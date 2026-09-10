import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MANAGED_CHANNEL_LIMITS,
    ManagedOutboundChannel,
    type ManagedChannelClosure,
    type ManagedChannelSocket,
} from '@/app/api/socket/managed/managedOutboundQueue';

/** Pure: no database, no sockets, no environment. */

type Emitted = { event: string; args: unknown[] };

function fakeSocket() {
    const emitted: Emitted[] = [];
    let disconnected = false;
    const socket: ManagedChannelSocket = {
        emit: (event, ...args) => { emitted.push({ event, args }); return true; },
        disconnect: () => { disconnected = true; return undefined; },
    };
    return { socket, emitted, get disconnected() { return disconnected; } };
}

/** A check whose answer each call is controlled by the test. */
function scriptedCheck(answers: Array<{ ok: true } | { ok: false; reason: string } | Error>) {
    let calls = 0;
    return {
        get calls() { return calls; },
        check: async () => {
            const answer = answers[Math.min(calls, answers.length - 1)];
            calls++;
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
}

const allow = { ok: true } as const;

async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('a live grant lets traffic through', () => {
    it('emits queued items in order', async () => {
        const { socket, emitted } = fakeSocket();
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'update', args: [1] });
        channel.enqueue({ event: 'ephemeral', args: [2] });
        channel.enqueue({ event: 'rpc-request', args: [3] });
        await settle();
        expect(emitted).toEqual([
            { event: 'update', args: [1] },
            { event: 'ephemeral', args: [2] },
            { event: 'rpc-request', args: [3] },
        ]);
    });

    it('checks the grant once per item, not once per socket', async () => {
        const { socket } = fakeSocket();
        const scripted = scriptedCheck([allow]);
        const channel = new ManagedOutboundChannel(socket, scripted.check);
        channel.enqueue({ event: 'update', args: [] });
        channel.enqueue({ event: 'update', args: [] });
        await settle();
        // A grant read once and reused would let everything after a revoke
        // through for the life of the connection.
        expect(scripted.calls).toBe(2);
    });
});

describe('a refusal is a boundary, not a skipped item', () => {
    it('stops at the item whose check refused and drops what follows', async () => {
        const { socket, emitted } = fakeSocket();
        const scripted = scriptedCheck([allow, { ok: false, reason: 'revoked' }]);
        const channel = new ManagedOutboundChannel(socket, scripted.check);
        channel.enqueue({ event: 'first', args: [] });
        channel.enqueue({ event: 'second', args: [] });
        channel.enqueue({ event: 'third', args: [] });
        await settle();
        expect(emitted.map((e) => e.event)).toEqual(['first']);
        expect(channel.closed).toBe(true);
        expect(channel.closureReason).toEqual({ kind: 'grant-invalid', reason: 'revoked' });
    });

    it('closes the socket rather than leaving it connected and mute', async () => {
        const fake = fakeSocket();
        const channel = new ManagedOutboundChannel(fake.socket, async () => ({ ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'update', args: [] });
        await settle();
        expect(fake.disconnected).toBe(true);
    });

    it('answers a queued acknowledgement instead of letting it hang', async () => {
        const { socket } = fakeSocket();
        const refusals: ManagedChannelClosure[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => ({ ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'rpc-request', args: [], onRefused: (r) => refusals.push(r) });
        channel.enqueue({ event: 'rpc-request', args: [], onRefused: (r) => refusals.push(r) });
        await settle();
        // The caller learns the answer will never come; a silent drop would
        // leave it waiting for its own timeout.
        expect(refusals).toEqual([
            { kind: 'grant-invalid', reason: 'revoked' },
            { kind: 'grant-invalid', reason: 'revoked' },
        ]);
    });

    it('refuses anything enqueued after the channel closed', async () => {
        const { socket, emitted } = fakeSocket();
        const refusals: ManagedChannelClosure[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => ({ ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'first', args: [] });
        await settle();
        channel.enqueue({ event: 'later', args: [], onRefused: (r) => refusals.push(r) });
        await settle();
        expect(emitted).toEqual([]);
        expect(refusals).toHaveLength(1);
    });

    it('treats an unreachable authority as a refusal, never as permission', async () => {
        const fake = fakeSocket();
        const channel = new ManagedOutboundChannel(
            fake.socket,
            scriptedCheck([new Error('connect ECONNREFUSED')]).check,
        );
        channel.enqueue({ event: 'update', args: [] });
        await settle();
        // An unanswerable question about permission is not permission.
        expect(fake.emitted).toEqual([]);
        expect(fake.disconnected).toBe(true);
        expect(channel.closureReason).toEqual({ kind: 'authority-unavailable' });
    });
});

describe('serial delivery', () => {
    it('never has two checks in flight at once', async () => {
        const { socket, emitted } = fakeSocket();
        let inFlight = 0;
        let maxInFlight = 0;
        const release: Array<() => void> = [];
        const channel = new ManagedOutboundChannel(socket, () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve) => {
                release.push(() => { inFlight--; resolve(allow); });
            });
        });
        channel.enqueue({ event: 'a', args: [] });
        channel.enqueue({ event: 'b', args: [] });
        channel.enqueue({ event: 'c', args: [] });
        await settle();
        while (release.length > 0) {
            release.shift()!();
            await settle();
        }
        expect(maxInFlight).toBe(1);
        expect(emitted.map((e) => e.event)).toEqual(['a', 'b', 'c']);
    });

    it('does not emit an item whose check finished after the channel closed', async () => {
        const fake = fakeSocket();
        let resolveCheck: ((v: { ok: true }) => void) | null = null;
        const channel = new ManagedOutboundChannel(fake.socket, () =>
            new Promise((resolve) => { resolveCheck = resolve as never; }));
        channel.enqueue({ event: 'in-flight', args: [] });
        await settle();
        // The socket dropped while the check was still running.
        channel.close({ kind: 'disconnected' });
        resolveCheck!({ ok: true });
        await settle();
        expect(fake.emitted).toEqual([]);
    });

    it('reports a closure once, through the callback', async () => {
        const { socket } = fakeSocket();
        const closures: ManagedChannelClosure[] = [];
        const channel = new ManagedOutboundChannel(
            socket,
            async () => ({ ok: false, reason: 'expired' }),
            (closure) => closures.push(closure),
        );
        channel.enqueue({ event: 'a', args: [] });
        await settle();
        channel.close({ kind: 'disconnected' });
        expect(closures).toEqual([{ kind: 'grant-invalid', reason: 'expired' }]);
    });
});

describe('the queue is bounded', () => {
    it('closes with a fixed reason rather than growing without limit', async () => {
        const fake = fakeSocket();
        // A check that never answers is the shape of a slow authority store,
        // which is exactly when a fast stream would pile up.
        const channel = new ManagedOutboundChannel(
            fake.socket,
            () => new Promise(() => {}),
            undefined,
            { maxQueued: 3 },
        );
        const refusals: ManagedChannelClosure[] = [];
        for (let i = 0; i < 10; i++) {
            channel.enqueue({ event: 'stream', args: [i], onRefused: (r) => refusals.push(r) });
        }
        await settle();
        expect(channel.closureReason).toEqual({ kind: 'queue-overflow' });
        expect(fake.disconnected).toBe(true);
        // Everything still waiting is answered, so nothing hangs on a timeout.
        expect(refusals.length).toBeGreaterThanOrEqual(7);
        expect(refusals.every((r) => r.kind === 'queue-overflow')).toBe(true);
    });

    it('bounds by size as well as by count', async () => {
        const fake = fakeSocket();
        const channel = new ManagedOutboundChannel(
            fake.socket,
            () => new Promise(() => {}),
            undefined,
            { maxQueued: 1_000, maxQueuedBytes: 200 },
        );
        for (let i = 0; i < 5; i++) {
            channel.enqueue({ event: 'stream', args: ['x'.repeat(100)] });
        }
        await settle();
        expect(channel.closureReason).toEqual({ kind: 'queue-overflow' });
    });

    it('frees the bytes an emitted item held', async () => {
        const { socket } = fakeSocket();
        const channel = new ManagedOutboundChannel(
            socket, async () => allow, undefined, { maxQueuedBytes: 300 },
        );
        for (let i = 0; i < 20; i++) {
            channel.enqueue({ event: 'stream', args: ['x'.repeat(100)] });
            await settle();
        }
        // Draining releases the budget; a leak here would close the channel.
        expect(channel.closed).toBe(false);
    });

    it('has bounds by default, not only when a caller asks', () => {
        expect(DEFAULT_MANAGED_CHANNEL_LIMITS.maxQueued).toBeGreaterThan(0);
        expect(DEFAULT_MANAGED_CHANNEL_LIMITS.maxQueuedBytes).toBeGreaterThan(0);
        expect(DEFAULT_MANAGED_CHANNEL_LIMITS.checkTimeoutMs).toBeGreaterThan(0);
    });
});

describe('a grant check that never answers', () => {
    it('closes the channel instead of waiting forever', async () => {
        vi.useFakeTimers();
        try {
            const fake = fakeSocket();
            const channel = new ManagedOutboundChannel(
                fake.socket, () => new Promise(() => {}), undefined, { checkTimeoutMs: 50 },
            );
            channel.enqueue({ event: 'update', args: [] });
            await vi.advanceTimersByTimeAsync(60);
            expect(channel.closureReason).toEqual({ kind: 'authority-unavailable' });
            expect(fake.emitted).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('acknowledgements cross the same boundary', () => {
    it('runs the callback only while the grant is still live', async () => {
        const { socket, emitted } = fakeSocket();
        let live = true;
        const channel = new ManagedOutboundChannel(socket, async () =>
            (live ? allow : { ok: false, reason: 'revoked' }));
        const answered: unknown[] = [];
        channel.enqueue({ event: 'rpc-request', args: [{ id: 1 }], ack: (...a) => answered.push(a) });
        await settle();

        const first = emitted[0].args[1] as (...args: unknown[]) => void;
        expect(typeof first).toBe('function');
        first({ ok: true });
        await settle();
        expect(answered).toHaveLength(1);
        answered.length = 0;

        // A second request, answered after the grant was withdrawn.
        channel.enqueue({ event: 'rpc-request', args: [{ id: 2 }], ack: (...a) => answered.push(a) });
        await settle();
        live = false;
        (emitted[1].args[1] as (...args: unknown[]) => void)({ ok: true });
        await settle();
        expect(answered).toEqual([]);
        expect(channel.closureReason).toEqual({ kind: 'grant-invalid', reason: 'revoked' });
    });

    it('releases a request in flight when a revoke terminates the channel', async () => {
        const { socket, emitted } = fakeSocket();
        let live = true;
        const answered: unknown[] = [];
        const channel = new ManagedOutboundChannel(socket, async () =>
            (live ? allow : { ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'rpc-request', args: [{}], ack: (...a) => answered.push(a) });
        await settle();
        expect(emitted).toHaveLength(1);
        expect(answered).toEqual([]);

        // A later packet finds the grant gone and terminates the channel; the
        // request already sent must not be left waiting on its own timeout.
        live = false;
        channel.enqueue({ event: 'update', args: [] });
        await settle();
        expect(channel.closureReason).toEqual({ kind: 'grant-invalid', reason: 'revoked' });
        expect(answered).toEqual([[undefined]]);
    });

    it('ignores a second answer to a request already settled', async () => {
        const { socket, emitted } = fakeSocket();
        const answered: unknown[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'rpc-request', args: [{}], ack: (...a) => answered.push(a) });
        await settle();
        const gatedAck = emitted[0].args[1] as (...args: unknown[]) => void;
        gatedAck({ ok: true });
        gatedAck({ ok: true });
        await settle();
        // One request, one answer. A duplicate is a duplicate, not a new call.
        expect(answered).toHaveLength(1);
    });

    it('releases everything still waiting when the channel closes', async () => {
        const { socket, emitted } = fakeSocket();
        const answered: unknown[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'rpc-request', args: [{}], ack: (...a) => answered.push(a) });
        await settle();
        expect(emitted).toHaveLength(1);
        channel.close({ kind: 'disconnected' });
        await settle();
        // The caller is told once, immediately, rather than waiting out its own
        // timeout for an answer that can no longer arrive.
        expect(answered).toEqual([[undefined]]);
    });

    it('drops a response that arrives after the channel closed', async () => {
        const { socket, emitted } = fakeSocket();
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        const answered: unknown[] = [];
        channel.enqueue({
            event: 'rpc-request', args: [{}],
            ack: (...a) => answered.push(a),
        });
        await settle();
        const gatedAck = emitted[0].args[1] as (...args: unknown[]) => void;
        channel.close({ kind: 'disconnected' });
        await settle();
        // Closing settles the request as unanswered, once.
        expect(answered).toEqual([[undefined]]);

        gatedAck({ from: 'the child' });
        await settle();
        // The child's late response adds nothing: the request is already done.
        expect(answered).toEqual([[undefined]]);
    });

    it('emits without a trailing callback when the item has none', async () => {
        const { socket, emitted } = fakeSocket();
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'update', args: [{ seq: 1 }] });
        await settle();
        expect(emitted[0].args).toEqual([{ seq: 1 }]);
    });
});

describe('a throwing callback does not break the boundary', () => {
    it('keeps draining when emit throws', async () => {
        const emitted: string[] = [];
        const socket: ManagedChannelSocket = {
            emit: (event) => {
                if (event === 'bad') throw new Error('socket exploded');
                emitted.push(event);
                return true;
            },
            disconnect: () => undefined,
        };
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'bad', args: [] });
        channel.enqueue({ event: 'good', args: [] });
        await settle();
        // A throw that abandoned the loop would read as a hung child.
        expect(emitted).toEqual(['good']);
        expect(channel.closed).toBe(false);
    });

    it('closes cleanly when a refusal callback throws', async () => {
        const fake = fakeSocket();
        const channel = new ManagedOutboundChannel(fake.socket, async () => ({ ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'a', args: [], onRefused: () => { throw new Error('handler exploded'); } });
        channel.enqueue({ event: 'b', args: [], onRefused: () => { throw new Error('handler exploded'); } });
        await settle();
        expect(channel.closureReason).toEqual({ kind: 'grant-invalid', reason: 'revoked' });
        expect(fake.disconnected).toBe(true);
    });
});

describe('a reply delivered through a callback', () => {
    it('waits its turn and is released only under a live grant', async () => {
        const { socket, emitted } = fakeSocket();
        const order: string[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueue({ event: 'first', args: [] });
        channel.enqueueCallback({ result: 'ok' }, () => { order.push('reply'); });
        channel.enqueue({ event: 'last', args: [] });
        await settle();
        // Socket.IO writes a reply through a callback rather than an event, so
        // without an explicit queue entry it would overtake the packets before
        // it and skip the check entirely.
        expect(emitted.map((e) => e.event)).toEqual(['first', 'last']);
        expect(order).toEqual(['reply']);
    });

    it('is not delivered once the grant is gone', async () => {
        const { socket } = fakeSocket();
        const order: string[] = [];
        const refusals: ManagedChannelClosure[] = [];
        const channel = new ManagedOutboundChannel(socket, async () => ({ ok: false, reason: 'revoked' }));
        channel.enqueueCallback({ result: 'ok' }, () => { order.push('reply'); }, (r) => { refusals.push(r); });
        await settle();
        expect(order).toEqual([]);
        expect(refusals).toEqual([{ kind: 'grant-invalid', reason: 'revoked' }]);
    });

    it('does not break the channel when the reply throws', async () => {
        const { socket, emitted } = fakeSocket();
        const channel = new ManagedOutboundChannel(socket, async () => allow);
        channel.enqueueCallback({}, () => { throw new Error('reply exploded'); });
        channel.enqueue({ event: 'after', args: [] });
        await settle();
        expect(emitted.map((e) => e.event)).toEqual(['after']);
        expect(channel.closed).toBe(false);
    });
});

describe('what the bounds actually count', () => {
    it('measures encoded bytes, not UTF-16 code units', async () => {
        const fake = fakeSocket();
        // 100 characters, 300 bytes in UTF-8. A code-unit count would put this
        // at 100 and let three times the intended payload through.
        const channel = new ManagedOutboundChannel(
            fake.socket, () => new Promise(() => {}), undefined, { maxQueuedBytes: 250 },
        );
        channel.enqueue({ event: 'stream', args: ['한'.repeat(100)] });
        await settle();
        expect(channel.closureReason).toEqual({ kind: 'queue-overflow' });
    });

    it('counts a callback reply by its payload, not as nothing', async () => {
        const fake = fakeSocket();
        const channel = new ManagedOutboundChannel(
            fake.socket, () => new Promise(() => {}), undefined, { maxQueuedBytes: 400 },
        );
        for (let i = 0; i < 5; i++) {
            channel.enqueueCallback({ blob: 'x'.repeat(200) }, () => {});
        }
        await settle();
        // A closure weighs nothing; the reply it carries does not.
        expect(channel.closureReason).toEqual({ kind: 'queue-overflow' });
    });

    it('charges back what it charged, even if the caller mutated the args', async () => {
        const { socket } = fakeSocket();
        const channel = new ManagedOutboundChannel(
            socket, async () => allow, undefined, { maxQueuedBytes: 500 },
        );
        for (let i = 0; i < 20; i++) {
            const args: unknown[] = [{ blob: 'x'.repeat(100) }];
            channel.enqueue({ event: 'stream', args });
            // Shrinking it after handing it over must not refund more than was
            // charged, or the budget drifts until it is meaningless.
            (args[0] as { blob: string }).blob = '';
            await settle();
        }
        expect(channel.closed).toBe(false);
    });
});

describe('an answer from the child waits its turn', () => {
    it('goes through the same queue as everything else', async () => {
        const { socket, emitted } = fakeSocket();
        const order: string[] = [];
        let release: { fn: (() => void) | null } = { fn: null };
        let gate = false;
        const channel = new ManagedOutboundChannel(socket, () => {
            if (!gate) return Promise.resolve(allow);
            return new Promise((resolve) => { release.fn = () => resolve(allow); });
        });
        channel.enqueue({ event: 'rpc-request', args: [{}], ack: () => order.push('ack') });
        await settle();
        const gatedAck = emitted[0].args[1] as (...args: unknown[]) => void;

        // A packet is mid-check when the child answers.
        gate = true;
        channel.enqueue({ event: 'update', args: [], deliver: () => order.push('update') });
        await settle();
        gatedAck({ ok: true });
        await settle();
        expect(order).toEqual([]);

        gate = false;
        release.fn?.();
        await settle();
        // The answer did not overtake the packet queued before it.
        expect(order).toEqual(['update', 'ack']);
    });

    it('is refused rather than delivered once the grant is gone', async () => {
        const { socket, emitted } = fakeSocket();
        let live = true;
        const order: string[] = [];
        const channel = new ManagedOutboundChannel(socket, async () =>
            (live ? allow : { ok: false, reason: 'revoked' }));
        channel.enqueue({ event: 'rpc-request', args: [{}], ack: () => order.push('ack') });
        await settle();
        const gatedAck = emitted[0].args[1] as (...args: unknown[]) => void;
        live = false;
        gatedAck({ ok: true });
        await settle();
        expect(order).toEqual([]);
        expect(channel.closureReason).toEqual({ kind: 'grant-invalid', reason: 'revoked' });
    });
});

describe('the window between leaving the queue and going out', () => {
    /*
     * A packet sent on a second authority is checked again immediately before
     * the emit, and that check is a database read. Two things can happen while
     * it runs, and both used to end badly: the caller's deadline can pass, and
     * the channel can close. Folded in from root's own fixture, assertions
     * unchanged.
     */
    const allow = { ok: true } as const;

    function barrier() {
        let release!: () => void; let entered!: () => void;
        const waiting = new Promise<void>((r) => { release = r; });
        const started = new Promise<void>((r) => { entered = r; });
        return { release, started, check: async () => { entered(); await waiting; return allow; } };
    }

    it('refuses an item whose deadline passes during approver validation', async () => {
        const gate = barrier(); const emit = vi.fn(); const refused = vi.fn();
        let now = 1000; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const channel = new ManagedOutboundChannel({ emit, disconnect: vi.fn() }, async () => allow);
        try {
            channel.enqueue({ event: 'rpc-request', args: [], expiresAt: 2000, precondition: gate.check, onRefused: refused });
            await gate.started; now = 2001; gate.release(); await settle();
            expect(emit).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledOnce();
        } finally { gate.release(); channel.close({ kind: 'authority-unavailable' }); clock.mockRestore(); }
    });

    it('settles the item if the channel closes while approver validation waits', async () => {
        const gate = barrier(); const emit = vi.fn(); const refused = vi.fn();
        const channel = new ManagedOutboundChannel({ emit, disconnect: vi.fn() }, async () => allow);
        try {
            channel.enqueue({ event: 'rpc-request', args: [], precondition: gate.check, onRefused: refused });
            await gate.started; channel.close({ kind: 'authority-unavailable' }); gate.release(); await settle();
            expect(emit).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledOnce();
        } finally { gate.release(); channel.close({ kind: 'authority-unavailable' }); }
    });
});
