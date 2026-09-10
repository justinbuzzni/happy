/**
 * The Git half of plan §7.1 step 1, measured on a real repository rather than
 * argued from the archive's file list: a checkpoint is restored at a *different
 * absolute path* and the repository is asked, by `git` itself, what survived.
 *
 * The linked-worktree assertions are deliberately written as measurements of
 * what actually happens, including where the relation does not survive the move.
 * Recording that is the point — plan §7 forbids claiming a `worktreeId` or an
 * archive flag preserved a relation it did not.
 */
import { execFileSync } from 'node:child_process';

import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { restoreManagedCheckpoint } from './managedCheckpointRestore';

async function produce(root: string, checkpointId: string) {
    return createManagedCheckpoint({
        checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }], key, now: () => 1,
        outputDir: join(await scratch('mc-git-objects-'), 'objects'),
    });
}

async function restore(
    product: Awaited<ReturnType<typeof produce>>,
    destination: string,
    stagingRoot: string,
) {
    return restoreManagedCheckpoint({
        manifest: product.manifest,
        objects: product.objects,
        key,
        expected: { tenant, targetVolume: { volumeId: 'vol_new', deviceUuid: 'dev-new' } },
        destinations: new Map([['project' as const, destination]]),
        stagingRoot,
    });
}

const created: string[] = [];
const key = randomBytes(32);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [
        '-c', 'user.email=checkpoint@example.invalid',
        '-c', 'user.name=Checkpoint Test',
        '-c', 'commit.gpgsign=false',
        ...args,
    ], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
}

/** Strips the /private prefix macOS adds when resolving temp paths. */
function canonical(value: string): string {
    return value.split('/private/var/').join('/var/');
}

const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);

describe('managed checkpoint over a real Git repository', () => {
    it('shouldRestoreCommittedStagedUncommittedAndUntrackedStateAtADifferentAbsolutePath', async () => {
        const origin = await scratch('mc-git-origin-');
        const project = join(origin, 'project');
        await mkdir(project, { recursive: true });
        git(project, 'init', '-b', 'main');
        await writeFile(join(project, 'tracked.txt'), 'v1\n');
        await writeFile(join(project, 'asset.bin'), binary);
        git(project, 'add', 'tracked.txt', 'asset.bin');
        git(project, 'commit', '-m', 'first');
        git(project, 'branch', 'feature');
        await writeFile(join(project, 'tracked.txt'), 'v2 uncommitted\n');
        await writeFile(join(project, 'staged.txt'), 'staged\n');
        git(project, 'add', 'staged.txt');
        await writeFile(join(project, 'untracked.txt'), 'untracked\n');

        git(project, 'remote', 'add', 'origin', 'https://oauth2:ghp_secret_token@github.com/acme/repo.git');
        git(project, 'config', 'http.https://github.com/.extraHeader', 'Authorization: Bearer ghp_secret_token');

        const beforeHead = git(project, 'rev-parse', 'HEAD');
        const beforeStatus = git(project, 'status', '--porcelain');
        const beforeRefs = git(project, 'for-each-ref', '--format=%(refname) %(objectname)');
        const beforeBranch = git(project, 'rev-parse', '--abbrev-ref', 'HEAD');

        const product = await produce(project, 'a'.repeat(64));
        const elsewhere = await scratch('mc-git-restored-');
        const destination = join(elsewhere, 'different/absolute/project');
        await restore(product, destination, elsewhere);

        expect(destination).not.toBe(project);
        expect(git(destination, 'rev-parse', 'HEAD')).toBe(beforeHead);
        expect(git(destination, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(beforeBranch);
        expect(git(destination, 'status', '--porcelain')).toBe(beforeStatus);
        expect(git(destination, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(beforeRefs);
        expect(git(destination, 'fsck', '--no-progress')).toBe('');
        // The repository still knows its remote; it no longer knows the token.
        expect(await readFile(join(destination, '.git/config'), 'utf8')).not.toContain('ghp_secret_token');
        expect(git(destination, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/repo.git');
        expect(await readFile(join(destination, 'tracked.txt'), 'utf8')).toBe('v2 uncommitted\n');
        expect(await readFile(join(destination, 'untracked.txt'), 'utf8')).toBe('untracked\n');
        expect(await readFile(join(destination, 'asset.bin'))).toEqual(binary);
        expect(git(destination, 'show', 'HEAD:asset.bin' + '')).toBeDefined();
    });

    it('shouldRestoreAnInScopeLinkedWorktreeAsALiveRelationAtTheNewAbsolutePath', async () => {
        const origin = await scratch('mc-git-origin-');
        const project = join(origin, 'project');
        await mkdir(project, { recursive: true });
        git(project, 'init', '-b', 'main');
        await writeFile(join(project, 'tracked.txt'), 'v1\n');
        git(project, 'add', 'tracked.txt');
        git(project, 'commit', '-m', 'first');
        const worktree = join(project, '.worktrees/feature');
        git(project, 'worktree', 'add', worktree, '-b', 'feature');
        await writeFile(join(worktree, 'tracked.txt'), 'worktree uncommitted\n');
        await writeFile(join(worktree, 'wt-staged.txt'), 'wt staged\n');
        git(worktree, 'add', 'wt-staged.txt');
        await writeFile(join(worktree, 'wt-untracked.txt'), 'wt untracked\n');

        // A second config layer, which Git reads exactly like the main one.
        git(project, 'config', 'extensions.worktreeConfig', 'true');
        git(worktree, 'config', '--worktree', 'http.https://github.com/.extraHeader',
            'Authorization: Bearer wt_secret_token');

        const beforeWorktreeHead = git(worktree, 'rev-parse', 'HEAD');
        const beforeWorktreeStatus = git(worktree, 'status', '--porcelain');
        const beforeWorktreeBranch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD');

        const product = await produce(project, 'b'.repeat(64));
        const elsewhere = await scratch('mc-git-restored-');
        const destination = join(elsewhere, 'different/absolute/project');
        await restore(product, destination, elsewhere);
        // The machine the checkpoint came from is gone.
        await rm(origin, { recursive: true, force: true });

        // macOS reaches the temp directory through /private; git prints
        // whichever spelling it resolved. The relation is what is under test,
        // not the spelling, so both sides are normalised.
        const restoredWorktree = join(destination, '.worktrees/feature');
        expect(canonical(git(destination, 'worktree', 'list'))).toContain(canonical(restoredWorktree));
        expect(canonical(git(destination, 'worktree', 'list'))).not.toContain(canonical(worktree));
        expect(git(destination, 'worktree', 'list', '--porcelain')).not.toContain('prunable');

        expect(git(restoredWorktree, 'rev-parse', 'HEAD')).toBe(beforeWorktreeHead);
        expect(git(restoredWorktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(beforeWorktreeBranch);
        expect(git(restoredWorktree, 'status', '--porcelain')).toBe(beforeWorktreeStatus);
        expect(canonical(git(restoredWorktree, 'rev-parse', '--show-toplevel'))).toBe(canonical(restoredWorktree));
        expect(await readFile(join(restoredWorktree, 'tracked.txt'), 'utf8')).toBe('worktree uncommitted\n');
        expect(await readFile(join(restoredWorktree, 'wt-untracked.txt'), 'utf8')).toBe('wt untracked\n');
        expect(git(destination, 'fsck', '--no-progress')).toBe('');

        // The worktree's own config layer travelled without its credential.
        const worktreeConfig = await readFile(
            join(destination, '.git/worktrees/feature/config.worktree'), 'utf8',
        );
        expect(worktreeConfig).not.toContain('wt_secret_token');
        expect(git(destination, 'config', 'extensions.worktreeConfig')).toBe('true');
    });

    it('shouldRefuseToCarryAWorktreeRegistrationPointingOutsideTheArchivedRoot', async () => {
        const origin = await scratch('mc-git-origin-');
        const project = join(origin, 'project');
        await mkdir(project, { recursive: true });
        git(project, 'init', '-b', 'main');
        await writeFile(join(project, 'tracked.txt'), 'v1\n');
        git(project, 'add', 'tracked.txt');
        git(project, 'commit', '-m', 'first');
        // Outside the archived root: its working tree cannot travel, so its
        // registration must not travel either.
        git(project, 'worktree', 'add', join(origin, 'outside'), '-b', 'feature');

        const product = await produce(project, 'c'.repeat(64));
        expect(product.manifest.entries.some((entry) => entry.path.startsWith('.git/worktrees/outside'))).toBe(false);
        expect(product.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: '.git/worktrees/outside', reason: 'worktree-out-of-scope' },
        ]));
        expect(product.manifest.worktrees).toEqual([]);

        const elsewhere = await scratch('mc-git-restored-');
        const destination = join(elsewhere, 'different/absolute/project');
        await restore(product, destination, elsewhere);
        await rm(origin, { recursive: true, force: true });

        const listed = git(destination, 'worktree', 'list');
        expect(canonical(listed)).toContain(canonical(destination));
        expect(listed).not.toContain('outside');
        expect(git(destination, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
        expect(git(destination, 'for-each-ref', '--format=%(refname)')).toContain('refs/heads/feature');
    });
});
