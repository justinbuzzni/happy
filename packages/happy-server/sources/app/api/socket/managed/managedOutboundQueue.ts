/**
 * The delivery boundary for one managed socket.
 *
 * Everything a managed child receives passes through here, on the replica that
 * holds its socket: session updates, ephemerals, RPC requests, ordinary
 * responses and callback acknowledgements alike. Each one is released only
 * after the grant behind the socket has been re-read and found live.
 *
 * Why a queue rather than a check at the emit site:
 *
 *  - **The check has to happen where the socket is.** A sender replica that
 *    verified a grant is stating what was true on its own clock, before a
 *    relay hop it does not control. Reusing that as permission on the
 *    receiving side would make a revoke that lands during the hop invisible.
 *  - **It has to be serial.** Checking concurrently means a packet whose check
 *    started before a revoke can still be written after a later packet was
 *    refused, so the child sees the connection continue past the point it was
 *    withdrawn. One in-flight check at a time makes the refusal a boundary
 *    rather than a suggestion.
 *  - **Order is the contract.** Session traffic is a sequence; releasing item
 *    n+1 while n is still being checked reorders it.
 *
 * And why it is bounded: one database read per packet is slower than a stream
 * of agent output, so an unbounded queue is a memory leak with a throughput
 * trigger. The bounds are a safety limit rather than a tuning knob — a child
 * that outruns them is disconnected with a fixed reason and recovers the same
 * way any reconnect does, by reading what it missed over the authenticated HTTP
 * cursor.
 *
 * A refusal is terminal for the channel. Whether the grant was revoked, the
 * authority store could not be reached in time, or the queue overflowed,
 * nothing further is written and the socket is closed: an unanswerable question
 * about permission is not permission.
 */

import { log } from '@/utils/log';

export type ManagedOutboundItem = {
    /** Socket.IO event name. */
    event: string;
    args: unknown[];
    /**
     * Acknowledgement callback for this emit, invoked when the child answers.
     *
     * It is trusted server-side code, but it runs on the child's schedule, so
     * it is gated the same way an outbound packet is: the grant is re-read
     * before the callback is allowed to run. Without that, a request released
     * while the grant was live would still deliver its response afterwards.
     */
    ack?: (...args: unknown[]) => void;
    /**
     * A second authority, re-read immediately before this packet is emitted.
     *
     * The channel's own grant check covers the run this socket belongs to. It
     * says nothing about a packet sent on somebody else's authority — an
     * approver answering a permission prompt — and that authority can end while
     * the item sits in this queue. Failing it refuses **this item**; the
     * channel stays open, because the run's own grant is not what lapsed.
     */
    precondition?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * How long the child has to acknowledge this particular request.
     *
     * Per item, because the caller's deadline is what should govern: a fixed
     * server-side value either expires before the caller gave up or keeps the
     * entry alive long after it stopped caring.
     */
    ackTimeoutMs?: number;
    /**
     * The instant after which this item is pointless.
     *
     * Absolute, not a duration, because the wait happens in two places: the
     * grant check before the emit, and the child's acknowledgement after it.
     * A duration would restart at each, so an item whose caller already gave up
     * could still be released — with whatever side effect it carries — and then
     * be given a fresh acknowledgement window on top.
     */
    expiresAt?: number;
    /**
     * Called instead of the emit when the item is refused, so a caller waiting
     * on an acknowledgement learns the answer will never come rather than
     * hanging until its own timeout.
     */
    onRefused?: (reason: ManagedChannelClosure) => void;
    /**
     * Delivers this item instead of emitting an event.
     *
     * Used for a reply to something the child asked, which Socket.IO writes
     * through a callback rather than an event. It is still a packet to the
     * child, so it queues and is released under the same check as any other.
     */
    deliver?: () => void;
};

export type ManagedChannelClosure =
    | { kind: 'grant-invalid'; reason: string }
    | { kind: 'authority-unavailable' }
    | { kind: 'queue-overflow' }
    | { kind: 'ack-overflow' }
    | { kind: 'expired' }
    /**
     * The authority *this packet* was sent on ended before it went out — not
     * the run's. Refuses the item; the channel stays open.
     */
    | { kind: 'sender-revoked'; reason: string }
    | { kind: 'disconnected' };

export type ManagedGrantCheck = () => Promise<{ ok: true } | { ok: false; reason: string }>;

/** An item as the queue holds it: what to send, and what it was measured at. */
type QueuedItem = { item: ManagedOutboundItem; bytes: number };

/** One request awaiting the child's answer. Settled exactly once. */
type PendingAck = {
    settle: (error: Error | undefined, responseArgs: unknown[]) => void;
    /** Removes the matching entry from Socket.IO's own map and clears its timer. */
    cancel?: () => void;
};

export type ManagedChannelSocket = {
    emit: (event: string, ...args: unknown[]) => unknown;
    disconnect: (close?: boolean) => unknown;
    /**
     * Socket.IO's per-emit acknowledgement timeout.
     *
     * Without it `registerAckCallback` stores the callback in `socket.acks`
     * and never removes it, so a child that ignores requests leaks one entry
     * per call for the life of the connection. With it, the entry is dropped
     * on expiry and the callback is invoked error-first.
     */
    timeout?: (ms: number) => { emit: (event: string, ...args: unknown[]) => unknown };
    /**
     * Socket.IO's pending-acknowledgement map.
     *
     * Read so a cancelled request can be removed from it. Settling our own
     * registry leaves the entry and its timer alive until expiry — measured
     * against the installed version, `acks.size` stays at one after a close —
     * which is a per-request leak for anything that ends early.
     */
    acks?: Map<number, (...args: unknown[]) => void>;
};

export type ManagedChannelLimits = {
    /** Most items that may wait at once. */
    maxQueued: number;
    /** Most bytes those items may hold, measured on their serialised args. */
    maxQueuedBytes: number;
    /** Longest a single grant check may take before it counts as unreachable. */
    checkTimeoutMs: number;
    /** Longest the child may take to acknowledge one request. */
    ackTimeoutMs: number;
    /**
     * Most requests that may be awaiting an acknowledgement at once.
     *
     * The queue bounds what is waiting to be sent; this bounds what has been
     * sent and not yet answered, which outlives the queue entry.
     */
    maxInFlightAcks: number;
};

/**
 * Defaults sized to be obviously safe rather than tuned: a few hundred packets
 * or a megabyte is far more than a healthy child is ever behind by, and far
 * less than a replica can be made to hold by opening sockets.
 */
export const DEFAULT_MANAGED_CHANNEL_LIMITS: ManagedChannelLimits = {
    maxQueued: 256,
    maxQueuedBytes: 1024 * 1024,
    checkTimeoutMs: 5_000,
    ackTimeoutMs: 60_000,
    maxInFlightAcks: 128,
};

/**
 * What an item costs, in bytes actually on the wire.
 *
 * `String.length` counts UTF-16 code units, which undercounts every non-ASCII
 * payload — agent output is full of them — so the budget it enforces is not the
 * one it claims. `Buffer.byteLength` counts the encoded bytes.
 *
 * Measured once, at enqueue, and remembered: recomputing at dequeue lets a
 * caller that mutated the args it handed over return a different number and
 * leave the budget permanently wrong.
 */
function measureBytes(args: unknown[]): number {
    try {
        return Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8');
    } catch {
        // Unserialisable args are not a reason to stop counting.
        return 1024;
    }
}

/**
 * Runs a trusted callback without letting it break the boundary.
 *
 * These callbacks are ours, but a throw inside one would abandon the drain loop
 * with the channel still open — a failure that reads as "delivery stopped" and
 * would surface as a hung child rather than as an error.
 */
function runTrusted(what: string, fn: () => void): void {
    try {
        fn();
    } catch {
        log({ module: 'managed-socket', level: 'error' }, `managed channel callback failed (${what})`);
    }
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new TimeoutError('grant check timed out')), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * One socket's serial outbound channel.
 *
 * Not exported as a singleton: a channel is bound to a socket and dies with it.
 */
export class ManagedOutboundChannel {
    private queue: QueuedItem[] = [];
    private queuedBytes = 0;
    private inFlight = new Set<PendingAck>();
    private draining = false;
    private closure: ManagedChannelClosure | null = null;
    private readonly limits: ManagedChannelLimits;

    constructor(
        private readonly socket: ManagedChannelSocket,
        private readonly checkGrant: ManagedGrantCheck,
        private readonly onClosed?: (closure: ManagedChannelClosure) => void,
        limits: Partial<ManagedChannelLimits> = {},
    ) {
        this.limits = { ...DEFAULT_MANAGED_CHANNEL_LIMITS, ...limits };
    }

    get closed(): boolean {
        return this.closure !== null;
    }

    get closureReason(): ManagedChannelClosure | null {
        return this.closure;
    }

    /** Number of items still waiting, for tests and for shutdown accounting. */
    get pending(): number {
        return this.queue.length;
    }

    /**
     * Queues a reply that Socket.IO delivers through a callback.
     *
     * The payload is passed separately so it is measured like any other packet.
     * A closure alone would weigh nothing, and a stream of large replies would
     * pass a byte budget it never touched.
     */
    enqueueCallback(
        payload: unknown,
        deliver: () => void,
        onRefused?: (reason: ManagedChannelClosure) => void,
    ): void {
        this.enqueue({ event: 'callback', args: [payload], deliver, onRefused });
    }

    enqueue(item: ManagedOutboundItem): void {
        if (this.closure) {
            this.refuse(item, this.closure);
            return;
        }
        const bytes = measureBytes(item.args);
        if (this.queue.length + 1 > this.limits.maxQueued
            || this.queuedBytes + bytes > this.limits.maxQueuedBytes) {
            // Dropping the newest item and continuing would leave the child a
            // gap it cannot see. Closing makes the gap explicit, and the
            // authenticated HTTP cursor is how it is filled.
            this.terminate({ kind: 'queue-overflow' });
            this.refuse(item, this.closure!);
            return;
        }
        this.queue.push({ item, bytes });
        this.queuedBytes += bytes;
        void this.drain();
    }

    /**
     * Closes the channel without consulting the grant — used when the socket
     * goes away on its own.
     */
    close(closure: ManagedChannelClosure): void {
        if (this.closure) return;
        this.closure = closure;
        this.flushRefusals();
        this.releaseInFlight();
        if (this.onClosed) runTrusted('onClosed', () => this.onClosed!(closure));
    }

    private refuse(item: ManagedOutboundItem, closure: ManagedChannelClosure): void {
        if (!item.onRefused) return;
        runTrusted('onRefused', () => item.onRefused!(closure));
    }

    private flushRefusals(): void {
        const pending = this.queue;
        this.queue = [];
        this.queuedBytes = 0;
        for (const queued of pending) this.refuse(queued.item, this.closure!);
        /*
         * The one that is no longer in the queue and not yet emitted.
         *
         * Between the shift and the emit there is an await — the second
         * authority behind this packet is read there — and a channel that
         * closed during it used to refuse everything except this item: it was
         * gone from `queue` and not yet in `inFlight`, so nothing settled it
         * and the caller waited out its own deadline for an answer that could
         * never come.
         */
        const inTransit = this.inTransit;
        this.inTransit = null;
        if (inTransit) this.refuse(inTransit, this.closure!);
    }

    /**
     * Wraps an acknowledgement so the child's answer crosses the same boundary.
     *
     * The answer goes back through this same queue rather than starting its own
     * check. Two reasons: a child can produce answers faster than the authority
     * can be read, and an independent check would let a late answer overtake a
     * packet still waiting — the ordering the queue exists to keep.
     *
     * Each pending acknowledgement is registered here as well as in Socket.IO,
     * so closing the channel releases them immediately instead of leaving the
     * caller to its own timeout — and so exactly one of answer, expiry and
     * closure ever settles a given request.
     */
    private gateAck(ack: (...args: unknown[]) => void, timed: boolean): (...args: unknown[]) => void {
        const pending: PendingAck = {
            settle: (error, responseArgs) => {
                if (!this.inFlight.delete(pending)) return;
                // Whatever settled this request, Socket.IO must stop holding it.
                runTrusted('ack-cancel', () => pending.cancel?.());
                if (error) {
                    // The child did not answer in time. The caller is told
                    // once; nothing is resent.
                    runTrusted('ack-timeout', () => ack(undefined));
                    return;
                }
                this.enqueue({
                    event: 'ack',
                    args: responseArgs,
                    deliver: () => ack(...responseArgs),
                });
            },
        };
        this.inFlight.add(pending);
        if (this.inFlight.size > this.limits.maxInFlightAcks) {
            this.terminate({ kind: 'ack-overflow' });
            return () => undefined;
        }

        // Socket.IO calls a *timed* acknowledgement error-first and an untimed
        // one with the child's arguments alone. Reading the wrong shape either
        // drops the response or mistakes it for an error.
        if (!timed) {
            return (...responseArgs: unknown[]) => pending.settle(undefined, responseArgs);
        }
        return (maybeError: unknown, ...responseArgs: unknown[]) => {
            if (maybeError instanceof Error) {
                pending.settle(maybeError, []);
                return;
            }
            pending.settle(undefined, responseArgs);
        };
    }

    /**
     * Binds the acknowledgement Socket.IO just registered to the request that
     * caused it, so settling can remove exactly that entry.
     *
     * The id is found by difference: `emit` is synchronous, so the key that
     * appeared is ours. Nothing else in the map is touched — other requests on
     * this socket, and every other socket, are none of our business.
     */
    private attachAckCancel(before: Set<number>): void {
        const acks = this.socket.acks!;
        const added = [...acks.keys()].filter((key) => !before.has(key));
        if (added.length !== 1) return;
        const id = added[0];
        const pending = [...this.inFlight][this.inFlight.size - 1];
        if (!pending) return;
        pending.cancel = () => {
            const stored = acks.get(id);
            if (!stored) return;
            // Delete first: invoking the wrapper clears Socket.IO's timer and
            // calls back into our own gate, which is already settled and does
            // nothing. Deleting afterwards would race that reentry.
            acks.delete(id);
            stored(new Error('managed request cancelled'));
        };
    }

    /** Left the queue, not yet emitted. See `flushRefusals`. */
    private inTransit: ManagedOutboundItem | null = null;

    private releaseInFlight(): void {
        // A copy, but the set is not cleared first: `settle` removes its own
        // entry and does nothing if it is already gone, which is what keeps
        // "exactly once" true when a closure races an answer.
        for (const entry of [...this.inFlight]) {
            runTrusted('ack-release', () => entry.settle(new Error('channel closed'), []));
        }
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length > 0 && !this.closure) {
                // Read the head without removing it: if the check refuses, the
                // item must be answered as refused rather than silently lost.
                const { item, bytes } = this.queue[0];
                let verdict: { ok: true } | { ok: false; reason: string };
                try {
                    verdict = await withTimeout(this.checkGrant(), this.limits.checkTimeoutMs);
                } catch {
                    this.terminate({ kind: 'authority-unavailable' });
                    return;
                }
                if (!verdict.ok) {
                    this.terminate({ kind: 'grant-invalid', reason: verdict.reason });
                    return;
                }
                // Re-checked after the await: the socket may have gone away, or
                // another path may have closed the channel, while we waited.
                if (this.closure) return;
                this.queue.shift();
                this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
                // Held here until it is emitted or refused, so a close during
                // the awaits below still settles it.
                this.inTransit = item;
                // The caller may have given up while the grant was being read.
                // Releasing now would run a side effect nobody is waiting for.
                // One expired item is dropped; the channel stays open.
                if (item.expiresAt !== undefined && Date.now() >= item.expiresAt) {
                    this.inTransit = null;
                    this.refuse(item, { kind: 'expired' });
                    continue;
                }
                if (item.precondition) {
                    let allowed: { ok: true } | { ok: false; reason: string };
                    try {
                        allowed = await withTimeout(item.precondition(), this.limits.checkTimeoutMs);
                    } catch {
                        // Unable to look is not permission to send.
                        allowed = { ok: false, reason: 'authority-unavailable' };
                    }
                    // Checked again after the await, as everywhere else here.
                    // `flushRefusals` has already settled this item in that
                    // case, so it must not be settled or emitted again.
                    if (this.closure) return;
                    if (!allowed.ok) {
                        this.inTransit = null;
                        this.refuse(item, { kind: 'sender-revoked', reason: allowed.reason });
                        continue;
                    }
                    /*
                     * The deadline again, measured now.
                     *
                     * Reading the second authority takes time — a database
                     * round trip, and up to `checkTimeoutMs` of it. The window
                     * the caller was waiting in can close inside that read, and
                     * emitting afterwards sends a request whose answer nobody
                     * will accept: the child does the work and the result is
                     * discarded.
                     */
                    if (item.expiresAt !== undefined && Date.now() >= item.expiresAt) {
                        this.inTransit = null;
                        this.refuse(item, { kind: 'expired' });
                        continue;
                    }
                }
                this.inTransit = null;
                if (item.deliver) {
                    runTrusted('deliver', item.deliver);
                } else if (item.ack) {
                    const timed = typeof this.socket.timeout === 'function';
                    const gated = this.gateAck(item.ack, timed);
                    if (this.closure) return;
                    // What is left of the caller's own deadline, never a fresh
                    // window starting now.
                    const remaining = item.expiresAt !== undefined
                        ? Math.max(1, item.expiresAt - Date.now())
                        : item.ackTimeoutMs ?? this.limits.ackTimeoutMs;
                    const target = timed ? this.socket.timeout!(remaining) : this.socket;
                    const before = this.socket.acks ? new Set(this.socket.acks.keys()) : null;
                    runTrusted('emit', () => target.emit(item.event, ...item.args, gated));
                    if (before && this.socket.acks) {
                        this.attachAckCancel(before);
                    }
                } else {
                    runTrusted('emit', () => this.socket.emit(item.event, ...item.args));
                }
            }
        } finally {
            this.draining = false;
        }
    }

    private terminate(closure: ManagedChannelClosure): void {
        if (this.closure) return;
        this.closure = closure;
        this.flushRefusals();
        this.releaseInFlight();
        runTrusted('disconnect', () => this.socket.disconnect(true));
        if (this.onClosed) runTrusted('onClosed', () => this.onClosed!(closure));
    }
}
