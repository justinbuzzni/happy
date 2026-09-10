/**
 * What a managed runtime can still do once its socket is open.
 *
 * The handshake proves who connected. These are the properties that decide what
 * that connection is worth afterwards: it addresses one machine, and it stops
 * the moment the grant behind it does.
 */
import { describe, expect, it, vi } from 'vitest';

import { installManagedDaemonSocketGuard } from '@/app/api/socket/managedDaemonSocketGuard';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import type { ManagedDaemonAccessResult } from '@/app/managed/managedDaemonAccess';

const CLAIMS = { machineId: 'machine-1', accountId: 'acct-1' } as never;
const CONTROL = { daemonTokens: {} } as unknown as ManagedControlRuntime;

function harness(over: { live?: boolean; authorize?: unknown } = {}) {
    let middleware: ((packet: unknown, next: (error?: Error) => void) => void) | null = null;
    const socket = {
        use: vi.fn((fn: never) => { middleware = fn; }),
        disconnect: vi.fn(),
    };
    let ticker: (() => void) | null = null;
    const authorize = over.authorize ?? vi.fn(async () => ({
        ok: over.live !== false,
        ...(over.live === false ? { reason: 'revoked' } : { principal: { kind: 'managed-daemon', claims: CLAIMS } }),
    } as ManagedDaemonAccessResult));
    const guard = installManagedDaemonSocketGuard({
        socket: socket as never,
        claims: CLAIMS,
        token: 'daemon.bearer',
        managedControl: CONTROL,
        deps: {
            authorize: authorize as never,
            now: () => 1_000,
            setInterval: (handler) => { ticker = handler; return { unref: () => {} }; },
            clearInterval: () => { ticker = null; },
        },
    });
    const send = (event: string, payload?: unknown) => new Promise<Error | undefined>((resolve) => {
        middleware!([event, payload], resolve);
    });
    return { socket, send, guard, authorize, tick: () => ticker?.() };
}

describe('a managed runtime socket after the handshake', () => {
    it('passes an event for its own machine', async () => {
        const { send } = harness();
        expect(await send('machine-alive', { machineId: 'machine-1', time: 1_000 })).toBeUndefined();
    });

    it('refuses an event naming another machine of the same account', async () => {
        /*
         * This is the one that matters: the socket belongs to an account with
         * other machines, and the handlers act on whatever the payload names.
         * Without this the credential is a fleet credential, not a runtime one.
         */
        const { send, socket } = harness();
        const error = await send('machine-update-metadata', { machineId: 'machine-2', metadata: 'x' });
        expect(error?.message).toMatch(/only address its own machine/);
        expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('refuses an rpc registration for another machine, on the real wire shape', async () => {
        /*
         * `rpc-register` carries **no `machineId` field**. The scope is inside
         * the method name — `machine-2:bash` — so a guard that only looked for
         * a machine id found nothing to compare and let it through. That is the
         * whole bypass: one socket, the account's other machines, and a method
         * registered for any of them.
         */
        const { send, socket } = harness();
        const error = await send('rpc-register', { method: 'machine-2:bash' });
        expect(error?.message).toMatch(/only address its own machine/);
        expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('accepts an rpc registration for its own machine', async () => {
        const { send } = harness();
        expect(await send('rpc-register', { method: 'machine-1:bash' })).toBeUndefined();
    });

    it.each([
        ['no prefix at all', 'bash'],
        ['an empty machine', ':bash'],
        ['a prefix that merely starts the same', 'machine-11:bash'],
        ['a method that is not a string', 42],
    ])('refuses a registration with %s', async (_name, method) => {
        const { send } = harness();
        expect((await send('rpc-register', { method }))?.message).toMatch(/machine/);
    });

    it('refuses an event that is not on the runtime allowlist', async () => {
        // A handler added later must not become reachable from a runtime just
        // by existing.
        expect((await send_('session-alive'))?.message).toMatch(/not available/);
        async function send_(event: string) {
            const { send } = harness();
            return send(event, { machineId: 'machine-1' });
        }
    });

    it('re-reads the grant on every event, and disconnects when it is gone', async () => {
        // A grant withdrawn a second after the handshake has to stop this
        // socket. Remembering the handshake's answer would keep it alive for as
        // long as it stays open — which, for a daemon, is indefinitely.
        const { send, socket, authorize } = harness({ live: false });
        const error = await send('machine-alive', { machineId: 'machine-1' });
        expect(error?.message).toMatch(/no longer live/);
        expect(socket.disconnect).toHaveBeenCalledWith(true);
        expect(authorize).toHaveBeenCalled();
    });

    it('treats a failed grant lookup as not granted', async () => {
        const authorize = vi.fn(async () => { throw new Error('database unreachable'); });
        const { send, socket } = harness({ authorize });
        expect((await send('machine-alive', { machineId: 'machine-1' }))?.message)
            .toMatch(/no longer live/);
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects an idle socket whose grant was withdrawn', async () => {
        // Revocation cannot depend on the revoked party choosing to send
        // something: a daemon can sit silent while holding a live connection.
        const { socket, tick } = harness({ live: false });
        tick();
        await new Promise((resolve) => setImmediate(resolve));
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('leaves a live idle socket alone', async () => {
        const { socket, tick } = harness();
        tick();
        await new Promise((resolve) => setImmediate(resolve));
        expect(socket.disconnect).not.toHaveBeenCalled();
    });
});
