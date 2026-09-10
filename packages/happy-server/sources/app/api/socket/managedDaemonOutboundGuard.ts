/**
 * The last check before a request leaves for a managed runtime.
 *
 * A socket's authority is not a property of the connection: the grant behind it
 * can be withdrawn, superseded by a renewal, or expire, and none of those close
 * the TCP connection. Between the moment a request picks its target and the
 * moment the bytes go out, any of them can have happened — and a daemon whose
 * grant is gone is exactly the daemon that must not be handed more work.
 *
 * So this is asked **per outbound request**, not on a timer. A timer bounds how
 * long a revoked socket lingers; it does not stop the request already on its
 * way, and "we would have noticed within thirty seconds" is not a boundary.
 *
 * It applies only to sockets that authenticated as managed runtimes. An
 * ordinary machine socket has no grant to re-read, and asking about one would
 * refuse every BYOS daemon on the server.
 */
import type { ManagedDaemonClaims } from '@/app/auth/managedDaemonToken';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import { authorizeManagedDaemonRequest } from '@/app/managed/managedDaemonAccess';

export type ManagedOutboundTarget = {
    data?: Record<string, unknown>;
    handshake?: { auth?: Record<string, unknown> };
};

export type ManagedOutboundGuardDeps = {
    authorize?: typeof authorizeManagedDaemonRequest;
    now?: () => number;
};

/**
 * `true` when the request may go out.
 *
 * A target that is not a managed runtime passes untouched. One that is must
 * still hold a live grant for the machine it authenticated as, checked now.
 */
export async function managedOutboundAllowed(input: {
    target: ManagedOutboundTarget;
    managedControl: ManagedControlRuntime | null;
    deps?: ManagedOutboundGuardDeps;
}): Promise<boolean> {
    const claims = input.target.data?.managedDaemon as ManagedDaemonClaims | undefined;
    if (!claims) return true;
    // A managed socket exists, and the deployment cannot check it. Refusing is
    // the only honest answer: the alternative is dispatching work to a runtime
    // whose authority nobody in this process can read.
    if (!input.managedControl) return false;

    const token = input.target.handshake?.auth?.token;
    if (typeof token !== 'string' || token === '') return false;

    const deps = input.deps ?? {};
    try {
        const result = await (deps.authorize ?? authorizeManagedDaemonRequest)({
            token,
            issuer: input.managedControl.daemonTokens,
            machineId: claims.machineId,
            now: (deps.now ?? Date.now)(),
        });
        return result.ok;
    } catch {
        // The same rule the inbound guard uses: a lookup that failed is not a
        // grant that holds.
        return false;
    }
}

/**
 * The control runtime this process built, for callers that cannot be handed it.
 *
 * `rpcHandler` is constructed per socket and has no access to what the API
 * assembled at startup. A second `createManagedControlRuntime` here would
 * derive a second key and accept tokens the first would not, so the one that
 * exists is registered instead.
 */
let registered: ManagedControlRuntime | null = null;

export function setManagedControlRuntime(runtime: ManagedControlRuntime | null): void {
    registered = runtime;
}

export function managedControlRuntime(): ManagedControlRuntime | null {
    return registered;
}
