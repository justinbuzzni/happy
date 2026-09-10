/**
 * The order a managed Codex run applies its envelope in.
 *
 * `runCodex` reads the initial prompt out of the environment very early, and
 * that read consumes it. An envelope applied after that point never reaches
 * the first turn: the child starts with no prompt, and the delivery the parent
 * is waiting to have acknowledged never happens.
 *
 * This drives the real ordering rather than the helper, by calling the same
 * preparation `runCodex` calls, in the same sequence, against the envelope.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecSyncOptions } from 'node:child_process';

/**
 * The real runner is what has to hold the order, so the observation is made
 * from inside `prepareCodexInitialPrompt` — the call that consumes the prompt.
 * A future edit that moves the envelope application below it fails here.
 */
const promptSeenAt: Array<{ prompt?: string; localId?: string }> = [];
vi.mock('@/codex/initialPrompt', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/codex/initialPrompt')>();
    return {
        ...original,
        prepareCodexInitialPrompt: (input: Parameters<typeof original.prepareCodexInitialPrompt>[0]) => {
            promptSeenAt.push({
                prompt: input.env.HAPPY_INITIAL_PROMPT,
                localId: input.env.HAPPY_INITIAL_PROMPT_LOCAL_ID,
            });
            return original.prepareCodexInitialPrompt(input);
        },
    };
});
vi.mock('@/utils/killShims', () => ({ installBroadKillShims: vi.fn() }));

/**
 * `runCodex` shells out to `codex --version` early and calls `process.exit(1)`
 * when it is absent — correct for a user who has not installed it, and fatal
 * for a suite that has nothing to do with the Codex CLI. A machine that
 * happens to have it hides that: these tests passed locally and died on CI at
 * the first assertion past the check, because the run had already exited.
 *
 * Only that one command is answered, matched exactly. A prefix would let any
 * future `codex …` invocation be faked here, which is a different behaviour
 * standing in for the real one.
 */
vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    // `execSync` is overloaded on its options, so the wrapper is written
    // against one signature and asserted to the whole set once — the assertion
    // is on the function, not on any value passing through it.
    const execSync = ((command: string, options?: ExecSyncOptions) => {
        if (command === 'codex --version') return 'codex-cli 0.140.0';
        return original.execSync(command, options);
    }) as typeof original.execSync;
    return { ...original, execSync };
});

/**
 * Enough of the runner's surroundings for the real `runCodex` to reach the
 * point where it waits for the delivery acknowledgement. Everything mocked
 * here is a dependency, not the behaviour under test: the ordering and the
 * gate are the real code.
 */
const mockAwaitMessageAck = vi.fn();
const mockSendSessionEvent = vi.fn();
const mockConnect = vi.fn(async () => {});
/** Reads another thread's history so it can be replayed into this session. */
const mockReadThread = vi.fn(async () => ({ thread: { id: 'thread-somebody-else', turns: [] } }));
/** Constructed only once the delivery has been acknowledged (runCodex:767). */
const mockClientConstructed = vi.fn();
const mockReadSettings = vi.fn(async () => ({ machineId: undefined }));
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: mockReadSettings,
}));
vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        constructor(...args: unknown[]) { mockClientConstructed(args); }
        connect = mockConnect;
        readThread = mockReadThread;
        setEventHandler = vi.fn();
        supportsGoalActions = () => false;
        dispose = vi.fn(async () => {});
        interrupt = vi.fn(async () => {});
    },
}));
vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1/', toolNames: [], stop: vi.fn() })),
}));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => {}) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn() },
}));

import { prepareCodexInitialPrompt } from '@/codex/initialPrompt';
import {
    applyManagedGatewayEnvironment,
    applyManagedInitialPrompt,
    managedCodexProviderArguments,
} from '@/managed/managedStartup';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

const SAYCODE = 'https://studio.example.test';

function envelope(): ManagedSpawnEnvelope {
    return {
        directory: '/workspace/project',
        agent: 'codex',
        model: 'gpt-5',
        effort: 'high',
        initialPrompt: 'the prompt this run was created for',
        initialPromptLocalId: 'd'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: {
            baseUrl: `${SAYCODE}/api/cloud/gateway/openai/v1/responses`,
            capability: 'capability-for-this-run',
            provider: 'openai',
            endpoint: 'openai-responses',
            model: 'gpt-5',
        },
    };
}

/**
 * The plan a managed run carries, built by **the launcher's own planner**.
 *
 * Written by hand it drifts: the verifier reconstructs the argument list from
 * its own rules and compares it exactly, so a hand-written fixture stops being
 * a plan the moment those rules change — and the failure then looks like a
 * broken control rather than a stale fixture.
 */
async function plannedProviderArguments(): Promise<void> {
    const { buildCodexToolPolicy } = await import('@/launcher/codexToolPolicy');
    const policy = buildCodexToolPolicy({
        codexHome: '/workspace/.codex',
        brokerUrl: 'http://127.0.0.1:8931/mcp',
        brokerToken: 'broker-token-for-this-run',
        env: {},
    });
    process.env.SAYCODE_PROVIDER_CODEX_ARGS = JSON.stringify(policy.args);
}

describe('a managed Codex start', () => {
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
        // What a runtime's environment actually looks like on arrival: a stale
        // prompt from an earlier launch and somebody else's provider key.
        env = {
            HAPPY_INITIAL_PROMPT: 'a prompt from another launch',
            HAPPY_INITIAL_PROMPT_LOCAL_ID: 'stale',
            OPENAI_API_KEY: 'another-accounts-key',
        };
    });

    it('carries the envelope prompt into the first turn', () => {
        applyManagedGatewayEnvironment(env, envelope());
        applyManagedInitialPrompt(env, envelope());

        const prepared = prepareCodexInitialPrompt({
            env,
            automationRunOnceRequested: false,
        });
        expect(prepared.prompt).toBe('the prompt this run was created for');
        expect(prepared.localId).toBe('d'.repeat(32));
    });

    it('loses the prompt entirely when the envelope is applied too late', () => {
        // The defect, stated as a fact about ordering: the read consumes the
        // value, so anything written afterwards is written to nobody.
        const prepared = prepareCodexInitialPrompt({
            env,
            automationRunOnceRequested: false,
        });
        applyManagedInitialPrompt(env, envelope());

        expect(prepared.prompt).toBe('a prompt from another launch');
        expect(prepared.localId).not.toBe('d'.repeat(32));
    });

    it('requires the delivery to be acknowledged before the provider is reached', () => {
        // The child arrives with a clean environment: whatever the daemon does
        // or does not set, a managed envelope is itself the requirement. If the
        // confirmation is not demanded here, the run answers the prompt and
        // spends the capability before anything durable records that it was
        // delivered — and a failure afterwards cannot tell the two apart.
        expect(env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK).toBeUndefined();
        applyManagedInitialPrompt(env, envelope());

        const prepared = prepareCodexInitialPrompt({
            env,
            automationRunOnceRequested: false,
        });
        expect(prepared.requireConfirmedDelivery).toBe(true);
    });

    it('has the provider pinned before any turn can be taken', () => {
        applyManagedGatewayEnvironment(env, envelope());
        const args = managedCodexProviderArguments(envelope());

        // The capability replaced the inherited key, and the provider the CLI
        // will use is the managed one — both settled before the first turn.
        expect(env.OPENAI_API_KEY).toBe('capability-for-this-run');
        expect(env.OPENAI_BASE_URL).toBe(`${SAYCODE}/api/cloud/gateway/openai/v1`);
        expect(args).toContain('model_provider="saycode-managed"');
    });
});

/**
 * The real `runCodex`, driven to the acknowledgement it must wait for.
 *
 * Observing that the prompt was read in the right order says nothing about
 * whether the run then waits. This drives the runner until it asks for the
 * acknowledgement, holds it there, and checks that no turn was taken — then
 * answers "not durable" and requires the run to end rather than proceed.
 */
describe('runCodex itself, for a managed child', () => {
    const attachment = {
        session: {
            id: 'sess-1', seq: 0,
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'dataKey' as const,
            metadata: { path: '/workspace/project' } as never,
            metadataVersion: 0, agentState: null, agentStateVersion: 0,
        },
        managed: { serverOrigin: 'https://happy.example.test' },
        scopedToken: 'scoped.bearer.value',
    };

    function sessionClientStub() {
        return {
            sessionId: 'sess-1',
            awaitMessageAck: mockAwaitMessageAck,
            sendSessionEvent: mockSendSessionEvent,
            sendSessionProtocolMessage: vi.fn(),
            updateMetadata: vi.fn(),
            getMetadata: vi.fn(() => ({ path: '/workspace/project' })),
            updateAgentState: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            hasTitle: vi.fn(() => false),
            skipExistingMessages: vi.fn(),
            capRuntimeProcessedSeq: vi.fn(),
            suppressNextArchiveSignal: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            keepAlive: vi.fn(),
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
    }

    beforeEach(async () => {
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('HAPPY_RECONNECT_') || key.startsWith('HAPPY_FORK')
                || key.startsWith('HAPPY_CREATED_BY') || key.startsWith('HAPPY_INITIAL_')) {
                delete process.env[key];
            }
        }
        /*
         * Every managed control below is a run the launcher started, and such a
         * run now carries a verified provider plan or refuses. Set here, once,
         * rather than in the controls that happen to notice: setting it inside
         * one test left the others passing only because that test had run
         * first, so the suite's result depended on ordering — green locally,
         * red in CI, and red about the wrong thing when it failed.
         *
         * The one control that is *about* the missing plan deletes it itself.
         */
        await plannedProviderArguments();
        promptSeenAt.length = 0;
        mockAwaitMessageAck.mockReset();
        mockSendSessionEvent.mockReset();
        mockConnect.mockClear();
        mockClientConstructed.mockClear();
        mockReadThread.mockClear();
    });

    afterEach(() => {
        // The plan is this run's, not the process's: leaving it set would let a
        // later test pass on a neighbour's environment.
        delete process.env.SAYCODE_PROVIDER_CODEX_ARGS;
    });

    it('has applied the envelope before it reads the prompt', async () => {
        const { runCodex } = await import('@/codex/runCodex');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'a prompt from another launch');
        vi.stubEnv('HAPPY_INITIAL_PROMPT_LOCAL_ID', 'stale');
        mockAwaitMessageAck.mockResolvedValue({ ok: true });

        try {
            await runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            }).catch(() => { /* startup fails past the point under test */ });
        } finally {
            cwdSpy.mockRestore();
            vi.unstubAllEnvs();
        }

        expect(promptSeenAt).toHaveLength(1);
        expect(promptSeenAt[0].prompt).toBe('the prompt this run was created for');
        expect(promptSeenAt[0].localId).toBe('d'.repeat(32));
    }, 60_000);

    it('refuses a managed run that carries no verified provider plan', async () => {
        /*
         * The launcher pins this run's tool boundary in the provider plan. A
         * managed run without one must stop rather than fall back to the
         * ordinary arguments — falling back is how a managed child ends up
         * running with no broker registration and no credential env var.
         */
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);
        mockAwaitMessageAck.mockResolvedValue({ ok: true });
        delete process.env.SAYCODE_PROVIDER_CODEX_ARGS;

        try {
            await expect(runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            })).rejects.toThrow(/no verified provider plan/);
            expect(mockClientConstructed).not.toHaveBeenCalled();
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }, 60_000);

    it('does reach the app-server once the acknowledgement succeeds', async () => {
        // The control for the test below: "connect was not called" only means
        // something if a run that is acknowledged does call it.
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);
        mockAwaitMessageAck.mockResolvedValue({ ok: true });
        // A managed run now carries the launcher's verified provider plan, and
        // refuses to start without one. Without it this control would fail for
        // the wrong reason — before the app-server, not because of the ack.

        try {
            await runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            }).catch(() => { /* the run fails somewhere past the app-server */ });
            expect(mockAwaitMessageAck).toHaveBeenCalled();
            expect(mockClientConstructed).toHaveBeenCalled();
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }, 60_000);

    it('ignores a thread this runtime was forked from before', async () => {
        // A reused runtime still carrying an earlier launch's fork lineage.
        // Acted on, it reads that thread's history and replays it into *this*
        // session, then rewrites the native thread id to match.
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);
        mockAwaitMessageAck.mockResolvedValue({ ok: true });
        vi.stubEnv('HAPPY_FORK_CODEX_THREAD_ID', 'thread-somebody-else');
        vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'sess-somebody-else');

        try {
            await runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            }).catch(() => { /* the run fails past the backfill */ });

            // The backfill reads this variable much later in the run, past
            // where this harness reaches. What is checked here is that the
            // value is gone by the time the runner is running at all — so
            // there is nothing left for that reader, or any other, to act on.
            expect(process.env.HAPPY_FORK_CODEX_THREAD_ID).toBeUndefined();
            expect(process.env.HAPPY_RECONNECT_SESSION_ID).toBeUndefined();
            expect(mockReadThread).not.toHaveBeenCalled();
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
            vi.unstubAllEnvs();
        }
    }, 60_000);

    it('refuses a new objective, while leaving clearing available', async () => {
        // A goal carries a free-text instruction into every turn after it —
        // work this run's admission never covered. Clearing removes an
        // instruction rather than adding one, so it is not refused for being
        // managed; both arrive through the same handler, which reads the
        // parameters the RPC name alone cannot express.
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);
        mockAwaitMessageAck.mockResolvedValue({ ok: true });

        try {
            await runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            }).catch(() => { /* the run fails past the registration */ });

            const goalAction = stub.rpcHandlerManager.registerHandler.mock.calls
                .find((call: unknown[]) => call[0] === 'goal-action')?.[1] as
                    ((params: unknown) => Promise<unknown>) | undefined;
            // No fallback: a run that did not register the handler has not
            // exercised the guard, and a test that accepts that outcome proves
            // nothing about it.
            expect(goalAction).toBeDefined();
            await expect(goalAction!({ action: 'edit', objective: 'do something else' }))
                .rejects.toThrow(/objective/i);
            await expect(goalAction!({ action: 'clear' })).rejects.not.toThrow(/objective/i);
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }, 60_000);

    it('refuses a user turn posted to the session', async () => {
        // Same ingress as Claude: the account that owns the session can post
        // an encrypted user message, which would arrive as an ordinary turn,
        // re-select the permission mode and queue work no admission covered.
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);
        mockAwaitMessageAck.mockResolvedValue({ ok: true });

        try {
            await runCodex({
                principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
            }).catch(() => { /* the run fails past the registration */ });

            expect(stub.onUserMessage).toHaveBeenCalled();
            const handler = stub.onUserMessage.mock.calls[0][0] as (m: unknown) => unknown;
            stub.drainAttachmentsForUserMessage.mockClear();

            await handler({
                content: { text: 'answer this instead' },
                meta: { permissionMode: 'bypassPermissions' },
            });
            // Nothing drained, so nothing was queued and no extra turn ran.
            expect(stub.drainAttachmentsForUserMessage).not.toHaveBeenCalled();
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }, 60_000);

    it('waits for the acknowledgement, and ends the run when it is refused', async () => {
        const { runCodex } = await import('@/codex/runCodex');
        const { ApiClient } = await import('@/api/api');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');
        const stub = sessionClientStub();
        const managedSpy = vi.spyOn(ApiClient, 'managed').mockReturnValue({
            getOrCreateMachine: vi.fn(async () => { throw new Error('must not register'); }),
            getOrCreateSession: vi.fn(async () => { throw new Error('must not create'); }),
            sessionSyncClient: vi.fn(() => stub),
            deactivateSession: vi.fn(async () => {}),
        } as never);

        let settleAck!: (value: { ok: boolean; reason?: string }) => void;
        mockAwaitMessageAck.mockReturnValue(new Promise((resolve) => { settleAck = resolve; }));

        const run = runCodex({
            principal: { kind: 'managed', startup: { envelope: envelope(), attachment } },
        });
        const settled = run.then(
            () => ({ rejected: false as const }),
            (error: unknown) => ({ rejected: true as const, error }),
        );

        try {
            await vi.waitFor(() => expect(mockAwaitMessageAck).toHaveBeenCalled(), { timeout: 20_000 });
            // Held at the acknowledgement: the app-server was never asked to
            // take a turn, so no provider call and nothing reported as done.
            await new Promise((r) => setTimeout(r, 50));
            expect(mockClientConstructed).not.toHaveBeenCalled();
            expect(mockSendSessionEvent).not.toHaveBeenCalled();

            settleAck({ ok: false, reason: 'not-durable' });
            const outcome = await settled;
            expect(outcome.rejected).toBe(true);
            expect(String((outcome as { error: unknown }).error)).toMatch(/durab/i);
            expect(mockClientConstructed).not.toHaveBeenCalled();
        } finally {
            managedSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    }, 60_000);
});
