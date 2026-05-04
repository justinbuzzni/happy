/**
 * Per-daemon registry of active PTY-backed terminal sessions
 * (specs/remote-terminal/ Phase 2 + Phase 5). Holds the mapping between
 * server-issued sessionId and the local PtySession, plus the bookkeeping
 * needed for the audit log (openedAt, bytesIn/Out) and the idle-timeout
 * watchdog (Phase 5).
 *
 * Pure data-structure module — no socket.io / api coupling. apiMachine.ts
 * uses these helpers to plumb socket events into PtySession actions and
 * to record activity for the idle timer.
 */

import { type PtySession } from './remoteTerminal'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

export interface DaemonTerminalEntry {
    readonly id: string
    readonly session: PtySession
    readonly userId: string
    readonly machineId: string | null
    readonly openedAt: number
    bytesIn: number
    bytesOut: number
    /** Last in/out activity wallclock ms — drives the idle timer reset. */
    lastActivityAt: number
}

interface InternalEntry extends DaemonTerminalEntry {
    _idleTimeoutMs: number
    _idleTimer: ReturnType<typeof setTimeout> | null
}

export interface AddSessionOptions {
    userId: string
    machineId?: string | null
    /** ms with no in/out activity before SIGHUP. Defaults to 15 min. Pass 0 to disable. */
    idleTimeoutMs?: number
}

const sessions = new Map<string, InternalEntry>()

function clearIdleTimer(entry: InternalEntry): void {
    if (entry._idleTimer) {
        clearTimeout(entry._idleTimer)
        entry._idleTimer = null
    }
}

function armIdleTimer(entry: InternalEntry): void {
    clearIdleTimer(entry)
    if (entry._idleTimeoutMs <= 0) return
    entry._idleTimer = setTimeout(() => {
        // Trust pty.onExit to fire and remove the entry from the map; if
        // the kill races with a manual close, removeDaemonTerminalSession
        // is idempotent.
        try { entry.session.kill('SIGHUP') } catch {/* already gone */ }
    }, entry._idleTimeoutMs)
}

export function addDaemonTerminalSession(
    id: string,
    session: PtySession,
    opts: AddSessionOptions,
): DaemonTerminalEntry {
    const now = Date.now()
    const entry: InternalEntry = {
        id,
        session,
        userId: opts.userId,
        machineId: opts.machineId ?? null,
        openedAt: now,
        bytesIn: 0,
        bytesOut: 0,
        lastActivityAt: now,
        _idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        _idleTimer: null,
    }
    sessions.set(id, entry)
    armIdleTimer(entry)
    return entry
}

export function getDaemonTerminalSession(id: string | undefined | null): DaemonTerminalEntry | null {
    if (!id) return null
    return sessions.get(id) ?? null
}

export function removeDaemonTerminalSession(id: string): boolean {
    const entry = sessions.get(id)
    if (!entry) return false
    clearIdleTimer(entry)
    return sessions.delete(id)
}

export function killAllDaemonTerminalSessions(signal: NodeJS.Signals = 'SIGTERM'): number {
    let killed = 0
    for (const [id, entry] of sessions) {
        clearIdleTimer(entry)
        try {
            entry.session.kill(signal)
            killed++
        } catch {
            /* already dead */
        }
        sessions.delete(id)
    }
    return killed
}

/**
 * Record bytes flowing client → PTY (stdin). Increments the in counter
 * and resets the idle timer. No-op if the session is no longer registered.
 */
export function recordBytesIn(id: string, n: number): void {
    const entry = sessions.get(id)
    if (!entry || n <= 0) return
    entry.bytesIn += n
    entry.lastActivityAt = Date.now()
    armIdleTimer(entry)
}

/**
 * Record bytes flowing PTY → client (stdout/stderr). Increments the out
 * counter and resets the idle timer. No-op if the session is no longer
 * registered.
 */
export function recordBytesOut(id: string, n: number): void {
    const entry = sessions.get(id)
    if (!entry || n <= 0) return
    entry.bytesOut += n
    entry.lastActivityAt = Date.now()
    armIdleTimer(entry)
}

export function _resetDaemonTerminalSessionsForTest(): void {
    for (const entry of sessions.values()) {
        clearIdleTimer(entry)
    }
    sessions.clear()
}
