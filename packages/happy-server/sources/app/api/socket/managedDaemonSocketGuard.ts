/**
 * What a managed runtime's socket may do **after** the handshake.
 *
 * Authenticating the connection is not the boundary. The handlers a machine
 * socket carries take a `userId` and act on whatever the payload names, so a
 * daemon that authenticated for one machine could, with the account it belongs
 * to, update another machine's metadata or register RPC methods for it. The
 * credential is scoped to one machine; without this, the socket is not.
 *
 * Two things are enforced here, on every inbound event:
 *
 *  - **The machine.** A payload naming a different machine is refused, not
 *    silently retargeted. This is the difference between a credential for one
 *    runtime and a credential for the account's whole fleet.
 *  - **The grant, freshly.** Checked again rather than remembered: a grant
 *    withdrawn or superseded a second after the handshake must stop this
 *    socket, and a connection that only re-checked at connect time would keep
 *    working for as long as it stayed open — which, for a daemon, is forever.
 *
 * An idle socket is revalidated on a timer for the same reason: revocation
 * cannot depend on the revoked party choosing to send something.
 */
import type { Socket } from 'socket.io';

import type { ManagedDaemonClaims } from '@/app/auth/managedDaemonToken';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import { authorizeManagedDaemonRequest } from '@/app/managed/managedDaemonAccess';

/**
 * The events a managed runtime's daemon actually needs.
 *
 * An allowlist, so a handler added later does not silently become reachable
 * from a runtime. Everything else is refused even if a handler exists for it.
 */
export const MANAGED_DAEMON_SOCKET_EVENTS: ReadonlySet<string> = new Set([
    'machine-alive',
    'machine-update-metadata',
    'machine-update-state',
    'rpc-register',
    'rpc-unregister',
    'rpc-response',
    'ping',
]);

export type ManagedDaemonGuardDeps = {
    authorize?: typeof authorizeManagedDaemonRequest;
    now?: () => number;
    /** How often an idle socket is revalidated against its grant. */
    revalidateIntervalMs?: number;
    setInterval?: (handler: () => void, ms: number) => { unref?: () => void };
    clearInterval?: (handle: unknown) => void;
};

/**
 * Events that name their machine inside the **method**, not in a field.
 *
 * `rpc-register` and `rpc-unregister` carry `{ method: 'machine-1:bash' }` and
 * no machine id at all. A guard that only looked for a `machineId` field found
 * nothing to compare on exactly these two, which is the entire bypass: one
 * authenticated socket could register methods for every other machine on the
 * account.
 */
const METHOD_SCOPED_EVENTS: ReadonlySet<string> = new Set(['rpc-register', 'rpc-unregister']);

type ScopeCheck = { ok: true } | { ok: false; reason: 'foreign-machine' | 'malformed' };

/**
 * Whether an event stays inside this machine.
 *
 * Three answers, not two: a payload that names nothing is in scope (`ping`
 * carries nothing), a payload that names another machine is out, and a payload
 * that *should* name one but does not is malformed — which is refused rather
 * than read as "names nothing".
 */
function withinMachine(event: string, payload: unknown, machineId: string): ScopeCheck {
    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;

    if (METHOD_SCOPED_EVENTS.has(event)) {
        const method = record?.method;
        if (typeof method !== 'string') return { ok: false, reason: 'malformed' };
        // The separator is part of the comparison: `machine-11:bash` must not
        // pass as `machine-1`'s, and a name with no separator names nothing.
        const separator = method.indexOf(':');
        if (separator <= 0) return { ok: false, reason: 'malformed' };
        return method.slice(0, separator) === machineId
            ? { ok: true }
            : { ok: false, reason: 'foreign-machine' };
    }

    const named = record?.machineId;
    if (named === undefined) return { ok: true };
    if (typeof named !== 'string') return { ok: false, reason: 'malformed' };
    return named === machineId ? { ok: true } : { ok: false, reason: 'foreign-machine' };
}

export function installManagedDaemonSocketGuard(input: {
    socket: Pick<Socket, 'use' | 'disconnect'> & { data?: Record<string, unknown> };
    claims: ManagedDaemonClaims;
    /** The bearer this socket authenticated with; re-checked, never re-issued. */
    token: string;
    managedControl: ManagedControlRuntime;
    deps?: ManagedDaemonGuardDeps;
}): { dispose: () => void } {
    const deps = input.deps ?? {};
    const authorize = deps.authorize ?? authorizeManagedDaemonRequest;
    const now = deps.now ?? Date.now;
    const schedule = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    const cancel = deps.clearInterval ?? ((handle) => clearInterval(handle as never));

    const stillGranted = async (): Promise<boolean> => {
        try {
            const result = await authorize({
                token: input.token,
                issuer: input.managedControl.daemonTokens,
                machineId: input.claims.machineId,
                now: now(),
            });
            return result.ok;
        } catch {
            // A lookup that failed is not a grant that holds. Letting the
            // socket continue while the database is unreachable is a
            // revocation that stops working exactly when it matters.
            return false;
        }
    };

    input.socket.use((packet, next) => {
        const [event, payload] = packet as unknown as [string, unknown];
        void guard(event, payload, next);
    });

    async function guard(
        event: string,
        payload: unknown,
        next: (error?: Error) => void,
    ): Promise<void> {
        if (!MANAGED_DAEMON_SOCKET_EVENTS.has(event)) {
            next(new Error('event not available to a managed runtime'));
            return;
        }
        const scope = withinMachine(event, payload, input.claims.machineId);
        if (!scope.ok) {
            // The one that matters most: with the account's other machines
            // reachable by name, this is the difference between a runtime
            // credential and a fleet credential.
            next(new Error(scope.reason === 'foreign-machine'
                ? 'managed runtime may only address its own machine'
                : 'managed runtime event does not name a machine it may address'));
            return;
        }
        if (!await stillGranted()) {
            input.socket.disconnect(true);
            next(new Error('managed grant is no longer live'));
            return;
        }
        next();
    }

    const handle = schedule(() => {
        void stillGranted().then((live) => {
            if (!live) input.socket.disconnect(true);
        });
    }, deps.revalidateIntervalMs ?? 30_000);
    handle.unref?.();

    return { dispose: () => cancel(handle) };
}
