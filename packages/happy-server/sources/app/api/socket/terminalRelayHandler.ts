/**
 * Server-side relay for the remote terminal feature
 * (specs/remote-terminal/ Phase 2). Forwards opaque, end-to-end-encrypted
 * frames between the client (web-ui xterm panel) and the daemon (PTY on
 * the user's machine). The server never sees plaintext stdin/stdout — the
 * `data` field of every frame is encrypted at the originating endpoint
 * with the user's existing rpc-call secret key.
 *
 * Wire shape:
 *   client → server: 'terminal-open'   { machineId, params }, ack
 *   server → daemon: 'terminal-open-fwd' { sessionId, params }, ack
 *   client → server: 'terminal-frame'  { sessionId, data }
 *   client → server: 'terminal-resize' { sessionId, cols, rows }
 *   client → server: 'terminal-close'  { sessionId }
 *   daemon → server: 'terminal-frame'  { sessionId, data }
 *   daemon → server: 'terminal-closed' { sessionId, code, signal }
 *
 * The same handler is registered on every socket; direction is inferred
 * from whether the originating socket matches `clientSocket` or
 * `daemonSocket` of the resolved session.
 *
 * ACL: terminal-open succeeds only if the caller's userId already has a
 * machine-scoped daemon socket connected for the requested machineId.
 * This is the same trust boundary as today's rpc-call routing — a
 * different user's terminal request lands at "Machine not connected for
 * this user" and never reaches the daemon.
 */

import { Socket } from 'socket.io';
import { eventRouter } from '@/app/events/eventRouter';
import { log } from '@/utils/log';
import { randomUUID } from 'node:crypto';
import {
    addTerminalSession,
    getTerminalSession,
    removeTerminalSession,
    findTerminalSessionsBySocket,
    countActiveSessionsForUser,
    MAX_TERMINALS_PER_USER,
} from './terminalSessions';

const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

// TODO(post-Phase-2): factor out — duplicated from previewRoutes.ts.
function findMachineSocket(userId: string, machineId: string): Socket | null {
    const connections = eventRouter.getConnections(userId);
    if (!connections) return null;
    for (const c of connections) {
        if (c.connectionType === 'machine-scoped' && c.machineId === machineId) {
            return c.socket;
        }
    }
    return null;
}

export function terminalRelayHandler(userId: string, socket: Socket): void {
    socket.on('terminal-open', async (data: any, ack?: (response: any) => void) => {
        const reply = (resp: any) => { if (typeof ack === 'function') ack(resp); };
        try {
            const machineId = data?.machineId;
            if (!machineId || typeof machineId !== 'string') {
                reply({ ok: false, error: 'machineId is required' });
                return;
            }

            if (countActiveSessionsForUser(userId) >= MAX_TERMINALS_PER_USER) {
                reply({ ok: false, error: 'Too many active terminals' });
                return;
            }

            const daemonSocket = findMachineSocket(userId, machineId);
            if (!daemonSocket) {
                reply({ ok: false, error: 'Machine not connected for this user' });
                return;
            }

            const sessionId = randomUUID();
            let daemonAck: unknown;
            try {
                daemonAck = await daemonSocket
                    .timeout(TERMINAL_OPEN_TIMEOUT_MS)
                    .emitWithAck('terminal-open-fwd', {
                        sessionId,
                        params: data?.params ?? null,
                    });
            } catch (err) {
                log({ module: 'terminal-relay', level: 'error' }, `terminal-open-fwd timeout: ${(err as Error).message}`);
                reply({ ok: false, error: 'Daemon did not acknowledge terminal-open in time' });
                return;
            }

            const ackResp = daemonAck as { ok?: boolean; error?: string } | null | undefined;
            if (!ackResp || ackResp.ok !== true) {
                reply({ ok: false, error: ackResp?.error ?? 'Daemon failed to open terminal' });
                return;
            }

            addTerminalSession({
                id: sessionId,
                userId,
                machineId,
                clientSocket: socket,
                daemonSocket,
                createdAt: Date.now(),
            });
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] open user=${userId} machine=${machineId} session=${sessionId}`);
            reply({ ok: true, sessionId });
        } catch (e) {
            log({ module: 'terminal-relay', level: 'error' }, `terminal-open error: ${(e as Error).message}`);
            reply({ ok: false, error: 'Internal error' });
        }
    });

    socket.on('terminal-frame', (data: any) => {
        const session = getTerminalSession(data?.sessionId);
        if (!session) return;
        // Direction is inferred from the source socket. Drop frames whose
        // source is not part of the session pair — defends against a
        // confused-deputy where a third socket guesses a sessionId.
        if (socket === session.clientSocket) {
            session.daemonSocket.emit('terminal-frame-fwd', {
                sessionId: session.id,
                data: data?.data,
            });
        } else if (socket === session.daemonSocket) {
            session.clientSocket.emit('terminal-frame', {
                sessionId: session.id,
                data: data?.data,
            });
        }
    });

    socket.on('terminal-resize', (data: any) => {
        const session = getTerminalSession(data?.sessionId);
        if (!session || socket !== session.clientSocket) return;
        const cols = Number(data?.cols);
        const rows = Number(data?.rows);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
        session.daemonSocket.emit('terminal-resize-fwd', {
            sessionId: session.id,
            cols,
            rows,
        });
    });

    socket.on('terminal-close', (data: any) => {
        const session = getTerminalSession(data?.sessionId);
        if (!session) return;
        if (socket !== session.clientSocket && socket !== session.daemonSocket) return;
        if (socket === session.clientSocket) {
            session.daemonSocket.emit('terminal-close-fwd', { sessionId: session.id });
        }
        removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (explicit)`);
    });

    socket.on('terminal-closed', (data: any) => {
        // Daemon-originated close (PTY exited).
        const session = getTerminalSession(data?.sessionId);
        if (!session || socket !== session.daemonSocket) return;
        session.clientSocket.emit('terminal-closed', {
            sessionId: session.id,
            code: data?.code,
            signal: data?.signal,
        });
        removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} exit=${data?.code} signal=${data?.signal}`);
    });

    socket.on('disconnect', () => {
        const sessions = findTerminalSessionsBySocket(socket);
        if (sessions.length === 0) return;
        for (const session of sessions) {
            try {
                if (socket === session.clientSocket) {
                    session.daemonSocket.emit('terminal-close-fwd', { sessionId: session.id });
                } else if (socket === session.daemonSocket) {
                    session.clientSocket.emit('terminal-closed', {
                        sessionId: session.id,
                        code: -1,
                        signal: null,
                        reason: 'daemon-disconnected',
                    });
                }
            } catch {
                /* ignore — counterpart socket may also be tearing down */
            }
            removeTerminalSession(session.id);
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (socket disconnect)`);
        }
    });
}
