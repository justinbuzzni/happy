/**
 * Produces a managed project checkpoint: the sealed archives and the manifest
 * that describes them.
 *
 * The walk applies `classifyCheckpointEntry` to every entry and never descends
 * into one it excluded — that is what keeps `node_modules` and `.ssh` from
 * being read at all rather than read and then dropped. Everything excluded is
 * recorded, because "this checkpoint does not contain your 900MB binary" is a
 * result the user has to be able to see (plan §7).
 *
 * ## Memory
 *
 * `tar` output goes straight through the hash and the cipher into the sealed
 * file. The archive is never a `Buffer`, so peak memory is a stream chunk
 * regardless of project size — a cap on a buffered archive would only have
 * turned an out-of-memory kill into a refusal, and neither one produces a
 * checkpoint. `maxArchiveBytes` remains, but it now bounds the *file* the
 * checkpoint would occupy, which is a different question from whether this
 * process survives making it.
 *
 * ## Linked worktrees
 *
 * A linked worktree is two absolute paths pointing at each other:
 * `.git/worktrees/<name>/gitdir` names the worktree's `.git` file, and that
 * file names the administrative directory back. Both are recorded here as a
 * path *relative to the archived root*, so a restore can rebuild the pair at
 * whatever absolute path it lands on. A registration whose worktree lives
 * outside the archived root is dropped entirely — its working tree cannot
 * travel, so carrying the registration would only deliver a pointer to a
 * directory on a machine that no longer exists.
 */
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';

import {
    checkpointManifestDigest,
    MANAGED_CHECKPOINT_MANIFEST_VERSION,
    type ManagedCheckpointEntry,
    type ManagedCheckpointManifest,
} from './managedCheckpointManifest';
import { sealCheckpointStream } from './managedCheckpointCrypto';
import { classifyCheckpointEntry, sanitizeGitConfig, type CheckpointArea } from './managedCheckpointScope';

export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export type CheckpointAreaSource = { area: CheckpointArea; root: string };

export type ManagedCheckpointProduct = {
    manifest: ManagedCheckpointManifest;
    manifestDigest: string;
    /** Sealed archive file per area. */
    objects: Map<CheckpointArea, string>;
};

type Excluded = ManagedCheckpointManifest['excluded'][number];
type WorktreeRelation = ManagedCheckpointManifest['worktrees'][number];

async function assertUsableRoot(root: string): Promise<void> {
    // `lstat`, not `stat`: a root that is itself a symlink is refused rather
    // than followed, because the tree that would get read is not the one that
    // was named. Ancestor components are not checked here — on a real host
    // they are legitimately links (`/var` → `/private/var`) — containment for
    // everything below the root comes from the walk, which never follows one.
    try {
        const stat = await lstat(root);
        if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
        throw new Error('managed checkpoint area root is unusable');
    }
}

/**
 * Reads `.git/worktrees/<name>/gitdir` for every registration and splits them
 * into the ones whose worktree lives inside the archived root and the ones
 * that do not.
 */
async function readWorktreeRelations(root: string): Promise<{
    inScope: WorktreeRelation[];
    outOfScope: string[];
}> {
    const inScope: WorktreeRelation[] = [];
    const outOfScope: string[] = [];
    let names: string[];
    try {
        names = await readdir(join(root, '.git/worktrees'));
    } catch {
        return { inScope, outOfScope };
    }
    // A `gitdir` file holds one path. Reading it whole would allocate whatever
    // is in it — and this runs before the walk that caps file sizes, so a
    // repository carrying a huge file under that name would be read in full
    // just to be rejected. Bounded, and only if it is a regular file.
    const readPointer = async (path: string): Promise<string> => {
        const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
            const limit = 4096;
            const buffer = Buffer.allocUnsafe(limit + 1);
            const read = await handle.read(buffer, 0, limit + 1, 0);
            if (read.bytesRead > limit) throw new Error('gitdir pointer is too large');
            return buffer.subarray(0, read.bytesRead).toString('utf8');
        } finally {
            await handle.close();
        }
    };

    // Both sides are resolved before they are compared. Git records whatever
    // absolute path it canonicalised to, and a root reached through a link
    // (`/var` → `/private/var`, or a symlinked workspace mount) would
    // otherwise make every registration look like it points outside.
    const canonicalRoot = await realpath(root).catch(() => resolve(root));
    for (const name of names.sort()) {
        let gitdir: string;
        try {
            gitdir = (await readPointer(join(root, '.git/worktrees', name, 'gitdir'))).trim();
        } catch {
            outOfScope.push(name);
            continue;
        }
        // `gitdir` names the worktree's own `.git` file; its directory is the
        // worktree.
        const declared = dirname(gitdir);
        const worktreePath = await realpath(declared).catch(() => resolve(declared));
        const inside = relative(canonicalRoot, worktreePath);
        if (!gitdir.startsWith('/') || inside === '' || inside.startsWith('..') || inside.startsWith('/')) {
            outOfScope.push(name);
            continue;
        }
        inScope.push({ name, path: inside });
    }
    return { inScope, outOfScope };
}

/** Hashes a file without holding it: a 2GB asset costs one chunk of memory. */
async function fileDigest(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), async function* (chunks) {
        for await (const chunk of chunks) hash.update(chunk as Buffer);
    });
    return hash.digest('hex');
}

async function walkArea(
    area: CheckpointArea,
    root: string,
    outOfScopeWorktrees: Set<string>,
    providerStateSessions: readonly string[],
): Promise<{ entries: ManagedCheckpointEntry[]; excluded: Excluded[] }> {
    const entries: ManagedCheckpointEntry[] = [];
    const excluded: Excluded[] = [];

    const visit = async (relativePath: string): Promise<void> => {
        const children = await readdir(relativePath === '' ? root : join(root, relativePath), { withFileTypes: true });
        for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
            const absolute = join(root, path);
            const stat = await lstat(absolute);
            const type = stat.isFile() ? 'file'
                : stat.isDirectory() ? 'directory'
                    : stat.isSymbolicLink() ? 'symlink' : 'other';

            if (area === 'project'
                && relativePath === '.git/worktrees'
                && outOfScopeWorktrees.has(child.name)) {
                excluded.push({ area, path, reason: 'worktree-out-of-scope' });
                continue;
            }

            const linkTarget = type === 'symlink' ? await readlink(absolute) : undefined;
            const decision = classifyCheckpointEntry({
                area, path, type, bytes: stat.size, linkTarget, providerStateSessions,
            });
            if (!decision.include) {
                excluded.push({ area, path, reason: decision.reason });
                continue;
            }
            if (type === 'directory') {
                entries.push({ area, path, type, bytes: 0, mode: stat.mode & 0o7777, sha256: EMPTY_SHA256 });
                await visit(path);
                continue;
            }
            if (type === 'symlink') {
                entries.push({
                    area,
                    path,
                    type,
                    bytes: 0,
                    mode: stat.mode & 0o7777,
                    sha256: createHash('sha256').update(linkTarget!).digest('hex'),
                    linkTarget,
                });
                continue;
            }
            if (decision.include && 'sanitize' in decision) {
                // Rewritten rather than copied, so it travels in the manifest:
                // see `inline` there.
                if (stat.size > 64 * 1024) {
                    excluded.push({ area, path, reason: 'too-large' });
                    continue;
                }
                const inline = sanitizeGitConfig(await readFile(absolute, 'utf8'));
                entries.push({
                    area,
                    path,
                    type: 'file',
                    bytes: Buffer.byteLength(inline),
                    mode: stat.mode & 0o7777,
                    sha256: createHash('sha256').update(inline).digest('hex'),
                    inline,
                });
                continue;
            }
            entries.push({
                area,
                path,
                type: 'file',
                bytes: stat.size,
                mode: stat.mode & 0o7777,
                sha256: await fileDigest(absolute),
            });
        }
    };

    await visit('');
    return { entries, excluded };
}

/**
 * The archive, produced only while it is being consumed.
 *
 * `tar.c(...)` returns a stream that starts reading the tree the moment it
 * exists, so building it up front and piping it into the sealer began the work
 * before the sealer had claimed its destination or attached a single error
 * handler. A refusal from the size limit then had nowhere to go and left the
 * process as an uncaught exception — the tar source is not one of the stages
 * `pipeline` owns, so tearing the pipeline down never reached it.
 *
 * As a generator, nothing happens until the sealer pulls: the tar stream is
 * created inside the consumer's first `next()`, every chunk is measured on the
 * way through, and a `throw` here is the pipeline's rejection rather than a
 * loose error on a stream nobody is listening to. Breaking out of the
 * `for await` — which is what a torn-down pipeline does — closes the tar
 * stream through the iterator's own `return`.
 */
function archiveSource(input: {
    root: string;
    paths: string[];
    maxArchiveBytes: number;
}): { stream: Readable; archiveBytes: () => number; digest: () => string } {
    const hash = createHash('sha256');
    let archiveBytes = 0;
    const stream = Readable.from((async function* () {
        // `portable` is off deliberately. It rewrites each entry's mode as
        // `(mode | 0o600) & ~0o22`, which turns Git's read-only loose objects
        // (0o400) into 0o600 — a checkpoint that quietly makes the user's
        // read-only files writable is not a faithful copy of the tree, and the
        // manifest's recorded mode would disagree with what a restore finds.
        // The uid/gid the header then carries are ignored on the way back out
        // (`preserveOwner: false`), and ownership is verified separately.
        const pack = tar.c(
            { cwd: input.root, gzip: true, portable: false, noDirRecurse: true, follow: false },
            input.paths,
        );
        for await (const chunk of pack) {
            const bytes = chunk as Buffer;
            archiveBytes += bytes.length;
            if (archiveBytes > input.maxArchiveBytes) {
                throw new Error('managed checkpoint archive is too large');
            }
            hash.update(bytes);
            yield bytes;
        }
    })());
    return { stream, archiveBytes: () => archiveBytes, digest: () => hash.digest('hex') };
}

export async function createManagedCheckpoint(input: {
    checkpointId: string;
    tenant: { companyId: string; projectId: string };
    volume: { volumeId: string; deviceUuid: string };
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    key: Buffer;
    /** Where the sealed archives are written. */
    outputDir: string;
    /** Session ids that may leave the `provider-state` area. */
    providerStateSessions?: readonly string[];
    now: () => number;
    maxArchiveBytes?: number;
}): Promise<ManagedCheckpointProduct> {
    const maxArchiveBytes = input.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    const entries: ManagedCheckpointEntry[] = [];
    const excluded: Excluded[] = [];
    const areas: ManagedCheckpointManifest['areas'] = [];
    const worktrees: WorktreeRelation[] = [];
    const objects = new Map<CheckpointArea, string>();
    await mkdir(input.outputDir, { recursive: true, mode: 0o700 });

    for (const source of input.sources) {
        await assertUsableRoot(source.root);
        const relations = source.area === 'project'
            ? await readWorktreeRelations(source.root)
            : { inScope: [], outOfScope: [] };
        const walked = await walkArea(
            source.area,
            source.root,
            new Set(relations.outOfScope),
            input.providerStateSessions ?? [],
        );

        const destination = join(input.outputDir, `${source.area}.tar.gz.enc`);
        const measure = archiveSource({
            root: source.root,
            // Entries carried inline are not in the tar; the archive holds
            // exactly what the manifest says it holds.
            paths: walked.entries.filter((entry) => entry.inline === undefined).map((entry) => entry.path),
            maxArchiveBytes,
        });
        await sealCheckpointStream({
            source: measure.stream,
            destination,
            key: input.key,
            binding: {
                companyId: input.tenant.companyId,
                projectId: input.tenant.projectId,
                checkpointId: input.checkpointId,
                area: source.area,
            },
        });

        areas.push({
            area: source.area,
            archiveSha256: measure.digest(),
            archiveBytes: measure.archiveBytes(),
            entryCount: walked.entries.filter((entry) => entry.inline === undefined).length,
        });
        objects.set(source.area, destination);
        entries.push(...walked.entries);
        excluded.push(...walked.excluded);
        worktrees.push(...relations.inScope);
    }

    const manifest: ManagedCheckpointManifest = {
        schemaVersion: MANAGED_CHECKPOINT_MANIFEST_VERSION,
        checkpointId: input.checkpointId,
        tenant: input.tenant,
        volume: input.volume,
        image: input.image,
        createdAtMs: input.now(),
        areas,
        entries,
        excluded,
        worktrees,
    };
    return { manifest, manifestDigest: checkpointManifestDigest(manifest), objects };
}
