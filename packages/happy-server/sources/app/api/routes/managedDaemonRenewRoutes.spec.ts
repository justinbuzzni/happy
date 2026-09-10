/**
 * Recovering a daemon credential without reissuing its bootstrap.
 *
 * Real Fastify and real PostgreSQL, opt-in like the other managed suites — on
 * `HAPPY_MANAGED_DAEMON_TEST_DATABASE_URL`, this file's own variable. The grant
 * is created through the bootstrap route rather than inserted directly, so what
 * is renewed here is the same row that route actually produces.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';

/**
 * Its own database, not the shared managed one.
 *
 * This file creates Machines, grants and projections while the other managed
 * suites are doing the same, and they run in parallel. Separating them keeps
 * this file's rows and locks out of theirs; it is not a claim about why any
 * particular run failed. There is no fallback to the shared URL — a deployment
 * that has not set this one skips the suite rather than quietly writing into a
 * database another suite is asserting over.
 */
const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_DAEMON_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
    HANDY_MASTER_SECRET: process.env.HANDY_MASTER_SECRET,
};
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const AUDIENCE = 'https://happy.control.test';
const HOUR = 3_600_000;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const CONTROL_KEY_B64 = Buffer
    .from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
    .toString('base64');

const CONTROL_ENV = {
    HAPPY_MANAGED_CONTROL_VERIFIER_KEYS: JSON.stringify({ 'control-1': CONTROL_KEY_B64 }),
    HAPPY_MANAGED_CONTROL_AUDIENCE: AUDIENCE,
    HAPPY_MANAGED_SCOPED_TOKEN_SEED: 'test-scoped-seed-not-a-production-key',
    HAPPY_MANAGED_PUBLIC_URL: 'https://happy.control.test',
};

const RENEW_ROUTE = '/v1/managed/control/daemon/renew';
const RESOLVE_ROUTE = '/v1/managed/control/daemon/resolve';

let db: PrismaClient;
let modules: {
    control: typeof import('@/app/api/routes/managedControlRoutes');
    renew: typeof import('@/app/api/routes/managedDaemonRenewRoutes');
    runtime: typeof import('@/app/managed/managedControlRuntime');
    assertion: typeof import('@/app/managed/managedControlAssertion');
    digest: typeof import('@/app/managed/canonicalDigest');
    auth: typeof import('@/app/auth/auth');
    tokens: typeof import('@/app/auth/managedDaemonToken');
};

const createdWorkspaceIds = new Set<string>();
const createdAccountIds = new Set<string>();

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let accountId: string;
let otherAccountId: string;
let accountToken: string;
let otherToken: string;
let workspaceId: string;

/** The recipient of the machine key envelope — a real account keypair. */
const recipient = nacl.box.keyPair();
let buildMachineKeyEnvelopes: (
    material: { machineKey: Uint8Array; accountPublicKey: Uint8Array } | null,
    serverPublicKey: Uint8Array | null,
) => { dataEncryptionKey: Uint8Array | null; serverDataEncryptionKey: Uint8Array | null };

function machineEnvelope(): string {
    const { dataEncryptionKey } = buildMachineKeyEnvelopes(
        { machineKey: new Uint8Array(randomBytes(32)), accountPublicKey: recipient.publicKey },
        null,
    );
    return Buffer.from(dataEncryptionKey!).toString('base64');
}

function assertionFor(op: string, body: unknown, over: Record<string, unknown> = {}): string {
    const now = Date.now();
    const payload = {
        kid: 'control-1',
        aud: AUDIENCE,
        purpose: modules.assertion.CONTROL_ASSERTION_PURPOSE,
        op,
        bodyDigest: modules.digest.canonicalDigest(body),
        iat: now,
        exp: now + 60_000,
        ...over,
    };
    const bytes = modules.assertion.encodeControlAssertionPayload(payload as never);
    return modules.assertion.encodeControlAssertion(bytes, signBytes(null, bytes, privateKey));
}

async function call(input: {
    path: string;
    op: string;
    body: unknown;
    token?: string;
    assertion?: string | null;
    instance?: FastifyInstance;
}) {
    const headers: Record<string, string> = {
        authorization: `Bearer ${input.token ?? accountToken}`,
        'content-type': 'application/json',
    };
    const assertion = input.assertion === undefined
        ? assertionFor(input.op, input.body)
        : input.assertion;
    if (assertion !== null) headers[modules.control.CONTROL_ASSERTION_HEADER] = assertion;
    return (input.instance ?? app).inject({
        method: 'POST', url: input.path, headers, payload: JSON.stringify(input.body),
    });
}

/**
 * Every row this file can touch, in full and in a stable order.
 *
 * Counts would hide the defect these assertions exist for: a handler that
 * renews and only then refuses leaves the count identical while the generation
 * and the expiry have already moved.
 */
async function rowSnapshot() {
    const [grants, machines, workspaces] = await Promise.all([
        db.managedDaemonGrant.findMany({
            where: { accountId: { in: [...createdAccountIds] } },
            orderBy: { daemonGrantId: 'asc' },
        }),
        db.machine.findMany({
            where: { accountId: { in: [...createdAccountIds] } },
            orderBy: { id: 'asc' },
        }),
        db.managedWorkspaceAuthority.findMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
            orderBy: { workspaceId: 'asc' },
        }),
    ]);
    return { grants, machines, workspaces };
}

/**
 * Commit something on another connection after the handler's transaction has
 * read, and before it writes.
 *
 * Fencing a workspace *before* the request only exercises whatever check runs
 * first; deleting the comparison that happens inside the writing transaction
 * would not show up. The hook replaces `db.$transaction` — which `inTx` goes
 * through — so the change lands in the window the in-transaction re-read
 * exists for, committed from a connection of its own.
 *
 * Restored by value rather than through `vi.spyOn`: `$transaction` is not an
 * own property of the client, so deleting an override leaves it `undefined`
 * and every later transaction in the file fails.
 */
function commitDuringTransaction(change: () => Promise<void>): {
    fired: () => boolean;
    restore: () => void;
} {
    const client = db as unknown as Record<string, unknown>;
    const previous = client.$transaction;
    const original = db.$transaction.bind(db) as (...args: unknown[]) => unknown;
    let fired = false;
    // Once for the hook, not once per transaction: the change is what causes
    // the retry, so re-applying it on the retry would make every attempt lose
    // and turn a recoverable conflict into a permanent one.
    let done = false;
    client.$transaction = (fn: unknown, options: unknown) => {
        if (typeof fn !== 'function') return original(fn, options);
        return original(async (tx: object) => {
            const wrapped = new Proxy(tx as Record<string | symbol, unknown>, {
                get(target, prop) {
                    const value = Reflect.get(target, prop);
                    if (prop !== 'managedDaemonGrant' || typeof value !== 'object' || !value) {
                        return typeof value === 'function' ? (value as Function).bind(target) : value;
                    }
                    return new Proxy(value as Record<string | symbol, unknown>, {
                        get(model, method) {
                            const fnv = Reflect.get(model, method);
                            if (typeof fnv !== 'function') return fnv;
                            const call = fnv as (...args: unknown[]) => unknown;
                            // *After* the transaction's first read of the
                            // grant, and before the projection and the Machine
                            // are read. The order matters: PostgreSQL takes the
                            // snapshot at the first statement, not at BEGIN, so
                            // a change committed before that first read would
                            // simply be inside the snapshot and prove nothing.
                            if (String(method) !== 'findUnique') return call.bind(model);
                            return async (...args: unknown[]) => {
                                const result = await call.apply(model, args);
                                if (!done) { done = true; fired = true; await change(); }
                                return result;
                            };
                        },
                    });
                },
            });
            return (fn as (tx: object) => Promise<unknown>)(wrapped);
        }, options);
    };
    return { fired: () => fired, restore: () => { client.$transaction = previous; } };
}

async function buildApp(getRuntime: () => unknown): Promise<FastifyInstance> {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>();
    // The real decorator: refusing a scoped bearer is one of the properties
    // under test, and a stand-in would not refuse one.
    (await import('@/app/api/utils/enableAuthentication')).enableAuthentication(typed as never);
    // Both modules, as they are mounted in `api.ts`. The bootstrap route is
    // what creates the grant these routes recover.
    modules.control.managedControlRoutes(typed as never, getRuntime as never);
    modules.renew.managedDaemonRenewRoutes(typed as never, getRuntime as never);
    await instance.ready();
    return instance;
}

describe.skipIf(!enabled)('managed daemon credential recovery (real Fastify + PostgreSQL)', () => {
    beforeAll(async () => {
        modules = {
            control: await import('@/app/api/routes/managedControlRoutes'),
            renew: await import('@/app/api/routes/managedDaemonRenewRoutes'),
            runtime: await import('@/app/managed/managedControlRuntime'),
            assertion: await import('@/app/managed/managedControlAssertion'),
            digest: await import('@/app/managed/canonicalDigest'),
            auth: await import('@/app/auth/auth'),
            tokens: await import('@/app/auth/managedDaemonToken'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();

        // The CLI's own envelope producer, loaded at runtime and anchored to
        // this file: a fixture that rebuilt the envelope here would only prove
        // the bootstrap route accepts the fixture.
        const here = expect.getState().testPath!;
        const specifier = `${here.slice(0, here.lastIndexOf('/sources/'))}`
            + '/../happy-cli/src/api/encryption.ts';
        ({ buildMachineKeyEnvelopes } = await import(specifier));

        const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
        app = await buildApp(() => runtime);
        unconfiguredApp = await buildApp(() => null);
    });

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        otherAccountId = other.id;
        createdAccountIds.add(accountId);
        createdAccountIds.add(otherAccountId);
        accountToken = await modules.auth.auth.createToken(accountId);
        otherToken = await modules.auth.auth.createToken(otherAccountId);
    });

    afterEach(async () => {
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.managedDaemonGrant.deleteMany({ where: { accountId: { in: [...createdAccountIds] } } });
        await db.machine.deleteMany({ where: { accountId: { in: [...createdAccountIds] } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        expect(await rowSnapshot()).toEqual({ grants: [], machines: [], workspaces: [] });
        await app?.close();
        await unconfiguredApp?.close();
        await db.$disconnect();
        restoreEnv();
    });

    async function projectWorkspace(over: Record<string, unknown> = {}) {
        const response = await call({
            path: '/v1/managed/control/authority/workspace',
            op: 'authority-sync',
            body: {
                ownerAccountId: accountId,
                expectedVersion: 0,
                body: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1', ...over,
                },
            },
        });
        expect(response.statusCode).toBe(200);
    }

    /** A live grant, created the way the control plane really creates one. */
    async function bootstrap(over: Record<string, unknown> = {}) {
        const body = {
            accountId,
            machineId: `machine-${randomUUID()}`,
            runtimeId: 'runtime-1',
            provisioningOperationId: `op-${randomUUID()}`,
            workspaceId,
            projectId: 'project-1',
            epoch: 1,
            daemonGrantId: `dgrant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: Date.now() + HOUR,
            metadata: '{}',
            dataEncryptionKey: machineEnvelope(),
            ...over,
        };
        const response = await call({
            path: '/v1/managed/control/daemon/bootstrap', op: 'daemon-bootstrap', body,
        });
        expect(response.statusCode).toBe(200);
        return { body, response };
    }

    function scopeOf(body: Record<string, unknown>) {
        return {
            accountId: body.accountId,
            machineId: body.machineId,
            runtimeId: body.runtimeId,
            provisioningOperationId: body.provisioningOperationId,
            workspaceId: body.workspaceId,
            projectId: body.projectId,
            epoch: body.epoch,
        };
    }

    function renewBody(bootstrapped: Record<string, unknown>, over: Record<string, unknown> = {}) {
        return {
            scope: scopeOf(bootstrapped),
            daemonGrantId: bootstrapped.daemonGrantId,
            expectedGeneration: 0,
            requestId: `renew-${randomUUID()}`,
            expiresAt: Date.now() + 2 * HOUR,
            ...over,
        };
    }

    function resolveBody(bootstrapped: Record<string, unknown>, over: Record<string, unknown> = {}) {
        return {
            scope: scopeOf(bootstrapped),
            daemonGrantId: bootstrapped.daemonGrantId,
            generation: 0,
            expiresAt: Date.now() + HOUR,
            ...over,
        };
    }

    const renew = (body: unknown, over: Record<string, unknown> = {}) =>
        call({ path: RENEW_ROUTE, op: 'daemon-renew', body, ...over });
    const resolve = (body: unknown, over: Record<string, unknown> = {}) =>
        call({ path: RESOLVE_ROUTE, op: 'daemon-resolve', body, ...over });

    describe('renewing a grant that already exists', () => {
        it('advances the generation and mints for the new one', async () => {
            await projectWorkspace();
            const { body, response } = await bootstrap();
            expect(response.json().generation).toBe(0);

            const renewed = await renew(renewBody(body));
            expect(renewed.statusCode).toBe(200);
            expect(renewed.json().generation).toBe(1);
            expect(renewed.json().daemonGrantId).toBe(body.daemonGrantId);
            expect(renewed.json().machineId).toBe(body.machineId);

            // The credential really names the new generation, so the one minted
            // before it stops resolving.
            const issuer = await modules.tokens.createManagedDaemonTokenIssuer({
                seed: CONTROL_ENV.HAPPY_MANAGED_SCOPED_TOKEN_SEED,
            });
            const verified = await issuer.verify(renewed.json().token as string, Date.now());
            expect(verified.ok).toBe(true);
            if (!verified.ok) return;
            expect(verified.claims.generation).toBe(1);
            expect(verified.claims.daemonGrantId).toBe(body.daemonGrantId);
            expect(verified.claims.machineId).toBe(body.machineId);
        });

        it('recovers a grant whose credential has already expired', async () => {
            // The case the bootstrap route cannot answer: its body is immutable
            // and the generation may hold only one grant, so nothing about the
            // original request can ask for a longer life. The daemon holding
            // the dead credential cannot reach here either — this needs the
            // control plane's own assertion.
            await projectWorkspace();
            const { body } = await bootstrap();
            await db.managedDaemonGrant.update({
                where: { daemonGrantId: body.daemonGrantId as string },
                data: { expiresAt: BigInt(Date.now() - 1_000) },
            });
            expect((await resolve(resolveBody(body))).json().error).toBe('expired');

            const renewed = await renew(renewBody(body));
            expect(renewed.statusCode).toBe(200);
            expect(renewed.json().generation).toBe(1);
            // And the recovered grant resolves again.
            const again = await resolve(resolveBody(body, { generation: 1 }));
            expect(again.statusCode).toBe(200);
        });

        it('converges on a lost response instead of advancing twice', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const request = renewBody(body);
            const first = await renew(request);
            const again = await renew(request);
            expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
            expect(again.json().idempotent).toBe(true);
            expect(again.json().generation).toBe(first.json().generation);
            const row = await db.managedDaemonGrant.findUnique({
                where: { daemonGrantId: body.daemonGrantId as string },
            });
            expect(row!.generation).toBe(1);
        });

        it('refuses a renewal that names a generation already superseded', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            expect((await renew(renewBody(body))).statusCode).toBe(200);

            const before = await rowSnapshot();
            const stale = await renew(renewBody(body, { expectedGeneration: 0 }));
            expect(stale.statusCode).toBe(409);
            expect(stale.json().error).toBe('generation-conflict');
            expect(await rowSnapshot()).toEqual(before);
        });

        it('never revives a revoked grant', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            await db.managedDaemonGrant.update({
                where: { daemonGrantId: body.daemonGrantId as string },
                data: { revokedAt: BigInt(Date.now()), revokedReason: 'test' },
            });
            const before = await rowSnapshot();
            const response = await renew(renewBody(body));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('revoked');
            expect(await rowSnapshot()).toEqual(before);
        });

        it('refuses once the workspace has been fenced to another generation', async () => {
            // Extending a credential for a generation the control plane has
            // moved past keeps alive exactly the runtime a fence was meant to
            // cut off.
            await projectWorkspace();
            const { body } = await bootstrap();
            await db.managedWorkspaceAuthority.update({
                where: { workspaceId },
                data: { epoch: 2 },
            });
            const before = await rowSnapshot();
            const response = await renew(renewBody(body));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('workspace-authority-mismatch');
            expect(await rowSnapshot()).toEqual(before);
        });

        it('refuses a promotion committed while the renewal was deciding', async () => {
            // The projection is re-read inside the writing transaction. Fencing
            // before the request only exercises the read; this commits the
            // promotion from another connection after the grant has been read
            // and before the update runs, which is the window that re-read
            // exists for.
            await projectWorkspace();
            const { body } = await bootstrap();
            const hook = commitDuringTransaction(async () => {
                await db.managedWorkspaceAuthority.update({
                    where: { workspaceId },
                    data: { epoch: 2 },
                });
            });
            const before = await rowSnapshot();
            let response: Awaited<ReturnType<typeof renew>>;
            try {
                response = await renew(renewBody(body));
            } finally {
                hook.restore();
            }
            expect(hook.fired()).toBe(true);
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('workspace-authority-mismatch');
            // Only the fence itself moved; the grant did not.
            const after = await rowSnapshot();
            expect(after.grants).toEqual(before.grants);
            expect(after.machines).toEqual(before.machines);
        });

        it('refuses when the Machine changes hands while the renewal was deciding', async () => {
            // Every id in the row can line up while the Machine it names has
            // been reassigned. Checked outside the transaction, the reassignment
            // commits in between and the renewal extends a credential for a
            // machine the account no longer owns.
            await projectWorkspace();
            const { body } = await bootstrap();
            const hook = commitDuringTransaction(async () => {
                await db.machine.update({
                    where: { id: body.machineId as string },
                    data: { accountId: otherAccountId },
                });
            });
            const before = await rowSnapshot();
            let response: Awaited<ReturnType<typeof renew>>;
            try {
                response = await renew(renewBody(body));
            } finally {
                hook.restore();
            }
            expect(hook.fired()).toBe(true);
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('machine-not-owned');
            const after = await rowSnapshot();
            expect(after.grants).toEqual(before.grants);
        });

        it('rolls back every renewal write when the lifetime expires inside the transaction', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const request = renewBody(body);
            const realNow = Date.now.bind(Date);
            let advance = 0;
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + advance);
            const hook = commitDuringTransaction(async () => {
                // Advance only after the real grant SELECT: arrival validation
                // has passed, but the final transactional clock must refuse.
                advance = 3 * HOUR;
            });
            let response: Awaited<ReturnType<typeof renew>>;
            try {
                response = await renew(request);
            } finally {
                hook.restore();
                clock.mockRestore();
            }
            expect(hook.fired()).toBe(true);
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toBe('expired');
            // Mint also refuses an expired token. Status alone cannot prove
            // rollback: without the final TX guard it still returns 400 while
            // committing a new generation and renewal receipt.
            expect(await rowSnapshot()).toEqual(before);
        });

        it('refuses a renewal whose scope disagrees with the row', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const response = await renew(renewBody(body, {
                scope: { ...scopeOf(body), machineId: `machine-${randomUUID()}` },
            }));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('scope-mismatch');
            expect(await rowSnapshot()).toEqual(before);
        });

        it("refuses to renew another account's daemon", async () => {
            // `renewManagedDaemonGrant` is addressed by grant id alone, so
            // without an ownership check any bearer that learned an id could
            // extend the life of somebody else's runtime.
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const response = await renew(
                renewBody(body, { scope: { ...scopeOf(body), accountId: otherAccountId } }),
                { token: otherToken },
            );
            expect(response.statusCode).toBe(403);
            expect(await rowSnapshot()).toEqual(before);
        });

        it.each([
            ['an id longer than the credential allows', { daemonGrantId: 'd'.repeat(201) }],
            ['a request id with surrounding whitespace', { requestId: ' renew-padded ' }],
            ['an expiry already past', { expiresAt: Date.now() - 1_000 }],
            ['a lifetime beyond the ceiling', { expiresAt: Date.now() + 25 * HOUR }],
        ])('refuses %s before writing anything', async (_name, over) => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const response = await renew(renewBody(body, over));
            expect(response.statusCode).toBe(400);
            expect(await rowSnapshot()).toEqual(before);
            // The corrected request still works, because nothing was kept.
            expect((await renew(renewBody(body))).statusCode).toBe(200);
        });
    });

    describe('the control plane recovering a lost renewal', () => {
        it('recovers the generation without ever guessing it', async () => {
            // The scenario this whole path exists for: the renewal committed,
            // its acknowledgement was lost, and by the time the control plane
            // retries, the renewal request's own lifetime has passed.
            await projectWorkspace();
            const { body } = await bootstrap();

            // 1. The renewal lands. The answer never arrives.
            const lost = renewBody(body, { expiresAt: Date.now() + 500 });
            expect((await renew(lost)).statusCode).toBe(200);

            // 2. Time passes. Resending the same request verbatim is the first
            //    thing to try — it converges while it still can — but its own
            //    lifetime is spent, so it cannot be the recovery.
            await new Promise((resolve) => setTimeout(resolve, 700));
            const replayed = await renew(lost);
            expect(replayed.statusCode).toBe(400);
            expect(replayed.json().error).toBe('expired');

            // 3. A fresh request must state a generation. The control plane
            //    only knows the one it started from, and guessing the next is
            //    exactly what would let two replicas both walk the CAS
            //    forward. Stating the stale one is refused — and the refusal
            //    carries the fact it was missing.
            const stale = await renew(renewBody(body, { expectedGeneration: 0 }));
            expect(stale.statusCode).toBe(409);
            expect(stale.json().error).toBe('generation-conflict');
            expect(stale.json().currentGeneration).toBe(1);

            // 4. Corrected from that fact, not from an assumption.
            const corrected = await renew(renewBody(body, {
                expectedGeneration: stale.json().currentGeneration as number,
            }));
            expect(corrected.statusCode).toBe(200);
            expect(corrected.json().generation).toBe(2);

            // 5. And only now can the credential be re-read, against the
            //    generation the row actually holds.
            const resolved = await resolve(resolveBody(body, { generation: 2 }));
            expect(resolved.statusCode).toBe(200);
            expect(resolved.json().generation).toBe(2);

            // The original bootstrap never moved: one machine, one grant, and
            // the key material untouched throughout.
            const machines = await db.machine.findMany({ where: { accountId } });
            expect(machines).toHaveLength(1);
            expect(Buffer.from(machines[0].dataEncryptionKey!).toString('base64'))
                .toBe(body.dataEncryptionKey);
            expect(await db.managedDaemonGrant.count({ where: { accountId } })).toBe(1);
        });

        it('does not tell a caller the generation of a grant it does not own', async () => {
            // The fact goes back only after ownership, scope and the projection
            // have all matched — it is the holder's own grant it describes.
            await projectWorkspace();
            const { body } = await bootstrap();
            const response = await renew(
                renewBody(body, {
                    expectedGeneration: 0,
                    scope: { ...scopeOf(body), accountId: otherAccountId },
                }),
                { token: otherToken },
            );
            expect(response.statusCode).toBe(403);
            expect(response.json().currentGeneration).toBeUndefined();
        });
    });

    describe('resolving a grant that is still healthy', () => {
        it('mints again without changing anything', async () => {
            // The acknowledgement was lost, not the grant.
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const response = await resolve(resolveBody(body));
            expect(response.statusCode).toBe(200);
            expect(response.json().generation).toBe(0);
            expect(response.json().daemonGrantId).toBe(body.daemonGrantId);
            expect(await rowSnapshot()).toEqual(before);
        });

        it('resolves one snapshot when a projection changes between its reads', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const before = await rowSnapshot();
            const hook = commitDuringTransaction(async () => {
                await db.managedWorkspaceAuthority.update({
                    where: { workspaceId }, data: { epoch: 2 },
                });
            });
            let response: Awaited<ReturnType<typeof resolve>>;
            try {
                response = await resolve(resolveBody(body));
            } finally {
                hook.restore();
            }
            expect(hook.fired()).toBe(true);
            expect(response.statusCode).toBe(200);
            expect(response.json().generation).toBe(0);
            expect(response.json().daemonGrantId).toBe(body.daemonGrantId);
            const after = await rowSnapshot();
            expect(after.grants).toEqual(before.grants);
            expect(after.machines).toEqual(before.machines);
            expect(after.workspaces[0].epoch).toBe(2);
            // The first response describes its earlier consistent snapshot;
            // it is not proof that this credential survives the new fence.
            const next = await resolve(resolveBody(body));
            expect(next.statusCode).toBe(409);
            expect(next.json().error).toBe('stale-epoch');
        });

        it('refuses a generation the row has moved past', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            expect((await renew(renewBody(body))).statusCode).toBe(200);
            const response = await resolve(resolveBody(body, { generation: 0 }));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('stale-generation');
        });

        it('refuses a scope that disagrees with the row', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const response = await resolve(resolveBody(body, {
                scope: { ...scopeOf(body), projectId: 'project-somebody-else' },
            }));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('scope-mismatch');
        });

        it('never mints longer than what was signed for', async () => {
            // The grant may outlive the request. A credential must not.
            await projectWorkspace();
            const { body } = await bootstrap();
            const shortly = Date.now() + 60_000;
            const response = await resolve(resolveBody(body, { expiresAt: shortly }));
            expect(response.statusCode).toBe(200);
            expect(response.json().expiresAt).toBe(shortly);
            const row = await db.managedDaemonGrant.findUnique({
                where: { daemonGrantId: body.daemonGrantId as string },
            });
            expect(Number(row!.expiresAt)).toBeGreaterThan(shortly);
        });
    });

    describe('both proofs are required', () => {
        const ROUTES = [[RENEW_ROUTE, 'daemon-renew'], [RESOLVE_ROUTE, 'daemon-resolve']] as const;

        it('refuses the bearer alone on both routes', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            for (const [path, op] of ROUTES) {
                const requestBody = op === 'daemon-renew' ? renewBody(body) : resolveBody(body);
                const before = await rowSnapshot();
                const response = await call({ path, op, body: requestBody, assertion: null });
                expect(response.statusCode).toBe(403);
                expect(await rowSnapshot()).toEqual(before);
            }
        });

        it('refuses an assertion signed for another operation', async () => {
            // The daemon grant and the session grant are different
            // authorities. An assertion signed to keep a conversation alive
            // must not keep a runtime's identity alive.
            await projectWorkspace();
            const { body } = await bootstrap();
            for (const [path, op, wrong] of [
                [RENEW_ROUTE, 'daemon-renew', 'grant-renew'],
                [RENEW_ROUTE, 'daemon-renew', 'daemon-bootstrap'],
                [RESOLVE_ROUTE, 'daemon-resolve', 'grant-resolve'],
                [RESOLVE_ROUTE, 'daemon-resolve', 'daemon-renew'],
            ] as const) {
                const requestBody = op === 'daemon-renew' ? renewBody(body) : resolveBody(body);
                const before = await rowSnapshot();
                const response = await call({
                    path, op, body: requestBody, assertion: assertionFor(wrong, requestBody),
                });
                expect(response.statusCode).toBe(403);
                expect(await rowSnapshot()).toEqual(before);
            }
        });

        it('refuses an assertion signed over a different body', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const signed = renewBody(body);
            const sent = renewBody(body, { expiresAt: signed.expiresAt + 1_000 });
            const response = await call({
                path: RENEW_ROUTE, op: 'daemon-renew', body: sent,
                assertion: assertionFor('daemon-renew', signed),
            });
            expect(response.statusCode).toBe(403);
        });

        it('refuses a scope the bearer does not own', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            for (const [path, op] of ROUTES) {
                const requestBody = op === 'daemon-renew' ? renewBody(body) : resolveBody(body);
                const response = await call({ path, op, body: requestBody, token: otherToken });
                expect(response.statusCode).toBe(403);
            }
        });

        it('refuses a scoped bearer as unauthenticated', async () => {
            await projectWorkspace();
            const { body } = await bootstrap();
            const daemonToken = (await bootstrap()).response.json().token as string;
            for (const [path, op] of ROUTES) {
                const requestBody = op === 'daemon-renew' ? renewBody(body) : resolveBody(body);
                const response = await call({ path, op, body: requestBody, token: daemonToken });
                // The account verifier refuses it, so no handler ever runs.
                expect(response.statusCode).toBe(401);
            }
        });

        it('refuses when managed control is not configured', async () => {
            for (const [path, op] of ROUTES) {
                const response = await call({
                    path, op, body: { nonsense: true }, instance: unconfiguredApp,
                });
                // Before schema validation: an unconfigured deployment does not
                // describe the route's shape to a caller it will not serve.
                expect(response.statusCode).toBe(503);
            }
        });
    });
});
