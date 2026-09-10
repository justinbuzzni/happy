/**
 * Where managed attachments live, and why it is not where the others live.
 *
 * Two boundaries have to hold at once, and neither is about the relay's own
 * checks:
 *
 *  - **Local.** `GET /files/*` serves `getLocalFilesDir()` with no bearer and
 *    no grant. A managed blob written under that root is readable by anyone
 *    holding the ref, so a revoke would change nothing. Managed blobs go to a
 *    sibling directory that route never reaches.
 *  - **S3.** The BYOS bucket is initialised with `mc anonymous set download`,
 *    which makes every object in it world-readable by URL. Managed objects
 *    therefore need a *different* bucket, and this module refuses to work
 *    until it has seen that the bucket has no policy at all.
 *
 * The privacy check is an activation check, not a continuous proof: a bucket
 * can be opened up after startup, and nothing here would notice. What it does
 * buy is that a deployment cannot start managed attachments pointed at the
 * public bucket by accident.
 *
 * Backend: MinIO, through the client this server already builds. AWS S3 is not
 * implemented — its policy model and its conditional-write behaviour are not
 * the ones validated here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { managedS3Client, isLocalStorage, getManagedFilesDir } from '@/storage/files';

export type ManagedStorageEnv = {
    S3_BUCKET?: string;
    HAPPY_MANAGED_S3_BUCKET?: string;
    /**
     * Which object store this deployment runs. Named, not implied: the policy
     * model and the conditional-write behaviour validated here are MinIO's,
     * and an AWS-configured client would otherwise pass the same check.
     */
    HAPPY_MANAGED_S3_BACKEND?: string;
};

export type ManagedStorageActivation =
    | { ok: true; mode: 'local' }
    | { ok: true; mode: 's3'; bucket: string }
    | { ok: false; reason: ManagedStorageRefusal };

export type ManagedStorageRefusal =
    | 'managed-backend-not-supported'
    | 'managed-bucket-not-configured'
    | 'managed-bucket-same-as-public'
    | 'managed-bucket-missing'
    | 'managed-bucket-has-policy'
    | 'managed-bucket-unverifiable';

/** The one object store whose policy and conditional-write behaviour is validated here. */
export const SUPPORTED_MANAGED_BACKEND = 'minio';

/**
 * Raised when the store could not answer; never read as absence.
 *
 * The message is fixed. A driver error can carry an endpoint, a bucket or the
 * credentials that reached it, and this one is allowed to surface.
 */
export class ManagedStorageUnavailable extends Error {
    constructor() {
        super('managed attachment storage unavailable');
    }
}

/** The only errors that mean an object is not there. */
export function isMissingObject(error: unknown): boolean {
    const candidate = error as { code?: unknown; name?: unknown; statusCode?: unknown } | null;
    const code = typeof candidate?.code === 'string' ? candidate.code : '';
    const name = typeof candidate?.name === 'string' ? candidate.name : '';
    return code === 'ENOENT'
        || code === 'NoSuchKey' || code === 'NotFound'
        || name === 'NoSuchKey' || name === 'NotFound'
        || candidate?.statusCode === 404;
}

/**
 * Decides whether managed attachment storage may be used at all.
 *
 * Every uncertainty refuses. A bucket that cannot be reached, a policy that
 * cannot be parsed, a permission error on the policy read — none of those are
 * evidence of privacy, and treating them as such is how a public bucket ends
 * up holding managed blobs.
 */
export async function activateManagedStorage(
    env: ManagedStorageEnv,
    client: Pick<typeof managedS3Client, 'bucketExists' | 'getBucketPolicy'> = managedS3Client,
    // Passed in so the object-store branch is reachable without a deployment
    // shaped like one; the default is what the process actually runs on.
    local: boolean = isLocalStorage(),
): Promise<ManagedStorageActivation> {
    if (local) return { ok: true, mode: 'local' };

    // Only the backend whose behaviour these checks were written against.
    if (env.HAPPY_MANAGED_S3_BACKEND?.trim() !== SUPPORTED_MANAGED_BACKEND) {
        return { ok: false, reason: 'managed-backend-not-supported' };
    }

    const bucket = env.HAPPY_MANAGED_S3_BUCKET?.trim();
    if (!bucket) return { ok: false, reason: 'managed-bucket-not-configured' };
    // The public bucket is world-readable by construction, so sharing it is
    // not a configuration choice available to anyone.
    if (bucket === env.S3_BUCKET?.trim()) {
        return { ok: false, reason: 'managed-bucket-same-as-public' };
    }

    let exists: boolean;
    try {
        exists = await client.bucketExists(bucket);
    } catch {
        return { ok: false, reason: 'managed-bucket-unverifiable' };
    }
    if (!exists) return { ok: false, reason: 'managed-bucket-missing' };

    try {
        await client.getBucketPolicy(bucket);
        // Any answer at all means a policy exists — including an empty or
        // unparseable body, which says the read succeeded and this server does
        // not understand what came back. Only the absence error below is
        // evidence that there is nothing to understand.
        return { ok: false, reason: 'managed-bucket-has-policy' };
    } catch (error) {
        const candidate = error as { code?: unknown; name?: unknown } | null;
        const isAbsent = candidate?.code === 'NoSuchBucketPolicy'
            || candidate?.name === 'NoSuchBucketPolicy';
        // Exactly "there is no policy" is the only accepted answer. A 403 says
        // this server cannot see the policy, which is not the same as there
        // not being one.
        return isAbsent
            ? { ok: true, mode: 's3', bucket }
            : { ok: false, reason: 'managed-bucket-unverifiable' };
    }
}

/**
 * Resolves a path through whatever part of it exists on disk.
 *
 * Ascends past a *missing* directory only. `EACCES`, `ELOOP` and `ENOTDIR` say
 * the path cannot be resolved, not that it is absent — falling back to a
 * lexical comparison there would compare two strings and call an overlap safe.
 */
function resolveThroughExisting(target: string): string {
    let current = path.resolve(target);
    const trailing: string[] = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...trailing.slice().reverse());
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code !== 'ENOENT') throw new ManagedStorageUnavailable();
            const parent = path.dirname(current);
            if (parent === current) throw new ManagedStorageUnavailable();
            trailing.push(path.basename(current));
            current = parent;
        }
    }
}

/**
 * Resolves a ref under the private local root.
 *
 * Realpath, not string concatenation: a symlink inside the private root that
 * points back into the public one would put the bytes exactly where they must
 * not be, and a path check on the unresolved string would not see it.
 */
export function managedLocalPath(ref: string): string {
    const root = resolveThroughExisting(getManagedFilesDir());
    // Through the filesystem, not the string: a symlink at
    // `sessions/<sid>/attachments` pointing into the public root would make a
    // lexical check pass while `wx` created the file on the other side of it.
    const full = resolveThroughExisting(path.resolve(getManagedFilesDir(), ref));
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new ManagedStorageUnavailable();
    }
    return full;
}

/** Throws when the private root and the public one are not distinct on disk. */
export function assertPrivateRootIsolated(publicRoot: string, privateRoot: string): void {
    // Either root may not exist yet, and `realpath` throws on a missing path.
    // Resolving the deepest ancestor that does exist and re-appending the rest
    // keeps both sides in the same namespace — comparing one realpath against
    // one plain resolve would call `/var/...` and `/private/var/...` distinct.
    const real = (dir: string) => resolveThroughExisting(dir);
    const pub = real(publicRoot);
    const priv = real(privateRoot);
    if (priv === pub || priv.startsWith(pub + path.sep) || pub.startsWith(priv + path.sep)) {
        throw new Error('managed attachment root overlaps the public files root');
    }
}

/**
 * Publishes a local object under a name that no one else may take.
 *
 * The bytes are written to a private temporary file and flushed before the
 * name exists at all: a link only ever appears once its content is whole, so
 * a short write or a full disk leaves the name free for the next attempt
 * instead of publishing a truncated blob that can never be replaced. The
 * link is exclusive, so a loser sees EEXIST and the winner's bytes stand.
 *
 * `wx` on the final path would not do: it creates the name before the bytes
 * land, so an interrupted write publishes a partial object and takes the name
 * for good.
 */
async function createLocalObject(fullPath: string, body: Buffer): Promise<'created' | 'already-exists'> {
    const dir = path.dirname(fullPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(fullPath)}.${randomUUID()}.part`);
    try {
        await fs.promises.writeFile(tempPath, body, { flag: 'wx' });
        const handle = await fs.promises.open(tempPath, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.link(tempPath, fullPath);
        return 'created';
    } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => { /* our own leftover */ });
    }
}

/**
 * Creates the object, or reports that the name is taken — never overwrites.
 *
 * A `stat` followed by a `put` is not write-once: two callers can both see an
 * absent object and both write, and the loser's cleanup would then delete the
 * winner's bytes. Each mode uses an exclusive create instead — locally the
 * link above, and on S3 `If-None-Match: *`, which the installed SDK forwards
 * verbatim (`isSupportedHeader` lists it, so `prependXAMZMeta` does not
 * rewrite it into `x-amz-meta-`). Whether that write is actually refused is
 * then the bucket's decision, so exclusivity there is as strong as the
 * backend's support for the header and no stronger — measured against MinIO,
 * which refuses it with `PreconditionFailed`.
 *
 * Nothing is deleted on failure. A write that did not clearly succeed leaves
 * whatever is stored alone, because it may belong to someone else.
 */
export async function managedCreateObject(
    ref: string,
    body: Buffer,
): Promise<'created' | 'already-exists'> {
    try {
        if (isLocalStorage()) {
            return await createLocalObject(managedLocalPath(ref), body);
        }
        await managedS3Client.putObject(managedBucket(), ref, body, body.length, { 'If-None-Match': '*' });
        return 'created';
    } catch (error) {
        const candidate = error as { code?: unknown; statusCode?: unknown } | null;
        if (candidate?.code === 'EEXIST'
            || candidate?.code === 'PreconditionFailed'
            || candidate?.statusCode === 412) {
            return 'already-exists';
        }
        throw new ManagedStorageUnavailable();
    }
}

export async function managedReadStream(ref: string): Promise<NodeJS.ReadableStream | null> {
    try {
        if (isLocalStorage()) {
            const fullPath = managedLocalPath(ref);
            await fs.promises.stat(fullPath);
            return fs.createReadStream(fullPath);
        }
        return await managedS3Client.getObject(managedBucket(), ref);
    } catch (error) {
        if (isMissingObject(error)) return null;
        throw new ManagedStorageUnavailable();
    }
}


/**
 * Size of a stored object, or null when it is genuinely absent.
 *
 * Anything other than a known not-found is raised, so the caller answers
 * "unavailable" rather than acting on a guess.
 */
export async function managedObjectSize(ref: string): Promise<number | null> {
    try {
        if (isLocalStorage()) {
            return (await fs.promises.stat(managedLocalPath(ref))).size;
        }
        const stat = await managedS3Client.statObject(managedBucket(), ref);
        return typeof stat?.size === 'number' ? stat.size : null;
    } catch (error) {
        if (isMissingObject(error)) return null;
        throw new ManagedStorageUnavailable();
    }
}

/**
 * The bucket managed objects live in.
 *
 * Read at call time from what activation accepted, so a route can never reach
 * the public bucket by holding an older value.
 */
let activeManagedBucket: string | null = null;

export function setManagedBucket(bucket: string | null): void {
    activeManagedBucket = bucket;
}

function managedBucket(): string {
    if (!activeManagedBucket) throw new ManagedStorageUnavailable();
    return activeManagedBucket;
}
