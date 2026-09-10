/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * No database records — attachments are identified by their ref path.
 * Cleanup happens when sessions are deleted (Phase 8).
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir, putLocalFile } from '@/storage/files';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import {
    ManagedStorageUnavailable,
    managedCreateObject,
    managedLocalPath,
    managedObjectSize,
    managedReadStream,
} from '@/app/managed/managedAttachmentStorage';
import { authorizeManagedSessionRequest } from '@/app/managed/managedSessionAccess';
import { requireSessionScopeAuth } from '@/app/api/utils/enableAuthentication';
import type { Principal } from '@/app/auth/sessionScopedToken';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

// Per-user, per-process token bucket for request-upload. Best-effort flood
// protection — on a multi-process deploy each instance counts independently,
// so an attacker with N processes gets N×limit. Adequate as a backstop
// against a single-client loop generating presigned URLs forever.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const uploadRateState = new Map<string, { count: number; windowStart: number }>();

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then x-forwarded-* (for
 * deployments behind a proxy), then the Host header the request itself
 * arrived on. Falling back to localhost would make any non-localhost client
 * (a phone, another LAN device, a desktop pointing at a dev IP) fail with a
 * generic Network request failed when it tries to follow the URL.
 */
function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const xfHost = request.headers['x-forwarded-host'];
    const xfProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost) ?? request.headers.host;
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) ?? 'http';
    if (typeof host === 'string' && host.length > 0) {
        return `${proto}://${host}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}

/**
 * Whether this request is a managed child's, and what it is scoped to.
 *
 * `authenticateSessionScope` has already decided that; this only reads the
 * answer. A managed principal reaching a handler means the route, the session
 * and the grant were all checked for *this* request — the metadata call that
 * produced the URL does not carry over.
 */
function managedPrincipal(request: { principal?: Principal }): Principal & { kind: 'managed-session' } | null {
    return request.principal?.kind === 'managed-session' ? request.principal : null;
}

/**
 * The absolute URL a managed child should call, built only from configuration.
 *
 * Never from `Host` or `x-forwarded-*`: those are the caller's, and a scoped
 * bearer sent to an address the caller chose is a bearer sent wherever the
 * caller likes.
 */
function managedAttachmentUrl(runtime: ManagedControlRuntime, sessionId: string, file: string): string {
    return `${runtime.publicUrl}/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file)}`;
}

/** Server-generated names only, so a ref can never point outside its session. */
const MANAGED_ATTACHMENT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc$/;

function managedRefFor(sessionId: string, file: string): string | null {
    if (!MANAGED_ATTACHMENT_FILE.test(file)) return null;
    return `sessions/${sessionId}/attachments/${file}`;
}

/**
 * Re-reads the grant after the bytes have been handled.
 *
 * A large transfer takes time, and the request's admission was decided before
 * it. This does not un-send what already went out; it decides whether the next
 * step — storing, or writing the first byte of a response — still has
 * permission.
 */
async function managedStillPermitted(
    principal: Principal & { kind: 'managed-session' },
    request: { method: string; url: string; body?: unknown },
): Promise<boolean> {
    const again = await authorizeManagedSessionRequest({
        method: request.method,
        path: request.url,
        body: request.body,
        claims: principal.claims,
        now: Date.now(),
    });
    return again.ok;
}

/**
 * Stops a response at the relay's ceiling.
 *
 * The size read before opening is a moment, not a promise — a shared bucket can
 * grow an object between the two — so the bytes that actually leave are counted.
 */
function boundedRelayStream(source: NodeJS.ReadableStream, limit: number): stream.Readable {
    let sent = 0;
    const bound = new stream.Transform({
        transform(chunk: Buffer, _encoding, done) {
            sent += chunk.length;
            if (sent > limit) {
                done(new Error('attachment exceeds the relay limit'));
                return;
            }
            done(null, chunk);
        },
    });
    return stream.pipeline(source, bound, () => { /* both ends closed by pipeline */ });
}

function checkUploadRate(userId: string): boolean {
    const now = Date.now();
    const entry = uploadRateState.get(userId);
    if (!entry || now - entry.windowStart >= UPLOAD_RATE_WINDOW_MS) {
        uploadRateState.set(userId, { count: 1, windowStart: now });
        // Opportunistic prune so the map cannot grow forever from one-shot
        // users churning through the system.
        if (uploadRateState.size > 10_000) {
            for (const [k, v] of uploadRateState) {
                if (now - v.windowStart >= UPLOAD_RATE_WINDOW_MS) {
                    uploadRateState.delete(k);
                }
            }
        }
        return true;
    }
    if (entry.count >= UPLOAD_RATE_MAX) return false;
    entry.count++;
    return true;
}

export function attachmentRoutes(
    app: Fastify,
    getRuntime: () => ManagedControlRuntime | null = () => null,
) {

    /**
     * Request an upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl to PUT the encrypted blob to.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                filename: z.string(),
                size: z.number().max(MAX_FILE_SIZE),
            }),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                    method: z.enum(['PUT', 'POST']),
                    formFields: z.record(z.string(), z.string()).optional(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
                503: z.object({ error: z.string() }),
            },
        },
        preHandler: requireSessionScopeAuth(app) as never,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size } = request.body;
        const userId = request.userId;
        const managed = managedPrincipal(request as never);

        if (!checkUploadRate(userId)) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Always .enc — encrypted opaque blobs, never trust client filename for path.
        const attachmentId = crypto.randomUUID();
        const attachmentFile = `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (managed) {
            // Managed children never receive a presigned URL. A presign is an
            // address at another origin that carries its own authority, which
            // is the opposite of a grant that has to be re-read on every use.
            // Both storage modes go through this server instead.
            const runtime = getRuntime();
            if (!runtime) {
                return reply.code(503).send({ error: 'Managed relay is not configured' });
            }
            return reply.send({
                ref,
                uploadUrl: managedAttachmentUrl(runtime, sessionId, attachmentFile),
                method: 'PUT',
            });
        }

        if (isLocalStorage()) {
            // Local mode: client uploads to our own PUT endpoint (the server
            // enforces the size limit by inspecting the request body before
            // it hits disk, so PUT is fine here).
            const baseUrl = resolveBaseUrl(request);
            const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else {
            // S3 mode: presigned POST policy with content-length-range so S3
            // itself rejects oversize uploads — a presigned PUT cannot enforce
            // size and would let a client honest about size in the auth call
            // PUT 500MB at the URL afterwards.
            const policy = s3client.newPostPolicy();
            policy.setBucket(s3bucket);
            policy.setKey(ref);
            policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
            policy.setContentLengthRange(0, MAX_FILE_SIZE);
            const { postURL, formData } = await s3client.presignedPostPolicy(policy);
            return reply.send({
                ref,
                uploadUrl: postURL,
                method: 'POST',
                formFields: formData as Record<string, string>,
            });
        }
    });

    /**
     * Local storage: accept encrypted blob upload via PUT.
     * Only active when S3 is not configured.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        // The real ceiling, applied while the body is read rather than after.
        // The global limit is 100MB, so without this a caller could make the
        // server buffer that much before the 10MiB check refused it.
        bodyLimit: MAX_FILE_SIZE,
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
                400: z.object({ error: z.string() }),
                403: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
                409: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                503: z.object({ error: z.string() }),
            },
        },
        preHandler: requireSessionScopeAuth(app) as never,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;
        const managed = managedPrincipal(request as never);

        if (managed) {
            if (!getRuntime()) {
                return reply.code(503).send({ error: 'Managed relay is not configured' });
            }
            const ref = managedRefFor(sessionId, attachmentFile);
            if (!ref) return reply.code(404).send({ error: 'Invalid attachment file' });

            const body = request.body as Buffer;
            if (!Buffer.isBuffer(body)) {
                return reply.code(400).send({ error: 'Body must be a binary blob' });
            }
            if (body.length > MAX_FILE_SIZE) {
                return reply.code(413).send({ error: 'File too large (max 10MB)' });
            }

            // The bytes are in. Whether they may be *stored* is a fresh
            // question: the transfer took time, and the grant may have been
            // withdrawn during it. Nothing already sent is recalled by this.
            if (!await managedStillPermitted(managed, request as never)) {
                return reply.code(403).send({ error: 'Managed session grant is no longer valid' });
            }

            let outcome: 'created' | 'already-exists';
            try {
                outcome = await managedCreateObject(ref, body);
            } catch (error) {
                if (error instanceof ManagedStorageUnavailable) {
                    // A fixed line: a driver error can name the bucket, the
                    // endpoint or the credentials that reached it.
                    log({ module: 'managed-attachments', level: 'error' },
                        'Managed attachment store unavailable during upload');
                    return reply.code(503).send({ error: 'Attachment storage unavailable' });
                }
                throw error;
            }
            // The name was generated by this server for one upload, so a second
            // write is a retry or a mistake. Either way the stored bytes are
            // not this request's to replace — and nothing is deleted here, so a
            // failed write can never remove someone else's object.
            if (outcome === 'already-exists') {
                return reply.code(409).send({ error: 'Attachment already uploaded' });
            }

            // Stored. The store was waited on, so the grant is read once more
            // before this is reported as done; the object is this request's own
            // exclusive creation, which is what makes removing it safe.
            if (!await managedStillPermitted(managed, request as never)) {
                await fs.promises.rm(managedLocalPath(ref), { force: true })
                    .catch(() => { /* S3 objects are left for the operator */ });
                return reply.code(403).send({ error: 'Managed session grant is no longer valid' });
            }
            return reply.send({ ok: true });
        }

        if (!isLocalStorage()) {
            return reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const body = request.body as Buffer;
        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        await putLocalFile(ref, body);

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET — in local mode it points back at
     * this server (auth-required), in S3 mode it is a presigned GET URL.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                ref: z.string(),
            }),
            response: {
                200: z.object({
                    downloadUrl: z.string(),
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
                503: z.object({ error: z.string() }),
            },
        },
        preHandler: requireSessionScopeAuth(app) as never,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref } = request.body;
        const userId = request.userId;
        const managed = managedPrincipal(request as never);

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // ref must live strictly under this session's attachments prefix —
        // otherwise a member of session A could craft a ref pointing into
        // session B and ride this endpoint's auth to read it.
        const expectedPrefix = `sessions/${sessionId}/attachments/`;
        if (!ref.startsWith(expectedPrefix)) {
            return reply.code(400).send({ error: 'Ref does not belong to this session' });
        }
        const attachmentFile = ref.slice(expectedPrefix.length);
        if (!attachmentFile || attachmentFile.includes('/') || attachmentFile.includes('..')) {
            return reply.code(400).send({ error: 'Invalid attachment ref' });
        }

        if (managed) {
            const runtime = getRuntime();
            if (!runtime) {
                return reply.code(503).send({ error: 'Managed relay is not configured' });
            }
            if (!managedRefFor(sessionId, attachmentFile)) {
                return reply.code(400).send({ error: 'Invalid attachment ref' });
            }
            return reply.send({
                downloadUrl: managedAttachmentUrl(runtime, sessionId, attachmentFile),
            });
        }

        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ downloadUrl });
        }
        const downloadUrl = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
        return reply.send({ downloadUrl });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3). Backs the URL returned by
     * /request-download in local mode; clients can also call this directly.
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
        },
        preHandler: requireSessionScopeAuth(app) as never,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;
        const managed = managedPrincipal(request as never);

        if (managed) {
            if (!getRuntime()) {
                return reply.code(503).send({ error: 'Managed relay is not configured' });
            }
            const managedRef = managedRefFor(sessionId, attachmentFile);
            if (!managedRef) return reply.code(404).send({ error: 'Invalid attachment file' });

            let size: number | null;
            let source: NodeJS.ReadableStream | null;
            try {
                // Cheap refusal first, so an object already over the ceiling is
                // not opened at all.
                size = await managedObjectSize(managedRef);
                if (size === null) return reply.code(404).send({ error: 'Attachment not found' });
                if (size > MAX_FILE_SIZE) {
                    return reply.code(413).send({ error: 'Attachment exceeds the relay limit' });
                }
                // Opening is itself a wait — the SDK goes to the network — so
                // the grant is read after the stream exists and before any byte
                // of it is written out.
                source = await managedReadStream(managedRef);
            } catch (error) {
                if (error instanceof ManagedStorageUnavailable) {
                    log({ module: 'managed-attachments', level: 'error' },
                        'Managed attachment store unavailable during download');
                    return reply.code(503).send({ error: 'Attachment storage unavailable' });
                }
                throw error;
            }
            if (!source) return reply.code(404).send({ error: 'Attachment not found' });

            // The object is open from here, and the grant read below is a wait.
            // For the whole of it the stream can fail — an `error` with no
            // listener is an uncaught exception, not a 503 — and the client can
            // go away, leaving a handle nobody closes. Both are answered the
            // moment the stream exists rather than when it is finally piped.
            const open = source;
            const release = () => (open as { destroy?: () => void }).destroy?.();
            let sourceFailed = false;
            let clientGone = false;
            const onSourceError = () => { sourceFailed = true; release(); };
            const onClientGone = () => { clientGone = true; release(); };
            open.on('error', onSourceError);
            reply.raw.on('close', onClientGone);
            // Opening was itself a wait, and a client that gave up inside it
            // has already emitted its `close` — a listener attached now never
            // hears it. The socket's own state is the only record left, so it
            // is read once here rather than waited for.
            if (reply.raw.destroyed || reply.raw.writableEnded) onClientGone();

            let permitted: boolean;
            try {
                permitted = await managedStillPermitted(managed, request as never);
            } catch {
                // The stream is already open, so it is closed here rather than
                // left to the garbage collector, and the failure is reported as
                // a fixed line: an authority error can carry a connection string.
                release();
                log({ module: 'managed-attachments', level: 'error' },
                    'Managed attachment authority unavailable before first byte');
                return reply.code(503).send({ error: 'Authorization unavailable' });
            }
            if (!permitted) {
                release();
                return reply.code(403).send({ error: 'Managed session grant is no longer valid' });
            }
            if (clientGone) {
                // Nobody is waiting for these bytes. The stream is already
                // closed; sending would be a relay to a dead socket, and
                // handing a destroyed source to `pipeline` only manufactures
                // an error to swallow.
                release();
                return reply;
            }
            if (sourceFailed) {
                // Nothing was sent, and nothing is going to be: the answer is
                // the store's, reported as a fixed line.
                log({ module: 'managed-attachments', level: 'error' },
                    'Managed attachment stream failed before first byte');
                return reply.code(503).send({ error: 'Attachment storage unavailable' });
            }

            // Bounded on the bytes actually sent: the size above was a moment,
            // and a shared bucket can grow an object after it.
            //
            // Handed to `pipeline`, which owns both ends from now on — it
            // closes the source on any failure and on the client leaving, so
            // the placeholder listener is removed rather than left to report a
            // second time.
            open.off('error', onSourceError);
            const bounded = boundedRelayStream(open, MAX_FILE_SIZE);
            reply.raw.off('close', release);
            reply.raw.on('close', () => bounded.destroy());
            reply.header('Content-Type', 'application/octet-stream');
            return reply.send(bounded);
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (isLocalStorage()) {
            const fullPath = path.join(getLocalFilesDir(), ref);
            if (!fs.existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Attachment not found' });
            }
            reply.header('Content-Type', 'application/octet-stream');
            return reply.type('application/octet-stream').send(fs.readFileSync(fullPath));
        } else {
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.redirect(url);
        }
    });
}
