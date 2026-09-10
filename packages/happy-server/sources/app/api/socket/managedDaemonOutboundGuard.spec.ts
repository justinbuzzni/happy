/**
 * The last question asked before work is handed to a managed runtime.
 *
 * A revoked daemon does not close its socket, and a periodic sweep cannot stop
 * a request that is already choosing its target. What decides whether the bytes
 * go out is this, asked per request.
 */
import { describe, expect, it, vi } from 'vitest';

import { managedOutboundAllowed } from '@/app/api/socket/managedDaemonOutboundGuard';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import type { ManagedDaemonAccessResult } from '@/app/managed/managedDaemonAccess';

const CONTROL = { daemonTokens: {} } as unknown as ManagedControlRuntime;

function managedTarget(over: { token?: unknown } = {}) {
    return {
        data: { managedDaemon: { machineId: 'machine-1', accountId: 'acct-1' } },
        handshake: { auth: { token: 'token' in over ? over.token : 'daemon.bearer' } },
    };
}

function authorizer(ok: boolean) {
    return vi.fn(async () => (ok
        ? { ok: true, principal: { kind: 'managed-daemon', claims: {} } }
        : { ok: false, reason: 'revoked' }) as ManagedDaemonAccessResult);
}

describe('dispatching to a managed runtime', () => {
    it('sends when the grant is still live', async () => {
        const authorize = authorizer(true);
        expect(await managedOutboundAllowed({
            target: managedTarget(), managedControl: CONTROL, deps: { authorize: authorize as never },
        })).toBe(true);
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }));
    });

    it('does not send once the grant is gone', async () => {
        // The socket is still open — revocation does not close connections —
        // so the connection's existence is not the thing to trust.
        expect(await managedOutboundAllowed({
            target: managedTarget(),
            managedControl: CONTROL,
            deps: { authorize: authorizer(false) as never },
        })).toBe(false);
    });

    it('does not send when the grant cannot be read', async () => {
        const authorize = vi.fn(async () => { throw new Error('database unreachable'); });
        expect(await managedOutboundAllowed({
            target: managedTarget(), managedControl: CONTROL, deps: { authorize: authorize as never },
        })).toBe(false);
    });

    it('leaves an ordinary machine socket alone', async () => {
        // A BYOS daemon has no grant to read. Asking about one would refuse
        // every ordinary machine on the server.
        const authorize = authorizer(true);
        expect(await managedOutboundAllowed({
            target: { data: {}, handshake: { auth: { token: 'account.bearer' } } },
            managedControl: CONTROL,
            deps: { authorize: authorize as never },
        })).toBe(true);
        expect(authorize).not.toHaveBeenCalled();
    });

    it('refuses a managed socket this process cannot check', async () => {
        // Managed control unconfigured, and a managed socket connected anyway.
        // Dispatching would hand work to a runtime whose authority nobody here
        // can read.
        expect(await managedOutboundAllowed({
            target: managedTarget(), managedControl: null,
        })).toBe(false);
    });

    it('refuses a managed socket with no bearer to re-check', async () => {
        expect(await managedOutboundAllowed({
            target: managedTarget({ token: undefined }),
            managedControl: CONTROL,
            deps: { authorize: authorizer(true) as never },
        })).toBe(false);
    });
});
