/**
 * Moves checkpoint objects to and from the store, over URLs the parent signed.
 *
 * The runtime never holds storage credentials. It is handed pre-authorised
 * URLs and does nothing but stream bytes through them, which keeps the blast
 * radius of a compromised runtime to the objects of the run it is already
 * inside — it cannot list, reach another project's keys, or forge a URL.
 *
 * ## The latest pointer is a compare-and-set
 *
 * Two runtimes for the same project can finish a checkpoint at the same time,
 * and last-writer-wins would silently drop one of them — worse, it could make
 * an older checkpoint the current one. So the pointer is written conditionally:
 * `If-None-Match: *` to create it and `If-Match: <etag>` to replace a known
 * version. A `412` is not an error to retry blindly; it means someone else
 * moved the pointer, and the caller has to re-read before deciding.
 *
 * Verified against MinIO, which implements both preconditions.
 *
 * Everything streams. An object is a project archive, and a `Buffer` of one
 * decides the memory profile of the whole runtime.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type CheckpointFetch = typeof globalThis.fetch;

export class CheckpointObjectStoreError extends Error {
    constructor(readonly code:
        | 'upload-failed'
        | 'download-failed'
        | 'verify-failed'
        | 'missing'
        | 'object-exists') {
        // No URL, no response body: a signed URL is a credential and the
        // store's error text is not this caller's to relay.
        super(`managed checkpoint object store: ${code}`);
        this.name = 'CheckpointObjectStoreError';
    }
}

function normalizeEtag(value: string | null): string | null {
    if (!value) return null;
    return value.replace(/^W\//, '').replace(/"/g, '');
}

/**
 * The digest of a file on disk, read in chunks.
 *
 * Deliberately a separate pass from the upload. Hashing the request body as it
 * is consumed ties the digest's lifetime to the transfer's, and a `fetch` that
 * answers early — a `403` from an expired signature, say — finalises the hash
 * while the stream is still emitting, which throws
 * `ERR_CRYPTO_HASH_FINALIZED` out of a listener nobody is awaiting. The digest
 * is also a claim about the *file*, not about how much of it went out, so
 * measuring the transfer was the wrong measurement in the first place.
 */
async function fileMd5(filePath: string): Promise<string> {
    const md5 = createHash('md5');
    await pipeline(createReadStream(filePath), async function* (chunks) {
        for await (const chunk of chunks) md5.update(chunk as Buffer);
    });
    return md5.digest('hex');
}

/**
 * Streams a local file to a signed URL, returning what the store recorded.
 *
 * `ifAbsent` makes the write refuse to replace anything, which is what makes a
 * checkpoint's objects immutable. Without it two runs writing the same key
 * silently overwrite each other, and since only the pointer is a
 * compare-and-set the loser of that race can still have left its bytes behind:
 * the pointer then names one checkpoint's manifest over another's archive, and
 * nothing restores.
 */
export async function putCheckpointObject(input: {
    url: string;
    filePath: string;
    ifAbsent?: boolean;
    fetchImpl?: CheckpointFetch;
}): Promise<{ etag: string | null; bytes: number; md5: string }> {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const bytes = (await stat(input.filePath)).size;
    const md5 = await fileMd5(input.filePath);

    const source = createReadStream(input.filePath);
    let response: Response;
    try {
        response = await fetchImpl(input.url, {
            method: 'PUT',
            body: Readable.toWeb(source) as ReadableStream,
            duplex: 'half',
            headers: {
                'content-length': String(bytes),
                'content-type': 'application/octet-stream',
                ...(input.ifAbsent ? { 'if-none-match': '*' } : {}),
            },
        } as RequestInit);
    } catch {
        throw new CheckpointObjectStoreError('upload-failed');
    } finally {
        // An early response leaves the body unconsumed; without this the file
        // descriptor stays open for as long as the process does.
        if (!source.destroyed) source.destroy();
    }
    if (response.status === 412 || response.status === 409) {
        throw new CheckpointObjectStoreError('object-exists');
    }
    if (!response.ok) throw new CheckpointObjectStoreError('upload-failed');
    return { etag: normalizeEtag(response.headers.get('etag')), bytes, md5 };
}

/**
 * Confirms the store holds what was sent. The ETag of a single-part PUT is the
 * MD5 of the body, so this catches a transfer that was truncated or corrupted
 * without downloading the object again.
 */
export async function verifyCheckpointObject(input: {
    url: string;
    expect: { bytes: number; md5: string };
    fetchImpl?: CheckpointFetch;
}): Promise<void> {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetchImpl(input.url, { method: 'HEAD' });
    } catch {
        throw new CheckpointObjectStoreError('verify-failed');
    }
    if (response.status === 404) throw new CheckpointObjectStoreError('missing');
    if (!response.ok) throw new CheckpointObjectStoreError('verify-failed');
    const bytes = Number(response.headers.get('content-length'));
    const etag = normalizeEtag(response.headers.get('etag'));
    if (bytes !== input.expect.bytes) throw new CheckpointObjectStoreError('verify-failed');
    // A store that does not expose an MD5-shaped ETag (multipart, or a
    // different implementation) leaves the size as the only check; that is
    // stated here rather than dressed up as a checksum match.
    if (etag && /^[a-f0-9]{32}$/.test(etag) && etag !== input.expect.md5) {
        throw new CheckpointObjectStoreError('verify-failed');
    }
}

export async function getCheckpointObject(input: {
    url: string;
    destination: string;
    fetchImpl?: CheckpointFetch;
}): Promise<{ bytes: number; sha256: string }> {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const hash = createHash('sha256');
    let bytes = 0;

    // The request first, the file second. Cleanup is only ever allowed to
    // remove a file this call created — an `EEXIST` means the destination was
    // already someone else's, and a 404 means there was never anything to
    // write. Removing either would be deleting a file on the strength of a
    // failure that had nothing to do with it.
    let response: Response;
    try {
        response = await fetchImpl(input.url, { method: 'GET' });
    } catch {
        throw new CheckpointObjectStoreError('download-failed');
    }
    if (response.status === 404) throw new CheckpointObjectStoreError('missing');
    if (!response.ok || !response.body) throw new CheckpointObjectStoreError('download-failed');

    const handle = await open(input.destination, 'wx', 0o600).catch(() => {
        throw new CheckpointObjectStoreError('download-failed');
    });
    try {
        await pipeline(
            Readable.fromWeb(response.body as never),
            async function* (chunks) {
                for await (const chunk of chunks) {
                    bytes += (chunk as Buffer).length;
                    hash.update(chunk as Buffer);
                    yield chunk;
                }
            },
            handle.createWriteStream(),
        );
    } catch (error) {
        // This call created it, so this call removes it.
        await rm(input.destination, { force: true }).catch(() => undefined);
        if (error instanceof CheckpointObjectStoreError) throw error;
        throw new CheckpointObjectStoreError('download-failed');
    }
    return { bytes, sha256: hash.digest('hex') };
}

export type PointerWrite =
    | { ok: true; etag: string | null }
    /** Someone else moved the pointer; re-read before deciding what to do. */
    | { ok: false; reason: 'conflict' };

/**
 * Writes the latest pointer, but only if the store still holds the version the
 * caller reasoned about — `null` meaning "there was none".
 */
export async function putCheckpointPointer(input: {
    url: string;
    body: string;
    expectedEtag: string | null;
    fetchImpl?: CheckpointFetch;
}): Promise<PointerWrite> {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetchImpl(input.url, {
            method: 'PUT',
            body: input.body,
            headers: {
                'content-type': 'application/json',
                ...(input.expectedEtag === null
                    ? { 'if-none-match': '*' }
                    : { 'if-match': `"${input.expectedEtag}"` }),
            },
        });
    } catch {
        throw new CheckpointObjectStoreError('upload-failed');
    }
    if (response.status === 412 || response.status === 409) return { ok: false, reason: 'conflict' };
    if (!response.ok) throw new CheckpointObjectStoreError('upload-failed');
    return { ok: true, etag: normalizeEtag(response.headers.get('etag')) };
}

export async function readCheckpointPointer(input: {
    url: string;
    fetchImpl?: CheckpointFetch;
}): Promise<{ body: string; etag: string | null } | null> {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetchImpl(input.url, { method: 'GET' });
    } catch {
        throw new CheckpointObjectStoreError('download-failed');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new CheckpointObjectStoreError('download-failed');
    return { body: await response.text(), etag: normalizeEtag(response.headers.get('etag')) };
}
