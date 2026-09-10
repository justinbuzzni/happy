import { describe, expect, it } from 'vitest';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    type ProviderSupervisorConfig,
    providerWorkloadScript,
    startManagedProviderRun,
} from './managedProviderRun';
import type { ManagedToolSession } from './managedToolSession';

const KEY = { runId: 'run1', attemptId: 'a1', epoch: 0 };

function fakeSession(events: string[]): ManagedToolSession {
    return {
        providerPlan: {
            agent: 'codex',
            cwd: '/workspace/project',
            env: { PATH: '/usr/bin' },
            args: [],
            files: [{ path: '/run/codex/environments.toml', contents: 'include_local = false\n', mode: 0o444 }],
            sdkOptions: null,
        },
        brokerPort: 4242,
        revoke: async () => { events.push('revoke'); return { proven: true, detail: 'cgroup-empty' }; },
        close: async () => { events.push('session-close'); return { proven: true, detail: 'cgroup-empty' }; },
    };
}

function fakeSupervisor(events: string[], outcomeKind: 'exec-attempted' | 'setup-refused' = 'exec-attempted') {
    return {
        execGeneration: async (call: { onAcquired?: (pid: number) => Promise<void> }) => {
            events.push('park');
            if (call.onAcquired) await call.onAcquired(777);
            events.push('release');
            return outcomeKind === 'exec-attempted'
                ? { kind: 'exec-attempted' as const, pid: 777 }
                : { kind: 'setup-refused' as const, stage: 'cgroup-create-failed' };
        },
        stopGeneration: () => { events.push('stop-generation'); return { stopped: true as const, observedEmptyAt: 1 }; },
    };
}

const base = (events: string[]) => ({
    session: fakeSession(events),
    key: KEY,
    statusFd: 9,
    releaseFd: 8,
    leaseExpiresMonotonic: 10_000,
    writeFile: (file: { path: string }) => { events.push(`write:${file.path}`); },
    workloadPath: '/usr/local/lib/saycode/provider-run1',
    execPath: '/usr/local/bin/codex',
    register: async (pid: number) => { events.push(`register:${pid}`); },
    identity: { provider: { uid: 10601, gid: 10601 } },
    readProcEnviron: () => ({ PATH: '/usr/bin', PWD: '/workspace/project' }),
    onUnprovenTermination: (info: { tool: string; detail?: string }) => { events.push(`unproven:${info.tool}`); },
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    // `/usr/local/bin/codex` 가 잎이고 그 위는 전부 디렉터리다.
    lstatPath: (path: string) => ({
        uid: 0, mode: 0o755, isSymbolicLink: false,
        isDirectory: path !== '/usr/local/bin/codex', isFile: path === '/usr/local/bin/codex',
    }),
});

describe('managed provider run', () => {
    it('writes the policy files and the launch definition before the child is even parked', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({ ...base(events), createSupervisor: () => fakeSupervisor(events) });
        expect(run.outcome).toEqual({ kind: 'exec-attempted', pid: 777 });
        // helper 는 인자 검사에서 workload 파일을 확인한다. park 보다도 앞이어야 하고,
        // 당연히 release 보다 앞이다 — 뒤면 정책 없이 도구를 광고하는 구간이 생긴다.
        expect(events.indexOf('write:/run/codex/environments.toml'))
            .toBeLessThan(events.indexOf('park'));
        expect(events.indexOf('write:/usr/local/lib/saycode/provider-run1'))
            .toBeLessThan(events.indexOf('park'));
    });

    it('stops the generation before closing the broker', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({ ...base(events), createSupervisor: () => fakeSupervisor(events) });
        await run.stop();
        // 문을 먼저 닫으면 이미 도는 도구가 살아남는다.
        expect(events.indexOf('stop-generation')).toBeLessThan(events.indexOf('session-close'));
    });

    it('does not leave the tool boundary open when the launch is refused', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({
            ...base(events), createSupervisor: () => fakeSupervisor(events, 'setup-refused'),
        });
        expect(run.outcome).toMatchObject({ kind: 'setup-refused' });
        expect(events).toContain('session-close');
    });

    it('never releases a run whose registration failed', async () => {
        const events: string[] = [];
        await expect(startManagedProviderRun({
            ...base(events),
            createSupervisor: () => ({
                execGeneration: async (call: { onAcquired?: (pid: number) => Promise<void> }) => {
                    events.push('park');
                    if (call.onAcquired) await call.onAcquired(777);
                    events.push('release');
                    return { kind: 'exec-attempted' as const, pid: 777 };
                },
                stopGeneration: () => { events.push('stop-generation'); return { stopped: true as const, observedEmptyAt: 1 }; },
            }),
            register: async () => { throw new Error('registration refused'); },
        })).rejects.toThrow(/registration refused/);
        expect(events).not.toContain('release');
        expect(events).toContain('session-close');
    });

    it('does not repeat a proven stop', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({ ...base(events), createSupervisor: () => fakeSupervisor(events) });
        expect(await run.stop()).toEqual({ stopped: true, observedEmptyAt: 1 });
        await run.stop();
        expect(events.filter((e) => e === 'stop-generation')).toHaveLength(1);
    });

    it('never turns a failed stop into proof of stopping', async () => {
        const events: string[] = [];
        let attempts = 0;
        const run = await startManagedProviderRun({
            ...base(events),
            createSupervisor: () => ({
                execGeneration: async (call: { onAcquired?: (pid: number) => Promise<void> }) => {
                    if (call.onAcquired) await call.onAcquired(777);
                    return { kind: 'exec-attempted' as const, pid: 777 };
                },
                stopGeneration: () => {
                    events.push('stop-generation');
                    // 첫 시도는 비었음을 관측하지 못한다.
                    return ++attempts === 1
                        ? { stopped: false as const, detail: 'still-populated' }
                        : { stopped: true as const, observedEmptyAt: 42 };
                },
            }),
        });
        // 실패는 실패로 돌려준다. `observedEmptyAt: 0` 같은 가짜 증거를 만들지 않는다.
        expect(await run.stop()).toEqual({ stopped: false, detail: 'still-populated' });
        // 증명되지 않았으므로 다시 시도한다.
        expect(await run.stop()).toEqual({ stopped: true, observedEmptyAt: 42 });
        expect(events.filter((e) => e === 'stop-generation')).toHaveLength(2);
    });
});

describe('the launch actually carries the plan', () => {
    it('writes a workload that execs the agent with the plan’s arguments', async () => {
        const events: string[] = [];
        const written: Array<{ path: string; contents: string; mode: number }> = [];
        const session = fakeSession(events);
        session.providerPlan.args = ['--disable', 'hooks', '-c', 'mcp_servers.saycode.url="http://127.0.0.1:1/"'];
        await startManagedProviderRun({
            ...base(events),
            session,
            createSupervisor: () => fakeSupervisor(events),
            writeFile: (file) => { written.push(file); events.push(`write:${file.path}`); },
        });
        const workload = written.find((file) => file.path === '/usr/local/lib/saycode/provider-run1');
        // helper 는 인자 없이 workload 하나만 execve 한다. 계획의 인자는 이 스크립트가 싣는다.
        expect(workload?.contents).toContain('/usr/local/bin/codex');
        expect(workload?.contents).toContain("'--disable' 'hooks'");
        expect(workload?.contents).toContain('mcp_servers.saycode.url');
        // provider 가 자기 실행 정의를 다시 쓸 수 있으면 정책이 아니다.
        expect(workload?.mode).toBe(0o555);
        // 계획의 cwd 를 실제로 소비한다. helper 도 supervisor 도 chdir 하지 않는다.
        expect(workload?.contents).toContain("cd '/workspace/project' || exit 70");
    });

    it('registers before release and refuses to run without a registrar', async () => {
        const events: string[] = [];
        await startManagedProviderRun({ ...base(events), createSupervisor: () => fakeSupervisor(events) });
        expect(events.indexOf('register:777')).toBeLessThan(events.indexOf('release'));
    });
});

describe('workload script quoting', () => {
    it('survives an argument containing quotes and spaces — checked by running it', () => {
        const script = providerWorkloadScript({
            path: '/usr/local/lib/saycode/provider-quote',
            execPath: '/bin/echo',
            args: ["it's", 'two words', '-c', 'x="y z"'],
            cwd: '/',
        });
        const dir = mkdtempSync(join(tmpdir(), 'p4-workload-'));
        const file = join(dir, 'workload.sh');
        writeFileSync(file, script.contents, { mode: 0o555 });
        // 인용이 깨지면 인자가 쪼개지거나 쉘이 다른 것을 실행한다. 실제로 돌려 본다.
        const printed = execFileSync('/bin/sh', [file], { encoding: 'utf8' }).trim();
        expect(printed).toBe(`it's two words -c x="y z"`);
        rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a workload path outside the trusted directory', () => {
        expect(() => providerWorkloadScript({
            path: '/tmp/anywhere', execPath: '/bin/echo', args: [], cwd: '/workspace/project',
        })).toThrow(/trusted directory/);
    });
});

describe('the workload enters the planned directory', () => {
    it('refuses to run when it cannot enter the planned cwd — checked by running it', () => {
        const script = providerWorkloadScript({
            path: '/usr/local/lib/saycode/provider-cwd',
            execPath: '/bin/echo',
            args: ['should-not-run'],
            cwd: '/no/such/directory',
        });
        const dir = mkdtempSync(join(tmpdir(), 'p4-cwd-'));
        const file = join(dir, 'workload.sh');
        writeFileSync(file, script.contents, { mode: 0o555 });
        let printed = '';
        let code = 0;
        try {
            printed = execFileSync('/bin/sh', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (error) {
            code = (error as { status?: number }).status ?? -1;
        }
        expect(code).toBe(70);
        expect(printed).not.toContain('should-not-run');
        rmSync(dir, { recursive: true, force: true });
    });

    it('actually starts in the planned directory', () => {
        const target = mkdtempSync(join(tmpdir(), 'p4-target-'));
        const script = providerWorkloadScript({
            path: '/usr/local/lib/saycode/provider-cwd-ok',
            execPath: '/bin/pwd',
            args: [],
            cwd: target,
        });
        const dir = mkdtempSync(join(tmpdir(), 'p4-cwd-ok-'));
        const file = join(dir, 'workload.sh');
        writeFileSync(file, script.contents, { mode: 0o555 });
        const printed = execFileSync('/bin/sh', [file], { encoding: 'utf8' }).trim();
        expect(printed).toBe(execFileSync('/bin/sh', ['-c', `cd ${target} && pwd`], { encoding: 'utf8' }).trim());
        rmSync(dir, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
    });
});

describe('nothing is left open when preparation cannot even write', () => {
    it('closes the tool boundary if a plan file cannot be written', async () => {
        const events: string[] = [];
        await expect(startManagedProviderRun({
            ...base(events),
            createSupervisor: () => fakeSupervisor(events),
            writeFile: () => { throw new Error('read-only filesystem'); },
        })).rejects.toThrow(/read-only filesystem/);
        expect(events).toContain('session-close');
        expect(events).not.toContain('park');
    });
});

describe('the provider executable itself must be trusted', () => {
    const dirStat = { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false, isFile: false };
    const fileStat = { uid: 0, mode: 0o555, isDirectory: false, isSymbolicLink: false, isFile: true };

    it('refuses a leaf that is not a root-owned, others-unwritable regular file', async () => {
        for (const [leaf, message] of [
            [{ ...fileStat, isFile: false }, /regular file/],
            [{ ...fileStat, uid: 1000 }, /owned by root/],
            [{ ...fileStat, mode: 0o557 }, /writable by others/],
            [{ ...fileStat, mode: 0o575 }, /writable by others/],
            [{ ...fileStat, isSymbolicLink: true }, /symlink/],
        ] as const) {
            const events: string[] = [];
            await expect(startManagedProviderRun({
                ...base(events),
                createSupervisor: () => fakeSupervisor(events),
                lstatPath: (path: string) => (path === '/usr/local/bin/codex' ? leaf : dirStat),
            })).rejects.toThrow(message);
            // 검사에 걸리면 아무것도 쓰지 않고 경계도 남기지 않는다.
            expect(events).not.toContain('park');
            expect(events).toContain('session-close');
        }
    });

    it('refuses when any ancestor directory is writable, symlinked or foreign', async () => {
        for (const bad of [
            { ...dirStat, mode: 0o777 },
            { ...dirStat, isSymbolicLink: true },
            { ...dirStat, uid: 1000 },
            { ...dirStat, isDirectory: false },
        ]) {
            const events: string[] = [];
            await expect(startManagedProviderRun({
                ...base(events),
                createSupervisor: () => fakeSupervisor(events),
                // `/usr/local` 한 칸만 흔들려도 잎의 소유권은 의미가 없다.
                lstatPath: (path: string) => (path === '/usr/local' ? bad : (path === '/usr/local/bin/codex' ? fileStat : dirStat)),
            })).rejects.toThrow(/not trusted/);
            expect(events).not.toContain('park');
        }
    });

    it('refuses a workload path that escapes the trusted root', () => {
        for (const path of [
            '/usr/local/lib/saycode/../../../tmp/x',
            '/usr/local/lib/saycode/nested/x',
            '/usr/local/lib/saycodex/x',
            '/tmp/x',
        ]) {
            expect(() => providerWorkloadScript({
                path, execPath: '/bin/echo', args: [], cwd: '/workspace/project',
            })).toThrow(/trusted directory/);
        }
    });
});

describe('stopping means both the provider and its tools stopped', () => {
    function sessionWithClose(events: string[], proof: { proven: boolean; detail: string }) {
        const session = fakeSession(events);
        return {
            ...session,
            close: async () => { events.push('session-close'); return proof; },
        };
    }

    it('does not report a stop while the tool cgroup is still populated', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({
            ...base(events),
            session: sessionWithClose(events, { proven: false, detail: 'still-populated' }),
            createSupervisor: () => fakeSupervisor(events),
        });
        // supervisor 는 세대를 정지시켰지만 도구 cgroup 은 비지 않았다.
        // 그것을 콜백으로만 흘리고 `stopped: true` 를 돌려주면 남은 프로세스가
        // 정지된 것으로 원장에 남는다.
        expect(await run.stop()).toEqual({ stopped: false, detail: 'tools-still-populated' });
    });

    it('retries until both sides are proven, then caches only that', async () => {
        const events: string[] = [];
        let closes = 0;
        const session = fakeSession(events);
        const run = await startManagedProviderRun({
            ...base(events),
            session: {
                ...session,
                close: async () => {
                    events.push('session-close');
                    return ++closes === 1
                        ? { proven: false, detail: 'still-populated' }
                        : { proven: true, detail: 'cgroup-empty' };
                },
            },
            createSupervisor: () => fakeSupervisor(events),
        });
        expect(await run.stop()).toEqual({ stopped: false, detail: 'tools-still-populated' });
        expect(await run.stop()).toEqual({ stopped: true, observedEmptyAt: 1 });
        // 둘 다 증명된 뒤에만 캐시한다.
        await run.stop();
        expect(events.filter((e) => e === 'session-close')).toHaveLength(2);
    });
});

describe('the launch binds the plan to the execution boundary', () => {
    it('builds the supervisor from the plan, so no caller can hand it a different environment', async () => {
        const events: string[] = [];
        let seen: ProviderSupervisorConfig | null = null;
        const session = fakeSession(events);
        session.providerPlan.env = { PATH: '/usr/bin', SAYCODE_PROVIDER_SDK_OPTIONS: '{}' };
        const run = await startManagedProviderRun({
            ...base(events),
            session,
            readProcEnviron: () => ({ ...session.providerPlan.env, PWD: '/workspace/project' }),
            // 제품이 config 를 만든다. 호출자는 supervisor 를 **완성해서** 주지 못한다.
            createSupervisor: (config) => { seen = config; return fakeSupervisor(events); },
        });
        expect(run.outcome).toMatchObject({ kind: 'exec-attempted' });
        const config = seen as unknown as ProviderSupervisorConfig;
        expect(config.envAllowlist).toEqual(session.providerPlan.env);
        expect(config.workloadPath).toBe('/usr/local/lib/saycode/provider-run1');
        expect(config.resolveGenerationCredentials()).toEqual({ uid: 10601, gid: 10601 });
        expect(config.cgroupRoot).toBe('/sys/fs/cgroup/saycode');
        expect(config.helperPath).toBe('/usr/local/lib/saycode/exec-helper');
    });
});

describe('the environment is verified against the process that actually runs', () => {
    it('checks the environment while the child is parked, before registration and release', async () => {
        const events: string[] = [];
        await expect(startManagedProviderRun({
            ...base(events),
            createSupervisor: () => fakeSupervisor(events),
            readProcEnviron: () => { events.push('read-environ'); return { NOT: 'the-plan' }; },
        })).rejects.toThrow(/launched process/);
        // park 이후, 등록·release 이전이어야 한다. release 뒤면 사용자 코드가 이미 돈다.
        expect(events.indexOf('read-environ')).toBeGreaterThan(events.indexOf('park'));
        expect(events).not.toContain('register:777');
        expect(events).not.toContain('release');
    });

    it('reads the launched process environment and refuses when it is not the plan’s', async () => {
        const events: string[] = [];
        const run = startManagedProviderRun({
            ...base(events),
            // factory 가 config 를 무시하고 다른 env 로 supervisor 를 만든 경우.
            // 주장이 아니라 **실제 프로세스의 environ** 이 그것을 드러낸다.
            createSupervisor: () => fakeSupervisor(events),
            readProcEnviron: () => ({ PATH: '/usr/bin', SNEAKED_IN: 'yes' }),
        });
        await expect(run).rejects.toThrow(/launched process/);
        expect(events).toContain('session-close');
    });

    it('accepts the shell’s own additions but nothing else', async () => {
        const events: string[] = [];
        const run = await startManagedProviderRun({
            ...base(events),
            createSupervisor: () => fakeSupervisor(events),
            // `cd` 한 sh 가 더하는 것들. 계획이 정한 값은 모두 그대로 있다.
            readProcEnviron: () => ({ PATH: '/usr/bin', PWD: '/workspace/project', SHLVL: '1', _: '/bin/sh' }),
        });
        expect(run.outcome).toMatchObject({ kind: 'exec-attempted' });
    });

    it('refuses when a planned variable is missing or altered', async () => {
        for (const environ of [
            { PWD: '/workspace/project' } as Record<string, string>,
            { PATH: '/somewhere/else' } as Record<string, string>,
        ]) {
            const events: string[] = [];
            await expect(startManagedProviderRun({
                ...base(events),
                createSupervisor: () => fakeSupervisor(events),
                readProcEnviron: () => environ,
            })).rejects.toThrow(/launched process/);
        }
    });
});

describe('nothing is left open when the supervisor cannot even be built', () => {
    it('closes the tool boundary if the factory throws', async () => {
        const events: string[] = [];
        await expect(startManagedProviderRun({
            ...base(events),
            createSupervisor: () => { throw new Error('cgroup root missing'); },
        })).rejects.toThrow(/cgroup root missing/);
        // broker 와 grant 가 열린 채 남으면 안 된다.
        expect(events).toContain('session-close');
    });
});

describe('a failed launch still hands back the cleanup', () => {
    /** 정지가 증명되지 않는 supervisor. 실패 경로에서 그 사실이 사라지면 안 된다. */
    function stubbornSupervisor(events: string[], kind: 'exec' | 'throw' = 'exec') {
        return () => ({
            execGeneration: async (call: { onAcquired?: (pid: number) => Promise<void> }) => {
                events.push('park');
                if (kind === 'throw') throw new Error('exec exploded');
                if (call.onAcquired) await call.onAcquired(777);
                events.push('release');
                return { kind: 'exec-attempted' as const, pid: 777 };
            },
            stopGeneration: () => {
                events.push('stop-generation');
                return { stopped: false as const, detail: 'still-populated' };
            },
        });
    }

    const failures: Array<[string, Record<string, unknown>, RegExp]> = [
        ['registration is refused', { register: async () => { throw new Error('registration refused'); } }, /registration refused/],
        ['the environment is not the plan’s', { readProcEnviron: () => ({ NOT: 'the-plan' }) }, /launched process/],
        ['exec itself throws', { createSupervisor: undefined }, /exec exploded/],
    ];

    for (const [name, overrides, message] of failures) {
        it(`keeps the stop outcome and a retry when ${name}`, async () => {
            const events: string[] = [];
            const applied = name === 'exec itself throws'
                ? { createSupervisor: stubbornSupervisor(events, 'throw') }
                : { createSupervisor: stubbornSupervisor(events), ...overrides };
            let caught: unknown = null;
            try {
                await startManagedProviderRun({ ...base(events), ...applied });
            } catch (error) { caught = error; }
            expect(String((caught as Error).message)).toMatch(message);
            const failure = caught as {
                stopOutcome?: { stopped: boolean; detail?: string };
                stop?: () => Promise<{ stopped: boolean }>;
                key?: { runId: string };
            };
            // 정리 결과를 버리지 않는다 — 정지되지 않았다는 사실이 그대로 온다.
            expect(failure.stopOutcome).toMatchObject({ stopped: false });
            // 다시 시도할 수 있어야 한다. 세대를 남긴 채 손잡이가 없으면 아무도 못 치운다.
            expect(typeof failure.stop).toBe('function');
            expect(failure.key).toEqual(KEY);
            // provider 세대가 정지되지 않았다는 것은 lifecycle 이 알아야 한다.
            expect(events).toContain('unproven:provider-generation');
        });
    }

    it('still hands back a retry when the supervisor could not be built', async () => {
        const events: string[] = [];
        let caught: unknown = null;
        try {
            await startManagedProviderRun({
                ...base(events),
                createSupervisor: () => { throw new Error('cgroup root missing'); },
            });
        } catch (error) { caught = error; }
        const failure = caught as { stopOutcome?: { stopped: boolean }; stop?: unknown; key?: unknown };
        expect(String((caught as Error).message)).toMatch(/cgroup root missing/);
        // 세대를 만든 적이 없으므로 남은 것도 없다 — 그 사실이 결과에 있어야 한다.
        expect(failure.stopOutcome).toMatchObject({ stopped: true });
        expect(typeof failure.stop).toBe('function');
        expect(failure.key).toEqual(KEY);
        expect(events).toContain('session-close');
    });

    it('reports the provider generation even when the tools did stop', async () => {
        const events: string[] = [];
        let caught: unknown = null;
        try {
            await startManagedProviderRun({
                ...base(events),
                createSupervisor: stubbornSupervisor(events),
                // 도구 쪽은 깨끗하게 멈췄다. 그래도 provider 세대는 남아 있다.
                session: { ...fakeSession(events), close: async () => ({ proven: true, detail: 'cgroup-empty' }) },
                register: async () => { throw new Error('registration refused'); },
            });
        } catch (error) { caught = error; }
        expect(caught).toBeTruthy();
        expect(events).toContain('unproven:provider-generation');
    });
});

describe('the launch can pass trusted descriptors through', () => {
    it('hands the supervisor exactly the descriptors the caller trusted it with', async () => {
        const events: string[] = [];
        let seen: Array<{ childFd: number; parentFd: number }> | undefined;
        await startManagedProviderRun({
            ...base(events),
            createSupervisor: () => ({
                execGeneration: async (call: {
                    inherit?: Array<{ childFd: number; parentFd: number }>;
                    onAcquired?: (pid: number) => Promise<void>;
                }) => {
                    seen = call.inherit;
                    if (call.onAcquired) await call.onAcquired(777);
                    return { kind: 'exec-attempted' as const, pid: 777 };
                },
                stopGeneration: () => ({ stopped: true as const, observedEmptyAt: 1 }),
            }),
            // B2 부트 봉투 FD. 우리가 만들지 않고 그대로 넘긴다.
            inherit: [{ childFd: 3, parentFd: 11 }],
        });
        expect(seen).toEqual([{ childFd: 3, parentFd: 11 }]);
    });

    it('passes nothing when the caller trusted nothing', async () => {
        const events: string[] = [];
        let seen: unknown = 'unset';
        await startManagedProviderRun({
            ...base(events),
            createSupervisor: () => ({
                execGeneration: async (call: { inherit?: unknown; onAcquired?: (pid: number) => Promise<void> }) => {
                    seen = call.inherit;
                    if (call.onAcquired) await call.onAcquired(777);
                    return { kind: 'exec-attempted' as const, pid: 777 };
                },
                stopGeneration: () => ({ stopped: true as const, observedEmptyAt: 1 }),
            }),
        });
        expect(seen).toBeUndefined();
    });
});
