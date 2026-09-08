import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointExclusionGuard } from './checkpointExclusionPolicy';
import {
    CHECKPOINT_ATTACHMENT_UPLOAD_PATH,
    checkpointAttachmentPassthroughCandidates,
} from './checkpointAttachmentPassthrough';

const POLICY = {
    secretPatterns: ['.env*'],
    maxFileBytes: 1024 * 1024,
    maxFiles: 100,
    maxTotalBytes: 16 * 1024 * 1024,
};

describe('checkpointAttachmentPassthroughCandidates', () => {
    let projectPath: string;

    beforeEach(async () => {
        projectPath = await mkdtemp(join(tmpdir(), 'happy-attachment-passthrough-'));
        await writeFile(join(projectPath, 'source.txt'), 'before');
    });

    afterEach(async () => {
        await rm(projectPath, { recursive: true, force: true });
    });

    /**
     * Mirrors how the composition picks a candidate: the exclusion manifest,
     * not this module, decides which shape a project can name.
     */
    async function firstAcceptedCandidate(candidates: string[]): Promise<string | null> {
        for (const candidate of candidates) {
            try {
                await CheckpointExclusionGuard.create({
                    projectPath,
                    ...POLICY,
                    readOnlyPassthroughPaths: [candidate],
                });
                return candidate;
            } catch {
                continue;
            }
        }
        return null;
    }

    it('creates the upload directory as a self-scoped ignored directory', async () => {
        const candidates = await checkpointAttachmentPassthroughCandidates(projectPath);

        expect(candidates[0]).toBe(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
        expect((await lstat(join(projectPath, '.aplus/uploads'))).isDirectory()).toBe(true);
        expect(await readFile(join(projectPath, '.aplus/.gitignore'), 'utf8')).toBe('*\n');
    });

    it('resolves to the narrow upload path when the root gitignore ignores .aplus', async () => {
        await writeFile(join(projectPath, '.gitignore'), 'dist/\n');

        const candidates = await checkpointAttachmentPassthroughCandidates(projectPath);

        await expect(firstAcceptedCandidate(candidates))
            .resolves.toBe(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
    });

    it('keeps the narrow upload path when the root gitignore stops the scan at .aplus', async () => {
        await writeFile(join(projectPath, '.gitignore'), '.aplus/\n');

        const candidates = await checkpointAttachmentPassthroughCandidates(projectPath);

        expect(candidates).toEqual([CHECKPOINT_ATTACHMENT_UPLOAD_PATH]);
        await expect(firstAcceptedCandidate(candidates))
            .resolves.toBe(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
    });

    it('keeps a later upload of any size out of the exclusion fingerprint', async () => {
        const candidates = await checkpointAttachmentPassthroughCandidates(projectPath);
        const accepted = await firstAcceptedCandidate(candidates);
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            ...POLICY,
            readOnlyPassthroughPaths: accepted ? [accepted] : [],
        });

        await writeFile(
            join(projectPath, '.aplus/uploads/attachment.bin'),
            Buffer.alloc(3 * 1024 * 1024, 1),
        );

        await expect(guard.dispatchAfterPolicyCheck(async () => 'dispatched'))
            .resolves.toBe('dispatched');
    });

    it('is idempotent across sessions and preserves an existing wildcard ignore', async () => {
        await checkpointAttachmentPassthroughCandidates(projectPath);

        await expect(checkpointAttachmentPassthroughCandidates(projectPath))
            .resolves.toContain(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
        expect(await readFile(join(projectPath, '.aplus/.gitignore'), 'utf8')).toBe('*\n');
    });

    it('declines rather than overwriting an existing .aplus ignore that tracks files', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus/.gitignore'), 'uploads/\n');

        await expect(checkpointAttachmentPassthroughCandidates(projectPath)).resolves.toEqual([]);
        expect(await readFile(join(projectPath, '.aplus/.gitignore'), 'utf8')).toBe('uploads/\n');
    });

    it('reads a commented wildcard as absent rather than as an ignore-everything rule', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus/.gitignore'), '# *\nkeep.txt\n');

        await expect(checkpointAttachmentPassthroughCandidates(projectPath)).resolves.toEqual([]);
    });

    it('never writes through a symlinked .aplus, even outside the project', async () => {
        const outsider = await mkdtemp(join(tmpdir(), 'happy-attachment-outsider-'));
        try {
            await symlink(outsider, join(projectPath, '.aplus'), 'dir');

            await expect(checkpointAttachmentPassthroughCandidates(projectPath)).resolves.toEqual([]);
            expect(await readdir(outsider)).toEqual([]);
        } finally {
            await rm(outsider, { recursive: true, force: true });
        }
    });

    it('declines when .aplus is occupied by a regular file', async () => {
        await writeFile(join(projectPath, '.aplus'), 'not a directory');

        await expect(checkpointAttachmentPassthroughCandidates(projectPath)).resolves.toEqual([]);
    });

    it('does not newly ignore content a project already keeps under .aplus', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus/worktree-setup.sh'), 'echo hi\n');

        const candidates = await checkpointAttachmentPassthroughCandidates(projectPath);

        await expect(readFile(join(projectPath, '.aplus/.gitignore'), 'utf8')).rejects.toThrow();
        const guard = await CheckpointExclusionGuard.create({ projectPath, ...POLICY });
        expect(guard.excludedReason('.aplus/worktree-setup.sh')).toBeNull();
        expect(candidates).not.toContain(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
    });

    it('accepts a directory another session prepared concurrently', async () => {
        await mkdir(join(projectPath, '.aplus/uploads'), { recursive: true });
        await writeFile(join(projectPath, '.aplus/.gitignore'), '*\n');

        await expect(checkpointAttachmentPassthroughCandidates(projectPath))
            .resolves.toContain(CHECKPOINT_ATTACHMENT_UPLOAD_PATH);
    });

    it('treats an ignore file that re-includes a path as not ignoring everything', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus/.gitignore'), '*\n!keep.txt\n');

        await expect(checkpointAttachmentPassthroughCandidates(projectPath)).resolves.toEqual([]);
    });

    it('declines instead of throwing when the project cannot be written to', async () => {
        const readOnlyProject = join(projectPath, 'read-only');
        await mkdir(readOnlyProject);
        await chmod(readOnlyProject, 0o500);
        try {
            await expect(checkpointAttachmentPassthroughCandidates(readOnlyProject))
                .resolves.toEqual([]);
        } finally {
            await chmod(readOnlyProject, 0o700);
        }
    });
});
