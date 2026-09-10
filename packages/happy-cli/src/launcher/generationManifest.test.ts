import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGenerationManifest, generationScopeDigest } from './generationManifest';

const NOW = 1_800_000_000_000;
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

describe('generation manifest', () => {
    let root: string;

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-manifest-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('a generation this supervisor never launched is not something to prove', () => {
        expect(createGenerationManifest(root).proveStopped(KEY))
            .toEqual({ proven: false, detail: 'never-launched' });
    });

    it('a launched generation with no observed termination is unknown, not stopped', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'termination-unknown' });
    });

    it('the never-launched / unknown distinction survives a restart', () => {
        createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW });
        const reopened = createGenerationManifest(root);
        expect(reopened.proveStopped(KEY)).toMatchObject({ detail: 'termination-unknown' });
        expect(reopened.proveStopped({ ...KEY, epoch: 9 })).toMatchObject({ detail: 'never-launched' });
    });

    it('ids containing the delimiter cannot collide into one record', () => {
        // `a__b` + `c` 와 `a` + `b__c` 는 구분자 이름에서 같은 파일이 된다.
        const left = { runId: 'a__b', attemptId: 'c', epoch: 0 };
        const right = { runId: 'a', attemptId: 'b__c', epoch: 0 };
        expect(generationScopeDigest(left)).not.toBe(generationScopeDigest(right));
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: left, launchedAt: NOW });
        manifest.recordTermination({ key: left, observedEmptyAt: NOW });
        expect(manifest.proveStopped(left)).toMatchObject({ proven: true });
        expect(manifest.proveStopped(right)).toMatchObject({ proven: false, detail: 'never-launched' });
    });

    it('proves a generation observed empty, and stays proven after the cgroup is gone', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        // cgroup 디렉터리는 이미 사라졌다. 그래도 증명은 남는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({
            proven: true, record: { observedEmptyAt: NOW },
        });
    });

    it('re-proving is idempotent and keeps the first observation', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW + 5_000 });
        const first = manifest.proveStopped(KEY);
        const second = manifest.proveStopped(KEY);
        expect(first).toEqual(second);
        expect(first).toMatchObject({ record: { observedEmptyAt: NOW } });
    });

    it('survives a restart — a new manifest object reads the same evidence', () => {
        createGenerationManifest(root).recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(createGenerationManifest(root).proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('proveStopped matches the full requested scope, not just the epoch', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(manifest.proveStopped({ ...KEY, epoch: 3 }))
            .toEqual({ proven: false, detail: 'never-launched' });
        expect(manifest.proveStopped({ ...KEY, runId: 'run-2' }))
            .toEqual({ proven: false, detail: 'never-launched' });
        expect(manifest.proveStopped({ ...KEY, attemptId: 'other' }))
            .toEqual({ proven: false, detail: 'never-launched' });
    });

    it('refuses to overwrite a record it cannot read', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(() => manifest.recordTermination({ key: KEY, observedEmptyAt: NOW }))
            .toThrow(/unreadable/);
    });

    it('a damaged record is unreadable, never treated as absence or as proof', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{not json');
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'record-unreadable' });
    });

    it('a record whose contents name another scope is not this scope’s answer', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), JSON.stringify({
            version: 1, runId: 'someone-else', attemptId: 'x', epoch: 0,
            launchedAt: NOW, observedEmptyAt: NOW,
        }));
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'record-unreadable' });
    });

    it('refuses a manifest root that is writable by others', () => {
        const open = mkdtempSync(join(tmpdir(), 'gen-open-'));
        chmodSync(open, 0o777);
        expect(() => createGenerationManifest(open)).toThrow(/writable by others/);
        rmSync(open, { recursive: true, force: true });
    });

    it('refuses a manifest root owned by someone else', () => {
        expect(() => createGenerationManifest(root, { ownerUid: 999_999 }))
            .toThrow(/unexpected owner/);
    });

    it('leaves no partial file behind for a reader to trust', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(require('node:fs').readdirSync(root).filter((e: string) => e.endsWith('.tmp'))).toEqual([]);
    });

    describe('proving every launched generation below an epoch', () => {
        it('nothing launched means nothing to prove', () => {
            expect(createGenerationManifest(root).proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('a launched generation with no termination blocks the proof', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'run-1', attemptId: 'a', epoch: 1 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'termination-unknown' });
        });

        it('does not require generations that were never launched', () => {
            // epoch 0,2 만 띄웠다. 1 은 존재한 적이 없으므로 증명 대상이 아니다.
            const manifest = createGenerationManifest(root);
            for (const epoch of [0, 2]) {
                const key = { runId: 'run-1', attemptId: 'a', epoch };
                manifest.recordLaunch({ key, launchedAt: NOW });
                manifest.recordTermination({ key, observedEmptyAt: NOW });
            }
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('generations at or above the epoch are not required', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'run-1', attemptId: 'a', epoch: 7 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('covers every run and attempt — the contract is runtime-wide', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'other-run', attemptId: 'z', epoch: 0 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
                .toMatchObject({ proven: false, detail: 'termination-unknown' });
        });

        it('an unreadable record blocks the proof instead of being skipped', () => {
            const manifest = createGenerationManifest(root);
            const key = { runId: 'run-1', attemptId: 'a', epoch: 0 };
            manifest.recordLaunch({ key, launchedAt: NOW });
            writeFileSync(join(root, `${generationScopeDigest(key)}.json`), 'broken');
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'record-unreadable' });
        });

        it('an oversize record is unreadable, not ignored', () => {
            const manifest = createGenerationManifest(root);
            const key = { runId: 'run-1', attemptId: 'a', epoch: 0 };
            manifest.recordLaunch({ key, launchedAt: NOW });
            writeFileSync(join(root, `${generationScopeDigest(key)}.json`), 'x'.repeat(8192));
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'record-unreadable' });
        });
    });

    it('refuses ids that would escape the manifest directory', () => {
        const manifest = createGenerationManifest(root);
        for (const runId of ['../escape', 'a/b', '']) {
            expect(() => manifest.proveStopped({ ...KEY, runId })).toThrow(/safe id/);
        }
        expect(() => manifest.proveStopped({ ...KEY, epoch: -1 })).toThrow(/epoch/);
    });
});

describe('a generation is launched once', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-once-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('accepts the first launch', () => {
        expect(createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW }))
            .toEqual({ ok: true });
    });

    it('refuses a second launch of the same generation while it is open', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 1 }))
            .toEqual({ ok: false, reason: 'already-launched' });
    });

    it('refuses relaunching a terminated generation — that would make a live child look stopped', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW + 10 });
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 20 }))
            .toEqual({ ok: false, reason: 'already-terminated' });
        // 종료 증거가 그대로 남아 새 workload 를 덮지 않는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('refuses when the existing record cannot be read', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 1 }))
            .toEqual({ ok: false, reason: 'record-unreadable' });
    });
});

describe('open inventory and pending termination', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-open-inv-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('lists generations whose termination was never observed', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const done = { runId: 'run-1', attemptId: 'a', epoch: 9 };
        manifest.recordLaunch({ key: done, launchedAt: NOW });
        manifest.recordTermination({ key: done, observedEmptyAt: NOW });
        const open = manifest.listOpen();
        expect(open.records.map((record) => record.epoch)).toEqual([KEY.epoch]);
        expect(open.unreadable).toBe(0);
    });

    it('the inventory survives a restart so a running child can be re-armed', () => {
        createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW });
        expect(createGenerationManifest(root).listOpen().records).toHaveLength(1);
    });

    it('a requested-but-unobserved termination is pending, not stopped and not unknown', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW + 1 });
        // kill 뒤 관측 전에 죽은 상태다. 치웠다고 읽으면 안 된다.
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'termination-pending' });
        expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
            .toMatchObject({ proven: false, detail: 'termination-pending' });
        expect(manifest.listOpen().records).toHaveLength(1);
    });

    it('counts entries it cannot read instead of silently skipping them', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, 'not-a-digest.json'), '{}');
        expect(manifest.listOpen().unreadable).toBe(1);
    });

    it('a record filed under the wrong digest is not trusted', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        const other = { runId: 'run-1', attemptId: 'a', epoch: 4 };
        // 다른 scope 의 이름으로 종료 기록을 갖다 놓아 증명을 만들 수 없다.
        writeFileSync(join(root, `${generationScopeDigest(other)}.json`), JSON.stringify({
            version: 1, ...KEY, launchedAt: NOW, terminationRequestedAt: null, observedEmptyAt: NOW,
        }));
        expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
            .toMatchObject({ proven: false, detail: 'record-unreadable' });
    });
});
