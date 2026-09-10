import { describe, expect, it } from 'vitest';

import { createCheckpointDrain } from '@/managed/checkpoint/managedCheckpointDrain';
import { MANAGED_WRITE_TOOLS } from './toolWorkload';
import { createManagedToolRuntime } from './managedToolRuntime';
import { handleBrokerMessage, mintBrokerGrant, type BrokerGrant } from './toolBroker';
import { createToolExecutor, planToolExecutorIsolation, type ExecutorProcess } from './toolExecutor';

const PLAN = planToolExecutorIsolation({
    identity: { uid: 10602, gid: 10600 },
    providerIdentity: { uid: 10601, gid: 10601 },
});

const TOOLS = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];

function stubProcess(events: string[]): ExecutorProcess {
    return {
        ack: Promise.resolve({ pid: 999, status: 'ack=setup-complete pid=999' }),
        release: () => { events.push('release'); },
        abort: () => { events.push('abort'); },
        write: () => {},
        settled: Promise.resolve({ exitCode: 0, stdout: 'contents', status: '' }),
    };
}

function runtime(input: { grant: () => BrokerGrant | null; now?: () => number; events: string[] }) {
    return createManagedToolRuntime({
        tools: TOOLS,
        plan: PLAN,
        executor: createToolExecutor({
            helperPath: '/usr/local/lib/saycode/executorHelper',
            workloadPath: '/usr/local/lib/saycode/toolRunner',
            cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
            spawn: () => stubProcess(input.events),
            applyNetwork: async () => ({ ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) }),
            killCgroup: async () => { input.events.push('kill-cgroup'); return { proven: true, detail: 'cgroup-empty' }; },
            monotonicNow: () => 0,
        }),
        grant: input.grant,
        monotonicNow: input.now ?? (() => 0),
        timeoutMs: 5_000,
        onUnprovenTermination: () => {},
    });
}

describe('managed tool runtime', () => {
    it('runs an in-scope call through the executor', async () => {
        const events: string[] = [];
        const grant = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
        const deps = runtime({ grant: () => grant, events });
        const outcome = await handleBrokerMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
            deps,
            `Bearer ${grant.token}`,
        );
        expect(outcome).toEqual({ result: { content: [{ type: 'text', text: 'contents' }] } });
        expect(events).toContain('release');
    });

    it('does not execute a call whose grant expires while the child is being prepared', async () => {
        const events: string[] = [];
        const grant = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
        // 입구 인가(1)와 실행 직전 첫 검증(2)까지는 유효하고, helper 가 park 된
        // 뒤의 검증(3)에서 만료된다.
        let reads = 0;
        const deps = runtime({
            grant: () => grant,
            now: () => (++reads >= 3 ? 2000 : 0),
            events,
        });
        const outcome = await handleBrokerMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
            deps,
            `Bearer ${grant.token}`,
        );
        expect(outcome).toEqual({ result: { isError: true, content: [{ type: 'text', text: 'tool-unavailable' }] } });
        expect(events).not.toContain('release');
        expect(events).toContain('kill-cgroup');
    });

    it('does not let a re-minted grant rescue a call admitted under a revoked one', async () => {
        const events: string[] = [];
        const first = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
        let current = first;
        const deps = runtime({
            grant: () => {
                const value = current;
                // 준비 사이에 폐기되고 새로 발급된다.
                current = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
                return value;
            },
            events,
        });
        const outcome = await handleBrokerMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
            deps,
            `Bearer ${first.token}`,
        );
        expect(outcome).toEqual({ result: { isError: true, content: [{ type: 'text', text: 'tool-unavailable' }] } });
        expect(events).not.toContain('release');
    });
});

describe('unproven termination reaches the lifecycle', () => {
    it('reports a call whose processes could not be proven stopped', async () => {
        const events: string[] = [];
        const grant = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
        const unproven: Array<{ tool: string; detail?: string }> = [];
        const deps = createManagedToolRuntime({
            tools: TOOLS,
            plan: PLAN,
            executor: createToolExecutor({
                helperPath: '/usr/local/lib/saycode/executor-helper',
                workloadPath: '/usr/local/lib/saycode/toolRunner',
                cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
                spawn: () => ({
                    ...stubProcess(events),
                    settled: new Promise(() => {}),
                }),
                applyNetwork: async () => ({ ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) }),
                killCgroup: async () => ({ proven: false, detail: 'still-populated' }),
                monotonicNow: () => 0,
            }),
            grant: () => grant,
            monotonicNow: () => 0,
            timeoutMs: 5,
            terminationWaitMs: 50,
            // 증명되지 않은 정지는 조용히 사라지면 안 된다 — 남은 프로세스를
            // 추적할 책임이 상위에 있다.
            onUnprovenTermination: (info) => { unproven.push(info); },
        });
        const outcome = await handleBrokerMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
            deps,
            `Bearer ${grant.token}`,
        );
        expect(outcome).toEqual({ result: { isError: true, content: [{ type: 'text', text: 'execution-timeout' }] } });
        expect(unproven).toEqual([{ tool: 'read_file', detail: 'termination-unobserved' }]);
    });
});

describe('createManagedToolRuntime with a checkpoint drain', () => {
    function runtime(drain: { beginWrite: () => () => void }, executed: string[]) {
        return createManagedToolRuntime({
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
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });
    }

    it('shouldRefuseAWriteWhileTheDrainIsHeldAndSayItIsAPause', async () => {
        const drain = createCheckpointDrain();
        const executed: string[] = [];
        const deps = runtime(drain, executed);
        const held = await drain.drain(1000);

        expect(await deps.execute({ name: 'write_file', arguments: {} }))
            .toEqual({ ok: false, code: 'checkpoint-paused' });
        expect(await deps.execute({ name: 'run_command', arguments: {} }))
            .toEqual({ ok: false, code: 'checkpoint-paused' });
        // The call never reached the executor, so nothing was half-written.
        expect(executed).toEqual([]);

        held.release();
        expect(await deps.execute({ name: 'write_file', arguments: {} })).toEqual({ ok: true, content: 'done' });
        expect(executed).toEqual(['write_file']);
    });

    it('shouldNotHoldReadsWhileACheckpointIsBeingTaken', async () => {
        const drain = createCheckpointDrain();
        const executed: string[] = [];
        const deps = runtime(drain, executed);
        await drain.drain(1000);

        expect(await deps.execute({ name: 'read_file', arguments: {} })).toEqual({ ok: true, content: 'done' });
        expect(await deps.execute({ name: 'list_files', arguments: {} })).toEqual({ ok: true, content: 'done' });
        expect(executed).toEqual(['read_file', 'list_files']);
    });

    it('shouldMakeADrainWaitForAWriteThatIsAlreadyRunning', async () => {
        const drain = createCheckpointDrain();
        let finish: (() => void) | null = null;
        const deps = createManagedToolRuntime({
            tools: [],
            plan: {} as never,
            executor: { run: async () => {
                await new Promise<void>((resolve) => { finish = resolve; });
                return { ok: true, content: 'done' };
            } } as never,
            grant: () => ({ token: 't', scope: new Set(['write_file']), expiresMonotonic: 10 }) as never,
            monotonicNow: () => 0,
            timeoutMs: 1000,
            onUnprovenTermination: () => undefined,
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });

        const call = deps.execute({ name: 'write_file', arguments: {} });
        await new Promise((resolve) => setTimeout(resolve, 5));
        let drained = false;
        const pending = drain.drain(1000).then((held) => { drained = true; return held; });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(drained).toBe(false);

        finish!();
        await call;
        await pending;
        expect(drained).toBe(true);
    });

    it('shouldReleaseTheWriteEvenWhenTheToolFails', async () => {
        const drain = createCheckpointDrain();
        const deps = createManagedToolRuntime({
            tools: [],
            plan: {} as never,
            executor: { run: async () => { throw new Error('boom'); } } as never,
            grant: () => ({ token: 't', scope: new Set(['write_file']), expiresMonotonic: 10 }) as never,
            monotonicNow: () => 0,
            timeoutMs: 1000,
            onUnprovenTermination: () => undefined,
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });

        await expect(deps.execute({ name: 'write_file', arguments: {} })).rejects.toThrow();
        // A write that blew up must not hold the gate shut forever.
        expect(drain.inFlight()).toBe(0);
        await expect(drain.drain(1000)).resolves.toBeDefined();
    });
});

describe('an unproven write holds the checkpoint gate', () => {
    it('shouldNotReleaseTheGateForAWriteWhoseProcessesCouldNotBeProvenStopped', async () => {
        const drain = createCheckpointDrain();
        const unproven: { tool: string }[] = [];
        const deps = createManagedToolRuntime({
            tools: [],
            plan: {} as never,
            executor: { run: async () => ({
                ok: false,
                code: 'execution-timeout',
                cancelProven: false,
                cancelDetail: 'processes may still be running',
            }) } as never,
            grant: () => ({ token: 't', scope: new Set(['run_command']), expiresMonotonic: 10 }) as never,
            monotonicNow: () => 0,
            timeoutMs: 1000,
            onUnprovenTermination: (info: { tool: string }) => { unproven.push(info); },
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });

        expect(await deps.execute({ name: 'run_command', arguments: {} }))
            .toEqual({ ok: false, code: 'execution-timeout' });
        expect(unproven).toHaveLength(1);

        // Something may still be writing to the workspace, so a checkpoint
        // must not be able to say the volume is quiet.
        expect(drain.inFlight()).toBe(1);
        // The drain has nothing to wait for that will ever finish, so it fails
        // on its budget instead of reporting a quiet volume.
        await expect(drain.drain(50)).rejects.toMatchObject({ code: 'drain-timeout' });
    });

    it('shouldReleaseTheGateWhenTerminationWasProven', async () => {
        const drain = createCheckpointDrain();
        const deps = createManagedToolRuntime({
            tools: [],
            plan: {} as never,
            executor: { run: async () => ({ ok: false, code: 'execution-timeout', cancelProven: true }) } as never,
            grant: () => ({ token: 't', scope: new Set(['run_command']), expiresMonotonic: 10 }) as never,
            monotonicNow: () => 0,
            timeoutMs: 1000,
            onUnprovenTermination: () => undefined,
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });

        await deps.execute({ name: 'run_command', arguments: {} });
        expect(drain.inFlight()).toBe(0);
        await expect(drain.drain(1000)).resolves.toBeDefined();
    });
});
