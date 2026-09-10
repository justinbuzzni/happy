/**
 * The durable identity a managed daemon runs on.
 *
 * Issued once per runtime generation, renewable in place, and revocable
 * without waiting for a credential to expire. The row is the authority: a
 * token only names it, so a withdrawal here takes effect on the next check
 * rather than at the end of a lifetime nobody chose.
 *
 * Real PostgreSQL, opt-in like the other managed suites.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);
const priorEnv = { DATABASE_URL: process.env.DATABASE_URL, DB_PROVIDER: process.env.DB_PROVIDER };
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
}

let db: PrismaClient;
let grants: typeof import('@/app/managed/managedDaemonGrant');

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const created = new Set<string>();
const createdWorkspaces = new Set<string>();
const createdAccounts = new Set<string>();
const createdMachines = new Set<string>();

function scope(over: Record<string, unknown> = {}) {
    return {
        accountId: 'acc-1',
        machineId: 'machine-1',
        runtimeId: `runtime-${randomUUID()}`,
        provisioningOperationId: `op-${randomUUID()}`,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        epoch: 3,
        ...over,
    };
}

async function issue(over: Record<string, unknown> = {}) {
    const input = {
        scope: scope(),
        daemonGrantId: `dgrant-${randomUUID()}`,
        requestId: `req-${randomUUID()}`,
        expiresAt: NOW + HOUR,
        now: NOW,
        ...over,
    };
    const result = await grants.issueManagedDaemonGrant(input as never);
    if (result.ok) created.add(result.grant.daemonGrantId);
    return result;
}

describe.skipIf(!enabled)('managed daemon grants (real PostgreSQL)', () => {
    beforeAll(async () => {
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        grants = await import('@/app/managed/managedDaemonGrant');
    });

    afterEach(async () => {
        await db.managedDaemonGrant.deleteMany({ where: { daemonGrantId: { in: [...created] } } });
        await db.machine.deleteMany({ where: { id: { in: [...createdMachines] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaces] } },
        });
        await db.account.deleteMany({ where: { id: { in: [...createdAccounts] } } });
        created.clear();
        createdWorkspaces.clear();
        createdAccounts.clear();
        createdMachines.clear();
    });

    afterAll(async () => {
        await db.$disconnect();
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('issues a grant that names its runtime generation', async () => {
        const result = await issue();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.grant.generation).toBe(0);
        expect(result.grant.revokedAt).toBeNull();
        expect(result.idempotent).toBe(false);
    });

    it('returns the same grant for an exact retry', async () => {
        // The control plane retries; a second row would be a second credential
        // that also looks current.
        const first = await issue();
        if (!first.ok) return;
        const again = await grants.issueManagedDaemonGrant({
            scope: {
                accountId: first.grant.accountId,
                machineId: first.grant.machineId,
                runtimeId: first.grant.runtimeId,
                provisioningOperationId: first.grant.provisioningOperationId,
                workspaceId: first.grant.workspaceId,
                projectId: first.grant.projectId,
                epoch: first.grant.epoch,
            },
            daemonGrantId: first.grant.daemonGrantId,
            requestId: first.grant.requestId,
            expiresAt: Number(first.grant.expiresAt),
            now: NOW + 1_000,
        } as never);
        expect(again).toMatchObject({ ok: true, idempotent: true });
    });

    it('refuses a different body under a request id already used', async () => {
        const first = await issue();
        if (!first.ok) return;
        const conflicting = await grants.issueManagedDaemonGrant({
            scope: { ...scope(), runtimeId: first.grant.runtimeId },
            daemonGrantId: `dgrant-${randomUUID()}`,
            requestId: first.grant.requestId,
            expiresAt: NOW + HOUR,
            now: NOW,
        } as never);
        expect(conflicting).toEqual({ ok: false, reason: 'request-body-changed' });
    });

    it('leaves the original issue retry converging after a renewal', async () => {
        // The renewal used to overwrite `requestId` while `bodyDigest` still
        // described the issue. A retry of the original issue then found no row
        // by request id and collided on the unique index — a raw database
        // error where the caller had asked a question with a defined answer.
        const first = await issue();
        if (!first.ok) return;
        await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 1_000,
        });

        const retry = await grants.issueManagedDaemonGrant({
            scope: {
                accountId: first.grant.accountId,
                machineId: first.grant.machineId,
                runtimeId: first.grant.runtimeId,
                provisioningOperationId: first.grant.provisioningOperationId,
                workspaceId: first.grant.workspaceId,
                projectId: first.grant.projectId,
                epoch: first.grant.epoch,
            },
            daemonGrantId: first.grant.daemonGrantId,
            requestId: first.grant.requestId,
            expiresAt: NOW + HOUR,
            now: NOW + 2_000,
        } as never);
        expect(retry).toMatchObject({ ok: true, idempotent: true });
    });

    it('converges a renewal retry instead of advancing twice', async () => {
        const first = await issue();
        if (!first.ok) return;
        const renewalRequestId = `req-${randomUUID()}`;
        const once = await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: renewalRequestId,
            now: NOW + 1_000,
        });
        // The response was lost; the control plane sends the same request.
        const again = await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: renewalRequestId,
            now: NOW + 2_000,
        });
        expect(once.ok && again.ok).toBe(true);
        if (!once.ok || !again.ok) return;
        expect(again.grant.generation).toBe(once.grant.generation);
    });

    it('gives a defined answer when a new request names a runtime that already has a grant', async () => {
        // Not a raw unique violation: the caller asked whether this runtime
        // generation has a grant, and it does.
        const first = await issue();
        if (!first.ok) return;
        const other = await grants.issueManagedDaemonGrant({
            scope: {
                accountId: first.grant.accountId,
                machineId: first.grant.machineId,
                runtimeId: first.grant.runtimeId,
                provisioningOperationId: first.grant.provisioningOperationId,
                workspaceId: first.grant.workspaceId,
                projectId: first.grant.projectId,
                epoch: first.grant.epoch,
            },
            daemonGrantId: `dgrant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: NOW + HOUR,
            now: NOW + 1_000,
        } as never);
        expect(other).toEqual({ ok: false, reason: 'runtime-grant-exists' });
    });

    it('does not lose a concurrent issue of the same request to a raw error', async () => {
        // Two replicas send the same request at once: both see no row, both
        // insert, and one loses on the unique index. `inTx` retries P2034 only,
        // so the loser has to be caught and re-read outside its failed
        // transaction.
        const shared = {
            scope: scope(),
            daemonGrantId: `dgrant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: NOW + HOUR,
            now: NOW,
        };
        const [a, b] = await Promise.all([
            grants.issueManagedDaemonGrant(shared as never),
            grants.issueManagedDaemonGrant(shared as never),
        ]);
        created.add(shared.daemonGrantId);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(a.grant.daemonGrantId).toBe(b.grant.daemonGrantId);
        // Exactly one row exists for that request.
        expect(await db.managedDaemonGrant.count({ where: { requestId: shared.requestId } })).toBe(1);
    });

    it('hands a caller-owned transaction its unique violation unchanged', async () => {
        // Standalone, this module owns the transaction and recovers in place.
        // Inside a caller's transaction it must not: the violation has already
        // aborted that transaction, so the retry's first statement returns
        // "current transaction is aborted" and the caller receives an error it
        // cannot classify instead of the P2002 it recognises — and then cannot
        // tell a convergence race from a database fault.
        const taken = await issue();
        expect(taken.ok).toBe(true);
        if (!taken.ok) return;

        const inTx = (await import('@/storage/inTx')).inTx;
        // A different request naming a different runtime generation, so both
        // lookups miss and the insert collides on the grant id alone.
        const failure = await inTx(async (tx) => grants.issueManagedDaemonGrant({
            scope: scope(),
            daemonGrantId: taken.grant.daemonGrantId,
            requestId: `req-${randomUUID()}`,
            expiresAt: NOW + HOUR,
            now: NOW,
            tx: tx as never,
        } as never)).then(() => null, (error: unknown) => error);

        expect(failure).not.toBeNull();
        expect((failure as { code?: string }).code).toBe('P2002');
        // And nothing of the refused request survives.
        expect(await db.managedDaemonGrant.count({
            where: { daemonGrantId: taken.grant.daemonGrantId },
        })).toBe(1);
    });

    it('advances the generation on a renewal, in place', async () => {
        const first = await issue();
        if (!first.ok) return;
        const renewed = await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 1_000,
        });
        expect(renewed).toMatchObject({ ok: true });
        if (!renewed.ok) return;
        expect(renewed.grant.generation).toBe(first.grant.generation + 1);
        expect(renewed.grant.daemonGrantId).toBe(first.grant.daemonGrantId);
    });

    it('refuses a renewal that names a generation already superseded', async () => {
        // Two control-plane replicas renewing the same grant: the second must
        // not walk the generation backwards or extend a credential the first
        // already replaced.
        const first = await issue();
        if (!first.ok) return;
        await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 1_000,
        });
        expect(await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 3 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 2_000,
        })).toEqual({ ok: false, reason: 'generation-conflict' });
    });

    it('never revives a revoked grant through a renewal', async () => {
        const first = await issue();
        if (!first.ok) return;
        await grants.revokeManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId, reason: 'operator', now: NOW + 1_000,
        });
        expect(await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 2_000,
        })).toEqual({ ok: false, reason: 'revoked' });
    });

    it('revokes without waiting for anything to expire', async () => {
        const first = await issue();
        if (!first.ok) return;
        expect(await grants.revokeManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            reason: 'operator',
            now: NOW + 1_000,
        })).toMatchObject({ ok: true });

        const resolved = await grants.resolveManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            generation: first.grant.generation,
            now: NOW + 2_000,
        } as never);
        expect(resolved).toEqual({ ok: false, reason: 'revoked' });
    });

    it('refuses a credential from a superseded generation', async () => {
        const first = await issue();
        if (!first.ok) return;
        await grants.renewManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            expectedGeneration: first.grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 1_000,
        });
        // The token minted before the renewal still verifies as a signature;
        // it is this check that stops it being usable.
        expect(await grants.resolveManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            generation: first.grant.generation,
            now: NOW + 2_000,
        } as never)).toEqual({ ok: false, reason: 'stale-generation' });
    });

    it('refuses a grant that has passed its own expiry', async () => {
        const first = await issue({ expiresAt: NOW + 1_000 });
        if (!first.ok) return;
        expect(await grants.resolveManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            generation: first.grant.generation,
            now: NOW + 1_001,
        } as never)).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a credential whose scope disagrees with the row', async () => {
        // The row is the authority. A token that verifies as a signature but
        // names a different machine, workspace or account is a token for
        // something else — the id and generation matching is not enough.
        const first = await issue();
        if (!first.ok) return;
        const base = {
            daemonGrantId: first.grant.daemonGrantId,
            generation: first.grant.generation,
            now: NOW + 1_000,
            claims: {
                accountId: first.grant.accountId,
                machineId: first.grant.machineId,
                runtimeId: first.grant.runtimeId,
                provisioningOperationId: first.grant.provisioningOperationId,
                workspaceId: first.grant.workspaceId,
                projectId: first.grant.projectId,
                epoch: first.grant.epoch,
            },
        };
        for (const field of [
            'accountId', 'machineId', 'runtimeId', 'provisioningOperationId',
            'workspaceId', 'projectId',
        ]) {
            expect(await grants.resolveManagedDaemonGrant({
                ...base,
                claims: { ...base.claims, [field]: 'somebody-else' },
            } as never), field).toEqual({ ok: false, reason: 'scope-mismatch' });
        }
        expect(await grants.resolveManagedDaemonGrant({
            ...base, claims: { ...base.claims, epoch: base.claims.epoch + 1 },
        } as never)).toEqual({ ok: false, reason: 'scope-mismatch' });
    });

    it('reads the workspace authority itself rather than trusting the caller', async () => {
        // The fencing axis is what the control plane recorded, not what the
        // caller passed in. A check that took the epoch as an argument would
        // be satisfied by whoever is asking.
        const workspaceId = `ws-${randomUUID()}`;
        const runtimeId = `runtime-${randomUUID()}`;
        createdWorkspaces.add(workspaceId);
        await db.managedWorkspaceAuthority.create({
            data: {
                workspaceId, tenantId: 'tenant-1', projectId: 'proj-1',
                epoch: 5, runtimeId, version: 1, bodyDigest: 'd',
                createdAt: BigInt(NOW), updatedAt: BigInt(NOW),
            },
        });
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        createdAccounts.add(account.id);
        const machine = await db.machine.create({
            data: { id: `machine-${randomUUID()}`, accountId: account.id, metadata: '{}' },
        });
        createdMachines.add(machine.id);

        const behind = await issue({
            scope: {
                ...scope(), accountId: account.id, machineId: machine.id,
                runtimeId, workspaceId, epoch: 4,
            },
        });
        if (!behind.ok) return;
        expect(await grants.resolveManagedDaemonGrant({
            daemonGrantId: behind.grant.daemonGrantId,
            generation: behind.grant.generation,
            now: NOW + 1_000,
            claims: {
                accountId: behind.grant.accountId, machineId: behind.grant.machineId,
                runtimeId: behind.grant.runtimeId,
                provisioningOperationId: behind.grant.provisioningOperationId,
                workspaceId: behind.grant.workspaceId, projectId: behind.grant.projectId,
                epoch: behind.grant.epoch,
            },
        })).toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('refuses when the machine is not the account the credential names', async () => {
        // A Machine that belongs to somebody else is not this daemon's, even
        // when every id in the token lines up with its own row.
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        createdAccounts.add(owner.id);
        createdAccounts.add(other.id);
        const machine = await db.machine.create({
            data: { id: `machine-${randomUUID()}`, accountId: other.id, metadata: '{}' },
        });
        createdMachines.add(machine.id);

        const workspaceId = `ws-${randomUUID()}`;
        const runtimeId = `runtime-${randomUUID()}`;
        createdWorkspaces.add(workspaceId);
        await db.managedWorkspaceAuthority.create({
            data: {
                workspaceId, tenantId: 'tenant-1', projectId: 'proj-1',
                epoch: 3, runtimeId, version: 1, bodyDigest: 'd',
                createdAt: BigInt(NOW), updatedAt: BigInt(NOW),
            },
        });
        const mismatched = await issue({
            scope: {
                ...scope(), accountId: owner.id, machineId: machine.id,
                runtimeId, workspaceId, epoch: 3,
            },
        });
        if (!mismatched.ok) return;
        expect(await grants.resolveManagedDaemonGrant({
            daemonGrantId: mismatched.grant.daemonGrantId,
            generation: mismatched.grant.generation,
            now: NOW + 1_000,
            claims: {
                accountId: mismatched.grant.accountId, machineId: mismatched.grant.machineId,
                runtimeId: mismatched.grant.runtimeId,
                provisioningOperationId: mismatched.grant.provisioningOperationId,
                workspaceId: mismatched.grant.workspaceId, projectId: mismatched.grant.projectId,
                epoch: mismatched.grant.epoch,
            },
        })).toEqual({ ok: false, reason: 'machine-not-owned' });
    });

    it('resolves a live grant to the scope it was issued for', async () => {
        // Real rows: the resolve reads the workspace authority and the Machine
        // owner itself, so a fixture without them is not a live grant.
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        createdAccounts.add(account.id);
        const machine = await db.machine.create({
            data: { id: `machine-${randomUUID()}`, accountId: account.id, metadata: '{}' },
        });
        createdMachines.add(machine.id);
        const workspaceId = `ws-${randomUUID()}`;
        const runtimeId = `runtime-${randomUUID()}`;
        createdWorkspaces.add(workspaceId);
        await db.managedWorkspaceAuthority.create({
            data: {
                workspaceId, tenantId: 'tenant-1', projectId: 'proj-1',
                epoch: 3, runtimeId, version: 1, bodyDigest: 'd',
                createdAt: BigInt(NOW), updatedAt: BigInt(NOW),
            },
        });
        const first = await issue({
            scope: {
                ...scope(), accountId: account.id, machineId: machine.id,
                runtimeId, workspaceId, epoch: 3,
            },
        });
        if (!first.ok) return;
        const resolved = await grants.resolveManagedDaemonGrant({
            daemonGrantId: first.grant.daemonGrantId,
            generation: first.grant.generation,
            now: NOW + 1_000,
            claims: {
                accountId: first.grant.accountId,
                machineId: first.grant.machineId,
                runtimeId: first.grant.runtimeId,
                provisioningOperationId: first.grant.provisioningOperationId,
                workspaceId: first.grant.workspaceId,
                projectId: first.grant.projectId,
                epoch: first.grant.epoch,
            },
        } as never);
        expect(resolved).toMatchObject({
            ok: true,
            grant: expect.objectContaining({
                accountId: account.id,
                machineId: machine.id,
                workspaceId,
                epoch: 3,
            }),
        });
    });
});
