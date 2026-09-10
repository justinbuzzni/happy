/**
 * 별도 supervisor **프로세스** 와 daemon client 의 수명주기.
 *
 * 함수 호출로만 확인하면 소켓 인증·핸들 수명·프로세스 경계가 검증되지 않는다.
 * 여기서는 supervisor 를 자식 프로세스로 띄우고 실제 Unix 소켓으로 대화한다.
 * cgroup 이 없는 환경(개발 macOS 포함)에서도 도는 부분만 다룬다 — 실제 exec 과
 * fencing 은 `docker/managed-launch/verify-*.sh` 가 Linux 에서 판정한다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLauncherClient, createUnixSocketRequest } from '@/daemon/launch/launcherClient';

const TOKEN = 'process-fixture-token';
// `@/` alias 를 쓰는 소스를 자식 프로세스에서 그대로 돌리려면 tsconfig 를 명시해야 한다.
const PACKAGE_ROOT = resolve(__dirname, '../..');
const TSX_CLI = createRequire(__filename).resolve('tsx/cli');
const TSCONFIG = join(PACKAGE_ROOT, 'tsconfig.json');
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

describe('supervisor process ↔ daemon client', () => {
    let dir: string;
    let child: ChildProcess | null = null;
    let socketPath: string;
    let entryDir: string;

    async function startSupervisor(): Promise<void> {
        const entry = join(entryDir, 'run-supervisor.ts');
        writeFileSync(entry, `
import { createSupervisorRuntime } from ${JSON.stringify(join(__dirname, 'main'))};
const runtime = createSupervisorRuntime({
  config: {
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/node',
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
  },
  manifestRoot: ${JSON.stringify(join(dir, 'manifest'))},
  stagingRoot: ${JSON.stringify(join(dir, 'staging'))},
  socketPath: ${JSON.stringify(socketPath)},
  watchdogIntervalMs: 250,
  releaseDeadlineMs: 2000,
  runtimeId: 'fixture-' + process.pid,
  token: ${JSON.stringify(TOKEN)},
  // 운영은 Linux 추상 소켓 잠금을 쓴다. 이 fixture 는 macOS 에서도 돌아야 해서
  // 그 자리만 바꾼다 — 잠금 자체의 계약은 아래 전용 테스트가 확인한다.
  acquireLock: async () => ({ ok: true, release: async () => {} }),
});
await runtime.start();
process.send?.('ready');
`);
        child = spawn(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, entry], {
            cwd: PACKAGE_ROOT,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('supervisor did not start')), 20_000);
            child!.on('message', () => { clearTimeout(timer); resolve(); });
            let stderr = '';
            child!.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child!.on('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`exited ${code}: ${stderr.slice(0, 600)}`));
            });
        });
    }

    function client(token = TOKEN) {
        return createLauncherClient({ token, deps: createUnixSocketRequest(socketPath, 5_000) });
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'supervisor-process-'));
        socketPath = join(dir, 'launcher.sock');
        // 진입 스크립트는 패키지 안에 둔다. 패키지 밖의 절대 `.ts` 경로를
        // import 하면 tsx 가 변환하지 못한다.
        entryDir = mkdtempSync(join(PACKAGE_ROOT, '.supervisor-fixture-'));
    });

    afterEach(() => {
        child?.kill('SIGKILL');
        child = null;
        rmSync(dir, { recursive: true, force: true });
        rmSync(entryDir, { recursive: true, force: true });
    });

    it('answers a fencing question over the real socket', async () => {
        await startSupervisor();
        // 아무것도 띄운 적이 없으니 증명할 대상이 없다.
        expect(await client().proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER }))
            .toMatchObject({ proven: true });
    }, 30_000);

    it('refuses a client without the boot token', async () => {
        await startSupervisor();
        expect(await client('wrong-token').requestStop(KEY))
            .toEqual({ requested: false, detail: 'unauthorized' });
    }, 30_000);

    it('refuses a bootstrap that is not a real B2 envelope, without staging it', async () => {
        await startSupervisor();
        const prepared = await client().prepareLaunch({
            key: KEY, leaseExpiresMonotonic: Date.now() + 60_000,
            bootstrap: Buffer.from('{"not":"an envelope"}'),
        });
        expect(prepared).toEqual({ prepared: false, detail: 'bootstrap-invalid' });
    }, 30_000);

    it('a release handle that was never issued is refused', async () => {
        await startSupervisor();
        expect(await client().releaseLaunch('0'.repeat(32)))
            .toEqual({ released: false, detail: 'unknown-handle' });
    }, 30_000);

    it('refuses to renew a generation this supervisor never launched', async () => {
        await startSupervisor();
        expect(await client().renew({
            key: KEY, renewalSeq: 1, leaseExpiresMonotonic: Date.now() + 60_000,
        })).toEqual({ renewed: false, detail: 'never-launched' });
    }, 30_000);

    it.skipIf(process.platform !== 'linux')('a second supervisor on the same runtime id refuses to start', async () => {
        await startSupervisor();
        const entry = join(entryDir, 'second.ts');
        writeFileSync(entry, `
import { acquireSupervisorLock } from ${JSON.stringify(join(__dirname, 'supervisor'))};
const shared = { runtimeId: 'fixtureshared', manifestRoot: '/tmp', cgroupRoot: '/tmp' };
const first = await acquireSupervisorLock(shared);
// 같은 물리 자원을 **다른 runtimeId** 로 열어도 막혀야 한다.
const second = await acquireSupervisorLock({ ...shared, runtimeId: 'fixtureother' });
console.log(JSON.stringify({ first: first.ok, second }));
process.exit(0);
`);
        const output = await new Promise<string>((resolve) => {
            const probe = spawn(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, entry], {
                cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            probe.stdout.on('data', (chunk) => { out += String(chunk); });
            probe.on('close', () => resolve(out));
        });
        const parsed = JSON.parse(output.trim().split('\n').pop() ?? '{}');
        expect(parsed.first).toBe(true);
        // 두 번째는 같은 이름을 잡지 못한다 — 원장과 cgroup 을 나눠 쓰지 않는다.
        expect(parsed.second).toMatchObject({ ok: false, reason: 'already-held' });
    }, 30_000);
});

describe('supervisor exclusivity', () => {
    it('is a Linux-only lock and says so rather than pretending', async () => {
        const { acquireSupervisorLock } = await import('./supervisor');
        const result = await acquireSupervisorLock({
            runtimeId: 'exclusivityprobe', manifestRoot: '/tmp', cgroupRoot: '/tmp',
        });
        if (process.platform === 'linux') {
            expect(result).toMatchObject({ ok: true });
            if (result.ok) await result.release();
        } else {
            // managed 는 Linux 전용이다. 다른 곳에서 잠금을 흉내내면 두
            // supervisor 가 같은 원장을 쓰는 것을 막는다고 착각하게 된다.
            expect(result).toEqual({ ok: false, reason: 'not-linux' });
        }
    });

    it('refuses a runtime id that could escape the lock namespace', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        for (const runtimeId of ['a b', '../x', '']) {
            expect(() => supervisorLockAddress({
                runtimeId, manifestRoot: '/tmp', cgroupRoot: '/tmp',
            })).toThrow(/safe runtimeId/);
        }
    });
});

describe('shutdown does not orphan released children (Astra P1-3)', () => {
    it('keeps the watchdog and the lock when an open generation cannot be proven stopped', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-guard-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                    helperPath: '/usr/local/lib/saycode/exec-helper',
                    workloadPath: '/usr/local/lib/saycode/node',
                    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdown-guard',
                acquireLock: async () => ({
                    ok: true,
                    release: async () => { lockReleased = true; },
                }),
            });
            await runtime.start();
            // 이전에 놓아준 자식이 남아 있는 상태를 만든다: 원장에 열린 기록이
            // 있고, cgroup 은 이 환경에 없어 정지를 증명할 수 없다.
            runtime.manifest.recordLaunch({
                key: { runId: 'r', attemptId: 'a', epoch: 0 }, launchedAt: Date.now(),
            });
            const result = await runtime.stop();
            expect(result).toMatchObject({ stopped: false });
            if (!result.stopped) expect(result.open).toHaveLength(1);
            // 감시를 놓는 것이 곧 그 자식을 잃는 것이다.
            expect(runtime.watchdog.armedCount()).toBe(1);
            expect(lockReleased).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('refuses to release the lock while the inventory cannot be read', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const { writeFileSync } = await import('node:fs');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-unreadable-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdownunreadable',
                acquireLock: async () => ({ ok: true, release: async () => { lockReleased = true; } }),
            });
            await runtime.start();
            // 읽을 수 없는 기록 하나. 무엇이 열려 있는지 알 수 없는 상태다.
            writeFileSync(join(root, 'manifest', `${'a'.repeat(64)}.json`), 'broken');
            const result = await runtime.stop();
            expect(result).toMatchObject({ stopped: false, unreadable: 1 });
            expect(lockReleased).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('releases the lock only when nothing is left open', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-clean-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                    helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdown-clean',
                acquireLock: async () => ({
                    ok: true,
                    release: async () => { lockReleased = true; },
                }),
            });
            await runtime.start();
            expect(await runtime.stop()).toEqual({ stopped: true });
            expect(lockReleased).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('the lock is bound to the physical resources, not to a name', () => {
    it('two different runtime ids over the same roots produce the same lock', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        const roots = { manifestRoot: '/tmp', cgroupRoot: '/tmp' };
        // 같은 원장과 같은 cgroup 을 여는 두 supervisor 는 서로를 막아야 한다.
        expect(supervisorLockAddress({ runtimeId: 'alpha', ...roots }))
            .toBe(supervisorLockAddress({ runtimeId: 'beta', ...roots }));
    });

    it('the same runtime over different roots is a different lock', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        expect(supervisorLockAddress({ runtimeId: 'r', manifestRoot: '/tmp', cgroupRoot: '/tmp' }))
            .not.toBe(supervisorLockAddress({ runtimeId: 'r', manifestRoot: '/var', cgroupRoot: '/tmp' }));
    });
});
