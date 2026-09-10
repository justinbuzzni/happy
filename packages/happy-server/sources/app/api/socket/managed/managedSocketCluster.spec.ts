import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { Redis } from 'ioredis';

import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import type { PrismaClient } from '@prisma/client';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';
import { MANAGED_SOCKET_PATH } from '@/app/api/socket/managed/managedSocketPath';
import * as logModule from '@/utils/log';
import { eventRouter } from '@/app/events/eventRouter';

/**
 * Two replicas, a real Redis stream between them, real sockets and the real
 * database.
 *
 * The properties under test only exist across that boundary: a packet produced
 * on one replica has to be released by the other, after that other replica has
 * read the grant for itself. A single-process test would assert the sender's
 * opinion, which is exactly the thing that must not be trusted.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL` and `HAPPY_MANAGED_TEST_REDIS_URL`.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const TEST_REDIS_URL = process.env.HAPPY_MANAGED_TEST_REDIS_URL;
const enabled = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
};
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const HOUR = 3_600_000;

let db: PrismaClient;
let modules: {
    server: typeof import('@/app/api/socket/managed/managedSocketServer');
    delivery: typeof import('@/app/api/socket/managed/managedDelivery');
    registryModule: typeof import('@/app/api/socket/managed/managedSocketRegistry');
    tokens: typeof import('@/app/auth/sessionScopedToken');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
};

type Replica = {
    http: HttpServer;
    io: import('socket.io').Server;
    registry: import('@/app/api/socket/managed/managedSocketRegistry').ManagedSocketRegistry;
    url: string;
    redis: Redis;
};

const replicas: Replica[] = [];
const clients: ClientSocket[] = [];
const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let issuer: SessionScopedTokenIssuer;
let accountId: string;
let sessionId: string;
let workspaceId: string;
let runId: string;
let grantId: string;
let grantExpiresAt: number;
let streamName: string;

function scope(over: Record<string, unknown> = {}) {
    return {
        tenantId: 'tenant-1', projectId: 'project-1', workspaceId, runtimeId: 'runtime-1',
        epoch: 1, runId, attemptId: 'attempt-1', sessionId, accountId,
        workspaceAuthorityVersion: 1, runAuthorityVersion: 1, ...over,
    };
}

function claims(over: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    const s = scope();
    return {
        v: 1, grantId, accountId: s.accountId, sessionId: s.sessionId,
        tenantId: s.tenantId, projectId: s.projectId, workspaceId: s.workspaceId,
        runtimeId: s.runtimeId, runId: s.runId, attemptId: s.attemptId, epoch: s.epoch,
        workspaceAuthorityVersion: s.workspaceAuthorityVersion,
        runAuthorityVersion: s.runAuthorityVersion,
        purpose: 'runner' as const,
        expiresAt: grantExpiresAt, ...over,
    };
}

async function startReplica(): Promise<Replica> {
    const http = createServer();
    const redis = new Redis(TEST_REDIS_URL!);
    const registry = new modules.registryModule.ManagedSocketRegistry();
    const io = modules.server.startManagedSocket(http, {
        issuer,
        registry,
        adapter: createAdapter(redis as never, { streamName }) as never,
    })!;
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const port = (http.address() as AddressInfo).port;
    const replica = { http, io, registry, url: `http://127.0.0.1:${port}`, redis };
    replicas.push(replica);
    return replica;
}

function connect(replica: Replica, token: string): Promise<ClientSocket> {
    const socket = connectClient(replica.url, {
        path: MANAGED_SOCKET_PATH,
        transports: ['websocket'],
        auth: { token },
        reconnection: false,
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (error: Error) => reject(error));
    });
}

function nextEvent(socket: ClientSocket, event: string, ms = 1_500): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        socket.once(event, (payload: unknown) => { clearTimeout(timer); resolve(payload); });
    });
}

async function expectNoEvent(socket: ClientSocket, event: string, ms = 400): Promise<void> {
    const received: unknown[] = [];
    const handler = (payload: unknown) => received.push(payload);
    socket.on(event, handler);
    await new Promise((resolve) => setTimeout(resolve, ms));
    socket.off(event, handler);
    expect(received).toEqual([]);
}

/** Waits until the peer replica has the socket in its own registry. */
async function waitForRegistry(replica: Replica, sid: string, ms = 1_500): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (replica.registry.forSession(sid).length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('socket never appeared in the registry');
}

describe.skipIf(!enabled)('managed sockets across two replicas', () => {
    beforeAll(async () => {
        modules = {
            server: await import('@/app/api/socket/managed/managedSocketServer'),
            delivery: await import('@/app/api/socket/managed/managedDelivery'),
            registryModule: await import('@/app/api/socket/managed/managedSocketRegistry'),
            tokens: await import('@/app/auth/sessionScopedToken'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        issuer = await modules.tokens.createSessionScopedTokenIssuer({
            seed: 'test-scoped-seed-not-a-production-key',
        });
        // The legacy fan-out is a process-wide singleton normally initialised
        // by `startSocket`. These cases are about the managed boundary, so the
        // account-side server is a sink rather than a second real one.
        const { eventRouter } = await import('@/app/events/eventRouter');
        eventRouter.init({ to: () => ({ emit: () => {} }) } as never);
    });

    beforeEach(async () => {
        streamName = `socket.io.managed.test.${randomUUID()}`;
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        createdAccountIds.add(accountId);
        const session = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = session.id;
        createdSessionIds.add(sessionId);

        const now = Date.now();
        await modules.projection.syncWorkspaceAuthority({
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
            expectedVersion: 0, now,
        });
        await modules.projection.syncRunAuthority({
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
            expectedVersion: 0, now,
        });
        const issued = await modules.grants.issueSessionGrant({
            scope: scope() as never,
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: now + HOUR,
            now,
        });
        if (!issued.ok) throw new Error(`fixture grant failed: ${issued.reason}`);
        grantId = issued.grant.grantId;
        grantExpiresAt = issued.grant.expiresAt;
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        for (const replica of replicas.splice(0)) {
            // `io.close()` is async and closes this same HTTP server itself
            // (`socket.io/dist/index.js`: it awaits `adapter.close()`, then
            // calls `httpServer.close`). Firing it without awaiting and then
            // issuing a second `close` left two callbacks waiting on the same
            // connection drain, with nothing forcing a lingering socket shut —
            // a hook that hangs under load rather than a slow one.
            replica.http.closeAllConnections();
            await replica.io.close();
            replica.redis.disconnect();
        }
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: [...createdSessionIds] } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        expect(await db.managedSessionGrant.count({ where: { runId: { in: [...createdRunIds] } } })).toBe(0);
        expect(await db.session.count({ where: { id: { in: [...createdSessionIds] } } })).toBe(0);
        await db.$disconnect();
        restoreEnv();
    });

    async function mint(over: Partial<SessionScopedClaims> = {}): Promise<string> {
        const minted = await issuer.mint(claims(over), Date.now());
        if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
        return minted.token;
    }

    it('delivers a packet produced on the other replica', async () => {
        const [holder, producer] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        modules.delivery.deliverManagedSession(
            producer.io, { sessionId, accountId, event: 'update', args: [{ seq: 1 }] },
            producer.registry,
        );
        expect(await nextEvent(client, 'update')).toEqual({ seq: 1 });
    });

    it('stops delivering the moment the grant is revoked, on the holder*s own reading', async () => {
        const [holder, producer] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        modules.delivery.deliverManagedSession(
            producer.io, { sessionId, accountId, event: 'update', args: [{ seq: 1 }] }, producer.registry);
        expect(await nextEvent(client, 'update')).toEqual({ seq: 1 });

        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });

        // The producing replica has no idea; it relays exactly as before.
        modules.delivery.deliverManagedSession(
            producer.io, { sessionId, accountId, event: 'update', args: [{ seq: 2 }] }, producer.registry);
        await expectNoEvent(client, 'update');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(client.connected).toBe(false);
    });

    it('refuses a connection whose grant is already revoked', async () => {
        const holder = await startReplica();
        const token = await mint();
        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });
        await expect(connect(holder, token)).rejects.toThrow();
    });

    it('refuses a token for a session with no grant at all', async () => {
        const holder = await startReplica();
        await expect(connect(holder, await mint({ grantId: 'never-issued' }))).rejects.toThrow();
    });

    it('never puts a managed socket in a legacy room', async () => {
        const holder = await startReplica();
        await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        const sockets = await holder.io.fetchSockets();
        expect(sockets).toHaveLength(1);
        // Only its own id room, which Socket.IO always joins.
        expect([...sockets[0].rooms]).toEqual([sockets[0].id]);
    });

    it('has no packet recovery to reconnect into', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        // Recovery is what would replay missed packets before authentication.
        expect((holder.io as unknown as { _opts: { connectionStateRecovery?: unknown } })
            ._opts.connectionStateRecovery).toBeUndefined();
        expect(client.id).toBeTruthy();
    });

    it('accepts an allowed event and refuses one that is not', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        client.emit('session-stream', { sid: sessionId, time: Date.now(), data: 'x' });
        await expectNoEvent(client, 'managed-error', 300);

        client.emit('machine-alive', { machineId: 'm1' });
        // The name is not echoed: it is not one this server handles.
        expect(await nextEvent(client, 'managed-error'))
            .toEqual({ event: null, reason: 'event-not-allowed' });
    });

    it('refuses rpc-call, including for its own session', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-call', { method: `${sessionId}:permission` });
        expect(await nextEvent(client, 'managed-error'))
            .toEqual({ event: null, reason: 'rpc-call-not-permitted' });
    });

    it('registers only exact-session allowlisted RPC names', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        client.emit('rpc-register', { method: `${sessionId}:permission` });
        expect(await nextEvent(client, 'rpc-registered'))
            .toMatchObject({ method: `${sessionId}:permission` });
        expect(holder.registry.forRpc(sessionId, 'permission')).toHaveLength(1);

        client.emit('rpc-register', { method: `${sessionId}:spawn-happy-session` });
        expect(await nextEvent(client, 'managed-error'))
            .toMatchObject({ reason: 'rpc-name-not-allowed' });
        client.emit('rpc-register', { method: `other-session:permission` });
        expect(await nextEvent(client, 'managed-error'))
            .toMatchObject({ reason: 'session-mismatch' });
        expect(holder.registry.forRpc(sessionId, 'spawn-happy-session')).toEqual([]);
    });

    it('routes an RPC to the holder and answers in the legacy envelope', async () => {
        const [holder, producer] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');

        // What the CLI's RPC handler manager actually acknowledges with: an
        // opaque encrypted string, not a structured object.
        const encrypted = 'AAECAwQFBgc=';
        client.on('rpc-request', (_payload: unknown, ack: (r: unknown) => void) => ack(encrypted));

        expect(await modules.delivery.dispatchManagedRpc(
            null,
            { sessionId, accountId, rpcName: 'permission', requestId: 'req-1', params: {} },
            holder.registry, { deadlineMs: 2_000 },
        )).toEqual({ ok: true, result: encrypted });

        // The producing replica holds no socket for this session at all.
        expect(await modules.delivery.dispatchManagedRpc(
            null,
            { sessionId, accountId, rpcName: 'permission', requestId: 'req-2', params: {} },
            producer.registry, { deadlineMs: 500 },
        )).toEqual({ ok: false, reason: 'no-target' });
    });

    it('runs a call exactly once when the same session is connected on two replicas', async () => {
        // The reconnect shape: engine.io has not given up on the old socket, so
        // two replicas legitimately hold one for this session. Three replicas
        // so the caller is neither of them and has to locate before it acts.
        const [oldHolder, newHolder, caller] = [
            await startReplica(), await startReplica(), await startReplica(),
        ];
        const runs: string[] = [];

        const older = await connect(oldHolder, await mint());
        await waitForRegistry(oldHolder, sessionId);
        older.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(older, 'rpc-registered');
        older.on('rpc-request', (_p: unknown, ack: (r: unknown) => void) => {
            runs.push('old');
            ack('from-old');
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const newer = await connect(newHolder, await mint());
        await waitForRegistry(newHolder, sessionId);
        newer.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(newer, 'rpc-registered');
        newer.on('rpc-request', (_p: unknown, ack: (r: unknown) => void) => {
            runs.push('new');
            ack('from-new');
        });

        // Let the adapter see both peers.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const result = await modules.delivery.dispatchManagedRpc(
            caller.io,
            { sessionId, accountId, rpcName: 'permission', requestId: 'once', params: {} },
            caller.registry, { deadlineMs: 8_000 },
        );

        await new Promise((resolve) => setTimeout(resolve, 400));
        // Broadcasting the work would have run it on both; the side effect is
        // what matters, not the answer.
        expect(runs).toEqual(['new']);
        expect(result).toEqual({ ok: true, result: 'from-new' });
    });

    it('answers a ping sent with a callback and no payload', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        // The CLI sends `emit('ping', cb)`: Socket.IO puts the acknowledgement
        // in the first position, where a payload would otherwise be read.
        const answered = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no ping answer')), 2_000);
            client.emit('ping', (response: unknown) => { clearTimeout(timer); resolve(response); });
        });
        expect(answered).toBeTruthy();
    });

    it('does not answer a ping once the grant is withdrawn', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });
        const answered: unknown[] = [];
        client.emit('ping', (response: unknown) => answered.push(response));
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(answered).toEqual([]);
    });

    it('reconnects as a new connection and re-registers, with no replay', async () => {
        const holder = await startReplica();
        const first = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        first.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(first, 'rpc-registered');
        const firstId = first.id;
        first.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(holder.registry.forSession(sessionId)).toEqual([]);

        const second = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        // A new identity, and nothing carried over: no rooms, no registrations,
        // no missed packets.
        expect(second.id).not.toBe(firstId);
        expect(holder.registry.forRpc(sessionId, 'permission')).toEqual([]);
        await expectNoEvent(second, 'update', 300);
    });

    it('runs the real session handlers, with effects other clients can see', async () => {
        const { eventRouter } = await import('@/app/events/eventRouter');
        const seen: Array<{ payload: any; filter: any }> = [];
        const original = eventRouter.emitEphemeral.bind(eventRouter);
        (eventRouter as unknown as { emitEphemeral: unknown }).emitEphemeral =
            (params: any) => { seen.push({ payload: params.payload, filter: params.recipientFilter }); };

        try {
            const holder = await startReplica();
            const client = await connect(holder, await mint());
            await waitForRegistry(holder, sessionId);

            client.emit('session-stream', { sid: sessionId, time: Date.now(), data: 'token' });
            client.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: true });
            await new Promise((resolve) => setTimeout(resolve, 500));

            // The real handlers ran: an allowed event has an effect other
            // clients observe, not merely an absence of refusal.
            expect(seen.map((s) => (s.payload as { type?: string }).type)).toContain('stream');
            expect(seen.some((s) => (s.payload as { id?: string }).id === sessionId)).toBe(true);
        } finally {
            (eventRouter as unknown as { emitEphemeral: unknown }).emitEphemeral = original;
        }
    });

    it('persists a message through the real handler and updates the session', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        client.emit('update-metadata', {
            sid: sessionId, metadata: 'managed-metadata', expectedVersion: 0,
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        // The database moved, which is what makes this a connection rather
        // than an authorisation that goes nowhere.
        expect(session.metadata).toBe('managed-metadata');
        expect(session.metadataVersion).toBe(1);
    });

    it('completes an update sent without an acknowledgement, without failing inside the handler', async () => {
        // `sessionUpdateHandler` calls its acknowledgement unguarded once the
        // write has happened. A child that wants no answer would otherwise make
        // it throw *after* the state changed, and the handler's own catch would
        // swallow that — a partial success nobody is told about.
        //
        // Completion is observed, not waited out. The handler emits its update
        // and then calls back synchronously, so the update packet arriving at
        // the client means the callback has already run: a sleep long enough
        // for the write but short of `allocateUserSeq` would let the throw
        // happen after the log spy was removed.
        const [holder, producer] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        // Fan-out to a managed child goes out over the relay, so the emitting
        // side must be the peer of the replica holding the socket.
        eventRouter.initManaged(producer.io);

        const updates: Array<{ body?: { id?: string; metadata?: { value?: string; version?: number }; agentState?: { value?: string; version?: number } } }> = [];
        client.on('update', (payload: unknown) => updates.push(payload as never));

        const swallowed: string[] = [];
        const spy = vi.spyOn(logModule, 'log').mockImplementation(((...args: unknown[]) => {
            const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
            // Only errors raised inside the handlers under test; unrelated
            // server logging must not make this fail.
            if (/Error in update-(metadata|state)/.test(text)) swallowed.push(text);
        }) as never);

        async function waitForUpdate(match: (u: typeof updates[number]) => boolean, what: string) {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                if (updates.some(match)) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(`no ${what} update reached the client`);
        }

        try {
            client.emit('update-metadata', {
                sid: sessionId, metadata: 'no-ack-metadata', expectedVersion: 0,
            });
            await waitForUpdate((u) => u.body?.id === sessionId
                && u.body?.metadata?.value === 'no-ack-metadata'
                && u.body?.metadata?.version === 1, 'metadata');

            client.emit('update-state', {
                sid: sessionId, agentState: 'no-ack-state', expectedVersion: 0,
            });
            await waitForUpdate((u) => u.body?.id === sessionId
                && u.body?.agentState?.value === 'no-ack-state'
                && u.body?.agentState?.version === 1, 'agent state');

            const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
            expect(session.metadata).toBe('no-ack-metadata');
            expect(session.metadataVersion).toBe(1);
            expect(session.agentState).toBe('no-ack-state');
            expect(session.agentStateVersion).toBe(1);
            // The distinguishing assertion, made while the spy is still in
            // place: a write that landed while the handler threw would satisfy
            // the four above on its own.
            expect(swallowed).toEqual([]);
        } finally {
            spy.mockRestore();
            eventRouter.initManaged(null);
        }
    }, 30_000);

    it('answers a callback through the channel, and not after a revoke', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);

        const first = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no callback')), 1_500);
            client.emit('update-metadata', {
                sid: sessionId, metadata: 'v1', expectedVersion: 0,
            }, (response: unknown) => { clearTimeout(timer); resolve(response); });
        });
        expect(first).toMatchObject({ result: 'success' });

        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });
        const answered: unknown[] = [];
        client.emit('update-metadata', {
            sid: sessionId, metadata: 'v2', expectedVersion: 1,
        }, (response: unknown) => answered.push(response));
        await new Promise((resolve) => setTimeout(resolve, 600));
        // The reply is a packet to the child and does not cross a withdrawn
        // grant; the write behind it never ran either.
        expect(answered).toEqual([]);
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        expect(session.metadata).toBe('v1');
    });

    it('refuses with a fixed reason and does not reflect an arbitrary event name', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('<img src=x onerror=alert(1)>', { sid: sessionId });
        expect(await nextEvent(client, 'managed-error'))
            .toEqual({ event: null, reason: 'event-not-allowed' });
    });

    it('delivers its own archive ephemeral across replicas, and stops after a revoke', async () => {
        // The CLI exits on this one (`apiSession.ts`: activity, reason
        // 'archived'), so a managed child that never receives it keeps calling
        // an endpoint that now 404s. `sessionArchive` emits it under
        // 'all-interested-in-session', which is the only filter forwarded to
        // managed sockets — everything user-scoped stays with the UI.
        const { eventRouter } = await import('@/app/events/eventRouter');
        const { buildSessionActivityEphemeral } = await import('@/app/events/eventRouter');

        const [holder, producer] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        eventRouter.initManaged(producer.io);

        try {
            const archived = buildSessionActivityEphemeral(sessionId, false, Date.now(), false, 'archived');
            eventRouter.emitEphemeral({
                userId: accountId,
                payload: archived,
                recipientFilter: { type: 'all-interested-in-session', sessionId },
            });
            expect(await nextEvent(client, 'ephemeral'))
                .toMatchObject({ type: 'activity', id: sessionId, reason: 'archived' });

            // Another session's archive must not reach this child.
            const otherSid = `session-${randomUUID()}`;
            eventRouter.emitEphemeral({
                userId: accountId,
                payload: buildSessionActivityEphemeral(otherSid, false, Date.now(), false, 'archived'),
                recipientFilter: { type: 'all-interested-in-session', sessionId: otherSid },
            });
            await expectNoEvent(client, 'ephemeral', 400);

            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            eventRouter.emitEphemeral({
                userId: accountId,
                payload: archived,
                recipientFilter: { type: 'all-interested-in-session', sessionId },
            });
            await expectNoEvent(client, 'ephemeral', 400);
        } finally {
            eventRouter.initManaged(null);
        }
    });

    it('forwards nothing that is scoped to the account*s own clients', async () => {
        const { eventRouter, buildSessionActivityEphemeral } = await import('@/app/events/eventRouter');
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        eventRouter.initManaged(holder.io);
        try {
            for (const filter of [
                { type: 'user-scoped-only' as const },
                { type: 'machine-scoped-only' as const, machineId: 'machine-1' },
                { type: 'all-user-authenticated-connections' as const },
            ]) {
                eventRouter.emitEphemeral({
                    userId: accountId,
                    payload: buildSessionActivityEphemeral(sessionId, true, Date.now(), false),
                    recipientFilter: filter,
                });
            }
            // These are the UI's and the daemon's scopes; forwarding them
            // wholesale would hand a child traffic for sessions it has no
            // grant for.
            await expectNoEvent(client, 'ephemeral', 500);
        } finally {
            eventRouter.initManaged(null);
        }
    });

    it('routes an RPC to the replica that holds the socket, across the bus', async () => {
        const [holder, caller] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');
        client.on('rpc-request', (_payload: unknown, ack: (r: unknown) => void) => ack('AAECAwQFBgc='));
        // Give the adapter a moment to see its peer.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const result = await modules.delivery.dispatchManagedRpc(
            caller.io,
            { sessionId, accountId, rpcName: 'permission', requestId: 'req-x', params: {} },
            caller.registry, { deadlineMs: 5_000 },
        );
        expect(result).toEqual({ ok: true, result: 'AAECAwQFBgc=' });
    });

    it('lets the caller*s deadline govern a slow remote answer', async () => {
        // The cluster bus acknowledges `serverSideEmit` with a hard-coded 5s
        // timeout that no caller can raise. Carrying the *result* on that ack
        // makes every call longer than five seconds fail as unavailable, while
        // the identical call to a local socket succeeds for thirty.
        const [holder, caller] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');
        client.on('rpc-request', (_p: unknown, ack: (r: unknown) => void) => {
            setTimeout(() => ack('slow-but-fine'), 6_500);
        });
        await new Promise((resolve) => setTimeout(resolve, 400));

        const result = await modules.delivery.dispatchManagedRpc(
            caller.io,
            { sessionId, accountId, rpcName: 'permission', requestId: 'slow-1', params: {} },
            caller.registry, { deadlineMs: 20_000 },
        );
        expect(result).toEqual({ ok: true, result: 'slow-but-fine' });
    }, 30_000);

    it('does not accumulate pending acknowledgements when a child never answers', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');
        // The child receives every request and answers none.
        client.on('rpc-request', () => {});

        for (let i = 0; i < 5; i++) {
            await modules.delivery.dispatchManagedRpc(
                null,
                { sessionId, accountId, rpcName: 'permission', requestId: `never-${i}`, params: {} },
                holder.registry, { deadlineMs: 150 },
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 800));

        const sockets = await holder.io.fetchSockets();
        expect(sockets).toHaveLength(1);
        const serverSocket = [...(holder.io.sockets.sockets.values())][0] as unknown as {
            acks: Map<number, unknown>;
        };
        // Socket.IO keeps an un-timed acknowledgement in this map forever, so
        // a child that ignores requests leaks one entry per call.
        expect(serverSocket.acks.size).toBe(0);
        expect(client.connected).toBe(true);
    }, 20_000);

    function serverSocketOf(replica: Replica): { acks: Map<number, unknown> } {
        return [...replica.io.sockets.sockets.values()][0] as unknown as { acks: Map<number, unknown> };
    }

    it('leaves no pending acknowledgement behind when a revoke closes the channel', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');
        client.on('rpc-request', () => { /* never answers */ });

        const pending = modules.delivery.dispatchManagedRpc(
            null,
            { sessionId, accountId, rpcName: 'permission', requestId: 'revoke-ack', params: {} },
            holder.registry, { deadlineMs: 20_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Held across the revoke: closing the channel disconnects the socket,
        // so it is gone from the server's map by the time we look.
        const serverSocket = serverSocketOf(holder);
        expect(serverSocket.acks.size).toBe(1);

        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });
        // A packet after the revoke is what makes the channel notice.
        modules.delivery.deliverManagedLocally(
            { sessionId, accountId, event: 'update', args: [{}] }, holder.registry,
        );
        expect(await pending).toMatchObject({ ok: false });
        // Settling our own registry is not enough: Socket.IO holds its own
        // entry and timer until expiry unless the request is cancelled there.
        expect(serverSocket.acks.size).toBe(0);
    }, 25_000);

    it('leaves no pending acknowledgement behind across repeated reconnects', async () => {
        const holder = await startReplica();
        for (let round = 0; round < 3; round++) {
            const client = await connect(holder, await mint());
            await waitForRegistry(holder, sessionId);
            client.emit('rpc-register', { method: `${sessionId}:permission` });
            await nextEvent(client, 'rpc-registered');
            client.on('rpc-request', () => { /* never answers */ });

            const pending = modules.delivery.dispatchManagedRpc(
                null,
                { sessionId, accountId, rpcName: 'permission', requestId: `round-${round}`, params: {} },
                holder.registry, { deadlineMs: 20_000 },
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(serverSocketOf(holder).acks.size).toBe(1);

            client.close();
            expect(await pending).toMatchObject({ ok: false });
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(holder.registry.forSession(sessionId)).toEqual([]);
            expect([...holder.io.sockets.sockets.values()]).toHaveLength(0);
        }
    }, 30_000);

    it('cancels only the request that ended, not the others on that socket', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');

        const answers = new Map<string, (r: unknown) => void>();
        client.on('rpc-request', (payload: { requestId: string }, ack: (r: unknown) => void) => {
            answers.set(payload.requestId, ack);
        });

        const shortCall = modules.delivery.dispatchManagedRpc(
            null, { sessionId, accountId, rpcName: 'permission', requestId: 'short', params: {} },
            holder.registry, { deadlineMs: 400 },
        );
        const longCall = modules.delivery.dispatchManagedRpc(
            null, { sessionId, accountId, rpcName: 'permission', requestId: 'long', params: {} },
            holder.registry, { deadlineMs: 15_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const serverSocket = serverSocketOf(holder);
        expect(serverSocket.acks.size).toBe(2);

        // The short one gives up. Socket.IO's own timer fires at that same
        // instant, so the cleanup lands a tick later.
        expect(await shortCall).toMatchObject({ ok: false, reason: 'timeout' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        // Exactly one entry went: the long call is still a live request.
        expect(serverSocket.acks.size).toBe(1);

        answers.get('long')!('answered');
        expect(await longCall).toEqual({ ok: true, result: 'answered' });
        expect(serverSocket.acks.size).toBe(0);
    }, 25_000);

    it('does not release a request whose caller already gave up', async () => {
        const holder = await startReplica();
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');

        const received: string[] = [];
        client.on('rpc-request', (payload: { requestId: string }) => received.push(payload.requestId));

        // Hold the grant check open past the caller's deadline, then allow it.
        const entry = holder.registry.forSession(sessionId)[0];
        const channel = entry.channel as unknown as { checkGrant: () => Promise<unknown> };
        const realCheck = channel.checkGrant.bind(entry.channel);
        let barrier: (() => void) | null = null;
        (entry.channel as unknown as { checkGrant: () => Promise<unknown> }).checkGrant = () =>
            new Promise((resolve) => { barrier = () => resolve(realCheck()); });

        const result = await modules.delivery.dispatchManagedRpc(
            null,
            { sessionId, accountId, rpcName: 'permission', requestId: 'gave-up', params: {} },
            holder.registry, { deadlineMs: 300 },
        );
        expect(result).toMatchObject({ ok: false, reason: 'timeout' });

        barrier!();
        await new Promise((resolve) => setTimeout(resolve, 400));
        // The grant came back valid, but nobody is waiting: releasing it now
        // would run the call's side effect for a caller that is gone.
        expect(received).toEqual([]);
        expect(serverSocketOf(holder).acks.size).toBe(0);
        expect(client.connected).toBe(true);
    }, 20_000);

    it('fails an RPC for a revoked session instead of falling back', async () => {
        const [holder, caller] = [await startReplica(), await startReplica()];
        const client = await connect(holder, await mint());
        await waitForRegistry(holder, sessionId);
        client.emit('rpc-register', { method: `${sessionId}:permission` });
        await nextEvent(client, 'rpc-registered');
        client.on('rpc-request', (_p: unknown, ack: (r: unknown) => void) => ack('AAECAwQFBgc='));
        await new Promise((resolve) => setTimeout(resolve, 300));

        await modules.grants.revokeSessionGrant({
            scope: scope() as never, reason: 'operator', now: Date.now(),
        });

        const result = await modules.delivery.dispatchManagedRpc(
            caller.io,
            { sessionId, accountId, rpcName: 'permission', requestId: 'req-y', params: {} },
            caller.registry, { deadlineMs: 5_000 },
        );
        // The holder answers with the refusal rather than the child's result,
        // and nothing looks for a legacy room to try instead.
        expect(result).toEqual({
            ok: false, reason: 'unavailable',
            error: 'Managed session grant is no longer valid',
        });
    });

    it('reports no target when the session has no managed socket anywhere', async () => {
        const caller = await startReplica();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await modules.delivery.dispatchManagedRpc(
            caller.io,
            { sessionId, accountId, rpcName: 'permission', requestId: 'req-z', params: {} },
            caller.registry, { deadlineMs: 5_000 },
        )).toEqual({ ok: false, reason: 'no-target' });
    });
});
