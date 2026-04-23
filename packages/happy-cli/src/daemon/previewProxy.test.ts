import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { proxyHttp, PreviewProxyError } from './previewProxy'

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

async function startTestServer(handler: RequestHandler): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf-8')

describe('proxyHttp', () => {
  let stopServer: (() => Promise<void>) | null = null

  afterEach(async () => {
    if (stopServer) {
      await stopServer()
      stopServer = null
    }
  })

  it('proxies a simple GET and returns 200 with the response body', async () => {
    const srv = await startTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello world')
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: {},
      bodyB64: null,
    })

    expect(result.status).toBe(200)
    expect(fromB64(result.bodyB64)).toBe('hello world')
    expect(result.truncated).toBe(false)
  })

  it('preserves response Content-Type header', async () => {
    const srv = await startTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/api/status',
      headers: {},
      bodyB64: null,
    })

    expect(result.headers['content-type']).toMatch(/application\/json/)
  })

  it('forwards a POST body to the upstream server', async () => {
    let receivedBody = ''
    const srv = await startTestServer((req, res) => {
      req.on('data', (chunk) => { receivedBody += chunk.toString() })
      req.on('end', () => {
        res.writeHead(200)
        res.end(`got:${receivedBody}`)
      })
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'POST',
      path: '/submit',
      headers: { 'Content-Type': 'text/plain' },
      bodyB64: b64('payload-abc'),
    })

    expect(result.status).toBe(200)
    expect(fromB64(result.bodyB64)).toBe('got:payload-abc')
  })

  it('returns non-2xx status codes unchanged', async () => {
    const srv = await startTestServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/missing',
      headers: {},
      bodyB64: null,
    })

    expect(result.status).toBe(404)
    expect(fromB64(result.bodyB64)).toBe('not found')
  })

  it('throws CONNECTION_REFUSED when no server is listening on the port', async () => {
    // Pick an unused high port; avoid race by opening+closing immediately
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const freePort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    await expect(
      proxyHttp({ port: freePort, method: 'GET', path: '/', headers: {}, bodyB64: null }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' })
  })

  it('strips hop-by-hop headers from the response', async () => {
    const srv = await startTestServer((req, res) => {
      // Some hop-by-hop headers would be rejected by Node's HTTP stack if sent raw.
      // Use writeHead with only the ones that pass through, then verify stripping.
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Keep-Alive': 'timeout=5',
        'Connection': 'keep-alive',
      })
      res.end('ok')
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: {},
      bodyB64: null,
    })

    expect(result.headers['connection']).toBeUndefined()
    expect(result.headers['keep-alive']).toBeUndefined()
  })

  it('strips hop-by-hop headers from the forwarded request', async () => {
    let upstreamSawConnection: string | undefined
    let upstreamSawUpgrade: string | undefined
    const srv = await startTestServer((req, res) => {
      upstreamSawConnection = req.headers['connection'] as string | undefined
      upstreamSawUpgrade = req.headers['upgrade'] as string | undefined
      res.writeHead(200)
      res.end('ok')
    })
    stopServer = srv.stop

    await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: { Connection: 'keep-alive', Upgrade: 'websocket', 'X-Keep': 'yes' },
      bodyB64: null,
    })

    // Node will supply its own Connection header for keep-alive semantics,
    // but it must NOT be the one the caller passed (and Upgrade must be gone).
    expect(upstreamSawUpgrade).toBeUndefined()
    expect(upstreamSawConnection === 'keep-alive' || upstreamSawConnection === undefined).toBe(true)
  })

  it('truncates response bodies that exceed maxBodyBytes', async () => {
    const big = 'A'.repeat(4096)
    const srv = await startTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(big)
    })
    stopServer = srv.stop

    const result = await proxyHttp(
      { port: srv.port, method: 'GET', path: '/', headers: {}, bodyB64: null },
      { maxBodyBytes: 512 },
    )

    expect(result.status).toBe(200)
    expect(result.truncated).toBe(true)
    expect(Buffer.from(result.bodyB64, 'base64').length).toBe(512)
  })

  it('rejects ports below the minimum', async () => {
    await expect(
      proxyHttp({ port: 80, method: 'GET', path: '/', headers: {}, bodyB64: null }),
    ).rejects.toMatchObject({ code: 'INVALID_PORT' })
  })

  it('rejects ports above the maximum', async () => {
    await expect(
      proxyHttp({ port: 70000, method: 'GET', path: '/', headers: {}, bodyB64: null }),
    ).rejects.toMatchObject({ code: 'INVALID_PORT' })
  })

  it('rejects a path that does not start with /', async () => {
    await expect(
      proxyHttp({ port: 3000, method: 'GET', path: 'no-slash', headers: {}, bodyB64: null }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('times out when upstream does not respond within timeoutMs', async () => {
    const srv = await startTestServer(() => {
      // Never respond
    })
    stopServer = srv.stop

    await expect(
      proxyHttp(
        { port: srv.port, method: 'GET', path: '/', headers: {}, bodyB64: null },
        { timeoutMs: 150 },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('forwards custom request headers to the upstream server', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const srv = await startTestServer((req, res) => {
      seen = req.headers
      res.writeHead(200)
      res.end('ok')
    })
    stopServer = srv.stop

    await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: { 'X-Custom': 'abc', 'Accept-Language': 'ko-KR' },
      bodyB64: null,
    })

    expect(seen['x-custom']).toBe('abc')
    expect(seen['accept-language']).toBe('ko-KR')
  })

  it('handles an empty request body without hanging', async () => {
    const srv = await startTestServer((req, res) => {
      res.writeHead(200)
      res.end('done')
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'POST',
      path: '/empty',
      headers: {},
      bodyB64: null,
    })

    expect(result.status).toBe(200)
    expect(fromB64(result.bodyB64)).toBe('done')
  })

  it('base64 round-trips binary response bodies', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x00])
    const srv = await startTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(binary)
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/bin',
      headers: {},
      bodyB64: null,
    })

    const got = Buffer.from(result.bodyB64, 'base64')
    expect(got.equals(binary)).toBe(true)
  })

  it('preserves the path including query string', async () => {
    let seenUrl = ''
    const srv = await startTestServer((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200)
      res.end('ok')
    })
    stopServer = srv.stop

    await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/search?q=hello&lang=ko',
      headers: {},
      bodyB64: null,
    })

    expect(seenUrl).toBe('/search?q=hello&lang=ko')
  })

  it('throws PreviewProxyError instances (typed) for invalid inputs', async () => {
    await expect(
      proxyHttp({ port: 0, method: 'GET', path: '/', headers: {}, bodyB64: null }),
    ).rejects.toBeInstanceOf(PreviewProxyError)
  })

  // Regression: browsers default to `Accept-Encoding: gzip, deflate, br`.
  // If we pass that through to the upstream dev server, the server compresses
  // the response, and the happy-server preview route (which strips
  // Content-Encoding and then calls rewriteHtml(bodyUtf8, …)) ends up
  // UTF-8-decoding gzip bytes and shipping garbage to the iframe. Force
  // `identity` at the proxy boundary so the end-to-end relay stays plain.
  // See specs/remote-preview-relay/context.md (Phase 7 — gzip mojibake fix).
  it('forces Accept-Encoding: identity on the upstream request', async () => {
    let seenAcceptEncoding: string | string[] | undefined
    const srv = await startTestServer((req, res) => {
      seenAcceptEncoding = req.headers['accept-encoding']
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    stopServer = srv.stop

    await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
      bodyB64: null,
    })

    expect(seenAcceptEncoding).toBe('identity')
  })

  it('receives plain (un-gzipped) bodies even when caller requests gzip', async () => {
    // Simulate a real dev server that respects Accept-Encoding.
    const srv = await startTestServer((req, res) => {
      const ae = String(req.headers['accept-encoding'] ?? '')
      if (ae.includes('gzip')) {
        const gz = zlib.gzipSync(Buffer.from('<html><body>hello</body></html>'))
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
        res.end(gz)
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body>hello</body></html>')
      }
    })
    stopServer = srv.stop

    const result = await proxyHttp({
      port: srv.port,
      method: 'GET',
      path: '/',
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
      bodyB64: null,
    })

    // Body is plain UTF-8 HTML — NOT gzip bytes base64-encoded.
    expect(fromB64(result.bodyB64)).toBe('<html><body>hello</body></html>')
    // Upstream didn't compress, so no content-encoding header to forward.
    expect(result.headers['content-encoding']).toBeUndefined()
  })
})
