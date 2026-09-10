import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TITLE_INSTRUCTION } from '@/utils/titlePrompt';
import * as axIntegration from '@/orchestrator/prompts/integrate';

const {
    mockApiClientManaged,
    mockGetProjectPath,
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
    mockApiClientManaged: vi.fn(),
    mockGetProjectPath: vi.fn(() => '/tmp'),
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
        managed: mockApiClientManaged,
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

vi.mock('@/claude/registerKillSessionHandler', () => ({
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

vi.mock('@/claude/utils/path', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/claude/utils/path')>(),
    getProjectPath: mockGetProjectPath,
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));


import { runClaude } from '@/claude/runClaude';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';
import type { ManagedStartup } from '@/managed/managedStartup';

/**
 * The managed branch of the real runner.
 *
 * This calls `runClaude` itself, with no settings and no machine id — the
 * shape a managed child actually starts in. What it proves is the runner's own
 * wiring: that it does not exit for the missing machine, that it stands in the
 * runtime's project root, that the agent is pointed at the approved gateway
 * and at nothing else, and that the session it uses is the attached one.
 *
 * It does not prove the API client's refusals or the lookup; those run against
 * a real server in managedStartupAttach.test.ts and managedSessionAttach.test.ts.
 * No agent process is launched here.
 */
const GATEWAY = 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages';

function managedStartup(): ManagedStartup {
    return {
        envelope: {
            directory: MANAGED_PROJECT_ROOT,
            agent: 'claude',
            model: 'claude-opus-5',
            effort: 'high',
            initialPrompt: 'do the thing',
            initialPromptLocalId: 'c'.repeat(32),
            bootstrap: {
                version: 1,
                serverOrigin: 'https://happy.example.test',
                sessionId: 'sess-managed-runner',
                encryptionVariant: 'dataKey',
                rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
                wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
                scopedToken: 'scoped.bearer.value',
                tokenExpiresAt: Date.now() + 3_600_000,
            },
            gateway: {
                baseUrl: GATEWAY,
                capability: 'capability-for-this-run',
                provider: 'anthropic',
                endpoint: 'anthropic-messages',
                model: 'claude-opus-5',
            },
        },
        attachment: {
            session: {
                id: 'sess-managed-runner',
                seq: 3,
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'dataKey',
                metadata: { path: MANAGED_PROJECT_ROOT } as never,
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 1,
            },
            managed: { serverOrigin: 'https://happy.example.test' },
            scopedToken: 'scoped.bearer.value',
        },
    };
}

/**
 * Process listeners the runner installs, and this file's duty to undo them.
 *
 * A completed startup registers signal and failure handlers on `process`, and
 * a suite that runs the startup a dozen times leaves a dozen sets behind —
 * Node warns about the leak, and the handlers stay live for every later test.
 * Only the ones a test actually added are removed: the runner is not the sole
 * owner of these events, and stripping the rest would disable whatever the
 * harness itself relies on.
 */
const RUNNER_PROCESS_EVENTS = [
    'uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT',
] as const;

describe('runClaude for a managed Cloud child', () => {
    let listenersBefore: Map<string, Set<(...args: unknown[]) => void>>;
    let sessionClient: Record<string, unknown>;
    let api: Record<string, unknown>;
    let loopDeferred: { promise: Promise<void>; resolve: () => void };
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: { mockRestore: () => void; mock: { calls: unknown[] } };

    beforeEach(() => {
        listenersBefore = new Map(RUNNER_PROCESS_EVENTS.map((event) => [
            event,
            new Set(process.listeners(event as never) as Array<(...args: unknown[]) => void>),
        ]));
        vi.clearAllMocks();
        // The runtime this process starts in is not assumed to be clean: a
        // reused one carries lineage from earlier launches, and inheriting it
        // is precisely what must not happen. Removed here so the test controls
        // its own environment rather than the machine it happens to run on.
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('HAPPY_RECONNECT_') || key.startsWith('HAPPY_FORK')
                || key.startsWith('HAPPY_CREATED_BY') || key.startsWith('HAPPY_INITIAL_')) {
                delete process.env[key];
            }
        }
        // No account home: nothing was ever registered on this runtime.
        mockReadSettings.mockResolvedValue(null);
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(MANAGED_PROJECT_ROOT);
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${code}) was called`);
        }) as never) as unknown as typeof exitSpy;

        let metadata: Record<string, unknown> = { path: MANAGED_PROJECT_ROOT };
        sessionClient = {
            sessionId: 'sess-managed-runner',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            capRuntimeProcessedSeq: vi.fn(),
            updateMetadata: vi.fn((updater: (c: Record<string, unknown>) => Record<string, unknown>) => {
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
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            awaitMessageAck: vi.fn(async () => ({ ok: true })),
            sendClaudeSessionMessageFromLocalTranscript: vi.fn(),
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        api = {
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register a machine'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create a session'); }),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientManaged.mockReturnValue(api);
        mockCreateSessionScanner.mockReturnValue({ stop: vi.fn(), start: vi.fn() });
        mockStartHappyServer.mockResolvedValue({ url: 'http://127.0.0.1:1/', toolNames: [], stop: vi.fn() });
        mockStartHookServer.mockResolvedValue({ url: 'http://127.0.0.1:2/', stop: vi.fn() });
        mockRegisterKillSessionHandler.mockReturnValue(undefined);
        mockCreateCheckpointSessionComposition.mockReturnValue({
            protectedBashCwd: MANAGED_PROJECT_ROOT,
            trackProtectedWriter: vi.fn(),
            stop: vi.fn(),
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue(undefined);

        let resolve!: () => void;
        const promise = new Promise<void>((res) => { resolve = res; });
        loopDeferred = { promise, resolve };
        mockLoop.mockReturnValue(promise);
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        vi.unstubAllEnvs();
        for (const event of RUNNER_PROCESS_EVENTS) {
            const before = listenersBefore.get(event)!;
            for (const listener of process.listeners(event as never) as Array<(...args: unknown[]) => void>) {
                if (!before.has(listener)) process.removeListener(event as never, listener as never);
            }
        }
    });

    async function start() {
        const startup = managedStartup();
        const run = runClaude({ kind: 'managed', startup }, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });
        run.catch(() => { /* startup finished; the loop is what we assert on */ });
        // Reaching the agent loop is the signal that startup completed.
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled(), { timeout: 8_000 });
        return { startup, run };
    }

    it('starts with no settings and no machine id, and registers none', async () => {
        // An account-shaped start would have exited here: there is no machine
        // id in settings because nothing on this runtime was ever registered.
        const { run } = await start();
        expect(exitSpy.mock.calls).toEqual([]);
        expect(api.getOrCreateMachine).not.toHaveBeenCalled();
        expect(api.getOrCreateSession).not.toHaveBeenCalled();
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('uses the session it was attached to', async () => {
        const { startup, run } = await start();
        expect(mockApiClientManaged).toHaveBeenCalledWith(startup.attachment);
        expect(api.sessionSyncClient).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'sess-managed-runner' }),
        );
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('points the agent at the approved gateway and removes every other key', async () => {
        // Keys an ordinary machine would have, which the agent CLI picks up on
        // its own in preference to anything this process decided.
        vi.stubEnv('ANTHROPIC_API_KEY', 'someone-elses-key');
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'someone-elses-oauth');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic');

        const { run } = await start();
        expect(process.env.ANTHROPIC_BASE_URL).toBe('https://studio.example.test/api/cloud/gateway/anthropic');
        expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('capability-for-this-run');
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('runs the model the envelope approved, not one the caller supplied', async () => {
        // A launch environment and a command line both naming a cheaper model.
        // The startup consumes these seeds, so the proof is what the agent loop
        // is actually started with.
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'a prompt from another launch');
        vi.stubEnv('HAPPY_INITIAL_MODEL', 'claude-cheap');

        const startup = managedStartup();
        const run = runClaude({ kind: 'managed', startup }, {
            startingMode: 'remote',
            shouldStartDaemon: false,
            model: 'claude-cheap',
            claudeArgs: ['--model', 'claude-cheap', '--verbose'],
        });
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled(), { timeout: 8_000 });

        expect(mockLoop).toHaveBeenCalledWith(expect.objectContaining({
            model: 'claude-opus-5',
            path: MANAGED_PROJECT_ROOT,
        }));
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('delivers the envelope prompt through the seam the agent consumes', async () => {
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'a prompt from another launch');
        vi.stubEnv('HAPPY_INITIAL_PROMPT_FILE', '/tmp/somebody-elses-prompt');
        // Observed at the point of consumption: the startup reads and deletes
        // these, so the value it read is the one that matters.
        const { run } = await start();
        // Consumed exactly once, and never left for a later launch to inherit.
        expect(process.env.HAPPY_INITIAL_PROMPT).toBeUndefined();
        expect(process.env.HAPPY_INITIAL_PROMPT_FILE).toBeUndefined();
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('does not let a caller redirect the gateway through --claude-env', async () => {
        // These land in `process.env` after startup (claudeRemote.ts), so they
        // would otherwise replace the gateway and the capability.
        const startup = managedStartup();
        const run = runClaude({ kind: 'managed', startup }, {
            startingMode: 'remote',
            shouldStartDaemon: false,
            claudeEnvVars: {
                ANTHROPIC_BASE_URL: 'https://evil.test',
                ANTHROPIC_AUTH_TOKEN: 'someone-elses-token',
                MY_OWN_SETTING: 'kept',
            },
        });
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled(), { timeout: 8_000 });

        expect(mockLoop).toHaveBeenCalledWith(expect.objectContaining({
            claudeEnvVars: { MY_OWN_SETTING: 'kept' },
        }));
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('gives the SDK the base it appends to, not the whole route', async () => {
        const { run } = await start();
        // `new URL(baseURL + '/v1/messages')`: the whole route here would build
        // `/anthropic/v1/messages/v1/messages`.
        expect(process.env.ANTHROPIC_BASE_URL)
            .toBe('https://studio.example.test/api/cloud/gateway/anthropic');
        expect(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`).toBe(GATEWAY);
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('will not answer the prompt until its delivery is acknowledged', async () => {
        // The child arrives with a clean environment — no flag from anywhere.
        // A managed envelope is itself the requirement, so the run must wait
        // for a durable acknowledgement before the model is reached.
        expect(process.env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK).toBeUndefined();

        let settleAck!: (value: { ok: boolean; reason?: string }) => void;
        const pendingAck = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
            settleAck = resolve;
        });
        const awaitMessageAck = vi.fn(() => pendingAck);
        (sessionClient as { awaitMessageAck: unknown }).awaitMessageAck = awaitMessageAck;

        const startup = managedStartup();
        const run = runClaude({ kind: 'managed', startup }, {
            startingMode: 'remote', shouldStartDaemon: false,
        });
        const settled = run.then(
            () => ({ rejected: false as const }),
            (error: unknown) => ({ rejected: true as const, error }),
        );

        await vi.waitFor(() => expect(awaitMessageAck).toHaveBeenCalled(), { timeout: 8_000 });
        // While the acknowledgement is outstanding: no turn, so no provider
        // call and nothing reported as done.
        await new Promise((r) => setTimeout(r, 50));
        expect(mockLoop).not.toHaveBeenCalled();
        expect((sessionClient as { sendSessionEvent: ReturnType<typeof vi.fn> }).sendSessionEvent)
            .not.toHaveBeenCalled();

        // An acknowledgement that says the record is not durable ends the run
        // rather than letting it answer anyway.
        settleAck({ ok: false, reason: 'not-durable' });
        const outcome = await settled;
        expect(outcome.rejected).toBe(true);
        expect(String((outcome as { error: unknown }).error)).toMatch(/durab/i);
        expect(mockLoop).not.toHaveBeenCalled();
    }, 30_000);

    it('ignores a session this runtime was attached to before', async () => {
        // A reused runtime still carrying an earlier launch's reconnect
        // environment. Read before the prompt is prepared, it makes the runner
        // resume that session — dropping this run's prompt as already
        // delivered, and merging the foreign snapshot's metadata over its own.
        vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'sess-somebody-else');
        vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_KEY', Buffer.alloc(32, 3).toString('base64'));
        vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'dataKey');
        vi.stubEnv('HAPPY_RECONNECT_SNAPSHOT', Buffer.from(JSON.stringify({
            metadata: { path: '/somewhere/else', host: 'other' },
            metadataVersion: 9, agentState: null, agentStateVersion: 9, seq: 9,
        })).toString('base64'));
        vi.stubEnv('HAPPY_RECONNECT_SEQ', '9');
        vi.stubEnv('HAPPY_RECONNECT_METADATA_VERSION', '9');
        vi.stubEnv('HAPPY_RECONNECT_AGENT_STATE_VERSION', '9');
        // A fork of somebody else's conversation whose transcript really is
        // on this runtime's disk. Read, it is replayed into *this* session and
        // the native session id is rewritten to match.
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const historyDir = mkdtempSync(join(tmpdir(), 'managed-fork-'));
        writeFileSync(join(historyDir, 'claude-somebody-else.jsonl'), [
            JSON.stringify({
                type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'claude-somebody-else',
                timestamp: new Date().toISOString(), cwd: '/somewhere/else',
                message: { role: 'user', content: 'somebody elses question' },
            }),
        ].join('\n'));
        mockGetProjectPath.mockReturnValue(historyDir);
        vi.stubEnv('HAPPY_FORK_CLAUDE_SESSION_ID', 'claude-somebody-else');
        vi.stubEnv('HAPPY_FORKED_FROM_SESSION_ID', 'sess-somebody-else');
        vi.stubEnv('HAPPY_CREATED_BY_ACCOUNT_ID', 'account-somebody-else');

        const { run } = await start();
        // Nothing from another conversation was replayed into this session,
        // and its native id was not rewritten to somebody else's.
        expect((sessionClient as { sendClaudeSessionMessageFromLocalTranscript: ReturnType<typeof vi.fn> })
            .sendClaudeSessionMessageFromLocalTranscript).not.toHaveBeenCalled();
        expect((sessionClient as { getMetadata: () => Record<string, unknown> }).getMetadata()
            .claudeSessionId).toBeUndefined();
        // Its own session, and its own prompt was delivered rather than
        // discarded as belonging to a resumed one.
        expect(api.sessionSyncClient).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'sess-managed-runner' }),
        );
        expect((sessionClient as { awaitMessageAck: ReturnType<typeof vi.fn> }).awaitMessageAck)
            .toHaveBeenCalled();
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('refuses a user turn posted to the session, during and after the first one', async () => {
        // The account that owns this session can post an encrypted user
        // message to it. Arriving as an ordinary turn it would change the
        // model and the permission mode and queue another turn — spending
        // this run's capability on work no admission covered.
        const { run } = await start();
        const onUserMessage = (sessionClient as { onUserMessage: ReturnType<typeof vi.fn> })
            .onUserMessage;
        expect(onUserMessage).toHaveBeenCalled();
        const handler = onUserMessage.mock.calls[0][0] as (m: unknown) => Promise<void>;

        const drain = (sessionClient as { drainAttachmentsForUserMessage: ReturnType<typeof vi.fn> })
            .drainAttachmentsForUserMessage;
        const loopCallsBefore = mockLoop.mock.calls.length;

        await handler({
            content: { text: 'answer this instead' },
            meta: { model: 'claude-cheap', permissionMode: 'bypassPermissions' },
        });
        await handler({ content: { text: 'and this' }, meta: {} });

        // Nothing was drained, queued or re-selected, and no extra turn ran.
        expect(drain).not.toHaveBeenCalled();
        expect(mockLoop.mock.calls.length).toBe(loopCallsBefore);
        expect(mockLoop).toHaveBeenCalledWith(expect.objectContaining({
            model: 'claude-opus-5',
        }));
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('refuses a new objective, while still allowing one to be cleared', async () => {
        // Setting a goal carries a free-text instruction into every turn after
        // it — work this run's admission never covered. Clearing one removes an
        // instruction rather than adding one, so it stays available.
        const { run } = await start();
        const register = (sessionClient as {
            rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> };
        }).rpcHandlerManager.registerHandler;
        const goalAction = register.mock.calls.find((call) => call[0] === 'goal-action')?.[1] as
            ((params: unknown) => Promise<unknown>) | undefined;
        expect(goalAction).toBeDefined();

        await expect(goalAction!({ action: 'edit', objective: 'do something else' }))
            .rejects.toThrow(/objective/i);
        // Clearing is a different method shape and is not refused for being
        // managed; whatever it does next is the ordinary path.
        await expect(goalAction!({ action: 'clear' })).rejects.not.toThrow(/managed run/i);

        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('carries the managed flag down to the handlers the launcher registers', async () => {
        const { run } = await start();
        expect(mockLoop).toHaveBeenCalledWith(expect.objectContaining({ managedRun: true }));
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('loads no filesystem settings, so none can redirect the gateway', async () => {
        // A settings file's `env` block is applied to the agent and takes
        // precedence over the environment this startup produced, so a
        // `~/.claude/settings.json` left on the runtime image could point the
        // agent at another gateway or another key. A managed run loads none of
        // those sources — the empty list is explicit, because the SDK's default
        // is to load every source Claude Code would.
        const { run } = await start();
        expect(mockLoop).toHaveBeenCalledWith(expect.objectContaining({
            managedSettingsLockdown: true,
        }));
        loopDeferred.resolve();
        await run.catch(() => {});
    }, 30_000);

    it('refuses to run outside the runtime project root', async () => {
        cwdSpy.mockReturnValue('/somewhere/else');
        await expect(runClaude({ kind: 'managed', startup: managedStartup() }, {
            startingMode: 'remote', shouldStartDaemon: false,
        })).rejects.toThrow(/project root/i);
        expect(mockLoop).not.toHaveBeenCalled();
    }, 30_000);
});

/**
 * The steer handler the remote launcher registers.
 *
 * Steering injects free text into the turn already running, which for a
 * managed run is an instruction its admission never covered. Refused before
 * the active turn is reached at all.
 */
describe('the Claude steer handler', () => {
    async function registerAndTakeSteer(managedRun: boolean) {
        const { claudeRemoteLauncher } = await import('@/claude/claudeRemoteLauncher');
        const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
        const activeInputSender = vi.fn(() => true);
        const session = {
            managedRun,
            sessionId: 'sess-managed-runner',
            path: MANAGED_PROJECT_ROOT,
            allowedTools: [],
            mcpServers: {},
            messageQueue: { get: vi.fn(async () => null) },
            client: {
                rpcHandlerManager: {
                    registerHandler: (method: string, handler: never) => {
                        handlers.set(method, handler);
                    },
                },
                sendSessionEvent: vi.fn(),
                updateAgentState: vi.fn(),
                getMetadata: vi.fn(() => ({})),
            },
            onActiveUserInputAccepted: vi.fn(),
            // Captured the moment the launcher offers it.
            setActiveInputSender: activeInputSender,
        };
        // The launcher runs a turn; it is not what is under test here.
        void claudeRemoteLauncher(session as never).catch(() => {});
        await vi.waitFor(() => expect(handlers.has('steer')).toBe(true), { timeout: 5_000 });
        return { steer: handlers.get('steer')!, activeInputSender };
    }

    it('refuses a managed run without reaching the active turn', async () => {
        const { steer, activeInputSender } = await registerAndTakeSteer(true);
        await expect(steer({ text: 'do something else' }))
            .resolves.toEqual({ success: false, error: 'A managed run cannot be steered' });
        expect(activeInputSender).not.toHaveBeenCalled();
    }, 30_000);

    it('still refuses an ordinary run only for having no active turn', async () => {
        const { steer } = await registerAndTakeSteer(false);
        // The ordinary refusal, which is about the turn rather than the run.
        await expect(steer({ text: 'do something else' }))
            .resolves.toEqual({ success: false, error: 'No active Claude turn' });
    }, 30_000);
});
