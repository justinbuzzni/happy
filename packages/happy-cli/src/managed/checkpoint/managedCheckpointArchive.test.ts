import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import {
    parseManagedCheckpointManifest,
    serializeManagedCheckpointManifest,
} from './managedCheckpointManifest';
import { openCheckpointFile } from './managedCheckpointCrypto';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-archive-'));
    created.push(dir);
    return dir;
}

async function openArchive(
    product: Awaited<ReturnType<typeof createManagedCheckpoint>>,
    area: 'project' | 'provider-state',
): Promise<Buffer> {
    const plain = join(await scratch(), 'archive.tar.gz');
    await openCheckpointFile({
        source: product.objects.get(area)!,
        destination: plain,
        key,
        binding: { companyId: 'co_1', projectId: 'pr_1', checkpointId, area },
    });
    return readFile(plain);
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);

let outputSeq = 0;

async function checkpointInput(sources: { area: 'project' | 'provider-state'; root: string }[]) {
    return {
        outputDir: join(await scratch(), `out-${outputSeq += 1}`),
        checkpointId,
        tenant: { companyId: 'co_1', projectId: 'pr_1' },
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'managed-runtime@1.2.3' },
        sources,
        key,
        now: () => 1_700_000_000_000,
    };
}

describe('createManagedCheckpoint', () => {
    it('shouldArchiveProjectFilesAndGitMetadataAndRecordWhatItLeftOut', async () => {
        const root = await scratch();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
        await mkdir(join(root, 'node_modules/left-pad'), { recursive: true });
        await writeFile(join(root, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
        await mkdir(join(root, '.ssh'), { recursive: true });
        await writeFile(join(root, '.ssh/id_rsa'), 'PRIVATE');

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        const paths = result.manifest.entries.map((entry) => entry.path).sort();
        expect(paths).toContain('src/index.ts');
        expect(paths).toContain('.git/HEAD');
        expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
        expect(paths.some((path) => path.startsWith('.ssh'))).toBe(false);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: 'node_modules', reason: 'regeneratable' },
            { area: 'project', path: '.ssh', reason: 'credential' },
        ]));
    });

    it('shouldProduceAnEncryptedArchiveThatExtractsBackToTheSameContent', async () => {
        const root = await scratch();
        await mkdir(join(root, 'a/b'), { recursive: true });
        await writeFile(join(root, 'a/b/file.txt'), 'contents\n');

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const archive = await openArchive(result, 'project');

        const target = await scratch();
        await new Promise<void>((resolve, reject) => {
            const extract = tar.x({ cwd: target, strict: true, preservePaths: false });
            extract.on('end', resolve);
            extract.on('error', reject);
            extract.end(archive);
        });
        expect(await readFile(join(target, 'a/b/file.txt'), 'utf8')).toBe('contents\n');
    });

    it('shouldNotArchiveProviderCredentialsWithProviderState', async () => {
        const root = await scratch();
        await mkdir(join(root, 'sessions/s1'), { recursive: true });
        await writeFile(join(root, 'sessions/s1/rollout.jsonl'), '{}\n');
        await mkdir(join(root, 'sessions/other'), { recursive: true });
        await writeFile(join(root, 'sessions/other/rollout.jsonl'), 'someone else\n');
        await writeFile(join(root, 'auth.json'), '{"token":"secret"}');
        await writeFile(join(root, 'history.jsonl'), 'personal\n');

        const result = await createManagedCheckpoint({
            ...await checkpointInput([{ area: 'provider-state', root }]),
            providerStateSessions: ['s1'],
        });
        const archive = await openArchive(result, 'provider-state');

        expect(result.manifest.entries.map((entry) => entry.path)).toEqual(
            expect.arrayContaining(['sessions/s1/rollout.jsonl']),
        );
        expect(archive.includes(Buffer.from('secret'))).toBe(false);
        expect(archive.includes(Buffer.from('personal'))).toBe(false);
        expect(archive.includes(Buffer.from('someone else'))).toBe(false);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'provider-state', path: 'auth.json', reason: 'credential' },
            { area: 'provider-state', path: 'history.jsonl', reason: 'personal-history' },
            { area: 'provider-state', path: 'sessions/other', reason: 'not-allowlisted' },
        ]));
        // The manifest has to survive being written down and read back, which
        // is where a reason the schema does not know about actually bites: the
        // producer builds it happily and the restore side refuses to parse it.
        expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(result.manifest)))
            .toEqual(result.manifest);
    });

    it('shouldExcludeSymlinksLeavingTheAreaAndKeepInternalOnes', async () => {
        const root = await scratch();
        await mkdir(join(root, 'a'), { recursive: true });
        await writeFile(join(root, 'a/real.txt'), 'real\n');
        await symlink('../a/real.txt', join(root, 'a/inside.link'));
        await symlink('/etc/passwd', join(root, 'a/outside.link'));

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const paths = result.manifest.entries.map((entry) => entry.path);
        expect(paths).toContain('a/inside.link');
        expect(paths).not.toContain('a/outside.link');
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: 'a/outside.link', reason: 'link-escape' },
        ]));
    });

    it('shouldCarryASanitizedGitConfigInTheManifestAndKeepTheTokenOutOfTheArchive', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/config'), [
            '[remote "origin"]',
            '\turl = https://oauth2:ghp_secret_token@github.com/acme/repo.git',
            '[http "https://github.com/"]',
            '\textraHeader = Authorization: Bearer ghp_secret_token',
        ].join('\n'));

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const archive = await openArchive(result, 'project');
        const entry = result.manifest.entries.find((candidate) => candidate.path === '.git/config')!;

        expect(archive.includes(Buffer.from('ghp_secret_token'))).toBe(false);
        expect(entry.inline).toBeDefined();
        expect(entry.inline).not.toContain('ghp_secret_token');
        expect(entry.inline).toContain('url = https://github.com/acme/repo.git');
        expect(entry.sha256).toBe(createHash('sha256').update(entry.inline!).digest('hex'));
        expect(entry.bytes).toBe(Buffer.byteLength(entry.inline!));
        // Carried by the manifest, so it is not one of the archive's entries.
        expect(result.manifest.areas[0]!.entryCount)
            .toBe(result.manifest.entries.filter((candidate) => candidate.inline === undefined).length);
    });

    it('shouldRecordTheSha256OfEachArchivedFile', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'abc');
        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const entry = result.manifest.entries.find((candidate) => candidate.path === 'f.txt')!;
        expect(entry.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(entry.bytes).toBe(3);
    });

    it('shouldBindTheManifestDigestToTheProducedCheckpoint', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'abc');
        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(result.manifest.tenant).toEqual({ companyId: 'co_1', projectId: 'pr_1' });
        expect(result.manifest.image).toEqual({ imageVersion: 'managed-runtime@1.2.3' });
    });

    it('shouldNotStartArchivingBeforeTheSealedObjectPathIsClaimed', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'contents\n');
        const input = await checkpointInput([{ area: 'project', root }]);
        await mkdir(input.outputDir, { recursive: true });
        await writeFile(join(input.outputDir, 'project.tar.gz.enc'), 'someone else');

        await expect(createManagedCheckpoint(input)).rejects.toThrow();
        // Refused without producing anything, and the object that was there is
        // untouched.
        expect(await readFile(join(input.outputDir, 'project.tar.gz.enc'), 'utf8')).toBe('someone else');
    });

    it('shouldRejectAGenuineReadFailureWithoutLeavingASealedObjectBehind', async () => {
        const root = await scratch();
        await writeFile(join(root, 'readable.txt'), 'fine\n');
        const unreadable = join(root, 'locked.bin');
        await writeFile(unreadable, randomBytes(64 * 1024));
        await chmod(unreadable, 0o000);
        const input = await checkpointInput([{ area: 'project', root }]);

        try {
            // Not the size limit: a real I/O failure on the tree being read.
            await expect(createManagedCheckpoint(input)).rejects.toThrow();
        } finally {
            await chmod(unreadable, 0o600);
        }

        // Nothing half-sealed is left where a later publish would find it and
        // hand it to the store.
        await expect(stat(join(input.outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    });

    it('shouldFailClosedWhenAnAreaExceedsTheArchiveLimit', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), randomBytes(256 * 1024));
        await expect(createManagedCheckpoint({
            ...await checkpointInput([{ area: 'project', root }]),
            maxArchiveBytes: 1024,
        })).rejects.toThrow('managed checkpoint archive is too large');
    });

    it('shouldRefuseAnAreaRootThatIsMissing', async () => {
        const root = await scratch();
        await expect(createManagedCheckpoint(await checkpointInput([{ area: 'project', root: join(root, 'nope') }])))
            .rejects.toThrow('managed checkpoint area root is unusable');
    });

    it('shouldRefuseAnAreaRootReachedThroughASymlink', async () => {
        const root = await scratch();
        await mkdir(join(root, 'real'), { recursive: true });
        await symlink(join(root, 'real'), join(root, 'link'));
        await expect(createManagedCheckpoint(await checkpointInput([{ area: 'project', root: join(root, 'link') }])))
            .rejects.toThrow('managed checkpoint area root is unusable');
    });

    it('shouldNotReadAnOversizedOrIrregularWorktreePointerWhole', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git/worktrees/huge'), { recursive: true });
        // Far larger than a path, and read before the walk's size cap applies.
        await writeFile(join(root, '.git/worktrees/huge/gitdir'), Buffer.alloc(8 * 1024 * 1024, 0x41));
        await mkdir(join(root, '.git/worktrees/weird'), { recursive: true });
        await mkdir(join(root, '.git/worktrees/weird/gitdir'), { recursive: true });

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        expect(result.manifest.worktrees).toEqual([]);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: '.git/worktrees/huge', reason: 'worktree-out-of-scope' },
            { area: 'project', path: '.git/worktrees/weird', reason: 'worktree-out-of-scope' },
        ]));
        expect(result.manifest.entries.some((entry) => entry.path.startsWith('.git/worktrees/'))).toBe(false);
    });

    it('shouldNotBlockOnAWorktreePointerThatIsNotARegularFile', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git/worktrees/fifo'), { recursive: true });
        // A reader that opens this without O_NONBLOCK, or reads it whole,
        // waits for a writer that never comes — the checkpoint hangs instead
        // of refusing a pointer that cannot be one.
        execFileSync('mkfifo', [join(root, '.git/worktrees/fifo/gitdir')]);

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        expect(result.manifest.worktrees).toEqual([]);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: '.git/worktrees/fifo', reason: 'worktree-out-of-scope' },
        ]));
    }, 10_000);
});
