/**
 * The root-protected record of what a managed volume was originally made from.
 *
 * ## What this module is not
 *
 * It does not restore anything. Laying a checkpoint down is
 * `CheckpointRestoreExecutor`'s work — it has the plan, the ledger binding,
 * the safety checkpoint, the exclusion policy and an exclusive store lock,
 * and it works on the real tree rather than a map of strings. A second
 * implementation here would be a weaker one wearing the same name.
 *
 * **What that pipeline does not carry, and this record must not imply it
 * does:** the project's own `.git` is excluded from it on both sides —
 * `checkpointStore.ts` writes `.git/` into the bare store's `info/exclude`
 * (line 503) and `checkpointExclusionPolicy.ts` skips the project's `.git`
 * entry outright (line 243). So the local store is an undo history of working
 * files; it is not a backup of the original repository's metadata, remotes,
 * or worktree relations. An earlier version of this comment said the executor
 * "handles a git directory, worktrees", which read as a claim that those
 * survive a restore. They do not, and nothing here may be cited as satisfying
 * that requirement.
 *
 * A full archive — native state, environment, an encrypted remote copy, and a
 * drain — is T13's separate work. This module's scope stays where it is: the
 * empty-initialization and current-volume adoption evidence B3 needs.
 *
 * What is genuinely missing is a durable answer to a question the restore
 * pipeline does not ask: *was this volume prepared, and from what?* The parent
 * needs that before it will dispatch, it must survive the compute being
 * replaced, and it must be writable only by root. That is this file.
 *
 * ## Three answers, and why the third matters
 *
 *  - **empty-initialized** — the volume was created for this operation and had
 *    no checkpoint to restore from.
 *  - **restored** — a checkpoint was laid down and completed.
 *  - **pending / failed** — no record yet, or a record that does not hold.
 *    A half-prepared volume looks complete from the outside; a run started on
 *    it produces work against files that are silently missing.
 *
 * ## A volume outlives the compute attached to it
 *
 * The record lives on the volume, so a later boot finds it and knows the
 * volume was already prepared. `checkpointId: null` means "no checkpoint to
 * restore from", never "this volume is empty" — treating the two as the same
 * would relabel a volume full of real work as freshly initialised, and a
 * producer acting on that would clear it. So an existing record is adopted,
 * never rewritten, and the volume is left exactly as it is.
 *
 * The record describes the volume's **origin**, not its current contents: the
 * agent is supposed to change those files, and a readiness answer that
 * required the tree to stay byte-identical would refuse every runtime that had
 * done any work.
 */
import { constants, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

export const MANAGED_RESTORE_MANIFEST_VERSION = 1;

/**
 * The wire values the parent already understands.
 *
 * `pending` and `failed` are different answers, and collapsing them loses the
 * distinction the parent needs: nothing recorded yet may still become ready,
 * while a record that exists and does not hold will not.
 */
export type ManagedRestoreStatus = 'empty-initialized' | 'restored' | 'pending' | 'failed';

/** The volume a record is about, and whether this operation created it. */
export type ManagedVolumeIdentity = {
    volumeId: string;
    /** The filesystem's own identity: a provider id can be reassigned. */
    deviceUuid: string;
    /**
     * Authority from the protected bootstrap that this volume was created by
     * this operation. The absence of a record is **not** this evidence: a
     * record can be lost, and a reused volume with no record still holds real
     * work.
     */
    createdByThisOperation: boolean;
};

export type ManagedRestoreState = {
    status: ManagedRestoreStatus;
    checkpointId: string | null;
    manifestDigest: string | null;
};

export function managedRestoreManifestPath(stateDir: string): string {
    return join(stateDir, 'restore-manifest.json');
}

/** The record as stored, with the volume it was written for. */
/** Nothing recorded yet: this may still become ready. */
const PENDING: ManagedRestoreState = {
    status: 'pending', checkpointId: null, manifestDigest: null,
};

/** A record exists and does not hold: it will not become ready on its own. */
const FAILED: ManagedRestoreState = {
    status: 'failed', checkpointId: null, manifestDigest: null,
};

type RetainedRecord = { volumeId: string; deviceUuid: string; state: ManagedRestoreState };

/**
 * Reads the record through the same trusted path every root-protected read on
 * this runtime uses: every ancestor checked, the final component opened with
 * `O_NOFOLLOW`, and ownership and mode judged on the open descriptor rather
 * than on a path that may have been swapped since.
 *
 * Without that, "root-protected" is an assumption. The agent can write inside
 * the workspace, and a record it could replace is a record it could use to
 * call a half-prepared volume ready.
 */
function readRetainedRecord(
    stateDir: string,
    deps: ManagedProvisioningDeps,
): RetainedRecord | 'absent' | 'unusable' {
    const path = managedRestoreManifestPath(stateDir);
    /*
     * The **parent directory** is what gets walked, not the file.
     *
     * `trustedPathRefusal` requires every component of the chain it is given to
     * be a directory, and the chain includes the target itself. Handed a file
     * path it therefore refuses always: an existing manifest as "not a
     * directory", a missing one as ENOENT. Both completion and adoption were
     * permanently unreachable — the record could be written and never read.
     *
     * The leaf's own safety is not skipped, it is judged where it can be judged
     * atomically: `readRootProtectedFile` opens it with `O_NOFOLLOW` and gates
     * on the open descriptor rather than on a path that may have been swapped.
     * This is the same split `managedRuntimeIdentity` uses for its marker.
     */
    const untrusted = trustedPathRefusal(dirname(resolve(path)), deps.getuid(), 'unreadable', deps);
    if (untrusted) return 'unusable';

    const file = readRootProtectedFile(path, deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') return 'absent';
    if (file.kind !== 'ok') return 'unusable';

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return 'unusable';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unusable';
    const record = parsed as Record<string, unknown>;
    if (record.version !== MANAGED_RESTORE_MANIFEST_VERSION) return 'unusable';
    const volumeId = typeof record.volumeId === 'string' && record.volumeId.trim() !== ''
        ? record.volumeId
        : null;
    const deviceUuid = typeof record.deviceUuid === 'string' && record.deviceUuid.trim() !== ''
        ? record.deviceUuid
        : null;
    if (!volumeId || !deviceUuid) return 'unusable';

    if (record.status === 'empty-initialized') {
        return {
            volumeId,
            deviceUuid,
            state: { status: 'empty-initialized', checkpointId: null, manifestDigest: null },
        };
    }
    if (record.status !== 'restored') return 'unusable';

    const checkpointId = typeof record.checkpointId === 'string' ? record.checkpointId : null;
    const manifestDigest = typeof record.manifestDigest === 'string' ? record.manifestDigest : null;
    if (!checkpointId || !manifestDigest) return 'unusable';
    return { volumeId, deviceUuid, state: { status: 'restored', checkpointId, manifestDigest } };
}

/**
 * Records that this volume has been prepared, durably and exactly once.
 *
 * Called by whatever did the preparing, **after** it finished. The record is
 * the claim that the work behind it completed, so it is written last and
 * flushed — with its directory entry — before it is treated as one: a record
 * that survives a crash while the data behind it did not is the failure this
 * whole file exists to prevent.
 *
 * `wx` is the exclusivity, and it is enough here because this writes one small
 * file and never touches the workspace: there is no window in which a loser
 * could have modified anything a winner then relabels.
 */
export async function recordManagedRestoreCompletion(input: {
    stateDir: string;
    volume: ManagedVolumeIdentity;
    outcome:
        | { status: 'empty-initialized' }
        | { status: 'restored'; checkpointId: string; manifestDigest: string };
    deps: ManagedProvisioningDeps;
}): Promise<ManagedRestoreState> {
    const retained = readRetainedRecord(input.stateDir, input.deps);
    if (retained === 'unusable') {
        throw new Error('managed restore record exists and cannot be trusted');
    }
    if (retained !== 'absent') {
        // Already prepared. Adopted as it stands: the record is not rewritten,
        // and nothing about the volume is touched.
        if (retained.volumeId !== input.volume.volumeId
            || retained.deviceUuid !== input.volume.deviceUuid) {
            throw new Error('managed restore record belongs to another volume');
        }
        return retained.state;
    }
    // No record, and no authority saying this volume is new. A reused volume
    // still holds real work, and recording it as freshly initialised is the
    // step before something clears it.
    if (!input.volume.createdByThisOperation) {
        throw new Error('managed restore refused: volume was not created by this operation');
    }

    const state: ManagedRestoreState = input.outcome.status === 'empty-initialized'
        ? { status: 'empty-initialized', checkpointId: null, manifestDigest: null }
        : {
            status: 'restored',
            checkpointId: input.outcome.checkpointId,
            manifestDigest: input.outcome.manifestDigest,
        };

    const path = managedRestoreManifestPath(input.stateDir);
    const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        await handle.writeFile(JSON.stringify({
            version: MANAGED_RESTORE_MANIFEST_VERSION,
            volumeId: input.volume.volumeId,
            deviceUuid: input.volume.deviceUuid,
            ...state,
        }));
        await handle.sync();
    } finally {
        await handle.close();
    }
    // The directory entry too: without this the file can be gone after a crash
    // even though its contents were flushed.
    const dir = await fs.open(input.stateDir, constants.O_RDONLY);
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
    return state;
}

export function readManagedRestoreState(input: {
    stateDir: string;
    volume: Pick<ManagedVolumeIdentity, 'volumeId' | 'deviceUuid'>;
    deps: ManagedProvisioningDeps;
}): ManagedRestoreState {
    const retained = readRetainedRecord(input.stateDir, input.deps);
    if (retained === 'absent') return PENDING;
    if (retained === 'unusable') return FAILED;
    // A record found beside a different volume, or beside a different
    // filesystem wearing the same provider id, is a record about something
    // else — and one that is there and does not hold will not fix itself.
    if (retained.volumeId !== input.volume.volumeId
        || retained.deviceUuid !== input.volume.deviceUuid) {
        return FAILED;
    }
    return retained.state;
}
