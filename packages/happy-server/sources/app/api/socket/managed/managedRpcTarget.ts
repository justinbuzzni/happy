/**
 * Whether an RPC method belongs to a managed session.
 *
 * RPC methods are addressed as `${sessionId}:${name}`, and the caller is an
 * account client that cannot know — and must not decide — how the session on
 * the other end is run. This answers that from the database.
 *
 * The answer is durable, not "is a managed socket connected right now". A
 * session that has ever had a managed grant stays managed: revoking the grant,
 * or the child going offline, must not make the same method fall back to the
 * legacy room. That fallback is the whole risk — the legacy room is joined by
 * name, so anything that registered `${sessionId}:permission` would inherit a
 * withdrawn child's traffic the moment the child stopped answering.
 *
 * A short cache is safe here precisely because the answer only ever moves in
 * one direction: a session becomes managed once and never becomes unmanaged.
 * A stale "managed" is still correct, and a stale "not managed" expires.
 */

import { db } from '@/storage/db';

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;

/** Only positive answers are remembered; see the note above on direction. */
const managedSessions = new Map<string, number>();

export function splitRpcMethod(method: string): { sessionId: string; name: string } | null {
    const separator = method.indexOf(':');
    if (separator <= 0) return null;
    const sessionId = method.slice(0, separator);
    const name = method.slice(separator + 1);
    if (name.length === 0) return null;
    return { sessionId, name };
}

export async function isManagedSessionId(sessionId: string): Promise<boolean> {
    const cachedUntil = managedSessions.get(sessionId);
    if (cachedUntil !== undefined && cachedUntil > Date.now()) return true;

    const row = await db.managedSessionGrant.findFirst({
        where: { sessionId },
        select: { grantId: true },
    });
    if (!row) return false;

    if (managedSessions.size >= MAX_CACHE_ENTRIES) managedSessions.clear();
    managedSessions.set(sessionId, Date.now() + CACHE_TTL_MS);
    return true;
}

/** Test seam: the cache is process-wide and would otherwise leak between cases. */
export function resetManagedSessionCache(): void {
    managedSessions.clear();
}
