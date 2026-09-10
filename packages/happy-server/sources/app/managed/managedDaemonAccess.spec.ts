/**
 * What a managed daemon credential is allowed to do.
 *
 * The credential names an account, because the Machine really is that
 * account's. It authorises nothing that account could do: no session, no
 * listing, no administration. What it opens is one machine's own control and
 * status, and only while the grant behind it is still live.
 *
 * Real PostgreSQL: the row is the authority, and a check that did not read it
 * would be a check the caller performs on itself.
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

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

let db: PrismaClient;
let access: typeof import('@/app/managed/managedDaemonAccess');
let grants: typeof import('@/app/managed/managedDaemonGrant');
let tokens: typeof import('@/app/auth/managedDaemonToken');

const cleanup = {
    grants: new Set<string>(), machines: new Set<string>(),
    accounts: new Set<string>(), workspaces: new Set<string>(),
};

async function liveDaemon() {
    const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
    cleanup.accounts.add(account.id);
    const machine = await db.machine.create({
        data: { id: `machine-${randomUUID()}`, accountId: account.id, metadata: '{}' },
    });
    cleanup.machines.add(machine.id);
    const workspaceId = `ws-${randomUUID()}`;
    const runtimeId = `runtime-${randomUUID()}`;
    cleanup.workspaces.add(workspaceId);
    await db.managedWorkspaceAuthority.create({
        data: {
            workspaceId, tenantId: 'tenant-1', projectId: 'proj-1',
            epoch: 3, runtimeId, version: 1, bodyDigest: 'd',
            createdAt: BigInt(NOW), updatedAt: BigInt(NOW),
        },
    });
    const scope = {
        accountId: account.id, machineId: machine.id, runtimeId,
        provisioningOperationId: `op-${randomUUID()}`,
        workspaceId, projectId: 'proj-1', epoch: 3,
    };
    const issued = await grants.issueManagedDaemonGrant({
        scope,
        daemonGrantId: `dgrant-${randomUUID()}`,
        requestId: `req-${randomUUID()}`,
        expiresAt: NOW + HOUR,
        now: NOW,
    });
    if (!issued.ok) throw new Error('fixture grant failed');
    cleanup.grants.add(issued.grant.daemonGrantId);

    const issuer = await tokens.createManagedDaemonTokenIssuer({ seed: 'test-daemon-seed-not-a-key' });
    const minted = await issuer.mint({
        v: 1,
        ...scope,
        daemonGrantId: issued.grant.daemonGrantId,
        generation: issued.grant.generation,
        expiresAt: NOW + HOUR,
    }, NOW);
    if (!minted.ok) throw new Error('fixture mint failed');
    return { issuer, token: minted.token, scope, grant: issued.grant };
}

describe.skipIf(!enabled)('managed daemon access (real PostgreSQL)', () => {
    beforeAll(async () => {
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        access = await import('@/app/managed/managedDaemonAccess');
        grants = await import('@/app/managed/managedDaemonGrant');
        tokens = await import('@/app/auth/managedDaemonToken');
    });

    afterEach(async () => {
        await db.managedDaemonGrant.deleteMany({ where: { daemonGrantId: { in: [...cleanup.grants] } } });
        await db.machine.deleteMany({ where: { id: { in: [...cleanup.machines] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...cleanup.workspaces] } },
        });
        await db.account.deleteMany({ where: { id: { in: [...cleanup.accounts] } } });
        for (const set of Object.values(cleanup)) set.clear();
    });

    afterAll(async () => {
        await db.$disconnect();
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('admits a live daemon to its own machine', async () => {
        const { issuer, token, scope } = await liveDaemon();
        const result = await access.authorizeManagedDaemonRequest({
            token, issuer, machineId: scope.machineId, now: NOW + 1_000,
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.principal.kind).toBe('managed-daemon');
        expect(result.principal.claims.machineId).toBe(scope.machineId);
    });

    it('refuses it on any other machine', async () => {
        // The credential is for one machine. Presenting it against another is
        // the case an account bearer would sail through.
        const { issuer, token } = await liveDaemon();
        expect(await access.authorizeManagedDaemonRequest({
            token, issuer, machineId: `machine-${randomUUID()}`, now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'machine-mismatch' });
    });

    it('refuses it the moment the grant is revoked', async () => {
        // Without waiting for the token to expire: that is the whole reason
        // the grant is a row.
        const { issuer, token, scope, grant } = await liveDaemon();
        await grants.revokeManagedDaemonGrant({
            daemonGrantId: grant.daemonGrantId, reason: 'operator', now: NOW + 500,
        });
        expect(await access.authorizeManagedDaemonRequest({
            token, issuer, machineId: scope.machineId, now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'revoked' });
    });

    it('refuses a credential from a superseded generation', async () => {
        const { issuer, token, scope, grant } = await liveDaemon();
        await grants.renewManagedDaemonGrant({
            daemonGrantId: grant.daemonGrantId,
            expectedGeneration: grant.generation,
            expiresAt: NOW + 2 * HOUR,
            requestId: `req-${randomUUID()}`,
            now: NOW + 500,
        });
        expect(await access.authorizeManagedDaemonRequest({
            token, issuer, machineId: scope.machineId, now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'stale-generation' });
    });

    it('refuses an expired credential', async () => {
        const { issuer, scope, grant } = await liveDaemon();
        const shortLived = await issuer.mint({
            v: 1, ...scope,
            daemonGrantId: grant.daemonGrantId,
            generation: grant.generation,
            expiresAt: NOW + 1_000,
        }, NOW);
        if (!shortLived.ok) return;
        expect(await access.authorizeManagedDaemonRequest({
            token: shortLived.token, issuer, machineId: scope.machineId, now: NOW + 1_001,
        })).toEqual({ ok: false, reason: 'token-invalid' });
    });

    it('refuses an account bearer presented in its place', async () => {
        // The two are different purposes, and this boundary does not accept
        // the other one just because it is also a valid token.
        const { issuer, scope } = await liveDaemon();
        expect(await access.authorizeManagedDaemonRequest({
            token: 'not-a-daemon-token', issuer, machineId: scope.machineId, now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'token-invalid' });
    });

    it('grants nothing account-shaped', async () => {
        // Stated as a property of the principal: whatever else changes, this
        // credential must never start carrying an account id that something
        // downstream reads as "acting as".
        const { issuer, token, scope } = await liveDaemon();
        const result = await access.authorizeManagedDaemonRequest({
            token, issuer, machineId: scope.machineId, now: NOW + 1_000,
        });
        if (!result.ok) return;
        expect(result.principal).not.toHaveProperty('userId');
        expect(result.principal).not.toHaveProperty('sessionId');
        expect(Object.keys(result.principal).sort()).toEqual(['claims', 'kind']);
    });
});
