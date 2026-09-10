/**
 * Managed attachment storage against a real MinIO server.
 *
 * Everything the object-store branch claims is a claim about a server this
 * process does not contain: whether `If-None-Match: *` is honoured, whether a
 * policy-free bucket actually refuses anonymous readers, whether the session
 * cleanup reaches the managed bucket. Unit tests with a stub client can only
 * restate the assumption.
 *
 * Opt-in. Runs only when HAPPY_MANAGED_PROBE_S3_ENDPOINT names a MinIO the
 * caller owns, and only ever touches buckets whose names it generates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Client } from 'minio';

const endpoint = process.env.HAPPY_MANAGED_PROBE_S3_ENDPOINT;
const suite = endpoint ? describe : describe.skip;

const [probeHost, probePort] = (endpoint ?? '127.0.0.1:0').split(':');
const accessKey = process.env.HAPPY_MANAGED_PROBE_S3_ACCESS_KEY ?? '';
const secretKey = process.env.HAPPY_MANAGED_PROBE_S3_SECRET_KEY ?? '';

const run = randomUUID().slice(0, 8);
const publicBucket = `probe-public-${run}`;
const privateBucket = `probe-private-${run}`;

type Storage = typeof import('@/app/managed/managedAttachmentStorage');
type Files = typeof import('@/storage/files');

let storage: Storage;
let files: Files;
let admin: Client;

const anonymousGet = (bucket: string, key: string) =>
    fetch(`http://${endpoint}/${bucket}/${key}`).then((r) => r.status);

const readAll = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
};

suite('managed attachment storage (real MinIO)', () => {
    beforeAll(async () => {
        admin = new Client({
            endPoint: probeHost, port: Number(probePort), useSSL: false, accessKey, secretKey,
            region: 'us-east-1',
        });
        await admin.makeBucket(publicBucket, 'us-east-1');
        await admin.makeBucket(privateBucket, 'us-east-1');
        // What `pnpm s3:init` does to the BYOS bucket, verbatim in effect:
        // every object in it readable by anyone with the URL.
        await admin.setBucketPolicy(publicBucket, JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
                Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${publicBucket}/*`],
            }],
        }));

        process.env.S3_HOST = probeHost;
        process.env.S3_PORT = probePort;
        process.env.S3_USE_SSL = 'false';
        process.env.S3_ACCESS_KEY = accessKey;
        process.env.S3_SECRET_KEY = secretKey;
        process.env.S3_BUCKET = publicBucket;
        process.env.S3_PUBLIC_URL = `http://${endpoint}/${publicBucket}`;
        process.env.HAPPY_MANAGED_S3_BUCKET = privateBucket;
        process.env.HAPPY_MANAGED_S3_BACKEND = 'minio';

        files = await import('@/storage/files');
        storage = await import('@/app/managed/managedAttachmentStorage');
        expect(files.isLocalStorage()).toBe(false);
        storage.setManagedBucket(privateBucket);
    }, 60_000);

    afterAll(async () => {
        for (const bucket of [publicBucket, privateBucket]) {
            const keys: string[] = await new Promise((resolve, reject) => {
                const found: string[] = [];
                const stream = admin.listObjects(bucket, '', true);
                stream.on('data', (o: { name?: string }) => { if (o.name) found.push(o.name); });
                stream.on('end', () => resolve(found));
                stream.on('error', reject);
            });
            if (keys.length > 0) await admin.removeObjects(bucket, keys);
            await admin.removeBucket(bucket);
        }
    }, 60_000);

    describe('activation', () => {
        it('accepts a bucket that carries no policy at all', async () => {
            await expect(storage.activateManagedStorage({
                S3_BUCKET: publicBucket,
                HAPPY_MANAGED_S3_BUCKET: privateBucket,
                HAPPY_MANAGED_S3_BACKEND: 'minio',
            }, undefined, false)).resolves.toEqual({ ok: true, mode: 's3', bucket: privateBucket });
        });

        it('refuses the world-readable bucket the BYOS deployment already has', async () => {
            await expect(storage.activateManagedStorage({
                S3_BUCKET: 'some-other-bucket',
                HAPPY_MANAGED_S3_BUCKET: publicBucket,
                HAPPY_MANAGED_S3_BACKEND: 'minio',
            }, undefined, false)).resolves.toEqual({ ok: false, reason: 'managed-bucket-has-policy' });
        });

        it('refuses a bucket that is not there', async () => {
            await expect(storage.activateManagedStorage({
                S3_BUCKET: publicBucket,
                HAPPY_MANAGED_S3_BUCKET: `probe-absent-${run}`,
                HAPPY_MANAGED_S3_BACKEND: 'minio',
            }, undefined, false)).resolves.toEqual({ ok: false, reason: 'managed-bucket-missing' });
        });
    });

    describe('conditional PUT', () => {
        it('refuses a second write to a name that is taken, and keeps the first bytes', async () => {
            const ref = `sessions/${randomUUID()}/attachments/${randomUUID()}`;
            expect(await storage.managedCreateObject(ref, Buffer.from('winner'))).toBe('created');
            expect(await storage.managedCreateObject(ref, Buffer.from('loser-overwrite')))
                .toBe('already-exists');
            const stream = await storage.managedReadStream(ref);
            expect((await readAll(stream!)).toString()).toBe('winner');
        }, 30_000);

        it('lets exactly one of eight simultaneous writers publish', async () => {
            const ref = `sessions/${randomUUID()}/attachments/${randomUUID()}`;
            const bodies = Array.from({ length: 8 }, (_, i) => `body-${i}`.padEnd(16, '.'));
            const results = await Promise.all(
                bodies.map((b) => storage.managedCreateObject(ref, Buffer.from(b))),
            );
            expect(results.filter((r) => r === 'created')).toHaveLength(1);
            const stored = (await readAll((await storage.managedReadStream(ref))!)).toString();
            expect(bodies).toContain(stored);
            // Whole, not a mixture of two writers' bytes.
            expect(stored).toHaveLength(16);
        }, 30_000);
    });

    describe('a refused write', () => {
        it('does not break the next managed call, nor an unrelated BYOS one', async () => {
            const publicKey = `open/${randomUUID()}`;
            await admin.putObject(publicBucket, publicKey, Buffer.from('byos-bytes'));
            const ref = `sessions/${randomUUID()}/attachments/${randomUUID()}`;
            expect(await storage.managedCreateObject(ref, Buffer.from('winner'))).toBe('created');

            // MinIO answers a refused conditional PUT with 412 and closes the
            // connection. On a shared keep-alive pool the next request to
            // reuse that socket dies with ECONNRESET — including one that has
            // nothing to do with managed storage.
            for (let round = 0; round < 3; round++) {
                expect(await storage.managedCreateObject(ref, Buffer.from('loser')))
                    .toBe('already-exists');
                expect(await storage.managedObjectSize(ref)).toBe(6);
                await expect(files.s3client.statObject(publicBucket, publicKey))
                    .resolves.toMatchObject({ size: 10 });
            }
        }, 30_000);
    });

    describe('who can read a managed object', () => {
        it('is nobody without credentials, while the public bucket is open to all', async () => {
            const ref = `sessions/${randomUUID()}/attachments/${randomUUID()}`;
            await storage.managedCreateObject(ref, Buffer.from('private-bytes'));
            const publicKey = `open/${randomUUID()}`;
            await admin.putObject(publicBucket, publicKey, Buffer.from('public-bytes'));

            // The control: the BYOS bucket really does serve anyone.
            expect(await anonymousGet(publicBucket, publicKey)).toBe(200);
            expect(await anonymousGet(privateBucket, ref)).toBe(403);
        }, 30_000);
    });

    describe('deleting a session', () => {
        it('removes the session managed objects from the managed bucket', async () => {
            const sessionId = randomUUID();
            const ref = `sessions/${sessionId}/attachments/${randomUUID()}`;
            await storage.managedCreateObject(ref, Buffer.from('should-not-survive'));
            expect(await storage.managedObjectSize(ref)).toBe(18);

            await files.deleteSessionAttachments(sessionId);

            expect(await storage.managedObjectSize(ref)).toBeNull();
        }, 30_000);
    });
});
