/**
 * HTTP proxy utility for remote preview.
 *
 * Accepts a normalized request descriptor and relays it to a local dev server
 * listening on `127.0.0.1:{port}`. The response body is buffered in memory,
 * truncated to `maxBodyBytes`, and returned base64-encoded so the daemon's
 * Socket.IO RPC transport can carry it to happy-server.
 *
 * Deliberately a pure utility: no logger, no sockets, no globals. The daemon
 * wires this into its HTTP control endpoint and its `proxy-http` RPC handler.
 */

import http from 'node:http'
import { Buffer } from 'node:buffer'

export interface ProxyRequest {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  bodyB64: string | null
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  bodyB64: string
  truncated: boolean
}

export interface ProxyOptions {
  timeoutMs?: number
  maxBodyBytes?: number
  portMin?: number
  portMax?: number
}

export const DEFAULT_TIMEOUT_MS = 30_000
// 50 MiB — covers typical dev JS bundles, source maps, and unoptimized
// images without needing a streaming protocol. Bumped from 1 MiB after
// live remote-preview testing showed real React / Vite / Next.js dev
// builds routinely ship 5–15 MiB of transient assets. See
// specs/remote-preview-relay/ Phase 4.
export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024
export const DEFAULT_PORT_MIN = 1024
export const DEFAULT_PORT_MAX = 65535

export type PreviewProxyErrorCode =
  | 'INVALID_PORT'
  | 'INVALID_PATH'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'

export class PreviewProxyError extends Error {
  public readonly code: PreviewProxyErrorCode
  constructor(code: PreviewProxyErrorCode, message: string) {
    super(message)
    this.name = 'PreviewProxyError'
    this.code = code
  }
}

// RFC 7230 §6.1 + `Host` which we always rewrite ourselves.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      out[key] = value
    }
  }
  return out
}

function flattenResponseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

export function proxyHttp(req: ProxyRequest, opts: ProxyOptions = {}): Promise<ProxyResponse> {
  const portMin = opts.portMin ?? DEFAULT_PORT_MIN
  const portMax = opts.portMax ?? DEFAULT_PORT_MAX
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  if (!Number.isInteger(req.port) || req.port < portMin || req.port > portMax) {
    return Promise.reject(
      new PreviewProxyError('INVALID_PORT', `Port must be an integer in [${portMin}, ${portMax}], got ${req.port}`),
    )
  }
  if (typeof req.path !== 'string' || !req.path.startsWith('/')) {
    return Promise.reject(new PreviewProxyError('INVALID_PATH', `Path must start with '/', got ${JSON.stringify(req.path)}`))
  }

  const bodyBuf = req.bodyB64 ? Buffer.from(req.bodyB64, 'base64') : null
  const requestHeaders = stripHopByHop(req.headers)
  // Force the upstream to skip compression. The browser's default
  // `Accept-Encoding: gzip, deflate, br` would otherwise have the dev
  // server gzip its response, and the happy-server preview route strips
  // `Content-Encoding` before running HTML/JS rewrites on the body —
  // turning the iframe into mojibake. Loopback compression buys nothing
  // here, so identity is strictly an improvement.
  // Drop any caller-supplied Accept-Encoding (case-insensitive) before
  // setting identity, otherwise Node sends both values.
  for (const k of Object.keys(requestHeaders)) {
    if (k.toLowerCase() === 'accept-encoding') delete requestHeaders[k]
  }
  requestHeaders['Accept-Encoding'] = 'identity'
  if (bodyBuf && requestHeaders['content-length'] === undefined) {
    requestHeaders['Content-Length'] = String(bodyBuf.length)
  }

  return new Promise<ProxyResponse>((resolve, reject) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: req.port,
      method: req.method,
      path: req.path,
      headers: requestHeaders,
    })

    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => {
        upstream.destroy()
        reject(new PreviewProxyError('TIMEOUT', `Upstream did not respond within ${timeoutMs}ms`))
      })
    }, timeoutMs)

    upstream.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      settle(() => {
        if (err.code === 'ECONNREFUSED') {
          reject(new PreviewProxyError('CONNECTION_REFUSED', `No server listening on 127.0.0.1:${req.port}`))
        } else {
          reject(new PreviewProxyError('UPSTREAM_ERROR', err.message))
        }
      })
    })

    upstream.once('response', (res) => {
      const chunks: Buffer[] = []
      let received = 0
      let truncated = false

      res.on('data', (chunk: Buffer) => {
        if (truncated) return
        const remaining = maxBodyBytes - received
        if (remaining <= 0) {
          truncated = true
          res.destroy()
          return
        }
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining))
          received += remaining
          truncated = true
          res.destroy()
        } else {
          chunks.push(chunk)
          received += chunk.length
        }
      })

      res.on('end', () => {
        clearTimeout(timer)
        settle(() => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenResponseHeaders(res.headers),
            bodyB64: Buffer.concat(chunks, received).toString('base64'),
            truncated,
          })
        })
      })

      res.on('close', () => {
        // If we destroyed the stream due to truncation, resolve with what we have.
        if (!settled && truncated) {
          clearTimeout(timer)
          settle(() => {
            resolve({
              status: res.statusCode ?? 0,
              headers: flattenResponseHeaders(res.headers),
              bodyB64: Buffer.concat(chunks, received).toString('base64'),
              truncated,
            })
          })
        }
      })

      res.on('error', (err) => {
        clearTimeout(timer)
        settle(() => reject(new PreviewProxyError('UPSTREAM_ERROR', err.message)))
      })
    })

    if (bodyBuf) {
      upstream.end(bodyBuf)
    } else {
      upstream.end()
    }
  })
}
