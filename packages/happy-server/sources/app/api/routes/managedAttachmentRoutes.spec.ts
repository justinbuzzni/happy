import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import type { PrismaClient } from '@prisma/client';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';

/**
 * The managed attachment relay, against a real Fastify instance, the real
 * database and a real local filesystem — with the MinIO SDK mocked so the S3
 * path exercises the same adapter calls without a bucket.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL`, like the other real-database
 * suites.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
    HANDY_MASTER_SECRET: process.env.HANDY_MASTER_SECRET,
    DATA_DIR: process.env.DATA_DIR,
};
let localDir = '';
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
    // Local storage: `files.ts` reads this at import time and `S3_HOST` is
    // unset, so the relay's local adapter is the real one.
    localDir = join(tmpdir(), `managed-attach-${randomUUID()}`);
    process.env.DATA_DIR = localDir;
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const RELAY_ORIGIN = 'https://relay.example.test';
const HOUR = 3_600_000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

let db: PrismaClient;
let modules: {
    auth: typeof import('@/app/auth/auth');
    tokens: typeof import('@/app/auth/sessionScopedToken');
    enable: typeof import('@/app/api/utils/enableAuthentication');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
    attachments: typeof import('@/app/api/routes/attachmentRoutes');
    files: typeof import('@/storage/files');
};

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let issuer: SessionScopedTokenIssuer;
let runtime: import('@/app/managed/managedControlRuntime').ManagedControlRuntime;

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let accountId: string;
let otherAccountId: string;
let accountToken: string;
let sessionId: string;
let siblingSessionId: string;
let workspaceId: string;
let runId: string;
let grantId: string;
let grantExpiresAt: number;
let scopedToken: string;

function scope(over: Record<string, unknown> = {}) {
    return {
        tenantId: 'tenant-1', projectId: 'project-1', workspaceId, runtimeId: 'runtime-1',
        epoch: 1, runId, attemptId: 'attempt-1', sessionId, accountId,
        workspaceAuthorityVersion: 1, runAuthorityVersion: 1, ...over,
    };
}

function claimsFor(over: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    const s = scope();
    return {
        v: 1, grantId, accountId: s.accountId, sessionId: s.sessionId,
        tenantId: s.tenantId, projectId: s.projectId, workspaceId: s.workspaceId,
        runtimeId: s.runtimeId, runId: s.runId, attemptId: s.attemptId, epoch: s.epoch,
        workspaceAuthorityVersion: s.workspaceAuthorityVersion,
        runAuthorityVersion: s.runAuthorityVersion,
        purpose: 'runner' as const,
        expiresAt: grantExpiresAt, ...over,
    };
}

async function mintScoped(over: Partial<SessionScopedClaims> = {}): Promise<string> {
    const minted = await issuer.mint(claimsFor(over), Date.now());
    if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
    return minted.token;
}

function request(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    token: string;
    body?: unknown;
    binary?: Buffer;
    headers?: Record<string, string>;
    instance?: FastifyInstance;
}) {
    return (input.instance ?? app).inject({
        method: input.method,
        url: input.url,
        headers: {
            authorization: `Bearer ${input.token}`,
            'content-type': input.binary ? 'application/octet-stream' : 'application/json',
            ...input.headers,
        },
        ...(input.binary
            ? { payload: input.binary }
            : input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    });
}

/** Everything under the fixtures' own sessions, so "nothing was stored" is checked. */
function managedRoot(): string {
    return join(localDir, 'managed-files');
}

async function storedFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const id of createdSessionIds) {
        const dir = join(managedRoot(), 'sessions', id, 'attachments');
        try {
            const { readdir } = await import('node:fs/promises');
            for (const name of await readdir(dir)) found.push(`${id}/${name}`);
        } catch {
            // No directory means nothing was written for that session.
        }
    }
    return found.sort();
}

async function buildApp(getRuntime: () => unknown): Promise<FastifyInstance> {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.addContentTypeParser(
        'application/octet-stream', { parseAs: 'buffer' }, (_q, body, done) => done(null, body),
    );
    // The same unauthenticated static route the API registers in local mode.
    // Without it here, a relay that wrote into the public root would look safe.
    instance.get('/files/*', (request, reply) => {
        const rel = (request.params as Record<string, string>)['*'];
        const baseDir = join(localDir, 'files');
        const full = join(baseDir, rel);
        if (!full.startsWith(`${baseDir}/`)) return reply.code(403).send('Forbidden');
        return readFile(full)
            .then((buf) => reply.send(buf))
            .catch(() => reply.code(404).send('Not found'));
    });
    const typed = instance.withTypeProvider<ZodTypeProvider>();
    modules.enable.enableAuthentication(typed as never);
    modules.enable.enableSessionScopeAuthentication(typed as never, () => issuer);
    modules.attachments.attachmentRoutes(typed as never, getRuntime as never);
    await instance.ready();
    return instance;
}

describe.skipIf(!enabled)('managed attachment relay (real Fastify + PostgreSQL + local fs)', () => {
    beforeAll(async () => {
        modules = {
            auth: await import('@/app/auth/auth'),
            tokens: await import('@/app/auth/sessionScopedToken'),
            enable: await import('@/app/api/utils/enableAuthentication'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
            attachments: await import('@/app/api/routes/attachmentRoutes'),
            files: await import('@/storage/files'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();
        await mkdir(join(localDir, 'files'), { recursive: true });
        issuer = await modules.tokens.createSessionScopedTokenIssuer({
            seed: 'test-scoped-seed-not-a-production-key',
        });
        const built = await (await import('@/app/managed/managedControlRuntime'))
            .createManagedControlRuntime({
                HAPPY_MANAGED_CONTROL_VERIFIER_KEYS: JSON.stringify({ 'control-1': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
                HAPPY_MANAGED_CONTROL_AUDIENCE: RELAY_ORIGIN,
                HAPPY_MANAGED_SCOPED_TOKEN_SEED: 'test-scoped-seed-not-a-production-key',
                HAPPY_MANAGED_PUBLIC_URL: RELAY_ORIGIN,
            });
        runtime = built!;
        app = await buildApp(() => runtime);
        unconfiguredApp = await buildApp(() => null);
    });

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        otherAccountId = other.id;
        createdAccountIds.add(accountId);
        createdAccountIds.add(otherAccountId);
        accountToken = await modules.auth.auth.createToken(accountId);

        const granted = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        const sibling = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = granted.id;
        siblingSessionId = sibling.id;
        createdSessionIds.add(sessionId);
        createdSessionIds.add(siblingSessionId);

        const now = Date.now();
        await modules.projection.syncWorkspaceAuthority({
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
            expectedVersion: 0, now,
        });
        await modules.projection.syncRunAuthority({
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
            expectedVersion: 0, now,
        });
        const issued = await modules.grants.issueSessionGrant({
            scope: scope() as never,
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: now + HOUR,
            now,
        });
        if (!issued.ok) throw new Error(`fixture grant failed: ${issued.reason}`);
        grantId = issued.grant.grantId;
        grantExpiresAt = issued.grant.expiresAt;
        scopedToken = await mintScoped();
    });

    afterEach(async () => {
        const ids = [...createdSessionIds];
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
        await rm(join(localDir, 'files', 'sessions'), { recursive: true, force: true });
        await rm(join(managedRoot(), 'sessions'), { recursive: true, force: true });
    });

    afterAll(async () => {
        await app?.close();
        await unconfiguredApp?.close();
        await db.$disconnect();
        await rm(localDir, { recursive: true, force: true });
        restoreEnv();
    });

    async function requestUpload(token = scopedToken, sid = sessionId) {
        return request({
            method: 'POST', url: `/v1/sessions/${sid}/attachments/request-upload`,
            token, body: { filename: 'shot.png', size: 10 },
        });
    }

    describe('the URL a child is given', () => {
        it('comes from configuration, whatever the request claims', async () => {
            const response = await requestUpload();
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.method).toBe('PUT');
            expect(body.formFields).toBeUndefined();
            expect(body.uploadUrl.startsWith(`${RELAY_ORIGIN}/v1/sessions/${sessionId}/attachments/`)).toBe(true);
        });

        it('ignores Host and x-forwarded-* entirely', async () => {
            const response = await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
                token: scopedToken, body: { filename: 'shot.png', size: 10 },
                headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.body).not.toContain('evil.test');
        });

        it('refuses when the relay origin is not configured', async () => {
            const response = await requestUpload();
            expect(response.statusCode).toBe(200);
            expect((await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
                token: scopedToken, body: { filename: 'shot.png', size: 10 },
                instance: unconfiguredApp,
            })).statusCode).toBe(503);
        });

        it('hands back a same-origin download URL, never a presigned one', async () => {
            const upload = (await requestUpload()).json();
            const response = await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-download`,
                token: scopedToken, body: { ref: upload.ref },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().downloadUrl.startsWith(`${RELAY_ORIGIN}/`)).toBe(true);
        });
    });

    describe('uploading', () => {
        it('stores the blob and serves it back without a redirect', async () => {
            const upload = (await requestUpload()).json();
            const blob = Buffer.from('encrypted-bytes');
            const put = await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: blob,
            });
            expect(put.statusCode).toBe(200);

            const get = await request({
                method: 'GET', url: new URL(upload.uploadUrl).pathname, token: scopedToken,
            });
            expect(get.statusCode).toBe(200);
            expect(get.rawPayload.equals(blob)).toBe(true);
            // No declared length: the response is bounded on what it actually
            // sends, and promising a size it might cut short would be a lie.
            expect(get.headers['content-type']).toBe('application/octet-stream');
        });

        it('refuses a second write to the same name and keeps the first', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('first'),
            })).statusCode).toBe(200);

            // Write-once: the stored bytes are not a later request's to replace.
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('second'),
            })).statusCode).toBe(409);
            const get = await request({ method: 'GET', url: path, token: scopedToken });
            expect(get.rawPayload.toString()).toBe('first');
        });

        it('refuses a body past the relay ceiling and stores nothing', async () => {
            const upload = (await requestUpload()).json();
            const before = await storedFiles();
            const put = await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.alloc(MAX_FILE_SIZE + 1, 1),
            });
            expect(put.statusCode).toBe(413);
            expect(await storedFiles()).toEqual(before);
        });

        it('refuses a name this server did not generate', async () => {
            // A traversal never reaches the route: the scope gate decodes the
            // path and refuses it there.
            expect((await request({
                method: 'PUT',
                url: `/v1/sessions/${sessionId}/attachments/${encodeURIComponent('../escape.enc')}`,
                token: scopedToken, binary: Buffer.from('x'),
            })).statusCode).toBe(403);

            // Well-formed paths that are not names this server issued.
            for (const name of ['notauuid.enc', `${randomUUID()}.txt`, `${randomUUID()}.enc.bak`]) {
                const response = await request({
                    method: 'PUT',
                    url: `/v1/sessions/${sessionId}/attachments/${encodeURIComponent(name)}`,
                    token: scopedToken, binary: Buffer.from('x'),
                });
                expect(response.statusCode, name).toBe(404);
            }
            expect(await storedFiles()).toEqual([]);
        });

        it('refuses to store bytes whose grant was withdrawn while they arrived', async () => {
            const upload = (await requestUpload()).json();
            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            const put = await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.from('too late'),
            });
            expect(put.statusCode).toBe(403);
            expect(await storedFiles()).toEqual([]);
        });
    });

    describe('where a managed blob is stored', () => {
        it('is not reachable through the unauthenticated file route', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('secret-bytes'),
            })).statusCode).toBe(200);

            // The relay is the only way in. A blob written under the public
            // root would be served to anyone holding the ref, with no bearer
            // and no grant — the whole boundary bypassed by a static handler.
            const direct = await app.inject({ method: 'GET', url: `/files/${upload.ref}` });
            expect(direct.statusCode).toBe(404);
            expect(direct.rawPayload.toString()).not.toContain('secret-bytes');
        });

        it('stays unreachable there after the grant is revoked', async () => {
            const upload = (await requestUpload()).json();
            await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.from('secret-bytes'),
            });
            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            const direct = await app.inject({ method: 'GET', url: `/files/${upload.ref}` });
            expect(direct.statusCode).toBe(404);
            expect(direct.rawPayload.toString()).not.toContain('secret-bytes');
        });
    });

    describe('when the session is deleted', () => {
        it('removes the managed blobs too, rather than orphaning them', async () => {
            const upload = (await requestUpload()).json();
            expect((await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.from('bytes'),
            })).statusCode).toBe(200);
            expect(await storedFiles()).toHaveLength(1);

            // The private root is not the public one, so the existing cleanup
            // would walk past it and leave the bytes behind for good.
            await modules.files.deleteSessionAttachments(sessionId);
            expect(await storedFiles()).toEqual([]);
        });
    });

    describe('a symlink under the private root', () => {
        it('cannot make an upload land in the public files tree', async () => {
            const upload = (await requestUpload()).json();
            // The attachments directory for this session is replaced by a link
            // into the public root. `wx` on a fresh name would follow it and
            // create the file on the other side, where `/files/*` serves it.
            const { symlink, mkdir: makeDir, rm: remove } = await import('node:fs/promises');
            const privateDir = join(managedRoot(), 'sessions', sessionId, 'attachments');
            const publicDir = join(localDir, 'files', 'sessions', sessionId, 'attachments');
            await makeDir(publicDir, { recursive: true });
            await remove(privateDir, { recursive: true, force: true });
            await makeDir(join(managedRoot(), 'sessions', sessionId), { recursive: true });
            await symlink(publicDir, privateDir);

            const put = await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.from('would-be-public'),
            });
            expect(put.statusCode).toBe(503);

            const direct = await app.inject({ method: 'GET', url: `/files/${upload.ref}` });
            expect(direct.statusCode).toBe(404);
        });
    });

    describe('a write that fails part way', () => {
        it('leaves no partial blob at the final name and lets the retry succeed', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;

            // A short write: the bytes start landing and the device fills up.
            // Creating the final name first would leave those bytes published
            // under it — served to the child as the attachment, and refused
            // forever afterwards as "already uploaded".
            const nodeFs = await import('node:fs');
            const realWrite = nodeFs.promises.writeFile;
            let failed = false;
            const spy = vi.spyOn(nodeFs.promises, 'writeFile').mockImplementation((async (
                target: never, data: never, options: never,
            ) => {
                if (failed) return realWrite(target, data, options);
                failed = true;
                await realWrite(target, Buffer.from('partial'), options);
                throw Object.assign(new Error('device full'), { code: 'ENOSPC' });
            }) as never);

            let firstAttempt: number;
            try {
                firstAttempt = (await request({
                    method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('complete-bytes'),
                })).statusCode;
            } finally {
                spy.mockRestore();
            }
            expect(firstAttempt).toBe(503);
            expect(await storedFiles()).toEqual([]);

            // The name is still free, so the caller can try again.
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('complete-bytes'),
            })).statusCode).toBe(200);
            expect((await request({ method: 'GET', url: path, token: scopedToken })).rawPayload.toString())
                .toBe('complete-bytes');
        }, 20_000);

        it('does not disturb an object that is already published', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('winner'),
            })).statusCode).toBe(200);

            const nodeFs = await import('node:fs');
            const realWrite = nodeFs.promises.writeFile;
            const spy = vi.spyOn(nodeFs.promises, 'writeFile').mockImplementation((async (
                target: never, _data: never, options: never,
            ) => {
                await realWrite(target, Buffer.from('partial'), options);
                throw Object.assign(new Error('device full'), { code: 'ENOSPC' });
            }) as never);
            try {
                await request({ method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('loser') });
            } finally {
                spy.mockRestore();
            }
            expect((await request({ method: 'GET', url: path, token: scopedToken })).rawPayload.toString())
                .toBe('winner');
        }, 20_000);
    });

    describe('the stream is live while the grant is still being read', () => {
        /**
         * A real socket, because a disconnect is a transport event.
         *
         * `closed` resolves on the response's own `close` — the same event the
         * handler would have to hear. Waiting on it instead of a delay is what
         * makes "the client was already gone" an observation rather than an
         * assumption about scheduling. The hook is registered here, in the
         * test's own instance, so nothing is added to the product path.
         */
        async function listeningApp() {
            const instance = fastify();
            instance.setValidatorCompiler(validatorCompiler);
            instance.setSerializerCompiler(serializerCompiler);
            instance.addContentTypeParser(
                'application/octet-stream', { parseAs: 'buffer' }, (_q, b, done) => done(null, b),
            );
            let announceClosed: () => void = () => {};
            const closed = new Promise<void>((resolve) => { announceClosed = resolve; });
            instance.addHook('onRequest', async (_request, reply) => {
                reply.raw.once('close', () => announceClosed());
            });
            const typed = instance.withTypeProvider<ZodTypeProvider>();
            modules.enable.enableAuthentication(typed as never);
            modules.enable.enableSessionScopeAuthentication(typed as never, () => issuer);
            modules.attachments.attachmentRoutes(typed as never, () => runtime as never);
            const address = await instance.listen({ port: 0, host: '127.0.0.1' });
            return { address, closed, close: () => instance.close() };
        }

        /**
         * Opening the object and deciding whether the caller may have it are
         * two waits, and the object is open for the whole of the second one. A
         * source that fails in that window has no listener, and a client that
         * leaves in it has nobody to close the handle.
         */
        async function relayWithBarrier(sessionUnderTest = sessionId) {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('bytes'),
            })).statusCode).toBe(200);

            const { PassThrough } = await import('node:stream');
            const source = new PassThrough();
            let destroyed = false;
            source.on('close', () => { destroyed = true; });

            const storage = await import('@/app/managed/managedAttachmentStorage');
            const access = await import('@/app/managed/managedSessionAccess');
            const readSpy = vi.spyOn(storage, 'managedReadStream')
                .mockResolvedValue(source as never);

            // The barrier: the route is parked inside the grant read, with the
            // stream already open, until the test says otherwise.
            // The first call is the route's own authentication, which has to
            // pass for the handler to run at all; the barrier is the *second*,
            // the re-check that happens with the object already open.
            let releaseGrant: () => void = () => {};
            let calls = 0;
            const atBarrier = new Promise<void>((resolve) => {
                const original = access.authorizeManagedSessionRequest;
                vi.spyOn(access, 'authorizeManagedSessionRequest')
                    .mockImplementation(async (input) => {
                        if (++calls < 2) return original(input);
                        resolve();
                        await new Promise<void>((r) => { releaseGrant = r; });
                        return original(input);
                    });
            });

            const inflight = request({ method: 'GET', url: path, token: scopedToken });
            await atBarrier;
            expect(readSpy).toHaveBeenCalled();
            return {
                source, inflight,
                release: () => releaseGrant(),
                wasDestroyed: () => destroyed,
                restore: () => { readSpy.mockRestore(); vi.restoreAllMocks(); },
                unusedSession: sessionUnderTest,
            };
        }

        it('answers 503 and sends no bytes when the source fails first', async () => {
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown) => unhandled.push(reason);
            process.on('unhandledRejection', onUnhandled);
            process.on('uncaughtException', onUnhandled);

            const barrier = await relayWithBarrier();
            try {
                barrier.source.emit('error', new Error('connection reset by the object store'));
                barrier.release();
                const response = await barrier.inflight;
                expect(response.statusCode).toBe(503);
                expect(response.rawPayload.toString()).not.toContain('connection reset');
                expect(barrier.wasDestroyed()).toBe(true);
            } finally {
                barrier.restore();
                process.off('unhandledRejection', onUnhandled);
                process.off('uncaughtException', onUnhandled);
            }
            // An `error` on a stream nobody listens to takes the process down.
            await new Promise((r) => setTimeout(r, 50));
            expect(unhandled).toEqual([]);
        }, 30_000);

        it('closes the source when the caller left before it was even open', async () => {
            // The window nobody watches: opening the object is itself a network
            // wait, and a client that gives up inside it has already fired its
            // `close` by the time any listener could be attached. A handler
            // that only listens from then on never hears it, and the provider
            // stream stays open with nobody holding it.
            const listening = await listeningApp();
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('bytes'),
            })).statusCode).toBe(200);

            const { PassThrough } = await import('node:stream');
            const source = new PassThrough();
            let destroyed = false;
            source.on('close', () => { destroyed = true; });
            source.on('error', () => { /* owned by the route once handed over */ });

            const storage = await import('@/app/managed/managedAttachmentStorage');
            const access = await import('@/app/managed/managedSessionAccess');
            let releaseOpen: () => void = () => {};
            const atOpen = new Promise<void>((resolve) => {
                vi.spyOn(storage, 'managedReadStream').mockImplementation(async () => {
                    resolve();
                    await new Promise<void>((r) => { releaseOpen = r; });
                    return source as never;
                });
            });
            // A second barrier at the grant read, so the assertion lands before
            // any handoff: a source that is only closed once `pipeline` fails
            // against the dead socket was held open across this whole wait, and
            // its bytes were relayed to nobody.
            let calls = 0;
            let releaseGrant: () => void = () => {};
            const atGrant = new Promise<void>((resolve) => {
                const original = access.authorizeManagedSessionRequest;
                vi.spyOn(access, 'authorizeManagedSessionRequest')
                    .mockImplementation(async (input) => {
                        if (++calls < 2) return original(input);
                        resolve();
                        await new Promise<void>((r) => { releaseGrant = r; });
                        return original(input);
                    });
            });

            const controller = new AbortController();
            const inflight = fetch(`${listening.address}${path}`, {
                headers: { authorization: `Bearer ${scopedToken}` },
                signal: controller.signal,
            }).catch(() => undefined);

            try {
                await atOpen;
                // Gone before the stream exists. The wait is on the response's
                // own `close`, so by the time the stream is handed over that
                // event is provably in the past — a listener attached
                // afterwards can never hear it.
                controller.abort();
                await listening.closed;
                releaseOpen();
                await atGrant;
                // Still parked in the grant read: the handle must already be
                // gone, not closed later by a pipeline failing against a dead
                // socket.
                await vi.waitFor(() => expect(destroyed).toBe(true), { timeout: 5_000 });
                releaseGrant();
                await inflight;
            } finally {
                vi.restoreAllMocks();
                await listening.close();
            }
        }, 30_000);

        it('closes the source when the caller goes away mid-decision', async () => {
            // A real socket, because a disconnect is a transport event: an
            // injected request has no client to lose.
            const listening = await listeningApp();
            const address = listening.address;

            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('bytes'),
            })).statusCode).toBe(200);

            const { PassThrough } = await import('node:stream');
            const source = new PassThrough();
            let destroyed = false;
            source.on('close', () => { destroyed = true; });
            source.on('error', () => { /* the route owns this once acquired */ });

            const storage = await import('@/app/managed/managedAttachmentStorage');
            const access = await import('@/app/managed/managedSessionAccess');
            const readSpy = vi.spyOn(storage, 'managedReadStream').mockResolvedValue(source as never);
            let releaseGrant: () => void = () => {};
            let calls = 0;
            const atBarrier = new Promise<void>((resolve) => {
                const original = access.authorizeManagedSessionRequest;
                vi.spyOn(access, 'authorizeManagedSessionRequest')
                    .mockImplementation(async (input) => {
                        if (++calls < 2) return original(input);
                        resolve();
                        await new Promise<void>((r) => { releaseGrant = r; });
                        return original(input);
                    });
            });

            const controller = new AbortController();
            const inflight = fetch(`${address}${path}`, {
                headers: { authorization: `Bearer ${scopedToken}` },
                signal: controller.signal,
            }).catch(() => undefined);

            try {
                await atBarrier;
                controller.abort();
                // Still parked in the grant read. The handle has to be gone by
                // now, not whenever the decision happens to come back — that
                // wait is unbounded from here.
                await vi.waitFor(() => expect(destroyed).toBe(true), { timeout: 5_000 });
                releaseGrant();
                await inflight;
            } finally {
                readSpy.mockRestore();
                vi.restoreAllMocks();
                await listening.close();
            }
        }, 30_000);
    });

    describe('two writers for one name', () => {
        it('lets exactly one win and leaves the winner*s bytes intact', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            const [a, b] = await Promise.all([
                request({ method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('AAAA') }),
                request({ method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('BBBB') }),
            ]);
            const codes = [a.statusCode, b.statusCode].sort();
            // A check followed by a write is not write-once: both callers see
            // an absent object and both write.
            expect(codes).toEqual([200, 409]);

            const stored = (await request({ method: 'GET', url: path, token: scopedToken })).rawPayload.toString();
            const winner = a.statusCode === 200 ? 'AAAA' : 'BBBB';
            expect(stored).toBe(winner);
        });

        it('does not remove a stored object when a later write fails', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('kept'),
            })).statusCode).toBe(200);

            // Whatever the second write does, the first caller's bytes are not
            // its to clean up.
            await request({ method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('other') });
            expect((await request({ method: 'GET', url: path, token: scopedToken })).rawPayload.toString())
                .toBe('kept');
        });
    });

    describe('storage that cannot answer', () => {
        it('is reported as unavailable, not as an absent object', async () => {
            const upload = (await requestUpload()).json();
            const files = modules.files as unknown as { getManagedFilesDir: () => string };
            const spy = vi.spyOn(files, 'getManagedFilesDir').mockImplementation(() => {
                throw Object.assign(new Error('mount gone'), { code: 'EIO' });
            });
            try {
                const put = await request({
                    method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                    token: scopedToken, binary: Buffer.from('x'),
                });
                // Treating an unreadable store as "nothing is there" would turn
                // an outage into an overwrite.
                expect(put.statusCode).toBe(503);
                expect(put.body).not.toContain('mount gone');
            } finally {
                spy.mockRestore();
            }
            expect(await storedFiles()).toEqual([]);
        });
    });

    describe('another session is refused', () => {
        it('refuses metadata and blob calls for a sibling session', async () => {
            expect((await requestUpload(scopedToken, siblingSessionId)).statusCode).toBe(403);
            expect((await request({
                method: 'PUT',
                url: `/v1/sessions/${siblingSessionId}/attachments/${randomUUID()}.enc`,
                token: scopedToken, binary: Buffer.from('x'),
            })).statusCode).toBe(403);
            expect((await request({
                method: 'GET',
                url: `/v1/sessions/${siblingSessionId}/attachments/${randomUUID()}.enc`,
                token: scopedToken,
            })).statusCode).toBe(403);
            expect(await storedFiles()).toEqual([]);
        });

        it('refuses a ref pointing outside the granted session', async () => {
            const response = await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-download`,
                token: scopedToken,
                body: { ref: `sessions/${siblingSessionId}/attachments/${randomUUID()}.enc` },
            });
            expect(response.statusCode).toBe(400);
        });
    });

    describe('the grant is read again on every call', () => {
        it('stops serving a download once the grant is revoked', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('bytes'),
            })).statusCode).toBe(200);
            expect((await request({ method: 'GET', url: path, token: scopedToken })).statusCode).toBe(200);

            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            expect((await request({ method: 'GET', url: path, token: scopedToken })).statusCode).toBe(403);
        });

        it('does not reuse the metadata call*s permission for the blob call', async () => {
            const upload = (await requestUpload()).json();
            await modules.projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                expectedVersion: 1, now: Date.now(),
            });
            expect((await request({
                method: 'PUT', url: new URL(upload.uploadUrl).pathname,
                token: scopedToken, binary: Buffer.from('x'),
            })).statusCode).toBe(403);
            expect(await storedFiles()).toEqual([]);
        });

        it('stops a response whose object outgrows what its size claimed', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('small'),
            })).statusCode).toBe(200);

            // The stat is a moment, not a promise: the object can grow between
            // it and the read. The response has to be bounded on the bytes it
            // actually sends.
            const ref = upload.ref as string;
            await writeFile(join(managedRoot(), ref), Buffer.alloc(MAX_FILE_SIZE + 1024, 3));
            const get = await request({ method: 'GET', url: path, token: scopedToken });
            expect(get.rawPayload.length).toBeLessThanOrEqual(MAX_FILE_SIZE);
        }, 30_000);

        it('refuses an oversized stored object before writing a byte', async () => {
            const upload = (await requestUpload()).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: scopedToken, binary: Buffer.from('small'),
            })).statusCode).toBe(200);
            // Grown behind the relay's back, as a shared bucket could be.
            const ref = upload.ref as string;
            await writeFile(join(managedRoot(), ref), Buffer.alloc(MAX_FILE_SIZE + 1, 2));
            const get = await request({ method: 'GET', url: path, token: scopedToken });
            expect(get.statusCode).toBe(413);
        }, 20_000);
    });

    describe('account bearers keep their behaviour', () => {
        it('still receives the local upload URL built from the request', async () => {
            const response = await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
                token: accountToken, body: { filename: 'shot.png', size: 10 },
                headers: { host: 'byos.example.test' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.method).toBe('PUT');
            // Unchanged: BYOS keeps the request-derived origin.
            expect(body.uploadUrl).toContain('byos.example.test');
        });

        it('uploads and downloads through the existing local path', async () => {
            const upload = (await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
                token: accountToken, body: { filename: 'shot.png', size: 10 },
            })).json();
            const path = new URL(upload.uploadUrl).pathname;
            expect((await request({
                method: 'PUT', url: path, token: accountToken, binary: Buffer.from('byos'),
            })).statusCode).toBe(200);
            const get = await request({ method: 'GET', url: path, token: accountToken });
            expect(get.statusCode).toBe(200);
            expect(get.rawPayload.toString()).toBe('byos');
        });

        it('may still overwrite its own attachment, as it always could', async () => {
            const upload = (await request({
                method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
                token: accountToken, body: { filename: 'shot.png', size: 10 },
            })).json();
            const path = new URL(upload.uploadUrl).pathname;
            await request({ method: 'PUT', url: path, token: accountToken, binary: Buffer.from('one') });
            expect((await request({
                method: 'PUT', url: path, token: accountToken, binary: Buffer.from('two'),
            })).statusCode).toBe(200);
        });
    });
});
