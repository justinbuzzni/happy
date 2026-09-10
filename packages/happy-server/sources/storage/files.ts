import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { Client } from 'minio';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let managedS3Client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    // Managed objects go through their own connection pool.
    //
    // A managed write is conditional (`If-None-Match: *`), and a MinIO that
    // refuses one answers 412 and closes the connection. The socket still
    // lands back in the pool, so the *next* request to reuse it dies with
    // ECONNRESET — measured, deterministic, one call per refusal. Sharing
    // `http.globalAgent` therefore lets a duplicate managed upload break an
    // unrelated BYOS request. A pool that does not reuse sockets cannot carry
    // the damage anywhere, and the BYOS client keeps the agent it always had.
    managedS3Client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
        transportAgent: s3UseSSL
            ? new https.Agent({ keepAlive: false })
            : new http.Agent({ keepAlive: false }),
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
    s3public = process.env.S3_PUBLIC_URL!;
}

export { s3client, managedS3Client, s3bucket, s3host };

export async function loadFiles() {
    if (useLocalStorage) {
        fs.mkdirSync(localFilesDir, { recursive: true });
        return;
    }
    await s3client.bucketExists(s3bucket);
}

export function getPublicUrl(filePath: string) {
    if (useLocalStorage) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
        return `${baseUrl}/files/${filePath}`;
    }
    return `${s3public}/${filePath}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

/**
 * Where managed attachments are stored on a local deployment.
 *
 * A sibling of the public files root, never inside it: `GET /files/*` serves
 * that root with no authentication, so anything under it is readable by
 * anyone holding the path.
 */
const managedFilesDir = path.join(dataDir, 'managed-files');

export function getManagedFilesDir() {
    return managedFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
}

/**
 * Delete all attachments for a session.
 * Local: removes the session attachments directory.
 * S3: deletes all objects with prefix "sessions/{sessionId}/attachments/".
 */
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
    const prefix = `sessions/${sessionId}/attachments`;
    if (useLocalStorage) {
        // Both roots. The managed one is deliberately outside the public root,
        // so a cleanup that only walked the public tree would leave managed
        // blobs behind for good — the session row is already gone by the time
        // this runs, so nothing later would know they existed.
        const results = await Promise.allSettled(
            [localFilesDir, managedFilesDir].map(async (root) => {
                const dir = path.join(root, prefix);
                await fs.promises.rm(dir, { recursive: true, force: true });
            }),
        );
        const failed = results.filter((result) => result.status === 'rejected');
        // Reported, not swallowed: an attachment that outlives its session is
        // exactly what this function exists to prevent.
        if (failed.length > 0) {
            throw new Error(`failed to delete attachments for ${failed.length} storage root(s)`);
        }
        return;
    }

    // S3: every bucket this deployment may have written the session's
    // attachments to. The managed bucket is a separate one by construction,
    // and it is read from configuration rather than from whatever managed
    // activation happened to accept: a deployment that has since turned
    // managed control off still has to be able to delete what it stored.
    const buckets = [s3bucket];
    const managed = process.env.HAPPY_MANAGED_S3_BUCKET?.trim();
    // No fallback to the public bucket when it is unset — a missing managed
    // bucket means nothing was stored there, not that it lives elsewhere.
    if (managed && managed !== s3bucket) buckets.push(managed);

    // Both are attempted even if the first fails; stopping at the first error
    // is how the other bucket keeps its copy forever.
    const results = await Promise.allSettled(
        buckets.map((bucket) => deleteBucketPrefix(bucket, prefix + '/')),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
        // Count only. A driver error carries the endpoint, the bucket and the
        // credentials that reached it, and the caller of a delete does not
        // need any of that to know the delete did not happen.
        throw new Error(`failed to delete attachments for ${failed.length} storage bucket(s)`);
    }
}

async function deleteBucketPrefix(bucket: string, prefix: string): Promise<void> {
    const stream = s3client.listObjects(bucket, prefix, true);
    const keys: string[] = await new Promise((resolve, reject) => {
        const collected: string[] = [];
        stream.on('data', (obj: { name: string }) => { if (obj.name) collected.push(obj.name); });
        stream.on('end', () => resolve(collected));
        stream.on('error', reject);
    });

    if (keys.length === 0) return;

    // A multi-object delete answers 200 even when it refused keys: the per-key
    // outcomes are in the body, and this SDK returns the refusals as an array
    // rather than throwing. Ignoring the return value would report a cleanup
    // that did not happen — and the session row is already gone, so nothing
    // later would know these objects exist.
    const refused: unknown[] = await s3client.removeObjects(bucket, keys);
    if (refused.length > 0) {
        // Count only. A per-key error carries the key, the bucket and the
        // principal that was denied.
        throw new Error(`store refused ${refused.length} of ${keys.length} object(s)`);
    }
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
