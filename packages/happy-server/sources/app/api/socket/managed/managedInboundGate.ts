/**
 * What a managed child is allowed to send.
 *
 * The allowlist itself lives in `managedScopeAllowlist`, shared with the HTTP
 * surface so the two cannot drift. This adds what is specific to a socket: the
 * grant is re-read for every inbound event, and `rpc-call` is refused outright.
 *
 * `rpc-call` is refused whatever session it names, including the child's own.
 * A child provides handlers; it does not invoke them. The dispatcher resolves a
 * method to a room across the whole cluster, so a caller that reaches it can
 * address any registered method on the account — a session id in the string is
 * an argument, not a boundary.
 *
 * `rpc-register` and `rpc-unregister` are accepted only for `${sessionId}:name`
 * where the session is exactly the granted one and the name is on the list.
 * Registration is recorded in the managed registry rather than by joining a
 * room, so a name a child claims can never make it a member of anything.
 */

import {
    authorizeManagedRpcName,
    authorizeManagedSocketEvent,
} from '@/app/managed/managedScopeAllowlist';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

export type ManagedInboundDenial =
    | 'event-not-allowed'
    | 'session-mismatch'
    | 'rpc-name-not-allowed'
    | 'rpc-name-malformed'
    | 'capability-not-supported'
    | 'rpc-call-not-permitted'
    | 'grant-invalid'
    | 'authority-unavailable';

export type ManagedInboundDecision =
    | { ok: true }
    | { ok: false; reason: ManagedInboundDenial };

/** Events a managed socket may never send, whatever they name. */
const REFUSED_EVENTS: ReadonlySet<string> = new Set(['rpc-call']);

export type ManagedGrantProbe = () => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * Decides one inbound event.
 *
 * The grant is checked last and only for events that got past the shape rules,
 * so a refused event costs no database read — and, more importantly, a valid
 * grant is never the thing that makes an unlisted event acceptable.
 */
export async function authorizeManagedInbound(input: {
    event: string;
    payload: unknown;
    claims: SessionScopedClaims;
    checkGrant: ManagedGrantProbe;
}): Promise<ManagedInboundDecision> {
    if (REFUSED_EVENTS.has(input.event)) {
        return { ok: false, reason: 'rpc-call-not-permitted' };
    }

    const shape = authorizeManagedSocketEvent({
        event: input.event,
        payload: input.payload,
        sessionId: input.claims.sessionId,
        purpose: input.claims.purpose,
    });
    if (!shape.ok) {
        return { ok: false, reason: shape.reason as ManagedInboundDenial };
    }

    if (input.event === 'rpc-register' || input.event === 'rpc-unregister') {
        const method = (input.payload as { method?: unknown } | null)?.method;
        if (typeof method !== 'string') return { ok: false, reason: 'rpc-name-malformed' };
        const named = authorizeManagedRpcName({
            method,
            sessionId: input.claims.sessionId,
            purpose: input.claims.purpose,
        });
        if (!named.ok) return { ok: false, reason: named.reason as ManagedInboundDenial };
    }

    let grant: { ok: true } | { ok: false; reason: string };
    try {
        grant = await input.checkGrant();
    } catch {
        return { ok: false, reason: 'authority-unavailable' };
    }
    if (!grant.ok) return { ok: false, reason: 'grant-invalid' };

    return { ok: true };
}
