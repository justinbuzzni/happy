/**
 * Graceful stop for a dev server spawned by `startServerProcess`. SIGTERM
 * first; if the child is still alive after `gracefulTimeoutMs`, follow up
 * with SIGKILL. Does not touch the port registry — project stickiness
 * survives so the next spawn reuses the same port.
 *
 * Mirrors `startServer.ts` in spirit: pure utility, no logger, no globals.
 * controlServer.ts wires this to `POST /stop-server` and apiMachine.ts
 * wires it to the `${mid}:stop-server` RPC. See
 * specs/preview-server-lifecycle/ Phase 5a.
 */

import { setTimeout as sleep } from 'node:timers/promises'

export type StopServerErrorCode =
  | 'INVALID_PID'
  | 'NO_SUCH_PROCESS'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'INTERNAL'

export class StopServerError extends Error {
  public readonly code: StopServerErrorCode
  constructor(code: StopServerErrorCode, message: string) {
    super(message)
    this.name = 'StopServerError'
    this.code = code
  }
}

export interface StopServerRequest {
  pid: number
}

export interface StopServerResult {
  stopped: true
  sentSignal: 'SIGTERM' | 'SIGKILL'
}

export interface StopServerOptions {
  /** Total window between SIGTERM and the SIGKILL fallback. Default 5s. */
  gracefulTimeoutMs?: number
  /** Poll interval when waiting for the process to exit. Default 100 ms. */
  pollMs?: number
  /** Injected for tests. Default is `process.kill`. */
  kill?: (pid: number, signal: number | string) => void
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000
const DEFAULT_POLL_MS = 100

export async function stopServerProcess(
  req: StopServerRequest,
  opts: StopServerOptions = {},
): Promise<StopServerResult> {
  const { pid } = req
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new StopServerError('INVALID_PID', `Invalid pid: ${pid}`)
  }
  const kill = opts.kill ?? ((p: number, s: number | string) => process.kill(p, s))
  const gracefulTimeoutMs = opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS

  const isAlive = (): boolean => {
    try {
      kill(pid, 0)
      return true
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ESRCH') return false
      // EPERM means the process exists but we cannot signal — still "alive"
      return true
    }
  }

  if (!isAlive()) {
    throw new StopServerError('NO_SUCH_PROCESS', `No process with pid ${pid}`)
  }

  try {
    kill(pid, 'SIGTERM')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EPERM') {
      throw new StopServerError('PERMISSION_DENIED', `Permission denied for pid ${pid}`)
    }
    if (err.code === 'ESRCH') {
      // Process died between the alive-check and the signal — still a success.
      return { stopped: true, sentSignal: 'SIGTERM' }
    }
    throw new StopServerError('INTERNAL', err.message)
  }

  const start = Date.now()
  while (Date.now() - start < gracefulTimeoutMs) {
    if (!isAlive()) return { stopped: true, sentSignal: 'SIGTERM' }
    await sleep(pollMs)
  }

  try {
    kill(pid, 'SIGKILL')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ESRCH') {
      // Exited on its own between SIGTERM and SIGKILL.
      return { stopped: true, sentSignal: 'SIGTERM' }
    }
    throw new StopServerError('INTERNAL', err.message)
  }

  await sleep(pollMs)
  if (isAlive()) {
    throw new StopServerError('TIMEOUT', `Process ${pid} did not exit after SIGKILL`)
  }
  return { stopped: true, sentSignal: 'SIGKILL' }
}
