import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServerProcess } from './startServer'
import { stopServerProcess, StopServerError } from './stopServer'

function writeSleeper(dir: string, ms: number): string {
  const script = `setTimeout(() => process.exit(0), ${ms})`
  const p = path.join(dir, 'sleep.js')
  writeFileSync(p, script)
  return p
}

/** Trap SIGTERM so only SIGKILL will actually terminate this child. The
 *  setInterval keeps the event loop alive past the timeout — a plain
 *  setTimeout here has been observed to exit on SIGTERM under `detached:
 *  true` + `stdio: 'ignore'`, which defeats the fallback-path test. */
function writeTrappedSleeper(dir: string): string {
  const script = `
process.on('SIGTERM', () => { /* ignore */ })
setInterval(() => {}, 1000)
`
  const p = path.join(dir, 'trap.js')
  writeFileSync(p, script)
  return p
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('stopServerProcess', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  function mkdir(): string {
    const d = mkdtempSync(path.join(tmpdir(), 'stop-server-'))
    dirs.push(d)
    return d
  }

  it('rejects a non-positive / non-integer pid', async () => {
    await expect(stopServerProcess({ pid: 0 })).rejects.toMatchObject({
      name: 'StopServerError',
      code: 'INVALID_PID',
    })
    await expect(stopServerProcess({ pid: -1 })).rejects.toMatchObject({ code: 'INVALID_PID' })
    await expect(stopServerProcess({ pid: 1.5 })).rejects.toMatchObject({ code: 'INVALID_PID' })
  })

  it('rejects an unknown pid with NO_SUCH_PROCESS', async () => {
    // Pick a pid very unlikely to exist — we only need the ESRCH path.
    await expect(stopServerProcess({ pid: 0x7fff_ffff })).rejects.toBeInstanceOf(StopServerError)
    await expect(stopServerProcess({ pid: 0x7fff_ffff })).rejects.toMatchObject({
      code: 'NO_SUCH_PROCESS',
    })
  })

  it('gracefully terminates a well-behaved child with SIGTERM', async () => {
    const dir = mkdir()
    const script = writeSleeper(dir, 30_000)
    const { pid } = await startServerProcess({ command: `node ${script}`, cwd: dir })
    expect(isAlive(pid)).toBe(true)

    const result = await stopServerProcess({ pid }, { gracefulTimeoutMs: 2_000, pollMs: 50 })
    expect(result).toEqual({ stopped: true, sentSignal: 'SIGTERM' })
    // Give the kernel a tick to reap before asserting
    await sleep(50)
    expect(isAlive(pid)).toBe(false)
  })

  it('falls back to SIGKILL when the child ignores SIGTERM', async () => {
    const dir = mkdir()
    const script = writeTrappedSleeper(dir)
    const { pid } = await startServerProcess({ command: `node ${script}`, cwd: dir })
    expect(isAlive(pid)).toBe(true)

    // startServerProcess resolves on setImmediate/fastFailDelayMs, before
    // the child's `process.on('SIGTERM', ...)` line has necessarily
    // executed. Give the interpreter a short head start so SIGTERM
    // actually hits the registered handler instead of the default exit.
    await sleep(200)

    // Tight graceful window so the test doesn't block for the 5s default
    const result = await stopServerProcess({ pid }, { gracefulTimeoutMs: 500, pollMs: 50 })
    expect(result).toEqual({ stopped: true, sentSignal: 'SIGKILL' })
    await sleep(50)
    expect(isAlive(pid)).toBe(false)
  })
})
