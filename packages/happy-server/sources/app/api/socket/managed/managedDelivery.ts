/**
 * Getting a packet to a managed child, wherever its socket happens to be.
 *
 * Two hops, and only the second one grants anything:
 *
 *  - The replica that produced the packet delivers to any managed socket it
 *    holds and relays to its peers over the existing cluster bus.
 *  - The replica that holds the socket looks the session up in its *own*
 *    registry — built from a handshake it verified itself — and hands the
 *    packet to that socket's channel, which re-reads the grant before writing.
 *
 * The sender's opinion is routing information, never permission. A relay
 * payload is a message from another process: it says which session to look for,
 * and everything it claims about who may receive it is checked again here. A
 * revoke that commits while the packet is in flight is caught on this side,
 * which is the only side that can catch it.
 */

import type { Server } from 'socket.io';

import { log } from '@/utils/log';
import { parseSessionScopedClaims, type SessionScopedClaims } from '@/app/auth/sessionScopedToken';
import { managedSocketRegistry, type ManagedSocketRegistry } from '@/app/api/socket/managed/managedSocketRegistry';
import type { ManagedChannelClosure } from '@/app/api/socket/managed/managedOutboundQueue';

/** The cluster-bus event carrying one managed delivery between replicas. */
export const MANAGED_RELAY_EVENT = 'managed:deliver';

export type ManagedDelivery = {
    sessionId: string;
    /** The account the sender believes owns the session; re-checked locally. */
    accountId: string;
    event: string;
    args: unknown[];
};

export type ManagedDeliveryOutcome = {
    /** Managed sockets on this replica the packet was queued for. */
    queued: number;
};

function isDelivery(value: unknown): value is ManagedDelivery {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
        && typeof candidate.accountId === 'string' && candidate.accountId.length > 0
        && typeof candidate.event === 'string' && candidate.event.length > 0
        && Array.isArray(candidate.args);
}

/**
 * Queues a packet for every managed socket of this session on this replica.
 *
 * The account is compared against the registry entry rather than taken from the
 * delivery: the entry's account came from a handshake this replica verified,
 * and a payload naming one session but another account must reach nobody.
 */
export function deliverManagedLocally(
    delivery: ManagedDelivery,
    registry: ManagedSocketRegistry = managedSocketRegistry,
    onRefused?: (closure: ManagedChannelClosure) => void,
): ManagedDeliveryOutcome {
    let queued = 0;
    for (const entry of registry.forSession(delivery.sessionId)) {
        if (entry.accountId !== delivery.accountId) continue;
        entry.channel.enqueue({
            event: delivery.event,
            args: delivery.args,
            onRefused,
        });
        queued++;
    }
    return { queued };
}

/**
 * Delivers here and asks every peer to do the same.
 *
 * The relay is fire-and-forget by design: a peer that never answers must not
 * hold up the sender, and a packet nobody could deliver is not an error — the
 * child may simply be gone. What must never happen is delivery *without* the
 * receiving replica's own check, which is why the peers run
 * `deliverManagedLocally` rather than being told the packet is authorised.
 */
export function deliverManagedSession(
    io: Pick<Server, 'serverSideEmit'> | null,
    delivery: ManagedDelivery,
    registry: ManagedSocketRegistry = managedSocketRegistry,
): ManagedDeliveryOutcome {
    const local = deliverManagedLocally(delivery, registry);
    if (io) {
        try {
            io.serverSideEmit(MANAGED_RELAY_EVENT, delivery);
        } catch (error) {
            log({ module: 'managed-socket', level: 'error' },
                `managed relay publish failed (${(error as { name?: string })?.name === 'Error' ? 'Error' : 'unknown'})`);
        }
    }
    return local;
}

export type ManagedRpcRequest = {
    sessionId: string;
    accountId: string;
    /** RPC name without the `${sessionId}:` prefix. */
    rpcName: string;
    /** Correlates the response with this request. */
    requestId: string;
    params: unknown;
    /**
     * A second grant that must still be live **where the emit happens**.
     *
     * The run's own grant is re-read by the channel on every packet, but a
     * packet sent on somebody *else's* authority — an approver answering a
     * permission prompt — carries an authority the channel knows nothing
     * about. Between authorising the HTTP request and the emit, the packet can
     * cross a replica boundary and wait in a queue; an approver removed in that
     * window would still have their answer applied.
     *
     * Carried as ids rather than as a callback because it has to survive the
     * cluster bus: the replica that owns the socket re-reads the row itself,
     * which is the only side that can catch a revoke committed in flight.
     */
    approval?: { claims: SessionScopedClaims };
};

/** A candidate connection, addressable across the cluster by its socket id. */
export type ManagedRpcTargetRef = { socketId: string; connectedAt: number };

/** The cluster-bus events carrying the RPC phases between replicas. */
export const MANAGED_RPC_LOCATE_EVENT = 'managed:rpc:locate';
export const MANAGED_RPC_EXECUTE_EVENT = 'managed:rpc:execute';
export const MANAGED_RPC_RESULT_EVENT = 'managed:rpc:result';

/** How long the whole call may take before it is reported as unanswered. */
export const MANAGED_RPC_DEADLINE_MS = 30_000;
/** How long the locate round may take; it is a lookup, not the work itself. */
export const MANAGED_RPC_LOCATE_TIMEOUT_MS = 3_000;

export type ManagedRpcResult =
    | { ok: true; result: unknown }
    | { ok: false; reason: 'no-target' | 'unavailable' | 'timeout'; error?: string };

function isRpcRequest(value: unknown): value is ManagedRpcRequest {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    if (!(typeof c.sessionId === 'string' && c.sessionId.length > 0
        && typeof c.accountId === 'string' && c.accountId.length > 0
        && typeof c.rpcName === 'string' && c.rpcName.length > 0
        && typeof c.requestId === 'string' && c.requestId.length > 0)) {
        return false;
    }
    /*
     * The second authority, when the payload carries one.
     *
     * It arrives from another process, so it is shape-checked like everything
     * else here — and it is only ever ids. The row it names is read on this
     * side; nothing the sender says about that row is believed.
     */
    if (c.approval !== undefined) {
        if (!c.approval || typeof c.approval !== 'object') return false;
        const approval = c.approval as Record<string, unknown>;
        // The same parser the token decoder uses, so a payload from another
        // process has to be claims-shaped before anything reads a field off it.
        // Nothing it says is believed: the row it names is read on this side.
        if (parseSessionScopedClaims(approval.claims) === null) return false;
    }
    return true;
}

/** Connections on this replica that could serve the call. */
export function locateManagedRpcTargets(
    request: ManagedRpcRequest,
    registry: ManagedSocketRegistry = managedSocketRegistry,
): ManagedRpcTargetRef[] {
    return registry
        .forRpc(request.sessionId, request.rpcName)
        .filter((entry) => entry.accountId === request.accountId && !entry.channel.closed)
        .map((entry) => ({ socketId: entry.socketId, connectedAt: entry.connectedAt }));
}

/**
 * Picks the one connection that will run the call.
 *
 * Newest first, because a reconnect leaves the previous socket present until
 * engine.io gives up on it. The socket id breaks a tie so every replica making
 * this choice from the same candidate list makes the same one.
 */
export function chooseManagedRpcTarget(targets: ManagedRpcTargetRef[]): ManagedRpcTargetRef | null {
    return [...targets].sort((a, b) =>
        b.connectedAt - a.connectedAt || a.socketId.localeCompare(b.socketId))[0] ?? null;
}

/**
 * Runs the call on one named socket, if this replica holds it.
 *
 * Addressed by socket id rather than by session, so the replica that does not
 * hold the chosen connection does nothing at all. That is the whole point: the
 * previous design asked every peer to serve the session, and a reconnect with
 * sockets on two replicas ran the call twice.
 */
export function executeManagedRpcLocally(
    request: ManagedRpcRequest,
    targetSocketId: string,
    onResponse: (response: ManagedRpcResult) => void,
    registry: ManagedSocketRegistry = managedSocketRegistry,
    expiresAt?: number,
): { ok: true } | { ok: false; reason: 'no-target' } {
    const entry = registry.get(targetSocketId);
    if (!entry
        || entry.sessionId !== request.sessionId
        || entry.accountId !== request.accountId
        || !entry.rpcNames.has(request.rpcName)
        || entry.channel.closed) {
        return { ok: false, reason: 'no-target' };
    }

    entry.channel.enqueue({
        event: 'rpc-request',
        args: [{
            method: `${request.sessionId}:${request.rpcName}`,
            params: request.params,
            requestId: request.requestId,
        }],
        // Read here, on the replica that holds the socket, in the instant
        // before the packet goes out.
        ...(request.approval
            ? { precondition: () => checkApprovalStillLive(request.approval!, request) }
            : {}),
        // The child's answer crosses the boundary too: the channel re-reads the
        // grant before this runs.
        // `undefined` is how the channel reports an acknowledgement that never
        // came: the child had its turn and did not answer.
        // Absolute, so the same instant governs the wait for the grant, the
        // emit and the child's acknowledgement — on this replica or another.
        expiresAt,
        ack: (response: unknown) => onResponse(response === undefined
            ? { ok: false, reason: 'timeout', error: 'RPC call timed out' }
            : { ok: true, result: response }),
        onRefused: (closure) => onResponse(closure.kind === 'expired'
            ? { ok: false, reason: 'timeout', error: 'RPC call timed out' }
            : { ok: false, reason: 'unavailable', error: closureError(closure) }),
    });
    return { ok: true };
}

function closureError(closure: ManagedChannelClosure): string {
    switch (closure.kind) {
        case 'grant-invalid': return 'Managed session grant is no longer valid';
        case 'sender-revoked': return 'The authority behind this request is no longer valid';
        case 'authority-unavailable': return 'Authorization unavailable';
        case 'queue-overflow': return 'Managed session fell too far behind';
        case 'ack-overflow': return 'Managed session left too many calls unanswered';
        case 'disconnected': return 'Managed session disconnected';
        default: return 'Managed session unavailable';
    }
}

/**
 * Calls this replica issued and is still waiting on, keyed by request id.
 *
 * The result arrives on its own bus event rather than on the execute
 * acknowledgement, because that acknowledgement is capped at five seconds by
 * the cluster adapter and no caller can raise it. Carrying the result there
 * made every remote call longer than five seconds fail as unavailable while
 * the identical local call had thirty. The acknowledgement now answers only
 * "did a replica accept this?", and the caller's own deadline governs the rest.
 */
const pendingResults = new Map<string, (result: ManagedRpcResult) => void>();

/** Delivers a result to the replica that issued the call. */
export function installManagedRpcResultReceiver(io: Pick<Server, 'on'>): void {
    io.on(MANAGED_RPC_RESULT_EVENT as never, ((payload: unknown) => {
        const envelope = payload as { requestId?: unknown; result?: unknown } | null;
        if (!envelope || typeof envelope.requestId !== 'string') return;
        // Unknown ids are normal: every replica sees every result, and only the
        // caller has a pending entry for this one.
        pendingResults.get(envelope.requestId)?.(envelope.result as ManagedRpcResult);
    }) as never);
}

/** Settles exactly once, whichever of answer, refusal or deadline arrives first. */
function settleOnce(deadlineMs: number): {
    promise: Promise<ManagedRpcResult>;
    settle: (result: ManagedRpcResult) => void;
} {
    let settle!: (result: ManagedRpcResult) => void;
    let done = false;
    const promise = new Promise<ManagedRpcResult>((resolve) => {
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ ok: false, reason: 'timeout', error: 'RPC call timed out' });
        }, deadlineMs);
        settle = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
    });
    return { promise, settle };
}

/**
 * Sends an RPC to exactly one managed connection, wherever it is.
 *
 * Two rounds. The first asks every replica which connections it holds; the
 * second addresses one of them by socket id, so only the replica holding that
 * socket acts. Broadcasting the work itself — the earlier design — ran the call
 * on every replica that happened to hold a socket for the session, which a
 * reconnect makes normal rather than rare.
 *
 * An outcome that is not known is reported as not known. There is no second
 * attempt on another connection: a call whose effect is unknown must not be
 * repeated, and there is deliberately no legacy room to fall back to.
 */
export async function dispatchManagedRpc(
    io: Pick<Server, 'serverSideEmit'> | null,
    request: ManagedRpcRequest,
    registry: ManagedSocketRegistry = managedSocketRegistry,
    options: { deadlineMs?: number; locateTimeoutMs?: number } = {},
): Promise<ManagedRpcResult> {
    const startedAt = Date.now();
    const local = locateManagedRpcTargets(request, registry);
    const remote = io ? await locateRemoteTargets(io, request, options.locateTimeoutMs) : [];
    const chosen = chooseManagedRpcTarget([...local, ...remote]);
    if (!chosen) return { ok: false, reason: 'no-target' };

    const deadlineMs = options.deadlineMs ?? MANAGED_RPC_DEADLINE_MS;
    // Fixed here, before the locate round, so the time that round takes is the
    // caller's time and not an extension of it.
    const expiresAt = startedAt + deadlineMs;
    const { promise, settle } = settleOnce(Math.max(1, expiresAt - Date.now()));

    if (local.some((target) => target.socketId === chosen.socketId)) {
        // The child's acknowledgement window ends when the caller stops
        // waiting, so Socket.IO drops its `acks` entry at that instant rather
        // than holding one per unanswered call.
        const started = executeManagedRpcLocally(request, chosen.socketId, settle, registry, expiresAt);
        if (!started.ok) settle({ ok: false, reason: 'no-target' });
        return promise;
    }

    if (!io) return { ok: false, reason: 'no-target' };

    pendingResults.set(request.requestId, settle);
    (io.serverSideEmit as (ev: string, payload: unknown, ack: (err: Error | null, r: unknown[]) => void) => void)(
        MANAGED_RPC_EXECUTE_EVENT,
        { request, targetSocketId: chosen.socketId, expiresAt },
        (error, responses) => {
            if (error) {
                // Nobody confirmed acceptance. The effect is unknown, so this
                // is reported as unknown; there is no second attempt on another
                // connection, and nothing is rebroadcast.
                settle({ ok: false, reason: 'unavailable', error: 'RPC target did not respond' });
                return;
            }
            const accepted = responses.some((response) =>
                Boolean(response) && (response as { accepted?: unknown }).accepted === true);
            if (!accepted) settle({ ok: false, reason: 'no-target' });
        },
    );
    try {
        return await promise;
    } finally {
        pendingResults.delete(request.requestId);
    }
}

async function locateRemoteTargets(
    io: Pick<Server, 'serverSideEmit'>,
    request: ManagedRpcRequest,
    timeoutMs = MANAGED_RPC_LOCATE_TIMEOUT_MS,
): Promise<ManagedRpcTargetRef[]> {
    try {
        const responses = await Promise.race([
            new Promise<unknown[]>((resolve, reject) => {
                (io.serverSideEmit as (ev: string, payload: unknown, ack: (err: Error | null, r: unknown[]) => void) => void)(
                    MANAGED_RPC_LOCATE_EVENT,
                    request,
                    (error, peerResponses) => (error ? reject(error) : resolve(peerResponses)),
                );
            }),
            new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
        ]);
        return responses.flatMap((response) =>
            (Array.isArray(response) ? response : []).filter((target): target is ManagedRpcTargetRef =>
                Boolean(target) && typeof (target as ManagedRpcTargetRef).socketId === 'string'
                && typeof (target as ManagedRpcTargetRef).connectedAt === 'number'));
    } catch {
        // A locate that failed is a locate that found nothing here.
        return [];
    }
}

/** Answers the two RPC phases for sockets this replica holds. */
export function installManagedRpcReceiver(
    io: Pick<Server, 'on'>,
    registry: ManagedSocketRegistry = managedSocketRegistry,
): void {
    io.on(MANAGED_RPC_LOCATE_EVENT as never, ((payload: unknown, ack?: (targets: unknown) => void) => {
        if (!ack) return;
        if (!isRpcRequest(payload)) return ack([]);
        ack(locateManagedRpcTargets(payload, registry));
    }) as never);

    io.on(MANAGED_RPC_EXECUTE_EVENT as never, ((payload: unknown, ack?: (response: unknown) => void) => {
        const envelope = payload as {
            request?: unknown; targetSocketId?: unknown; expiresAt?: unknown;
        } | null;
        if (!envelope || !isRpcRequest(envelope.request) || typeof envelope.targetSocketId !== 'string') {
            ack?.({ accepted: false });
            return;
        }
        const request = envelope.request;
        const started = executeManagedRpcLocally(
            request,
            envelope.targetSocketId,
            (result) => {
                // The result travels on its own event, so the acknowledgement
                // above is free to answer immediately.
                (io as unknown as { serverSideEmit: (ev: string, payload: unknown) => void })
                    .serverSideEmit(MANAGED_RPC_RESULT_EVENT, { requestId: request.requestId, result });
            },
            registry,
            typeof envelope.expiresAt === 'number' ? envelope.expiresAt : undefined,
        );
        // Acceptance only: whether this replica holds the chosen socket and has
        // queued the request. Not whether the child answered.
        ack?.({ accepted: started.ok });
    }) as never);
}

/**
 * Listens for relayed deliveries from peer replicas.
 *
 * Payloads arrive from another process, so they are validated before use and
 * then treated purely as an address to look up locally.
 */
export function installManagedRelayReceiver(
    io: Pick<Server, 'on'>,
    registry: ManagedSocketRegistry = managedSocketRegistry,
): void {
    io.on(MANAGED_RELAY_EVENT as never, ((payload: unknown) => {
        if (!isDelivery(payload)) return;
        deliverManagedLocally(payload, registry);
    }) as never);
}

/**
 * The managed server this process runs, for callers that are not handed one.
 *
 * Set once at startup; null when managed access is not configured, which makes
 * every managed dispatch report no target rather than reaching for a fallback.
 */
let managedServer: Server | null = null;

export function setManagedRpcServer(io: Server | null): void {
    managedServer = io;
}

export function managedRpcServer(): Server | null {
    return managedServer;
}

/**
 * Whether the approval grant behind a relayed answer is still live.
 *
 * Everything about it is compared against the stored row rather than taken
 * from the packet: the purpose, the session, and the viewer it was resealed
 * for. A revoke that commits while the packet is queued is caught here, and
 * nowhere earlier — the sender's check happened before the wait.
 */
async function checkApprovalStillLive(
    approval: { claims: SessionScopedClaims },
    request: ManagedRpcRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { claims } = approval;
    // The bearer's own claims, not just the row it names: an approval token has
    // an expiry of its own, and it names the run it was minted for.
    if (claims.purpose !== 'approval-control') return { ok: false, reason: 'purpose-not-allowed' };
    if (claims.sessionId !== request.sessionId || claims.accountId !== request.accountId) {
        return { ok: false, reason: 'scope-mismatch' };
    }
    try {
        const { resolveLiveGrant } = await import('@/app/managed/managedSessionGrant');
        /*
         * The same check every action by that bearer makes, run **here** and
         * with the clock read now.
         *
         * The row alone is not enough and was what this used to read. It loses
         * two things: the token's own expiry — a bearer may not outlive the
         * request it was issued for — and the run authority, so an answer for a
         * superseded attempt, a cancelled run or an advanced epoch would still
         * go out. `resolveLiveGrant` compares all of it against the current
         * projection, in one transaction.
         *
         * `Date.now()` is read at this point on purpose: the packet may have
         * waited, and the wait is exactly what this is here to catch.
         */
        const live = await resolveLiveGrant({ claims, now: Date.now() });
        if (!live.ok) return { ok: false, reason: live.reason };
        /*
         * And again, after the resolver's own database round trips.
         *
         * The instant passed *into* the resolver is read before those awaits,
         * so a window that closes while the row is being read is a window the
         * resolver still calls open. The emit happens after all of it, so the
         * only comparison that means anything is one made here: the bearer's
         * expiry and the grant's, against the clock as it stands now.
         */
        const afterRead = Date.now();
        if (afterRead >= claims.expiresAt || afterRead >= live.grant.expiresAt) {
            return { ok: false, reason: 'expired' };
        }
        return { ok: true };
    } catch {
        // Unable to look is not permission to send.
        return { ok: false, reason: 'authority-unavailable' };
    }
}
