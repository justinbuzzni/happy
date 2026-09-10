/**
 * The stage-3 pipeline against a real S3-compatible object store.
 *
 * Everything above this file talks to a `fetch` it was handed, which proves
 * the logic and nothing about the store. The two things that only a real store
 * can answer are whether conditional writes actually behave as compare-and-set
 * — MinIO honours `If-None-Match: *` and `If-Match: <etag>` with 412 — and
 * whether an object survives the round trip byte for byte.
 *
 * Requires a store reachable at `MANAGED_CHECKPOINT_TEST_STORE` with anonymous
 * read/write on the bucket in the URL; skipped otherwise, and never silently
 * passed as if it had run.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointDrain } from './managedCheckpointDrain';
import { createManagedCheckpointRunner } from './managedCheckpointRunner';
import { MANAGED_WRITE_TOOLS } from '@/launcher/toolWorkload';
import { putCheckpointPointer, readCheckpointPointer } from './managedCheckpointObjectStore';
import { publishManagedCheckpoint } from './managedCheckpointPublisher';
import { createManagedCheckpointSource } from './managedCheckpointResolver';
import { restoreManagedCheckpoint } from './managedCheckpointRestore';

const base = process.env.MANAGED_CHECKPOINT_TEST_STORE;
const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-minio-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

describe.skipIf(!base)('managed checkpoint against a real object store', () => {
    const key = randomBytes(32);
    const tenant = { companyId: 'co_1', projectId: 'pr_1' };
    const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

    function targetsFor(prefix: string) {
        // Anonymous access, so one URL serves every method here; the signed
        // contract — a URL authorises one method — is proved against a private
        // bucket in managedCheckpointPresigned.integration.test.ts.
        const object = `${base}/${prefix}/project.tar.gz.enc`;
        const manifest = `${base}/${prefix}/manifest.json.enc`;
        return {
            objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
            manifest: { putUrl: manifest, headUrl: manifest },
            pointer: { putUrl: `${base}/${prefix}/latest.json`, getUrl: `${base}/${prefix}/latest.json` },
        };
    }

    async function project(): Promise<string> {
        const root = await scratch();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
        await writeFile(join(root, 'binary.bin'), randomBytes(64 * 1024));
        return root;
    }

    it('shouldPublishThenResolveAndRestoreOntoAFreshVolume', async () => {
        const prefix = `t13-${randomUUID()}`;
        const root = await project();
        const checkpointId = randomBytes(32).toString('hex');

        const published = await publishManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            key,
            workDir: join(await scratch(), 'work'),
            drain: createCheckpointDrain(),
            drainBudgetMs: 5000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: targetsFor(prefix),
            now: () => Date.now(),
        });

        const source = createManagedCheckpointSource({
            authority: {
                tenant,
                pointerUrl: `${base}/${prefix}/latest.json`,
                manifestUrl: `${base}/${prefix}/manifest.json.enc`,
                objectUrls: new Map([['project' as const, `${base}/${prefix}/project.tar.gz.enc`]]),
                key,
            },
            downloadDir: await scratch(),
        });
        const resolved = await source.resolveLatest();
        expect(resolved?.manifest.checkpointId).toBe(checkpointId);
        expect(resolved?.manifest.checkpointId).toBe(published.pointer.checkpointId);

        const home = await scratch();
        const result = await restoreManagedCheckpoint({
            manifest: resolved!.manifest,
            objects: resolved!.objects,
            key: resolved!.key,
            // The machine it came from is gone; the binding is the authority's.
            expected: { tenant, targetVolume: { volumeId: 'vol_new', deviceUuid: 'dev-new' } },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        });

        expect(result.manifestDigest).toBe(published.manifestDigest);
        expect(await readFile(join(home, 'project/src/index.ts'), 'utf8')).toBe('export const a = 1;\n');
        expect(await readFile(join(home, 'project/binary.bin'))).toEqual(await readFile(join(root, 'binary.bin')));
    }, 60_000);

    it('shouldLetOnlyOneOfTwoConcurrentPublishersMoveThePointerAndRestoreTheWinner', async () => {
        // One project, one pointer, two runtimes — each writing its own
        // checkpoint-scoped objects, which is what the parent signs. The race
        // is on the pointer alone.
        const prefix = `t13-${randomUUID()}`;
        const marked = async (content: string): Promise<string> => {
            const root = await scratch();
            await writeFile(join(root, 'whose.txt'), content);
            return root;
        };

        // Both runtimes must have *read* the pointer before either writes it,
        // otherwise `Promise.allSettled` only proves that one of them started
        // late — the second would read the first's pointer and the write would
        // never contend. The barrier holds both at the read.
        let arrived = 0;
        let openBarrier: () => void = () => undefined;
        const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
        const barrierFetch: typeof globalThis.fetch = async (url, init) => {
            const isPointerRead = String(url).endsWith('latest.json') && (init?.method ?? 'GET') === 'GET';
            if (!isPointerRead) return globalThis.fetch(url as never, init as never);
            const response = await globalThis.fetch(url as never, init as never);
            arrived += 1;
            if (arrived >= 2) openBarrier();
            await barrier;
            return response;
        };

        const run = async (content: string) => {
            const checkpointId = randomBytes(32).toString('hex');
            const objects = `${base}/${prefix}/${checkpointId}/project.tar.gz.enc`;
            const manifest = `${base}/${prefix}/${checkpointId}/manifest.json.enc`;
            const published = await publishManagedCheckpoint({
                checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
                sources: [{ area: 'project', root: await marked(content) }],
                key,
                workDir: join(tmpdir(), `mc-minio-work-${randomUUID()}`),
                drain: createCheckpointDrain(),
                drainBudgetMs: 5000,
                flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
                targets: {
                    objects: new Map([['project' as const, { putUrl: objects, headUrl: objects }]]),
                    manifest: { putUrl: manifest, headUrl: manifest },
                    pointer: {
                        putUrl: `${base}/${prefix}/latest.json`,
                        getUrl: `${base}/${prefix}/latest.json`,
                    },
                },
                now: () => Date.now(),
                fetchImpl: barrierFetch,
            });
            return { published, checkpointId, objects, manifest, content };
        };

        const outcomes = await Promise.allSettled([run('runtime-a'), run('runtime-b')]);
        // Both really did read the same pre-state.
        expect(arrived).toBe(2);
        const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'pointer-conflict' });

        const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value;
        const pointer = await readCheckpointPointer({ url: `${base}/${prefix}/latest.json` });
        expect(JSON.parse(pointer!.body).checkpointId).toBe(winner.checkpointId);

        // And the checkpoint the pointer names actually restores — the loser's
        // objects sit in their own namespace and cannot have replaced these.
        const source = createManagedCheckpointSource({
            authority: {
                tenant,
                pointerUrl: `${base}/${prefix}/latest.json`,
                manifestUrl: winner.manifest,
                objectUrls: new Map([['project' as const, winner.objects]]),
                key,
            },
            downloadDir: await scratch(),
        });
        const resolved = await source.resolveLatest();
        const home = await scratch();
        await restoreManagedCheckpoint({
            manifest: resolved!.manifest,
            objects: resolved!.objects,
            key: resolved!.key,
            expected: { tenant, targetVolume: { volumeId: 'vol_new', deviceUuid: 'dev-new' } },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        });
        expect(await readFile(join(home, 'project/whose.txt'), 'utf8')).toBe(winner.content);
    }, 60_000);

    it('shouldPublishTwoSequentialCheckpointsFromOneRunner', async () => {
        // The property root's fixture is after, proved against a store that
        // actually implements conditional writes and returns ETags.
        const prefix = `t13-${randomUUID()}`;
        const root = await scratch();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');

        const runner = createManagedCheckpointRunner({
            tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 5000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => Date.now(),
        });

        const takeOne = async () => {
            const checkpointId = randomBytes(32).toString('hex');
            const object = `${base}/${prefix}/${checkpointId}/project.tar.gz.enc`;
            const manifest = `${base}/${prefix}/${checkpointId}/manifest.json.enc`;
            return runner.takeCheckpoint({
                checkpointId,
                key,
                targets: {
                    objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
                    manifest: { putUrl: manifest, headUrl: manifest },
                    pointer: {
                        putUrl: `${base}/${prefix}/latest.json`,
                        getUrl: `${base}/${prefix}/latest.json`,
                    },
                },
            });
        };

        const first = await takeOne();
        const second = await takeOne();

        expect(second.pointer.checkpointId).not.toBe(first.pointer.checkpointId);
        const pointer = await readCheckpointPointer({ url: `${base}/${prefix}/latest.json` });
        expect(JSON.parse(pointer!.body).checkpointId).toBe(second.pointer.checkpointId);
    }, 60_000);

    it('shouldRefuseToWriteOverAnObjectThatAlreadyExists', async () => {
        const prefix = `t13-${randomUUID()}`;
        const checkpointId = randomBytes(32).toString('hex');
        const objects = `${base}/${prefix}/${checkpointId}/project.tar.gz.enc`;
        const manifest = `${base}/${prefix}/${checkpointId}/manifest.json.enc`;
        // Something is already at the object key this run would write.
        expect((await fetch(objects, { method: 'PUT', body: 'someone else' })).status).toBe(200);

        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'mine\n');
        await expect(publishManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            key,
            workDir: join(await scratch(), 'work'),
            drain: createCheckpointDrain(),
            drainBudgetMs: 5000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: {
                objects: new Map([['project' as const, { putUrl: objects, headUrl: objects }]]),
                manifest: { putUrl: manifest, headUrl: manifest },
                pointer: { putUrl: `${base}/${prefix}/latest.json`, getUrl: `${base}/${prefix}/latest.json` },
            },
            now: () => Date.now(),
        })).rejects.toMatchObject({ code: 'object-exists' });

        expect(await (await fetch(objects)).text()).toBe('someone else');
        expect((await fetch(`${base}/${prefix}/latest.json`)).status).toBe(404);
    }, 60_000);

    it('shouldRefuseToReplaceAPointerVersionItDidNotRead', async () => {
        const prefix = `t13-${randomUUID()}`;
        const url = `${base}/${prefix}/latest.json`;
        const first = await putCheckpointPointer({ url, body: '{"v":1}', expectedEtag: null });
        expect(first.ok).toBe(true);

        expect(await putCheckpointPointer({ url, body: '{"v":2}', expectedEtag: null }))
            .toEqual({ ok: false, reason: 'conflict' });
        expect(await putCheckpointPointer({ url, body: '{"v":2}', expectedEtag: 'deadbeefdeadbeefdeadbeefdeadbeef' }))
            .toEqual({ ok: false, reason: 'conflict' });

        const current = await readCheckpointPointer({ url });
        expect(current!.body).toBe('{"v":1}');
        const replaced = await putCheckpointPointer({ url, body: '{"v":2}', expectedEtag: current!.etag });
        expect(replaced.ok).toBe(true);
        expect((await readCheckpointPointer({ url }))!.body).toBe('{"v":2}');
    }, 30_000);
});
