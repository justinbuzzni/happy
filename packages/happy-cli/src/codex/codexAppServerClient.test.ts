import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
    mockPrepareCodexMultiAuthProxy,
    mockProxyCleanup,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
    mockPrepareCodexMultiAuthProxy: vi.fn(),
    mockProxyCleanup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./codexMultiAuthProxy', () => ({
    prepareCodexMultiAuthProxy: mockPrepareCodexMultiAuthProxy,
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockPrepareCodexMultiAuthProxy.mockResolvedValue(null);
        mockProxyCleanup.mockResolvedValue(undefined);
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockExecSync.mockReturnValue('codex-cli 0.130.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('emits response-scoped usage with the native Codex response id', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (_msg, stdout) => {
                appServerStdout = stdout;
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));

        await client.connect();
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'rawResponse/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                responseId: 'response-1',
                usage: {
                    totalTokens: 150,
                    inputTokens: 120,
                    cachedInputTokens: 70,
                    cacheWriteInputTokens: 10,
                    outputTokens: 30,
                    reasoningOutputTokens: 5,
                },
            },
        });

        await waitFor(() => events.length === 1);
        expect(events[0]).toEqual({
            type: 'codex_usage',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            response_id: 'response-1',
            usage: {
                totalTokens: 150,
                inputTokens: 120,
                cachedInputTokens: 70,
                cacheWriteInputTokens: 10,
                outputTokens: 30,
                reasoningOutputTokens: 5,
            },
        });

        await client.disconnect();
    });

    it('adapts MCP startup notifications and paginated tool/auth inventory', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
                requests.push(msg);
                const secondPage = msg.params?.cursor === 'page-2';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: secondPage
                        ? {
                            data: [{ name: 'notion', authStatus: 'notLoggedIn', tools: {} }],
                            nextCursor: null,
                        }
                        : {
                            data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                            nextCursor: 'page-2',
                        },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: {
                threadId: 'thread-1',
                name: 'notion',
                status: 'failed',
                error: 'OAuth login required',
                failureReason: 'reauthenticationRequired',
            },
        });
        await waitFor(() => client.getMcpStartupStatuses().length === 1);

        expect(client.getMcpStartupStatuses()).toEqual([{
            threadId: 'thread-1',
            name: 'notion',
            status: 'failed',
            error: 'OAuth login required',
            failureReason: 'reauthenticationRequired',
        }]);
        await expect(client.listMcpServerStatus({ threadId: 'thread-1' })).resolves.toEqual({
            data: [
                { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
            ],
            nextCursor: null,
        });
        expect(requests.map(({ params }) => params)).toEqual([
            { threadId: 'thread-1', cursor: null, limit: 100, detail: 'toolsAndAuthOnly' },
            { threadId: 'thread-1', cursor: 'page-2', limit: 100, detail: 'toolsAndAuthOnly' },
        ]);

        client.clearThreadState();
        expect(client.getMcpStartupStatuses()).toEqual([]);

        await client.disconnect();
    });

    it('completes MCP runtime recovery before starting the next user turn', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                requests.push(msg);
                if (msg.id == null) return;
                if (msg.method === 'thread/start') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-1', path: '/tmp/thread-1' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'mcpServerStatus/list') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                            nextCursor: null,
                        },
                    }), 0);
                }
                if (msg.method === 'thread/resume') {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            method: 'mcpServer/startupStatus/updated',
                            params: { threadId: 'thread-1', name: 'argos', status: 'ready' },
                        });
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-1', path: '/tmp/thread-1' }, model: 'gpt-test' },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/start') {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-1' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-1',
                                turn: { id: 'turn-1', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        }));
        const [{ CodexAppServerClient }, { CodexMcpRuntimeRecovery }] = await Promise.all([
            import('./codexAppServerClient'),
            import('./codexMcpRuntimeRecovery'),
        ]);
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            cwd: '/tmp/project',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            developerInstructions: 'Discover Argos tools before fallback.',
        });
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-1', name: 'argos', status: 'failed' },
        });
        await waitFor(() => client.getMcpStartupStatuses().some(({ status }) => status === 'failed'));

        const recovery = new CodexMcpRuntimeRecovery(client, { maxAttempts: 1, backoffMs: 0 });
        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Discover Argos tools before fallback.',
        })).resolves.toEqual({ status: 'recovered', affectedServers: ['argos'] });
        await expect(client.sendTurnAndWait('Use Argos now.')).resolves.toEqual({ aborted: false });

        const resumeIndex = requests.findIndex(({ method }) => method === 'thread/resume');
        const turnIndex = requests.findIndex(({ method }) => method === 'turn/start');
        expect(resumeIndex).toBeGreaterThan(-1);
        expect(resumeIndex).toBeLessThan(turnIndex);
        expect(requests[resumeIndex]?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            developerInstructions: 'Discover Argos tools before fallback.',
            config: {
                mcp_servers: { argos: { url: 'https://argos.test/mcp' } },
            },
        }));

        await client.disconnect();
    });

    it('persists developer instructions across start, topology-update resume, and fork', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/compact/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                    return;
                }
                if (!['thread/start', 'thread/resume', 'thread/fork'].includes(msg.method ?? '') || msg.id == null) {
                    return;
                }
                const threadId = msg.method === 'thread/fork' ? 'thread-forked' : 'thread-1';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: {
                        thread: { id: threadId, path: `/tmp/${threadId}` },
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        cwd: '/tmp/project',
                        approvalPolicy: 'on-request',
                        sandbox: { type: 'workspaceWrite' },
                        reasoningEffort: null,
                    },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await client.startThread({
            cwd: '/tmp/project',
            developerInstructions: 'Discover Gmail tools before browser fallback.',
        });
        await client.resumeThread({
            threadId: 'thread-1',
            developerInstructions: 'Discover Gmail and Argos tools before browser fallback.',
        });
        await client.compactThread({ threadId: 'thread-1' });
        await client.resumeThread({ threadId: 'thread-1' });
        await client.forkThread({ threadId: 'thread-1' });

        expect(requests.find(({ method }) => method === 'thread/start')?.params.developerInstructions)
            .toBe('Discover Gmail tools before browser fallback.');
        expect(requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => (
            params.developerInstructions
        ))).toEqual([
            'Discover Gmail and Argos tools before browser fallback.',
            'Discover Gmail and Argos tools before browser fallback.',
        ]);
        expect(requests.find(({ method }) => method === 'thread/compact/start')?.params).toEqual({
            threadId: 'thread-1',
        });
        expect(requests.find(({ method }) => method === 'thread/fork')?.params.developerInstructions)
            .toBe('Discover Gmail and Argos tools before browser fallback.');

        await client.disconnect();
    });

    it('persists additional writable roots across thread start, resume, and every workspace-write turn', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (['thread/start', 'thread/resume'].includes(msg.method ?? '') && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-roots', path: '/tmp/thread-roots' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-roots' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: { threadId: 'thread-roots', turn: { id: 'turn-roots', status: 'completed' } },
                        });
                    }, 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const writableRoots = ['/repo/frontend', '/repo/backend'];
        await client.connect();

        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write', writableRoots });
        await client.resumeThread({ threadId: 'thread-roots' });
        await client.sendTurnAndWait('edit both projects', { sandbox: 'workspace-write' });

        for (const request of requests.filter(({ method }) => method === 'thread/start' || method === 'thread/resume')) {
            expect(request.params.config).toMatchObject({
                sandbox_workspace_write: { writable_roots: writableRoots },
            });
        }
        expect(requests.find(({ method }) => method === 'turn/start')?.params.sandboxPolicy).toEqual({
            type: 'workspaceWrite',
            writableRoots,
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });

        await client.disconnect();
    });

    it('does not dispatch a protected turn when the checkpoint gate fails', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-protected', path: '/tmp/thread-protected' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-should-not-start' } },
                    }), 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const beforeTurn = vi.fn(async () => {
            throw new Error('checkpoint unavailable');
        });
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        await expect(client.sendTurn('edit the project', { beforeTurn }))
            .rejects.toThrow('checkpoint unavailable');

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);
        await client.disconnect();
    });

    it('does not create a checkpoint when no provider thread can accept the turn', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const beforeTurn = vi.fn(async () => {});

        await expect(client.sendTurnAndWait('edit the project', { beforeTurn }))
            .rejects.toThrow('No active thread');

        expect(beforeTurn).not.toHaveBeenCalled();
    });

    it('runs the checkpoint gate exactly once before dispatching a protected turn', async () => {
        const order: string[] = [];
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-gated', path: '/tmp/thread-gated' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    order.push('provider');
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-gated' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-gated',
                                turn: { id: 'turn-gated', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        }));
        const beforeTurn = vi.fn(async () => {
            order.push('gate');
            return {
                operationId: 'turn-1',
                checkpointId: 'a'.repeat(40),
                providerPath: '/private/checkpoints/codex-turn-1',
            };
        });
        const completeTurn = vi.fn(async (quiesceWriters: () => Promise<void>) => {
            await quiesceWriters();
            order.push('apply');
            return { status: 'completed' as const, entries: [] };
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, beforeTurn, completeTurn);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        await expect(client.sendTurnAndWait('edit the project'))
            .resolves.toEqual({ aborted: false });

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(completeTurn).toHaveBeenCalledOnce();
        expect(order).toEqual(['gate', 'provider', 'apply']);
        expect(requests.find(({ method }) => method === 'turn/start')?.params.cwd)
            .toBe('/private/checkpoints/codex-turn-1');
        await client.disconnect();
    });

    it('does not dispatch an excluded-path retry while protection confirmation is pending', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-excluded', path: '/tmp/thread-excluded' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-should-not-start' } },
                    }), 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let rejectConfirmation!: (reason: Error) => void;
        const confirmation = new Promise<void>((_, reject) => {
            rejectConfirmation = reject;
        });
        const beforeTurn = vi.fn(() => confirmation);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        const running = client.sendTurnAndWait(
            'retry after the excluded .env write was denied',
            { beforeTurn },
        );
        await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce());

        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);

        rejectConfirmation(new Error('excluded path confirmation cancelled'));
        await expect(running).rejects.toThrow('excluded path confirmation cancelled');
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);
        await client.disconnect();
    });

    it('clears persisted developer instructions when resume explicitly sends null', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (!['thread/start', 'thread/resume', 'thread/fork'].includes(msg.method ?? '') || msg.id == null) {
                    return;
                }
                const threadId = msg.method === 'thread/fork' ? 'thread-forked' : 'thread-1';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: {
                        thread: { id: threadId, path: `/tmp/${threadId}` },
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        cwd: '/tmp/project',
                        approvalPolicy: 'on-request',
                        sandbox: { type: 'workspaceWrite' },
                        reasoningEffort: null,
                    },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await client.startThread({
            cwd: '/tmp/project',
            developerInstructions: 'SAYCODE INSTRUCTIONS',
        });
        await client.resumeThread({
            threadId: 'thread-1',
            developerInstructions: null,
        });
        await client.resumeThread({ threadId: 'thread-1' });
        await client.forkThread({ threadId: 'thread-1' });

        expect(requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => (
            params.developerInstructions
        ))).toEqual([null, null]);
        expect(requests.find(({ method }) => method === 'thread/fork')?.params.developerInstructions)
            .toBeNull();

        await client.disconnect();
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('runs its protected runtime gate before every turn dispatch', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-runtime', path: '/tmp/thread-runtime' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-runtime' } },
                    }), 0);
                }
            },
        }));
        const beforeTurn = vi.fn(async () => {});
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, beforeTurn);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project' });

        await client.sendTurn('edit the project');

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(true);
        await client.disconnect();
    });

    // 2026-08-31 회귀 — 8/28 수정이 스폰 시점에 무조건 죽이도록 만들어, 폴백해도
    // 네트워크가 멀쩡한 세션까지 전부 죽였다. connect() 시점에는 permissionMode 를
    // 아직 모른다 (턴마다 결정된다). 그러니 여기서는 초기화 실패 사실만 기록하고,
    // 네트워크를 실제로 잃는지는 모드를 아는 턴 시점에서 판정한다.
    it('records sandbox init failure and still connects — the turn decides if it is fatal', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(client.sandboxEnabled).toBe(false);
        expect(client.sandboxInitFailed).toBe(true);
        expect(mockSpawn).toHaveBeenCalled();

        await client.disconnect();
    });

    it('leaves sandboxInitFailed false when the sandbox initialised cleanly', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(client.sandboxEnabled).toBe(true);
        expect(client.sandboxInitFailed).toBe(false);

        await client.disconnect();
    });

    it('still falls back to non-sandbox transport when the sandbox deliberately blocks network', async () => {
        // 네트워크를 원래도 안 쓰려던 자리는 초기화가 실패해도 계속 진행해도 된다 —
        // Codex 네이티브 readOnly 정책도 어차피 네트워크가 없으므로 의도와 일치한다.
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient({ ...sandboxConfig, networkMode: 'blocked' });

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('fails closed when a protected runtime cannot initialize its sandbox', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(
            { ...sandboxConfig, networkMode: 'blocked' },
            vi.fn(async () => {}),
        );

        await expect(client.connect()).rejects.toThrow(/checkpoint protection sandbox initialization failed/);

        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('routes managed Codex sessions through multi-auth and closes the proxy on disconnect', async () => {
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: ['-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://', '-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
            expect.objectContaining({
                env: expect.objectContaining({ OPENAI_API_KEY: 'local-client-key' }),
            }),
        );
        await client.disconnect();
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('closes the multi-auth proxy when the Codex process exits unexpectedly', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: [],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        proc.emit('exit', 1, null);

        await waitFor(() => mockProxyCleanup.mock.calls.length === 1);
        await client.disconnect();
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('closes the multi-auth proxy when spawning Codex throws synchronously', async () => {
        mockSpawn.mockImplementation(() => {
            throw new Error('spawn failed');
        });
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: [],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await expect(client.connect()).rejects.toThrow('spawn failed');
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('keeps a queued turn behind thread resume during a forced restart', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        let resumeCompleted = false;

        const proc1 = createMockProcess({
            pid: 2011,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-restart-order', path: '/tmp/thread-restart-order' } },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-before-restart' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-before-restart', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2012,
            initializeDelayMs: 30,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        resumeCompleted = true;
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-restart-order', path: '/tmp/thread-restart-order' } },
                        });
                    }, 30);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-after-resume' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-after-resume', status: 'inProgress' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-after-resume', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const interruptedTurn = client.sendTurnAndWait('hang before restart', { turnTimeoutMs: 60_000 });
        const queuedTurn = interruptedTurn.then(() => client.sendTurnAndWait('queued during restart'));
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const restart = client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });
        await waitFor(() => secondProcessRequests.some((msg) => msg.method === 'turn/start'));

        expect(resumeCompleted).toBe(true);
        expect(secondProcessRequests.findIndex((msg) => msg.method === 'thread/resume')).toBeLessThan(
            secondProcessRequests.findIndex((msg) => msg.method === 'turn/start'),
        );
        await expect(restart).resolves.toEqual(expect.objectContaining({
            forcedRestart: true,
            resumedThread: true,
        }));
        await expect(interruptedTurn).resolves.toEqual({ aborted: true });
        await expect(queuedTurn).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('does not dispatch a queued turn when forced restart cannot resume the thread', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 2013,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-resume-failure', path: '/tmp/thread-resume-failure' } },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-resume-failure' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-resume-failure',
                                turn: { id: 'turn-resume-failure', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        const proc2 = createMockProcess({
            pid: 2014,
            initializeDelayMs: 20,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        error: { code: -32600, message: 'thread not found' },
                    }), 20);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const interruptedTurn = client.sendTurnAndWait('hang before failed resume', { turnTimeoutMs: 60_000 });
        const queuedTurn = interruptedTurn.then(() => client.sendTurnAndWait('must not dispatch'));
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        await expect(client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        })).resolves.toEqual(expect.objectContaining({
            forcedRestart: true,
            resumedThread: false,
        }));
        await expect(interruptedTurn).resolves.toEqual({ aborted: true });
        await expect(queuedTurn).rejects.toThrow('No active thread');
        expect(secondProcessRequests.some((msg) => msg.method === 'turn/start')).toBe(false);

        await client.disconnect();
    });

    it('keeps an active turn alive when provider progress resets the inactivity timeout', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2003,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-timeout', path: '/tmp/thread-timeout' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-timeout',
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('long active turn', { turnTimeoutMs: 200 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-timeout',
                    turnId: 'turn-timeout',
                    item: { id: 'item-progress', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-timeout',
                    turn: { id: 'turn-timeout', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores stale-turn activity and interrupts the inactive current provider turn', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2004,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-inactive', path: '/tmp/thread-inactive' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(15);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-inactive',
                    turnId: 'turn-from-previous-request',
                    item: { id: 'stale-item', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(6);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            expect(events.filter((event) => event.type === 'turn_aborted')).toEqual([
                expect.objectContaining({ turn_id: 'turn-inactive', status: 'cancelled' }),
            ]);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog-forced abort with the inactivity reason and the not-ready MCP servers', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2014,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-hung', path: '/tmp/thread-hung' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        // One server never finished starting; another is fine. Only the hung one
        // should be surfaced to the user.
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'aplus-common', status: 'ready' },
        });
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            // Provider goes fully silent — the watchdog must fire.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                turn_id: 'turn-hung',
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags the completion with the inactivity reason even when codex settles the interrupted turn as completed', async () => {
        // Replays the real incident: codex answered the watchdog's turn/interrupt
        // with turn/completed status 'completed' (not 'cancelled'), so the abort
        // surfaced as task_complete and the user saw nothing.
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2015,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-done', path: '/tmp/thread-done' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-done', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: false });
            const terminalEvents = events.filter((event) =>
                event.type === 'task_complete' || event.type === 'turn_aborted');
            expect(terminalEvents).toHaveLength(1);
            expect(terminalEvents[0]).toMatchObject({
                type: 'task_complete',
                turn_id: 'turn-done',
                reason: 'inactivity_timeout',
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('does not tag a user-initiated abort as inactivity even when the watchdog deadline passes mid-abort', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2016,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-cancel', path: '/tmp/thread-cancel' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    // The provider takes 30ms to honor the user's interrupt — long
                    // enough for the 20ms inactivity deadline to pass mid-abort.
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 30);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10);
            // User cancels before the watchdog deadline.
            const abortPromise = client.abortTurnWithFallback({ gracePeriodMs: 100 });
            await vi.advanceTimersByTimeAsync(40);

            await expect(abortPromise).resolves.toMatchObject({ aborted: true });
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).not.toHaveProperty('reason', 'inactivity_timeout');
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog abort delivered via the legacy codex/event protocol', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2017,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-legacy', path: '/tmp/thread-legacy' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-legacy', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'turn_aborted', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-legacy', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('keeps an active turn alive while an approval request awaits the user', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2005,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-approval', path: '/tmp/thread-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-approval',
                                turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        // Codex asks the user to approve a command and then goes
                        // silent until we answer — no turn notifications arrive.
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-approval',
                                turnId: 'turn-approval',
                                itemId: 'exec-approval-1',
                                command: 'rm -rf build',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        // Held by the approval handler so the test controls when the user answers.
        let approveUser: () => void = () => { throw new Error('approval not requested yet'); };
        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                await new Promise<void>((resolveDecision) => {
                    approveUser = resolveDecision;
                    resolveRequested();
                });
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('needs approval', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;

            // The provider is blocked on us, not hung — the watchdog must not fire
            // no matter how long the user takes to answer.
            await vi.advanceTimersByTimeAsync(500);
            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

            approveUser();
            await vi.advanceTimersByTimeAsync(0);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-approval',
                    turn: { id: 'turn-approval', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('resumes the inactivity watchdog after an approval is answered', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2006,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-after-approval', path: '/tmp/thread-after-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 78,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-after-approval',
                                turnId: 'turn-after-approval',
                                itemId: 'exec-approval-2',
                                command: 'sleep 600',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                resolveRequested();
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('approve then hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;
            await vi.advanceTimersByTimeAsync(0);

            // Approval answered and the provider still goes silent — the watchdog
            // must re-arm and interrupt the genuinely stuck turn.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores an approval completion from a disconnected app-server epoch', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        let secondStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;

        const proc1 = createMockProcess({
            pid: 2007,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-old', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-old', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-old',
                                itemId: 'old-approval',
                                command: 'old command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2008,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                secondStdout = stdout;
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-new', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-new', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 88,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-new',
                                itemId: 'new-approval',
                                command: 'new command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseOldApproval!: () => void;
        let releaseNewApproval!: () => void;
        let markOldApprovalRequested!: () => void;
        let markNewApprovalRequested!: () => void;
        const oldApprovalDecision = new Promise<void>((resolve) => { releaseOldApproval = resolve; });
        const newApprovalDecision = new Promise<void>((resolve) => { releaseNewApproval = resolve; });
        const oldApprovalRequested = new Promise<void>((resolve) => { markOldApprovalRequested = resolve; });
        const newApprovalRequested = new Promise<void>((resolve) => { markNewApprovalRequested = resolve; });
        client.setApprovalHandler(async ({ callId }) => {
            if (callId === 'old-approval') {
                markOldApprovalRequested();
                await oldApprovalDecision;
                return 'approved';
            }
            markNewApprovalRequested();
            await newApprovalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const oldPending = client.sendTurnAndWait('old turn', { turnTimeoutMs: 60_000 });
        await oldApprovalRequested;
        await expect(client.reconnectAndResumeThread()).resolves.toBe(true);
        await expect(oldPending).resolves.toEqual({ aborted: true });

        vi.useFakeTimers();
        try {
            const newPending = client.sendTurnAndWait('new turn', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await newApprovalRequested;

            releaseOldApproval();
            await vi.advanceTimersByTimeAsync(0);

            expect(secondProcessRequests.some((request) => request.id === 77 && request.result !== undefined)).toBe(false);
            await vi.advanceTimersByTimeAsync(25);
            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(false);

            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            if (!secondStdout) throw new Error('second app-server stdout unavailable');
            pushJsonLine(secondStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-epoch',
                    turn: { id: 'turn-new', items: [], status: 'completed', error: null },
                },
            });
            await expect(newPending).resolves.toEqual({ aborted: false });
        } finally {
            releaseOldApproval();
            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('re-arms the watchdog for a turn started after a crash left an approval outstanding', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 2009,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-crash', path: '/tmp/thread-crash' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-crash', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-crash',
                                turnId: 'turn-crash',
                                itemId: 'crash-approval',
                                command: 'never answered',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2010,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-after-crash', items: [], status: 'inProgress', error: null } },
                    }), 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-crash',
                                turn: { id: 'turn-after-crash', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseApproval!: () => void;
        let markApprovalRequested!: () => void;
        const approvalDecision = new Promise<void>((resolve) => { releaseApproval = resolve; });
        const approvalRequested = new Promise<void>((resolve) => { markApprovalRequested = resolve; });
        client.setApprovalHandler(async () => {
            markApprovalRequested();
            await approvalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const crashedTurn = client.sendTurnAndWait('crashes mid-approval', { turnTimeoutMs: 60_000 });
        await approvalRequested;

        // The app-server dies while the approval is still outstanding, so
        // disconnectInternal never runs to clear the outstanding-request count.
        proc1.emit('exit', 1, null);
        await expect(crashedTurn).resolves.toEqual({ aborted: true });
        await client.connect();

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('after crash', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            releaseApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const imported = await client.forkThreadFromPath({
            path: '/tmp/imported-rollout.jsonl',
            cwd: '/tmp/moved-project',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(imported.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => (
            msg.method === 'thread/fork'
            && (msg.params as { path?: string } | undefined)?.path === '/tmp/imported-rollout.jsonl'
        ))?.params).toEqual(expect.objectContaining({
            threadId: '',
            path: '/tmp/imported-rollout.jsonl',
            cwd: '/tmp/moved-project',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });

    it('steers text into the currently active Codex turn', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2803,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steer', path: '/tmp/thread-steer' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            turn: { id: 'turn-steer', items: [], status: 'inProgress', error: null },
                        },
                    }), 0);
                }

                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurn('initial request');
        await client.steerTurn('apply this now');

        expect(requests.find((msg) => msg.method === 'turn/steer')?.params).toEqual({
            threadId: 'thread-steer',
            input: [{ type: 'text', text: 'apply this now' }],
            expectedTurnId: 'turn-steer',
        });

        await client.disconnect();
    });

    it('waits for authoritative completion after steering adds more work to the turn', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2804,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steered-completion', path: '/tmp/thread-steered-completion' },
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-steered-completion', status: 'inProgress' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-steered-completion',
                                turn: { id: 'turn-steered-completion', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const completion = client.sendTurnAndWait('initial request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started'));
        await client.steerTurn('additional request');
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-steered-completion',
                turnId: 'turn-steered-completion',
                item: {
                    type: 'agentMessage',
                    id: 'msg-intermediate-final',
                    text: 'first answer before steered work finishes',
                    phase: 'final_answer',
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-steered-completion',
                turn: { id: 'turn-steered-completion', status: 'completed', error: null },
            },
        });

        await expect(completion).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('rejects steering when Codex has no active turn', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await expect(client.steerTurn('too late')).rejects.toThrow('No active Codex turn');
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    // desktop-stuck-responding-state: a mid-turn agentMessage can legitimately
    // carry phase 'final_answer' (Codex asking a clarifying question), which
    // schedules our idle-fallback task_complete. When Codex then resumes the
    // SAME provider turn — no fresh turn/started, since it never asked for a
    // new turn — the authoritative turn/completed that eventually arrives for
    // that turnId must not be dropped as a duplicate of the premature one, or
    // the session never gets a real terminal marker again.
    it('does not drop the authoritative completion when work resumes after a premature final_answer fallback', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3010,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-resume', path: '/tmp/thread-resume' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-resume-1', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-resume', turn: { id: 'turn-resume-1' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-resume',
                                turnId: 'turn-resume-1',
                                item: { type: 'agentMessage', id: 'msg-mid-turn', text: 'clarifying question', phase: 'final_answer' },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        // The premature fallback resolves sendTurnAndWait ~250ms after the
        // final_answer-phase message, with no open command to defer behind.
        await expect(client.sendTurnAndWait('initial request')).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        // Codex keeps working on the SAME provider turn: no turn/started
        // precedes this activity, matching the production log
        // (~/.happy_remote/logs — exec_command_begin ~23s after task_complete
        // with no intervening task_started).
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'item/started',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: { type: 'commandExecution', id: 'call-resume', command: 'cat file', cwd: '/tmp', status: 'inProgress' },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: {
                    type: 'commandExecution', id: 'call-resume', command: 'cat file', cwd: '/tmp',
                    aggregatedOutput: 'contents', exitCode: 0, durationMs: 1, status: 'completed',
                },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: { type: 'agentMessage', id: 'msg-real-final', text: 'the real final answer', phase: 'final_answer' },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-resume', turn: { id: 'turn-resume-1', status: 'completed', error: null } },
        });

        await waitFor(() => events.filter((event) => event.type === 'task_complete').length >= 2);
        expect(events.filter((event) => event.type === 'exec_command_end')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'agent_message' && event.message === 'the real final answer')).toHaveLength(1);

        let mapperState = {
            currentTurnId: null as string | null,
            currentProviderTurnId: null as string | null,
        };
        const lifecycleTypes = events.flatMap((event) => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, mapperState);
            mapperState = mapped;
            return mapped.envelopes.map((envelope) => envelope.ev.t);
        }).filter((type) => type === 'turn-start' || type === 'turn-end');
        expect(lifecycleTypes).toEqual([
            'turn-start',
            'turn-end',
            'turn-start',
            'turn-end',
        ]);

        await client.disconnect();
    });

    it('defers terminal completion until a command started by the turn completes', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-delayed-command', path: '/tmp/thread-delayed-command' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-delayed-command' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-delayed-command', turn: { id: 'turn-delayed-command' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-delayed-command',
                                turnId: 'turn-delayed-command',
                                item: {
                                    type: 'commandExecution', id: 'call-delayed', command: 'sleep 1', cwd: '/tmp', status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turnId: 'turn-delayed-command',
                                item: { type: 'agentMessage', id: 'final-delayed', text: 'final answer', phase: 'final_answer' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-delayed-command', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turn: { id: 'turn-delayed-command', status: 'failed', error: 'provider failed' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turn: { id: 'turn-stale', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        let settled = false;
        const completion = client.sendTurnAndWait('run delayed command').then((result) => {
            settled = true;
            return result;
        });
        await waitFor(() => events.some((event) => event.type === 'exec_command_begin'));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(events.some((event) => event.type === 'task_complete')).toBe(false);
        expect(settled).toBe(false);

        pushJsonLine(appServerStdout!, {
            method: 'item/completed',
            params: {
                threadId: 'thread-delayed-command',
                turnId: 'turn-delayed-command',
                item: {
                    type: 'commandExecution', id: 'call-delayed', command: 'sleep 1', cwd: '/tmp',
                    aggregatedOutput: '', exitCode: 0, durationMs: 1, status: 'completed',
                },
            },
        });

        await expect(completion).resolves.toEqual({ aborted: false });
        const commandEndIndex = events.findIndex((event) => event.type === 'exec_command_end');
        const terminalIndex = events.findIndex((event) => event.type === 'task_complete');
        expect(commandEndIndex).toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBeGreaterThan(commandEndIndex);
        expect(events[terminalIndex]).toEqual(expect.objectContaining({
            type: 'task_complete',
            status: 'failed',
            error: 'provider failed',
        }));

        let mapperState = {
            currentTurnId: null as string | null,
            currentProviderTurnId: null as string | null,
        };
        const sessionEnvelopes = events.flatMap((event) => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, mapperState);
            mapperState = mapped;
            return mapped.envelopes;
        });
        const lifecycleEnvelopes = sessionEnvelopes.filter((envelope) => (
            envelope.ev.t === 'turn-start'
            || envelope.ev.t === 'tool-call-start'
            || envelope.ev.t === 'tool-call-end'
            || envelope.ev.t === 'turn-end'
        ));
        expect(lifecycleEnvelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'tool-call-end',
            'turn-end',
        ]);
        expect(new Set(lifecycleEnvelopes.map((envelope) => envelope.turn))).toEqual(
            new Set([lifecycleEnvelopes[0].turn]),
        );
        expect(lifecycleEnvelopes[0].turn).toEqual(expect.any(String));

        await client.disconnect();
    });

    it('ignores a stale idle status from the previous turn while the next turn is starting', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        let turnStartCount = 0;
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-queued', path: '/tmp/thread-queued' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    turnStartCount += 1;
                    const turnId = turnStartCount === 1 ? 'turn-first' : 'turn-second';
                    setTimeout(() => {
                        if (turnId === 'turn-second') {
                            pushJsonLine(stdout, {
                                method: 'turn/started',
                                params: {
                                    threadId: 'thread-queued',
                                    turn: { id: 'turn-late-nested' },
                                },
                            });
                            pushJsonLine(stdout, {
                                method: 'thread/status/changed',
                                params: { threadId: 'thread-queued', status: { type: 'idle' } },
                            });
                        }

                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: turnId, items: [], status: 'inProgress', error: null },
                            },
                        });

                        if (turnId === 'turn-first') {
                            pushJsonLine(stdout, {
                                method: 'turn/started',
                                params: {
                                    threadId: 'thread-queued',
                                    turn: { id: turnId, items: [], status: 'inProgress', error: null },
                                },
                            });
                            pushJsonLine(stdout, {
                                method: 'item/completed',
                                params: {
                                    threadId: 'thread-queued',
                                    turnId,
                                    item: {
                                        type: 'agentMessage',
                                        id: 'msg-first',
                                        text: 'first done',
                                        phase: 'final_answer',
                                    },
                                },
                            });
                            return;
                        }

                        // The previous turn's idle notification can arrive after the
                        // next turn/start response but before its turn/started event.
                        setTimeout(() => {
                            pushJsonLine(stdout, {
                                method: 'thread/status/changed',
                                params: { threadId: 'thread-queued', status: { type: 'idle' } },
                            });
                        }, 0);
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await expect(client.sendTurnAndWait('first request')).resolves.toEqual({ aborted: false });

        let secondSettled = false;
        const second = client.sendTurnAndWait('second request').finally(() => {
            secondSettled = true;
        });
        await waitFor(() => turnStartCount === 2);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(secondSettled).toBe(false);
        expect(events.filter((event) => event.turn_id === 'turn-second')).toHaveLength(0);
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-queued',
                turn: { id: 'turn-second', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-queued',
                turnId: 'turn-second',
                item: {
                    type: 'agentMessage',
                    id: 'msg-second',
                    text: 'second done',
                    phase: 'final_answer',
                },
            },
        });

        await expect(second).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.turn_id === 'turn-second')).toEqual([
            expect.objectContaining({ type: 'task_started' }),
            expect.objectContaining({ type: 'task_complete' }),
        ]);

        await client.disconnect();
    });

    it('does not start a queued turn before the prior turn authoritative completion', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        let turnStartCount = 0;
        const proc = createMockProcess({
            pid: 3010,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-authoritative', path: '/tmp/thread-authoritative' },
                                model: 'gpt-test',
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    turnStartCount += 1;
                    const turnId = turnStartCount === 1 ? 'turn-first' : 'turn-second';
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: turnId } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-authoritative',
                                turn: { id: turnId, status: 'inProgress' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-authoritative',
                                turnId,
                                item: {
                                    type: 'agentMessage',
                                    id: `msg-${turnId}`,
                                    text: `${turnId} done`,
                                    phase: 'final_answer',
                                },
                            },
                        });
                        if (turnId === 'turn-second') {
                            pushJsonLine(stdout, {
                                method: 'turn/completed',
                                params: {
                                    threadId: 'thread-authoritative',
                                    turn: { id: turnId, status: 'completed', error: null },
                                },
                            });
                        }
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const first = client.sendTurnAndWait('first request');
        const second = first.then(() => client.sendTurnAndWait('second request'));
        await waitFor(() => events.some((event) => (
            event.type === 'agent_message' && event.message === 'turn-first done'
        )));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(turnStartCount).toBe(1);
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-authoritative',
                turn: { id: 'turn-first', status: 'completed', error: null },
            },
        });

        await expect(first).resolves.toEqual({ aborted: false });
        await expect(second).resolves.toEqual({ aborted: false });
        expect(turnStartCount).toBe(2);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when nested turn lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-root', path: '/tmp/thread-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-root',
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started' && event.turn_id === 'turn-root'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                item: {
                    type: 'agentMessage',
                    id: 'msg-root',
                    text: 'root done',
                    phase: 'final_answer',
                },
            },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);

        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-root', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when legacy nested lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3009,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-legacy-root', path: '/tmp/thread-legacy-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-legacy-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-root' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-nested' } },
        });
        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-nested' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-root' } },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);

        await client.disconnect();
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('falls back to final answer completion when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'happy:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });
});

/**
 * A managed Cloud run configures its own provider, and only its own.
 *
 * Account rotation exists to spread load across the operator's own Codex
 * accounts. For a managed run that is a different payer and a provider outside
 * the approval, so it must not be consulted at all — consulting it has already
 * started a proxy and picked an account by the time anything could override it.
 */
describe('CodexAppServerClient for a managed Cloud run', () => {
    const MANAGED_ARGS = [
        '-c', 'model_providers.saycode-managed.name="Saycode managed gateway"',
        '-c', 'model_providers.saycode-managed.base_url="https://studio.example.test/api/cloud/gateway/openai/v1"',
        '-c', 'model_providers.saycode-managed.env_key="OPENAI_API_KEY"',
        '-c', 'model_providers.saycode-managed.requires_openai_auth=false',
        '-c', 'model_providers.saycode-managed.wire_api="responses"',
        '-c', 'model_provider="saycode-managed"',
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: ['-c', 'model_provider="codex-multi-auth"'],
            env: { OPENAI_API_KEY: 'another-accounts-key' },
            cleanup: mockProxyCleanup,
        });
        mockProxyCleanup.mockResolvedValue(undefined);
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    it('never consults account rotation, and starts with the managed provider', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, undefined, undefined, MANAGED_ARGS);
        await client.connect();

        expect(mockPrepareCodexMultiAuthProxy).not.toHaveBeenCalled();
        const [, args] = mockSpawn.mock.calls[0];
        for (const expected of MANAGED_ARGS) expect(args).toContain(expected);
        // Not the rotation's provider, and not whatever the config file says.
        expect(args).not.toContain('model_provider="codex-multi-auth"');
    });

    it('still uses account rotation for an ordinary run', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        expect(mockPrepareCodexMultiAuthProxy).toHaveBeenCalled();
        const [, args] = mockSpawn.mock.calls[0];
        expect(args).toContain('model_provider="codex-multi-auth"');
    });
});
