/**
 * The managed child's socket, on its own Socket.IO server.
 *
 * Separate from `/v1/updates` rather than a client type on it, because the
 * things that make BYOS reconnects cheap are the same things that make a
 * revocation boundary impossible:
 *
 *  - Socket.IO restores a recovered session in the `Socket` constructor —
 *    rooms re-joined and missed packets written — before any middleware runs
 *    (`namespace.js` `_createSocket` precedes `run`). `skipMiddlewares: false`
 *    changes only whether `_doConnect` is reached, not whether that happened.
 *  - Room and broadcast delivery goes through the adapter, which writes to the
 *    engine directly; it does not pass through `socket.packet`, so patching
 *    that leaves both local broadcasts and relayed ones untouched.
 *
 * So recovery is off here and there are no rooms: every packet is addressed
 * explicitly through the registry and released by the socket's own channel
 * after the grant is re-read. A reconnect is an ordinary new connection, and
 * the child catches up through the authenticated HTTP cursor it already uses.
 *
 * BYOS keeps `/v1/updates` exactly as it is, recovery included.
 */

import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';

import { log } from '@/utils/log';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';
import { resolveLiveGrant } from '@/app/managed/managedSessionGrant';
import { authorizeManagedInbound } from '@/app/api/socket/managed/managedInboundGate';
import { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';
import {
    managedSocketRegistry,
    type ManagedSocketRegistry,
} from '@/app/api/socket/managed/managedSocketRegistry';
import {
    installManagedRelayReceiver,
    installManagedRpcReceiver,
    installManagedRpcResultReceiver,
} from '@/app/api/socket/managed/managedDelivery';
import { MANAGED_SOCKET_PATH } from '@/app/api/socket/managed/managedSocketPath';
import { createManagedHandlerBridge } from '@/app/api/socket/managed/managedHandlerBridge';

/** Inbound events a managed socket may send at all; each is still gated. */
const HANDLED_EVENTS = [
    'session-stream', 'session-alive', 'session-end',
    'update-metadata', 'update-state',
    'usage-report', 'provider-usage-report',
    'ping', 'rpc-register', 'rpc-unregister',
] as const;

export type ManagedSocketServerOptions = {
    issuer: SessionScopedTokenIssuer | null;
    registry?: ManagedSocketRegistry;
    /** Supplied by the caller so the managed bus is separate from the legacy one. */
    adapter?: Parameters<Server['adapter']>[0];
};

/** Splits `(payload?, callback?)` as Socket.IO actually delivers it. */
function normaliseArgs(received: unknown[]): {
    payload: unknown;
    callback?: (response: unknown) => void;
} {
    const last = received[received.length - 1];
    if (typeof last === 'function') {
        return {
            payload: received.length > 1 ? received[0] : undefined,
            callback: last as (response: unknown) => void,
        };
    }
    return { payload: received[0] };
}

/**
 * Refusals say a code and nothing else.
 *
 * The event name is echoed only when it is one this server actually handles.
 * Reflecting whatever a client sent would turn the error channel into one the
 * client writes.
 */
function refusal(event: string, reason: string): { event: string | null; reason: string } {
    return {
        event: (HANDLED_EVENTS as readonly string[]).includes(event) ? event : null,
        reason,
    };
}

function readToken(socket: Socket): string | null {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token === 'string' && auth.token.length > 0) return auth.token;
    return null;
}

/**
 * Starts the managed server on the given HTTP server.
 *
 * Returns null when no issuer is configured: managed access is off by default,
 * and an unconfigured deployment must not expose a second socket endpoint that
 * accepts anything.
 */
export function startManagedSocket(
    httpServer: HttpServer,
    options: ManagedSocketServerOptions,
): Server | null {
    if (!options.issuer) return null;
    const issuer = options.issuer;
    const registry = options.registry ?? managedSocketRegistry;

    const io = new Server(httpServer, {
        path: MANAGED_SOCKET_PATH,
        transports: ['websocket', 'polling'],
        serveClient: false,
        // No `connectionStateRecovery`. See the note at the top of this file:
        // recovery restores rooms and replays packets before authentication.
        //
        // `destroyUpgrade: false` matches the legacy server, which shares this
        // HTTP server: without it each engine.io instance tears down the
        // other's upgrades after `destroyUpgradeTimeout`.
        destroyUpgrade: false,
        pingTimeout: 45_000,
        pingInterval: 15_000,
        connectTimeout: 20_000,
    });
    if (options.adapter) io.adapter(options.adapter);
    installManagedRelayReceiver(io, registry);
    installManagedRpcReceiver(io, registry);
    installManagedRpcResultReceiver(io);

    io.use(async (socket, next) => {
        const token = readToken(socket);
        if (!token) return next(new Error('Missing authentication token'));

        const now = Date.now();
        const verified = await issuer.verify(token, now);
        if (!verified.ok) return next(new Error('Invalid authentication token'));

        let grant;
        try {
            grant = await resolveLiveGrant({ claims: verified.claims, now });
        } catch {
            // Unreachable authority is not a rejected credential, but a socket
            // has nowhere to put a 503, so it is refused and retried.
            return next(new Error('Authorization unavailable'));
        }
        if (!grant.ok) return next(new Error('Forbidden'));
        /*
         * This server is the managed **child's** connection: the run's own
         * socket. A bearer that carries no run cannot be one — reading a
         * transcript happens over HTTP, and admitting a read bearer here would
         * register it in a registry whose entries are keyed by run.
         */
        if (verified.claims.purpose !== 'runner') return next(new Error('Forbidden'));

        socket.data.claims = verified.claims;
        socket.data.grantId = grant.grant.grantId;
        next();
    });

    io.on('connection', (socket) => {
        const claims = socket.data.claims as SessionScopedClaims;

        const checkGrant = async () => {
            const grant = await resolveLiveGrant({ claims, now: Date.now() });
            return grant.ok ? { ok: true as const } : { ok: false as const, reason: grant.reason };
        };

        // `acks` is private in the type but present at runtime; the channel
        // reads it to cancel exactly the acknowledgements it registered.
        const channelSocket = socket as unknown as ConstructorParameters<typeof ManagedOutboundChannel>[0];
        const channel = new ManagedOutboundChannel(channelSocket, checkGrant, (closure) => {
            registry.remove(socket.id);
            log({ module: 'managed-socket' }, `managed channel closed (${closure.kind})`);
        });

        // The real handlers, registered against a facade so nothing they
        // subscribe to is reachable without passing the gate below.
        const bridge = createManagedHandlerBridge({
            userId: claims.accountId,
            sessionId: claims.sessionId,
            socketId: socket.id,
            channel,
        });

        registry.add({
            socketId: socket.id,
            accountId: claims.accountId,
            sessionId: claims.sessionId,
            grantId: socket.data.grantId as string,
            // Run-scoped by admission: the gate above refuses anything that is
            // not a runner, so these are always present here.
            runId: claims.runId!,
            attemptId: claims.attemptId!,
            channel,
            rpcNames: new Set<string>(),
            connectedAt: Date.now(),
        });

        /** Every reply to the child is a packet, so it crosses the channel. */
        const send = (event: string, payload: unknown) => {
            channel.enqueue({ event, args: [payload] });
        };

        for (const event of HANDLED_EVENTS) {
            socket.on(event, async (...received: unknown[]) => {
                // Socket.IO puts the acknowledgement last, so a client that
                // sends only a callback — `emit('ping', cb)`, which the CLI
                // does — arrives with the function in the payload position.
                // Reading it as a payload both loses the callback and hands a
                // function to a handler expecting data.
                const { payload, callback } = normaliseArgs(received);
                const decision = await authorizeManagedInbound({
                    event, payload, claims, checkGrant,
                });
                if (!decision.ok) {
                    send('managed-error', refusal(event, decision.reason));
                    if (decision.reason === 'grant-invalid' || decision.reason === 'authority-unavailable') {
                        channel.close({ kind: 'grant-invalid', reason: decision.reason });
                        socket.disconnect(true);
                    }
                    return;
                }

                if (event === 'rpc-register' || event === 'rpc-unregister') {
                    const entry = registry.get(socket.id);
                    const method = (payload as { method: string }).method;
                    const name = method.slice(claims.sessionId.length + 1);
                    if (entry) {
                        if (event === 'rpc-register') entry.rpcNames.add(name);
                        else entry.rpcNames.delete(name);
                    }
                    send(event === 'rpc-register' ? 'rpc-registered' : 'rpc-unregistered', { method });
                    return;
                }

                // A reply to the child is a packet to the child. Socket.IO
                // writes it through a callback rather than an event, so it is
                // queued explicitly instead of being invoked in place.
                const respond = callback
                    ? (response: unknown) => channel.enqueueCallback(response, () => callback(response))
                    : undefined;

                // Only the wrapped reply reaches the handler. Passing the
                // original callback would let a handler answer the child
                // directly, outside the channel that checks the grant.
                bridge.dispatch(event, payload, respond);
            });
        }

        // Anything not handled above is refused rather than ignored, so a child
        // learns its event went nowhere instead of waiting for an effect.
        socket.onAny((event: string) => {
            if ((HANDLED_EVENTS as readonly string[]).includes(event)) return;
            send('managed-error', refusal(
                event,
                event === 'rpc-call' ? 'rpc-call-not-permitted' : 'event-not-allowed',
            ));
        });

        socket.on('disconnect', () => {
            channel.close({ kind: 'disconnected' });
            registry.remove(socket.id);
        });
    });

    log({ module: 'managed-socket' }, `Managed socket server listening on ${MANAGED_SOCKET_PATH}`);
    return io;
}
