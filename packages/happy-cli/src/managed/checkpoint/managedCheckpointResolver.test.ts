import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { sealCheckpointBuffer } from './managedCheckpointCrypto';
import { checkpointManifestDigest, serializeManagedCheckpointManifest } from './managedCheckpointManifest';
import { createManagedCheckpointSource, ManagedCheckpointResolveError } from './managedCheckpointResolver';
import { restoreManagedCheckpoint } from './managedCheckpointRestore';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-resolve-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const POINTER = 'https://store.invalid/latest.json';
const MANIFEST = 'https://store.invalid/manifest.enc';
const OBJECT = 'https://store.invalid/project.enc';

async function published(overrides: {
    tenant?: { companyId: string; projectId: string };
    checkpointId?: string;
} = {}) {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    const product = await createManagedCheckpoint({
        checkpointId: overrides.checkpointId ?? checkpointId,
        tenant: overrides.tenant ?? tenant,
        volume,
        image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }],
        key,
        outputDir: join(await scratch(), 'objects'),
        now: () => 1,
    });
    const manifestPath = join(await scratch(), 'manifest.enc');
    await sealCheckpointBuffer({
        plaintext: Buffer.from(serializeManagedCheckpointManifest(product.manifest), 'utf8'),
        destination: manifestPath,
        key,
        binding: {
            companyId: (overrides.tenant ?? tenant).companyId,
            projectId: (overrides.tenant ?? tenant).projectId,
            checkpointId: overrides.checkpointId ?? checkpointId,
            area: 'manifest',
        },
    });
    return { product, manifestPath };
}

function store(entries: Record<string, Buffer | string>) {
    return (async (url: string | URL | Request) => {
        const value = entries[String(url)];
        if (value === undefined) return new Response(null, { status: 404 });
        return new Response(typeof value === 'string' ? value : new Uint8Array(value), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
}

function authority(overrides: Partial<{ tenant: { companyId: string; projectId: string } }> = {}) {
    return {
        tenant: overrides.tenant ?? tenant,
        pointerUrl: POINTER,
        manifestUrl: MANIFEST,
        objectUrls: new Map([['project' as const, OBJECT]]),
        key,
    };
}

function pointerBody(manifestDigest: string, id = checkpointId): string {
    return JSON.stringify({ schemaVersion: 1, checkpointId: id, manifestDigest, createdAtMs: 1 });
}

describe('createManagedCheckpointSource', () => {
    it('shouldReturnNullWhenTheProjectHasNeverBeenCheckpointed', async () => {
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({}),
        });
        expect(await source.resolveLatest()).toBeNull();
    });

    it('shouldBringDownTheManifestAndObjectsTheParentVouchedFor', async () => {
        const { product, manifestPath } = await published();
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(product.manifestDigest),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });

        const resolved = await source.resolveLatest();
        expect(resolved?.manifest.checkpointId).toBe(checkpointId);
        expect(resolved?.objects.get('project')).toBeDefined();
        expect(await readFile(resolved!.objects.get('project')!)).toEqual(
            await readFile(product.objects.get('project')!),
        );
    });

    it('shouldFeedARestoreThatNamesNoSourceVolume', async () => {
        const { product, manifestPath } = await published();
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(product.manifestDigest),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });
        const resolved = await source.resolveLatest();
        const home = await scratch();

        const result = await restoreManagedCheckpoint({
            manifest: resolved!.manifest,
            objects: resolved!.objects,
            key: resolved!.key,
            expected: { tenant, targetVolume: { volumeId: 'vol_new', deviceUuid: 'dev-new' } },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        });

        expect(result.promoted).toBe(true);
        expect(result.sourceVolume).toEqual(volume);
        expect(await readFile(join(home, 'project/src/index.ts'), 'utf8')).toBe('export const a = 1;\n');
    });

    it('shouldRefuseAManifestThatDoesNotHashToWhatThePointerNames', async () => {
        const { product, manifestPath } = await published();
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(createHash('sha256').update('something else').digest('hex')),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'authority-mismatch' });
    });

    it('shouldRefuseAnotherProjectsCheckpointEvenThoughItsOwnDigestIsConsistent', async () => {
        // A complete, internally consistent checkpoint — of a different project.
        const other = await published({ tenant: { companyId: 'co_1', projectId: 'pr_other' } });
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(checkpointManifestDigest(other.product.manifest)),
                [MANIFEST]: await readFile(other.manifestPath),
                [OBJECT]: await readFile(other.product.objects.get('project')!),
            }),
        });
        // The manifest is sealed under the other project's binding, so it does
        // not even open under this run's authority.
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'manifest-unreadable' });
    });

    it('shouldRefuseAManifestForADifferentCheckpointThanThePointerNames', async () => {
        const { product, manifestPath } = await published();
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(product.manifestDigest, 'b'.repeat(64)),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });
        // Sealed under the real checkpoint id, opened under the pointer's.
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'manifest-unreadable' });
    });

    it('shouldRefuseAManifestThatOpensCleanlyButNamesAnotherProject', async () => {
        // Sealed under *this* run's binding and digest-consistent with its
        // pointer, so nothing but the tenant comparison can catch it.
        const { product } = await published();
        const forged = { ...product.manifest, tenant: { companyId: 'co_1', projectId: 'pr_other' } };
        const digest = checkpointManifestDigest(forged);
        const manifestPath = join(await scratch(), 'forged.enc');
        await sealCheckpointBuffer({
            plaintext: Buffer.from(serializeManagedCheckpointManifest(forged), 'utf8'),
            destination: manifestPath,
            key,
            binding: { ...tenant, checkpointId, area: 'manifest' },
        });

        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(digest),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'authority-mismatch' });
    });

    it('shouldRefuseAManifestThatOpensCleanlyButIsADifferentCheckpoint', async () => {
        const { product } = await published();
        const forged = { ...product.manifest, checkpointId: 'c'.repeat(64) };
        const digest = checkpointManifestDigest(forged);
        const manifestPath = join(await scratch(), 'forged.enc');
        await sealCheckpointBuffer({
            plaintext: Buffer.from(serializeManagedCheckpointManifest(forged), 'utf8'),
            destination: manifestPath,
            key,
            binding: { ...tenant, checkpointId, area: 'manifest' },
        });

        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(digest),
                [MANIFEST]: await readFile(manifestPath),
                [OBJECT]: await readFile(product.objects.get('project')!),
            }),
        });
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'authority-mismatch' });
    });

    it('shouldRefuseAPointerThatIsNotAPointer', async () => {
        for (const body of ['not json', '{}', '{"schemaVersion":2,"checkpointId":"a","manifestDigest":"b"}']) {
            const source = createManagedCheckpointSource({
                authority: authority(),
                downloadDir: await scratch(),
                fetchImpl: store({ [POINTER]: body }),
            });
            const error = await source.resolveLatest().catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ManagedCheckpointResolveError);
            expect((error as ManagedCheckpointResolveError).code).toBe('pointer-unreadable');
        }
    });

    it('shouldRefuseWhenAnObjectTheManifestNamesIsNotThere', async () => {
        const { product, manifestPath } = await published();
        const source = createManagedCheckpointSource({
            authority: authority(),
            downloadDir: await scratch(),
            fetchImpl: store({
                [POINTER]: pointerBody(product.manifestDigest),
                [MANIFEST]: await readFile(manifestPath),
            }),
        });
        await expect(source.resolveLatest()).rejects.toMatchObject({ code: 'object-missing' });
    });
});
