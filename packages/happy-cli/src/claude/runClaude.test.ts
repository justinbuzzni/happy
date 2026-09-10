import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TITLE_INSTRUCTION } from '@/utils/titlePrompt';
import * as axIntegration from '@/orchestrator/prompts/integrate';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
    mockCreateCheckpointSessionComposition,
    mockCreateCheckpointEventPublisher,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartHappyServer: vi.fn(),
    mockStartHookServer: vi.fn(),
    mockRegisterKillSessionHandler: vi.fn(),
    mockCreateCheckpointSessionComposition: vi.fn(),
    mockCreateCheckpointEventPublisher: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mockApiClientCreate,
    },
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: mockReadSettings,
}));

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/claude/loop', () => ({
    loop: mockLoop,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mockNotifyDaemonSessionStarted,
}));

vi.mock('@/daemon/run', () => ({
    initialMachineMetadata: {},
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/happy-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: mockRegisterKillSessionHandler,
}));

vi.mock('@/checkpoint/checkpointSessionComposition', () => ({
    createCheckpointSessionComposition: mockCreateCheckpointSessionComposition,
}));

vi.mock('@/checkpoint/checkpointEventPublisher', () => ({
    createCheckpointEventPublisher: mockCreateCheckpointEventPublisher,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: {
        setBackend: vi.fn(),
        notifyOffline: vi.fn(),
        fail: vi.fn(),
    },
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));

import { runClaude } from './runClaude';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function expectPromptRejectsFast(promise: Promise<unknown>, pattern: RegExp) {
    await expect(Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('goal action did not reject')), 10);
        }),
    ])).rejects.toThrow(pattern);
}

async function startRemoteRunClaudeHarness(opts: {
    metadata?: Record<string, unknown>;
    updateAgentState?: ReturnType<typeof vi.fn>;
    registerHandler?: ReturnType<typeof vi.fn>;
    runOptions?: Partial<Parameters<typeof runClaude>[1]>;
} = {}) {
    let metadata = opts.metadata ?? {
        claudeSessionId: 'claude-session-1',
        slashCommands: ['goal'],
    };
    const updateAgentState = opts.updateAgentState ?? vi.fn();
    const registerHandler = opts.registerHandler ?? vi.fn();
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        capRuntimeProcessedSeq: vi.fn(),
        updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
        }),
        sendClaudeSessionMessage: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        hasTitle: vi.fn(() => false),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => metadata),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: {
            registerHandler,
        },
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    const runPromise = runClaude({
        kind: 'account',
        credentials: {
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        },
    } as any, {
        startingMode: 'remote',
        shouldStartDaemon: false,
        ...opts.runOptions,
    });

    await vi.waitFor(() => {
        expect(mockCreateSessionScanner).toHaveBeenCalled();
        expect(mockLoop).toHaveBeenCalled();
    });

    const scannerOptions = mockCreateSessionScanner.mock.calls.at(-1)?.[0];
    const loopOptions = mockLoop.mock.calls.at(-1)?.[0];
    if (!scannerOptions || !loopOptions) {
        throw new Error('runClaude harness did not start');
    }
    const runtimeSession = { thinking: false, cleanup: vi.fn() };
    loopOptions.onSessionReady(runtimeSession);
    const goalActionHandler = registerHandler.mock.calls.find(([method]) => method === 'goal-action')?.[1];

    const finish = async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        loopDeferred.resolve(0);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    };

    return {
        api,
        finish,
        goalActionHandler,
        loopOptions,
        registerHandler,
        runtimeSession,
        scannerOptions,
        sessionClient,
        updateAgentState,
    };
}

function emitClaudeGoalStatus(
    scannerOptions: { onTranscriptEvent: (event: unknown) => void },
    event: {
        uuid: string;
        met: boolean;
        condition: string;
        sourceSessionId?: string;
    },
) {
    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: event.uuid,
        sourceRevision: event.uuid,
        sourceSessionId: event.sourceSessionId ?? 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: event.met,
            sentinel: true,
            condition: event.condition,
        },
    });
}

describe('runClaude remote JSONL scanner', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }

        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        delete process.env.HAPPY_RECONNECT_SNAPSHOT;
        delete process.env.HAPPY_FORKED_FROM_SESSION_ID;
        delete process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;
        delete process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
        delete process.env.HAPPY_CREATED_BY_DISPLAY_NAME;
        delete process.env.HAPPY_INITIAL_PROMPT;
        delete process.env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED;
        delete process.env.HAPPY_AUTOMATION_RUN_ONCE;
        delete process.env.HAPPY_AUTOMATION_RESUME_PROMPT;
        delete process.env.HAPPY_PROJECT_SANDBOX_CONFIG;

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title'],
            stop: vi.fn(),
        });
        mockStartHookServer.mockResolvedValue({
            port: 23456,
            stop: vi.fn(),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(),
        });
        mockCreateCheckpointSessionComposition.mockImplementation(async (input) => ({
            sandboxConfig: input.sandboxConfig,
        }));
    });

    afterEach(() => {
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) {
                process.on(event as any, listener);
            }
        }
        originalListeners.clear();
    });

    it('persists an accepted active-turn prompt once and deduplicates the JSONL scanner copy', async () => {
        const harness = await startRemoteRunClaudeHarness();

        harness.loopOptions.onActiveUserInputAccepted('apply this now');

        expect(harness.sessionClient.sendSessionProtocolMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                ev: { t: 'text', text: 'apply this now' },
            }),
        );

        harness.scannerOptions.onMessage({
            type: 'user',
            message: { content: 'apply this now' },
        });
        expect(harness.sessionClient.sendClaudeSessionMessage).not.toHaveBeenCalled();

        await harness.finish();
    });

    it('injects the protected composition into Claude remote before its loop starts', async () => {
        const checkpointProtection = {
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        };
        process.env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify({ checkpointProtection });
        const beforeTurn = vi.fn(async () => {});
        const claudeSandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
        };
        mockCreateCheckpointSessionComposition.mockResolvedValue({
            sandboxConfig: { checkpointProtection, enabled: true },
            beforeTurn,
            claudeSandbox,
        });
        const checkpointEvents = { snapshot: vi.fn(), rewind: vi.fn() };
        mockCreateCheckpointEventPublisher.mockReturnValue(checkpointEvents);

        const harness = await startRemoteRunClaudeHarness();

        expect(mockCreateCheckpointEventPublisher).toHaveBeenCalledWith(expect.objectContaining({
            token: expect.any(String),
            sessionId: 'happy-session-1',
            encryption: expect.objectContaining({ encryptionVariant: expect.any(String) }),
        }));
        expect(mockCreateCheckpointSessionComposition).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'claude-remote',
            platform: process.platform,
            projectPath: process.cwd(),
            sessionId: 'happy-session-1',
            env: process.env,
            checkpointEvents,
        }));
        expect(harness.loopOptions.checkpointComposition).toMatchObject({
            beforeTurn,
            claudeSandbox,
        });
        await harness.finish();
    });

    it('passes reconnect seq and refreshes runtime metadata without losing server fields', async () => {
        process.env.HAPPY_RECONNECT_SESSION_ID = 'happy-session-1';
        process.env.HAPPY_RECONNECT_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32)).toString('base64');
        process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT = 'legacy';
        process.env.HAPPY_RECONNECT_SEQ = '42';
        process.env.HAPPY_RECONNECT_METADATA_VERSION = '3';
        process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION = '4';
        const reconnectMetadata = {
            path: '/tmp/project',
            host: 'test-host',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happy',
            happyLibDir: '/tmp/happy',
            happyToolsDir: '/tmp/happy/tools',
            flavor: 'claude',
            hostPid: 77316,
            version: '1.1.10-aplus.56',
            claudeSessionId: 'claude-session-1',
            summary: { text: 'preserved title', updatedAt: 1 },
            futureProviderState: { preserved: true },
        };
        process.env.HAPPY_RECONNECT_SNAPSHOT = Buffer.from(JSON.stringify({
            metadata: reconnectMetadata,
            seq: 42,
            metadataVersion: 3,
            agentStateVersion: 4,
        })).toString('base64');

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.sessionClient.suppressNextArchiveSignal).toHaveBeenCalledTimes(1);
        expect(harness.sessionClient.skipExistingMessages).toHaveBeenCalledWith(42);
        expect(harness.api.sessionSyncClient).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                hostPid: process.pid,
                summary: { text: 'preserved title', updatedAt: 1 },
                futureProviderState: { preserved: true },
            }),
            seq: 42,
            metadataVersion: 3,
        }));
        expect(mockNotifyDaemonSessionStarted).toHaveBeenCalledWith(
            'happy-session-1',
            expect.objectContaining({
                hostPid: process.pid,
                summary: { text: 'preserved title', updatedAt: 1 },
                futureProviderState: { preserved: true },
            }),
            expect.any(Object),
        );

        await harness.finish();
    });

    it('caps the runtime cursor and exits after one explicit automation resume turn', async () => {
        process.env.HAPPY_RECONNECT_SESSION_ID = 'happy-session-1';
        process.env.HAPPY_RECONNECT_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32)).toString('base64');
        process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT = 'legacy';
        process.env.HAPPY_RECONNECT_SNAPSHOT = Buffer.from(JSON.stringify({
            metadata: {
                path: '/tmp/project', flavor: 'claude', claudeSessionId: 'claude-session-1',
            },
            seq: 42,
            metadataVersion: 3,
            agentStateVersion: 4,
        })).toString('base64');
        process.env.HAPPY_INITIAL_PROMPT = 'apply reviewed findings';
        process.env.HAPPY_AUTOMATION_RESUME_PROMPT = '1';
        process.env.HAPPY_AUTOMATION_RUN_ONCE = '1';

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.sessionClient.capRuntimeProcessedSeq).toHaveBeenCalledWith(42);
        expect(harness.loopOptions.exitAfterFirstTurn).toBe(true);
        expect(process.env.HAPPY_AUTOMATION_RESUME_PROMPT).toBeUndefined();

        await harness.finish();
    });

    it('includes createdBy in fresh session metadata when the daemon supplies it', async () => {
        process.env.HAPPY_CREATED_BY_ACCOUNT_ID = 'acct-123';
        process.env.HAPPY_CREATED_BY_DISPLAY_NAME = 'Ada';

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.api.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                createdBy: { accountId: 'acct-123', displayName: 'Ada' },
            }),
        }));

        await harness.finish();
    });

    it('omits createdBy from fresh session metadata when not supplied (backward compatible)', async () => {
        const harness = await startRemoteRunClaudeHarness();

        const call = (harness.api.getOrCreateSession as any).mock.calls.at(-1)?.[0];
        expect(call.metadata.createdBy).toBeUndefined();

        await harness.finish();
    });

    it('consumes the automation run-once marker and passes it to the Claude loop', async () => {
        process.env.HAPPY_AUTOMATION_RUN_ONCE = '1';
        process.env.HAPPY_INITIAL_PROMPT = '업무 브리핑';

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.loopOptions.exitAfterFirstTurn).toBe(true);
        expect(process.env.HAPPY_AUTOMATION_RUN_ONCE).toBeUndefined();

        await harness.finish();
    });

    it('applies the recovered Saycode prompt policy to the atomically delivered first turn', async () => {
        process.env.HAPPY_INITIAL_PROMPT = '복구 후 이어서 작업해줘';
        process.env.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT = [
            'USER PROJECT CONTEXT',
            '',
            '<!-- saycode:owned-prompt -->',
            'SAYCODE RECOVERY PROMPT',
            '<!-- saycode:owned-prompt -->',
            '',
            '<!-- ax:base-prompt -->',
            'SAYCODE AX BASE',
            '<!-- ax:base-prompt -->',
        ].join('\n');
        process.env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED = 'false';

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.loopOptions.messageQueue.queue[0].mode).toMatchObject({
            appendSystemPrompt: 'USER PROJECT CONTEXT',
            saycodeSystemPromptEnabled: false,
        });
        // The recovered turn keeps the chat title nudge: titling is product
        // plumbing, not a Saycode-owned instruction, so it survives OFF.
        expect(harness.loopOptions.messageQueue.queue[0].message).toContain('복구 후 이어서 작업해줘');
        expect(harness.loopOptions.messageQueue.queue[0].message).toContain(TITLE_INSTRUCTION);
        expect(process.env.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT).toBeUndefined();
        expect(process.env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED).toBeUndefined();

        await harness.finish();
    });

    it('seeds per-block Saycode overrides from the recovery env into the first turn', async () => {
        process.env.HAPPY_INITIAL_PROMPT = '복구 후 이어서 작업해줘';
        process.env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED = 'true';
        process.env.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS = '{"workerDelegation":false}';

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.loopOptions.messageQueue.queue[0].mode.saycodePromptBlocks).toEqual({
            workerDelegation: false,
        });
        expect(process.env.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS).toBeUndefined();

        await harness.finish();
    });

    it('strips a recovered AX base when only its block is seeded off', async () => {
        // The per-turn path already honors the block gate; the recovery seed path
        // must apply the same rule or a master-on/axBase-off account's recovered
        // first turn re-injects the base the user turned off.
        process.env.HAPPY_INITIAL_PROMPT = '복구 후 이어서 작업해줘';
        process.env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED = 'true';
        process.env.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS = '{"axBase":false}';
        process.env.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT = [
            '<!-- ax:base-prompt -->',
            'SAYCODE AX BASE',
            '<!-- ax:base-prompt -->',
            '',
            'USER PROJECT CONTEXT',
        ].join('\n');

        const harness = await startRemoteRunClaudeHarness();

        expect(harness.loopOptions.messageQueue.queue[0].mode.appendSystemPrompt).toBe('USER PROJECT CONTEXT');

        await harness.finish();
    });

    it('keeps read-only tool restrictions when a remote message resets disallowed tools', async () => {
        process.env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify({
            enabled: true,
            sessionIsolation: 'custom',
            customWritePaths: [],
            allowLocalBinding: false,
        });
        const harness = await startRemoteRunClaudeHarness({
            runOptions: { permissionMode: 'read-only' },
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'review the change' },
            meta: { disallowedTools: null },
        });

        expect(harness.loopOptions.messageQueue.queue[0].mode).toMatchObject({
            permissionMode: 'bypassPermissions',
            disallowedTools: [
                'Edit',
                'MultiEdit',
                'Write',
                'NotebookEdit',
                'mcp__happy__bash_stream',
            ],
        });
        await harness.finish();
    });

    it('fails closed instead of starting an offline interactive Claude for automation', async () => {
        process.env.HAPPY_AUTOMATION_RUN_ONCE = '1';
        process.env.HAPPY_INITIAL_PROMPT = '업무 브리핑';
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => null),
        };
        mockApiClientCreate.mockResolvedValue(api);

        await expect(runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        })).rejects.toThrow('Claude automation cannot start while the Happy server is unavailable');

        expect(mockLoop).not.toHaveBeenCalled();
        expect(mockNotifyDaemonSessionStarted).not.toHaveBeenCalled();
    });

    it('does not forward terminal JSONL messages while local mode owns the transcript', async () => {
        const sentMessages: unknown[] = [];
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            capRuntimeProcessedSeq: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            hasTitle: vi.fn(() => false),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'local-owned-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in local terminal',
            },
        });

        expect(sentMessages).toHaveLength(0);

        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onModeChange('remote');
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'remote-terminal-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in parallel remote terminal',
            },
        });

        expect(sentMessages).toHaveLength(1);
        expect(sessionClient.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'remote-terminal-user' }),
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('observes goal_status side-channel events as agent goal state', async () => {
        const sentMessages: unknown[] = [];
        let metadata = {
            claudeSessionId: 'claude-session-1',
            slashCommands: ['goal'],
        };
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            capRuntimeProcessedSeq: vi.fn(),
            updateMetadata: vi.fn((updater: (current: typeof metadata) => typeof metadata) => {
                metadata = updater(metadata);
            }),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            hasTitle: vi.fn(() => false),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => metadata),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        expect(scannerOptions.onTranscriptEvent).toEqual(expect.any(Function));

        scannerOptions.onMessage({
            type: 'attachment',
            uuid: 'goal-event-as-message',
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });
        expect(sentMessages).toHaveLength(0);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-ignored',
            sourceSessionId: 'other-claude-session',
            sourceRevision: 'rev-ignored',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Wrong session goal',
            },
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        const userMessageHandler = sessionClient.onUserMessage.mock.calls[0][0];
        await userMessageHandler({
            content: { text: '/goal Ship goal observation' },
            meta: {},
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-1',
            sourceSessionId: 'claude-session-1',
            sourceRevision: 'rev-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });

        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(2);
        const goalUpdater = sessionClient.updateAgentState.mock.calls[1][0];
        const nextState = goalUpdater({ controlledByUser: false });
        expect(nextState).toMatchObject({
            controlledByUser: false,
            agentGoalStatus: {
                source: 'claude',
                status: 'active',
                sourceSessionId: 'claude-session-1',
                sourceRevision: 'rev-1',
                text: 'Ship goal observation',
                capabilities: { clear: true, edit: true },
            },
        });

        expect(sentMessages).toHaveLength(0);

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('registers Claude goal-action and queues clear as an isolated command without optimistic state changes', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'finish rpc test',
        });
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        const promise = handler({ action: 'clear' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal clear', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-cleared',
            met: true,
            condition: 'finish rpc test',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('rejects a second Claude goal action while one is pending', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        const first = handler({ action: 'edit', objective: 'new rpc goal' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        await expect(handler({ action: 'clear' })).rejects.toThrow(/already in progress|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-edited',
            met: false,
            condition: 'new rpc goal',
        });

        await expect(first).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('times out a pending Claude goal action, resets pending, and allows a subsequent action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-timeout',
            met: false,
            condition: 'timeout rpc goal',
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const first = handler({ action: 'clear' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal clear', isolate: true }),
            ]);

            vi.advanceTimersByTime(30000);
            await expect(first).rejects.toThrow(/Timed out waiting for Claude goal confirmation/);

            await harness.loopOptions.messageQueue.waitForMessagesAndGetAsString();
            const second = handler({ action: 'edit', objective: 'goal after timeout' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after timeout', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-timeout',
                met: false,
                condition: 'goal after timeout',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            vi.useRealTimers();
            await harness.finish();
        }
    });

    it('resets pending and clears timeout when pushIsolated throwing rejects Claude goal-action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-push-failure',
            met: false,
            condition: 'push failure rpc goal',
        });

        const originalPushIsolated = harness.loopOptions.messageQueue.pushIsolated.bind(harness.loopOptions.messageQueue);
        const pushError = new Error('pushIsolated failed');
        const pushIsolatedSpy = vi.spyOn(harness.loopOptions.messageQueue, 'pushIsolated')
            .mockImplementationOnce(() => {
                throw pushError;
            })
            .mockImplementation((...args: unknown[]) => {
                const [message, mode, attachments] = args as [string, any, any];
                originalPushIsolated(message, mode, attachments);
            });
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        try {
            await expect(handler({ action: 'clear' })).rejects.toThrow(/pushIsolated failed/);
            expect(clearTimeoutSpy).toHaveBeenCalled();

            const second = handler({ action: 'edit', objective: 'goal after push failure' });
            expect(pushIsolatedSpy).toHaveBeenCalledTimes(2);
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after push failure', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-push-failure',
                met: false,
                condition: 'goal after push failure',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            pushIsolatedSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            await harness.finish();
        }
    });

    it('queues edit Claude goal as isolated command and resolves only after a matching active side-channel status', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        let settled = false;
        const promise = handler({ action: 'edit', objective: '  revised rpc goal  ' });
        promise.then(() => { settled = true; });

        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal revised rpc goal', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-not-matching',
            met: false,
            condition: 'not yet revised',
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-matching',
            met: false,
            condition: '  revised rpc goal  ',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        expect(settled).toBe(true);
        await harness.finish();
    });

    it('rejects invalid and unsupported Claude goal-action params', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler(null)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler(undefined)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'stop' })).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'edit', objective: '   ' })).rejects.toThrow(/Unsupported Claude goal action/);
        await harness.finish();
    });

    it('rejects Claude goal-action when no active Claude goal is known', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler({ action: 'clear' })).rejects.toThrow(/No active Claude goal/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the relevant capability is missing', async () => {
        const harness = await startRemoteRunClaudeHarness({
            metadata: {
                claudeSessionId: 'claude-session-1',
                slashCommands: [],
            },
        });
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-no-capabilities',
            met: false,
            condition: 'goal without actions',
        });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/clear goal action is not supported/);
        await expect(handler({ action: 'edit', objective: 'new goal' })).rejects.toThrow(/edit goal action is not supported/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the message queue is busy', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-busy-queue',
            met: false,
            condition: 'busy queue goal',
        });
        harness.loopOptions.messageQueue.push('already queued', { permissionMode: 'default' });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/queue is busy|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: 'already queued' }),
        ]);
        await harness.finish();
    });

    it('rejects Claude goal-action while local mode owns the transcript', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-local-mode',
            met: false,
            condition: 'local mode goal',
        });
        harness.loopOptions.onModeChange('local');

        await expectPromptRejectsFast(handler({ action: 'clear' }), /not ready|remote/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([]);
        await harness.finish();
    });

    it('rejects Claude goal-action while Claude is still thinking', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-thinking',
            met: false,
            condition: 'thinking goal',
        });
        harness.runtimeSession.thinking = true;

        await expectPromptRejectsFast(handler({ action: 'clear' }), /not ready|thinking/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([]);
        await harness.finish();
    });

    it('appends the change_title instruction to a user message while the chat has no title', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(false);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({ content: { text: '로그인 버튼이 안 눌려' }, meta: {} });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(1);
        expect(queued[0].message.startsWith('로그인 버튼이 안 눌려')).toBe(true);
        expect(queued[0].message).toContain(TITLE_INSTRUCTION);
        await harness.finish();
    });

    it('does not append the change_title instruction once the chat already has a title', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({ content: { text: 'fix the parser' }, meta: {} });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(1);
        expect(queued[0].message).toBe('fix the parser');
        expect(queued[0].message).not.toContain(TITLE_INSTRUCTION);
        await harness.finish();
    });

    it('still appends the change_title instruction when Saycode prompts are disabled', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(false);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'use my own harness' },
            meta: { saycodeSystemPromptEnabled: false },
        });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(1);
        expect(queued[0].message).toContain('use my own harness');
        expect(queued[0].message).toContain(TITLE_INSTRUCTION);
        expect(queued[0].mode.saycodeSystemPromptEnabled).toBe(false);
        await harness.finish();
    });

    it('exposes the latest Saycode prompt policy to local mode transitions', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'switch to my local harness' },
            meta: { saycodeSystemPromptEnabled: false },
        });

        expect(harness.loopOptions.getSaycodeSystemPromptEnabled()).toBe(false);
        await harness.finish();
    });

    it('keeps the latest Saycode prompt policy when abort resets turn-scoped options', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'disable the product prompt' },
            meta: { saycodeSystemPromptEnabled: false },
        });
        harness.loopOptions.onAbort();

        expect(harness.loopOptions.getSaycodeSystemPromptEnabled()).toBe(false);
        await harness.finish();
    });

    it('keeps the latest append prompt when abort resets turn-scoped options', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'first turn' },
            meta: {
                appendSystemPrompt: 'USER PROJECT CONTEXT',
                saycodeSystemPromptEnabled: false,
            },
        });
        harness.loopOptions.onAbort();
        await userMessageHandler({
            content: { text: 'second turn' },
            meta: { saycodeSystemPromptEnabled: false },
        });

        expect(harness.loopOptions.messageQueue.queue[1].mode.appendSystemPrompt).toBe(
            'USER PROJECT CONTEXT',
        );
        await harness.finish();
    });

    it('passes per-block Saycode prompt overrides through to the queued mode', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'only turn off worker delegation' },
            meta: {
                saycodeSystemPromptEnabled: true,
                saycodePromptBlocks: { workerDelegation: false },
            },
        });

        expect(harness.loopOptions.messageQueue.queue[0].mode.saycodePromptBlocks).toEqual({
            workerDelegation: false,
        });
        await harness.finish();
    });

    it('keeps the latest per-block overrides when abort resets turn-scoped options', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'first turn' },
            meta: { saycodePromptBlocks: { axBase: false } },
        });
        harness.loopOptions.onAbort();
        await userMessageHandler({
            content: { text: 'second turn' },
            meta: {},
        });

        expect(harness.loopOptions.messageQueue.queue[1].mode.saycodePromptBlocks).toEqual({
            axBase: false,
        });
        await harness.finish();
    });

    it('does not batch turns that differ only in per-block Saycode overrides', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'first turn' },
            meta: { saycodePromptBlocks: { workerDelegation: false } },
        });
        await userMessageHandler({
            content: { text: 'second turn' },
            meta: { saycodePromptBlocks: { workerDelegation: true } },
        });

        // collectBatch() merges adjacent queue entries sharing a modeHash and applies the
        // FIRST entry's mode to the whole batch — so a hash that ignores the overrides
        // would silently run 'second turn' under the previous turn's block policy.
        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(2);
        expect(queued[0].modeHash).not.toBe(queued[1].modeHash);
        await harness.finish();
    });

    it('passes the resolved Saycode policy to AX orchestration', async () => {
        const orchestration = vi.spyOn(axIntegration, 'applyAxOrchestration').mockResolvedValue(null);
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'keep selected AX context only' },
            meta: { saycodeSystemPromptEnabled: false },
        });

        expect(orchestration).toHaveBeenCalledWith(expect.objectContaining({
            saycodeSystemPromptEnabled: false,
        }));
        orchestration.mockRestore();
        await harness.finish();
    });

    it('removes a stale AX Saycode base when only the axBase block is turned off', async () => {
        // applyAxOrchestration's own merge strips the stale base, but it returns null on a
        // non-AX / unavailable workspace — then this path is the only cleanup. Gating it on
        // the master boolean alone leaves the base injected forever for a user who turned
        // just this block off.
        const orchestration = vi.spyOn(axIntegration, 'applyAxOrchestration').mockResolvedValue(null);
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'continue without the AX base' },
            meta: {
                saycodeSystemPromptEnabled: true,
                saycodePromptBlocks: { axBase: false },
                appendSystemPrompt: [
                    '<!-- ax:base-prompt -->',
                    'You are the Saycode AI assistant.',
                    '<!-- ax:base-prompt -->',
                    '',
                    'CUSTOM USER PROMPT',
                ].join('\n'),
            },
        });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(1);
        expect(queued[0].mode.appendSystemPrompt).toBe('CUSTOM USER PROMPT');
        orchestration.mockRestore();
        await harness.finish();
    });

    it('removes a stale AX Saycode base when AX state is no longer available', async () => {
        const orchestration = vi.spyOn(axIntegration, 'applyAxOrchestration').mockResolvedValue(null);
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'continue without product instructions' },
            meta: {
                saycodeSystemPromptEnabled: false,
                appendSystemPrompt: [
                    '<!-- ax:base-prompt -->',
                    'You are the Saycode AI assistant.',
                    '<!-- ax:base-prompt -->',
                    '',
                    'CUSTOM USER PROMPT',
                ].join('\n'),
            },
        });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(1);
        expect(queued[0].mode.appendSystemPrompt).toBe('CUSTOM USER PROMPT');
        orchestration.mockRestore();
        await harness.finish();
    });

    it('separates queued turns when the Saycode prompt policy changes', async () => {
        const harness = await startRemoteRunClaudeHarness();
        harness.sessionClient.hasTitle.mockReturnValue(true);
        await vi.waitFor(() => {
            expect(harness.sessionClient.onUserMessage).toHaveBeenCalled();
        });
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({ content: { text: 'first' }, meta: { saycodeSystemPromptEnabled: true } });
        await userMessageHandler({ content: { text: 'second' }, meta: { saycodeSystemPromptEnabled: false } });

        const queued = harness.loopOptions.messageQueue.queue;
        expect(queued).toHaveLength(2);
        expect(queued.map((item: any) => item.mode.saycodeSystemPromptEnabled)).toEqual([true, false]);
        await harness.finish();
    });
});
