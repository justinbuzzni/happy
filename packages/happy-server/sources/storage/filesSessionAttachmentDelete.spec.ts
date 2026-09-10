/**
 * What a multi-object delete actually reports, and what we do with it.
 *
 * `removeObjects` answers HTTP 200 with a `DeleteResult` body that may carry
 * per-key `Error` entries, and the installed SDK returns those as an array
 * rather than throwing (`internal/xml-parser.js:576`). A caller that ignores
 * the return value therefore reports a successful cleanup for objects that are
 * still there — which, for a deleted session, means they stay forever.
 *
 * Driven through the real SDK against a canned S3 endpoint, so the parsing is
 * the shipped one and not a restatement of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const PUBLIC_BUCKET = 'public-fixture';
const PRIVATE_BUCKET = 'private-fixture';

const priorEnv = { ...process.env };
let server: Server;
let files: typeof import('@/storage/files');

/** Which buckets received a delete, and what the endpoint answered. */
let deletesSeen: string[] = [];
let failingBuckets = new Set<string>();

const listBody = (keys: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  ${keys.map((k) => `<Contents><Key>${k}</Key><Size>3</Size><ETag>"x"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join('')}
</ListBucketResult>`;

/** A partial failure, exactly as S3 reports one: 200 with per-key errors. */
const mixedDeleteBody = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Deleted><Key>sessions/s/attachments/a.enc</Key></Deleted>
  <Error>
    <Key>sessions/s/attachments/b.enc</Key>
    <Code>AccessDenied</Code>
    <Message>Access Denied by bucket policy for arn:aws:iam::1234:user/probe</Message>
  </Error>
</DeleteResult>`;

const cleanDeleteBody = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`;

describe('deleting the attachments of a session on an object store', () => {
    beforeAll(async () => {
        server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://placeholder');
            const bucket = url.pathname.split('/').filter(Boolean)[0] ?? '';
            if (req.method === 'POST' && url.searchParams.has('delete')) {
                deletesSeen.push(bucket);
                // Drain the request body before answering, so the socket is
                // reusable and the SDK sees a normal exchange.
                req.on('data', () => {});
                req.on('end', () => {
                    res.writeHead(200, { 'content-type': 'application/xml' })
                        .end(failingBuckets.has(bucket) ? mixedDeleteBody : cleanDeleteBody);
                });
                return;
            }
            res.writeHead(200, { 'content-type': 'application/xml' })
                .end(listBody(['sessions/s/attachments/a.enc', 'sessions/s/attachments/b.enc']));
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as { port: number }).port;

        process.env.S3_HOST = '127.0.0.1';
        process.env.S3_PORT = String(port);
        process.env.S3_USE_SSL = 'false';
        process.env.S3_ACCESS_KEY = 'fixture-access';
        process.env.S3_SECRET_KEY = 'fixture-secret';
        process.env.S3_BUCKET = PUBLIC_BUCKET;
        process.env.S3_PUBLIC_URL = `http://127.0.0.1:${port}/${PUBLIC_BUCKET}`;
        process.env.HAPPY_MANAGED_S3_BUCKET = PRIVATE_BUCKET;
        files = await import('@/storage/files');
        expect(files.isLocalStorage()).toBe(false);
    });

    afterEach(() => {
        deletesSeen = [];
        failingBuckets = new Set();
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
        for (const key of Object.keys(process.env)) {
            if (!(key in priorEnv)) delete process.env[key];
        }
        Object.assign(process.env, priorEnv);
    });

    it('succeeds only when every key was actually removed', async () => {
        await expect(files.deleteSessionAttachments(randomUUID())).resolves.toBeUndefined();
        expect(deletesSeen.sort()).toEqual([PRIVATE_BUCKET, PUBLIC_BUCKET]);
    }, 20_000);

    it('fails when the store refused a key, and says nothing about why', async () => {
        failingBuckets = new Set([PRIVATE_BUCKET]);
        await expect(files.deleteSessionAttachments(randomUUID())).rejects.toThrow(
            /failed to delete attachments for 1 storage bucket/,
        );
        await expect(files.deleteSessionAttachments(randomUUID())).rejects.not.toThrow(
            /AccessDenied|arn:aws|bucket policy/,
        );
    }, 20_000);

    it('still attempts the other bucket when one of them refuses', async () => {
        failingBuckets = new Set([PUBLIC_BUCKET]);
        await expect(files.deleteSessionAttachments(randomUUID())).rejects.toThrow();
        expect(deletesSeen.sort()).toEqual([PRIVATE_BUCKET, PUBLIC_BUCKET]);
    }, 20_000);
});
