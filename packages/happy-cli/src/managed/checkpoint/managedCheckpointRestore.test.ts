import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { sealCheckpointBuffer } from './managedCheckpointCrypto';
import { restoreManagedCheckpoint, ManagedCheckpointRestoreError } from './managedCheckpointRestore';
import type { ManagedCheckpointManifest } from './managedCheckpointManifest';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-restore-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function sourceTree(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'README.md'), '# project\n');
    await symlink('../README.md', join(root, 'src/readme.link'));
    return root;
}

async function produce(root: string) {
    return createManagedCheckpoint({
        checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }], key, now: () => 1,
        outputDir: join(await scratch(), 'objects'),
    });
}

async function restoreInput(product: Awaited<ReturnType<typeof produce>>, destination: string, staging: string) {
    return {
        manifest: product.manifest,
        objects: product.objects,
        key,
        expected: { tenant, sourceVolume: volume, targetVolume: volume },
        destinations: new Map([['project' as const, destination]]),
        stagingRoot: staging,
    };
}

describe('restoreManagedCheckpoint', () => {
    it('shouldRestoreTheTreeAtADifferentAbsolutePath', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'restored/project');
        const result = await restoreManagedCheckpoint(await restoreInput(product, destination, home));

        expect(result.promoted).toBe(true);
        expect(result.manifestDigest).toBe(product.manifestDigest);
        expect(await readFile(join(destination, 'src/index.ts'), 'utf8')).toBe('export const a = 1;\n');
        expect(await readlink(join(destination, 'src/readme.link'))).toBe('../README.md');
    });

    it('shouldReplaceAnExistingTreeAndLeaveNoStagingBehind', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'stale.txt'), 'old\n');

        await restoreManagedCheckpoint(await restoreInput(product, destination, home));

        await expect(stat(join(destination, 'stale.txt'))).rejects.toThrow();
        expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# project\n');
        const leftovers = (await import('node:fs/promises')).readdir(home);
        expect((await leftovers).filter((name) => name.startsWith('.managed-checkpoint'))).toEqual([]);
    });

    it('shouldRefuseAnotherTenantsCheckpointWithoutTouchingTheVolume', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const input = await restoreInput(product, destination, home);
        await expect(restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant: { companyId: 'co_2', projectId: 'pr_1' },
                sourceVolume: volume,
                targetVolume: volume,
            },
        })).rejects.toMatchObject({ code: 'tenant-mismatch' });
        await expect(restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant,
                sourceVolume: { volumeId: 'vol_2', deviceUuid: 'dev-1' },
                targetVolume: volume,
            },
        })).rejects.toMatchObject({ code: 'source-volume-mismatch' });

        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveWhoseChecksumDoesNotMatchTheManifest', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const otherTree = await scratch();
        await writeFile(join(otherTree, 'src'), 'not the same archive\n');
        const swapped = await createManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root: otherTree }], key, now: () => 1,
            outputDir: join(await scratch(), 'objects'),
        });

        const input = await restoreInput(product, destination, home);
        await expect(restoreManagedCheckpoint({ ...input, objects: swapped.objects }))
            .rejects.toMatchObject({ code: 'archive-checksum-mismatch' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveCarryingContentTheScopeForbids', async () => {
        const root = await scratch();
        await mkdir(join(root, '.ssh'), { recursive: true });
        await writeFile(join(root, '.ssh/id_rsa'), 'PRIVATE');
        await writeFile(join(root, 'ok.txt'), 'ok\n');
        const honest = await produce(root);

        // Forge a manifest+archive pair whose producer did not exclude it.
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: root, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['ok.txt', '.ssh', '.ssh/id_rsa']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const empty = createHash('sha256').update('').digest('hex');
        const forged: ManagedCheckpointManifest = {
            ...honest.manifest,
            areas: [{
                area: 'project',
                archiveSha256: createHash('sha256').update(archive).digest('hex'),
                archiveBytes: archive.length,
                entryCount: 3,
            }],
            entries: [
                ...honest.manifest.entries,
                { area: 'project', path: '.ssh', type: 'directory', bytes: 0, mode: 0o755, sha256: empty },
                {
                    area: 'project', path: '.ssh/id_rsa', type: 'file', bytes: 7, mode: 0o644,
                    sha256: createHash('sha256').update('PRIVATE').digest('hex'),
                },
            ],
            excluded: [],
        };
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');
        const sealed = join(await scratch(), 'forged.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });

        await expect(restoreManagedCheckpoint({
            manifest: forged,
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, destination]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'forbidden-content' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveThatHoldsMoreThanTheManifestPromised', async () => {
        const root = await scratch();
        await writeFile(join(root, 'small.txt'), 'small\n');
        const honest = await produce(root);

        // The manifest still describes one small file; the archive does not.
        const bomb = await scratch();
        await writeFile(join(bomb, 'small.txt'), 'small\n');
        await writeFile(join(bomb, 'payload.bin'), Buffer.alloc(4 * 1024 * 1024, 0x41));
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: bomb, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['small.txt', 'payload.bin']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'bomb.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: honest.manifest.areas[0]!.entryCount,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRefuseAnArchiveHoldingMoreEntriesThanTheManifestPromised', async () => {
        const root = await scratch();
        await writeFile(join(root, 'only.txt'), 'only\n');
        const honest = await produce(root);

        const many = await scratch();
        await writeFile(join(many, 'only.txt'), 'only\n');
        const names = ['only.txt'];
        for (let index = 0; index < 200; index += 1) {
            await writeFile(join(many, `extra-${index}.txt`), '');
            names.push(`extra-${index}.txt`);
        }
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: many, gzip: true, portable: false, noDirRecurse: true, follow: false }, names);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'many.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: 1,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRefuseAnArchiveWhoseTotalIsLargerEvenWhenEveryFileAndTheCountFit', async () => {
        const root = await scratch();
        await writeFile(join(root, 'a.bin'), Buffer.alloc(1024 * 1024, 0x41));
        await writeFile(join(root, 'b.bin'), Buffer.alloc(512 * 1024, 0x42));
        await writeFile(join(root, 'c.bin'), Buffer.alloc(512 * 1024, 0x43));
        const honest = await produce(root);

        // Same file count, no file larger than the largest promised, but the
        // sum is over budget.
        const bomb = await scratch();
        for (const name of ['a.bin', 'b.bin', 'c.bin']) {
            await writeFile(join(bomb, name), Buffer.alloc(1024 * 1024, 0x41));
        }
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: bomb, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['a.bin', 'b.bin', 'c.bin']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'total.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: 3,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRestoreOntoADifferentVolumeThanTheCheckpointWasTakenOn', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        const input = await restoreInput(product, destination, home);

        const result = await restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant,
                // No source constraint: the machine it came from is gone.
                targetVolume: { volumeId: 'vol_replacement', deviceUuid: 'dev-2' },
            },
        });

        expect(result.sourceVolume).toEqual(volume);
        expect(result.targetVolume).toEqual({ volumeId: 'vol_replacement', deviceUuid: 'dev-2' });
        // The manifest is evidence about the source and is never rewritten to
        // agree with where it landed.
        expect(product.manifest.volume).toEqual(volume);
        expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# project\n');
    });

    it('shouldRefuseWhenTheExtractedTreeDoesNotMatchTheManifestEntries', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        const manifest: ManagedCheckpointManifest = {
            ...product.manifest,
            entries: [...product.manifest.entries, {
                area: 'project', path: 'ghost.txt', type: 'file', bytes: 1, mode: 0o644,
                sha256: 'f'.repeat(64),
            }],
        };
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            manifest,
        })).rejects.toMatchObject({ code: 'missing-entry' });
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldPreserveTheExistingVolumeWhenPromotionFailsPartWay', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const real = (await import('node:fs/promises')).rename;
        let calls = 0;
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            deps: {
                rename: async (from: string, to: string) => {
                    calls += 1;
                    // First rename moves the old tree aside; the second, which
                    // would put the new one in place, is the one that fails.
                    if (calls === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await real(from, to);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseWhenTheExtractedTreeIsNotOwnedByTheExpectedUid', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            expectedUid: (process.getuid?.() ?? 0) + 1,
        })).rejects.toMatchObject({ code: 'ownership-mismatch' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldKeepTheOriginalReachableWhenPromotionAndRollbackBothFail', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const real = (await import('node:fs/promises')).rename;
        let calls = 0;
        const error = await restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            deps: {
                rename: async (from: string, to: string) => {
                    calls += 1;
                    if (calls >= 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    await real(from, to);
                },
            },
        }).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: 'promotion-unreconciled' });
        // The user's only copy sits beside the destination, outside staging,
        // and nothing cleaned it up.
        const displaced = (await readdir(home)).find((name) => name.includes('saycode-displaced'))!;
        expect(await readFile(join(home, displaced, 'mine.txt'), 'utf8')).toBe('mine\n');
        expect((await readdir(home)).some((name) => name.startsWith('managed-checkpoint-promotion-'))).toBe(true);
        // This is the one exit that needs a person: the verified trees stay
        // put so there is something to look at.
        expect((await readdir(home)).some((name) => name.startsWith('.managed-checkpoint-'))).toBe(true);
    });

    it('shouldRefuseWhenAnAreaHasNoDestination', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, join(home, 'p'), home)),
            destinations: new Map(),
        })).rejects.toMatchObject({ code: 'area-missing' });
    });

    it('shouldSurfaceRestoreFailuresAsATypedErrorWithoutArchiveDetail', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const error = await restoreManagedCheckpoint({
            ...(await restoreInput(product, join(home, 'p'), home)),
            key: randomBytes(32),
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ManagedCheckpointRestoreError);
        expect((error as ManagedCheckpointRestoreError).code).toBe('object-unreadable');
        expect((error as Error).message).toBe('managed checkpoint restore refused: object-unreadable');
    });
});
