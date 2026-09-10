import { request as httpRequest } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createCheckpointDrain } from '@/managed/checkpoint/managedCheckpointDrain';
import { MANAGED_WRITE_TOOLS } from './toolWorkload';
import { startManagedToolSession } from './managedToolSession';
import { type ExecutorProcess, type ToolExecutorDeps } from './toolExecutor';

const TOOLS = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];

/** helper 없이 이 배선만 본다. 격리 자체는 Linux fixture 가 판정한다. */
function fakeExecutorDeps(events: string[]): ToolExecutorDeps {
    return {
        helperPath: '/usr/local/lib/saycode/executor-helper',
        workloadPath: '/usr/local/lib/saycode/toolRunner',
        cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
        spawn: (): ExecutorProcess => {
            events.push('spawn');
            return {
                ack: Promise.resolve({ pid: 4242, status: 'ack=setup-complete pid=4242' }),
                release: () => { events.push('release'); },
                abort: () => { events.push('abort'); },
                write: () => {},
                settled: Promise.resolve({ exitCode: 0, stdout: 'FILE-BODY', status: '' }),
            };
        },
        applyNetwork: async () => ({ ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) }),
        killCgroup: async () => ({ proven: true, detail: 'cgroup-empty' }),
        monotonicNow: () => 0,
    };
}

async function callBroker(port: number, token: string | null, name = 'read_file') {
    const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { path: 'a.txt' } },
    });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1', port, method: 'POST', path: '/',
            headers: token ? { authorization: `Bearer ${token}` } : {},
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve(JSON.parse(text || '{}')));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function baseInput(events: string[], unproven: Array<{ tool: string }> = []) {
    return {
        agent: 'claude' as const,
        model: 'claude-sonnet-5',
        providerEnv: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'capability-for-this-run' },
        tools: TOOLS,
        scope: ['read_file'],
        ttlMs: 60_000,
        identity: {
            executor: { uid: 10602, gid: 10600 },
            provider: { uid: 10601, gid: 10601 },
        },
        cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
        helperPath: '/usr/local/lib/saycode/executor-helper',
        workloadPath: '/usr/local/lib/saycode/toolRunner',
        toolTimeoutMs: 5_000,
        onUnprovenTermination: (info: { tool: string }) => { unproven.push(info); },
        executorDeps: fakeExecutorDeps(events),
        monotonicNow: () => 0,
    };
}

describe('managed tool session', () => {
    it('hands the provider a plan that already carries this run’s broker and token', async () => {
        const events: string[] = [];
        const session = await startManagedToolSession(baseInput(events));
        const server = session.providerPlan.sdkOptions?.mcpServers['saycode-broker'];
        expect(server?.url).toBe(`http://127.0.0.1:${session.brokerPort}/`);
        // 자격이 계획 안에 있다. 호출자가 따로 주입할 자리를 남기지 않는다.
        expect(server?.headers.authorization).toMatch(/^Bearer .+/);
        expect(session.providerPlan.sdkOptions?.tools).toEqual([]);
        expect(session.providerPlan.cwd).toBe('/workspace/project');

        // 그 자격으로 실제 호출이 executor 까지 간다.
        const token = server!.headers.authorization.slice('Bearer '.length);
        const answered = await callBroker(session.brokerPort, token);
        expect(answered).toMatchObject({
            result: { content: [{ type: 'text', text: 'FILE-BODY' }] },
        });
        expect(events).toContain('release');
        await session.close();
    });

    it('holds a write for the checkpoint the caller handed it, and lets reads through', async () => {
        const events: string[] = [];
        const drain = createCheckpointDrain();
        const session = await startManagedToolSession({
            ...baseInput(events),
            tools: [...TOOLS, { name: 'write_file', description: 'write', inputSchema: { type: 'object' } }],
            scope: ['read_file', 'write_file'],
            checkpointDrain: { drain, writeTools: MANAGED_WRITE_TOOLS },
        });
        const token = session.providerPlan.sdkOptions!.mcpServers['saycode-broker']!
            .headers.authorization.slice('Bearer '.length);
        const held = await drain.drain(1000);

        // The session forwards the gate; without that the write reaches the
        // executor while the archive is being taken.
        expect(await callBroker(session.brokerPort, token, 'write_file'))
            .toMatchObject({ result: { isError: true, content: [{ text: 'checkpoint-paused' }] } });
        expect(await callBroker(session.brokerPort, token, 'read_file'))
            .toMatchObject({ result: { content: [{ type: 'text', text: 'FILE-BODY' }] } });

        held.release();
        expect(await callBroker(session.brokerPort, token, 'write_file'))
            .toMatchObject({ result: { content: [{ type: 'text', text: 'FILE-BODY' }] } });
        await session.close();
    });

    it('refuses a call that does not carry this run’s token', async () => {
        const events: string[] = [];
        const session = await startManagedToolSession(baseInput(events));
        const answered = await callBroker(session.brokerPort, 'someone-elses-token');
        expect(answered).toMatchObject({ error: { message: 'bad-token' } });
        expect(events).not.toContain('spawn');
        await session.close();
    });

    it('stops answering the moment the run is revoked', async () => {
        const events: string[] = [];
        const session = await startManagedToolSession(baseInput(events));
        const token = session.providerPlan.sdkOptions!.mcpServers['saycode-broker']!
            .headers.authorization.slice('Bearer '.length);
        await session.revoke();
        const answered = await callBroker(session.brokerPort, token);
        expect(answered).toMatchObject({ error: { message: 'grant-revoked' } });
        expect(events).not.toContain('spawn');
        await session.close();
    });

    it('closes the door and drops the credential together', async () => {
        const events: string[] = [];
        const session = await startManagedToolSession(baseInput(events));
        const port = session.brokerPort;
        await session.close();
        // 닫힌 뒤에는 연결 자체가 되지 않는다.
        await expect(callBroker(port, 'anything')).rejects.toThrow();
    });

    it('does not leave a broker listening when the provider plan is refused', async () => {
        const events: string[] = [];
        // codex 는 run-private CODEX_HOME 없이는 계획이 서지 않는다.
        const input = { ...baseInput(events), agent: 'codex' as const };
        await expect(startManagedToolSession(input)).rejects.toThrow(/codexHome/);
        // broker 를 열어 둔 채 나가면 그 포트가 남는다. 열린 문이 없어야 한다.
        expect(events).toEqual([]);
    });

    it('reports an unproven termination to the lifecycle', async () => {
        const events: string[] = [];
        const unproven: Array<{ tool: string }> = [];
        const deps = fakeExecutorDeps(events);
        const session = await startManagedToolSession({
            ...baseInput(events, unproven),
            toolTimeoutMs: 5,
            terminationWaitMs: 50,
            executorDeps: {
                ...deps,
                spawn: () => ({
                    ack: Promise.resolve({ pid: 4242, status: 'ack=setup-complete pid=4242' }),
                    release: () => {},
                    abort: () => {},
                    write: () => {},
                    // 끝나지 않는 도구.
                    settled: new Promise(() => {}),
                }),
                killCgroup: async () => ({ proven: false, detail: 'still-populated' }),
            },
        });
        const token = session.providerPlan.sdkOptions!.mcpServers['saycode-broker']!
            .headers.authorization.slice('Bearer '.length);
        const answered = await callBroker(session.brokerPort, token);
        expect(answered).toMatchObject({
            result: { isError: true, content: [{ type: 'text', text: 'execution-timeout' }] },
        });
        expect(unproven).toHaveLength(1);
        await session.close();
    });
});

describe('revoke and close fence what is already running', () => {
    it('kills the generation, not just the credential', async () => {
        const events: string[] = [];
        const deps = fakeExecutorDeps(events);
        const killed: string[] = [];
        const session = await startManagedToolSession({
            ...baseInput(events),
            executorDeps: {
                ...deps,
                killCgroup: async () => { killed.push('kill'); return { proven: true, detail: 'cgroup-empty' }; },
            },
        });
        // 자격만 없애면 이미 execve 된 도구는 계속 돈다.
        await session.revoke();
        expect(killed).toEqual(['kill']);
        await session.close();
        expect(killed).toEqual(['kill', 'kill']);
    });

    it('tells the lifecycle when the generation could not be proven stopped', async () => {
        const events: string[] = [];
        const unproven: Array<{ tool: string; detail?: string }> = [];
        const deps = fakeExecutorDeps(events);
        const session = await startManagedToolSession({
            ...baseInput(events),
            onUnprovenTermination: (info) => { unproven.push(info); },
            executorDeps: {
                ...deps,
                killCgroup: async () => ({ proven: false, detail: 'still-populated' }),
            },
        });
        await session.close();
        expect(unproven).toEqual([{ tool: 'session-close', detail: 'still-populated' }]);
    });
});
