/**
 * Lays a managed checkpoint down — in a temporary tree first, and only then in
 * place.
 *
 * The two remote restore paths that already exist both extract straight onto
 * the target: `restoreWorkspaceRemote.ts:172` runs `tar -xzf … -C
 * "$RESOLVED_WORKSPACE_DIR"`, and `trialMachineRestoreTransfer.ts` checks the
 * archive's sha256 and then `cp -R`s it over the workspace. Either one that
 * fails half way leaves a tree that is neither the old contents nor the new
 * ones, which is exactly the outcome plan §7 forbids: on failure the existing
 * Volume and the completed checkpoint must both still be there.
 *
 * So everything is verified against the manifest in a staging tree — checksums,
 * the exact entry set, types, modes, link targets, ownership, and the scope
 * rule re-applied to what actually arrived — and the destination is not touched
 * until all of it holds. Re-applying the scope on this side is deliberate: the
 * producer already excluded credentials, and a restore that trusted the
 * producer's word for that would import whatever a forged manifest claimed.
 *
 * ## Volumes
 *
 * The checkpoint's volume and the volume being restored onto are different
 * questions and are kept apart. A checkpoint taken on a machine that was
 * destroyed is restored onto a **new** volume — that is the whole point of
 * AC08 — so the manifest's volume is only ever compared against what the caller
 * says it expects the *source* to have been, and never rewritten to match the
 * target. Anything that edited the manifest to agree with the destination would
 * turn the check into a formality.
 *
 * ## Memory
 *
 * Nothing here holds an archive. The sealed object is decrypted through a
 * stream into a staging file, and the extraction is bounded by what the
 * manifest says the archive contains: more entries, a larger file, or more
 * total bytes than were promised is a refusal partway through, not a full disk
 * followed by one.
 *
 * What this does not do is record that a restore happened. That record is
 * `recordManagedRestoreCompletion`, it is written after this returns, and it
 * is not evidence that any of the above ran.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

import { openCheckpointFile } from './managedCheckpointCrypto';
import { checkpointManifestDigest, type ManagedCheckpointManifest } from './managedCheckpointManifest';
import {
    managedPromotionJournalPath,
    promoteCheckpointTrees,
    ManagedPromotionError,
} from './managedCheckpointPromotion';
import { classifyCheckpointEntry, type CheckpointArea } from './managedCheckpointScope';

export type ManagedCheckpointRestoreCode =
    | 'tenant-mismatch'
    | 'source-volume-mismatch'
    | 'area-missing'
    | 'object-unreadable'
    | 'archive-checksum-mismatch'
    | 'extract-failed'
    | 'archive-exceeds-manifest'
    | 'missing-entry'
    | 'unexpected-entry'
    | 'entry-mismatch'
    | 'forbidden-content'
    | 'ownership-mismatch'
    | 'worktree-repair-failed'
    | 'promotion-failed'
    | 'promotion-unreconciled';

export class ManagedCheckpointRestoreError extends Error {
    constructor(readonly code: ManagedCheckpointRestoreCode) {
        // The code is the whole message. Archive contents, paths and provider
        // text are not put in front of a caller that may relay it onward.
        super(`managed checkpoint restore refused: ${code}`);
        this.name = 'ManagedCheckpointRestoreError';
    }
}

/**
 * Where a boot gets the two things a restore needs besides the key.
 *
 * Deliberately one call: a manifest fetched separately from the objects it
 * describes is a pair that can be mismatched by whoever answers second.
 *
 * `null` is not a failure. It means this project has no checkpoint to restore
 * from, which is the `empty-initialized` path — collapsing it into an error
 * would turn a new project into a failed boot, and collapsing an error into it
 * would clear a volume that has real work on it.
 *
 * The `key` is a live value for this restore only: it is never written to the
 * volume and never carried in the machine's boot input, because that file
 * outlives every checkpoint it could open. Producing it — unwrapping the data
 * key, resolving the latest pointer, fetching the objects — belongs to the
 * parent-side work that lands with T09; nothing here implements it.
 */
export type ManagedCheckpointSource = {
    resolveLatest(): Promise<null | {
        manifest: ManagedCheckpointManifest;
        /** Sealed object files already fetched onto this volume. */
        objects: Map<CheckpointArea, string>;
        key: Buffer;
    }>;
};

function refuse(code: ManagedCheckpointRestoreCode): never {
    throw new ManagedCheckpointRestoreError(code);
}

/**
 * Extraction bounded by the manifest. The archive is not allowed to be larger
 * than what it was said to contain, which is what stops a decompression bomb
 * from filling the volume before any verification runs.
 */
async function extractArchive(archivePath: string, into: string, budget: {
    entries: number;
    totalBytes: number;
    maxFileBytes: number;
}): Promise<void> {
    await mkdir(into, { recursive: true, mode: 0o700 });
    let entries = 0;
    let totalBytes = 0;
    let exceeded = false;
    try {
        await pipeline(createReadStream(archivePath), tar.x({
            cwd: into,
            strict: true,
            preservePaths: false,
            preserveOwner: false,
            // Skipping rather than throwing: an entry that breaches the budget
            // is never written, and every entry after it is skipped too, so
            // the refusal below costs at most what the manifest allowed.
            filter: (_path: string, entry: { size?: number }) => {
                if (exceeded) return false;
                entries += 1;
                totalBytes += entry.size ?? 0;
                if (entries > budget.entries
                    || totalBytes > budget.totalBytes
                    || (entry.size ?? 0) > budget.maxFileBytes) {
                    exceeded = true;
                    return false;
                }
                return true;
            },
        }));
    } catch {
        refuse('extract-failed');
    }
    if (exceeded) refuse('archive-exceeds-manifest');
}

type StagedEntry = {
    type: 'file' | 'directory' | 'symlink';
    bytes: number;
    mode: number;
    sha256: string;
    linkTarget?: string;
    uid: number;
};

async function fileDigest(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), async function* (chunks) {
        for await (const chunk of chunks) hash.update(chunk as Buffer);
    });
    return hash.digest('hex');
}

async function readStagedTree(root: string): Promise<Map<string, StagedEntry>> {
    const found = new Map<string, StagedEntry>();
    const visit = async (relative: string): Promise<void> => {
        for (const child of await readdir(relative === '' ? root : join(root, relative))) {
            const path = relative === '' ? child : `${relative}/${child}`;
            const absolute = join(root, path);
            const entry = await lstat(absolute);
            if (entry.isDirectory()) {
                found.set(path, {
                    type: 'directory', bytes: 0, mode: entry.mode & 0o7777, uid: entry.uid,
                    sha256: createHash('sha256').update('').digest('hex'),
                });
                await visit(path);
            } else if (entry.isSymbolicLink()) {
                const linkTarget = await readlink(absolute);
                found.set(path, {
                    type: 'symlink', bytes: 0, mode: entry.mode & 0o7777, uid: entry.uid, linkTarget,
                    sha256: createHash('sha256').update(linkTarget).digest('hex'),
                });
            } else if (entry.isFile()) {
                found.set(path, {
                    type: 'file', bytes: entry.size, mode: entry.mode & 0o7777, uid: entry.uid,
                    sha256: await fileDigest(absolute),
                });
            } else {
                // A device or socket cannot have come from a scope-conforming
                // producer, and there is no manifest entry it could match.
                refuse('forbidden-content');
            }
        }
    };
    await visit('');
    return found;
}

function verifyArea(
    area: CheckpointArea,
    manifest: ManagedCheckpointManifest,
    staged: Map<string, StagedEntry>,
    expectedUid: number,
    providerStateSessions: readonly string[],
): void {
    const expected = manifest.entries.filter((entry) => entry.area === area);
    // The scope rule is re-applied before anything else, because a forbidden
    // path is refused on its name alone: whether its size and mode happen to
    // agree with the manifest is not what makes it unacceptable.
    for (const entry of expected) {
        const decision = classifyCheckpointEntry({
            area,
            path: entry.path,
            type: entry.type,
            bytes: entry.bytes,
            linkTarget: entry.linkTarget,
            providerStateSessions,
        });
        if (!decision.include) refuse('forbidden-content');
    }
    for (const entry of expected) {
        const actual = staged.get(entry.path);
        if (!actual) refuse('missing-entry');
        if (actual.type !== entry.type
            || actual.sha256 !== entry.sha256
            || actual.bytes !== entry.bytes
            || actual.mode !== entry.mode
            || (entry.type === 'symlink' && actual.linkTarget !== entry.linkTarget)) {
            refuse('entry-mismatch');
        }
        if (actual.uid !== expectedUid) refuse('ownership-mismatch');
    }
    const expectedPaths = new Set(expected.map((entry) => entry.path));
    for (const path of staged.keys()) {
        if (!expectedPaths.has(path)) refuse('unexpected-entry');
    }
}

/**
 * Rebuilds the pair of absolute pointers a linked worktree is made of, at the
 * path this restore is actually landing on.
 *
 * Both files already exist in the staging tree and are only rewritten — never
 * created — so a manifest that named a worktree the archive did not carry is a
 * refusal rather than a new file appearing out of the manifest.
 */
async function repairWorktrees(
    manifest: ManagedCheckpointManifest,
    areaStaging: string,
    destination: string,
): Promise<void> {
    for (const worktree of manifest.worktrees) {
        classifyCheckpointEntry({ area: 'project', path: `${worktree.path}/.git`, type: 'file', bytes: 0 });
        const administrative = join(areaStaging, '.git/worktrees', worktree.name, 'gitdir');
        const pointer = join(areaStaging, worktree.path, '.git');
        const bothPresent = await Promise.all([
            stat(administrative).then((entry) => entry.isFile(), () => false),
            stat(pointer).then((entry) => entry.isFile(), () => false),
        ]);
        if (!bothPresent[0] || !bothPresent[1]) refuse('worktree-repair-failed');
        await writeFile(administrative, `${join(destination, worktree.path, '.git')}\n`);
        await writeFile(pointer, `gitdir: ${join(destination, '.git/worktrees', worktree.name)}\n`);
    }
}

export async function restoreManagedCheckpoint(input: {
    manifest: ManagedCheckpointManifest;
    /** Sealed object file per area. */
    objects: Map<CheckpointArea, string>;
    key: Buffer;
    expected: {
        tenant: { companyId: string; projectId: string };
        /**
         * The volume the checkpoint must have been taken on. Omitted when any
         * volume of this tenant and project is acceptable — the ordinary case
         * for restoring onto a replacement machine.
         */
        sourceVolume?: { volumeId: string; deviceUuid: string };
        /** The volume being restored onto. Never compared to the manifest. */
        targetVolume: { volumeId: string; deviceUuid: string };
    };
    destinations: Map<CheckpointArea, string>;
    /** Must be on the same filesystem as every destination — promotion renames. */
    stagingRoot: string;
    expectedUid?: number;
    providerStateSessions?: readonly string[];
    deps?: { rename?: (from: string, to: string) => Promise<void> };
}): Promise<{
    promoted: true;
    checkpointId: string;
    manifestDigest: string;
    sourceVolume: { volumeId: string; deviceUuid: string };
    targetVolume: { volumeId: string; deviceUuid: string };
}> {
    const expectedUid = input.expectedUid ?? process.getuid?.() ?? 0;
    const providerStateSessions = input.providerStateSessions ?? [];
    const manifest = input.manifest;

    if (manifest.tenant.companyId !== input.expected.tenant.companyId
        || manifest.tenant.projectId !== input.expected.tenant.projectId) {
        refuse('tenant-mismatch');
    }
    const sourceVolume = input.expected.sourceVolume;
    if (sourceVolume
        && (manifest.volume.volumeId !== sourceVolume.volumeId
            || manifest.volume.deviceUuid !== sourceVolume.deviceUuid)) {
        refuse('source-volume-mismatch');
    }

    const staging = join(input.stagingRoot, `.managed-checkpoint-${randomUUID()}`);
    let unreconciled = false;
    try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const plan: { area: CheckpointArea; staged: string; destination: string; displaced: string }[] = [];

        for (const area of manifest.areas) {
            const sealed = input.objects.get(area.area);
            const destination = input.destinations.get(area.area);
            if (!sealed || !destination) refuse('area-missing');

            const archivePath = join(staging, `${area.area}.tar.gz`);
            let opened: { bytes: number; sha256: string };
            try {
                opened = await openCheckpointFile({
                    source: sealed,
                    destination: archivePath,
                    key: input.key,
                    binding: {
                        companyId: manifest.tenant.companyId,
                        projectId: manifest.tenant.projectId,
                        checkpointId: manifest.checkpointId,
                        area: area.area,
                    },
                });
            } catch {
                refuse('object-unreadable');
            }
            if (opened.sha256 !== area.archiveSha256 || opened.bytes !== area.archiveBytes) {
                refuse('archive-checksum-mismatch');
            }

            const areaEntries = manifest.entries.filter((entry) => entry.area === area.area);
            const areaStaging = join(staging, area.area);
            await extractArchive(archivePath, areaStaging, {
                entries: area.entryCount,
                totalBytes: areaEntries.reduce((total, entry) => total + entry.bytes, 0),
                maxFileBytes: areaEntries.reduce((largest, entry) => Math.max(largest, entry.bytes), 0),
            });
            await rm(archivePath, { force: true });

            // Entries the manifest carries itself are written before
            // verification, so every entry is checked the same way.
            for (const entry of areaEntries) {
                if (entry.inline === undefined) continue;
                await mkdir(dirname(join(areaStaging, entry.path)), { recursive: true });
                await writeFile(join(areaStaging, entry.path), entry.inline, { mode: entry.mode });
            }

            verifyArea(area.area, manifest, await readStagedTree(areaStaging), expectedUid, providerStateSessions);
            if (area.area === 'project') await repairWorktrees(manifest, areaStaging, destination);

            plan.push({
                area: area.area,
                staged: areaStaging,
                destination,
                // A sibling of the destination, never a child of staging: a
                // rollback has to survive staging being cleaned up.
                displaced: `${destination}.saycode-displaced-${manifest.checkpointId.slice(0, 16)}`,
            });
            await mkdir(dirname(destination), { recursive: true });
        }

        try {
            await promoteCheckpointTrees({
                journalPath: managedPromotionJournalPath(input.stagingRoot, manifest.checkpointId),
                checkpointId: manifest.checkpointId,
                entries: plan,
                deps: input.deps,
            });
        } catch (error) {
            if (error instanceof ManagedPromotionError) {
                unreconciled = error.code === 'promotion-unreconciled';
                refuse(error.code);
            }
            throw error;
        }
    } finally {
        // Kept after an unreconciled promotion. The user's data is safe
        // either way — the displaced tree is a sibling of the destination, not
        // a child of staging — but this is the one exit that needs a person,
        // and the decrypted trees it leaves behind are what they will look at.
        if (!unreconciled) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
        promoted: true,
        checkpointId: manifest.checkpointId,
        manifestDigest: checkpointManifestDigest(manifest),
        sourceVolume: manifest.volume,
        targetVolume: input.expected.targetVolume,
    };
}
