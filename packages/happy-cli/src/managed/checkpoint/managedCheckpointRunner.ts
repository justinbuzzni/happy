/**
 * The thing a running runtime hands to whoever asks it for a checkpoint.
 *
 * Everything a checkpoint needs that does not change between checkpoints — the
 * tenant, the volume, which trees are archived, where the scratch space is —
 * is bound once, here. What the parent supplies per request is only what it
 * alone knows: which checkpoint this is, the signed URLs, and the one-use key.
 *
 * ## It owns the drain
 *
 * A drain only means something if the tool path and the checkpoint hold the
 * *same* one. Two instances would each be internally consistent and together
 * guarantee nothing, so this creates it and exposes it, rather than accepting
 * one and hoping. The tool session is given `runner.checkpointDrain` and every
 * write goes through it.
 *
 * ## One at a time
 *
 * A second checkpoint while one is running is refused by the drain itself
 * (`drain-in-progress`) rather than by a flag here — the gate is already the
 * thing that knows.
 *
 * This does not decide *when* to checkpoint. That is the parent's call,
 * arriving over RPC, and the registration of that method belongs to the daemon
 * side rather than here.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createCheckpointDrain, type CheckpointDrain } from './managedCheckpointDrain';
import type { CheckpointFlushDeps } from './managedCheckpointFlush';
import type { ManagedCheckpointManifest } from './managedCheckpointManifest';
import type { CheckpointFetch } from './managedCheckpointObjectStore';
import {
    publishManagedCheckpoint,
    type ManagedCheckpointPointer,
    type ManagedCheckpointPublishTargets,
} from './managedCheckpointPublisher';
import type { CheckpointAreaSource } from './managedCheckpointArchive';

export type ManagedCheckpointRequest = {
    checkpointId: string;
    /** Live for this checkpoint only; never written to the volume. */
    key: Buffer;
    targets: ManagedCheckpointPublishTargets;
    /** Take the checkpoint even though some databases could not be flushed. */
    acknowledgeUnsupportedDatabases?: boolean;
};

export type ManagedCheckpointRunner = {
    /** Give this to the tool session, so writes and checkpoints share one gate. */
    checkpointDrain: {
        drain: CheckpointDrain;
        writeTools: ReadonlySet<string>;
    };
    takeCheckpoint(request: ManagedCheckpointRequest): Promise<{
        manifest: ManagedCheckpointManifest;
        manifestDigest: string;
        pointer: ManagedCheckpointPointer;
    }>;
};

export function createManagedCheckpointRunner(config: {
    tenant: { companyId: string; projectId: string };
    volume: { volumeId: string; deviceUuid: string };
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    providerStateSessions?: readonly string[];
    /** Scratch space on the volume for the sealed objects. */
    workDir: string;
    /** How long a checkpoint may wait for in-flight writes. */
    drainBudgetMs: number;
    /** Which tools change the workspace; from the tool set actually served. */
    writeTools: ReadonlySet<string>;
    flushDeps: CheckpointFlushDeps;
    now: () => number;
    fetchImpl?: CheckpointFetch;
}): ManagedCheckpointRunner {
    const drain = createCheckpointDrain();
    return {
        checkpointDrain: { drain, writeTools: config.writeTools },
        async takeCheckpoint(request) {
            // Scratch space belongs to the call, not to the runner. The sealed
            // objects are written with `O_EXCL`, so a second checkpoint
            // reaching the same directory would collide with the first one's
            // leftovers and fail for a reason that has nothing to do with it.
            const workDir = join(config.workDir, `checkpoint-${randomUUID()}`);
            await mkdir(workDir, { recursive: true, mode: 0o700 });
            try {
                const published = await publishManagedCheckpoint({
                    checkpointId: request.checkpointId,
                    tenant: config.tenant,
                    volume: config.volume,
                    image: config.image,
                    sources: config.sources,
                    providerStateSessions: config.providerStateSessions,
                    key: request.key,
                    workDir,
                    drain,
                    drainBudgetMs: config.drainBudgetMs,
                    flushDeps: config.flushDeps,
                    targets: request.targets,
                    now: config.now,
                    acknowledgeUnsupportedDatabases: request.acknowledgeUnsupportedDatabases,
                    fetchImpl: config.fetchImpl,
                });
                return {
                    manifest: published.manifest,
                    manifestDigest: published.manifestDigest,
                    pointer: published.pointer,
                };
            } finally {
                // The objects are on the store now, or this checkpoint failed
                // and they are worth nothing. Either way they are not the next
                // call's business.
                await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
}
