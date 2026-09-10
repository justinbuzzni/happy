/**
 * Handing a request to a managed runtime, checked **where the socket lives**.
 *
 * ## Why the sender cannot be the one to check
 *
 * `emitWithAck` on a `RemoteSocket` does not send anything from here: the
 * cluster adapter publishes a broadcast, and the replica that owns the socket
 * delivers it — later, and without consulting anything. So a check on the
 * sender's replica proves what was true *before* the packet went onto the bus.
 * A grant withdrawn during that gap is a grant that stopped mattering: the
 * request arrives anyway, and the daemon that is no longer authorised runs it.
 *
 * So the request travels as an explicit relay and the authority is re-read on
 * the replica that will actually emit it, immediately before it does. That
 * replica is the only place where "the socket is here, and its grant holds
 * right now" can be said in one breath.
 *
 * ## What is fixed, and what is never retried
 *
 * The target socket id is chosen once and carried. The recipient does not pick
 * another socket, does not fall back to a room, and does not repeat a request
 * whose effect is unknown. A request that was refused on arrival is refused —
 * a second attempt on another connection would be the withdrawal being routed
 * around.
 */
import type { Server, Socket } from 'socket.io';

import { managedControlRuntime, managedOutboundAllowed } from '@/app/api/socket/managedDaemonOutboundGuard';

export const MANAGED_DAEMON_RPC_EXECUTE_EVENT = 'managed:daemon-rpc-execute';
export const MANAGED_DAEMON_RPC_RESULT_EVENT = 'managed:daemon-rpc-result';

export type DaemonRpcRequest = {
    requestId: string;
    targetSocketId: string;
    method: string;
    params: unknown;
    timeoutMs: number;
    /**
     * When the caller stops waiting, as an instant.
     *
     * Absolute on purpose. A relative timeout restarted on the recipient hands
     * it a fresh window after the hop already spent most of one — the caller
     * would be told `timeout` while the daemon still had time to run the
     * command. Set once by the caller and carried unchanged.
     */
    expiresAt?: number;
};

export type DaemonRpcOutcome =
    | { ok: true; result: unknown }
    | { ok: false; reason: 'no-target' | 'refused' | 'timeout' | 'error'; error?: string };

type Settle = (outcome: DaemonRpcOutcome) => void;

/** Requests this replica is waiting on, by request id. */
const pending = new Map<string, Settle>();

export type DaemonRpcRelayDeps = {
    /** Local sockets, by id. Injected so the decision can be tested directly. */
    localSocket?: (io: Server, socketId: string) => Socket | undefined;
    allowed?: typeof managedOutboundAllowed;
    /** The clock the deadline is judged against. Injected by tests only. */
    now?: () => number;
};

function defaultLocalSocket(io: Server, socketId: string): Socket | undefined {
    return io.sockets.sockets.get(socketId);
}

/**
 * Emits one request to a socket **on this replica**, after re-reading its
 * authority.
 *
 * Returns whether this replica accepted the request — that is, whether it holds
 * the socket and the grant still stood. The daemon's own answer arrives later.
 */
export async function executeDaemonRpcLocally(input: {
    io: Server;
    request: DaemonRpcRequest;
    onResult: (outcome: DaemonRpcOutcome) => void;
    deps?: DaemonRpcRelayDeps;
}): Promise<{ accepted: boolean; refused: boolean }> {
    const deps = input.deps ?? {};
    const now = deps.now ?? Date.now;
    const expiresAt = input.request.expiresAt;
    const socket = (deps.localSocket ?? defaultLocalSocket)(input.io, input.request.targetSocketId);
    // Not ours. Another replica may hold it; this one says nothing about that.
    if (!socket) return { accepted: false, refused: false };
    // Before asking anything: a request whose caller has already given up is
    // not one to spend a lookup on, let alone emit.
    if (expiresAt !== undefined && now() >= expiresAt) {
        input.onResult({ ok: false, reason: 'timeout' });
        return { accepted: true, refused: true };
    }

    const allowed = await (deps.allowed ?? managedOutboundAllowed)({
        target: socket as never,
        managedControl: managedControlRuntime(),
    });
    /*
     * Checked **again after the await**, and this is the whole point of having
     * a deadline at all: the authority answer can arrive after the caller
     * stopped waiting. Acting on it then turns "we asked in time" into "we
     * emitted late" — the caller was told `timeout` and the daemon ran the
     * command anyway.
     */
    if (expiresAt !== undefined && now() >= expiresAt) {
        input.onResult({ ok: false, reason: 'timeout' });
        return { accepted: true, refused: true };
    }
    if (!allowed) {
        // Refused **here**, with the socket in hand. Reported so the caller can
        // tell "nobody holds it" from "the runtime is no longer authorised".
        input.onResult({ ok: false, reason: 'refused' });
        return { accepted: true, refused: true };
    }

    void socket.timeout(expiresAt === undefined
        ? input.request.timeoutMs
        // What is left of the caller's window, never a fresh copy of it.
        : Math.max(1, expiresAt - now()))
        .emitWithAck('rpc-request', { method: input.request.method, params: input.request.params })
        .then((result: unknown) => input.onResult({ ok: true, result }))
        .catch((error: unknown) => input.onResult({
            ok: false,
            reason: 'timeout',
            error: error instanceof Error ? error.message : 'rpc failed',
        }));
    return { accepted: true, refused: false };
}

/** Listens for requests peers ask this replica to deliver. */
export function installManagedDaemonRpcExecutor(io: Server, deps?: DaemonRpcRelayDeps): void {
    io.on(MANAGED_DAEMON_RPC_EXECUTE_EVENT as never, ((payload: unknown, ack?: (response: unknown) => void) => {
        const request = payload as DaemonRpcRequest | null;
        if (!request || typeof request.requestId !== 'string'
            || typeof request.targetSocketId !== 'string' || typeof request.method !== 'string') {
            ack?.({ accepted: false });
            return;
        }
        void executeDaemonRpcLocally({
            io,
            request,
            onResult: (outcome) => {
                (io as unknown as { serverSideEmit: (ev: string, p: unknown) => void })
                    .serverSideEmit(MANAGED_DAEMON_RPC_RESULT_EVENT, { requestId: request.requestId, outcome });
            },
            ...(deps ? { deps } : {}),
        }).then((started) => ack?.({ accepted: started.accepted }));
    }) as never);

    io.on(MANAGED_DAEMON_RPC_RESULT_EVENT as never, ((payload: unknown) => {
        const envelope = payload as { requestId?: unknown; outcome?: unknown } | null;
        if (!envelope || typeof envelope.requestId !== 'string') return;
        pending.get(envelope.requestId)?.(envelope.outcome as DaemonRpcOutcome);
    }) as never);
}

/**
 * Sends a request to a managed runtime's socket, wherever it is.
 *
 * Local or remote takes the same path on purpose: one code path means the
 * recipient-side check cannot be skipped by the case that happens to be local,
 * which is the case that runs in every single-replica test.
 */
export async function dispatchDaemonRpc(input: {
    io: Server;
    request: DaemonRpcRequest;
    deps?: DaemonRpcRelayDeps;
}): Promise<DaemonRpcOutcome> {
    const now = input.deps?.now ?? Date.now;
    // Fixed here, once. Everything downstream reads this instant rather than
    // starting a window of its own.
    const request: DaemonRpcRequest = {
        ...input.request,
        expiresAt: input.request.expiresAt ?? now() + input.request.timeoutMs,
    };
    let settle: Settle = () => { /* replaced below */ };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<DaemonRpcOutcome>((resolve) => {
        let done = false;
        settle = (outcome) => {
            if (done) return;
            done = true;
            // Cleared on every path, so a settled request leaves no timer
            // holding a reference to it.
            if (timer !== undefined) clearTimeout(timer);
            resolve(outcome);
        };
        timer = setTimeout(
            () => settle({ ok: false, reason: 'timeout' }),
            Math.max(1, request.expiresAt! - now()),
        );
        timer.unref?.();
    });
    pending.set(request.requestId, settle);
    try {
        /*
         * The local attempt is **raced against the deadline**, not awaited
         * ahead of it. A lookup that hangs would otherwise hold the caller past
         * its own deadline — the promise nobody settles is a caller waiting on
         * a database.
         */
        const started = await Promise.race([
            executeDaemonRpcLocally({
                io: input.io,
                request,
                onResult: settle,
                ...(input.deps ? { deps: input.deps } : {}),
            }),
            answered.then(() => null),
        ]);
        if (started === null) return await answered;
        if (started.accepted) return await answered;

        // Not here. Ask the peers, naming the same socket — never a room, and
        // never a different socket.
        (input.io as unknown as {
            serverSideEmit: (ev: string, p: unknown, ack: (e: Error | null, r: unknown[]) => void) => void;
        }).serverSideEmit(MANAGED_DAEMON_RPC_EXECUTE_EVENT, request, (error, responses) => {
            if (error) {
                settle({ ok: false, reason: 'error', error: 'peer did not respond' });
                return;
            }
            const accepted = responses.some((response) =>
                Boolean(response) && (response as { accepted?: unknown }).accepted === true);
            if (!accepted) settle({ ok: false, reason: 'no-target' });
        });
        return await answered;
    } finally {
        pending.delete(request.requestId);
    }
}
