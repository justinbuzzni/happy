/**
 * Whether a machine socket is a managed runtime's daemon, and on what terms.
 *
 * A managed daemon presents a credential of its **own purpose**, signed under a
 * different service from account bearers — so `auth.verifyToken` cannot verify
 * one, and asking it to would only produce a confusing failure. This decides
 * which of the two the handshake is, before either is trusted.
 *
 * Both checks happen on every connect, and both are load-bearing: the signature
 * says the token was issued here, and the grant row says it has not been
 * withdrawn or superseded since. A socket authenticated on the signature alone
 * outlives the withdrawal that was meant to end it.
 */
import type { ManagedDaemonClaims } from '@/app/auth/managedDaemonToken';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import {
    authorizeManagedDaemonRequest,
    type ManagedDaemonAccessResult,
} from '@/app/managed/managedDaemonAccess';

export type ManagedDaemonSocketHandshake = {
    token: string;
    clientType: string | undefined;
    machineId: string | undefined;
};

/**
 * `null` means "not a managed daemon connection" — including every failed
 * attempt to be one. The caller then runs the ordinary account verification,
 * which refuses a managed token anyway, so a rejected daemon never reaches a
 * socket by a second route.
 */
export async function authenticateManagedDaemonSocket(input: {
    handshake: ManagedDaemonSocketHandshake;
    managedControl: ManagedControlRuntime | null;
    now: number;
    /** Injected for tests; production uses the real authorizer. */
    authorize?: typeof authorizeManagedDaemonRequest;
}): Promise<ManagedDaemonClaims | null> {
    const { token, clientType, machineId } = input.handshake;
    // Only a machine socket can be a daemon, and only when the deployment has
    // managed control configured. Unconfigured is a deliberate off state, not a
    // reason to accept a token nobody can verify.
    if (clientType !== 'machine-scoped' || !machineId || !token || !input.managedControl) return null;

    let result: ManagedDaemonAccessResult;
    try {
        result = await (input.authorize ?? authorizeManagedDaemonRequest)({
            token,
            issuer: input.managedControl.daemonTokens,
            machineId,
            now: input.now,
        });
    } catch {
        // A grant lookup that failed is not a grant that holds. Reading the
        // error as "not a managed token" is correct: the ordinary path then
        // refuses it too.
        return null;
    }
    return result.ok ? result.principal.claims : null;
}
