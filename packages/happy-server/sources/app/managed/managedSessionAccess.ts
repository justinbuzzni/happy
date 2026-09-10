/**
 * Whether one HTTP request from a managed child is allowed.
 *
 * A single decision, in one place, for every route a child can reach. Four
 * routes each deciding for themselves is four chances to disagree, and the one
 * that disagrees is the one that gets used.
 *
 * Two independent checks, both required:
 *  - the request itself must be on the allowlist and name the granted session
 *    (`managedScopeAllowlist`), and
 *  - the grant behind the bearer must still be live, current and owned by the
 *    account the token claims (`resolveLiveGrant`).
 *
 * The allowlist runs first because it needs no database: a request for a route
 * a child may never reach is refused without a query.
 *
 * Nothing is cached. The grant is re-derived on every request, which is what
 * makes a revoke, an epoch advance, an attempt change, a cancellation or an
 * expiry take effect on the next call rather than at the end of some TTL.
 */

import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';
import {
    authorizeManagedHttpRequest,
    type ManagedScopeDenial,
} from '@/app/managed/managedScopeAllowlist';
import {
    resolveLiveGrant,
    type GrantCheckFailure,
    type LiveGrant,
} from '@/app/managed/managedSessionGrant';

export type ManagedAccessDenial = ManagedScopeDenial | GrantCheckFailure;

export type ManagedAccessResult =
    | { ok: true; grant: LiveGrant; claims: SessionScopedClaims }
    | { ok: false; reason: ManagedAccessDenial };

export async function authorizeManagedSessionRequest(input: {
    method: string;
    path: string;
    body: unknown;
    claims: SessionScopedClaims;
    now: number;
}): Promise<ManagedAccessResult> {
    const allowed = authorizeManagedHttpRequest({
        method: input.method,
        path: input.path,
        sessionId: input.claims.sessionId,
        body: input.body,
        // From the verified claims, which is the only place that says what this
        // bearer is for. Omitting it here made every read token authorise as a
        // runner — the write gate was open to exactly the bearers it was added
        // to keep out.
        purpose: input.claims.purpose,
    });
    if (!allowed.ok) return { ok: false, reason: allowed.reason };

    const grant = await resolveLiveGrant({ claims: input.claims, now: input.now });
    if (!grant.ok) return { ok: false, reason: grant.reason };

    return { ok: true, grant: grant.grant, claims: input.claims };
}
