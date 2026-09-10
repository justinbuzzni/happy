/**
 * The signed-URL contract, against a **private** bucket.
 *
 * The anonymous-bucket integration test can prove the store's conditional
 * writes behave as compare-and-set, but it cannot prove anything about signed
 * URLs: where anyone may write, the signature was never what granted
 * permission. The property that only a private bucket can show is that SigV4
 * binds the HTTP method — a URL minted for `PUT` is refused for `HEAD` — which
 * is why every object here carries a pair of URLs rather than one.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 *
 * The presigner below is test scaffolding, not product code: in production the
 * parent mints these and the runtime never holds a secret key. It exists so
 * this test can create the exact artefact the runtime will be handed.
 *
 * Needs MANAGED_CHECKPOINT_TEST_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY};
 * skipped otherwise, never silently passed.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointDrain } from './managedCheckpointDrain';
import { publishManagedCheckpoint } from './managedCheckpointPublisher';
import { createManagedCheckpointSource } from './managedCheckpointResolver';
import { restoreManagedCheckpoint } from './managedCheckpointRestore';

const endpoint = process.env.MANAGED_CHECKPOINT_TEST_S3_ENDPOINT;
const bucket = process.env.MANAGED_CHECKPOINT_TEST_S3_BUCKET;
const accessKey = process.env.MANAGED_CHECKPOINT_TEST_S3_ACCESS_KEY;
const secretKey = process.env.MANAGED_CHECKPOINT_TEST_S3_SECRET_KEY;
const configured = Boolean(endpoint && bucket && accessKey && secretKey);

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-signed-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function presign(key: string, method: 'GET' | 'PUT' | 'HEAD'): string {
    const url = new URL(`${endpoint}/${bucket}/${key}`);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
    const query = [
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Credential', `${accessKey}/${scope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', '900'],
        ['X-Amz-SignedHeaders', 'host'],
    ].sort(([a], [b]) => (a! < b! ? -1 : 1))
        .map(([name, value]) => `${uriEncode(name!)}=${uriEncode(value!)}`)
        .join('&');
    const canonicalUri = `/${bucket}/${key}`.split('/').map(uriEncode).join('/').replace(/^%2F/, '/');
    const canonicalRequest = [
        method, canonicalUri, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    let signing = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest();
    for (const part of ['us-east-1', 's3', 'aws4_request']) {
        signing = createHmac('sha256', signing).update(part).digest();
    }
    const signature = createHmac('sha256', signing).update(stringToSign).digest('hex');
    return `${endpoint}/${bucket}/${key}?${query}&X-Amz-Signature=${signature}`;
}

describe.skipIf(!configured)('managed checkpoint over presigned URLs on a private bucket', () => {
    const key = randomBytes(32);
    const tenant = { companyId: 'co_1', projectId: 'pr_1' };
    const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

    it('shouldRefuseAUrlMintedForADifferentMethod', async () => {
        const objectKey = `t13-signed/${randomUUID()}/probe.bin`;
        expect((await fetch(presign(objectKey, 'PUT'), { method: 'PUT', body: 'hello' })).status).toBe(200);

        // The contract this whole pair of URLs exists for.
        expect((await fetch(presign(objectKey, 'PUT'), { method: 'HEAD' })).status).toBe(403);
        expect((await fetch(presign(objectKey, 'HEAD'), { method: 'HEAD' })).status).toBe(200);
        // And the bucket really is private, so the signature is what granted it.
        expect((await fetch(`${endpoint}/${bucket}/${objectKey}`)).status).toBe(403);
    }, 30_000);

    it('shouldPublishVerifyResolveAndRestoreEntirelyThroughSignedUrls', async () => {
        const prefix = `t13-signed/${randomUUID()}`;
        const root = await scratch();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
        await writeFile(join(root, 'asset.bin'), randomBytes(128 * 1024));
        const checkpointId = randomBytes(32).toString('hex');

        const objectKey = `${prefix}/project.tar.gz.enc`;
        const manifestKey = `${prefix}/manifest.json.enc`;
        const pointerKey = `${prefix}/latest.json`;

        const published = await publishManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            key,
            workDir: join(await scratch(), 'work'),
            drain: createCheckpointDrain(),
            drainBudgetMs: 5000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: {
                objects: new Map([['project' as const, {
                    putUrl: presign(objectKey, 'PUT'),
                    headUrl: presign(objectKey, 'HEAD'),
                }]]),
                manifest: { putUrl: presign(manifestKey, 'PUT'), headUrl: presign(manifestKey, 'HEAD') },
                pointer: { putUrl: presign(pointerKey, 'PUT'), getUrl: presign(pointerKey, 'GET') },
            },
            now: () => Date.now(),
        });

        const source = createManagedCheckpointSource({
            authority: {
                tenant,
                pointerUrl: presign(pointerKey, 'GET'),
                manifestUrl: presign(manifestKey, 'GET'),
                objectUrls: new Map([['project' as const, presign(objectKey, 'GET')]]),
                key,
            },
            downloadDir: await scratch(),
        });
        const resolved = await source.resolveLatest();
        expect(resolved?.manifest.checkpointId).toBe(checkpointId);

        const home = await scratch();
        const result = await restoreManagedCheckpoint({
            manifest: resolved!.manifest,
            objects: resolved!.objects,
            key: resolved!.key,
            expected: { tenant, targetVolume: { volumeId: 'vol_new', deviceUuid: 'dev-new' } },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        });

        expect(result.manifestDigest).toBe(published.manifestDigest);
        expect(await readFile(join(home, 'project/src/index.ts'), 'utf8')).toBe('export const a = 1;\n');
        expect(await readFile(join(home, 'project/asset.bin'))).toEqual(await readFile(join(root, 'asset.bin')));
    }, 90_000);

    it('shouldFailTheCheckpointRatherThanPublishWhenVerificationCannotBeSigned', async () => {
        const prefix = `t13-signed/${randomUUID()}`;
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'content\n');
        const objectKey = `${prefix}/project.tar.gz.enc`;
        const pointerKey = `${prefix}/latest.json`;

        await expect(publishManagedCheckpoint({
            checkpointId: randomBytes(32).toString('hex'),
            tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            key,
            workDir: join(await scratch(), 'work'),
            drain: createCheckpointDrain(),
            drainBudgetMs: 5000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: {
                objects: new Map([['project' as const, {
                    putUrl: presign(objectKey, 'PUT'),
                    // The defect this contract change fixes: reusing the upload
                    // URL to verify.
                    headUrl: presign(objectKey, 'PUT'),
                }]]),
                manifest: {
                    putUrl: presign(`${prefix}/manifest.json.enc`, 'PUT'),
                    headUrl: presign(`${prefix}/manifest.json.enc`, 'HEAD'),
                },
                pointer: { putUrl: presign(pointerKey, 'PUT'), getUrl: presign(pointerKey, 'GET') },
            },
            now: () => Date.now(),
        })).rejects.toMatchObject({ code: 'verify-failed' });

        // Nothing was pointed at.
        expect((await fetch(presign(pointerKey, 'GET'))).status).toBe(404);
    }, 60_000);
});
