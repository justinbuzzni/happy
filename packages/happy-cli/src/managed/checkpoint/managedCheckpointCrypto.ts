/**
 * The envelope a managed checkpoint object is stored in — streamed, never held.
 *
 * `trialMachineSnapshot.ts` already has AES-256-GCM helpers, and they are
 * deliberately not reused for two reasons. They carry no additional data and
 * their object keys are namespaced by company, for a snapshot that spans every
 * project and the shared agent state; a Cloud checkpoint whose ciphertext does
 * not say which tenant, project, checkpoint and area it belongs to could only
 * ever have a mismatch caught by whatever named the object. And they work on
 * whole `Buffer`s, which decides the memory profile of everything above them.
 *
 * Here the binding *is* the AAD, so decryption under the wrong company,
 * project, checkpoint or area fails inside GCM before a plaintext byte exists,
 * and both directions are streams: peak memory is a chunk, not an archive.
 *
 * Layout: magic(5) ‖ iv(12) ‖ ciphertext ‖ tag(16).
 *
 * The tag is at the end because that is when GCM produces it, and that has one
 * consequence worth being explicit about: a stream cannot be authenticated
 * before it is consumed. So `openCheckpointFile` writes the plaintext to a file
 * of its own and verifies the tag *before* returning, and it deletes that file
 * if the tag does not hold. Nothing downstream ever sees unauthenticated bytes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { CheckpointArea } from './managedCheckpointScope';

const MAGIC = Buffer.from('SCKP2', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

export type CheckpointCryptoBinding = {
    companyId: string;
    projectId: string;
    checkpointId: string;
    /**
     * `manifest` is not a checkpoint area — it is the description of them, and
     * it carries project content of its own (the sanitized `.git/config`). It
     * gets its own binding value so that a manifest object and an archive
     * object can never be substituted for one another.
     */
    area: CheckpointArea | 'manifest';
};

function additionalData(binding: CheckpointCryptoBinding): Buffer {
    if (!binding.companyId || !binding.projectId || !binding.checkpointId) {
        throw new Error('managed checkpoint binding is incomplete');
    }
    // Length-prefixed so that no two different bindings can concatenate to the
    // same bytes (`co|1` + `pr` vs `co` + `1|pr`).
    const parts = [binding.companyId, binding.projectId, binding.checkpointId, binding.area];
    return Buffer.from(parts.map((part) => `${part.length}:${part}`).join(''), 'utf8');
}

function assertKey(key: Buffer): void {
    if (key.length !== 32) throw new Error('managed checkpoint key must be 32-byte');
}

/** Seals a stream into `destination`, which must not already exist. */
export async function sealCheckpointStream(input: {
    source: Readable;
    destination: string;
    key: Buffer;
    binding: CheckpointCryptoBinding;
}): Promise<{ sealedBytes: number }> {
    assertKey(input.key);
    const aad = additionalData(input.binding);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', input.key, iv);
    cipher.setAAD(aad);
    let sealedBytes = 0;
    // The destination is claimed up front, so "already there" is answered
    // before anything is written and cleanup can only ever remove a file this
    // call created. Deciding that from the error afterwards got it wrong: a
    // source that failed on its own reported something other than `EEXIST`,
    // and the cleanup then deleted a file that was never ours.
    const handle = await open(input.destination, 'wx', 0o600);
    try {
        await pipeline(
            input.source,
            cipher,
            async function* (chunks) {
                const header = Buffer.concat([MAGIC, iv]);
                sealedBytes += header.length;
                yield header;
                for await (const chunk of chunks) {
                    sealedBytes += (chunk as Buffer).length;
                    yield chunk;
                }
                // Reached only once the cipher has ended, which is when the
                // tag exists.
                const tag = cipher.getAuthTag();
                sealedBytes += tag.length;
                yield tag;
            },
            handle.createWriteStream(),
        );
    } catch (error) {
        await rm(input.destination, { force: true }).catch(() => undefined);
        throw error;
    }
    return { sealedBytes };
}

/**
 * Opens a sealed file into `destination`, returning the plaintext's size and
 * digest. The tag is verified before this resolves; on failure `destination`
 * does not survive.
 */
export async function openCheckpointFile(input: {
    source: string;
    destination: string;
    key: Buffer;
    binding: CheckpointCryptoBinding;
}): Promise<{ bytes: number; sha256: string }> {
    assertKey(input.key);
    const aad = additionalData(input.binding);
    const hash = createHash('sha256');
    let bytes = 0;
    let sourceHandle: Awaited<ReturnType<typeof open>> | null = null;
    let destinationHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        // Everything that can refuse this object is checked before a
        // destination exists — format, size, magic. Creating it first and
        // cleaning up afterwards deleted whatever happened to be at that path
        // when the refusal had nothing to do with it.
        sourceHandle = await open(input.source, 'r');
        const size = (await sourceHandle.stat()).size;
        if (size < HEADER_BYTES + AUTH_TAG_BYTES) throw new Error('format');
        const head = Buffer.allocUnsafe(HEADER_BYTES);
        await sourceHandle.read(head, 0, HEADER_BYTES, 0);
        if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('format');
        const tag = Buffer.allocUnsafe(AUTH_TAG_BYTES);
        await sourceHandle.read(tag, 0, AUTH_TAG_BYTES, size - AUTH_TAG_BYTES);

        const decipher = createDecipheriv('aes-256-gcm', input.key, head.subarray(MAGIC.length));
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);

        const bodyBytes = size - HEADER_BYTES - AUTH_TAG_BYTES;
        const body = bodyBytes === 0
            ? Readable.from([])
            : sourceHandle.createReadStream({ start: HEADER_BYTES, end: size - AUTH_TAG_BYTES - 1, autoClose: false });

        destinationHandle = await open(input.destination, 'wx', 0o600);
        await pipeline(
            body,
            decipher,
            async function* (chunks) {
                for await (const chunk of chunks) {
                    bytes += (chunk as Buffer).length;
                    hash.update(chunk as Buffer);
                    yield chunk;
                }
            },
            destinationHandle.createWriteStream(),
        );
    } catch {
        // Only if this call created it.
        if (destinationHandle) await rm(input.destination, { force: true }).catch(() => undefined);
        // One answer for every failure: which of tenant, project, checkpoint,
        // area, key or integrity was wrong is not something a caller holding
        // the ciphertext gets to learn.
        throw new Error('managed checkpoint object is not readable');
    } finally {
        await sourceHandle?.close().catch(() => undefined);
    }
    return { bytes, sha256: hash.digest('hex') };
}

/** Seals bytes already in hand — used where the plaintext is small by nature. */
export async function sealCheckpointBuffer(input: {
    plaintext: Buffer;
    destination: string;
    key: Buffer;
    binding: CheckpointCryptoBinding;
}): Promise<void> {
    await sealCheckpointStream({
        source: Readable.from([input.plaintext]),
        destination: input.destination,
        key: input.key,
        binding: input.binding,
    });
}
