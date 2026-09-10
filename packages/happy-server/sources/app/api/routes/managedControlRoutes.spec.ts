import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import type { PrismaClient } from '@prisma/client';

/**
 * The control routes against a real Fastify instance and the real database.
 *
 * A refusal has to be provably inert, so every denial case counts the managed
 * rows before and after: an endpoint that rejects the caller but has already
 * written is not a refusal.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL`, like the other real-database
 * suites.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
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

const EVERY_ROUTE = [
    ['/v1/managed/control/authority/workspace', 'authority-sync'],
    ['/v1/managed/control/authority/run', 'authority-sync'],
    ['/v1/managed/control/grants/mint', 'grant-mint'],
    ['/v1/managed/control/grants/renew', 'grant-renew'],
    ['/v1/managed/control/grants/revoke', 'grant-revoke'],
    ['/v1/managed/control/authority/snapshot', 'authority-snapshot'],
    ['/v1/managed/control/grants/resolve', 'grant-resolve'],
] as const;

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

let db: PrismaClient;
let modules: {
    routes: typeof import('@/app/api/routes/managedControlRoutes');
    runtime: typeof import('@/app/managed/managedControlRuntime');
    assertion: typeof import('@/app/managed/managedControlAssertion');
    digest: typeof import('@/app/managed/canonicalDigest');
    auth: typeof import('@/app/auth/auth');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
};

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let accountId: string;
let otherAccountId: string;
let accountToken: string;
let otherToken: string;
let workspaceId: string;
let runId: string;
let sessionId: string;

function scope(over: Record<string, unknown> = {}) {
    return {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        workspaceId,
        runtimeId: 'runtime-1',
        epoch: 1,
        runId,
        attemptId: 'attempt-1',
        sessionId,
        accountId,
        workspaceAuthorityVersion: 1,
        runAuthorityVersion: 1,
        ...over,
    };
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
    if (assertion !== null) headers[modules.routes.CONTROL_ASSERTION_HEADER] = assertion;
    return (input.instance ?? app).inject({
        method: 'POST', url: input.path, headers, payload: JSON.stringify(input.body),
    });
}

/**
 * Every managed row this file created, in full and in a stable order.
 *
 * Counts are not enough: a handler that updates a row and only then refuses
 * leaves the count identical while having already changed the authority — which
 * is exactly the shape of bug these assertions exist to catch. The scope is the
 * fixtures' own ids, so nothing here reads or compares rows belonging to anyone
 * else.
 */
async function managedRowSnapshot() {
    const [workspaces, runs, grants, machines, daemonGrants] = await Promise.all([
        db.managedWorkspaceAuthority.findMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
            orderBy: { workspaceId: 'asc' },
        }),
        db.managedRunAuthority.findMany({
            where: { runId: { in: [...createdRunIds] } },
            orderBy: { runId: 'asc' },
        }),
        db.managedSessionGrant.findMany({
            where: { runId: { in: [...createdRunIds] } },
            orderBy: { grantId: 'asc' },
        }),
        // The daemon bootstrap route writes Machines and daemon grants, so a
        // snapshot without them cannot see a refusal that left either behind —
        // which is the whole class of defect these assertions exist for.
        db.machine.findMany({ where: { accountId }, orderBy: { id: 'asc' } }),
        db.managedDaemonGrant.findMany({ where: { accountId }, orderBy: { daemonGrantId: 'asc' } }),
    ]);
    return { workspaces, runs, grants, machines, daemonGrants };
}

/**
 * Prisma write methods on the models the bootstrap route creates rows in.
 * Reads are deliberately not hooked: the point of the barrier below is to hold
 * a transaction *after* it has read and *before* it writes.
 */
const HOOKED_WRITES = new Set(['create', 'update', 'updateMany', 'upsert']);
const HOOKED_MODELS = new Set(['machine', 'managedDaemonGrant']);

function hookWrites<T extends object>(tx: T, onWrite: () => Promise<void>): T {
    const wrapModel = (model: Record<string | symbol, unknown>) => new Proxy(model, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (typeof value !== 'function') return value;
            const method = value as (...args: unknown[]) => unknown;
            if (!HOOKED_WRITES.has(String(prop))) return method.bind(target);
            return async (...args: unknown[]) => {
                await onWrite();
                return method.apply(target, args);
            };
        },
    });
    return new Proxy(tx, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (HOOKED_MODELS.has(String(prop)) && value && typeof value === 'object') {
                return wrapModel(value as Record<string | symbol, unknown>);
            }
            return typeof value === 'function' ? (value as Function).bind(target) : value;
        },
    }) as T;
}

/**
 * Run a callback at the start of every transaction, and once inside each
 * transaction just before its first write.
 *
 * `inTx` goes through `db.$transaction`, so replacing it here puts the hook
 * inside the same real transaction the handler runs in — not around it.
 */
function installTransactionHook(hook: {
    onStart?: () => Promise<void>;
    onFirstWrite?: () => Promise<void>;
}): () => void {
    // Assigned and put back by value, not through `vi.spyOn`: `$transaction`
    // is not an own property of this client, so restoring a spy on it (or
    // deleting the override) leaves the property `undefined`, and every later
    // transaction in the file fails with "$transaction is not a function".
    const client = db as unknown as Record<string, unknown>;
    const previous = client.$transaction;
    const original = db.$transaction.bind(db) as (...args: unknown[]) => unknown;
    client.$transaction = (fn: unknown, options: unknown) => {
        if (typeof fn !== 'function') return original(fn, options);
        return original(async (tx: object) => {
            await hook.onStart?.();
            let fired = false;
            const once = async () => {
                if (fired || !hook.onFirstWrite) return;
                fired = true;
                await hook.onFirstWrite();
            };
            return (fn as (tx: object) => Promise<unknown>)(
                hook.onFirstWrite ? hookWrites(tx, once) : tx,
            );
        }, options);
    };
    return () => { client.$transaction = previous; };
}

/**
 * A barrier inside the database, not a hopeful `Promise.all`.
 *
 * Two requests issued together need not overlap at all: the first can open its
 * transaction, insert and commit before the second opens one, and a "race"
 * test written that way proves only that a sequential retry converges. This
 * holds every transaction that reaches its first write until `arrivals` of
 * them are inside — so all of them have finished reading before any of them
 * writes, which is the only interleaving that produces the conflict.
 *
 * `gated()` reports how many were actually held. A test that does not assert
 * it cannot tell a real race from a barrier that never engaged.
 */
function transactionBarrier(arrivals: number) {
    let gated = 0;
    let opened = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const restore = installTransactionHook({
        onFirstWrite: async () => {
            if (!opened) {
                gated++;
                if (gated >= arrivals) { opened = true; open(); }
            }
            await gate;
        },
    });
    return {
        gated: () => gated,
        restore: () => { opened = true; open(); restore(); },
    };
}

async function expectInert<T extends { statusCode: number }>(run: () => Promise<T>, status: number): Promise<T> {
    const before = await managedRowSnapshot();
    const response = await run();
    expect(response.statusCode).toBe(status);
    // Every column, not just the row count.
    expect(await managedRowSnapshot()).toEqual(before);
    return response;
}

async function buildApp(getRuntime: () => unknown): Promise<FastifyInstance> {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>();
    // The real decorator, not a stand-in: refusing a scoped bearer is one of
    // the properties under test.
    (await import('@/app/api/utils/enableAuthentication')).enableAuthentication(typed as never);
    modules.routes.managedControlRoutes(typed as never, getRuntime as never);
    await instance.ready();
    return instance;
}

describe.skipIf(!enabled)('managed control routes (real Fastify + PostgreSQL)', () => {
    beforeAll(async () => {
        modules = {
            routes: await import('@/app/api/routes/managedControlRoutes'),
            runtime: await import('@/app/managed/managedControlRuntime'),
            assertion: await import('@/app/managed/managedControlAssertion'),
            digest: await import('@/app/managed/canonicalDigest'),
            auth: await import('@/app/auth/auth'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();

        const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
        app = await buildApp(() => runtime);
        unconfiguredApp = await buildApp(() => null);
    });

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        otherAccountId = other.id;
        createdAccountIds.add(accountId);
        createdAccountIds.add(otherAccountId);
        accountToken = await modules.auth.auth.createToken(accountId);
        otherToken = await modules.auth.auth.createToken(otherAccountId);

        const session = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = session.id;
        createdSessionIds.add(sessionId);
    });

    afterEach(async () => {
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: [...createdSessionIds] } } });
        // Daemon bootstrap creates a Machine and a grant for the fixture
        // account; both reference it, so both go before it does.
        await db.managedDaemonGrant.deleteMany({ where: { accountId: { in: [...createdAccountIds] } } });
        await db.machine.deleteMany({ where: { accountId: { in: [...createdAccountIds] } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        expect(await managedRowSnapshot())
            .toEqual({ workspaces: [], runs: [], grants: [], machines: [], daemonGrants: [] });
        await app?.close();
        await unconfiguredApp?.close();
        await db.$disconnect();
        restoreEnv();
    });

    async function syncAuthority() {
        const workspaceBody = {
            ownerAccountId: accountId,
            expectedVersion: 0,
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
        };
        expect((await call({
            path: '/v1/managed/control/authority/workspace', op: 'authority-sync', body: workspaceBody,
        })).statusCode).toBe(200);

        const runBody = {
            expectedVersion: 0,
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
        };
        expect((await call({
            path: '/v1/managed/control/authority/run', op: 'authority-sync', body: runBody,
        })).statusCode).toBe(200);
    }

    function mintBody(over: Record<string, unknown> = {}) {
        return {
            scope: scope(),
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: Date.now() + HOUR,
            ...over,
        };
    }

    describe('the vertical path', () => {
        it('syncs authority, mints a grant, renews it and revokes it', async () => {
            await syncAuthority();

            const body = mintBody();
            const minted = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body });
            expect(minted.statusCode).toBe(200);
            const issued = minted.json();
            expect(issued).toMatchObject({ renewalSeq: 0, serverUrl: 'https://happy.control.test' });

            // The token verifies as a managed principal and never as an account.
            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(issued.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims).toMatchObject({ grantId: issued.grantId, sessionId, accountId });
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toMatchObject({ ok: true });
            }
            await expect(modules.auth.auth.verifyToken(issued.token)).resolves.toBeNull();

            const renewBody = {
                scope: scope(), expectedGrantId: issued.grantId,
                expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR,
            };
            const renewed = await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew', body: renewBody,
            });
            expect(renewed.statusCode).toBe(200);
            // The answer names the grant the caller asked to extend.
            expect(renewed.json()).toMatchObject({ renewalSeq: 1, grantId: issued.grantId });

            const revoked = await call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'operator' },
            });
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toMatchObject({ state: 'revoked', alreadyRevoked: false });

            // The token stops resolving the moment the grant is revoked.
            if (verified.ok) {
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toEqual({ ok: false, reason: 'revoked' });
            }
        });
    });

    function snapshotBody(over: Record<string, unknown> = {}) {
        return {
            requestId: `req-${randomUUID()}`,
            tenantId: 'tenant-1',
            projectId: 'project-1',
            workspaceId,
            runId,
            accountId,
            ...over,
        };
    }

    function resolveBody(over: Record<string, unknown> = {}) {
        return {
            requestId: `req-${randomUUID()}`,
            scope: scope(),
            requestedTokenExpiresAt: Date.now() + HOUR,
            ...over,
        };
    }

    describe('authority snapshot', () => {
        it('returns both projections from one read, and null before they exist', async () => {
            const empty = await call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(),
            });
            expect(empty.statusCode).toBe(200);
            expect(empty.json()).toMatchObject({ workspace: null, run: null });

            await syncAuthority();
            const body = snapshotBody();
            const filled = await call({
                path: '/v1/managed/control/authority/snapshot', op: 'authority-snapshot', body,
            });
            expect(filled.statusCode).toBe(200);
            expect(filled.json()).toEqual({
                requestId: body.requestId,
                workspace: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1', version: 1,
                },
                run: {
                    runId, workspaceId, accountId,
                    currentAttemptId: 'attempt-1', cancelled: false, version: 1,
                },
            });
        });

        it('reports a workspace that exists before its run', async () => {
            const workspaceBody = {
                ownerAccountId: accountId, expectedVersion: 0,
                body: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1',
                },
            };
            expect((await call({
                path: '/v1/managed/control/authority/workspace',
                op: 'authority-sync', body: workspaceBody,
            })).statusCode).toBe(200);

            const filled = await call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(),
            });
            expect(filled.statusCode).toBe(200);
            expect(filled.json().workspace).toMatchObject({ workspaceId, epoch: 1 });
            expect(filled.json().run).toBeNull();
        });

        it.each([
            ['tenantId', { tenantId: 'tenant-other' }],
            ['projectId', { projectId: 'project-other' }],
        ])('refuses a %s that does not match the stored workspace', async (_label, over) => {
            await syncAuthority();
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(over),
            }), 403);
        });

        it('refuses a run that belongs to another workspace or account', async () => {
            await syncAuthority();
            const otherWorkspaceId = `ws-${randomUUID()}`;
            createdWorkspaceIds.add(otherWorkspaceId);
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody({ workspaceId: otherWorkspaceId }),
            }), 403);
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody({ accountId: otherAccountId }),
            }), 403);
        });

        it('refuses when the bearer does not own the scope', async () => {
            await syncAuthority();
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(), token: otherToken,
            }), 403);
        });
    });

    describe('authority snapshot coherency', () => {
        it('reads a committed pair after every interleaved write', async () => {
            await syncAuthority();

            // Writes and reads alternate deterministically: after each commit the
            // snapshot must show exactly that state. A read that took the two
            // projections from different moments would show the pair the writes
            // never had — a run at attempt N+1 beside a workspace at epoch N.
            let workspaceVersion = 1;
            let runVersion = 1;
            let epoch = 1;
            let attempt = 1;

            async function expectSnapshot() {
                const response = await call({
                    path: '/v1/managed/control/authority/snapshot',
                    op: 'authority-snapshot', body: snapshotBody(),
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({
                    workspace: { version: workspaceVersion, epoch },
                    run: { version: runVersion, currentAttemptId: `attempt-${attempt}` },
                });
            }

            await expectSnapshot();
            for (let step = 0; step < 4; step += 1) {
                epoch += 1;
                expect((await call({
                    path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                    body: {
                        ownerAccountId: accountId, expectedVersion: workspaceVersion,
                        body: {
                            workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                            epoch, runtimeId: 'runtime-1',
                        },
                    },
                })).statusCode).toBe(200);
                workspaceVersion += 1;
                // Read between the two writes: the run must still be the old one.
                await expectSnapshot();

                attempt += 1;
                expect((await call({
                    path: '/v1/managed/control/authority/run', op: 'authority-sync',
                    body: {
                        expectedVersion: runVersion,
                        body: {
                            runId, workspaceId, accountId,
                            currentAttemptId: `attempt-${attempt}`, cancelled: false,
                        },
                    },
                })).statusCode).toBe(200);
                runVersion += 1;
                await expectSnapshot();
            }
        });
    });

    describe('grant resolve', () => {
        beforeEach(syncAuthority);

        it('recovers a live grant after a lost mint response without changing it', async () => {
            const minted = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            });
            expect(minted.statusCode).toBe(200);
            const issued = minted.json();

            const before = await managedRowSnapshot();
            const body = resolveBody();
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(resolved.statusCode).toBe(200);
            const payload = resolved.json();
            expect(payload).toMatchObject({
                requestId: body.requestId,
                scope: scope(),
                grantId: issued.grantId,
                grantExpiresAt: issued.expiresAt,
                renewalSeq: 0,
            });
            expect(payload.tokenExpiresAt).toBe(Math.min(issued.expiresAt, body.requestedTokenExpiresAt));
            // A read that issues a credential still must not write.
            expect(await managedRowSnapshot()).toEqual(before);

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(payload.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims).toMatchObject({
                    grantId: issued.grantId, sessionId, accountId, runId,
                });
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toMatchObject({ ok: true });
            }
            // Never an account principal.
            await expect(modules.auth.auth.verifyToken(payload.token)).resolves.toBeNull();
        });

        it('re-evaluates the current grant under the signed cap, not the first answer', async () => {
            const base = Date.now();
            const mint = mintBody({ expiresAt: base + 500 });
            const minted = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mint,
            });
            expect(minted.statusCode).toBe(200);

            const renew = {
                scope: scope(), expectedGrantId: minted.json().grantId,
                expectedRenewalSeq: 0, expiresAt: base + 1_500,
            };
            expect((await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew', body: renew,
            })).statusCode).toBe(200);

            const body = resolveBody({ requestedTokenExpiresAt: base + 1_000 });
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(resolved.statusCode).toBe(200);
            // Capped by the signed request, not the first response (500) and
            // never the renewed value (1500).
            expect(resolved.json()).toMatchObject({
                tokenExpiresAt: base + 1_000, grantExpiresAt: base + 1_500, renewalSeq: 1,
            });
        });

        it('does not create, resurrect or extend anything', async () => {
            // No grant at all.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            }), 404);

            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: Date.now() + HOUR }),
            })).statusCode).toBe(200);

            // Revoked.
            expect((await call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'operator' },
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            }), 403);
        });

        it('refuses an expired grant even when the request asks for later', async () => {
            const past = Date.now() + 40;
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: past }),
            })).statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 60));
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ requestedTokenExpiresAt: Date.now() + HOUR }),
            }), 403);
        });

        it('refuses a requested expiry that is already in the past', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ requestedTokenExpiresAt: Date.now() - 1_000 }),
            }), 403);
        });

        it.each([
            ['epoch', { epoch: 2 }],
            ['runtimeId', { runtimeId: 'runtime-2' }],
            ['attemptId', { attemptId: 'attempt-2' }],
            ['workspaceAuthorityVersion', { workspaceAuthorityVersion: 2 }],
            ['runAuthorityVersion', { runAuthorityVersion: 2 }],
            ['tenantId', { tenantId: 'tenant-other' }],
            ['projectId', { projectId: 'project-other' }],
        ])('refuses a stale or wrong %s', async (_label, over) => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ scope: scope(over) }),
            }), 403);
        });

        it('refuses when the bearer does not own the scope', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody(), token: otherToken,
            }), 403);
        });

        it('refuses a stored grant left behind by an authority advance', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);

            // The workspace moves on; the caller signs the new generation.
            expect((await call({
                path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                body: {
                    ownerAccountId: accountId, expectedVersion: 1,
                    body: {
                        workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                        epoch: 2, runtimeId: 'runtime-1',
                    },
                },
            })).statusCode).toBe(200);

            const fresh = scope({ epoch: 2, workspaceAuthorityVersion: 2 });
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ scope: fresh }),
            }), 403);
        });

        it('issues a token whose claims are exactly the scope it answered with', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            });
            expect(resolved.statusCode).toBe(200);
            const payload = resolved.json();

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(payload.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                // Every one of the eleven axes, plus the expiry the DTO reports.
                const claims = verified.claims as unknown as Record<string, unknown>;
                const answered = payload.scope as Record<string, unknown>;
                expect(Object.keys(answered)).toHaveLength(11);
                for (const key of Object.keys(answered)) {
                    expect(claims[key], key).toEqual(answered[key]);
                }
                expect(verified.claims.grantId).toBe(payload.grantId);
                expect(verified.claims.expiresAt).toBe(payload.tokenExpiresAt);
            }
        });

        it.each([
            ['past the safe integer range', Number.MAX_SAFE_INTEGER + 1],
            ['zero', 0],
            ['negative', -1],
            ['fractional', 1.5],
        ])('refuses a requested expiry %s', async (_label, requested) => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const body = resolveBody({ requestedTokenExpiresAt: requested });
            const before = await managedRowSnapshot();
            const response = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(response.statusCode).not.toBe(200);
            expect(await managedRowSnapshot()).toEqual(before);
        });

        it('refuses an assertion signed for another operation', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const body = resolveBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
                assertion: assertionFor('grant-mint', body),
            }), 403);
        });
    });

    describe('a replayed mint cannot inherit a renewal', () => {
        beforeEach(syncAuthority);

        it('caps the replayed token and response at the originally signed expiry', async () => {
            const signedExpiry = Date.now() + 60_000;
            const body = mintBody({ expiresAt: signedExpiry });
            const assertion = assertionFor('grant-mint', body);

            const first = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body, assertion });
            expect(first.statusCode).toBe(200);

            const renewedExpiry = Date.now() + 300_000;
            const renewed = await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: {
                    scope: scope(), expectedGrantId: first.json().grantId,
                    expectedRenewalSeq: 0, expiresAt: renewedExpiry,
                },
            });
            expect(renewed.statusCode).toBe(200);
            expect(renewed.json().expiresAt).toBe(renewedExpiry);

            // The same body and the same assertion, replayed. It authorised
            // sixty seconds and must not come back carrying five minutes.
            const replay = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body, assertion });
            expect(replay.statusCode).toBe(200);
            expect(replay.json()).toMatchObject({ idempotent: true, expiresAt: signedExpiry });

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(replay.json().token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims.expiresAt).toBe(signedExpiry);
                // And it stops working at that expiry, not at the renewed one.
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: signedExpiry }))
                    .toEqual({ ok: false, reason: 'expired' });
            }
            // The grant itself keeps the renewal.
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(Number(row.expiresAt)).toBe(renewedExpiry);
        });
    });

    describe('reminting an expired grant over HTTP', () => {
        beforeEach(syncAuthority);

        /**
         * Moves this process's clock forward.
         *
         * Only `Date.now`, and only forward: the server, the issuer and the
         * grant core all read it, so an expiry reached this way is the one real
         * issuance produces. Rewriting `expiresAt` in the database instead would
         * put the row behind a token that is still valid — a state no writer can
         * create, since a renewal only extends and a revoke is a separate
         * field — and any conclusion drawn from it would be about the fixture.
         */
        function advanceClock(toEpochMs: number): () => void {
            const spy = vi.spyOn(Date, 'now').mockReturnValue(toEpochMs);
            return () => spy.mockRestore();
        }

        async function mintExpiring(ms: number) {
            const body = mintBody({ expiresAt: Date.now() + ms });
            const response = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body });
            expect(response.statusCode).toBe(200);
            return response.json() as { token: string; grantId: string; expiresAt: number };
        }

        it('issues a new grant whose token replaces the expired one', async () => {
            const first = await mintExpiring(400);
            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            await new Promise((resolve) => setTimeout(resolve, 500));

            const second = await mintExpiring(60_000);
            expect(second.grantId).not.toBe(first.grantId);

            // The old token names a grant this family no longer has. Verified
            // through the real issuer, not by inspecting the row.
            const oldClaims = await runtime!.scopedTokens.verify(first.token, Date.now());
            expect(oldClaims).toMatchObject({ ok: false, reason: 'expired' });

            const newClaims = await runtime!.scopedTokens.verify(second.token, Date.now());
            expect(newClaims).toMatchObject({ ok: true });
            if (newClaims.ok) {
                expect(newClaims.claims.grantId).toBe(second.grantId);
                expect(await modules.grants.resolveLiveGrant({ claims: newClaims.claims, now: Date.now() }))
                    .toMatchObject({ ok: true });
            }
        }, 20_000);

        it('rejects a token minted for the superseded grant', async () => {
            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const t0 = Date.now();
            const first = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: t0 + 2_000 }),
            });
            expect(first.statusCode).toBe(200);
            const firstJson = first.json() as { token: string; grantId: string };
            const firstClaims = await runtime!.scopedTokens.verify(firstJson.token, t0);
            expect(firstClaims).toMatchObject({ ok: true });

            const restore = advanceClock(t0 + 2_500);
            try {
                const secondBody = mintBody({ expiresAt: t0 + 60_000 });
                const second = await call({
                    path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: secondBody,
                });
                expect(second.statusCode).toBe(200);
                expect(second.json().grantId).not.toBe(firstJson.grantId);

                if (firstClaims.ok) {
                    // Two independent refusals, both real: the token has passed
                    // its own expiry, and the grant it names is gone. A direct
                    // resolver call with an earlier timestamp isolates the ID
                    // lookup check; it does not simulate a live earlier request.
                    expect(await modules.grants.resolveLiveGrant({
                        claims: firstClaims.claims, now: t0 + 1_999,
                    })).toEqual({ ok: false, reason: 'grant-unknown' });
                    expect(await runtime!.scopedTokens.verify(firstJson.token, Date.now()))
                        .toMatchObject({ ok: false, reason: 'expired' });
                }
            } finally {
                restore();
            }
        }, 20_000);

        it('refuses a renewal signed for the grant the remint replaced', async () => {
            const t0 = Date.now();
            const firstResponse = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: t0 + 2_000 }),
            });
            expect(firstResponse.statusCode).toBe(200);
            const first = firstResponse.json() as { grantId: string };

            const restore = advanceClock(t0 + 2_500);
            let second: { grantId: string };
            try {
                const secondResponse = await call({
                    path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                    body: mintBody({ expiresAt: t0 + 60_000 }),
                });
                expect(secondResponse.statusCode).toBe(200);
                second = secondResponse.json();
            } finally {
                restore();
            }

            // G1 names the superseded id and sequence 0; G2 now has sequence 1.
            // The explicit grant mismatch is checked before sequence handling.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: {
                    scope: scope(), expectedGrantId: first.grantId,
                    expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR,
                },
            }), 403);

            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(row.grantId).toBe(second.grantId);
            // Advanced by the remint, not reset: the sequence is the family's.
            expect(row.renewalSeq).toBe(1);
        });

        it('refuses a remint of a revoked family and leaves it revoked', async () => {
            await mintExpiring(60_000);
            expect((await call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'operator' },
            })).statusCode).toBe(200);
            // Fixture shortcut, as above: no token is examined in this case.
            await db.managedSessionGrant.updateMany({
                where: { runId }, data: { expiresAt: BigInt(Date.now() - 1) },
            });

            const response = await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            }), 403);
            expect(response.json()).toMatchObject({ error: 'family-revoked' });
        });

        it('keeps a delayed renewal off a later grant that carries the same id', async () => {
            // A(seq 0) → B(seq 1) → A(seq 2), each generation reaching its own
            // expiry by the clock rather than by a write. Then A's original
            // holder submits the renewal it signed at the start: the assertion
            // is still inside its own window, and only the sequence separates
            // the generations.
            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const t0 = Date.now();
            const idA = `grant-${randomUUID()}`;

            const first = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ grantId: idA, expiresAt: t0 + 2_000 }),
            });
            expect(first.statusCode).toBe(200);
            expect(first.json()).toMatchObject({ grantId: idA, renewalSeq: 0 });
            const tokenA = first.json().token as string;

            // Signed now, submitted much later: what a delayed holder would send.
            const staleRenewBody = {
                scope: scope(), expectedGrantId: idA,
                expectedRenewalSeq: 0, expiresAt: t0 + 4 * HOUR,
            };
            const staleAssertion = assertionFor('grant-renew', staleRenewBody);

            let restore = advanceClock(t0 + 2_500);
            let second: { grantId: string; token: string };
            try {
                const secondBody = mintBody({ expiresAt: t0 + 4_500 });
                const response = await call({
                    path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: secondBody,
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ renewalSeq: 1 });
                expect(response.json().grantId).not.toBe(idA);
                second = response.json();
            } finally {
                restore();
            }
            expect(second.grantId).not.toBe(idA);

            restore = advanceClock(t0 + 5_000);
            try {
                const thirdBody = mintBody({ grantId: idA, expiresAt: t0 + 60_000 });
                const third = await call({
                    path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: thirdBody,
                });
                expect(third.statusCode).toBe(200);
                expect(third.json()).toMatchObject({ grantId: idA, renewalSeq: 2 });
                const tokenC = third.json().token as string;

                const before = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
                // The exact header and body signed at t0 — not a fresh one.
                const stale = await call({
                    path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                    body: staleRenewBody, assertion: staleAssertion,
                });
                // Five seconds in, so the assertion is well inside its own
                // window: the refusal is the sequence, not the signature.
                expect(stale.statusCode).toBe(409);
                const after = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
                expect(after.renewalSeq).toBe(before.renewalSeq);
                expect(Number(after.expiresAt)).toBe(Number(before.expiresAt));

                // The first A's token has passed its own expiry, which is what
                // real issuance guarantees: it never outlives its grant.
                expect(await runtime!.scopedTokens.verify(tokenA, Date.now()))
                    .toMatchObject({ ok: false, reason: 'expired' });

                const currentClaims = await runtime!.scopedTokens.verify(tokenC, Date.now());
                expect(currentClaims).toMatchObject({ ok: true });
                if (currentClaims.ok) {
                    expect(currentClaims.claims.grantId).toBe(idA);
                    expect(await modules.grants.resolveLiveGrant({
                        claims: currentClaims.claims, now: Date.now(),
                    })).toMatchObject({ ok: true });
                }
            } finally {
                restore();
            }
        }, 30_000);

        it('refuses a remint that reuses the id it is replacing', async () => {
            const first = await mintExpiring(60_000);
            // Fixture shortcut: the row is aged directly because no token is
            // examined here, so the token-outlives-grant invariant is not in
            // play. The temporal proofs above use the clock instead.
            await db.managedSessionGrant.updateMany({
                where: { runId }, data: { expiresAt: BigInt(Date.now() - 1) },
            });
            const response = await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ grantId: first.grantId, expiresAt: Date.now() + 60_000 }),
            }), 409);
            expect(response.json()).toMatchObject({ error: 'grant-id-reused' });
        });

        it('requires the expected grant id on the wire', async () => {
            await mintExpiring(60_000);
            // A renewal that names no grant is not a renewal this contract can
            // decide; the schema refuses it before anything is read.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: { scope: scope(), expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR },
            }), 400);
        });
    });

    describe('both proofs are required', () => {
        beforeEach(syncAuthority);

        it('refuses with no bearer at all', async () => {
            await expectInert(() => app.inject({
                method: 'POST', url: '/v1/managed/control/grants/mint',
                headers: { 'content-type': 'application/json' },
                payload: JSON.stringify(mintBody()),
            }), 401);
        });

        it('refuses a valid bearer with no assertion', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody(), assertion: null,
            }), 403);
        });

        it('refuses an assertion signed by a key this server does not verify', async () => {
            const stranger = generateKeyPairSync('ed25519').privateKey;
            const body = mintBody();
            const payload = {
                kid: 'control-1', aud: AUDIENCE,
                purpose: modules.assertion.CONTROL_ASSERTION_PURPOSE, op: 'grant-mint',
                bodyDigest: modules.digest.canonicalDigest(body),
                iat: Date.now(), exp: Date.now() + 60_000,
            };
            const bytes = modules.assertion.encodeControlAssertionPayload(payload as never);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: modules.assertion.encodeControlAssertion(bytes, signBytes(null, bytes, stranger)),
            }), 403);
        });

        it('refuses an assertion for another operation', async () => {
            const body = mintBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: assertionFor('grant-revoke', body),
            }), 403);
        });

        it('refuses when the body changed after the assertion was signed', async () => {
            const signed = mintBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: { ...signed, expiresAt: signed.expiresAt + 1 },
                assertion: assertionFor('grant-mint', signed),
            }), 403);
        });

        it('refuses an expired assertion', async () => {
            const body = mintBody();
            const stale = Date.now() - 10 * 60_000;
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: assertionFor('grant-mint', body, { iat: stale, exp: stale + 60_000 }),
            }), 403);
        });

        it('refuses every route when managed control is not configured', async () => {
            for (const [path, op] of EVERY_ROUTE) {
                // Unconfigured must not degrade to the account bearer alone,
                // and must refuse before the body shape is even considered.
                await expectInert(() => call({
                    path, op, body: mintBody(), instance: unconfiguredApp,
                }), 503);
            }
        });
    });

    describe('the bearer must own the scope', () => {
        beforeEach(syncAuthority);

        it('refuses to mint for an account the bearer is not', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody(), token: otherToken,
            }), 403);
        });

        it('refuses to renew or revoke another account*s grant', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);

            // Refused and untouched: no renewal, no revocation, no timestamp.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: {
                    scope: scope(), expectedGrantId: `grant-${randomUUID()}`,
                    expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR,
                },
                token: otherToken,
            }), 403);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'x' }, token: otherToken,
            }), 403);
        });

        it('refuses to sync a run for another account', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 1,
                    body: { runId, workspaceId, accountId: otherAccountId, currentAttemptId: 'attempt-2', cancelled: false },
                },
            }), 403);
        });
    });

    describe('a scoped bearer cannot reach the control plane', () => {
        beforeEach(syncAuthority);

        it('is rejected as unauthenticated on every control route', async () => {
            const minted = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            });
            expect(minted.statusCode).toBe(200);
            const scopedToken = minted.json().token as string;

            for (const [path, op] of EVERY_ROUTE) {
                // The account verifier refuses it, so the request never reaches
                // a handler that could act on it.
                await expectInert(() => call({ path, op, body: mintBody(), token: scopedToken }), 401);
            }
        });
    });

    describe('rejected requests write nothing', () => {
        beforeEach(syncAuthority);

        it('refuses a mint whose scope is no longer current', async () => {
            expect((await call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 1,
                    body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                },
            })).statusCode).toBe(200);

            const response = await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            }), 403);
            expect(response.json()).toMatchObject({ error: 'attempt-mismatch' });
        });

        it('refuses a mint for a session the bearer does not own', async () => {
            const foreign = await db.session.create({
                data: { accountId: otherAccountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
            });
            createdSessionIds.add(foreign.id);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ scope: scope({ sessionId: foreign.id }) }),
            }), 403);
        });

        it('reports a stale expected version as a conflict without writing', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 7,
                    body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-9', cancelled: false },
                },
            }), 409);
        });

        it('refuses a workspace sync for a bearer that is not its stated owner', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                body: {
                    ownerAccountId: otherAccountId,
                    expectedVersion: 1,
                    body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 2, runtimeId: 'runtime-2' },
                },
            }), 403);
        });

        it('refuses a revoke whose scope no longer matches and leaves the grant live', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            // A different attempt derives a different family, so this revoke
            // must not touch the grant that exists — and must not tombstone
            // over it either.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope({ accountId: otherAccountId }), reason: 'x' },
            }), 403);
        });

        it('rejects an unknown field rather than ignoring it', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: { ...mintBody(), somethingElse: true },
            }), 400);
        });
    });

    /**
     * Registering the Machine a managed runtime runs as, and issuing that
     * runtime's own credential.
     *
     * Exercised through the real route: the access helper passing says the
     * rules are right, not that anything reaches them.
     */
    describe('daemon bootstrap', () => {
        /**
         * The account this machine key is wrapped for. Held here so a test can
         * open what the route stored — the only way to show the bytes that
         * survived are still the recipient's to read.
         */
        const recipient = nacl.box.keyPair();

        /**
         * The CLI's own envelope producer, loaded at runtime.
         *
         * A fixture that rebuilds the envelope here would only prove the route
         * accepts the fixture. This proves it accepts what the CLI actually
         * sends. The specifier is computed rather than written as a literal so
         * this package's compiler does not pull the CLI's sources — and its
         * newer language level — into its own program.
         */
        let buildMachineKeyEnvelopes: (
            material: { machineKey: Uint8Array; accountPublicKey: Uint8Array } | null,
            serverPublicKey: Uint8Array | null,
        ) => { dataEncryptionKey: Uint8Array | null; serverDataEncryptionKey: Uint8Array | null };

        beforeAll(async () => {
            // Anchored to this file, not to the working directory: vitest
            // reports the running spec's absolute path, so the fixture resolves
            // the same however the suite is invoked.
            const here = expect.getState().testPath!;
            const specifier = `${here.slice(0, here.lastIndexOf('/sources/'))}`
                + '/../happy-cli/src/api/encryption.ts';
            ({ buildMachineKeyEnvelopes } = await import(specifier));
        });

        /**
         * A real envelope from its single assembly point, not a byte pattern of
         * the right length. `Buffer.alloc(105, 7)` has a version byte of 7 and
         * a box that opens to nothing; it passed every check this route used to
         * make, so those checks could not have caught a wrong key — and the key
         * is write-once.
         */
        function machineEnvelope(machineKey: Uint8Array = new Uint8Array(randomBytes(32))) {
            const { dataEncryptionKey } = buildMachineKeyEnvelopes(
                { machineKey, accountPublicKey: recipient.publicKey },
                null,
            );
            return Buffer.from(dataEncryptionKey!).toString('base64');
        }

        function bootstrapBody(over: Record<string, unknown> = {}) {
            return {
                accountId,
                machineId: `machine-${randomUUID()}`,
                runtimeId: 'runtime-1',
                provisioningOperationId: `op-${randomUUID()}`,
                workspaceId,
                projectId: 'project-1',
                epoch: 1,
                daemonGrantId: `dgrant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + 3_600_000,
                metadata: '{}',
                dataEncryptionKey: machineEnvelope(),
                ...over,
            };
        }

        /** The projection a runtime is fenced into, as the control plane records it. */
        async function projectWorkspace() {
            const response = await call({
                path: '/v1/managed/control/authority/workspace',
                op: 'authority-sync',
                body: {
                    ownerAccountId: accountId,
                    expectedVersion: 0,
                    body: {
                        workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                        epoch: 1, runtimeId: 'runtime-1',
                    },
                },
            });
            expect(response.statusCode).toBe(200);
        }

        async function bootstrap(body: Record<string, unknown>, over: Record<string, unknown> = {}) {
            return call({
                path: '/v1/managed/control/daemon/bootstrap',
                op: 'daemon-bootstrap',
                body,
                ...over,
            });
        }

        it('creates the machine and issues a credential for it', async () => {
            await projectWorkspace();
            const body = bootstrapBody();
            const response = await bootstrap(body);
            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.machineId).toBe(body.machineId);
            expect(payload.generation).toBe(0);
            expect(typeof payload.token).toBe('string');

            const machine = await db.machine.findFirst({
                where: { id: body.machineId as string, accountId },
            });
            expect(machine).not.toBeNull();
            expect(Buffer.from(machine!.dataEncryptionKey!).toString('base64'))
                .toBe(body.dataEncryptionKey);
        });

        it('stores an envelope its recipient can still open', async () => {
            await projectWorkspace();
            // The cross fixture: the CLI's own producer on one side, the
            // account's private key on the other, and this route in between.
            // Shape checks alone would pass on bytes nobody can open.
            const machineKey = new Uint8Array(randomBytes(32));
            const body = bootstrapBody({ dataEncryptionKey: machineEnvelope(machineKey) });
            expect((await bootstrap(body)).statusCode).toBe(200);

            const machine = await db.machine.findFirst({
                where: { id: body.machineId as string, accountId },
            });
            const stored = Buffer.from(machine!.dataEncryptionKey!);
            expect(stored.length).toBe(105);
            expect(stored[0]).toBe(0);
            const opened = nacl.box.open(
                new Uint8Array(stored.subarray(57)),
                new Uint8Array(stored.subarray(33, 57)),
                new Uint8Array(stored.subarray(1, 33)),
                recipient.secretKey,
            );
            expect(opened).not.toBeNull();
            expect(new Uint8Array(opened!)).toEqual(machineKey);
        });

        it.each([
            ['a one-byte payload', 'AQ=='],
            ['the wrong version byte', () => {
                const raw = Buffer.from(machineEnvelope(), 'base64');
                raw[0] = 1;
                return raw.toString('base64');
            }],
            ['a truncated envelope', () => Buffer.from(machineEnvelope(), 'base64')
                .subarray(0, 104).toString('base64')],
            ['a padded envelope', () => Buffer.concat([
                Buffer.from(machineEnvelope(), 'base64'), Buffer.alloc(1),
            ]).toString('base64')],
            ['an empty field', ''],
            ['something that is not base64 at all', 'not base64!!'],
            ['base64 that does not round-trip', 'AAAA='],
        ])('refuses %s as a machine key, writing nothing', async (_name, value) => {
            // This key is write-once: a wrong one is registered permanently and
            // the account can never read its own machine. Canonical base64 by
            // itself accepted every value in this table.
            await projectWorkspace();
            const dataEncryptionKey = typeof value === 'function' ? value() : value;
            const before = await managedRowSnapshot();

            const response = await bootstrap(bootstrapBody({ dataEncryptionKey }));
            expect(response.statusCode).toBe(400);
            expect(await managedRowSnapshot()).toEqual(before);

            // The corrected request still works — nothing was kept.
            expect((await bootstrap(bootstrapBody())).statusCode).toBe(200);
        });

        it('refuses a malformed server share the same way', async () => {
            await projectWorkspace();
            const before = await managedRowSnapshot();
            const response = await bootstrap(bootstrapBody({
                serverDataEncryptionKey: 'AQ==',
            }));
            expect(response.statusCode).toBe(400);
            expect(await managedRowSnapshot()).toEqual(before);
        });

        it.each([
            ['an id longer than the credential allows', { machineId: 'm'.repeat(201) }],
            ['a workspace id longer than the credential allows', { workspaceId: 'w'.repeat(201) }],
            ['an id with surrounding whitespace', { machineId: ' machine-padded ' }],
            ['a request id with surrounding whitespace', { requestId: ' req-padded ' }],
            ['an id that is only whitespace', { runtimeId: '   ' }],
        ])('refuses %s before writing anything', async (_name, over) => {
            // A 201-character id passed the route's emptiness check, committed
            // the Machine and the grant, and failed at mint: rows left behind
            // for a request that was refused. A padded id passed too, and would
            // have stored one identity while the token claimed another.
            await projectWorkspace();
            const before = await managedRowSnapshot();

            const response = await bootstrap(bootstrapBody(over));
            expect(response.statusCode).toBe(400);
            expect(await managedRowSnapshot()).toEqual(before);

            // The corrected request still works, because nothing was kept.
            expect((await bootstrap(bootstrapBody())).statusCode).toBe(200);
        });

        it('refuses without the control assertion', async () => {
            // The bearer alone is not enough: a stolen account token must not
            // be able to create a machine and mint a runtime credential.
            const response = await bootstrap(bootstrapBody(), { assertion: null });
            expect(response.statusCode).toBe(403);
        });

        it('refuses an assertion signed for another operation', async () => {
            const body = bootstrapBody();
            const response = await bootstrap(body, { assertion: assertionFor('grant-mint', body) });
            expect(response.statusCode).toBe(403);
        });

        it('refuses a scope the bearer does not own', async () => {
            const response = await bootstrap(bootstrapBody({ accountId: 'somebody-else' }));
            expect(response.statusCode).toBe(403);
        });

        it('converges on a lost response instead of making a second machine', async () => {
            await projectWorkspace();
            // The parent stored its key material before the first call and
            // resends the same body. A second row — or a second credential —
            // would be a machine the parent cannot read.
            const body = bootstrapBody();
            const first = await bootstrap(body);
            const again = await bootstrap(body);
            expect(first.statusCode).toBe(200);
            expect(again.statusCode).toBe(200);
            expect(again.json().idempotent).toBe(true);
            expect(again.json().daemonGrantId).toBe(first.json().daemonGrantId);
            expect(await db.machine.count({ where: { id: body.machineId as string } })).toBe(1);
        });

        it('refuses material that disagrees with what was already stored', async () => {
            await projectWorkspace();
            // Write-once. Accepting a different key here would hand back a
            // credential for a machine whose contents the parent cannot read.
            const body = bootstrapBody();
            await bootstrap(body);
            const conflicting = await bootstrap(bootstrapBody({
                machineId: body.machineId,
                dataEncryptionKey: machineEnvelope(),
            }));
            expect(conflicting.statusCode).toBe(409);
        });

        it('refuses a workspace with no projection, changing nothing', async () => {
            // The prose said this; the route did not do it. A daemon minted
            // for a workspace the control plane has never projected is a
            // credential for a generation nobody has fenced.
            const before = await db.machine.count();
            const grantsBefore = await db.managedDaemonGrant.count();
            const response = await bootstrap(bootstrapBody({ workspaceId: `ws-${randomUUID()}` }));
            expect(response.statusCode).toBe(409);
            expect(await db.machine.count()).toBe(before);
            expect(await db.managedDaemonGrant.count()).toBe(grantsBefore);
        });

        it.each([
            ['epoch', { epoch: 99 }],
            ['runtimeId', { runtimeId: 'runtime-somebody-else' }],
            ['projectId', { projectId: 'project-somebody-else' }],
        ])('refuses when %s disagrees with the projection, changing nothing', async (_name, over) => {
            const before = await db.machine.count();
            const grantsBefore = await db.managedDaemonGrant.count();
            const response = await bootstrap(bootstrapBody(over));
            expect(response.statusCode).toBe(409);
            expect(await db.machine.count()).toBe(before);
            expect(await db.managedDaemonGrant.count()).toBe(grantsBefore);
        });

        it.each([
            ['metadata', () => ({ metadata: '{"different":true}' })],
            ['serverDataEncryptionKey', () => ({ serverDataEncryptionKey: machineEnvelope() })],
        ])('refuses a retry whose %s disagrees with what was stored', async (_name, build) => {
            await projectWorkspace();
            // Every field of the precreate body is immutable. A retry that
            // changed one is a different request wearing the same id.
            const over = build();
            const body = bootstrapBody({ serverDataEncryptionKey: machineEnvelope() });
            expect((await bootstrap(body)).statusCode).toBe(200);
            const conflicting = await bootstrap({ ...body, ...over });
            expect(conflicting.statusCode).toBe(409);
        });

        it('converges when two replicas are inside the database at once', async () => {
            await projectWorkspace();
            // Two control-plane replicas retrying together. Issuing both and
            // hoping they overlap does not test this: the first can commit
            // before the second opens a transaction, and then the assertions
            // pass on a plain sequential retry. The barrier holds both after
            // their reads and before their writes, so the unique violation
            // really happens — and the loser must not surface it.
            const body = bootstrapBody();
            const barrier = transactionBarrier(2);
            let responses: Awaited<ReturnType<typeof bootstrap>>[];
            try {
                responses = await Promise.all([bootstrap(body), bootstrap(body)]);
            } finally {
                barrier.restore();
            }
            const [a, b] = responses;
            expect(barrier.gated()).toBe(2);
            expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
            expect(a.json().daemonGrantId).toBe(b.json().daemonGrantId);
            expect(a.json().machineId).toBe(b.json().machineId);
            expect(await db.machine.count({ where: { id: body.machineId as string } })).toBe(1);
            expect(await db.managedDaemonGrant.count({ where: { accountId } })).toBe(1);
        });

        it.each([
            ['an empty machine id', { machineId: '' }],
            ['an expiry already past', { expiresAt: Date.now() - 1_000 }],
            ['a lifetime beyond the ceiling', { expiresAt: Date.now() + 25 * 3_600_000 }],
        ])('refuses %s before writing anything', async (_name, over) => {
            // These used to be caught at mint — after the Machine and the
            // grant had already been written. The rows stayed, and a corrected
            // retry then collided on the digest of the body it was fixing:
            // unrecoverable without an operator.
            await projectWorkspace();
            const body = bootstrapBody(over);
            const before = await managedRowSnapshot();
            const machinesBefore = await db.machine.count();

            const response = await bootstrap(body);
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect(await managedRowSnapshot()).toEqual(before);
            expect(await db.machine.count()).toBe(machinesBefore);

            // And the corrected request still works, because nothing was kept.
            const fixed = await bootstrap(bootstrapBody({
                ...over,
                machineId: `machine-${randomUUID()}`,
                expiresAt: Date.now() + 3_600_000,
            }));
            expect(fixed.statusCode).toBe(200);
        });

        it('rolls the machine back when the grant is refused', async () => {
            // The grant issue returns a refusal rather than throwing. Returned
            // normally from inside the transaction, the Machine created
            // alongside it commits anyway — a machine nobody asked for, and one
            // that then makes every corrected retry look like a mismatch.
            await projectWorkspace();
            const taken = bootstrapBody();
            expect((await bootstrap(taken)).statusCode).toBe(200);

            const machinesBefore = await db.machine.count();
            // A different request naming the same runtime generation: the
            // grant refuses, so nothing about this call may persist.
            const response = await bootstrap(bootstrapBody({
                runtimeId: taken.runtimeId,
                provisioningOperationId: taken.provisioningOperationId,
            }));
            expect(response.statusCode).toBe(409);
            expect(await db.machine.count()).toBe(machinesBefore);
        });

        it('re-runs the whole transaction when another replica commits first', async () => {
            await projectWorkspace();
            // The interleaving the retry exists for: this transaction reads,
            // finds no machine, and another replica commits that very machine
            // before it writes. The unique violation arrives inside the
            // transaction, so nothing read in it can be trusted afterwards —
            // the recovery is to run the whole thing again, which re-reads the
            // projection, the machine and the key material and then adopts
            // what the other replica stored.
            const body = bootstrapBody();
            let raced = false;
            const restore = installTransactionHook({
                onFirstWrite: async () => {
                    if (raced) return;
                    raced = true;
                    await db.machine.create({
                        data: {
                            id: body.machineId,
                            accountId,
                            metadata: body.metadata,
                            dataEncryptionKey: new Uint8Array(
                                Buffer.from(body.dataEncryptionKey, 'base64'),
                            ),
                        },
                    });
                },
            });
            let response: Awaited<ReturnType<typeof bootstrap>>;
            try {
                response = await bootstrap(body);
            } finally {
                restore();
            }
            expect(raced).toBe(true);
            expect(response.statusCode).toBe(200);
            expect(response.json().machineId).toBe(body.machineId);
            expect(await db.machine.count({ where: { id: body.machineId as string } })).toBe(1);
            expect(await db.managedDaemonGrant.count({ where: { accountId } })).toBe(1);
        });

        it('rolls back rather than committing a grant whose lifetime ran out', async () => {
            await projectWorkspace();
            // The row work between arrival and commit is unbounded. Judged
            // against the arrival time, this answers 200 with a credential
            // already expired in real time — a success the caller cannot use
            // and cannot tell from a working one.
            //
            // Refusing while the transaction is still open is what makes it
            // recoverable: once the grant commits its body is immutable and
            // its runtime generation may have only one grant, so no variation
            // of this request can ask for a longer life. Only the control
            // plane's own renewal can.
            const body = bootstrapBody({ expiresAt: Date.now() + 400 });
            const before = await managedRowSnapshot();
            let stalled = false;
            const restore = installTransactionHook({
                onStart: async () => {
                    if (stalled) return;
                    stalled = true;
                    await new Promise((resolve) => setTimeout(resolve, 700));
                },
            });
            let response: Awaited<ReturnType<typeof bootstrap>>;
            try {
                response = await bootstrap(body);
            } finally {
                restore();
            }
            expect(stalled).toBe(true);
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toBe('expired');
            // Nothing kept: no machine, and no grant that could never be minted.
            expect(await managedRowSnapshot()).toEqual(before);
        });

        it('recovers when two machines race for the same runtime grant', async () => {
            await projectWorkspace();
            // Same runtime generation and provisioning operation, different
            // machines and different grant ids. Both create their own Machine
            // and then contend on the single grant a generation may have.
            // Held at the barrier, both read no grant before either writes, so
            // the conflict is real: one is serialized behind the other and
            // must be told the generation already has its credential rather
            // than being handed a second one.
            const shared = {
                runtimeId: 'runtime-1',
                provisioningOperationId: `op-${randomUUID()}`,
            };
            const first = bootstrapBody(shared);
            const second = bootstrapBody(shared);
            const barrier = transactionBarrier(2);
            let responses: Awaited<ReturnType<typeof bootstrap>>[];
            try {
                responses = await Promise.all([bootstrap(first), bootstrap(second)]);
            } finally {
                barrier.restore();
            }
            expect(barrier.gated()).toBe(2);
            expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
            const loser = responses.find((response) => response.statusCode === 409)!;
            expect(loser.json().error).toBe('runtime-grant-exists');

            // One grant for the generation, and the refused request left no
            // machine of its own behind.
            const grants = await db.managedDaemonGrant.findMany({ where: { accountId } });
            expect(grants).toHaveLength(1);
            const winner = responses.findIndex((response) => response.statusCode === 200);
            expect(grants[0].daemonGrantId).toBe([first, second][winner].daemonGrantId);
            expect(await db.machine.count({ where: { accountId } })).toBe(1);
        });

        it('refuses a reused grant id instead of failing inside the transaction', async () => {
            await projectWorkspace();
            // A grant id that already belongs to another generation. Both
            // lookups inside the grant issue miss — different request id,
            // different runtime — so the insert violates the primary key
            // *inside the caller's transaction*.
            //
            // That transaction is already aborted by then, so a retry issued
            // into it returns "current transaction is aborted" and the route
            // sees an error it cannot classify: the P2002 is masked and the
            // caller gets a server fault for what is a conflict. The recovery
            // belongs to whoever owns the transaction, and it re-runs the
            // whole thing rather than patching up inside a failed one.
            const taken = bootstrapBody();
            expect((await bootstrap(taken)).statusCode).toBe(200);

            const before = await managedRowSnapshot();
            const response = await bootstrap(bootstrapBody({
                daemonGrantId: taken.daemonGrantId,
            }));
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('daemon-grant-conflict');
            // And the refused request left nothing of its own behind.
            expect(await managedRowSnapshot()).toEqual(before);
        });

        it('has the loser of a key race adopt what the winner stored', async () => {
            // Two bodies with different key material for the same keyless
            // machine, held after their reads and released together. Only one
            // may own the key; the other must be refused rather than told its
            // own material was stored, which would hand back a credential for
            // a machine whose contents it cannot read.
            //
            // What decides it here is the stored-key comparison on the retry,
            // not the `updateMany` null guard: under Serializable the second
            // writer is rolled back and re-run rather than shown a stale
            // count, so the count-0 branch is a backstop this fixture does not
            // reach.
            await projectWorkspace();
            const machineId = `machine-${randomUUID()}`;
            // A machine registered the ordinary way, with no key yet.
            await db.machine.create({
                data: { id: machineId, accountId, metadata: '{}' },
            });

            const first = bootstrapBody({ machineId, metadata: '{}' });
            const second = bootstrapBody({ machineId, metadata: '{}' });
            const barrier = transactionBarrier(2);
            let responses: Awaited<ReturnType<typeof bootstrap>>[];
            try {
                responses = await Promise.all([bootstrap(first), bootstrap(second)]);
            } finally {
                barrier.restore();
            }
            expect(barrier.gated()).toBe(2);
            // Exactly one of them may own the key; the other is refused rather
            // than told its own material was stored.
            const codes = responses.map((response) => response.statusCode).sort();
            expect(codes).toEqual([200, 409]);

            const wonIndex = responses.findIndex((response) => response.statusCode === 200);
            const winner = [first, second][wonIndex];
            const stored = await db.machine.findFirst({ where: { id: machineId } });
            expect(Buffer.from(stored!.dataEncryptionKey!).toString('base64'))
                .toBe(winner.dataEncryptionKey);
            // The refused one left nothing behind either.
            expect(await db.managedDaemonGrant.count({ where: { accountId } })).toBe(1);
            expect((await db.managedDaemonGrant.findMany({ where: { accountId } }))[0].daemonGrantId)
                .toBe(winner.daemonGrantId);
        });

        it('refuses a retry that adds a server envelope the stored machine has not got', async () => {
            // Stored null and submitted non-null used to compare equal, which
            // let a different body through as if it were the same request.
            await projectWorkspace();
            const body = bootstrapBody();
            expect((await bootstrap(body)).statusCode).toBe(200);
            const conflicting = await bootstrap({
                ...body,
                serverDataEncryptionKey: machineEnvelope(),
            });
            expect(conflicting.statusCode).toBe(409);
        });

        it('re-reads the projection inside the transaction that writes', async () => {
            // Fencing the generation *before* the request only exercises the
            // check the handler already makes before the transaction opens —
            // deleting the re-read inside it would not have shown up. The hook
            // fences after that first check has passed and before the
            // transaction's own read, which is the window the re-read exists
            // for.
            await projectWorkspace();
            const body = bootstrapBody();
            let fenced = false;
            const restore = installTransactionHook({
                onStart: async () => {
                    if (fenced) return;
                    fenced = true;
                    await db.managedWorkspaceAuthority.update({
                        where: { workspaceId },
                        data: { epoch: 2 },
                    });
                },
            });
            const before = await managedRowSnapshot();
            let response: Awaited<ReturnType<typeof bootstrap>>;
            try {
                response = await bootstrap(body);
            } finally {
                restore();
            }
            expect(fenced).toBe(true);
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toBe('workspace-authority-mismatch');
            // The fence itself changed the projection row, so the comparison is
            // against the fenced state — everything else must be untouched.
            const after = await managedRowSnapshot();
            expect(after.machines).toEqual(before.machines);
            expect(after.daemonGrants).toEqual(before.daemonGrants);
        });

        it('never mints a credential outliving what the signed request asked for', async () => {
            await projectWorkspace();
            // An idempotent retry can return a row renewed to a later expiry.
            // Minting against that would let a replayed original request
            // collect a credential longer than the one it signed for.
            const body = bootstrapBody();
            const first = await bootstrap(body);
            expect(first.statusCode).toBe(200);
            await db.managedDaemonGrant.update({
                where: { daemonGrantId: body.daemonGrantId as string },
                data: { expiresAt: BigInt((body.expiresAt as number) + 3_600_000) },
            });
            const replay = await bootstrap(body);
            expect(replay.statusCode).toBe(200);
            expect(replay.json().expiresAt).toBe(body.expiresAt);
        });
    });

    describe('reading a transcript', () => {
        function readScope(over: Record<string, unknown> = {}) {
            return {
                tenantId: 'tenant-1',
                projectId: 'project-1',
                sessionId,
                sessionOwnerAccountId: accountId,
                viewerAccountId: accountId,
                /** The generation the parent would have assigned. */
                aclRevision: 1,
                ...over,
            };
        }

        it('mints a bearer that names no run', async () => {
            /*
             * The point of the separate surface: a transcript outlives its run,
             * so the token that reads one names none. Minted through
             * `grants/mint` it would have to, and a dormant project has nothing
             * to name.
             */
            const body = {
                scope: readScope(),
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
            };
            const response = await call({ path: '/v1/managed/control/grants/read/mint', op: 'read-grant-mint', body });
            expect(response.statusCode).toBe(200);
            expect(response.json().purpose).toBe('transcript-read');
            // The token is opaque on the wire; what this level can say is that
            // the row it was minted from carries no run, and that the purpose
            // came back as asked.
            const row = await db.managedSessionGrant.findUniqueOrThrow({ where: { grantId: body.grantId } });
            expect(row.runId).toBeNull();
            expect(row.purpose).toBe('transcript-read');
        });

        it('refuses an assertion signed for minting a runner credential', async () => {
            // One assertion must not mint both: a control plane authorised to
            // start work would otherwise be authorised to hand out reading.
            const body = {
                scope: readScope(),
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
            };
            const response = await call({
                path: '/v1/managed/control/grants/read/mint',
                op: 'read-grant-mint',
                body,
                assertion: assertionFor('grant-mint', body),
            });
            expect(response.statusCode).toBe(403);
        });

        it('mints for a viewer who is not the owner, and serves that viewer its own envelope', async () => {
            /*
             * The shared case, end to end and on real rows: a company project
             * read by a member whose Happy account is not the session owner's.
             * The parent holds **that member's** bearer — the owner's is not
             * available and must never be invented — and proves the member may
             * read with the control assertion this route requires.
             *
             * The envelope comes with the request because this server cannot
             * make one: it holds the wrapped key and nothing that opens it.
             */
            const envelope = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 5)]).toString('base64');
            const body = {
                scope: {
                    tenantId: 'tenant-1',
                    projectId: 'project-1',
                    sessionId,
                    sessionOwnerAccountId: accountId,
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                },
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                viewerDataEncryptionKey: envelope,
            };
            const response = await call({
                path: '/v1/managed/control/grants/read/mint',
                op: 'read-grant-mint',
                body,
                // The viewer's own bearer, which is what the parent has.
                token: otherToken,
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().viewerAccountId).toBe(otherAccountId);

            const row = await db.managedSessionGrant.findUniqueOrThrow({ where: { grantId: body.grantId } });
            expect(row.accountId).toBe(accountId);
            expect(row.viewerAccountId).toBe(otherAccountId);
            expect(Buffer.from(row.viewerDataEncryptionKey!).toString('base64')).toBe(envelope);
            expect(row.runId).toBeNull();
        });

        it('refuses a viewer with no envelope of its own', async () => {
            // A grant that is valid and useless: the stored envelope is the
            // owner's, so this viewer could never decrypt anything.
            const body = {
                scope: {
                    tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                    sessionOwnerAccountId: accountId, viewerAccountId: otherAccountId,
                },
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
            };
            const response = await call({
                path: '/v1/managed/control/grants/read/mint', op: 'read-grant-mint', body, token: otherToken,
            });
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect(await db.managedSessionGrant.findUnique({ where: { grantId: body.grantId } })).toBeNull();
        });

        it('withdraws a viewer without that viewer presenting anything', async () => {
            /*
             * The removal that matters most: a member taken off a project, an
             * account unlinked, a credential already revoked. Requiring the
             * viewer to co-operate in ending their own access would make those
             * exact cases impossible.
             *
             * The parent's assertion is the authority; the bearer here is the
             * admin's, not the removed member's.
             */
            const envelope = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 6)]).toString('base64');
            const scope = {
                tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                sessionOwnerAccountId: accountId, viewerAccountId: otherAccountId,
                aclRevision: 1,
            };
            const grantId = `grant-${randomUUID()}`;
            const minted = await call({
                path: '/v1/managed/control/grants/read/mint',
                op: 'read-grant-mint',
                body: {
                    scope, grantId, requestId: `req-${randomUUID()}`,
                    expiresAt: Date.now() + HOUR, viewerDataEncryptionKey: envelope,
                },
                token: otherToken,
            });
            expect(minted.statusCode).toBe(200);

            // The owner's bearer — the removed member presents nothing at all.
            const revoked = await call({
                path: '/v1/managed/control/grants/read/revoke',
                op: 'read-grant-revoke',
                body: { scope, reason: 'member-removed' },
            });
            expect(revoked.statusCode).toBe(200);
            const row = await db.managedSessionGrant.findUniqueOrThrow({ where: { grantId } });
            expect(row.revokedAt).not.toBeNull();
            expect(row.revokedReason).toBe('member-removed');
        });

        it('refuses a revoke aimed at a scope whose owner does not hold the session', async () => {
            // The bearer identity is not the authority here, so the scope is
            // what must be checked: a caller cannot write tombstones against
            // sessions it merely guessed at.
            const response = await call({
                path: '/v1/managed/control/grants/read/revoke',
                op: 'read-grant-revoke',
                body: {
                    scope: {
                        tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                        sessionOwnerAccountId: otherAccountId, viewerAccountId: otherAccountId,
                        aclRevision: 1,
                    },
                    reason: 'guessed',
                },
            });
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
        });

        it('refuses one account minting a read grant for another account\'s session', async () => {
            /*
             * The bearer is a real account, and the owner it names really does
             * own the session — so the ownership comparison inside the grant
             * path is satisfied. What must stop this is the route: an account
             * may only mint against **itself**, or any account could hand out
             * reading of anyone's session it could name.
             */
            const body = {
                scope: readScope(),
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
            };
            // The scope names this account as the viewer, and a different
            // account presents it. Minting for somebody else's viewing is how
            // one account would hand out reading in another's name.
            const response = await call({
                path: '/v1/managed/control/grants/read/mint',
                op: 'read-grant-mint',
                body,
                token: otherToken,
            });
            expect(response.statusCode).toBe(403);
            expect(await db.managedSessionGrant.findUnique({ where: { grantId: body.grantId } }))
                .toBeNull();
        });

        it('refuses an owner the bearer does not own', async () => {
            const body = {
                scope: readScope({ sessionOwnerAccountId: 'someone-else' }),
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
            };
            expect((await call({
                path: '/v1/managed/control/grants/read/mint', op: 'read-grant-mint', body,
            })).statusCode).toBe(403);
        });

        describe('an access list that changes', () => {
            const envelope = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 4)]).toString('base64');

            function mint(revision: number, over: Record<string, unknown> = {}) {
                return call({
                    path: '/v1/managed/control/grants/read/mint',
                    op: 'read-grant-mint',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: revision }),
                        grantId: `grant-${randomUUID()}`,
                        requestId: `req-${randomUUID()}`,
                        expiresAt: Date.now() + 120_000,
                        viewerDataEncryptionKey: envelope,
                        ...over,
                    },
                    token: otherToken,
                });
            }

            function resolve(revision: number, over: Record<string, unknown> = {}) {
                return call({
                    path: '/v1/managed/control/grants/read/resolve',
                    op: 'read-grant-resolve',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: revision }),
                        requestedTokenExpiresAt: Date.now() + 60_000,
                        ...over,
                    },
                    token: otherToken,
                });
            }

            it('refuses a request that names no generation at all', async () => {
                // Type-level requirement is not enough: the wire has to refuse
                // it too, or a caller written before this axis silently lands
                // on one generation for all time.
                const response = await call({
                    path: '/v1/managed/control/grants/read/mint',
                    op: 'read-grant-mint',
                    body: {
                        scope: {
                            tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                            sessionOwnerAccountId: accountId, viewerAccountId: otherAccountId,
                        },
                        grantId: `grant-${randomUUID()}`,
                        requestId: `req-${randomUUID()}`,
                        expiresAt: Date.now() + 120_000,
                        viewerDataEncryptionKey: envelope,
                    },
                    token: otherToken,
                });
                expect(response.statusCode).toBe(400);
            });

            it('lets a re-added member back in, and leaves the old row withdrawn', async () => {
                const first = await mint(1);
                expect(first.statusCode).toBe(200);
                const revoked = await call({
                    path: '/v1/managed/control/grants/read/revoke',
                    op: 'read-grant-revoke',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: 1 }),
                        reason: 'member-removed',
                    },
                });
                expect(revoked.statusCode).toBe(200);

                const rejoined = await mint(2);
                expect(rejoined.statusCode).toBe(200);
                expect(rejoined.json().grantId).not.toBe(first.json().grantId);
                expect((await db.managedSessionGrant.findUniqueOrThrow({
                    where: { grantId: first.json().grantId },
                })).revokedAt).not.toBeNull();
            });

            it('answers a stale mint and a stale revoke with a conflict', async () => {
                expect((await mint(2)).statusCode).toBe(200);
                const staleMint = await mint(1);
                expect(staleMint.statusCode).toBe(409);
                expect(staleMint.json().error).toBe('revision-stale');

                const staleRevoke = await call({
                    path: '/v1/managed/control/grants/read/revoke',
                    op: 'read-grant-revoke',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: 1 }),
                        reason: 'late-removal',
                    },
                });
                expect(staleRevoke.statusCode).toBe(409);
                expect(staleRevoke.json().error).toBe('revision-stale');
            });

            it('hands a second reader a token without rotating the grant', async () => {
                const minted = await mint(1);
                expect(minted.statusCode).toBe(200);
                const before = await db.managedSessionGrant.findUniqueOrThrow({
                    where: { grantId: minted.json().grantId },
                });

                const resolved = await resolve(1);
                expect(resolved.statusCode).toBe(200);
                expect(resolved.json().grantId).toBe(minted.json().grantId);
                expect(typeof resolved.json().token).toBe('string');
                expect(resolved.json().token).not.toBe(minted.json().token);
                expect(await db.managedSessionGrant.findUniqueOrThrow({
                    where: { grantId: minted.json().grantId },
                })).toEqual(before);
            });

            it('refuses to resolve what does not exist, and writes nothing', async () => {
                const response = await resolve(1);
                expect(response.statusCode).toBe(404);
                expect(await db.managedReadAclWatermark.findMany({ where: { sessionId } })).toEqual([]);
            });

            it('refuses an assertion signed for minting', async () => {
                // Recovering a token must not be reachable by a signature that
                // was authorised to issue a new grant, or the reverse.
                expect((await mint(1)).statusCode).toBe(200);
                const response = await call({
                    path: '/v1/managed/control/grants/read/resolve',
                    op: 'read-grant-mint',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: 1 }),
                        requestedTokenExpiresAt: Date.now() + 60_000,
                    },
                    token: otherToken,
                });
                expect(response.statusCode).toBeGreaterThanOrEqual(400);
            });

            it('refuses a bearer that is not the viewer', async () => {
                expect((await mint(1)).statusCode).toBe(200);
                const response = await call({
                    path: '/v1/managed/control/grants/read/resolve',
                    op: 'read-grant-resolve',
                    body: {
                        scope: readScope({ viewerAccountId: otherAccountId, aclRevision: 1 }),
                        requestedTokenExpiresAt: Date.now() + 60_000,
                    },
                });
                expect(response.statusCode).toBe(403);
            });
        });

        it('withdraws a viewer, and says so again on a repeat', async () => {
            const grantId = `grant-${randomUUID()}`;
            await call({
                path: '/v1/managed/control/grants/read/mint',
                op: 'read-grant-mint',
                body: {
                    scope: readScope(), grantId,
                    requestId: `req-${randomUUID()}`, expiresAt: Date.now() + HOUR,
                },
            });
            const body = { scope: readScope(), reason: 'acl-withdrawn' };
            const first = await call({ path: '/v1/managed/control/grants/read/revoke', op: 'read-grant-revoke', body });
            expect(first.statusCode).toBe(200);
            expect(first.json()).toEqual({ state: 'revoked', alreadyRevoked: false });
            const again = await call({ path: '/v1/managed/control/grants/read/revoke', op: 'read-grant-revoke', body });
            expect(again.json()).toEqual({ state: 'revoked', alreadyRevoked: true });
            const row = await db.managedSessionGrant.findUniqueOrThrow({ where: { grantId } });
            expect(row.revokedAt).not.toBeNull();
        });
    });
    describe('answering a permission prompt', () => {
        const envelope = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 9)]).toString('base64');

        beforeEach(async () => {
            // An approval names the run it answers for, so the authority the
            // scope is compared against has to exist.
            await syncAuthority();
        });

        function approvalBody(over: Record<string, unknown> = {}) {
            return {
                scope: scope(),
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                viewerAccountId: otherAccountId,
                viewerDataEncryptionKey: envelope,
                aclRevision: 1,
                ...over,
            };
        }

        async function mintApproval(over: Record<string, unknown> = {}) {
            const body = approvalBody(over);
            const response = await call({
                path: '/v1/managed/control/grants/approval/mint',
                op: 'approval-grant-mint',
                body,
                token: otherToken,
            });
            return { body, response };
        }

        it('mints a bearer for the approver, carrying the run it answers for', async () => {
            const { body, response } = await mintApproval();
            expect(response.statusCode).toBe(200);
            expect(response.json().purpose).toBe('approval-control');
            expect(response.json().viewerAccountId).toBe(otherAccountId);
            const row = await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: body.grantId as string },
            });
            expect(row.viewerAccountId).toBe(otherAccountId);
            // Unlike a read grant, this one names the run: an answer for a
            // superseded attempt answers a question nobody is posing.
            expect(row.runId).toBe(runId);
            expect(row.attemptId).toBe('attempt-1');
        });

        it('leaves the runner grant of the same scope alone', async () => {
            /*
             * The regression this exists for: the family carries the viewer, so
             * a lookup that forgets it finds the runner's row. Minting an
             * approval must add a row, never move the run's own credential.
             */
            const runner = await call({
                path: '/v1/managed/control/grants/mint',
                op: 'grant-mint',
                body: {
                    scope: scope(), grantId: `grant-${randomUUID()}`,
                    requestId: `req-${randomUUID()}`, expiresAt: Date.now() + HOUR,
                },
            });
            expect(runner.statusCode).toBe(200);
            const before = await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: runner.json().grantId },
            });

            const { response } = await mintApproval();
            expect(response.statusCode).toBe(200);
            expect(await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: runner.json().grantId },
            })).toEqual(before);
        });

        it('refuses a bearer that is not the approver it names', async () => {
            // The parent holds the approver's token, never the owner's.
            const body = approvalBody();
            const response = await call({
                path: '/v1/managed/control/grants/approval/mint',
                op: 'approval-grant-mint',
                body,
            });
            expect(response.statusCode).toBe(403);
            expect(await db.managedSessionGrant.findUnique({
                where: { grantId: body.grantId as string },
            })).toBeNull();
        });

        it('refuses an approver who is not the owner and brings no envelope', async () => {
            // Answering means sealing with the session key. A grant without an
            // envelope for that account would be valid and unusable.
            const body = approvalBody({ viewerDataEncryptionKey: undefined });
            const response = await call({
                path: '/v1/managed/control/grants/approval/mint',
                op: 'approval-grant-mint',
                body,
                token: otherToken,
            });
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect(await db.managedSessionGrant.findUnique({
                where: { grantId: body.grantId as string },
            })).toBeNull();
        });

        it('refuses an assertion signed for minting a reader', async () => {
            // Handing out reading must not also hand out answering.
            const body = approvalBody();
            const response = await call({
                path: '/v1/managed/control/grants/approval/mint',
                op: 'read-grant-mint',
                body,
                token: otherToken,
            });
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect(await db.managedSessionGrant.findUnique({
                where: { grantId: body.grantId as string },
            })).toBeNull();
        });

        it('withdraws an approver without that approver presenting anything', async () => {
            const { body } = await mintApproval();
            const revokeBody = {
                scope: scope(), reason: 'approver-removed', viewerAccountId: otherAccountId, aclRevision: 1,
            };
            // The owner's bearer; the removed approver presents nothing.
            const revoked = await call({
                path: '/v1/managed/control/grants/approval/revoke',
                op: 'approval-grant-revoke',
                body: revokeBody,
            });
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ state: 'revoked', alreadyRevoked: false });
            const row = await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: body.grantId as string },
            });
            expect(row.revokedAt).not.toBeNull();
            expect(row.revokedReason).toBe('approver-removed');

            const again = await call({
                path: '/v1/managed/control/grants/approval/revoke',
                op: 'approval-grant-revoke',
                body: revokeBody,
            });
            expect(again.json()).toEqual({ state: 'revoked', alreadyRevoked: true });
        });

        it('withdraws one approver and not the run', async () => {
            const { body: approval } = await mintApproval();
            const runner = await call({
                path: '/v1/managed/control/grants/mint',
                op: 'grant-mint',
                body: {
                    scope: scope(), grantId: `grant-${randomUUID()}`,
                    requestId: `req-${randomUUID()}`, expiresAt: Date.now() + HOUR,
                },
            });
            expect(runner.statusCode).toBe(200);

            await call({
                path: '/v1/managed/control/grants/approval/revoke',
                op: 'approval-grant-revoke',
                body: { scope: scope(), reason: 'approver-removed', viewerAccountId: otherAccountId, aclRevision: 1 },
            });
            expect((await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: approval.grantId as string },
            })).revokedAt).not.toBeNull();
            expect((await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: runner.json().grantId },
            })).revokedAt).toBeNull();
        });

        it('hands a second tab a token for the same grant, without rotating it', async () => {
            /*
             * A browser loses its bearer on a reload, a new tab or a restart.
             * Minting again is refused for the live family — and replacing it
             * would kill the bearer the other tab is answering with. So the
             * recovery is a read.
             */
            const { body } = await mintApproval();
            const before = await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: body.grantId as string },
            });

            const resolved = await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body: {
                    scope: scope(),
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                    requestedTokenExpiresAt: Date.now() + 60_000,
                },
                token: otherToken,
            });
            expect(resolved.statusCode).toBe(200);
            expect(resolved.json().grantId).toBe(body.grantId);
            expect(resolved.json().purpose).toBe('approval-control');
            expect(resolved.json().viewerAccountId).toBe(otherAccountId);
            expect(typeof resolved.json().token).toBe('string');
            expect(await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: body.grantId as string },
            })).toEqual(before);
        });

        it('never answers later than the grant itself', async () => {
            await mintApproval();
            const resolved = await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body: {
                    scope: scope(),
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                    requestedTokenExpiresAt: Date.now() + 10 * HOUR,
                },
                token: otherToken,
            });
            expect(resolved.statusCode).toBe(200);
            expect(resolved.json().expiresAt).toBe(resolved.json().grantExpiresAt);
        });

        it('refuses to resolve a grant from a superseded attempt', async () => {
            /*
             * The one way this differs from reading a transcript: an approval
             * names the run it answers for. Handing back a token minted for an
             * attempt that has been replaced would let somebody answer a
             * question nobody is still posing.
             */
            await mintApproval();
            await modules.projection.syncRunAuthority({
                body: {
                    runId, workspaceId, accountId,
                    currentAttemptId: 'attempt-2', cancelled: false,
                },
                expectedVersion: 1,
                now: Date.now(),
            });
            const resolved = await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body: {
                    scope: scope(),
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                    requestedTokenExpiresAt: Date.now() + 60_000,
                },
                token: otherToken,
            });
            expect(resolved.statusCode).toBeGreaterThanOrEqual(400);
        });

        it('refuses to resolve what was withdrawn, and what never existed', async () => {
            const missing = await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body: {
                    scope: scope(),
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                    requestedTokenExpiresAt: Date.now() + 60_000,
                },
                token: otherToken,
            });
            expect(missing.statusCode).toBe(404);

            await mintApproval();
            await call({
                path: '/v1/managed/control/grants/approval/revoke',
                op: 'approval-grant-revoke',
                body: { scope: scope(), reason: 'approver-removed', viewerAccountId: otherAccountId, aclRevision: 1 },
            });
            const revoked = await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body: {
                    scope: scope(),
                    viewerAccountId: otherAccountId,
                    aclRevision: 1,
                    requestedTokenExpiresAt: Date.now() + 60_000,
                },
                token: otherToken,
            });
            expect(revoked.statusCode).toBeGreaterThanOrEqual(400);
        });

        it('refuses a bearer that is not the approver, and an assertion signed to mint', async () => {
            await mintApproval();
            const body = {
                scope: scope(),
                viewerAccountId: otherAccountId,
                aclRevision: 1,
                requestedTokenExpiresAt: Date.now() + 60_000,
            };
            expect((await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-resolve',
                body,
            })).statusCode).toBe(403);
            expect((await call({
                path: '/v1/managed/control/grants/approval/resolve',
                op: 'approval-grant-mint',
                body,
                token: otherToken,
            })).statusCode).toBeGreaterThanOrEqual(400);
        });

        it('refuses an assertion signed for withdrawing a reader', async () => {
            const { body } = await mintApproval();
            const response = await call({
                path: '/v1/managed/control/grants/approval/revoke',
                op: 'read-grant-revoke',
                body: { scope: scope(), reason: 'wrong-op', viewerAccountId: otherAccountId, aclRevision: 1 },
            });
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect((await db.managedSessionGrant.findUniqueOrThrow({
                where: { grantId: body.grantId as string },
            })).revokedAt).toBeNull();
        });
    });
});
