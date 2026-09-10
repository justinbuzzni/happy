import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedCheckpointRunner } from './managedCheckpointRunner';
import { createManagedToolRuntime } from '@/launcher/managedToolRuntime';
import { MANAGED_WRITE_TOOLS } from '@/launcher/toolWorkload';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-runner-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function fakeStore() {
    const objects = new Map<string, Buffer>();
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const key = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'PUT') {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            if (headers['if-none-match'] === '*' && objects.has(key)) return new Response(null, { status: 412 });
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (typeof body === 'string') chunks.push(Buffer.from(body));
            else if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
            }
            objects.set(key, Buffer.concat(chunks));
            return new Response(null, {
                status: 200,
                headers: { etag: `"${createHash('md5').update(objects.get(key)!).digest('hex')}"` },
            });
        }
        const stored = objects.get(key);
        if (!stored) return new Response(null, { status: 404 });
        if (method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: {
                    'content-length': String(stored.length),
                    etag: `"${createHash('md5').update(stored).digest('hex')}"`,
                },
            });
        }
        return new Response(stored, {
            status: 200,
            headers: { etag: `"${createHash('md5').update(stored).digest('hex')}"` },
        });
    };
    return { objects, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

function targetsFor(id: string) {
    return {
        objects: new Map([['project' as const, {
            putUrl: `https://store.invalid/${id}/project.enc`,
            headUrl: `https://store.invalid/${id}/project.enc`,
        }]]),
        manifest: {
            putUrl: `https://store.invalid/${id}/manifest.enc`,
            headUrl: `https://store.invalid/${id}/manifest.enc`,
        },
        pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
    };
}

async function runnerFor(store: ReturnType<typeof fakeStore>) {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    return {
        root,
        runner: createManagedCheckpointRunner({
            tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1_700_000_000_000,
            fetchImpl: store.fetchImpl,
        }),
    };
}

describe('createManagedCheckpointRunner', () => {
    it('shouldTakeACheckpointFromTheBoundConfigurationAndTheRequestsUrls', async () => {
        const store = fakeStore();
        const { runner } = await runnerFor(store);
        const checkpointId = 'a'.repeat(64);

        const result = await runner.takeCheckpoint({ checkpointId, key, targets: targetsFor(checkpointId) });

        expect(result.pointer.checkpointId).toBe(checkpointId);
        expect(result.manifest.tenant).toEqual(tenant);
        expect(result.manifest.volume).toEqual(volume);
        expect(JSON.parse(store.objects.get('https://store.invalid/latest.json')!.toString()).manifestDigest)
            .toBe(result.manifestDigest);
    });

    it('shouldTakeASecondCheckpointFromTheSameRunner', async () => {
        const store = fakeStore();
        const { runner } = await runnerFor(store);

        const first = 'a'.repeat(64);
        await runner.takeCheckpoint({ checkpointId: first, key, targets: targetsFor(first) });
        // The sealed objects of the first checkpoint must not be sitting in the
        // scratch space where the second one writes its own.
        const second = 'b'.repeat(64);
        const result = await runner.takeCheckpoint({ checkpointId: second, key, targets: targetsFor(second) });

        expect(result.pointer.checkpointId).toBe(second);
        expect(JSON.parse(store.objects.get('https://store.invalid/latest.json')!.toString()).checkpointId)
            .toBe(second);
    });

    it('shouldNotLeaveItsScratchSpaceBehindAfterACheckpoint', async () => {
        const store = fakeStore();
        const workDir = join(await scratch(), 'work');
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'contents\n');
        const runner = createManagedCheckpointRunner({
            tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            workDir,
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });

        const id = 'c'.repeat(64);
        await runner.takeCheckpoint({ checkpointId: id, key, targets: targetsFor(id) });
        expect(await readdir(workDir)).toEqual([]);

        // And a failed one cleans up too.
        const failing = 'd'.repeat(64);
        store.objects.set(`https://store.invalid/${failing}/project.enc`, Buffer.from('taken'));
        await expect(runner.takeCheckpoint({ checkpointId: failing, key, targets: targetsFor(failing) }))
            .rejects.toThrow();
        expect(await readdir(workDir)).toEqual([]);
    });

    it('shouldHoldWritesInTheToolPathForTheDurationOfTheCheckpoint', async () => {
        const store = fakeStore();
        const { runner } = await runnerFor(store);
        const refusals: string[] = [];
        const executed: string[] = [];
        const tools = createManagedToolRuntime({
            tools: [],
            plan: {} as never,
            executor: { run: async (call: { call: { name: string } }) => {
                executed.push(call.call.name);
                return { ok: true, content: 'done' };
            } } as never,
            grant: () => ({ token: 't', scope: new Set(['write_file', 'read_file']), expiresMonotonic: 10 }) as never,
            monotonicNow: () => 0,
            timeoutMs: 1000,
            onUnprovenTermination: () => undefined,
            // The same gate the runner holds — this is the whole point.
            checkpointDrain: runner.checkpointDrain,
        });

        const checkpointId = 'b'.repeat(64);
        const checkpoint = runner.takeCheckpoint({ checkpointId, key, targets: targetsFor(checkpointId) });
        // The checkpoint takes the gate a moment after it starts — it makes
        // its own scratch space first. What is under test is that writes are
        // held *while the archive is being taken*, not that the refusal is
        // instantaneous.
        while (!runner.checkpointDrain.drain.isDraining()) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const duringWrite = await tools.execute({ name: 'write_file', arguments: {} });
        if (!duringWrite.ok) refusals.push(duringWrite.code);
        const duringRead = await tools.execute({ name: 'read_file', arguments: {} });

        await checkpoint;
        expect(refusals).toContain('checkpoint-paused');
        expect(duringRead).toEqual({ ok: true, content: 'done' });
        expect(executed).toEqual(['read_file']);

        // And the gate opens again afterwards.
        expect(await tools.execute({ name: 'write_file', arguments: {} })).toEqual({ ok: true, content: 'done' });
    });

    it('shouldRefuseASecondCheckpointWhileOneIsRunning', async () => {
        const store = fakeStore();
        const { runner } = await runnerFor(store);
        const first = runner.takeCheckpoint({
            checkpointId: 'c'.repeat(64), key, targets: targetsFor('c'.repeat(64)),
        });
        // Wait for the first to actually hold the gate: it makes its scratch
        // space before taking it, so starting the second immediately would be
        // a race on which one gets there first.
        while (!runner.checkpointDrain.drain.isDraining()) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await expect(runner.takeCheckpoint({
            checkpointId: 'd'.repeat(64), key, targets: targetsFor('d'.repeat(64)),
        })).rejects.toMatchObject({ code: 'drain-in-progress' });
        await first;
    });

    it('shouldOpenTheGateAgainWhenTheCheckpointFails', async () => {
        const store = fakeStore();
        const { runner } = await runnerFor(store);
        const checkpointId = 'e'.repeat(64);
        // The object key is already taken, so the publish is refused.
        store.objects.set(`https://store.invalid/${checkpointId}/project.enc`, Buffer.from('taken'));

        await expect(runner.takeCheckpoint({ checkpointId, key, targets: targetsFor(checkpointId) }))
            .rejects.toMatchObject({ code: 'object-exists' });
        expect(runner.checkpointDrain.drain.isDraining()).toBe(false);
        expect(() => runner.checkpointDrain.drain.beginWrite()).not.toThrow();
    });
});
