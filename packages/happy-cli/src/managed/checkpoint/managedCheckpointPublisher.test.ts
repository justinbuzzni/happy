import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointDrain } from './managedCheckpointDrain';
import { publishManagedCheckpoint, ManagedCheckpointPublishError } from './managedCheckpointPublisher';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-publish-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** An object store just real enough to observe order and preconditions. */
function fakeStore() {
    const objects = new Map<string, Buffer>();
    const etags = new Map<string, string>();
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const raw = String(url);
        const method = init?.method ?? 'GET';
        // Stands in for SigV4's method binding: a URL minted for one method is
        // rejected for another, exactly as a real signed URL is.
        const signedFor = /[?&]m=([A-Z]+)/.exec(raw);
        if (signedFor && signedFor[1] !== method) return new Response(null, { status: 403 });
        const key = raw.replace(/\?m=[A-Z]+$/, '');
        calls.push(`${method} ${key}`);
        if (method === 'PUT') {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            const existing = objects.get(key);
            if (headers['if-none-match'] === '*' && existing) return new Response(null, { status: 412 });
            if (headers['if-match'] && headers['if-match'] !== `"${etags.get(key)}"`) {
                return new Response(null, { status: 412 });
            }
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (typeof body === 'string') chunks.push(Buffer.from(body));
            else if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
            }
            const stored = Buffer.concat(chunks);
            objects.set(key, stored);
            const etag = createHash('md5').update(stored).digest('hex');
            etags.set(key, etag);
            return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
        }
        const stored = objects.get(key);
        if (!stored) return new Response(null, { status: 404 });
        if (method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: { 'content-length': String(stored.length), etag: `"${etags.get(key)}"` },
            });
        }
        return new Response(stored, { status: 200, headers: { etag: `"${etags.get(key)}"` } });
    };
    return { objects, etags, calls, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

async function projectRoot(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    return root;
}

// A signed URL authorises one method, so the upload and the verification are
// different URLs — as they are against a private bucket.
const targets = {
    objects: new Map([['project' as const, {
        putUrl: 'https://store.invalid/project.enc?m=PUT',
        headUrl: 'https://store.invalid/project.enc?m=HEAD',
    }]]),
    manifest: {
        putUrl: 'https://store.invalid/manifest.enc?m=PUT',
        headUrl: 'https://store.invalid/manifest.enc?m=HEAD',
    },
    pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
};

async function publish(overrides: Record<string, unknown> = {}) {
    const store = (overrides.store as ReturnType<typeof fakeStore>) ?? fakeStore();
    const result = await publishManagedCheckpoint({
        checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root: (overrides.root as string) ?? await projectRoot() }],
        key,
        workDir: join(await scratch(), 'work'),
        drain: (overrides.drain as ReturnType<typeof createCheckpointDrain>) ?? createCheckpointDrain(),
        drainBudgetMs: 1000,
        flushDeps: (overrides.flushDeps as never) ?? { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        targets,
        now: () => 1_700_000_000_000,
        fetchImpl: store.fetchImpl,
        ...(overrides.publish as object ?? {}),
    });
    return { result, store };
}

describe('publishManagedCheckpoint', () => {
    it('shouldUploadAndVerifyEveryObjectBeforeItMovesTheLatestPointer', async () => {
        const { result, store } = await publish();

        const pointerWrite = store.calls.indexOf('PUT https://store.invalid/latest.json');
        expect(store.calls.indexOf('PUT https://store.invalid/project.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('HEAD https://store.invalid/project.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('PUT https://store.invalid/manifest.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('HEAD https://store.invalid/manifest.enc')).toBeLessThan(pointerWrite);
        expect(JSON.parse(store.objects.get('https://store.invalid/latest.json')!.toString())).toEqual({
            schemaVersion: 1,
            checkpointId,
            manifestDigest: result.manifestDigest,
            createdAtMs: 1_700_000_000_000,
        });
    });

    it('shouldNotPublishAManifestThatNamesAnObjectTheStoreDoesNotHold', async () => {
        const store = fakeStore();
        const dropping = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                // The upload reports success and the store does not keep it.
                if (String(url).includes('project.enc') && (init?.method ?? 'GET') === 'PUT') {
                    return new Response(null, { status: 200, headers: { etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' } });
                }
                return store.fetchImpl(url, init);
            }) as unknown as typeof globalThis.fetch,
        };
        await expect(publish({ store: dropping })).rejects.toMatchObject({ code: 'missing' });
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldSealTheManifestSoTheStoreNeverSeesProjectContent', async () => {
        const root = await projectRoot();
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/config'), '[remote "origin"]\n\turl = https://github.com/acme/private-name.git\n');
        const { store } = await publish({ root });
        const stored = store.objects.get('https://store.invalid/manifest.enc')!;
        expect(stored.includes(Buffer.from('private-name'))).toBe(false);
        expect(stored.subarray(0, 5).toString()).toBe('SCKP2');
    });

    it('shouldStopBeforeArchivingWhenADatabaseHasNoFlushAdapter', async () => {
        const root = await projectRoot();
        await writeFile(join(root, 'app.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8)]));
        const store = fakeStore();
        await expect(publish({
            root,
            store,
            flushDeps: { run: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
        })).rejects.toBeInstanceOf(ManagedCheckpointPublishError);
        // Nothing at all was read or written: the refusal is a preflight.
        expect(store.calls).toEqual([]);
    });

    it('shouldTakeTheCheckpointAnywayWhenTheCallerSaysSoAndReportWhatWasNotFlushed', async () => {
        const root = await projectRoot();
        await writeFile(join(root, 'app.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8)]));
        const { result } = await publish({
            root,
            flushDeps: { run: async () => ({ code: 1, stdout: '' }) },
            publish: { acknowledgeUnsupportedDatabases: true },
        });
        expect(result.flush.unsupported).toEqual([{ path: 'app.db', reason: 'flush-failed' }]);
    });

    it('shouldRefuseToOverwriteAnObjectAnotherCheckpointAlreadyWrote', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/project.enc', Buffer.from('another checkpoint'));
        store.etags.set('https://store.invalid/project.enc', 'other');

        await expect(publish({ store })).rejects.toMatchObject({ code: 'object-exists' });
        // The bytes that were there stay there, and nothing was pointed at.
        expect(store.objects.get('https://store.invalid/project.enc')).toEqual(Buffer.from('another checkpoint'));
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldRefuseToOverwriteAManifestAnotherCheckpointAlreadyWrote', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/manifest.enc', Buffer.from('another manifest'));
        store.etags.set('https://store.invalid/manifest.enc', 'other');

        await expect(publish({ store })).rejects.toMatchObject({ code: 'object-exists' });
        expect(store.objects.get('https://store.invalid/manifest.enc')).toEqual(Buffer.from('another manifest'));
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldRefuseWhenThePointerExistsButItsVersionIsUnknown', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/latest.json', Buffer.from('{"schemaVersion":1}'));
        const versionless = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                const response = await store.fetchImpl(url, init);
                if (String(url).includes('latest.json') && (init?.method ?? 'GET') === 'GET') {
                    // A store that answers without an ETag gives no version to
                    // compare against.
                    return new Response(await response.text(), { status: response.status });
                }
                return response;
            }) as unknown as typeof globalThis.fetch,
        };

        await expect(publish({ store: versionless })).rejects.toMatchObject({ code: 'pointer-unreadable' });
        // The existing pointer is left exactly as it was.
        expect(store.objects.get('https://store.invalid/latest.json')!.toString()).toBe('{"schemaVersion":1}');
    });

    it('shouldLeaveAnotherRuntimesPointerAloneWhenItPublishedFirst', async () => {
        const store = fakeStore();
        // Another runtime's pointer is already there, so this run's
        // create-if-absent precondition fails.
        store.objects.set('https://store.invalid/latest.json', Buffer.from('{"schemaVersion":1}'));
        store.etags.set('https://store.invalid/latest.json', 'other');
        const winner = store.objects.get('https://store.invalid/latest.json')!;

        // Reads the pointer, then someone replaces it before the CAS.
        const racing = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                if (String(url).endsWith('latest.json') && (init?.method ?? 'GET') === 'GET') {
                    return new Response(null, { status: 404 });
                }
                return store.fetchImpl(url, init);
            }) as unknown as typeof globalThis.fetch,
        };

        await expect(publish({ store: racing })).rejects.toMatchObject({ code: 'pointer-conflict' });
        expect(store.objects.get('https://store.invalid/latest.json')).toEqual(winner);
    });

    it('shouldHoldTheDrainForTheWholeCheckpointAndAlwaysReleaseIt', async () => {
        const drain = createCheckpointDrain();
        let drainedDuringArchive = false;
        await publish({
            drain,
            flushDeps: { run: async () => { drainedDuringArchive = drain.isDraining(); return { code: 0, stdout: '0|0|0' }; } },
            root: await (async () => {
                const root = await projectRoot();
                await writeFile(join(root, 'app.db'), Buffer.concat([
                    Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8),
                ]));
                return root;
            })(),
        });
        expect(drainedDuringArchive).toBe(true);
        expect(drain.isDraining()).toBe(false);
        expect(() => drain.beginWrite()).not.toThrow();
    });

    it('shouldReleaseTheDrainEvenWhenTheCheckpointFails', async () => {
        const drain = createCheckpointDrain();
        await expect(publish({
            drain,
            store: {
                ...fakeStore(),
                fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch,
            },
        })).rejects.toThrow();
        expect(drain.isDraining()).toBe(false);
    });
});
