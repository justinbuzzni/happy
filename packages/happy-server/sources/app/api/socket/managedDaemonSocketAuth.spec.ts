/**
 * Which handshakes may become a managed runtime's daemon socket.
 *
 * The failure worth preventing is not a daemon that cannot connect. It is a
 * socket that keeps working after the grant behind it was withdrawn, or one
 * that a token for another machine — or an account bearer — can open.
 */
import { describe, expect, it, vi } from 'vitest';

import { authenticateManagedDaemonSocket } from '@/app/api/socket/managedDaemonSocketAuth';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import type { ManagedDaemonAccessResult } from '@/app/managed/managedDaemonAccess';

const CLAIMS = {
    accountId: 'acct-1',
    machineId: 'machine-1',
    runtimeId: 'rt-1',
    provisioningOperationId: 'op-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    epoch: 4,
    generation: 2,
    daemonGrantId: 'grant-1',
} as never;

const CONTROL = { daemonTokens: {} } as unknown as ManagedControlRuntime;

function authorizeOk() {
    return vi.fn(async () => ({
        ok: true, principal: { kind: 'managed-daemon', claims: CLAIMS },
    } as ManagedDaemonAccessResult));
}

function handshake(over: Partial<{ token: string; clientType: string; machineId: string }> = {}) {
    return {
        token: 'daemon.token',
        clientType: 'machine-scoped',
        machineId: 'machine-1',
        ...over,
    };
}

describe('authenticating a managed runtime daemon socket', () => {
    it('binds the claims the grant is still live for', async () => {
        const authorize = authorizeOk();
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake(), managedControl: CONTROL, now: 1_000, authorize,
        })).toEqual(CLAIMS);
        // The machine the socket says it is, checked by the authorizer against
        // the token — not taken from the token alone.
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', token: 'daemon.token', now: 1_000,
        }));
    });

    it.each([
        ['revoked'], ['expired'], ['unknown-grant'], ['stale-generation'],
        ['machine-mismatch'], ['token-invalid'],
    ])('refuses when the authorizer says %s', async (reason) => {
        // Every refusal is the same answer here: not a managed daemon. The
        // caller then runs the ordinary verification, which refuses a managed
        // token too — so a rejected daemon has no second route in.
        const authorize = vi.fn(async () => ({ ok: false, reason } as ManagedDaemonAccessResult));
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake(), managedControl: CONTROL, now: 1_000, authorize,
        })).toBeNull();
    });

    it('never attempts it for a session or user socket', async () => {
        // A daemon credential is for one machine. Nothing else may present it,
        // and nothing else may be examined as though it might.
        const authorize = authorizeOk();
        for (const clientType of ['session-scoped', 'user-scoped', undefined]) {
            expect(await authenticateManagedDaemonSocket({
                handshake: handshake({ clientType }) as never,
                managedControl: CONTROL, now: 1_000, authorize,
            })).toBeNull();
        }
        expect(authorize).not.toHaveBeenCalled();
    });

    it('does not attempt it without a machine id or a token', async () => {
        const authorize = authorizeOk();
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake({ machineId: undefined }) as never,
            managedControl: CONTROL, now: 1_000, authorize,
        })).toBeNull();
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake({ token: '' }), managedControl: CONTROL, now: 1_000, authorize,
        })).toBeNull();
        expect(authorize).not.toHaveBeenCalled();
    });

    it('accepts nothing when managed control is not configured', async () => {
        // Unconfigured is a deliberate off state. Accepting a token nobody can
        // verify would make the off state the most permissive one.
        const authorize = authorizeOk();
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake(), managedControl: null, now: 1_000, authorize,
        })).toBeNull();
        expect(authorize).not.toHaveBeenCalled();
    });

    it('treats a failed grant lookup as not authenticated', async () => {
        // A lookup that threw is not a grant that holds. The alternative —
        // letting the socket through while the database is unreachable — is a
        // revocation that stops taking effect exactly when it matters.
        const authorize = vi.fn(async () => { throw new Error('database unreachable'); });
        expect(await authenticateManagedDaemonSocket({
            handshake: handshake(), managedControl: CONTROL, now: 1_000, authorize: authorize as never,
        })).toBeNull();
    });
});
