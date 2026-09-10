/**
 * What may enter a managed project checkpoint, decided per path.
 *
 * This is the security boundary of T13 and it is deliberately a pure decision:
 * a checkpoint that quietly carried a provider credential, another project's
 * files, or a link pointing out of the volume would be a leak that no later
 * checksum could catch, so the rule has to be testable without a filesystem
 * and without an archive.
 *
 * Two areas exist because they have opposite defaults. `project` is the user's
 * tree — everything is kept, including the project's own `.git`, because the
 * whole point of a Cloud checkpoint is that Happy's local
 * `CheckpointStore`/`CheckpointRestoreExecutor` pipeline explicitly excludes
 * `.git` (checkpointStore.ts:503, checkpointExclusionPolicy.ts:243) and so
 * cannot stand in for one. `provider-state` is the native agent state next to
 * it, where the default is the opposite: only session state travels, never the
 * credential that authenticates the account and never the personal global
 * history, which are not this project's data.
 *
 * An unsafe path is refused rather than excluded. "Excluded" is a normal
 * outcome that a caller may reasonably ignore; a path that escapes its area is
 * a producer defect, and turning it into an ordinary skip would hide it.
 */
import { posix } from 'node:path';

export type CheckpointArea = 'project' | 'provider-state';

export type CheckpointEntryType = 'file' | 'directory' | 'symlink' | 'other';

/**
 * Per-file ceiling. User binaries, Git LFS payloads and attachments above it
 * are reported individually rather than silently dropped or silently blowing
 * up the archive (plan §7).
 */
export const CHECKPOINT_MAX_FILE_BYTES = 64 * 1024 * 1024;

export type CheckpointScopeDecision =
    | { include: true; reason: 'project-file' | 'git-metadata' | 'provider-state' }
    /** Included, but only after `sanitizeGitConfig` has taken the credentials out. */
    | { include: true; reason: 'git-config'; sanitize: 'git-config' }
    | {
        include: false;
        reason: 'regeneratable' | 'credential' | 'personal-history' | 'too-large' | 'link-escape'
        | 'unsupported-type' | 'not-allowlisted';
    };

/** Trees that are rebuilt from the lockfile and toolchain that we do keep. */
const REGENERATABLE_SEGMENTS = new Set([
    'node_modules',
    '.cache',
    '.turbo',
    '.next',
    '.venv',
    '__pycache__',
]);

/** Credential material, wherever it turns up inside a checkpointed area. */
const CREDENTIAL_DIRECTORY_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);
const CREDENTIAL_PATHS = new Set([
    '.netrc',
    '.npmrc',
    '.git-credentials',
    'auth.json',
    '.credentials.json',
    '.codex/auth.json',
    '.claude/.credentials.json',
    // Git's own credential stores and the studio's repository auth material,
    // all of which live inside `.git` and would otherwise ride along with the
    // repository metadata this checkpoint exists to preserve.
    '.git/credentials',
    '.git/aplus-auth',
]);

/** Personal, account-wide history — not this project's state. */
const PROVIDER_PERSONAL_HISTORY_PATHS = new Set(['history.jsonl']);

/**
 * `provider-state` is allow-listed, not deny-listed.
 *
 * The area is the agent's own home directory: it holds this project's session
 * state next to the account's credentials, its global config and every other
 * project's sessions. A deny list there is a list of the leaks someone thought
 * of — anything added to a future provider release arrives allowed. So only
 * the named sessions travel, and the caller has to name them.
 */
const PROVIDER_STATE_SESSIONS_DIRECTORY = 'sessions';

function assertSafeRelativePath(path: string): string[] {
    const unsafe = path.length === 0
        || path.includes('\0')
        || path.startsWith('/')
        || posix.normalize(path) !== path;
    const segments = path.split('/');
    if (unsafe || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`unsafe checkpoint path: ${JSON.stringify(path)}`);
    }
    return segments;
}

function escapesArea(path: string, linkTarget: string): boolean {
    if (linkTarget.startsWith('/')) return true;
    const resolved = posix.normalize(posix.join(posix.dirname(path), linkTarget));
    return resolved === '..' || resolved.startsWith('../');
}

export function classifyCheckpointEntry(entry: {
    area: CheckpointArea;
    path: string;
    type: CheckpointEntryType;
    bytes: number;
    linkTarget?: string;
    /** Session ids this run may carry out of `provider-state`. */
    providerStateSessions?: readonly string[];
}): CheckpointScopeDecision {
    const segments = assertSafeRelativePath(entry.path);
    if (entry.type === 'other') return { include: false, reason: 'unsupported-type' };

    if (CREDENTIAL_PATHS.has(entry.path)
        || segments.some((segment) => CREDENTIAL_DIRECTORY_SEGMENTS.has(segment))) {
        return { include: false, reason: 'credential' };
    }
    if (entry.area === 'provider-state') {
        if (PROVIDER_PERSONAL_HISTORY_PATHS.has(entry.path)) {
            return { include: false, reason: 'personal-history' };
        }
        if (segments[0] !== PROVIDER_STATE_SESSIONS_DIRECTORY) {
            return { include: false, reason: 'not-allowlisted' };
        }
        if (segments.length > 1 && !(entry.providerStateSessions ?? []).includes(segments[1])) {
            return { include: false, reason: 'not-allowlisted' };
        }
    }
    if (segments.some((segment) => REGENERATABLE_SEGMENTS.has(segment))) {
        return { include: false, reason: 'regeneratable' };
    }
    if (entry.type === 'symlink') {
        if (escapesArea(entry.path, entry.linkTarget ?? '')) return { include: false, reason: 'link-escape' };
    } else if (entry.type === 'file' && entry.bytes > CHECKPOINT_MAX_FILE_BYTES) {
        return { include: false, reason: 'too-large' };
    }

    if (entry.area === 'provider-state') return { include: true, reason: 'provider-state' };
    // Every config *layer*, not just the main file. `extensions.worktreeConfig`
    // adds `.git/config.worktree`, each linked worktree gets its own, and each
    // submodule has one under `.git/modules/`. An `http.extraHeader` in any of
    // them is read by Git exactly like one in the main config, so sanitizing
    // only `.git/config` would leave the credential in a file that still works.
    if (segments[0] === '.git'
        && (segments[segments.length - 1] === 'config' || segments[segments.length - 1] === 'config.worktree')) {
        return { include: true, reason: 'git-config', sanitize: 'git-config' };
    }
    if (segments[0] === '.git') return { include: true, reason: 'git-metadata' };
    return { include: true, reason: 'project-file' };
}

/**
 * Takes the credentials out of a Git config while leaving the rest of it
 * working.
 *
 * Dropping `.git/config` outright would cost the user their remotes, branch
 * tracking and every local setting, which is exactly the repository state this
 * checkpoint exists to preserve. But the same file is where a token ends up:
 * as an `http.extraHeader`, as userinfo inside a remote URL, or through a
 * `[credential]` section pointing at a store.
 *
 * Line-oriented on purpose. A config parser that round-trips would have to
 * reproduce comments, includes and repeated keys exactly; here anything not
 * recognised as credential-bearing is passed through untouched, so an
 * unfamiliar construct survives instead of being silently rewritten.
 */
export function sanitizeGitConfig(content: string): string {
    const credentialKey = /^\s*(extraheader|password|username|token)\s*=/i;
    const sectionHeader = /^\s*\[([^\]\s]+)/;
    let inCredentialSection = false;
    return content
        .split('\n')
        .filter((line) => {
            const section = sectionHeader.exec(line);
            if (section) {
                inCredentialSection = section[1].toLowerCase() === 'credential';
                return !inCredentialSection;
            }
            if (inCredentialSection) return false;
            return !credentialKey.test(line);
        })
        .map((line) => line.replace(
            // `scheme://user:secret@host` → `scheme://host`. The userinfo is
            // the credential; the rest of the URL is the remote's identity.
            /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/g,
            '$1',
        ))
        .join('\n');
}
