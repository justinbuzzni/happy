/**
 * The order a runtime has to recover in, and what it is allowed to conclude.
 *
 * Four things already exist — the promotion journal, the generation fence, the
 * checkpoint source, the restore. Each is safe on its own and none of them can
 * decide when the others should run. That order is the whole of this file, and
 * getting it wrong is not a style question:
 *
 *  1. **Look for interrupted promotions.** Reading a directory changes
 *     nothing, so this may happen first.
 *  2. **Fence the older generations, before anything is changed.** A runtime
 *     that was partitioned and came back is still a process with the volume
 *     mounted. Laying a checkpoint down while it might write is the corruption
 *     AC19 is about — and so is *reconciling*, which renames the displaced
 *     tree back over the destination and removes staged ones. Reconciling
 *     ahead of the fence would be a write to a volume that might have another
 *     writer, which is the very thing being guarded against. The ledger's
 *     `proveAllBelow` is what answers it, not a database epoch — that says
 *     what the control plane believes rather than what is running.
 *  3. **Finish any interrupted promotion.** A volume caught between two trees
 *     is not something the steps below may reason about, and a journal that
 *     cannot be resolved means the only copy of somebody's work is sitting
 *     where a reconcile was going to put it back.
 *  4. **Ask what the latest checkpoint is.**
 *  5. **Restore it.**
 *
 * ## Absence, failure, and emptiness are three different answers
 *
 * A *throw* from `resolveLatest()` means the runtime could not find out — an
 * unreadable pointer, an unreachable store — and reading that as "nothing to
 * restore" initialises a volume that has real work on it.
 *
 * `null` is narrower than it looks, and this does not stretch it. Plan §5.47
 * is explicit that `currentCheckpointId === null` is **not** evidence of an
 * empty workspace: a volume can carry a project that was never checkpointed,
 * or one whose pointer was never written. So the answer here is
 * `no-checkpoint` — a statement about the pointer and nothing else.
 *
 * Deciding that a volume may be *initialised* needs a different fact, and one
 * this module has no access to: `ManagedVolumeIdentity.createdByThisOperation`,
 * the protected bootstrap's authority that this volume is new.
 * `recordManagedRestoreCompletion` already requires it and refuses without it,
 * so the mapping from `no-checkpoint` to `empty-initialized` belongs there,
 * with the caller that holds that authority.
 *
 * The volume *seal* is not that authority and must not be used as one:
 * `resolveManagedVolumeBinding` answers `seal: 'created'` for the first local
 * seal of whatever volume it observed, which includes a reused volume full of
 * somebody's work that nothing had sealed yet.
 *
 * ## What it does not do
 *
 * It does not write the completion record. `recordManagedRestoreCompletion` is
 * the claim that a volume was prepared, it belongs to the boot that owns the
 * state directory, and it must be written from what this returned rather than
 * from anything it assumed.
 */
import type { ManagedCheckpointSource } from './managedCheckpointRestore';
import type { CheckpointArea } from './managedCheckpointScope';

export type ManagedRestoreRefusal =
    | 'promotion-unreconciled'
    | 'generations-not-fenced'
    | 'latest-unavailable'
    | 'restore-failed';

export type ManagedRestoreCoordination =
    /**
     * The pointer names no checkpoint. **Not** a claim that the volume is
     * empty, prepared, or initialisable — only the caller holding
     * `createdByThisOperation` can turn this into `empty-initialized`.
     */
    | { outcome: 'no-checkpoint' }
    | {
        outcome: 'restored';
        checkpointId: string;
        manifestDigest: string;
        sourceVolume: { volumeId: string; deviceUuid: string };
    }
    | { outcome: 'refused'; reason: ManagedRestoreRefusal; detail?: string };

/** Only a code, never a message: store and provider text stops here. */
function failureCode(error: unknown, fallback: string): string {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : fallback;
}

export async function coordinateManagedRestore(input: {
    /** This generation. Everything below its epoch must be proven stopped. */
    key: { runId: string; attemptId: string; epoch: number };
    tenant: { companyId: string; projectId: string };
    /** The volume being restored onto, from the machine's boot input. */
    targetVolume: { volumeId: string; deviceUuid: string };
    stagingRoot: string;
    destinations: Map<CheckpointArea, string>;
    findJournals: (stagingRoot: string) => Promise<string[]>;
    reconcile: (journalPath: string) => Promise<'none' | 'completed' | 'rolled-back' | 'unreconciled'>;
    proveAllBelow: (belowEpoch: number) => { proven: boolean; detail: string };
    resolveLatest: ManagedCheckpointSource['resolveLatest'];
    restore: (request: {
        manifest: Awaited<ReturnType<ManagedCheckpointSource['resolveLatest']>> extends null ? never : unknown;
        objects: Map<CheckpointArea, string>;
        key: Buffer;
        expected: {
            tenant: { companyId: string; projectId: string };
            targetVolume: { volumeId: string; deviceUuid: string };
        };
        destinations: Map<CheckpointArea, string>;
        stagingRoot: string;
    }) => Promise<{
        promoted: true;
        checkpointId: string;
        manifestDigest: string;
        sourceVolume: { volumeId: string; deviceUuid: string };
        targetVolume: { volumeId: string; deviceUuid: string };
    }>;
}): Promise<ManagedRestoreCoordination> {
    // Reading is safe; the fence comes before the first change.
    const journals = await input.findJournals(input.stagingRoot);

    const fence = input.proveAllBelow(input.key.epoch);
    if (!fence.proven) {
        return { outcome: 'refused', reason: 'generations-not-fenced', detail: fence.detail };
    }

    for (const journalPath of journals) {
        const reconciled = await input.reconcile(journalPath);
        if (reconciled === 'unreconciled') {
            return { outcome: 'refused', reason: 'promotion-unreconciled' };
        }
    }

    let latest: Awaited<ReturnType<ManagedCheckpointSource['resolveLatest']>>;
    try {
        latest = await input.resolveLatest();
    } catch (error) {
        return {
            outcome: 'refused',
            reason: 'latest-unavailable',
            detail: failureCode(error, 'resolve-failed'),
        };
    }
    if (!latest) return { outcome: 'no-checkpoint' };

    try {
        const restored = await input.restore({
            manifest: latest.manifest as never,
            objects: latest.objects,
            key: latest.key,
            expected: { tenant: input.tenant, targetVolume: input.targetVolume },
            destinations: input.destinations,
            stagingRoot: input.stagingRoot,
        });
        return {
            outcome: 'restored',
            checkpointId: restored.checkpointId,
            manifestDigest: restored.manifestDigest,
            sourceVolume: restored.sourceVolume,
        };
    } catch (error) {
        return {
            outcome: 'refused',
            reason: 'restore-failed',
            detail: failureCode(error, 'restore-failed'),
        };
    }
}
