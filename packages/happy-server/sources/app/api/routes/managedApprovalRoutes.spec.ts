/**
 * Answering a permission prompt, through the real route.
 *
 * The unit tests around the allowlist prove which purpose reaches this path.
 * What only this level shows is that the **real** pieces agree: the real
 * Fastify instance with the real session-scope decorator, a grant issued by the
 * real issuer against a real database, and the real dispatcher deciding whether
 * the run was reached.
 *
 * The one stub is the child's own connection. A managed socket is a socket, and
 * this suite is not about transport: a registry entry with a channel that
 * answers stands in for it, so "delivered" here means the packet was handed to
 * the connection the dispatcher chose, addressed as the child would read it.
 *
 * Two properties are asserted throughout:
 *
 *  - a refusal relays **nothing** — a 403 that still handed the run an answer
 *    would be an approval, whatever the status code said;
 *  - an undelivered answer is never reported as delivered, because the person
 *    is looking at a prompt that is still open.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL`, like the other real-database
 * suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import type { PrismaClient } from '@prisma/client';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';

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

const HOUR = 3_600_000;

/** A viewer envelope of the shape `issueSessionGrant` accepts: version byte, then the sealed key. */
const APPROVER_ENVELOPE = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 7)]).toString('base64');

let db: PrismaClient;
let modules: {
    auth: typeof import('@/app/auth/auth');
    tokens: typeof import('@/app/auth/sessionScopedToken');
    enable: typeof import('@/app/api/utils/enableAuthentication');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
    approval: typeof import('@/app/api/routes/managedApprovalRoutes');
    registry: typeof import('@/app/api/socket/managed/managedSocketRegistry');
    queue: typeof import('@/app/api/socket/managed/managedOutboundQueue');
};

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let app: FastifyInstance;
let issuer: SessionScopedTokenIssuer;

let ownerAccountId: string;
let approverAccountId: string;
let sessionId: string;
let otherSessionId: string;
let workspaceId: string;
let runId: string;
let approvalGrantId: string;
let approvalExpiresAt: number;
let approverToken: string;

/**
 * A base64 blob standing in for a sealed `PermissionResponse`.
 *
 * Its bytes are never inspected by anything under test: this server holds no
 * key that opens it, and the child's own manager is what decodes it.
 */
const SEALED = Buffer.from('{"id":"toolu_1","approved":true}').toString('base64');

/** Packets the stubbed child connection was handed, in order. */
type Relayed = { event: string; args: unknown[] };
let relayed: Relayed[];

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
        accountId: ownerAccountId,
        workspaceAuthorityVersion: 1,
        runAuthorityVersion: 1,
        ...over,
    };
}

function claimsFor(over: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    const s = scope();
    return {
        v: 1,
        grantId: approvalGrantId,
        accountId: s.accountId,
        sessionId: s.sessionId,
        tenantId: s.tenantId,
        projectId: s.projectId,
        workspaceId: s.workspaceId,
        runtimeId: s.runtimeId,
        runId: s.runId,
        attemptId: s.attemptId,
        epoch: s.epoch,
        workspaceAuthorityVersion: s.workspaceAuthorityVersion,
        runAuthorityVersion: s.runAuthorityVersion,
        purpose: 'approval-control' as const,
        viewerAccountId: approverAccountId,
        expiresAt: approvalExpiresAt,
        ...over,
    };
}

async function mint(over: Partial<SessionScopedClaims> = {}): Promise<string> {
    const minted = await issuer.mint(claimsFor(over), Date.now());
    if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
    return minted.token;
}

function answer(input: {
    token: string;
    sessionId?: string;
    body?: unknown;
}) {
    return app.inject({
        method: 'POST',
        url: `/v1/managed/sessions/${input.sessionId ?? sessionId}/permission`,
        headers: {
            authorization: `Bearer ${input.token}`,
            'content-type': 'application/json',
        },
        payload: JSON.stringify(input.body ?? { requestId: 'call-1', payload: SEALED }),
    });
}

/**
 * A managed connection for this session that behaves as told.
 *
 * `respond` decides what the child does with the packet: answer it, refuse the
 * channel, or say nothing at all. Everything the route hands it is recorded, so
 * a refusal can be shown to have relayed nothing rather than merely to have
 * returned a status code.
 */
function connectChild(respond: (item: {
    ack?: (response: unknown) => void;
    onRefused?: (closure: { kind: string }) => void;
}) => void = (item) => item.ack?.('child-answer-ciphertext')): string {
    const socketId = `socket-${randomUUID()}`;
    modules.registry.managedSocketRegistry.add({
        socketId,
        accountId: ownerAccountId,
        sessionId,
        grantId: approvalGrantId,
        runId,
        attemptId: 'attempt-1',
        rpcNames: new Set(['permission']),
        connectedAt: Date.now(),
        channel: {
            closed: false,
            enqueue: (item: Relayed & {
                ack?: (response: unknown) => void;
                onRefused?: (closure: { kind: string }) => void;
            }) => {
                relayed.push({ event: item.event, args: item.args });
                respond(item);
            },
        } as never,
    });
    return socketId;
}

/**
 * A connection built on the **real** outbound channel.
 *
 * The stub above is enough for cases about the route's own decisions. It is not
 * enough for the checks the channel performs on the way out — the second
 * authority behind a relayed answer is re-read there, immediately before the
 * emit, and a stub that ignores that field would report the guard working while
 * it was never called.
 */
function connectRealChild(input: {
    answer?: (respond: (value: unknown) => void) => void;
    /**
     * Runs inside the channel's own grant check — that is, **after** the route
     * authorised the request and **before** the packet is emitted.
     *
     * That window is the whole subject: the approver was live when the bearer
     * was checked, and the packet then waits (another replica, a queue, a slow
     * read). A revoke that commits in there is invisible to the route.
     */
    duringCheck?: () => Promise<void>;
} = {}): {
    socketId: string;
    emitted: { event: string; args: unknown[] }[];
    refusals: string[];
} {
    const socketId = `socket-${randomUUID()}`;
    const emitted: { event: string; args: unknown[] }[] = [];
    const refusals: string[] = [];
    const socket = {
        emit: (event: string, ...args: unknown[]) => {
            const ack = args[args.length - 1];
            emitted.push({ event, args: args.slice(0, -1) });
            if (typeof ack === 'function') {
                const respond = (value: unknown) => (ack as (...a: unknown[]) => void)(value);
                if (input.answer) input.answer(respond);
                else respond('child-answer-ciphertext');
            }
            return true;
        },
        disconnect: () => {},
    };
    const channel = new modules.queue.ManagedOutboundChannel(
        socket as never,
        // The run's own grant: live throughout. What these cases are about is
        // the *other* authority.
        async () => {
            if (input.duringCheck) await input.duringCheck();
            return { ok: true as const };
        },
        (closure: { kind: string }) => { refusals.push(closure.kind); },
    );
    modules.registry.managedSocketRegistry.add({
        socketId,
        accountId: ownerAccountId,
        sessionId,
        grantId: approvalGrantId,
        runId,
        attemptId: 'attempt-1',
        rpcNames: new Set(['permission']),
        connectedAt: Date.now(),
        channel: channel as never,
    });
    return { socketId, emitted, refusals };
}

describe.skipIf(!enabled)('answering a permission prompt (real Fastify + PostgreSQL)', () => {
    beforeAll(async () => {
        modules = {
            auth: await import('@/app/auth/auth'),
            tokens: await import('@/app/auth/sessionScopedToken'),
            enable: await import('@/app/api/utils/enableAuthentication'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
            approval: await import('@/app/api/routes/managedApprovalRoutes'),
            registry: await import('@/app/api/socket/managed/managedSocketRegistry'),
            queue: await import('@/app/api/socket/managed/managedOutboundQueue'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();
        issuer = await modules.tokens.createSessionScopedTokenIssuer({
            seed: 'test-scoped-seed-not-a-production-key',
        });

        const instance = fastify();
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        const typed = instance.withTypeProvider<ZodTypeProvider>();
        modules.enable.enableAuthentication(typed as never);
        modules.enable.enableSessionScopeAuthentication(typed as never, () => issuer);
        modules.approval.managedApprovalRoutes(typed as never);
        await instance.ready();
        app = instance;
    });

    beforeEach(async () => {
        relayed = [];
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const approver = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        ownerAccountId = owner.id;
        approverAccountId = approver.id;
        createdAccountIds.add(ownerAccountId);
        createdAccountIds.add(approverAccountId);

        const granted = await db.session.create({
            data: { accountId: ownerAccountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        const sibling = await db.session.create({
            data: { accountId: ownerAccountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = granted.id;
        otherSessionId = sibling.id;
        createdSessionIds.add(sessionId);
        createdSessionIds.add(otherSessionId);

        await modules.projection.syncWorkspaceAuthority({
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
            expectedVersion: 0,
            now: Date.now(),
        });
        await modules.projection.syncRunAuthority({
            body: { runId, workspaceId, accountId: ownerAccountId, currentAttemptId: 'attempt-1', cancelled: false },
            expectedVersion: 0,
            now: Date.now(),
        });

        const issued = await modules.grants.issueSessionGrant({
            scope: scope() as never,
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: Date.now() + HOUR,
            now: Date.now(),
            purpose: 'approval-control',
            viewerAccountId: approverAccountId,
            viewerDataEncryptionKey: APPROVER_ENVELOPE,
        });
        if (!issued.ok) throw new Error(`fixture approval grant failed: ${issued.reason}`);
        approvalGrantId = issued.grant.grantId;
        approvalExpiresAt = issued.grant.expiresAt;
        approverToken = await mint();
    });

    afterEach(async () => {
        modules.registry.managedSocketRegistry.clear();
        const ids = [...createdSessionIds];
        await db.managedSessionGrant.deleteMany({ where: { sessionId: { in: ids } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        await app?.close();
        await db.$disconnect();
        restoreEnv();
    });

    describe('an approver answers the run that is asking', () => {
        it('relays the answer on the run\'s own connection', async () => {
            connectChild();
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ relayed: true, response: 'child-answer-ciphertext' });
            expect(relayed).toEqual([{
                event: 'rpc-request',
                args: [{
                    method: `${sessionId}:permission`,
                    /*
                     * The sealed payload, **verbatim and as a string**.
                     *
                     * The child decodes this with `decodeBase64` before it
                     * decrypts. An object here — a `{id, response}` envelope
                     * this server built, say — throws inside the child's RPC
                     * manager, which catches it and answers with an *encrypted
                     * error*: a well-formed acknowledgement that the delivery
                     * layer then reports as success, while the person is told
                     * their answer went through.
                     *
                     * The permission request's own id is inside the ciphertext,
                     * where the child reads it. This server cannot put it
                     * there: it holds no key that opens the payload.
                     */
                    params: SEALED,
                    requestId: 'call-1',
                }],
            }]);
        });

        it('relays the payload unread', async () => {
            // Sealed with the session key, which this server does not hold.
            connectChild();
            const sealed = 'AAAAopaqueBytes==';
            await answer({ token: approverToken, body: { requestId: 'call-2', payload: sealed } });
            expect((relayed[0].args[0] as { params: unknown }).params).toBe(sealed);
        });

        it('hands the child\'s own answer back, and does not call it applied', async () => {
            /*
             * The child's permission handler returns the **same thing** for an
             * id it recognises and one it does not: an answer for a request
             * that was already resolved, or never open, is dropped inside the
             * child and still acknowledges. So this server cannot say the
             * prompt was answered, and it does not — it says what it did, and
             * hands back the sealed answer for the caller to read.
             */
            connectChild((item) => item.ack?.('opaque-child-response'));
            const response = await answer({ token: approverToken });
            expect(response.json()).toEqual({ relayed: true, response: 'opaque-child-response' });
            // Never these: relaying is not answering, and this server cannot
            // tell the difference from here.
            expect(response.json().delivered).toBeUndefined();
            expect(response.json().answered).toBeUndefined();
        });

        it('refuses a payload that is not base64 before anything is sent', async () => {
            // The shape the child can actually decode. An object or a JSON
            // string reaches `decodeBase64` and throws there, and the encrypted
            // error that comes back is indistinguishable from an answer.
            connectChild();
            for (const payload of ['{\"id\":\"toolu_1\"}', 'not base64!', '']) {
                const response = await answer({
                    token: approverToken,
                    body: { requestId: 'call-3', payload },
                });
                expect(response.statusCode).toBe(400);
            }
            expect(relayed).toEqual([]);
        });
    });

    describe('a bearer that is not an approver relays nothing', () => {
        it('refuses a read bearer', async () => {
            connectChild();
            const readToken = await mint({ purpose: 'transcript-read' });
            const response = await answer({ token: readToken });
            expect(response.statusCode).toBe(403);
            expect(response.json().reason).toBe('purpose-not-allowed');
            expect(relayed).toEqual([]);
        });

        it('refuses the runner bearer of the very session it is running', async () => {
            /*
             * The run may not answer its own prompt. That is the whole point of
             * a permission request: a decision the run is not trusted to make.
             *
             * A *live* runner grant, not merely a runner claim over the
             * approver's row: the second is refused for naming the wrong grant,
             * which would prove nothing about the purpose gate.
             */
            connectChild();
            const runnerGrant = await modules.grants.issueSessionGrant({
                scope: scope() as never,
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                now: Date.now(),
            });
            if (!runnerGrant.ok) throw new Error(`fixture runner grant failed: ${runnerGrant.reason}`);
            const runnerToken = await mint({
                purpose: 'runner',
                grantId: runnerGrant.grant.grantId,
                expiresAt: runnerGrant.grant.expiresAt,
                viewerAccountId: undefined,
            });
            const response = await answer({ token: runnerToken });
            expect(response.statusCode).toBe(403);
            expect(response.json().reason).toBe('purpose-not-allowed');
            expect(relayed).toEqual([]);
        });

        it('refuses an approver answering a different session of the same account', async () => {
            connectChild();
            const response = await answer({ token: approverToken, sessionId: otherSessionId });
            expect(response.statusCode).toBe(403);
            expect(response.json().reason).toBe('session-mismatch');
            expect(relayed).toEqual([]);
        });

        it('refuses an approver whose grant was revoked a moment ago', async () => {
            // The grant is re-read on this request, not remembered from the
            // mint: withdrawal has to take effect on the next answer.
            connectChild();
            await db.managedSessionGrant.updateMany({
                where: { grantId: approvalGrantId },
                data: { revokedAt: BigInt(Date.now()) },
            });
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(403);
            expect(relayed).toEqual([]);
        });

        it('refuses a token whose grant row names a different approver', async () => {
            /*
             * The row carries an envelope sealed for one account. If the stored
             * viewer moves — an admin re-pointing it, a row written by an older
             * path — the token minted for the previous approver must stop
             * working, and the family alone cannot say so: it is derived from
             * what the token claims, so it still matches.
             */
            connectChild();
            const stranger = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
            createdAccountIds.add(stranger.id);
            await db.managedSessionGrant.updateMany({
                where: { grantId: approvalGrantId },
                data: { viewerAccountId: stranger.id },
            });
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(403);
            expect(response.json().reason).toBe('claims-mismatch');
            expect(relayed).toEqual([]);
        });

        it('refuses an unsigned bearer', async () => {
            connectChild();
            const response = await answer({ token: 'not-a-token' });
            expect(response.statusCode).toBe(401);
            expect(relayed).toEqual([]);
        });

        it.each([
            ['no request id', { payload: SEALED }],
            ['an empty request id', { requestId: '', payload: SEALED }],
            ['no payload', { requestId: 'call-1' }],
            ['an extra field', { requestId: 'call-1', payload: SEALED, approved: true }],
            ['a payload that is an object', { requestId: 'call-1', payload: { id: 'toolu_1' } }],
        ])('refuses a body with %s', async (_name, body) => {
            connectChild();
            const response = await answer({ token: approverToken, body });
            expect(response.statusCode).toBe(400);
            expect(relayed).toEqual([]);
        });
    });

    describe('the approver\'s authority, re-read where the packet goes out', () => {
        /*
         * The route authorises the request; the packet is emitted somewhere
         * else, possibly on another replica, after a wait. An approver whose
         * access ends in that window must not have their answer applied — and
         * the only side that can see a revoke committed in flight is the side
         * holding the socket.
         *
         * These run on the real outbound channel, because that is where the
         * check lives.
         */
        it('relays the answer while the approval grant is live', async () => {
            const child = connectRealChild();
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ relayed: true, response: 'child-answer-ciphertext' });
            expect(child.emitted).toHaveLength(1);
            expect(child.emitted[0].event).toBe('rpc-request');
        });

        it('emits nothing when the approver is withdrawn while the packet waits', async () => {
            /*
             * The bearer was live when the route read it. The withdrawal
             * commits during the wait before the emit — which is exactly the
             * case a sender-side check cannot catch, and the only reason this
             * guard exists on the receiving side.
             */
            const child = connectRealChild({
                duringCheck: async () => {
                    await db.managedSessionGrant.updateMany({
                        where: { grantId: approvalGrantId },
                        data: { revokedAt: BigInt(Date.now()), revokedReason: 'approver-removed' },
                    });
                },
            });

            const response = await answer({ token: approverToken });
            // Nothing went to the child at all.
            expect(child.emitted).toEqual([]);
            expect(response.statusCode).toBe(503);
            expect(response.json().relayed).toBeUndefined();
        });

        it('emits nothing when the approval grant expires while the packet waits', async () => {
            const child = connectRealChild({
                duringCheck: async () => {
                    await db.managedSessionGrant.updateMany({
                        where: { grantId: approvalGrantId },
                        data: { expiresAt: BigInt(Date.now() - 1) },
                    });
                },
            });
            const response = await answer({ token: approverToken });
            expect(child.emitted).toEqual([]);
            expect(response.statusCode).toBe(503);
        });

        it('leaves the run\'s own connection open when the approver is the one who lapsed', async () => {
            /*
             * The approver losing authority is not the run losing it. Closing
             * the channel would take the session down because somebody else's
             * access ended.
             */
            const child = connectRealChild({
                duringCheck: async () => {
                    await db.managedSessionGrant.updateMany({
                        where: { grantId: approvalGrantId },
                        data: { revokedAt: BigInt(Date.now()), revokedReason: 'approver-removed' },
                    });
                },
            });
            await answer({ token: approverToken });
            expect(child.refusals).toEqual([]);
        });

        it('emits nothing when the run\'s attempt moved on while the packet waited', async () => {
            /*
             * The approval names the run it answers for, and the run's own
             * authority can advance in the same window a revoke can: a new
             * attempt, a cancelled run, a later epoch. The row alone cannot see
             * that — it is still live and still says what it always said — so
             * the check here is the same one every action by this bearer makes,
             * against the current projection.
             */
            const child = connectRealChild({
                duringCheck: async () => {
                    await modules.projection.syncRunAuthority({
                        body: {
                            runId, workspaceId, accountId: ownerAccountId,
                            currentAttemptId: 'attempt-2', cancelled: false,
                        },
                        expectedVersion: 1,
                        now: Date.now(),
                    });
                },
            });
            const response = await answer({ token: approverToken });
            expect(child.emitted).toEqual([]);
            expect(response.statusCode).toBe(503);
        });

        it('emits nothing when the approver\'s own token has expired by then', async () => {
            /*
             * The bearer's expiry, which the row does not carry. A token issued
             * for a short window must not be honoured after it, even while the
             * grant behind it lives on.
             */
            const shortToken = await mint({ expiresAt: Date.now() + 1_500 });
            const child = connectRealChild({
                duringCheck: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 1_600));
                },
            });
            const response = await answer({ token: shortToken });
            expect(child.emitted).toEqual([]);
            expect(response.statusCode).toBe(503);
        });

        it('reports an answer that is not a sealed string as not relayed', async () => {
            /*
             * The browser can only read a ciphertext. Anything else came from
             * somewhere this route does not understand, and passing it on as
             * `relayed` would present it as the child's answer.
             */
            connectRealChild({ answer: (respond) => respond({ approved: true }) });
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(502);
            expect(response.json()).toEqual({ error: 'Not relayed', reason: 'malformed-response' });
        });
    });

    describe('an answer that did not reach the run is not an answer', () => {
        it('reports a run with no connection as undelivered', async () => {
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: 'Not relayed', reason: 'no-target' });
            expect(response.json().relayed).toBeUndefined();
        });

        it('reports a connection that refused the packet as undelivered', async () => {
            connectChild((item) => item.onRefused?.({ kind: 'grant-invalid' }));
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(503);
            expect(response.json().reason).toBe('unavailable');
            expect(response.json().relayed).toBeUndefined();
        });

        it('reports a child that never answered as undelivered', async () => {
            // `undefined` is how the channel reports an acknowledgement that
            // never came. The prompt is still open at the child.
            connectChild((item) => item.ack?.(undefined));
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(503);
            expect(response.json().reason).toBe('timeout');
            expect(response.json().relayed).toBeUndefined();
        });

        it('reports a connection for another account as undelivered', async () => {
            /*
             * The registry entry is what the receiving side verified at its own
             * handshake. A session id alone must not select it.
             */
            const stranger = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
            createdAccountIds.add(stranger.id);
            modules.registry.managedSocketRegistry.add({
                socketId: `socket-${randomUUID()}`,
                accountId: stranger.id,
                sessionId,
                grantId: approvalGrantId,
                runId,
                attemptId: 'attempt-1',
                rpcNames: new Set(['permission']),
                connectedAt: Date.now(),
                channel: { closed: false, enqueue: (item: Relayed) => relayed.push(item) } as never,
            });
            const response = await answer({ token: approverToken });
            expect(response.statusCode).toBe(409);
            expect(relayed).toEqual([]);
        });
    });
    it('root: refuses an approval that expires during the recipient grant lookup', async () => {
        let now = Date.now();
        const initial = now;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const original = modules.grants.resolveLiveGrant;
        let calls = 0;
        const resolver = vi.spyOn(modules.grants, 'resolveLiveGrant').mockImplementation(async (input) => {
            const result = await original(input);
            calls += 1;
            // The first lookup authorizes HTTP, the second is the recipient's
            // database round trip. Preserve real DB results, advance time only
            // while that recipient call is still awaiting its result.
            if (calls === 2) now = initial + 2_000;
            return result;
        });
        try {
            const token = await mint({ expiresAt: initial + 1_000 });
            const child = connectRealChild();
            const response = await answer({ token });
            expect(calls).toBeGreaterThanOrEqual(2);
            expect(child.emitted).toEqual([]);
            expect(response.statusCode).toBe(503);
        } finally { resolver.mockRestore(); clock.mockRestore(); }
    });
});
