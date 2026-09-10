import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGenerationManifest, generationScopeDigest } from './generationManifest';
import {
    classifyHelperStatus,
    createLeaseWatchdog,
    createSupervisor,
    generationCgroupPath,
    type SupervisorDeps,
} from './supervisor';

const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };
const NOW = 1_800_000_000_000;
const LEASE = 60_000;

/** ACK 를 낸 뒤 park 된 helper. release/abort 가 결과를 정한다. */
function parkedHandle(pid: number, over: { onRelease?: string; onAbort?: string } = {}) {
    let resolve: (value: { status: string; pid: number | null }) => void = () => {};
    const settled = new Promise<{ status: string; pid: number | null }>((done) => { resolve = done; });
    return {
        pid,
        release: () => resolve({ status: over.onRelease ?? `ack=setup-complete pid=${pid}\n`, pid }),
        abort: () => resolve({
            status: over.onAbort ?? `ack=setup-complete pid=${pid}\nstage=release errno=0\n`, pid,
        }),
        settled,
    };
}

describe('helper status classification', () => {
    it('a bare EOF is not success — an ACK that never arrived is unknown', () => {
        expect(classifyHelperStatus({ status: '', pid: 4242 })).toEqual({ kind: 'unknown', detail: 'no-ack-no-stage' });
    });

    it('a setup refusal names its stage and means nothing ran', () => {
        expect(classifyHelperStatus({ status: 'stage=cgroup errno=2\n', pid: 4242 }))
            .toEqual({ kind: 'setup-refused', stage: 'cgroup' });
    });

    it('an ACK followed by an exec error is a failure, not a success', () => {
        // 준비는 끝났지만 execve 가 실패했다. ACK 만 보고 성공이라 하면 안 된다.
        expect(classifyHelperStatus({ status: 'ack=setup-complete\nstage=exec errno=2\n', pid: 4242 }))
            .toEqual({ kind: 'exec-failed', stage: 'exec' });
    });

    it('the pid comes from the helper’s own ACK, not from spawn alone', () => {
        expect(classifyHelperStatus({ status: 'ack=setup-complete pid=777\n', pid: 4242 }))
            .toEqual({ kind: 'exec-attempted', pid: 777 });
    });

    it('an ACK with no error record only means exec was attempted', () => {
        // helper 가 ACK 뒤 execve 전에 죽어도 여기까지는 같아 보인다.
        // workload 가 실제로 돌았다는 증거는 managed report 에서 온다.
        expect(classifyHelperStatus({ status: 'ack=setup-complete\n', pid: 4242 }))
            .toEqual({ kind: 'exec-attempted', pid: 4242 });
    });
});

describe('generation cgroup path', () => {
    it('is built from the delegated root and the generation identity', () => {
        expect(generationCgroupPath('/sys/fs/cgroup/saycode', KEY))
            .toBe('/sys/fs/cgroup/saycode/run-run-1/attempt-attempt-1/epoch-2');
    });

    it('refuses ids that would escape the delegated root', () => {
        for (const runId of ['../..', 'a/b', '']) {
            expect(() => generationCgroupPath('/sys/fs/cgroup/saycode', { ...KEY, runId }))
                .toThrow(/safe id/);
        }
        expect(() => generationCgroupPath('/sys/fs/cgroup/saycode', { ...KEY, epoch: -1 }))
            .toThrow(/epoch/);
    });
});

describe('supervisor', () => {
    let manifestRoot: string;
    let files: Map<string, string>;
    let dirs: Set<string>;

    function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            mkdir: (path) => { dirs.add(path); },
            writeFile: (path, data) => {
                const dir = path.replace(/\/[^/]+$/, '');
                if (!dirs.has(dir)) {
                    const error = new Error('ENOENT') as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                files.set(path, data);
            },
            readFile: (path) => {
                const value = files.get(path);
                if (value === undefined) throw new Error('missing');
                return value;
            },
            rmdir: (path) => {
                if (files.get(join(path, 'populated')) === 'yes') throw new Error('EBUSY');
                dirs.delete(path);
            },
            launch: async () => parkedHandle(4242),
            enrollWatchdog: () => {},
            ...over,
        };
    }

    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), 'supervisor-manifest-'));
        files = new Map();
        dirs = new Set();
    });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function readyGeneration(d: SupervisorDeps) {
        const supervisor = createSupervisor(config, d);
        // 세대 cgroup 은 `prepareLaunch` 만 만든다. 여기서는 그 결과를 흉내낸다.
        const path = supervisor.generationCgroup(KEY);
        dirs.add(path);
        files.set(join(path, 'cgroup.events'), 'populated 1\nfrozen 0\n');
        return { supervisor, path };
    }

    it('passes only trusted values to the helper — the caller picks the generation, nothing else', async () => {
        const launch = vi.fn(async () => parkedHandle(4242));
        const d = deps({ launch });
        const { supervisor } = readyGeneration(d);
        await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE });
        expect(launch).toHaveBeenCalledWith(expect.objectContaining({
            helperPath: '/usr/local/lib/saycode/exec-helper',
            statusFd: 9,
            releaseFd: 8,
            inheritFds: [],
            env: {},
            argv: [
                '9', '8', '/sys/fs/cgroup/saycode/run-run-1/attempt-attempt-1/epoch-2',
                '10002', '10002', '0', '/usr/local/lib/saycode/node',
            ],
        }));
    });

    it('refuses to build a request that would keep the status fd', async () => {
        const launch = vi.fn(async () => parkedHandle(4242));
        const d = deps({ launch });
        const { supervisor } = readyGeneration(d);
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, inherit: [{ childFd: 3, parentFd: 3 }, { childFd: 9, parentFd: 9 }], leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, inherit: [{ childFd: 8, parentFd: 8 }], leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 9, leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(launch).not.toHaveBeenCalled();
    });

    it('a kill request is not a stop — the cgroup must be observed empty', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'still-populated' });
        // 관측하지 못했으니 증거도 남지 않는다.
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: false });
        expect(files.get(join(path, 'cgroup.kill'))).toBe('1');
    });

    it('records termination only after the empty cgroup is removed', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: true, observedEmptyAt: NOW });
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('an rmdir refusal keeps the generation unproven', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        files.set(join(path, 'populated'), 'yes');
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'rmdir-refused' });
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: false });
    });

    it('an absent generation is not a stop', () => {
        const supervisor = createSupervisor(config, deps());
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'generation-absent' });
    });

    it('the watchdog does not act before the lease expires', () => {
        const d = deps({ monotonicNow: () => 1_000 });
        const { supervisor } = readyGeneration(d);
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 })).toBeNull();
    });

    it('the watchdog stops an expired generation without consulting the daemon', () => {
        const d = deps({ monotonicNow: () => 6_000 });
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        // daemon 은 이 판정에 등장하지 않는다.
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ stopped: true, observedEmptyAt: NOW });
    });

    it('the watchdog uses the monotonic clock, not the wall clock', () => {
        const d = deps({ monotonicNow: () => 1_000, now: () => NOW + 10_000_000 });
        const { supervisor } = readyGeneration(d);
        // 벽시계가 크게 앞서 있어도 만료가 아니다.
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 })).toBeNull();
    });
});

describe('autonomous lease watchdog', () => {
    function fakeSupervisor(outcomes: Array<{ stopped: boolean; detail?: string }>) {
        const calls: unknown[] = [];
        let index = 0;
        return {
            calls,
            supervisor: {
                stopGeneration: (key: typeof KEY) => {
                    calls.push(key);
                    const next = outcomes[Math.min(index++, outcomes.length - 1)]!;
                    return next.stopped
                        ? { stopped: true as const, observedEmptyAt: NOW }
                        : { stopped: false as const, detail: next.detail ?? 'still-populated' };
                },
            },
        };
    }

    it('does nothing before the lease expires', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 1_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        expect(watchdog.tick()).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('stops an expired generation without asking the daemon anything', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        const results = watchdog.tick();
        expect(results).toEqual([{ key: KEY, outcome: { stopped: true, observedEmptyAt: NOW } }]);
        expect(calls).toEqual([KEY]);
        expect(watchdog.armedCount()).toBe(0);
    });

    it('keeps watching a generation whose stop was requested but not observed', () => {
        const { supervisor } = fakeSupervisor([{ stopped: false }, { stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: false });
        // 요청만으로 감시를 놓으면 살아남은 세대가 다시는 집행되지 않는다.
        expect(watchdog.armedCount()).toBe(1);
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: true });
        expect(watchdog.armedCount()).toBe(0);
    });

    it('runs on its own timer', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        let handler: (() => void) | null = null;
        const watchdog = createLeaseWatchdog({
            supervisor,
            monotonicNow: () => 9_000,
            intervalMs: 50,
            setInterval: ((fn: () => void) => { handler = fn; return 1 as unknown as NodeJS.Timeout; }) as never,
            clearInterval: (() => { handler = null; }) as never,
        });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        watchdog.start();
        expect(handler).not.toBeNull();
        handler!();
        expect(calls).toEqual([KEY]);
        watchdog.stop();
    });
});

describe('launch handshake and lease renewal', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'handshake-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function base(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {},
            writeFile: () => {},
            readFile: () => 'populated 0\n',
            rmdir: () => {},
            launch: async () => parkedHandle(4242),
            ...over,
        };
    }

    it('registration runs after the pid is known and before the child is released', async () => {
        const order: string[] = [];
        const supervisor = createSupervisor(config, base({
            launch: async () => {
                order.push('pid-acquired');
                const handle = parkedHandle(4242);
                return { ...handle, release: () => { order.push('released'); handle.release(); } };
            },
        }));
        const outcome = await supervisor.execGeneration({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE,
            onAcquired: async (pid) => { order.push(`registered:${pid}`); },
        });
        // 등록이 release 보다 먼저다 — 빠른 workload 의 첫 보고가 등록을 앞지르지 못한다.
        expect(order).toEqual(['pid-acquired', 'registered:4242', 'released']);
        expect(outcome).toEqual({ kind: 'exec-attempted', pid: 4242 });
    });

    it('a registration failure is propagated, not hidden', async () => {
        const supervisor = createSupervisor(config, base({
            launch: async () => parkedHandle(4242),
        }));
        expect(await supervisor.execGeneration({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE,
            onAcquired: async () => { throw new Error('registry unavailable'); },
        })).toEqual({ kind: 'exec-failed', stage: 'release' });
    });

    it('refuses to renew a generation that was never launched', () => {
        expect(createSupervisor(config, base())
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'never-launched' });
    });

    it('refuses to renew a generation whose stop was already requested', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        deps.manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW });
        expect(createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'termination-pending' });
    });

    it('refuses a renewal whose deadline has already passed', () => {
        const deps = base({ monotonicNow: () => 9_000 });
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'lease-already-expired' });
    });

    it('a renewal updates the watchdog deadline, not just the sequence', () => {
        const armed: unknown[] = [];
        const deps = base({ enrollWatchdog: (entry) => { armed.push(entry); } });
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 });
        expect(armed).toEqual([{ key: KEY, leaseExpiresMonotonic: 5_000 }]);
    });

    it('a renewal must advance the sequence', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: true, leaseExpiresMonotonic: 5_000 });
        // 같은 토큰 재전송으로 deadline 을 늘리지 못한다.
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: false, detail: 'stale-renewal' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 0, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: false, detail: 'stale-renewal' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 2, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: true, leaseExpiresMonotonic: 9_000 });
    });

    it('a different generation has its own sequence', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        deps.manifest.recordLaunch({ key: { ...KEY, epoch: 3 }, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        supervisor.renewLease({ key: KEY, renewalSeq: 5, leaseExpiresMonotonic: 5_000 });
        expect(supervisor.renewLease({ key: { ...KEY, epoch: 3 }, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toMatchObject({ renewed: true });
    });

    it('refuses renewals that are not usable numbers', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        expect(supervisor.renewLease({ key: KEY, renewalSeq: -1, leaseExpiresMonotonic: 1 }))
            .toEqual({ renewed: false, detail: 'invalid-renewal-seq' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: Number.NaN }))
            .toEqual({ renewed: false, detail: 'invalid-expiry' });
    });
});

describe('a cancelled generation is never released (Astra P1-1)', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'release-guard-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {},
            writeFile: () => {},
            readFile: () => 'populated 1\n',
            rmdir: () => {},
            launch: async () => parkedHandle(4242),
            ...over,
        };
    }

    function tracked() {
        let releases = 0;
        let aborts = 0;
        const handle = parkedHandle(4242);
        return {
            get releases() { return releases; },
            get aborts() { return aborts; },
            handle: {
                ...handle,
                release: () => { releases += 1; handle.release(); },
                abort: () => { aborts += 1; handle.abort(); },
            },
        };
    }

    it('refuses to release a generation whose stop was requested while it was parked', async () => {
        // `requestStop` 은 의도를 남겼지만 kill 은 park 된 helper 를 죽이지
        // 못했다. 그대로 놓아주면 취소된 세대가 실행된다.
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        d.manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW });
        const supervisor = createSupervisor(config, d);
        const probe = tracked();
        expect(await supervisor.releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'termination-pending' });
        expect(probe.releases).toBe(0);
        expect(probe.aborts).toBe(1);
    });

    it('refuses to release a generation already observed stopped', async () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        d.manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'already-stopped' });
        expect(probe.releases).toBe(0);
    });

    it('refuses to release when the lease expired during preparation', async () => {
        const d = deps({ monotonicNow: () => 99_000 });
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'lease-already-expired' });
        expect(probe.releases).toBe(0);
    });

    it('refuses to release when the record cannot be read — unknown is not permission', async () => {
        // 거부 목록을 쓰면 이 상태가 목록에 없어 통과한다. 취소됐는지 모르는데
        // 놓아주는 것이 정확히 그 결함이었다.
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'record-unreadable' });
        expect(probe.releases).toBe(0);
        expect(probe.aborts).toBe(1);
    });

    it('refuses to renew when the record cannot be read', () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(createSupervisor(config, d)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 60_000 }))
            .toEqual({ renewed: false, detail: 'record-unreadable' });
    });

    it('a stop that could not record its intent does not become permission to release', async () => {
        // 원장을 쓰지 못해 정지 요청조차 남기지 못한 상태다.
        const d = deps({
            manifest: {
                ...createGenerationManifest(manifestRoot),
                recordTerminationRequested: () => { throw new Error('unwritable'); },
            },
        });
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, d);
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'manifest-unwritable' });
        // 정지에 실패했다고 해서 실행 권한이 생기지는 않는다.
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        const probe = tracked();
        expect(await supervisor.releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toMatchObject({ kind: 'setup-refused' });
        expect(probe.releases).toBe(0);
    });

    it('releases a live, uncancelled generation', async () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'exec-attempted', pid: 4242 });
        expect(probe.releases).toBe(1);
    });
});

describe('an expired lease cannot be revived by a newer renewal (Astra P1-2)', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/h',
        workloadPath: '/w',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'renew-guard-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    it('stores the current deadline so a renewal actually moves it', () => {
        const armed: Array<{ leaseExpiresMonotonic: number }> = [];
        const manifest = createGenerationManifest(manifestRoot);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, {
            manifest,
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: (entry) => { armed.push(entry); },
            mkdir: () => {}, writeFile: () => {}, readFile: () => 'populated 0\n', rmdir: () => {},
            launch: async () => parkedHandle(1),
        });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toMatchObject({ renewed: true });
        expect(armed).toEqual([{ key: KEY, leaseExpiresMonotonic: 5_000 }]);
    });

    it('a renewal arriving after the stored deadline passed is refused and records stop intent', () => {
        const manifest = createGenerationManifest(manifestRoot);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        let clock = 1_000;
        const supervisor = createSupervisor(config, {
            manifest,
            monotonicNow: () => clock,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {}, writeFile: () => {}, readFile: () => 'populated 0\n', rmdir: () => {},
            launch: async () => parkedHandle(1),
        });
        supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 });
        // watchdog tick 이 돌기 전에 만료됐고, 더 큰 seq 와 미래 deadline 이 온다.
        clock = 9_000;
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 2, leaseExpiresMonotonic: 20_000 }))
            .toEqual({ renewed: false, detail: 'lease-expired' });
        // 그 tick 이 확실히 집행하도록 정지 의도가 남는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({ detail: 'termination-pending' });
    });
});
