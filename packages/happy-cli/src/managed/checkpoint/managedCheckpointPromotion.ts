/**
 * The swap: staged trees become the live ones, or nothing does.
 *
 * A restore lays down more than one tree — the project and the provider's
 * session state — and those two are one consistent moment or they are garbage.
 * A crash between them leaves a new project next to the previous run's agent
 * state, which is worse than either, because everything looks prepared.
 *
 * POSIX gives no way to swap two directories atomically, so the crash
 * consistency here is a journal rather than a syscall. Before the first rename
 * the whole plan is written down and flushed — with its directory entry — and
 * the journal advances after each area. A boot that finds one calls
 * `reconcileManagedPromotion`, which **rolls back**: the volume returns to the
 * completed state it had before the restore started, and the parent can try
 * again. Rolling forward would mean trusting staged trees that a crash may have
 * left half-written, and there is no evidence on disk that separates the two.
 *
 * The displaced tree is a sibling of its destination, never a child of the
 * staging directory. That is not a detail: staging is cleaned up on failure,
 * and a rollback that has to survive that cleanup cannot live inside it.
 */
import { lstat, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const journalSchema = z.object({
    schemaVersion: z.literal(1),
    checkpointId: z.string().min(1),
    /** Areas fully promoted so far; everything from here on is untouched. */
    promoted: z.number().int().min(0),
    /**
     * The durable decision. Until this is true a journal that survives a crash
     * means "undo"; once it is true the same journal means "finish releasing
     * the old copies". Without it, a crash between deleting the first
     * displaced tree and deleting the journal would send a reconcile down the
     * rollback path with one area's old copy already gone — restoring the
     * other and leaving a volume that is half of each.
     */
    completed: z.boolean(),
    entries: z.array(z.object({
        area: z.string().min(1),
        staged: z.string().min(1),
        destination: z.string().min(1),
        displaced: z.string().min(1),
        /** Whether the destination existed before this promotion began. */
        hadDestination: z.boolean(),
    }).strict()).min(1),
}).strict();

export type ManagedPromotionJournal = z.infer<typeof journalSchema>;
export type ManagedPromotionEntry = ManagedPromotionJournal['entries'][number];

export type ManagedPromotionDeps = {
    rename: (from: string, to: string) => Promise<void>;
    /** `null` only for `ENOENT`; every other failure is thrown. */
    statPath: (path: string) => Promise<unknown | null>;
    /** `fsync` on a file or a directory. */
    syncPath: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
};

async function fsyncPath(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

const defaultDeps: ManagedPromotionDeps = {
    rename,
    statPath: async (path) => stat(path).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
        throw error;
    }),
    syncPath: fsyncPath,
    remove: (path) => rm(path, { recursive: true, force: true }),
};

/**
 * Puts a staged tree on the disk before it is renamed into place.
 *
 * A rename is metadata; it can reach the disk before the file contents it
 * names do. Promoting an unflushed tree therefore produces, after a power cut,
 * a destination that exists and is full of zero-length or missing files —
 * while the old copy has already been renamed away.
 *
 * This costs one `fsync` per entry, which is the price of the guarantee.
 */
async function flushTree(root: string, deps: ManagedPromotionDeps): Promise<void> {
    const visit = async (path: string): Promise<void> => {
        const entry = await lstat(path);
        if (entry.isDirectory()) {
            for (const child of await readdir(path)) await visit(join(path, child));
        }
        // Symlinks are metadata of the directory that holds them, which is
        // flushed as part of that directory.
        if (entry.isSymbolicLink()) return;
        await deps.syncPath(path);
    };
    await visit(root);
}

/** Makes a rename durable: the directory entry, on both sides of the move. */
async function flushRename(from: string, to: string, deps: ManagedPromotionDeps): Promise<void> {
    await deps.syncPath(dirname(from));
    await deps.syncPath(dirname(to));
}

/**
 * `promotion-unreconciled` is the one failure that is not a clean refusal: the
 * volume is between states and the journal names where everything is. Nothing
 * may be cleaned up after it.
 */
export class ManagedPromotionError extends Error {
    constructor(readonly code: 'promotion-failed' | 'promotion-unreconciled', readonly journalPath: string) {
        super(`managed checkpoint restore refused: ${code}`);
        this.name = 'ManagedPromotionError';
    }
}

/**
 * "Is there something here?" — and only `ENOENT` answers no.
 *
 * A catch-all made every other failure mean "nothing there", which is the
 * dangerous direction: an `EIO` on the destination would make the promotion
 * skip displacing the original, and the rollback would then delete it as
 * something this run had created. The same catch-all on the displaced tree
 * turned "cannot tell" into a skipped recovery reported as success.
 */
async function exists(path: string, deps: ManagedPromotionDeps): Promise<boolean> {
    return (await deps.statPath(path)) !== null;
}

/** Durable write: content flushed, renamed into place, parent flushed. */
async function writeJournal(journalPath: string, journal: ManagedPromotionJournal): Promise<void> {
    const directory = dirname(journalPath);
    const temporary = `${journalPath}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
        await handle.writeFile(JSON.stringify(journalSchema.parse(journal)));
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(temporary, journalPath);
    const directoryHandle = await open(directory, 'r');
    try {
        await directoryHandle.sync();
    } finally {
        await directoryHandle.close();
    }
}

export function managedPromotionJournalPath(stagingRoot: string, checkpointId: string): string {
    // Beside the staging directory, not inside it: this file has to outlive
    // the cleanup of everything the restore created.
    return join(stagingRoot, `${JOURNAL_PREFIX}${checkpointId}.json`);
}

const JOURNAL_PREFIX = 'managed-checkpoint-promotion-';

/**
 * Every interrupted promotion left in a staging root.
 *
 * A boot has no checkpoint id to build a path from — the run that wrote the
 * journal is the one that died — so it needs to be told what is there rather
 * than guessing, and it should not be matching filenames itself.
 */
export async function findManagedPromotionJournals(stagingRoot: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(stagingRoot);
    } catch (error) {
        // "Never used" and "could not look" are different answers. Folding the
        // second into an empty list lets a boot start on a volume with an
        // interrupted promotion still on it.
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') return [];
        throw new Error('managed checkpoint staging root could not be read');
    }
    return names
        .filter((name) => name.startsWith(JOURNAL_PREFIX) && name.endsWith('.json'))
        .sort()
        .map((name) => join(stagingRoot, name));
}

export async function readManagedPromotionJournal(journalPath: string): Promise<ManagedPromotionJournal | null> {
    try {
        return journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw new Error('managed checkpoint promotion journal is corrupt');
    }
}

async function rollbackEntry(entry: ManagedPromotionEntry, deps: ManagedPromotionDeps): Promise<void> {
    // Idempotent by construction: it is expressed as "make the destination be
    // what it was", not as "undo the step we think we took".
    if (entry.hadDestination) {
        if (await exists(entry.displaced, deps)) {
            await deps.remove(entry.destination);
            await deps.rename(entry.displaced, entry.destination);
            await flushRename(entry.displaced, entry.destination, deps);
        }
        return;
    }
    // There was nothing here before, so the undo is a deletion — and a
    // deletion that has not reached the directory entry can come back after a
    // power cut. The journal is removed once this returns, so a resurrected
    // tree would have nothing left to recover it: an area that was supposed to
    // not exist reappears as the new checkpoint's, beside another area that
    // rolled back. The flush is not optional, and its failure is not
    // swallowed.
    await deps.remove(entry.destination);
    await deps.syncPath(dirname(entry.destination));
}

/**
 * Promotes every entry, or leaves the volume as it was.
 *
 * Throws `promotion-failed` when the rollback succeeded — the caller's volume
 * is intact and staging may be cleaned up — and `promotion-unreconciled` when
 * it did not, in which case the journal and every displaced tree must be left
 * exactly where they are.
 */
export async function promoteCheckpointTrees(input: {
    journalPath: string;
    checkpointId: string;
    entries: Omit<ManagedPromotionEntry, 'hadDestination'>[];
    deps?: Partial<ManagedPromotionDeps>;
}): Promise<void> {
    const deps = { ...defaultDeps, ...input.deps };
    const entries: ManagedPromotionEntry[] = [];
    for (const entry of input.entries) {
        try {
            entries.push({ ...entry, hadDestination: await exists(entry.destination, deps) });
        } catch {
            // Nothing has moved and no journal exists yet, so the volume is
            // exactly as it was — but this promotion cannot proceed on a
            // survey it could not take.
            throw new ManagedPromotionError('promotion-failed', input.journalPath);
        }
    }
    // Everything that is about to be renamed is on the disk first.
    for (const entry of entries) await flushTree(entry.staged, deps);

    const journal: ManagedPromotionJournal = {
        schemaVersion: 1,
        checkpointId: input.checkpointId,
        promoted: 0,
        completed: false,
        entries,
    };
    await writeJournal(input.journalPath, journal);

    try {
        for (const [index, entry] of entries.entries()) {
            if (entry.hadDestination) {
                await deps.rename(entry.destination, entry.displaced);
                await flushRename(entry.destination, entry.displaced, deps);
            }
            await deps.rename(entry.staged, entry.destination);
            await flushRename(entry.staged, entry.destination, deps);
            journal.promoted = index + 1;
            await writeJournal(input.journalPath, journal);
        }
    } catch {
        try {
            for (const entry of [...entries].reverse()) await rollbackEntry(entry, deps);
        } catch {
            // The volume is between states. The journal stays, and so does
            // everything it names: a caller that cleaned up here would be
            // deleting the only copy of the user's work.
            throw new ManagedPromotionError('promotion-unreconciled', input.journalPath);
        }
        try {
            await removeJournal(input.journalPath, deps);
        } catch {
            // The volume is back to where it started, but the record that says
            // to redo that undo is still there. Reporting success would leave
            // it to delete a later restore's tree.
            throw new ManagedPromotionError('promotion-unreconciled', input.journalPath);
        }
        throw new ManagedPromotionError('promotion-failed', input.journalPath);
    }

    // The decision, made durable before anything is released. From here a
    // journal that survives means "finish", never "undo".
    journal.completed = true;
    await writeJournal(input.journalPath, journal);
    await releaseDisplaced(entries, deps);
    // Tolerated here, and only here: a journal that says `completed` never
    // touches a destination when it is read again — a later reconcile just
    // finishes releasing the old copies. Failing a checkpoint that actually
    // succeeded would be the worse answer.
    await removeJournal(input.journalPath, deps).catch(() => undefined);
}

async function releaseDisplaced(entries: ManagedPromotionEntry[], deps: ManagedPromotionDeps): Promise<void> {
    for (const entry of entries) {
        if (entry.hadDestination) await deps.remove(entry.displaced).catch(() => undefined);
    }
}

/**
 * Removes the journal durably. Failure is **not** swallowed.
 *
 * A journal that outlives the rollback it describes is read again on the next
 * boot, and a rollback entry for an area that did not exist before says
 * "delete the destination". By then the destination can hold a *newly
 * restored* tree, so a swallowed failure here turns into deleting the user's
 * data one boot later. The caller has to decide what to do about it, which
 * means it has to be told.
 */
async function removeJournal(journalPath: string, deps: ManagedPromotionDeps): Promise<void> {
    await deps.remove(journalPath);
    // Until the parent directory entry is flushed the journal can come back.
    await deps.syncPath(dirname(journalPath));
}

/**
 * Called at boot. Finishes an interrupted promotion by undoing it, so the
 * volume is the completed state it had before the restore began.
 */
export async function reconcileManagedPromotion(
    journalPath: string,
    deps?: Partial<ManagedPromotionDeps>,
): Promise<'none' | 'completed' | 'rolled-back' | 'unreconciled'> {
    const journal = await readManagedPromotionJournal(journalPath);
    if (!journal) return 'none';
    const resolved = { ...defaultDeps, ...deps };
    if (journal.completed) {
        // The promotion finished; only the release of the old copies did not.
        await releaseDisplaced(journal.entries, resolved);
        for (const entry of journal.entries) await resolved.remove(entry.staged).catch(() => undefined);
        await removeJournal(journalPath, resolved).catch(() => undefined);
        return 'completed';
    }
    try {
        for (const entry of [...journal.entries].reverse()) await rollbackEntry(entry, resolved);
    } catch {
        return 'unreconciled';
    }
    for (const entry of journal.entries) await resolved.remove(entry.staged).catch(() => undefined);
    try {
        await removeJournal(journalPath, resolved);
    } catch {
        // The undo happened; the record of it did not go away. Left as
        // unreconciled rather than reported as done, because the next boot
        // would act on that record.
        return 'unreconciled';
    }
    return 'rolled-back';
}
