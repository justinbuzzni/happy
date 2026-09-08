/**
 * Makes the chat-attachment upload directory usable inside a checkpoint
 * protected turn.
 *
 * Clients (Desktop composer attachments, review handoff) deliver a file by
 * writing it to `<project>/.aplus/uploads/` through the daemon `writeFile` RPC
 * and then referencing that path in the message. Under checkpoint protection
 * the provider does not run in the project directory at all — it runs in a
 * `git archive` extraction of the turn snapshot — so an upload is invisible
 * there, and the appearance of a new excluded entry flips the exclusion
 * fingerprint and fails every later turn with `CheckpointPolicyDriftError`.
 *
 * Both problems are solved by the mechanism ADR-059 already reserves for
 * ignored dependency/cache directories: a read-only passthrough. This module
 * writes a self-scoped `.aplus/.gitignore` (`*`) when safe and only offers the
 * narrow upload directory. When the project's root `.gitignore` ignores
 * `.aplus`, the exclusion policy can validate the narrow path through that
 * ignored ancestor without exposing sibling files.
 *
 * This runs before the exclusion baseline is built, so the files it creates are
 * part of the baseline and never read as drift.
 */
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Project-relative directory that chat attachments are uploaded into. */
export const CHECKPOINT_ATTACHMENT_UPLOAD_PATH = '.aplus/uploads';

const APLUS_DIRECTORY = '.aplus';
const SELF_SCOPED_IGNORE = '*\n';

/**
 * Prepares the upload directory and returns the narrow passthrough path to try.
 * An empty list means "no passthrough". The exclusion manifest remains the
 * authority on whether the directory is ignored, including through an ignored
 * ancestor.
 */
export async function checkpointAttachmentPassthroughCandidates(
    projectPath: string,
): Promise<string[]> {
    try {
        const aplusPath = join(projectPath, APLUS_DIRECTORY);
        // Never write through a symlinked `.aplus`: a recursive mkdir follows
        // intermediate links, so a link pointing at another project would make
        // session start create directories and an ignore rule over there. The
        // manifest checks run later and cannot undo a write.
        const aplusStats = await statIfPresent(aplusPath);
        if (aplusStats && !(aplusStats.isDirectory() && !aplusStats.isSymbolicLink())) return [];
        await mkdir(join(aplusPath, 'uploads'), { recursive: true, mode: 0o700 });
        if (!(await ensureSelfScopedIgnore(aplusPath))) return [];
        return [CHECKPOINT_ATTACHMENT_UPLOAD_PATH];
    } catch {
        return [];
    }
}

/**
 * Ensures `.aplus/.gitignore` marks the directory as ignoring everything, and
 * reports whether the narrow upload passthrough may be offered.
 *
 * Writing the rule is only safe when nothing else lives under `.aplus/`.
 * Otherwise the new rule would newly classify a project's own file there (a
 * checked-in `worktree-setup.sh`, say) as ignored, dropping it out of the turn
 * workspace and out of checkpoint snapshots — a silent loss of protection for
 * a file that has nothing to do with attachments. In that case the caller
 * offers no passthrough.
 */
async function ensureSelfScopedIgnore(aplusPath: string): Promise<boolean> {
    const existing = await readIgnoreFile(join(aplusPath, '.gitignore'));
    if (existing !== null) return ignoresEverything(existing);
    const entries = await readdir(aplusPath);
    if (entries.some((entry) => entry !== 'uploads' && entry !== '.gitignore')) return false;
    return publishIgnoreFile(aplusPath);
}

/**
 * Publishes the ignore file so no reader can observe it half-written: the
 * content is written to a scratch name first and then hard-linked into place,
 * which fails rather than clobbering if a concurrent session got there first.
 * Losing that race is success — the rule we wanted is already published.
 */
async function publishIgnoreFile(aplusPath: string): Promise<boolean> {
    const scratchPath = join(aplusPath, `.gitignore.${randomUUID()}`);
    try {
        await writeFile(scratchPath, SELF_SCOPED_IGNORE, { flag: 'wx' });
        await link(scratchPath, join(aplusPath, '.gitignore'));
        return true;
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const published = await readIgnoreFile(join(aplusPath, '.gitignore'));
        return published !== null && ignoresEverything(published);
    } finally {
        await unlink(scratchPath).catch(() => {});
    }
}

async function statIfPresent(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

async function readIgnoreFile(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Whether an existing `.aplus/.gitignore` already ignores every entry beside
 * itself. Only the unambiguous `*` form counts: anything else may deliberately
 * track something under `.aplus/`, and guessing wrong would silently drop a
 * user's file out of the checkpoint snapshot.
 */
function ignoresEverything(contents: string): boolean {
    const rules = contents
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    // A single re-inclusion is enough to keep some entry visible, so a file
    // carrying one is never "ignores everything" no matter what precedes it.
    if (rules.some((rule) => rule.startsWith('!'))) return false;
    return rules.includes('*');
}
