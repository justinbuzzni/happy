import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPortRegistry } from './portRegistry'
import { startDaemonControlServer } from './controlServer'

describe('controlServer port allocation endpoints', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => false,
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const allocate = async (projectId: string) => {
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
    return { status: res.status, body: (await res.json()) as { port?: number; reused?: boolean; error?: string } }
  }

  const release = async (projectId: string) => {
    const res = await fetch(`${baseUrl}/release-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
    return { status: res.status, body: (await res.json()) as { released?: boolean } }
  }

  const list = async () => {
    const res = await fetch(`${baseUrl}/port-registry`)
    return { status: res.status, body: (await res.json()) as { entries: Array<{ projectId: string; port: number; allocatedAt: number }> } }
  }

  it('POST /allocate-port returns a fresh port for a new projectId', async () => {
    const { status, body } = await allocate('proj-a')
    expect(status).toBe(200)
    expect(body.port).toBe(30000)
    expect(body.reused).toBe(false)
  })

  it('POST /allocate-port returns the same port when the projectId repeats', async () => {
    const first = await allocate('proj-a')
    const second = await allocate('proj-a')
    expect(second.body.port).toBe(first.body.port)
    expect(second.body.reused).toBe(true)
  })

  it('POST /allocate-port assigns distinct ports to different projectIds', async () => {
    const a = await allocate('proj-a')
    const b = await allocate('proj-b')
    expect(a.body.port).not.toBe(b.body.port)
  })

  it('GET /port-registry exposes all current allocations', async () => {
    await allocate('proj-a')
    await allocate('proj-b')
    const { status, body } = await list()
    expect(status).toBe(200)
    const ids = body.entries.map((e) => e.projectId).sort()
    expect(ids).toEqual(['proj-a', 'proj-b'])
    for (const entry of body.entries) {
      expect(entry.port).toBeGreaterThanOrEqual(30000)
      expect(entry.allocatedAt).toBeGreaterThan(0)
    }
  })

  it('POST /release-port removes an existing entry', async () => {
    await allocate('proj-a')
    const { status, body } = await release('proj-a')
    expect(status).toBe(200)
    expect(body.released).toBe(true)
    const registry = await list()
    expect(registry.body.entries.find((e) => e.projectId === 'proj-a')).toBeUndefined()
  })

  it('POST /release-port returns released=false for unknown projectId', async () => {
    const { body } = await release('ghost')
    expect(body.released).toBe(false)
  })

  it('POST /allocate-port validates projectId is a non-empty string', async () => {
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('controlServer port allocation — range exhaustion', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30001,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => false,
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 503 when the range is exhausted', async () => {
    await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'a' }),
    })
    await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'b' }),
    })
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'c' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/No available port/)
  })
})
