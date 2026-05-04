/**
 * In-memory registry of active terminal relay sessions on this happy-server
 * process. Server-side state for specs/remote-terminal/ Phase 2 — the
 * server is a thin routing layer between the client (web-ui xterm panel)
 * and the daemon (PTY on the user's machine). Payloads are E2EE between
 * the endpoints; this module only tracks the socket pair routing.
 *
 * Pure data structure module — no socket.io coupling beyond the Socket
 * type. terminalRelayHandler.ts uses these helpers to resolve sessionId
 * to its socket pair and to enforce per-user concurrency caps.
 */

import { Socket } from 'socket.io';

export const MAX_TERMINALS_PER_USER = 5;

export interface TerminalSession {
    id: string;
    userId: string;
    machineId: string;
    clientSocket: Socket;
    daemonSocket: Socket;
    createdAt: number;
}

const sessions = new Map<string, TerminalSession>();

export function addTerminalSession(session: TerminalSession): void {
    sessions.set(session.id, session);
}

export function getTerminalSession(id: string | undefined | null): TerminalSession | null {
    if (!id) return null;
    return sessions.get(id) ?? null;
}

export function removeTerminalSession(id: string): boolean {
    return sessions.delete(id);
}

export function findTerminalSessionsBySocket(socket: Socket): TerminalSession[] {
    const out: TerminalSession[] = [];
    for (const s of sessions.values()) {
        if (s.clientSocket === socket || s.daemonSocket === socket) {
            out.push(s);
        }
    }
    return out;
}

export function countActiveSessionsForUser(userId: string): number {
    let n = 0;
    for (const s of sessions.values()) {
        if (s.userId === userId) n++;
    }
    return n;
}

/** Test-only — clears the module-scoped session map between tests. */
export function _resetTerminalSessionsForTest(): void {
    sessions.clear();
}
