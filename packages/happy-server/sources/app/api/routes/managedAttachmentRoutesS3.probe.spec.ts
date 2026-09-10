/**
 * The managed attachment relay end to end against a real object store.
 *
 * The local suite proves the route contract; it cannot prove where the bytes
 * land when the deployment has S3 configured, which bucket serves them back,
 * or that deleting a session reaches the private bucket. Those are properties
 * of a server this process does not contain.
 *
 * Opt-in twice: a scope database and a MinIO the caller owns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Client } from 'minio';

import type { PrismaClient } from '@prisma/client';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const endpoint = process.env.HAPPY_MANAGED_PROBE_S3_ENDPOINT;
const enabled = Boolean(TEST_DATABASE_URL && endpoint);

const priorEnv = { ...process.env };
const run = randomUUID().slice(0, 8);
const publicBucket = `probe-relay-public-${run}`;
const privateBucket = `probe-relay-private-${run}`;
const [probeHost, probePort] = (endpoint ?? '127.0.0.1:0').split(':');
const accessKey = process.env.HAPPY_MANAGED_PROBE_S3_ACCESS_KEY ?? '';
const secretKey = process.env.HAPPY_MANAGED_PROBE_S3_SECRET_KEY ?? '';

if (enabled) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
    process.env.S3_HOST = probeHost;
    process.env.S3_PORT = probePort;
    process.env.S3_USE_SSL = 'false';
    process.env.S3_ACCESS_KEY = accessKey;
    process.env.S3_SECRET_KEY = secretKey;
    process.env.S3_BUCKET = publicBucket;
    process.env.S3_PUBLIC_URL = `http://${endpoint}/${publicBucket}`;
    process.env.HAPPY_MANAGED_S3_BUCKET = privateBucket;
    process.env.HAPPY_MANAGED_S3_BACKEND = 'minio';
}

const RELAY_ORIGIN = 'https://relay.example.test';
const HOUR = 3_600_000;

let db: PrismaClient;
let modules: {
    auth: typeof import('@/app/auth/auth');
    tokens: typeof import('@/app/auth/sessionScopedToken');
    enable: typeof import('@/app/api/utils/enableAuthentication');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
    attachments: typeof import('@/app/api/routes/attachmentRoutes');
    storage: typeof import('@/app/managed/managedAttachmentStorage');
    files: typeof import('@/storage/files');
};
let app: FastifyInstance;
let issuer: SessionScopedTokenIssuer;
let runtime: import('@/app/managed/managedControlRuntime').ManagedControlRuntime;
let admin: Client;

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let accountId: string;
let sessionId: string;
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

function request(input: {
    method: 'GET' | 'POST' | 'PUT'; url: string; token: string;
    body?: unknown; binary?: Buffer;
}) {
    return app.inject({
        method: input.method, url: input.url,
        headers: {
            authorization: `Bearer ${input.token}`,
            'content-type': input.binary ? 'application/octet-stream' : 'application/json',
        },
        ...(input.binary
            ? { payload: input.binary }
            : input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    });
}

const listKeys = (bucket: string, prefix: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
        const found: string[] = [];
        const stream = admin.listObjects(bucket, prefix, true);
        stream.on('data', (o: { name?: string }) => { if (o.name) found.push(o.name); });
        stream.on('end', () => resolve(found));
        stream.on('error', reject);
    });

describe.skipIf(!enabled)('managed attachment relay (real Fastify + PostgreSQL + real MinIO)', () => {
    beforeAll(async () => {
        admin = new Client({
            endPoint: probeHost, port: Number(probePort), useSSL: false, accessKey, secretKey,
            region: 'us-east-1',
        });
        await admin.makeBucket(publicBucket, 'us-east-1');
        await admin.makeBucket(privateBucket, 'us-east-1');
        await admin.setBucketPolicy(publicBucket, JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
                Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${publicBucket}/*`],
            }],
        }));

        modules = {
            auth: await import('@/app/auth/auth'),
            tokens: await import('@/app/auth/sessionScopedToken'),
            enable: await import('@/app/api/utils/enableAuthentication'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
            attachments: await import('@/app/api/routes/attachmentRoutes'),
            storage: await import('@/app/managed/managedAttachmentStorage'),
            files: await import('@/storage/files'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();
        expect(modules.files.isLocalStorage()).toBe(false);

        // The activation gate decides the bucket, exactly as the API does.
        const activation = await modules.storage.activateManagedStorage(process.env as never);
        expect(activation).toEqual({ ok: true, mode: 's3', bucket: privateBucket });
        modules.storage.setManagedBucket(privateBucket);

        issuer = await modules.tokens.createSessionScopedTokenIssuer({
            seed: 'test-scoped-seed-not-a-production-key',
        });
        runtime = (await (await import('@/app/managed/managedControlRuntime'))
            .createManagedControlRuntime({
                HAPPY_MANAGED_CONTROL_VERIFIER_KEYS: JSON.stringify({ 'control-1': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
                HAPPY_MANAGED_CONTROL_AUDIENCE: RELAY_ORIGIN,
                HAPPY_MANAGED_SCOPED_TOKEN_SEED: 'test-scoped-seed-not-a-production-key',
                HAPPY_MANAGED_PUBLIC_URL: RELAY_ORIGIN,
            }))!;

        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.addContentTypeParser(
            'application/octet-stream', { parseAs: 'buffer' }, (_q, body, done) => done(null, body),
        );
        const typed = app.withTypeProvider<ZodTypeProvider>();
        modules.enable.enableAuthentication(typed as never);
        modules.enable.enableSessionScopeAuthentication(typed as never, () => issuer);
        modules.attachments.attachmentRoutes(typed as never, () => runtime as never);
        await app.ready();
    }, 120_000);

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        createdAccountIds.add(accountId);
        const granted = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = granted.id;
        createdSessionIds.add(sessionId);

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
        const minted = await issuer.mint(claimsFor(), now);
        if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
        scopedToken = minted.token;
    });

    afterAll(async () => {
        await app?.close();
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: [...createdSessionIds] } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
        await db.$disconnect();
        for (const bucket of [publicBucket, privateBucket]) {
            const keys = await listKeys(bucket, '');
            if (keys.length > 0) await admin.removeObjects(bucket, keys);
            await admin.removeBucket(bucket);
        }
        for (const key of Object.keys(process.env)) {
            if (!(key in priorEnv)) delete process.env[key];
        }
        Object.assign(process.env, priorEnv);
    }, 120_000);

    async function upload(bytes: Buffer) {
        const requested = await request({
            method: 'POST', url: `/v1/sessions/${sessionId}/attachments/request-upload`,
            token: scopedToken, body: { filename: 'shot.png', size: bytes.length },
        });
        expect(requested.statusCode).toBe(200);
        const body = requested.json();
        const put = await request({
            method: 'PUT', url: new URL(body.uploadUrl).pathname, token: scopedToken, binary: bytes,
        });
        expect(put.statusCode).toBe(200);
        return body as { ref: string; uploadUrl: string };
    }

    it('puts the bytes in the private bucket and nowhere else', async () => {
        const { ref } = await upload(Buffer.from('relayed-bytes'));
        expect(await listKeys(privateBucket, `sessions/${sessionId}/`)).toEqual([ref]);
        expect(await listKeys(publicBucket, `sessions/${sessionId}/`)).toEqual([]);
    }, 60_000);

    it('serves them back to the grant holder, and to nobody anonymous', async () => {
        const { ref, uploadUrl } = await upload(Buffer.from('relayed-bytes'));
        const download = await request({ method: 'GET', url: new URL(uploadUrl).pathname, token: scopedToken });
        expect(download.statusCode).toBe(200);
        expect(download.rawPayload.toString()).toBe('relayed-bytes');

        const direct = await fetch(`http://${endpoint}/${privateBucket}/${ref}`);
        expect(direct.status).toBe(403);
    }, 60_000);

    it('stops serving once the grant is revoked, and the object stays private', async () => {
        const { ref, uploadUrl } = await upload(Buffer.from('relayed-bytes'));
        await modules.grants.revokeSessionGrant({ scope: scope() as never, reason: 'probe', now: Date.now() });

        const download = await request({ method: 'GET', url: new URL(uploadUrl).pathname, token: scopedToken });
        expect(download.statusCode).toBe(403);
        // Revocation is not deletion; the bytes are still there, still private.
        expect(await modules.storage.managedObjectSize(ref)).toBe(13);
        expect((await fetch(`http://${endpoint}/${privateBucket}/${ref}`)).status).toBe(403);
    }, 60_000);

    it('deletes them from the private bucket when the session goes', async () => {
        const { ref } = await upload(Buffer.from('relayed-bytes'));
        expect(await modules.storage.managedObjectSize(ref)).toBe(13);

        await modules.files.deleteSessionAttachments(sessionId);

        expect(await modules.storage.managedObjectSize(ref)).toBeNull();
        expect(await listKeys(privateBucket, `sessions/${sessionId}/`)).toEqual([]);
    }, 60_000);

    it('still deletes them when managed storage was never activated in this process', async () => {
        const { ref } = await upload(Buffer.from('relayed-bytes'));
        // A deployment that has since turned managed control off still owns
        // what it stored; cleanup reads the configured bucket, not whatever
        // activation happened to accept.
        modules.storage.setManagedBucket(null);
        try {
            await modules.files.deleteSessionAttachments(sessionId);
            expect(await listKeys(privateBucket, `sessions/${sessionId}/`)).toEqual([]);
        } finally {
            modules.storage.setManagedBucket(privateBucket);
        }
        expect(ref).toContain(sessionId);
    }, 60_000);
});
