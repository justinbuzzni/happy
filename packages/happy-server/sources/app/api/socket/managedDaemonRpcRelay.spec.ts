/**
 * Where a managed runtime's authority is read, relative to where the packet
 * leaves.
 *
 * The property is about ordering across replicas, so the control that matters
 * holds the request between "the sender decided" and "the owning replica
 * emits", withdraws the grant inside that window, and asks whether the daemon
 * received anything. A test that only checked the sender's answer would pass
 * against the version this replaces.
 */
import { describe, expect, it, vi } from 'vitest';

import {
    dispatchDaemonRpc,
    executeDaemonRpcLocally,
} from '@/app/api/socket/managedDaemonRpcRelay';

type Emitted = { method: string; params: unknown };

function daemonSocket(emitted: Emitted[], windows: number[] = []) {
    return {
        id: 'socket-1',
        data: { managedDaemon: { machineId: 'machine-1', accountId: 'acct-1' } },
        handshake: { auth: { token: 'daemon.bearer' } },
        timeout: (ms: number) => ({
            ...(windows.push(ms) ? {} : {}),
            emitWithAck: async (_event: string, payload: Emitted) => {
                emitted.push(payload);
                return { ok: true };
            },
        }),
    };
}

function ioWith(socket: unknown) {
    return {
        sockets: { sockets: new Map(socket ? [['socket-1', socket]] : []) },
        serverSideEmit: vi.fn(),
        on: vi.fn(),
    } as never;
}

const REQUEST = {
    requestId: 'req-1',
    targetSocketId: 'socket-1',
    method: 'machine-1:bash',
    params: { command: 'ls' },
    timeoutMs: 1_000,
};

describe('handing a request to a managed runtime', () => {
    it('reads the grant on the replica that emits, immediately before emitting', async () => {
        /*
         * The barrier: the grant is live when the request is dispatched and
         * withdrawn while it is in flight. A check made before the hop would
         * have said yes; the emit still must not happen.
         */
        const emitted: Emitted[] = [];
        let live = true;
        let released = () => { /* replaced */ };
        const inFlight = new Promise<void>((resolve) => { released = resolve; });

        const outcome = dispatchDaemonRpc({
            io: ioWith(daemonSocket(emitted)),
            request: REQUEST,
            deps: {
                allowed: (async () => {
                    // The hop: the owning replica does not get to answer until
                    // the withdrawal below has happened.
                    await inFlight;
                    return live;
                }) as never,
            },
        });
        live = false;
        released();

        expect(await outcome).toEqual({ ok: false, reason: 'refused' });
        expect(emitted).toEqual([]);
    });

    it('delivers exactly one request when the grant holds', async () => {
        const emitted: Emitted[] = [];
        const outcome = await dispatchDaemonRpc({
            io: ioWith(daemonSocket(emitted)),
            request: REQUEST,
            deps: { allowed: (async () => true) as never },
        });
        expect(outcome).toEqual({ ok: true, result: { ok: true } });
        expect(emitted).toEqual([{ method: 'machine-1:bash', params: { command: 'ls' } }]);
    });

    it('emits nothing once the caller\'s deadline has passed', async () => {
        /*
         * The authority answer can arrive after the caller has given up. A
         * check whose result is acted on regardless turns "we asked in time"
         * into "we emitted late": the caller was told `timeout` and the daemon
         * ran the command anyway, which is the one outcome a deadline exists to
         * rule out.
         *
         * The deadline is absolute — fixed when the request was made — so a hop
         * that took most of it does not hand the recipient a fresh window.
         */
        vi.useFakeTimers();
        try {
            const emitted: Emitted[] = [];
            let release = () => { /* replaced */ };
            const held = new Promise<void>((resolve) => { release = resolve; });
            const outcome = dispatchDaemonRpc({
                io: ioWith(daemonSocket(emitted)),
                request: { ...REQUEST, timeoutMs: 20 },
                deps: { allowed: (async () => { await held; return true; }) as never },
            });
            await vi.advanceTimersByTimeAsync(21);
            release();
            await vi.advanceTimersByTimeAsync(1);
            expect(await outcome).toEqual({ ok: false, reason: 'timeout' });
            expect(emitted).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles the caller at the deadline even while the authority is still being read', async () => {
        // The lookup can hang. A promise that only settles when it answers is a
        // caller held past its own deadline by a database.
        vi.useFakeTimers();
        try {
            const emitted: Emitted[] = [];
            const outcome = dispatchDaemonRpc({
                io: ioWith(daemonSocket(emitted)),
                request: { ...REQUEST, timeoutMs: 20 },
                deps: { allowed: (() => new Promise(() => { /* never answers */ })) as never },
            });
            await vi.advanceTimersByTimeAsync(25);
            expect(await outcome).toEqual({ ok: false, reason: 'timeout' });
            expect(emitted).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('spends no authority lookup on a request whose caller has already gone', async () => {
        // Asking costs a database round trip, and the answer could not be used.
        const emitted: Emitted[] = [];
        const asked = vi.fn();
        const started = await executeDaemonRpcLocally({
            io: ioWith(daemonSocket(emitted)),
            request: { ...REQUEST, expiresAt: 500 },
            onResult: () => { /* recorded below */ },
            deps: { allowed: (async () => { asked(); return true; }) as never, now: () => 1_000 },
        });
        expect(asked).not.toHaveBeenCalled();
        expect(started).toEqual({ accepted: true, refused: true });
        expect(emitted).toEqual([]);
    });

    it('gives the daemon what is left of the caller\'s window, not a fresh one', async () => {
        /*
         * The hop already spent most of the deadline. Restarting `timeoutMs`
         * here would let the daemon keep running after the caller was told it
         * had timed out — the window would be the sum of both, not the one the
         * caller asked for.
         */
        const windows: number[] = [];
        await executeDaemonRpcLocally({
            io: ioWith(daemonSocket([], windows)),
            request: { ...REQUEST, timeoutMs: 1_000, expiresAt: 1_005 },
            onResult: () => { /* not asserted here */ },
            deps: { allowed: (async () => true) as never, now: () => 1_000 },
        });
        expect(windows).toEqual([5]);
    });

    it('never re-selects another socket when the named one is not here', async () => {
        // Asking the peers names the same socket. A room fallback would route
        // around whatever refused it.
        const io = ioWith(null);
        const outcome = dispatchDaemonRpc({ io, request: { ...REQUEST, timeoutMs: 20 } });
        expect(await outcome).toMatchObject({ ok: false });
        const relayed = (io as unknown as { serverSideEmit: ReturnType<typeof vi.fn> }).serverSideEmit;
        expect(relayed).toHaveBeenCalledWith(
            'managed:daemon-rpc-execute',
            expect.objectContaining({ targetSocketId: 'socket-1', requestId: 'req-1' }),
            expect.any(Function),
        );
    });

    it('says nothing about a socket it does not hold', async () => {
        // "Not mine" and "not authorised" are different answers, and a replica
        // that conflated them would refuse a request another replica could
        // legitimately deliver.
        const started = await executeDaemonRpcLocally({
            io: ioWith(null),
            request: REQUEST,
            onResult: () => { throw new Error('must not answer'); },
            deps: { allowed: (async () => false) as never },
        });
        expect(started).toEqual({ accepted: false, refused: false });
    });

    it('refuses on arrival rather than emitting, when the grant is gone', async () => {
        const emitted: Emitted[] = [];
        const results: unknown[] = [];
        const started = await executeDaemonRpcLocally({
            io: ioWith(daemonSocket(emitted)),
            request: REQUEST,
            onResult: (outcome) => results.push(outcome),
            deps: { allowed: (async () => false) as never },
        });
        expect(started).toEqual({ accepted: true, refused: true });
        expect(results).toEqual([{ ok: false, reason: 'refused' }]);
        expect(emitted).toEqual([]);
    });
});
