/**
 * Where this replica's managed sockets are, and nowhere else.
 *
 * Managed sockets deliberately join none of the legacy rooms. `user:${userId}`,
 * `user:${userId}:user-scoped` and `user:${userId}:session:${sid}` are the
 * fan-out surface for account clients, and a managed socket in any of them
 * would receive whatever is emitted there — before any grant is consulted,
 * because room delivery happens inside the adapter. Membership is not something
 * that can be re-checked at the last moment; the only way to keep the check is
 * to never be a member.
 *
 * So routing to a managed child is explicit: look it up here, and hand the
 * packet to its channel. A session with no managed socket on this replica is
 * simply absent, which is what lets the caller decide between a relay and a
 * refusal rather than having the adapter silently do neither.
 */

import type { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';

export type ManagedSocketEntry = {
    /** Socket.IO id, unique per connection. */
    socketId: string;
    accountId: string;
    sessionId: string;
    grantId: string;
    runId: string;
    attemptId: string;
    channel: ManagedOutboundChannel;
    /** RPC names this socket has registered, without the `${sessionId}:` prefix. */
    rpcNames: Set<string>;
    connectedAt: number;
};

export class ManagedSocketRegistry {
    private bySocketId = new Map<string, ManagedSocketEntry>();
    private bySessionId = new Map<string, Set<string>>();

    add(entry: ManagedSocketEntry): void {
        this.bySocketId.set(entry.socketId, entry);
        let ids = this.bySessionId.get(entry.sessionId);
        if (!ids) {
            ids = new Set();
            this.bySessionId.set(entry.sessionId, ids);
        }
        ids.add(entry.socketId);
    }

    remove(socketId: string): void {
        const entry = this.bySocketId.get(socketId);
        if (!entry) return;
        this.bySocketId.delete(socketId);
        const ids = this.bySessionId.get(entry.sessionId);
        if (!ids) return;
        ids.delete(socketId);
        if (ids.size === 0) this.bySessionId.delete(entry.sessionId);
    }

    get(socketId: string): ManagedSocketEntry | undefined {
        return this.bySocketId.get(socketId);
    }

    /**
     * Every managed socket for a session on this replica.
     *
     * More than one is normal and transient: a reconnect leaves the previous
     * socket present until engine.io gives up on it.
     */
    forSession(sessionId: string): ManagedSocketEntry[] {
        const ids = this.bySessionId.get(sessionId);
        if (!ids) return [];
        const entries: ManagedSocketEntry[] = [];
        for (const id of ids) {
            const entry = this.bySocketId.get(id);
            if (entry) entries.push(entry);
        }
        return entries;
    }

    /** Sockets on this replica that registered a given RPC name for a session. */
    forRpc(sessionId: string, rpcName: string): ManagedSocketEntry[] {
        return this.forSession(sessionId).filter((entry) => entry.rpcNames.has(rpcName));
    }

    get size(): number {
        return this.bySocketId.size;
    }

    clear(): void {
        this.bySocketId.clear();
        this.bySessionId.clear();
    }
}

/** One registry per process, holding only the sockets this replica terminates. */
export const managedSocketRegistry = new ManagedSocketRegistry();
