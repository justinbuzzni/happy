/**
 * Spawns a PTY-backed interactive shell on behalf of the web-ui remote
 * terminal panel. Mirrors startServer.ts's pure-utility shape — no logger,
 * no globals — so callers (apiMachine.ts terminal-* RPC, future
 * controlServer endpoints) can wire it into their own envelope shapes.
 *
 * Unlike startServer.ts the child stays alive under daemon supervision —
 * we hold the IPty handle so write/resize/kill can hit it. node-pty creates
 * the child as the leader of a fresh process group via setsid, so
 * `process.kill(-pid, signal)` reaches grandchildren too (e.g. the browser
 * launcher that `gh auth login` spawns). See specs/remote-terminal/.
 */

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export interface PtySessionOpts {
    userId: string
    shell?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
}

export interface PtySession {
    readonly id: string
    readonly userId: string
    readonly pid: number
    readonly cols: number
    readonly rows: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: NodeJS.Signals): void
    onData(cb: (chunk: string) => void): () => void
    onExit(cb: (code: number, signal: number | null) => void): () => void
}

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

export function createPtySession(opts: PtySessionOpts): PtySession {
    const id = randomUUID()
    const shell = opts.shell || process.env.SHELL || DEFAULT_SHELL
    const args = opts.args ?? ['-l']
    const cwd = opts.cwd || homedir()
    const env: { [key: string]: string } = { ...process.env, ...(opts.env ?? {}) } as { [key: string]: string }
    const initialCols = opts.cols ?? 80
    const initialRows = opts.rows ?? 24

    const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd,
        env,
    })

    const pid = child.pid
    let cols = initialCols
    let rows = initialRows

    return {
        id,
        userId: opts.userId,
        pid,
        get cols() { return cols },
        get rows() { return rows },
        write(data: string) {
            child.write(data)
        },
        resize(c: number, r: number) {
            cols = c
            rows = r
            child.resize(c, r)
        },
        kill(signal: NodeJS.Signals = 'SIGTERM') {
            // Process-group kill so backgrounded jobs (browser launcher
            // from `gh auth login`, npm subshells, etc.) are reaped along
            // with the shell. Falls back to single-process kill if the PG
            // is already gone (e.g. natural exit followed by explicit kill).
            try {
                process.kill(-pid, signal)
            } catch {
                try { child.kill(signal) } catch {/* already dead */ }
            }
        },
        onData(cb) {
            const sub = child.onData(cb)
            return () => sub.dispose()
        },
        onExit(cb) {
            const sub = child.onExit(({ exitCode, signal }) => {
                cb(exitCode, signal ?? null)
            })
            return () => sub.dispose()
        },
    }
}
