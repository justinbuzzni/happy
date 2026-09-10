import { describe, expect, it } from 'vitest';

import { launchManagedRun } from './managedRunLaunch';
import { MANAGED_TOOL_WORKLOAD_PATH } from '@/managed/managedImagePackaging';
import { MANAGED_CODING_TOOLS, MANAGED_WRITE_TOOLS } from './toolWorkload';
import type { ExecutorProcess, ToolExecutorDeps } from './toolExecutor';

const identity = {
    runtimeId: 'rt_1',
    isolation: {
        backend: 'fly-machines',
        provider: { uid: 10601, gid: 10601 },
        executor: { uid: 10602, gid: 10600 },
        cgroupRoot: '/sys/fs/cgroup/saycode',
    },
} as never;

function baseInput(overrides: Record<string, unknown> = {}) {
    const started: Record<string, unknown>[] = [];
    const closed: string[] = [];
    return {
        started,
        closed,
        input: {
            identity,
            request: {
                agent: 'claude' as const,
                model: 'claude-sonnet-5',
                providerEnv: { PATH: '/usr/bin' },
                tools: MANAGED_CODING_TOOLS,
                scope: ['read_file', 'write_file'],
                ttlMs: 60_000,
                toolTimeoutMs: 5_000,
            },
            cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
            toolHelperPath: '/usr/local/lib/saycode/executor-helper',
            providerHelperPath: '/usr/local/lib/saycode/exec-helper',
            execPath: '/usr/local/bin/claude',
            key: { runId: 'r', attemptId: 'a', epoch: 0 } as never,
            statusFd: 21,
            releaseFd: 22,
            leaseExpiresMonotonic: 10_000,
            createSupervisor: (() => ({})) as never,
            writeFile: () => undefined,
            readProcEnviron: () => ({}),
            register: async () => undefined,
            lstatPath: (path: string) => (path === '/usr/local/bin/claude'
                ? { uid: 0, mode: 0o555, isDirectory: false, isSymbolicLink: false, isFile: true }
                : { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false, isFile: false }),
            onUnprovenTermination: () => undefined,
            checkpointDrain: { drain: { beginWrite: () => () => undefined }, writeTools: MANAGED_WRITE_TOOLS },
            deps: {
                startToolSession: async (sessionInput: Record<string, unknown>) => {
                    started.push(sessionInput);
                    return {
                        providerPlan: { env: {}, files: [], args: [], cwd: '/workspace/project' },
                        brokerPort: 4321,
                        revoke: async () => ({ proven: true, detail: 'ok' }),
                        close: async () => { closed.push('session'); return { proven: true, detail: 'ok' }; },
                    } as never;
                },
                startProviderRun: async (runInput: Record<string, unknown>) => {
                    started.push(runInput);
                    return { outcome: { code: 0 }, stop: async () => ({ stopped: true }) } as never;
                },
            },
            ...overrides,
        },
    };
}

describe('launchManagedRun', () => {
    it('shouldTakeTheWorkloadAndIsolationFromTheImageAndTheMarkerRatherThanTheCaller', async () => {
        const { input, started } = baseInput();
        await launchManagedRun(input as never);

        const session = started[0] as Record<string, unknown>;
        expect(session.workloadPath).toBe(MANAGED_TOOL_WORKLOAD_PATH);
        expect(session.helperPath).toBe('/usr/local/lib/saycode/executor-helper');
        expect(session.identity).toEqual({
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
        });
        const run = started[1] as Record<string, unknown>;
        expect(run.cgroupRoot).toBe('/sys/fs/cgroup/saycode');
        expect(run.identity).toEqual({ provider: { uid: 10601, gid: 10601 } });
        // The provider writes its generation script; it must not be handed the
        // image's tool program to write over.
        expect(run.workloadPath).not.toBe(MANAGED_TOOL_WORKLOAD_PATH);
        expect(run.workloadPath).toBe('/usr/local/lib/saycode/provider-exec-5a86d794d501f5924841e166b9f6c957');
        expect(run.helperPath).toBe('/usr/local/lib/saycode/exec-helper');
    });

    it('shouldGiveTheToolSessionTheCheckpointGateItWasHanded', async () => {
        const { input, started } = baseInput();
        await launchManagedRun(input as never);
        expect((started[0] as Record<string, unknown>).checkpointDrain)
            .toBe((input as Record<string, unknown>).checkpointDrain);
    });

    it('shouldReturnBothHalvesSoTheCallerCanStopTheRun', async () => {
        const { input } = baseInput();
        const launched = await launchManagedRun(input as never);
        expect(launched.session.brokerPort).toBe(4321);
        expect(launched.run.outcome).toEqual({ code: 0 });
    });

    it('shouldCloseTheToolSessionWhenTheProviderRunCannotStart', async () => {
        const { input, closed } = baseInput();
        (input.deps as Record<string, unknown>).startProviderRun = async () => {
            throw new Error('supervisor refused');
        };

        await expect(launchManagedRun(input as never)).rejects.toThrow();
        // Otherwise the broker keeps listening and its grant stays live for a
        // provider that never came up.
        expect(closed).toEqual(['session']);
    });

    it('shouldReportThatTheToolsCouldNotBeStoppedWhenTheCleanupAlsoFails', async () => {
        const unproven: { tool: string; detail?: string }[] = [];
        const { input } = baseInput();
        (input as Record<string, unknown>).onUnprovenTermination = (info: { tool: string; detail?: string }) => {
            unproven.push(info);
        };
        (input.deps as Record<string, unknown>).startToolSession = async () => ({
            providerPlan: { env: {}, files: [], args: [], cwd: '/workspace/project' },
            brokerPort: 4321,
            revoke: async () => ({ proven: false, detail: 'cgroup not empty' }),
            close: async () => ({ proven: false, detail: 'cgroup not empty' }),
        });
        (input.deps as Record<string, unknown>).startProviderRun = async () => {
            throw new Error('supervisor refused');
        };

        await expect(launchManagedRun(input as never)).rejects.toThrow();
        // A failed launch that also could not prove its tools stopped is not a
        // clean failure, and the generation cleanup upstream has to know.
        expect(unproven).toEqual([{ tool: 'session', detail: 'cgroup not empty' }]);
    });

    async function scriptPathFor(key: { runId: string; attemptId: string; epoch: number }) {
        const { input, started } = baseInput({ key: key as never });
        await launchManagedRun(input as never);
        return (started[1] as Record<string, unknown>).workloadPath as string;
    }

    it('shouldRefuseAnUnsafeGenerationIdBeforeAnythingIsOpenedOrWritten', async () => {
        // The ledger's own key check, called before the session and long
        // before a script is written: a bad key must not leave a broker
        // listening or a file behind.
        const { input, started, closed } = baseInput({
            key: { runId: '../../etc', attemptId: 'a/b', epoch: 0 } as never,
        });
        await expect(launchManagedRun(input as never)).rejects.toThrow('safe id segments');
        expect(started).toEqual([]);
        expect(closed).toEqual([]);
    });

    it('shouldGiveDistinctGenerationsDistinctScripts', async () => {
        // Joining safe ids with a separator still collides: (`r-a`, `b`) and
        // (`r`, `a-b`) produce the same name, and both are valid keys. Two
        // generations then write over each other's provider script — one of
        // them while the other is parked waiting for release.
        const paths = await Promise.all([
            scriptPathFor({ runId: 'r-a', attemptId: 'b', epoch: 0 }),
            scriptPathFor({ runId: 'r', attemptId: 'a-b', epoch: 0 }),
            scriptPathFor({ runId: 'r', attemptId: 'a', epoch: 0 }),
            scriptPathFor({ runId: 'r', attemptId: 'a', epoch: 1 }),
            scriptPathFor({ runId: 'ra', attemptId: 'b', epoch: 0 }),
        ]);
        expect(new Set(paths).size).toBe(paths.length);
    });

    it('shouldGiveTheSameGenerationTheSameScript', async () => {
        // A relaunch of the same epoch is the same generation, not a new one.
        expect(await scriptPathFor({ runId: 'r', attemptId: 'a', epoch: 0 }))
            .toBe(await scriptPathFor({ runId: 'r', attemptId: 'a', epoch: 0 }));
    });

    it('shouldRefuseWhenBothSidesWereHandedTheSameHelper', async () => {
        const { input } = baseInput({ providerHelperPath: '/usr/local/lib/saycode/executor-helper' });
        await expect(launchManagedRun(input as never)).rejects.toThrow('separate tool and provider helpers');
    });

    it('shouldRefuseAnIdentityThatDoesNotSeparateTheTwoUids', async () => {
        const { input } = baseInput({
            identity: {
                runtimeId: 'rt_1',
                isolation: {
                    backend: 'fly-machines',
                    provider: { uid: 10601, gid: 10601 },
                    executor: { uid: 10601, gid: 10601 },
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                },
            },
        });
        await expect(launchManagedRun(input as never)).rejects.toThrow('separate');
    });
});

describe('launchManagedRun through both real halves', () => {
    /** A supervisor that only records; the run itself is the real one. */
    function supervisor(events: string[]) {
        return {
            execGeneration: async (call: { onAcquired?: (pid: number) => Promise<void> }) => {
                events.push('park');
                if (call.onAcquired) await call.onAcquired(777);
                events.push('release');
                return { kind: 'exec-attempted' as const, pid: 777 };
            },
            stopGeneration: () => ({ stopped: true as const, observedEmptyAt: 1 }),
        };
    }

    /** The tool executor, without a real helper — the wiring is what is tested. */
    function executorDeps(events: string[]): ToolExecutorDeps {
        return {
            helperPath: '/usr/local/lib/saycode/executor-helper',
            workloadPath: MANAGED_TOOL_WORKLOAD_PATH,
            cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
            spawn: (): ExecutorProcess => {
                events.push('tool-spawn');
                return {
                    ack: Promise.resolve({ pid: 4242, status: 'ack=setup-complete pid=4242' }),
                    release: () => { events.push('tool-release'); },
                    abort: () => { events.push('tool-abort'); },
                    write: () => {},
                    settled: Promise.resolve({ exitCode: 0, stdout: 'BODY', status: '' }),
                };
            },
            applyNetwork: async () => ({ ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) }),
            killCgroup: async () => ({ proven: true, detail: 'cgroup-empty' }),
            monotonicNow: () => 0,
        };
    }

    async function launchWithBothHalvesReal(overrides: Record<string, unknown> = {}) {
        const events: string[] = [];
        const written: { path: string; mode: number }[] = [];
        const { input } = baseInput();

        // Neither half is stubbed: the session opens a real broker and the
        // provider run writes a real script, so the paths observed are the
        // ones the product actually uses.
        delete (input.deps as Record<string, unknown>).startProviderRun;
        delete (input.deps as Record<string, unknown>).startToolSession;
        (input as Record<string, unknown>).executorDeps = executorDeps(events);
        // The product clock reads /proc/uptime, which this host does not have.
        (input as Record<string, unknown>).monotonicNow = () => 0;
        (input as Record<string, unknown>).writeFile = (file: { path: string; contents: string; mode: number }) => {
            written.push({ path: file.path, mode: file.mode });
        };
        let launchedEnv: Record<string, string> = {};
        (input as Record<string, unknown>).createSupervisor = (config: {
            helperPath: string; workloadPath: string; envAllowlist: Record<string, string>;
        }) => {
            events.push(`supervisor:helper=${config.helperPath}`);
            events.push(`supervisor:workload=${config.workloadPath}`);
            // The product verifies the running process against the plan, so the
            // probe has to report what the supervisor was actually configured
            // with rather than a convenient subset.
            launchedEnv = config.envAllowlist;
            return supervisor(events);
        };
        (input as Record<string, unknown>).readProcEnviron = () => launchedEnv;
        Object.assign(input, overrides);

        const launched = await launchManagedRun(input as never);
        return { launched, events, written };
    }

    it('shouldNotWriteTheProviderScriptOverTheImagesToolProgram', async () => {
        const { launched, events, written } = await launchWithBothHalvesReal();

        expect(written.length).toBeGreaterThan(0);
        expect(written.map((file) => file.path)).not.toContain(MANAGED_TOOL_WORKLOAD_PATH);
        expect(written.map((file) => file.path))
            .toContain('/usr/local/lib/saycode/provider-exec-5a86d794d501f5924841e166b9f6c957');
        expect(events).toContain('release');
        await launched.run.stop();
    });

    it('shouldGiveEachHalfItsOwnHelper', async () => {
        const { launched, events } = await launchWithBothHalvesReal();

        // The provider supervisor gets `execHelper`; the tool executor keeps
        // `executorHelper`. Substituting one makes the provider run inside the
        // tool's network namespace, where the loopback broker it must reach
        // does not exist — and the provider supervisor never sets up the veth
        // and NAT that would put it back.
        expect(events).toContain('supervisor:helper=/usr/local/lib/saycode/exec-helper');
        expect(events).toContain('supervisor:workload=/usr/local/lib/saycode/provider-exec-5a86d794d501f5924841e166b9f6c957');
        expect(events).not.toContain('supervisor:helper=/usr/local/lib/saycode/executor-helper');
        await launched.run.stop();
    });

    it('shouldGiveTheProviderABrokerItCanActuallyReach', async () => {
        const { launched } = await launchWithBothHalvesReal();
        const server = launched.session.providerPlan.sdkOptions?.mcpServers['saycode-broker'];

        // The plan points the provider at a loopback port on this host. That
        // is only reachable because the provider is *not* in the tool's net
        // namespace.
        expect(server?.url).toBe(`http://127.0.0.1:${launched.session.brokerPort}/`);
        await launched.run.stop();
        await launched.session.close();
    });
});
