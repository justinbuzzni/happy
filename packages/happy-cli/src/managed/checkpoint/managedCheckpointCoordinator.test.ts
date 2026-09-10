import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MANAGED_WRITE_TOOLS } from '@/launcher/toolWorkload';
import { mayStopRuntime, type RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import { createManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import { createManagedCheckpointRunner } from './managedCheckpointRunner';
import type { ManagedCheckpointRequest, ManagedCheckpointRunner } from './managedCheckpointRunner';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };
const idle: RuntimeIdleDecision = { state: 'idle', forMs: 1 };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-coord-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** Only the object store is fake; the runner and publisher are the product. */
function fakeStore(options: { failObjects?: boolean } = {}) {
    const objects = new Map<string, Buffer>();
    const state = { refuseObjects: options.failObjects === true };
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'PUT') {
            if (state.refuseObjects && path.includes('project.enc')) {
                return new Response(null, { status: 507 });
            }
            const headers = (init?.headers ?? {}) as Record<string, string>;
            if (headers['if-none-match'] === '*' && objects.has(path)) return new Response(null, { status: 412 });
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (typeof body === 'string') chunks.push(Buffer.from(body));
            else if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
            }
            objects.set(path, Buffer.concat(chunks));
            return new Response(null, {
                status: 200,
                headers: { etag: `"${createHash('md5').update(objects.get(path)!).digest('hex')}"` },
            });
        }
        const stored = objects.get(path);
        if (!stored) return new Response(null, { status: 404 });
        const etag = `"${createHash('md5').update(stored).digest('hex')}"`;
        if (method === 'HEAD') {
            return new Response(null, { status: 200, headers: { 'content-length': String(stored.length), etag } });
        }
        return new Response(stored, { status: 200, headers: { etag } });
    };
    return {
        objects,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        set refuseObjects(value: boolean) { state.refuseObjects = value; },
    };
}

function targetsFor(checkpointId: string): ManagedCheckpointRequest {
    const object = `https://store.invalid/${checkpointId}/project.enc`;
    const manifest = `https://store.invalid/${checkpointId}/manifest.enc`;
    return {
        checkpointId,
        key,
        targets: {
            objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
            manifest: { putUrl: manifest, headUrl: manifest },
            pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
        },
    };
}

async function coordinator(options: {
    store?: ReturnType<typeof fakeStore>;
    policy?: { periodMs: number; onTurnBoundary: boolean; failureBackoffMs?: number } | null;
    targets?: { next: () => Promise<ManagedCheckpointRequest | null> };
    wrapRunner?: (runner: ManagedCheckpointRunner) => ManagedCheckpointRunner;
    initialState?: Parameters<typeof createManagedCheckpointCoordinator>[0]['initialState'];
} = {}) {
    const store = options.store ?? fakeStore();
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    let issued = 0;
    const runner = createManagedCheckpointRunner({
        tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }],
        workDir: join(await scratch(), 'work'),
        drainBudgetMs: 1000,
        writeTools: MANAGED_WRITE_TOOLS,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        now: () => 1,
        fetchImpl: store.fetchImpl,
    });
    const exposed = options.wrapRunner ? options.wrapRunner(runner) : runner;
    return {
        store,
        runner,
        coordinator: createManagedCheckpointCoordinator({
            runner: exposed,
            targets: options.targets ?? {
                next: async () => targetsFor(String(issued += 1).padStart(64, '0')),
            },
            policy: options.policy === undefined ? { periodMs: 300_000, onTurnBoundary: true } : options.policy,
            ...(options.initialState ? { initialState: options.initialState } : {}),
        }),
    };
}

describe('createManagedCheckpointCoordinator', () => {
    it('shouldActuallyTakeACheckpointThroughTheRunner', async () => {
        const { coordinator: coord, store } = await coordinator();

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toMatchObject({ attempted: true, saved: true });
        // The product wrote real objects and moved the pointer.
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(true);
        expect(coord.checkpointState()).toMatchObject({ saved: true });
    });

    it('shouldLetTheRuntimeStopOnlyAfterOneHasActuallySucceeded', async () => {
        const { coordinator: coord } = await coordinator();

        // Nothing saved yet: no stopping, whatever the idle answer says.
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldNotReportASaveWhenTheStoreRefusesTheUpload', async () => {
        const { coordinator: coord } = await coordinator({ store: fakeStore({ failObjects: true }) });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toMatchObject({ attempted: true, saved: false });
        expect(coord.checkpointState()).toMatchObject({ saved: false });
        // And the runtime may not be stopped on the strength of it.
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
        expect(coord.scheduleState().consecutiveFailures).toBe(1);
        expect(coord.scheduleState().lastSuccessAtMs).toBeUndefined();
    });

    it('shouldKeepTheOlderSavedPointWhenALaterAttemptFails', async () => {
        const store = fakeStore();
        const { coordinator: coord } = await coordinator({ store });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        const saved = coord.checkpointState();

        // The pointer is already there and this attempt writes the same object
        // key, so the conditional write refuses it.
        const failing = createManagedCheckpointCoordinator({
            runner: (await coordinator({ store })).runner,
            targets: { next: async () => targetsFor('1'.padStart(64, '0')) },
            policy: { periodMs: 1, onTurnBoundary: true },
        });
        const result = await failing.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: false });

        // The first coordinator's saved point is untouched by someone else's
        // failure, and its own state still names the checkpoint it verified.
        expect(coord.checkpointState()).toEqual(saved);
    });

    it('shouldStopAuthorisingAStopOnceALaterCheckpointFails', async () => {
        const store = fakeStore();
        const { coordinator: coord } = await coordinator({ store });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // The next one is due and the store refuses it. The older checkpoint
        // is still the newest verified one, but the volume has moved on.
        store.refuseObjects = true;
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: false });

        expect(coord.checkpointState()).toMatchObject({ saved: false });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldNotAuthoriseAStopWhileACheckpointIsStillRunning', async () => {
        // The second tick's targets never arrive until this is called.
        let release: () => void = () => undefined;
        const gate = new Promise<null>((resolve) => { release = () => resolve(null); });
        let issued = 0;
        const { coordinator: coord } = await coordinator({
            targets: {
                next: async () => {
                    issued += 1;
                    if (issued === 1) return targetsFor('1'.padStart(64, '0'));
                    return gate;
                },
            },
        });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // A second checkpoint is due and is waiting on its targets. It has not
        // failed, so failure counting says nothing — but the volume has moved
        // on from the last saved point and this one has not landed.
        const pending = coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(coord.scheduleState().inFlight).toBe(true);
        expect(coord.checkpointState()).toMatchObject({ saved: false });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: false });
        release();
        await pending;
    });

    it('shouldNotAuthoriseAStopOnAStateItDidNotVerifyItself', async () => {
        // A coordinator resumed from a persisted state knows a checkpoint once
        // succeeded; it does not know what has happened to the volume since,
        // because it was not running. That is not a proof it may stop on.
        const { coordinator: coord } = await coordinator({
            initialState: {
                lastSuccessAtMs: 1,
                lastSuccessCheckpointId: 'a'.repeat(64),
                lastSuccessManifestDigest: 'b'.repeat(64),
                consecutiveFailures: 0,
            },
        });
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'unverified-in-this-process' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });

        // Once this process takes one, it may.
        await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldWatchWritesWithoutBeingToldToByDefault', async () => {
        // No `writeGeneration` supplied: the runner's own gate is the source,
        // so forgetting to wire one does not silently disable the check.
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        runner.checkpointDrain.drain.beginWrite()();
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
    });

    it('shouldStopAuthorisingAStopAfterAWriteWithNoAttemptInBetween', async () => {
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // A tool writes. No checkpoint has been attempted since, so failure
        // counting alone would still say the volume is saved.
        const done = runner.checkpointDrain.drain.beginWrite();
        done();

        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldCompareAgainstTheCountTheArchiveWasTakenAtNotTheOneAfterTheGateReopened', async () => {
        // A write that lands after the gate reopens but before the outcome is
        // recorded is a write the archive does not contain. Recording the
        // count at that moment instead of the drained one would fold it into
        // the checkpoint and authorise a stop that loses it.
        let gate: ManagedCheckpointRunner['checkpointDrain'] | null = null;
        const { coordinator: coord } = await coordinator({
            wrapRunner: (runner) => {
                gate = runner.checkpointDrain;
                return {
                    ...runner,
                    takeCheckpoint: async (request) => {
                        const published = await runner.takeCheckpoint(request);
                        // The drain is released by now; this is the window.
                        runner.checkpointDrain.drain.beginWrite()();
                        return published;
                    },
                };
            },
        });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(gate).not.toBeNull();
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldAuthoriseAStopAgainOnceThoseWritesAreCheckpointed', async () => {
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        runner.checkpointDrain.drain.beginWrite()();
        expect(coord.checkpointState()).toMatchObject({ saved: false });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(coord.checkpointState()).toMatchObject({ saved: true });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldNotAttemptWhileSomethingMayStillBeWriting', async () => {
        const { coordinator: coord, store } = await coordinator();
        const result = await coord.tick({
            trigger: 'turn-boundary',
            idle: { state: 'undecidable', reason: 'unproven-writer' },
            now: 1_000_000,
        });
        expect(result).toEqual({ attempted: false, decision: { take: false, reason: 'unproven-writer' } });
        expect(store.objects.size).toBe(0);
    });

    it('shouldTakeNoneWithoutAConfiguredPolicy', async () => {
        const { coordinator: coord, store } = await coordinator({ policy: null });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 }))
            .toEqual({ attempted: false, decision: { take: false, reason: 'no-policy' } });
        expect(store.objects.size).toBe(0);
    });

    it('shouldNotTreatAFailureToFetchTargetsAsAnExpectedSkip', async () => {
        // `null` means the parent has issued none; a throw means the fetch
        // itself failed — an expired signature, an unreachable control plane,
        // a credential that no longer works. Folding the second into the first
        // makes a broken credential path look like an idle project, silently,
        // for as long as it stays broken.
        const { coordinator: coord } = await coordinator({
            targets: { next: async () => { throw Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }); } },
        });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toEqual({
            attempted: false,
            decision: { take: false, reason: 'targets-unavailable', detail: 'EAI_AGAIN' },
        });
        // It counts as a failed checkpoint: nothing was saved and something is
        // wrong, so the backoff applies rather than retrying every tick.
        expect(coord.scheduleState().consecutiveFailures).toBe(1);
        expect(coord.scheduleState().lastSuccessAtMs).toBeUndefined();
        expect(coord.scheduleState().inFlight).toBe(false);
    });

    it('shouldSkipRatherThanFailWhenNoTargetsHaveBeenIssued', async () => {
        const { coordinator: coord } = await coordinator({ targets: { next: async () => null } });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toEqual({ attempted: false, decision: { take: false, reason: 'no-targets' } });
        // Nothing was attempted, so nothing failed.
        expect(coord.scheduleState().consecutiveFailures).toBe(0);
    });

    it('shouldNotStartASecondCheckpointWhileOneIsRunning', async () => {
        const { coordinator: coord } = await coordinator();
        const first = coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        // The runner's drain would refuse this outright; the coordinator
        // answers with a decision instead of an error.
        const second = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_001 });
        expect(second).toEqual({ attempted: false, decision: { take: false, reason: 'in-flight' } });
        expect(await first).toMatchObject({ attempted: true, saved: true });
    });
});
