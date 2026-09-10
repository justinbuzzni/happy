/**
 * Keeping a managed runtime's credential current, and stopping when it is not.
 *
 * The daemon's bearer is short-lived on purpose: it is a credential handed to a
 * process that runs code the customer's agent can influence, and a long one
 * would keep working long after the parent decided this runtime should stop.
 * The parent renews it by rewriting the protected record; this watches that
 * record and does two things with what it finds.
 *
 *  - A **new** credential for the same Machine replaces the one the socket will
 *    present next. It does not tear down the live socket: that socket
 *    authenticated when it opened, and dropping it to apply a token it does not
 *    need would interrupt work that is running.
 *  - An **expired** one — nothing renewed it in time — stops the machine
 *    socket. Not retried, not degraded: a runtime that kept reconnecting with a
 *    dead credential looks like a network fault to everyone watching, while the
 *    real answer is that this runtime is no longer authorised.
 *
 * A credential naming a **different Machine** is never adopted. The marker says
 * which Machine this runtime is; a record disagreeing with it is a record about
 * something else, and taking it would publish this runtime's readiness on
 * somebody else's address.
 */
import {
    readManagedDaemonCredential,
    type ManagedDaemonCredentialOutcome,
} from '@/daemon/managedDaemonCredential';
import { defaultProvisioningDeps, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

export type ManagedCredentialWatchAction =
    /** Nothing changed and the credential still holds. */
    | { kind: 'unchanged' }
    /** A renewal arrived: present this token on the next connection. */
    | { kind: 'renewed'; token: string; expiresAt: number }
    /** It is over: stop the socket rather than reconnecting with a dead bearer. */
    | { kind: 'stop'; reason: 'expired' | 'withdrawn' | 'wrong-machine' };

export function decideManagedCredentialAction(input: {
    current: { token: string; expiresAt: number };
    /** Now, judged against the credential in hand — not only against the record. */
    now: number;
    latest: ManagedDaemonCredentialOutcome;
}): ManagedCredentialWatchAction {
    // The credential this process is actually using has its own deadline, and
    // it holds whatever the record says. Reading the record is how a renewal or
    // a withdrawal is noticed; it is not what keeps the bearer alive.
    const held = input.now < input.current.expiresAt;
    if (!input.latest.ok) {
        /*
         * Three failures, one of which is not "stop yet".
         *
         */
        /*
         * `unusable` is a record that cannot be read — a partial write, or one
         * being replaced right now. That is a reason to keep using what we
         * hold, but **only while what we hold is still valid**: a record that
         * stays unreadable would otherwise keep a runtime alive on a dead
         * bearer indefinitely, with every server call failing in a way that
         * looks like a network fault.
         */
        if (input.latest.reason === 'unusable') {
            return held ? { kind: 'unchanged' } : { kind: 'stop', reason: 'expired' };
        }
        if (input.latest.reason === 'wrong-machine') return { kind: 'stop', reason: 'wrong-machine' };
        // `absent` is the record having been removed under a running daemon:
        // the parent withdrew it. `expired` is nobody renewing in time.
        return {
            kind: 'stop',
            reason: input.latest.reason === 'absent' ? 'withdrawn' : 'expired',
        };
    }
    const credential = input.latest.credential;
    if (credential.token === input.current.token) return { kind: 'unchanged' };
    return { kind: 'renewed', token: credential.token, expiresAt: credential.expiresAt };
}

export function readManagedCredentialAction(input: {
    stateDir: string;
    expectedMachineId: string;
    current: { token: string; expiresAt: number };
    now: number;
    deps?: ManagedProvisioningDeps;
}): ManagedCredentialWatchAction {
    return decideManagedCredentialAction({
        current: input.current,
        now: input.now,
        latest: readManagedDaemonCredential({
            stateDir: input.stateDir,
            expectedMachineId: input.expectedMachineId,
            now: input.now,
            deps: input.deps ?? defaultProvisioningDeps,
        }),
    });
}
