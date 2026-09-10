/**
 * What happens to a machine socket when its credential changes or dies.
 *
 * Both properties here are about **reconnection**, which is where a credential
 * is actually presented again. A renewal that never reaches the handshake looks
 * fine until the first network flap and then never comes back; a socket stopped
 * for an expired credential that reconnects anyway keeps a dead bearer in
 * flight while the parent has already moved on.
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';

function machine(): Machine {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32).fill(5),
        encryptionVariant: 'dataKey',
        metadata: null as never,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

/** A stand-in for the socket the client holds, with the fields under test. */
function fakeSocket() {
    return {
        auth: { token: 'first.bearer', clientType: 'machine-scoped', machineId: 'machine-1' },
        connected: false,
        connect: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
        disconnect: vi.fn(),
    };
}

function clientWith(socket: ReturnType<typeof fakeSocket>) {
    const client = new ApiMachineClient('first.bearer', machine());
    (client as unknown as { socket: unknown }).socket = socket;
    return client;
}

describe('a machine socket whose credential is renewed', () => {
    it('presents the new token on the next connection, not the first one', () => {
        /*
         * The handshake reads `socket.auth` when it connects. Replacing only
         * the field the constructor was given leaves the socket presenting the
         * expired token on every reconnect — the failure looks like a network
         * problem and never resolves.
         */
        const socket = fakeSocket();
        const client = clientWith(socket);
        client.replaceToken('renewed.bearer');
        expect(socket.auth.token).toBe('renewed.bearer');
    });

    it('re-authenticates the live connection instead of only relabelling it', () => {
        /*
         * The server re-reads the grant on every event, against the token the
         * **handshake** carried. A renewal supersedes the old grant the moment
         * it is issued, so a connection still presenting the old bearer starts
         * being refused immediately — swapping a field on this side changes
         * nothing about the connection the server is judging.
         *
         * So a renewal reconnects. Losing a few seconds of connection is the
         * cost; the alternative is a runtime that looks connected and has every
         * request refused until something else notices.
         */
        const socket = fakeSocket();
        socket.connected = true;
        const client = clientWith(socket);
        client.replaceToken('renewed.bearer');
        expect(socket.auth.token).toBe('renewed.bearer');
        // The connection that authenticated with the old bearer is dropped, and
        // the reconnect path brings it back with the new one.
        expect(socket.disconnect).toHaveBeenCalled();
    });

    it('refuses an empty token rather than presenting one', () => {
        const socket = fakeSocket();
        expect(() => clientWith(socket).replaceToken('  ')).toThrow();
        expect(socket.auth.token).toBe('first.bearer');
    });
});

describe('a machine socket stopped for an expired credential', () => {
    it('does not come back through the reconnect loop', () => {
        /*
         * Closing a socket fires `disconnect`, and the disconnect handler is
         * what starts the reconnect loop. Without a stop that outlives the
         * close, the runtime immediately begins retrying with the very
         * credential that just expired.
         */
        const socket = fakeSocket();
        const client = clientWith(socket);
        client.stopForExpiredCredential();
        // Whatever the reconnect loop would have done, it must not connect.
        (client as unknown as { startSmartReconnect(): void }).startSmartReconnect();
        expect(socket.connect).not.toHaveBeenCalled();
        // And the loop is not merely idle: nothing was scheduled to retry.
        expect((client as unknown as { reconnectInterval: unknown }).reconnectInterval).toBeNull();
    });

    it('does not reconnect through a timeout scheduled before it stopped', () => {
        /*
         * `startSmartReconnect` schedules a one-second retry **as well as** the
         * interval. Guarding only the entry point leaves that timeout already
         * on the queue: it fires after the stop, sees a disconnected socket,
         * and reconnects with the credential that just expired.
         */
        vi.useFakeTimers();
        try {
            const socket = fakeSocket();
            const client = clientWith(socket);
            (client as unknown as { startSmartReconnect(): void }).startSmartReconnect();
            client.stopForExpiredCredential();
            vi.advanceTimersByTime(10_000);
            expect(socket.connect).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes the socket it was holding', () => {
        const socket = fakeSocket();
        clientWith(socket).stopForExpiredCredential();
        expect(socket.close).toHaveBeenCalled();
    });
});
