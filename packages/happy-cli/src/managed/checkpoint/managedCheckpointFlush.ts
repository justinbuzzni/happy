/**
 * Makes the databases in a project safe to copy as files — and says so plainly
 * when it cannot.
 *
 * Copying a live SQLite database is copying a file whose committed state is
 * partly in a `-wal` sibling. With writers stopped, folding that WAL back into
 * the main file makes the plain copy the archive takes a consistent one; while
 * writers are running, nothing here would help, which is why the drain comes
 * first in the sequence.
 *
 * The part that matters more than the flushing is the reporting. Plan §7 is
 * explicit that unsupported engines are named rather than quietly succeeding,
 * because a checkpoint that "worked" and restores an empty database is worse
 * than one that refused: the user finds out months later. So an engine with no
 * adapter, and a missing `sqlite3` binary, both come back as `unsupported` with
 * a reason — never as `flushed`.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');

/** Files that look like a database and are worth a verdict. */
const DATABASE_SUFFIXES = ['.db', '.sqlite', '.sqlite3'];

export type CheckpointDatabase = {
    /** Relative to the scanned root. */
    path: string;
    engine: 'sqlite' | 'unknown';
};

export type CheckpointFlushResult = {
    flushed: string[];
    unsupported: { path: string; reason: 'no-adapter' | 'unknown-engine' | 'flush-failed' }[];
};

export type CheckpointFlushDeps = {
    /**
     * Runs a program without a shell. `stdout` is part of the answer, not a
     * convenience: `PRAGMA wal_checkpoint` reports whether it actually ran in
     * its result row, and exits 0 either way.
     */
    run: (program: string, args: string[]) => Promise<{ code: number; stdout: string }>;
};

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)` answers with `busy|log|checkpointed`, and a
 * `busy` of 1 means another connection held a read lock and the WAL was *not*
 * folded into the database — while `sqlite3` still exits 0. Reading only the
 * exit code therefore reports a flush that did not happen, which is precisely
 * the "empty database restores fine" outcome plan §7 forbids.
 *
 * https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
 */
function checkpointCompleted(stdout: string): boolean {
    const row = stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    if (!row) return false;
    return row.split('|')[0] === '0';
}

async function looksLikeSqlite(path: string): Promise<boolean> {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.allocUnsafe(SQLITE_MAGIC.length);
        const read = await handle.read(header, 0, SQLITE_MAGIC.length, 0);
        return read.bytesRead === SQLITE_MAGIC.length && header.equals(SQLITE_MAGIC);
    } finally {
        await handle.close();
    }
}

/**
 * Finds candidate databases by content, not only by name: the extension is a
 * hint, the magic is the answer. A `.db` that is not SQLite is reported as an
 * unknown engine rather than assumed to be one.
 */
export async function detectCheckpointDatabases(root: string): Promise<CheckpointDatabase[]> {
    const found: CheckpointDatabase[] = [];
    const visit = async (relative: string): Promise<void> => {
        let children: string[];
        try {
            children = await readdir(relative === '' ? root : join(root, relative));
        } catch {
            return;
        }
        for (const child of children.sort()) {
            const path = relative === '' ? child : `${relative}/${child}`;
            // The archive does not carry these, so their contents are not a
            // question a checkpoint has to answer.
            if (child === 'node_modules' || child === '.git') continue;
            const absolute = join(root, path);
            // `lstat`, and symlinks are skipped rather than followed. `stat`
            // would resolve a link out of the project and run a write pragma
            // against a database that is not this project's — and the archive
            // does not carry the link's target either, so there is nothing to
            // be gained by flushing it.
            const entry = await lstat(absolute).catch(() => null);
            if (!entry || entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await visit(path);
                continue;
            }
            if (!entry.isFile() || !DATABASE_SUFFIXES.some((suffix) => child.endsWith(suffix))) continue;
            found.push({ path, engine: await looksLikeSqlite(absolute).catch(() => false) ? 'sqlite' : 'unknown' });
        }
    };
    await visit('');
    return found;
}

export async function flushCheckpointDatabases(input: {
    root: string;
    deps: CheckpointFlushDeps;
}): Promise<CheckpointFlushResult> {
    const flushed: string[] = [];
    const unsupported: CheckpointFlushResult['unsupported'][number][] = [];
    for (const database of await detectCheckpointDatabases(input.root)) {
        if (database.engine !== 'sqlite') {
            unsupported.push({ path: database.path, reason: 'unknown-engine' });
            continue;
        }
        let outcome: { code: number; stdout: string };
        try {
            outcome = await input.deps.run('sqlite3', [
                join(input.root, database.path),
                'PRAGMA wal_checkpoint(TRUNCATE);',
            ]);
        } catch {
            // No adapter on this image. Reporting it as flushed would be the
            // lie this module exists to avoid.
            unsupported.push({ path: database.path, reason: 'no-adapter' });
            continue;
        }
        if (outcome.code !== 0 || !checkpointCompleted(outcome.stdout)) {
            unsupported.push({ path: database.path, reason: 'flush-failed' });
            continue;
        }
        flushed.push(database.path);
    }
    return { flushed, unsupported };
}
