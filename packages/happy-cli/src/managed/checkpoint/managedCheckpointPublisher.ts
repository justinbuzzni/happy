/**
 * Takes a checkpoint, in the order plan §7 specifies, and makes it the current
 * one only once all of it is on the store.
 *
 * ```
 * drain writes → flush databases → archive → upload → verify → publish manifest
 *              → compare-and-set the latest pointer → release the drain
 * ```
 *
 * The order is the correctness argument, not a style choice:
 *
 *  - **flush before archive**, because the archive copies files and a database
 *    whose committed state is still in a WAL is not in those files.
 *  - **verify before publish**, because the manifest is the claim that the
 *    objects exist and are intact; publishing it first would make a torn
 *    upload indistinguishable from a good one.
 *  - **the pointer last, and conditionally**, because the pointer is what a
 *    restore reads. Nothing incomplete is ever pointed at, and a second
 *    runtime that published while this one was working wins the race instead
 *    of being silently overwritten.
 *  - **release the drain in `finally`**, because a failed checkpoint must not
 *    leave the agent unable to write.
 *
 * An engine with no flush adapter stops this before anything is archived. Plan
 * §7 is explicit that unsupported databases are surfaced rather than quietly
 * succeeding, and the caller has to say, in as many words, that it wants a
 * checkpoint without them.
 */
import { join } from 'node:path';

import { createManagedCheckpoint, type CheckpointAreaSource } from './managedCheckpointArchive';
import { sealCheckpointBuffer } from './managedCheckpointCrypto';
import type { CheckpointDrain } from './managedCheckpointDrain';
import { flushCheckpointDatabases, type CheckpointFlushDeps, type CheckpointFlushResult } from './managedCheckpointFlush';
import { serializeManagedCheckpointManifest, type ManagedCheckpointManifest } from './managedCheckpointManifest';
import {
    putCheckpointObject,
    putCheckpointPointer,
    readCheckpointPointer,
    verifyCheckpointObject,
    type CheckpointFetch,
} from './managedCheckpointObjectStore';
import type { CheckpointArea } from './managedCheckpointScope';

export const MANAGED_CHECKPOINT_POINTER_VERSION = 1;

export class ManagedCheckpointPublishError extends Error {
    constructor(readonly code:
        | 'unsupported-database'
        | 'target-missing'
        | 'pointer-conflict'
        | 'pointer-unreadable') {
        super(`managed checkpoint publish refused: ${code}`);
        this.name = 'ManagedCheckpointPublishError';
    }
}

/** What a restore reads first: which checkpoint is current, and its digest. */
export type ManagedCheckpointPointer = {
    schemaVersion: typeof MANAGED_CHECKPOINT_POINTER_VERSION;
    checkpointId: string;
    manifestDigest: string;
    createdAtMs: number;
};

/**
 * Each object is written once and never replaced (`ifAbsent`), so the keys the
 * parent signs must be scoped to this checkpoint. Only the pointer is a
 * compare-and-set; if the objects could be overwritten, the runtime that lost
 * the pointer race could still have replaced the winner's archive underneath
 * it — a pointer naming one manifest over another's bytes, which restores as
 * nothing at all.
 *
 * A signed URL authorises **one method**. SigV4 puts the HTTP method into the
 * canonical request that is signed, so a URL minted for `PUT` is rejected for
 * `HEAD` — a store that allowed it would be one with anonymous access, where
 * the signature was never the thing granting permission. So every object needs
 * its own pair, and the verification step gets a URL of its own rather than
 * reusing the upload's.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 */
export type CheckpointObjectTarget = { putUrl: string; headUrl: string };

export type ManagedCheckpointPublishTargets = {
    objects: Map<CheckpointArea, CheckpointObjectTarget>;
    manifest: CheckpointObjectTarget;
    /** Signed PUT and GET URLs for the latest pointer. */
    pointer: { putUrl: string; getUrl: string };
};

export async function publishManagedCheckpoint(input: {
    checkpointId: string;
    tenant: { companyId: string; projectId: string };
    volume: { volumeId: string; deviceUuid: string };
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    providerStateSessions?: readonly string[];
    key: Buffer;
    /** Scratch space on the volume for the sealed objects. */
    workDir: string;
    drain: CheckpointDrain;
    drainBudgetMs: number;
    flushDeps: CheckpointFlushDeps;
    targets: ManagedCheckpointPublishTargets;
    now: () => number;
    /** Take the checkpoint even though some databases could not be flushed. */
    acknowledgeUnsupportedDatabases?: boolean;
    fetchImpl?: CheckpointFetch;
}): Promise<{
    manifest: ManagedCheckpointManifest;
    manifestDigest: string;
    pointer: ManagedCheckpointPointer;
    pointerEtag: string | null;
    flush: CheckpointFlushResult;
}> {
    const held = await input.drain.drain(input.drainBudgetMs);
    try {
        const flush: CheckpointFlushResult = { flushed: [], unsupported: [] };
        for (const source of input.sources) {
            if (source.area !== 'project') continue;
            const result = await flushCheckpointDatabases({ root: source.root, deps: input.flushDeps });
            flush.flushed.push(...result.flushed);
            flush.unsupported.push(...result.unsupported);
        }
        if (flush.unsupported.length > 0 && input.acknowledgeUnsupportedDatabases !== true) {
            throw new ManagedCheckpointPublishError('unsupported-database');
        }

        // Read the pointer before producing, so the compare-and-set below is
        // against a version this run actually reasoned about.
        let previous: { body: string; etag: string | null } | null;
        try {
            previous = await readCheckpointPointer({
                url: input.targets.pointer.getUrl,
                fetchImpl: input.fetchImpl,
            });
        } catch {
            throw new ManagedCheckpointPublishError('pointer-unreadable');
        }

        const product = await createManagedCheckpoint({
            checkpointId: input.checkpointId,
            tenant: input.tenant,
            volume: input.volume,
            image: input.image,
            sources: input.sources,
            providerStateSessions: input.providerStateSessions,
            key: input.key,
            outputDir: input.workDir,
            now: input.now,
        });

        for (const [area, filePath] of product.objects) {
            const target = input.targets.objects.get(area);
            if (!target) throw new ManagedCheckpointPublishError('target-missing');
            const sent = await putCheckpointObject({
                url: target.putUrl, filePath, ifAbsent: true, fetchImpl: input.fetchImpl,
            });
            await verifyCheckpointObject({
                url: target.headUrl,
                expect: { bytes: sent.bytes, md5: sent.md5 },
                fetchImpl: input.fetchImpl,
            });
        }

        // The manifest is sealed too: it carries the sanitized `.git/config`,
        // which is the project's content and not the store's business.
        const manifestPath = join(input.workDir, 'manifest.json.enc');
        await sealCheckpointBuffer({
            plaintext: Buffer.from(serializeManagedCheckpointManifest(product.manifest), 'utf8'),
            destination: manifestPath,
            key: input.key,
            binding: {
                companyId: input.tenant.companyId,
                projectId: input.tenant.projectId,
                checkpointId: input.checkpointId,
                area: 'manifest',
            },
        });
        const sentManifest = await putCheckpointObject({
            url: input.targets.manifest.putUrl,
            filePath: manifestPath,
            ifAbsent: true,
            fetchImpl: input.fetchImpl,
        });
        await verifyCheckpointObject({
            url: input.targets.manifest.headUrl,
            expect: { bytes: sentManifest.bytes, md5: sentManifest.md5 },
            fetchImpl: input.fetchImpl,
        });

        const pointer: ManagedCheckpointPointer = {
            schemaVersion: MANAGED_CHECKPOINT_POINTER_VERSION,
            checkpointId: input.checkpointId,
            manifestDigest: product.manifestDigest,
            createdAtMs: input.now(),
        };
        if (previous && previous.etag === null) {
            // The pointer is there and the store did not say which version.
            // Falling back to `expectedEtag: null` would send create-if-absent
            // against an object that exists — a write that can only ever fail,
            // reported as a conflict with a checkpoint nobody published. There
            // is no safe compare-and-set without a version, so this says so.
            throw new ManagedCheckpointPublishError('pointer-unreadable');
        }
        const written = await putCheckpointPointer({
            url: input.targets.pointer.putUrl,
            body: JSON.stringify(pointer),
            expectedEtag: previous?.etag ?? null,
            fetchImpl: input.fetchImpl,
        });
        if (!written.ok) {
            // Another runtime published while this one was working. Its
            // checkpoint is the current one; overwriting it here would make an
            // arbitrary one of the two win.
            throw new ManagedCheckpointPublishError('pointer-conflict');
        }

        return {
            manifest: product.manifest,
            manifestDigest: product.manifestDigest,
            pointer,
            pointerEtag: written.etag,
            flush,
        };
    } finally {
        held.release();
    }
}
