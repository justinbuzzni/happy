/**
 * Spawns a dev server process on behalf of the web-ui `/api/start-server`
 * route when the session is routed to this (remote) machine. Mirrors the
 * local vite-host spawn in packages/web-ui/vite.config.ts — shell-less,
 * detached, stdio ignored, `child.unref()` so the process survives the
 * daemon's lifetime. The daemon does not attempt to manage stdout/stderr;
 * the caller owns reachability checks over the remote-preview relay.
 *
 * Pure utility: no logger, no globals. controlServer.ts wires this into
 * its HTTP endpoint and apiMachine.ts wires it into the `start-server`
 * RPC. See specs/remote-server-start/ Phase 3 and
 * specs/start-server-process-tracking/ for the spawn rationale.
 */

import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tokenizeCommand } from './tokenizeCommand'

export type StartServerErrorCode =
  | 'CWD_NOT_FOUND'
  | 'INVALID_COMMAND'
  | 'EXEC_NOT_FOUND'
  | 'SPAWN_FAILED'

export class StartServerError extends Error {
  public readonly code: StartServerErrorCode
  constructor(code: StartServerErrorCode, message: string) {
    super(message)
    this.name = 'StartServerError'
    this.code = code
  }
}

export interface StartServerRequest {
  command: string
  cwd: string
  env?: Record<string, string>
}

export interface StartServerResult {
  pid: number
}

export interface StartServerOptions {
  /** Delay before treating the spawn as "did not fail fast" and resolving. Defaults to one microtask tick. */
  fastFailDelayMs?: number
  /** Hook so controlServer / apiMachine can track the child for future stop-server RPCs. */
  onSpawn?: (child: ChildProcess) => void
}

/**
 * Returns the pid of the spawned process, or rejects with a
 * `StartServerError` carrying a stable machine-readable code so callers
 * can translate to HTTP status / RPC envelope shapes.
 */
export function startServerProcess(
  req: StartServerRequest,
  opts: StartServerOptions = {},
): Promise<StartServerResult> {
  if (!existsSync(req.cwd)) {
    return Promise.reject(
      new StartServerError('CWD_NOT_FOUND', `Directory not found: ${req.cwd}`),
    )
  }
  let argv: [string, ...string[]]
  try {
    argv = tokenizeCommand(req.command)
  } catch (e) {
    return Promise.reject(
      new StartServerError('INVALID_COMMAND', (e as Error).message),
    )
  }
  const [cmd, ...args] = argv

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: req.cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...(req.env ?? {}) },
      })
    } catch (e) {
      reject(new StartServerError('SPAWN_FAILED', (e as Error).message))
      return
    }
    // Let the child outlive the daemon event loop reference — matches the
    // web-ui vite handler.
    child.unref()
    opts.onSpawn?.(child)

    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    // ENOENT surfaces asynchronously on Node's ChildProcess 'error' event
    // when the executable is not on PATH. Treat that as a synchronous
    // EXEC_NOT_FOUND for the caller.
    child.once('error', (err: NodeJS.ErrnoException) => {
      const code: StartServerErrorCode = err.code === 'ENOENT' ? 'EXEC_NOT_FOUND' : 'SPAWN_FAILED'
      settle(() => reject(new StartServerError(code, err.message)))
    })

    const claim = () => {
      if (!child.pid) {
        settle(() => reject(new StartServerError('SPAWN_FAILED', 'no pid assigned')))
        return
      }
      settle(() => resolve({ pid: child.pid! }))
    }
    if (opts.fastFailDelayMs && opts.fastFailDelayMs > 0) {
      setTimeout(claim, opts.fastFailDelayMs)
    } else {
      setImmediate(claim)
    }
  })
}
