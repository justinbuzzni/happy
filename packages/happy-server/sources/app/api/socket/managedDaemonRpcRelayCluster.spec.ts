/**
 * Two replicas, a real Redis stream between them, and the question the
 * single-process controls cannot answer: **where** is a managed runtime's
 * authority read when the request has to cross a hop it does not control?
 *
 * The single-process spec forces the ordering with an injected pause. This one
 * lets the cluster adapter do the delaying, which is the thing that made the
 * sender-side check meaningless: the adapter publishes, and the replica that
 * owns the socket delivers later. A grant withdrawn in that window must stop
 * the request on arrival, with nothing emitted to the daemon.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_REDIS_URL`, like the managed socket cluster
 * spec — a fake bus would be the sender's opinion of its own timing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import {
    dispatchDaemonRpc,
    installManagedDaemonRpcExecutor,
} from '@/app/api/socket/managedDaemonRpcRelay';

const TEST_REDIS_URL = process.env.HAPPY_MANAGED_TEST_REDIS_URL;
const enabled = Boolean(TEST_REDIS_URL);

type Replica = { http: HttpServer; io: Server; url: string; redis: Redis };

const replicas: Replica[] = [];
const clients: ClientSocket[] = [];
let streamName: string;

/** Flipped by a test to withdraw the grant while a request is in flight. */
let grantLive = true;
/** Resolves once the owning replica has been asked, so a test can act in the gap. */
let asked: () => void = () => { /* replaced per test */ };

async function startReplica(): Promise<Replica> {
    const http = createServer();
    const redis = new Redis(TEST_REDIS_URL!);
    const io = new Server(http, {
        path: '/v1/updates',
        adapter: createAdapter(redis as never, { streamName }) as never,
    });
    io.on('connection', (socket) => {
        // What the handshake would have bound after a managed daemon
        // authenticated. The relay reads exactly these two.
        socket.data.managedDaemon = { machineId: 'machine-1', accountId: 'acct-1' };
        socket.handshake.auth.token = 'daemon.bearer';
    });
    installManagedDaemonRpcExecutor(io, {
        allowed: (async () => {
            asked();
            return grantLive;
        }) as never,
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const replica = {
        http, io, redis,
        url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    };
    replicas.push(replica);
    return replica;
}

function connect(replica: Replica): Promise<ClientSocket> {
    const client = connectClient(replica.url, { path: '/v1/updates', transports: ['websocket'] });
    clients.push(client);
    return new Promise((resolve, reject) => {
        client.on('connect', () => resolve(client));
        client.on('connect_error', reject);
    });
}

/**
 * The id the owning replica knows this client by.
 *
 * Taken from the client rather than from "the first socket on that replica":
 * a test that left a connection open would otherwise address the wrong one and
 * report a timeout that has nothing to do with authority.
 */
function socketIdOf(client: ClientSocket): string {
    return client.id!;
}

beforeAll(async () => {
    if (!enabled) return;
    streamName = `socket.io.daemon-relay.${randomUUID()}`;
    await startReplica();
    await startReplica();
    // The cluster bus discovers its peers asynchronously. Emitting before that
    // is a test of the adapter's startup, not of where authority is read.
    await new Promise((resolve) => setTimeout(resolve, 500));
});

afterEach(() => {
    grantLive = true;
    asked = () => { /* replaced per test */ };
});

afterAll(async () => {
    for (const client of clients) client.close();
    for (const replica of replicas) {
        replica.io.close();
        await new Promise<void>((resolve) => replica.http.close(() => resolve()));
        replica.redis.disconnect();
    }
});

describe.skipIf(!enabled)('a request crossing replicas to a managed runtime', () => {
    it('is refused on arrival when the grant is withdrawn during the hop', async () => {
        const [sender, owner] = replicas;
        const client = await connect(owner);
        const received: unknown[] = [];
        client.on('rpc-request', (payload: unknown) => received.push(payload));

        // The withdrawal happens after the owning replica has been asked —
        // which is after the packet crossed the bus, and before it emits.
        const reached = new Promise<void>((resolve) => { asked = () => { grantLive = false; resolve(); }; });
        // First ask sets `grantLive = false`; the answer it returns is the one
        // the owning replica acts on.
        const outcome = await dispatchDaemonRpc({
            io: sender.io,
            request: {
                requestId: randomUUID(),
                targetSocketId: socketIdOf(client),
                method: 'machine-1:bash',
                params: { command: 'ls' },
                timeoutMs: 3_000,
            },
        });
        await reached;

        expect(outcome).toEqual({ ok: false, reason: 'refused' });
        // The daemon on the other replica received nothing at all.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(received).toEqual([]);
    }, 30_000);

    it('delivers across the hop while the grant holds', async () => {
        // The refusal above has to be about the withdrawal, not about the hop.
        const [sender, owner] = replicas;
        const client = await connect(owner);
        client.on('rpc-request', (_payload: unknown, ack: (answer: unknown) => void) => {
            ack({ ok: true, result: 'done' });
        });
        const outcome = await dispatchDaemonRpc({
            io: sender.io,
            request: {
                requestId: randomUUID(),
                targetSocketId: socketIdOf(client),
                method: 'machine-1:bash',
                params: { command: 'ls' },
                timeoutMs: 5_000,
            },
        });
        expect(outcome).toMatchObject({ ok: true });
    }, 30_000);
});
