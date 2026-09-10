/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import {
    registerCommonHandlers,
    type RecoverSessionOptions,
    type RecoverSessionResult,
    type ResumeSessionResult,
    type SpawnSessionOptions,
    type SpawnSessionResult,
} from '../modules/common/registerCommonHandlers';
import { resolveDaemonAllowedRoot } from '../modules/common/resolveAllowedRoot';
import { REMOTE_TERMINAL_DISABLED_ERROR, resolveMachineLockdownPolicy } from '../daemon/machineLockdownPolicy';
import { homedir } from 'node:os';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { createTerminalOutputCoalescer } from '@/daemon/terminalOutputCoalescer';
import { backoff } from '@/utils/time';
import { applyManagedRpcRestrictions, registerManagedRpcHandlers, type ManagedRpcHandlers } from '@/daemon/managedRpcHandlers';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { createRpcRequestListener } from './rpc/rpcRequestListener';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import type { PortRegistry } from '@/daemon/portRegistry';
import type { AutomationStore } from '@/daemon/automations/automationStore';
import { createAutomationRpcHandlers } from '@/daemon/automations/automationRpcHandlers';
import {
    resolveStopSessionMode,
    type StopSessionContext,
    type StopSessionResult,
} from '@/daemon/sessionIdleReaper';
import { proxyHttp, PreviewProxyError } from '@/daemon/previewProxy';
import { PreviewWsProxy } from '@/daemon/previewWsProxy';
import { startServerProcess, StartServerError } from '@/daemon/startServer';
import packageJson from '../../package.json';
import { AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { stopServerProcess, StopServerError } from '@/daemon/stopServer';
import { createPtySession } from '@/daemon/remoteTerminal';
import { decideTerminalCwd, formatCwdFallbackBanner } from '@/daemon/decideTerminalCwd';
import { validatePath } from '@/modules/common/pathSecurity';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { readDaemonState } from '@/persistence';
import { fetchBrowserStatus } from '@/daemon/browserClient';
import { runPairing, formatPairOutcome } from '@/commands/browserPair';
import {
    canSudoWithoutPassword,
    detectChrome,
    isCdpReachable,
    launchChrome,
    planChromeInstall,
    resolveChromeDisplay,
    resolveProfileUserDataDir,
} from '@/daemon/browserSetup';
import {
    buildWebsockifyArgs,
    buildX11vncArgs,
    buildXvfbArgs,
    VIEWER_SLOTS,
    VIEWER_VNC_PORTS,
    VIEWER_WEB_PORTS,
    decideViewerBrowserAction,
    decideViewerStackAction,
    readDisplayFromEnviron,
    readFlagFromCmdline,
    summariseViewerBrowser,
    type ViewerBrowserSummary,
    detectMissingViewerTools,
    isViewerServing,
    planViewerInstall,
    resolveViewerProfileDir,
    selectViewerSlot,
    spawnDetached,
    validateViewerKey,
    viewerProcessMatchesLease,
} from '@/daemon/remoteViewer';
import {
    BrowserViewerLeaseRegistry,
    type BrowserViewerLeaseRecord,
} from '@/daemon/browserViewerLeaseRegistry';
import { BrowserSessionBrokerClient } from '@/daemon/browserSessionBrokerContract';
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken';
import { deriveBrowserViewerBridgeToken } from '@/daemon/browserBridge';
import { readFile, readdir } from 'node:fs/promises';
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    killAllDaemonTerminalSessions,
    recordBytesIn,
    recordBytesOut,
    removeDaemonTerminalSession,
} from '@/daemon/daemonTerminalSessions';
import type { ChildProcess } from 'node:child_process';
import type { BrowserCdpPipe } from '@/daemon/browserCdpPipe';
import { shouldReconnect } from '@/utils/lidState';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { createClaudeSessionTransferHandler } from '@/claude/utils/claudeSessionTransfer';
import { readClaudeCodeUsage } from '@/claudeCodeUsage/readUsage';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { createCodexThreadTransferHandler } from '@/codex/codexThreadTransfer';
import { ADDITIONAL_DIRECTORIES_CAPABILITY, parseAdditionalDirectories } from '@/daemon/additionalDirectories';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';
import type { MachineAutomationKey } from '@/daemon/automations/machineAutomationKey';
import type { ServerAutomationCache } from '@/daemon/automations/serverAutomationCache';
import { syncServerAutomationDeltas } from '@/daemon/automations/serverAutomationSync';
import type { ServerAutomationTransport } from '@/daemon/automations/serverAutomationExecutor';
import type { PendingAutomationReport } from '@/daemon/automations/serverAutomationRuntimeStore';
import type { SessionFollowupTransport } from '@/daemon/automations/sessionFollowupRunner';
import type { AiCredentialRuntime } from '@/daemon/aiCredentialRuntime';
import type { AutonomousQualityGateRpcHandlers } from '@/daemon/autonomousQualityGateRpc';
import type { CheckpointRpcHandlers } from '@/checkpoint/checkpointRpc';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROKER_ACTIVITY_TOUCH_INTERVAL_MS = 60_000;

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    // `callback` is optional because socket.io does not guarantee an ack on
    // every delivered packet — see createRpcRequestListener.
    'rpc-request': (data: { method: string, params: string }, callback?: (response: string) => void) => void;
    'proxy-http-request': (
        params: {
            port: number;
            method: string;
            path: string;
            headers: Record<string, string>;
            bodyB64: string | null;
        },
        ack: (response: unknown) => void,
    ) => void;
    // Preview WebSocket relay (raw byte tunnel). Counterpart to
    // proxy-http-request for upgrades (noVNC/websockify, ws, HMR). See
    // daemon/previewWsProxy.ts.
    'proxy-ws-open': (
        params: { tunnelId: string; port: number; dataB64: string },
        ack: (response: unknown) => void,
    ) => void;
    'proxy-ws-data': (payload: { tunnelId: string; dataB64: string }) => void;
    'proxy-ws-close': (payload: { tunnelId: string }) => void;
    // specs/remote-terminal/ Phase 2 — server forwards terminal control
    // events here. `params` / `data` payloads are E2EE between the
    // daemon and the originating client; happy-server only routes them.
    'terminal-open-fwd': (
        msg: { sessionId: string; params: string | null },
        ack: (response: unknown) => void,
    ) => void;
    'terminal-frame-fwd': (msg: { sessionId: string; data: string }) => void;
    'terminal-resize-fwd': (msg: { sessionId: string; cols: number; rows: number }) => void;
    'terminal-close-fwd': (msg: { sessionId: string }) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'automation-key-register': (data: {
        expectedKeyVersion: number;
        publicKey: string;
        protocolVersion: number;
    }, cb: (answer: {
        ok: boolean;
        value?: { keyVersion: number };
        error?: string;
    }) => void) => void;
    'automation-sync': (data: { afterSeq: string; limit: number }, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'automation-sync-ack': (data: {
        items: Array<{ automationId: string; revision: number }>;
    }, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'automation-claim': (data: {
        automationId: string;
        generation: number;
        scheduledFor: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-start': (data: {
        runId: string;
        claimToken: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-heartbeat': (data: {
        runId: string;
        claimToken: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-report': (data: PendingAutomationReport, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'session-followup-sync': (data: {
        wireVersion: 1;
        afterSeq: string;
        limit: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-claim': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-evaluate': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        decision: 'WAIT' | 'CONTINUE' | 'TERMINATE';
        observedSeq: number;
        terminalCode?: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-deliver': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        expectedSeq: number;
        localId: string;
        contentCiphertext: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
    // specs/remote-terminal/ Phase 2 — daemon-originated stream frames.
    // `data` is the E2EE-encrypted PTY chunk; happy-server forwards it
    // to the client without inspection.
    'terminal-frame': (msg: { sessionId: string; data: string }) => void;
    'terminal-closed': (msg: { sessionId: string; code: number; signal: number | null }) => void;
    // Preview WebSocket relay — upstream→browser bytes and tunnel teardown.
    'proxy-ws-data': (payload: { tunnelId: string; dataB64: string }) => void;
    'proxy-ws-close': (payload: { tunnelId: string }) => void;
}

type BrowserPairResult = {
    ok: boolean;
    message: string;
    connections: Array<{ profile: string; pairingId?: string }>;
    freshProfiles: string[];
    debuggerTier: boolean | null;
};

type ViewerBridgeSummary =
    | { bridgeReady: true; bridgeMessage?: undefined }
    | { bridgeReady: false; bridgeMessage: string };

type ViewerBrowserState = ViewerBrowserSummary & Partial<ViewerBridgeSummary>;
type ViewerStackStartResult = {
    display: string;
    vncPort: number | null;
    webPort: number;
    ready: boolean;
    reused: boolean;
} & ViewerBrowserState;

type IsolatedViewerStartResult = {
    viewerKey: string;
    slot: number;
    display: string;
    vncPort: number;
    webPort: number;
    profileDir: string;
    ready: boolean;
    reused: boolean;
} & ViewerBrowserState;

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: {
        model?: string;
        permissionMode?: string;
        environmentVariables?: Record<string, string>;
        mcpCallerGrantEnvelope?: string;
        mcpConfigProjectId?: string;
        expectedConnectors?: string[];
    }) => Promise<ResumeSessionResult>;
    recoverSession?: (sessionId: string, options: RecoverSessionOptions) => Promise<RecoverSessionResult>;
    stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
    requestShutdown: () => void;
    portRegistry: PortRegistry;
    /** When present, registers the scheduled-automation RPCs and advertises automationSupport. */
    automationStore?: AutomationStore;
    /**
     * Reports a freshly spawned session to A+ so it lands in the project's conversation list
     * (specs/daemon-spawn-project-link). Absent on a plain Happy daemon.
     *
     * The spawn path awaits this bounded bookkeeping attempt before returning so Desktop cannot
     * observe lineage before the project can load the child. Failure still leaves spawn successful.
     */
    linkSpawnedSession?: (input: { sessionId: string; directory: string }) => void | Promise<void>;
    aiCredentialRuntime: AiCredentialRuntime;
    autonomousQualityGate?: AutonomousQualityGateRpcHandlers;
    checkpoint?: CheckpointRpcHandlers;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function readExpectedConnectors(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value)
        || value.length > 32
        || value.some((provider) => typeof provider !== 'string' || !/^[a-z0-9-]{1,64}$/.test(provider))
    ) {
        throw new Error('Expected connectors must contain provider names only');
    }
    const providers = [...new Set(value)].sort();
    return providers.length > 0 ? providers : undefined;
}

async function withCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    /** Set when the managed credential ended; suppresses every reconnect. */
    private credentialStopped = false;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private runtimeActivityProvider: (() => {
        activeSessionCount: number;
        activeAutomationCount: number;
    }) | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    // specs/20260521-happy-cli-version-republish — daemon 재시작 후 새 cli
    // 버전을 server metadata 에 re-publish 못 하던 회귀 fix. null 초기
    // 이므로 첫 keep-alive 가 무조건 publish 하여 stale 한 server-side
    // happyCliVersion 을 갱신한다.
    private lastKnownCliVersion: string | null = null;
    // Whether the automation RPCs were registered (setRPCHandlers with an
    // automationStore). Advertised as metadata.automationSupport.rpcAvailable.
    private automationRpcAvailable = false;
    private lastKnownAutomationRpcAvailable: boolean | null = null;
    private autonomousQualityGateRpcAvailable = false;
    private lastKnownAutonomousQualityGateRpcAvailable: boolean | null = null;
    private automationKey: MachineAutomationKey | null = null;
    private automationProtocolVersion: number = AUTOMATION_PROTOCOL_VERSION;
    private persistAutomationKeyVersion: ((version: number) => void) | null = null;
    private automationServerKeyVersion: number | null = null;
    // Fail closed while server-backed ownership is unresolved. Legacy file ticks
    // are enabled only after the server explicitly reports rollout disabled.
    private automationLegacyFallbackEnabled = false;
    private lastKnownAutomationServerKeyVersion: number | null = null;
    private serverAutomationCache: ServerAutomationCache | null = null;
    private serverAutomationSyncInFlight: Promise<void> | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    // Live raw-TCP tunnels for preview WebSocket upgrades (previewWsProxy.ts).
    private previewWsProxy: PreviewWsProxy | null = null;
    // Running noVNC stack for the remote browser screen, if started.
    // vncPort is null for a stack we adopted from a previous daemon: only the
    // process that spawned it knows which VNC port it bound, and nothing after
    // adoption reads it. Guessing it by arithmetic would encode a coupling the
    // args builders do not actually promise.
    private viewer: { display: string; vncPort: number | null; webPort: number } | null = null;
    private viewerStartInFlight: {
        callerWillLaunchBrowser: boolean;
        promise: Promise<ViewerStackStartResult>;
    } | null = null;
    /** Set only on a verified managed runtime; null on every BYOS machine. */
    private managedHandlers: ManagedRpcHandlers | null = null;
    private isolatedViewerLeases = new Map<string, BrowserViewerLeaseRecord>();
    private isolatedViewerStarts = new Map<string, Promise<IsolatedViewerStartResult>>();
    private isolatedViewerMutation: Promise<void> = Promise.resolve();
    private isolatedViewerRegistry = new BrowserViewerLeaseRegistry(
        join(configuration.happyHomeDir, 'browser-viewers', 'leases.json'),
    );
    private browserSessionBroker = process.env.HAPPY_BROWSER_BROKER_SOCKET
        ? new BrowserSessionBrokerClient(process.env.HAPPY_BROWSER_BROKER_SOCKET)
        : null;
    private brokerRelayTouchedAt = new Map<number, number>();
    // Unsafe extension commands are accepted only from the fd 3/4 pipe that
    // launched Chrome. Keep that owner alive for as long as this daemon uses
    // the browser; a CDP port cannot recreate or replace the pipe later.
    private browserCdpPipes = new Map<number, BrowserCdpPipe>();
    private resumeSessionHandler: ((sessionId: string, options?: {
        model?: string;
        permissionMode?: string;
        environmentVariables?: Record<string, string>;
        mcpCallerGrantEnvelope?: string;
        mcpConfigProjectId?: string;
        expectedConnectors?: string[];
    }) => Promise<ResumeSessionResult>) | null = null;
    private recoverSessionHandler: ((sessionId: string, options: RecoverSessionOptions) => Promise<RecoverSessionResult>) | null = null;
    private linkSpawnedSessionHandler: ((input: { sessionId: string; directory: string }) => void | Promise<void>) | null = null;
    // specs/remote-terminal-cwd-fallback/ — cached so the
    // terminal-open-fwd handler can run validatePath against the same
    // root the rest of the RPC surface uses (Files tab / writeFile).
    private allowedRoot: string;
    private reconnectInterval: NodeJS.Timeout | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        // specs/daemon-rpc-workspace-rebase/ Phase 2 — rebase the
        // path-validation root for machine-scoped RPCs (getDirectoryTree
        // / readFile / writeFile / etc.) onto the user's home directory
        // (or HAPPY_WORKSPACE_ROOT if the operator explicitly puts the
        // workspace outside home, e.g. /opt/work). Previously this used
        // process.cwd(), which made the RPC surface depend on whichever
        // shell the user happened to start `happy daemon start` in,
        // breaking the cross-identity Files tab when the daemon was
        // launched from / or any directory that doesn't enclose the
        // project's workspaceDir.
        const allowedRoot = resolveDaemonAllowedRoot(process.env, homedir());
        this.allowedRoot = allowedRoot;
        registerCommonHandlers(this.rpcHandlerManager, allowedRoot);
        this.rpcHandlerManager.registerHandler(
            'claude-session-transfer',
            createClaudeSessionTransferHandler({ allowedRoot }),
        );
        this.rpcHandlerManager.registerHandler(
            'codex-thread-transfer',
            createCodexThreadTransferHandler({
                allowedRoot,
                codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
                readThreadPath: async (threadId) => withCodexAppServerClient(async (client) => {
                    const { thread } = await client.readThread({ threadId, includeTurns: false });
                    if (typeof thread.path !== 'string' || thread.path.length === 0) {
                        throw new Error('Codex thread rollout path is unavailable');
                    }
                    return thread.path;
                }),
                forkThreadFromPath: async ({ path, cwd }) => withCodexAppServerClient(async (client) => {
                    const forked = await client.forkThreadFromPath({ path, cwd });
                    return { threadId: forked.threadId };
                }),
            }),
        );
    }

    /**
     * Enables the managed dispatch surface. Must be called before
     * `setRPCHandlers`, which applies the restrictions as its last step.
     */
    setManagedRuntime(handlers: ManagedRpcHandlers): void {
        this.managedHandlers = handlers;
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        recoverSession,
        stopSession,
        requestShutdown,
        portRegistry,
        automationStore,
        aiCredentialRuntime,
        autonomousQualityGate,
        checkpoint,
        linkSpawnedSession,
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;
        this.recoverSessionHandler = recoverSession ?? null;
        this.linkSpawnedSessionHandler = linkSpawnedSession ?? null;

        if (autonomousQualityGate) {
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:start', autonomousQualityGate.start);
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:status', autonomousQualityGate.status);
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:control', autonomousQualityGate.control);
            this.autonomousQualityGateRpcAvailable = true;
        }

        if (checkpoint) {
            this.rpcHandlerManager.registerHandler('checkpoint:status', checkpoint.status);
            this.rpcHandlerManager.registerHandler('checkpoint:list', checkpoint.list);
            this.rpcHandlerManager.registerHandler('checkpoint:preview', checkpoint.preview);
            this.rpcHandlerManager.registerHandler('checkpoint:execute', checkpoint.execute);
            this.rpcHandlerManager.registerHandler('checkpoint:cancel', checkpoint.cancel);
            this.rpcHandlerManager.registerHandler('checkpoint:retry', checkpoint.retry);
            this.rpcHandlerManager.registerHandler('checkpoint:decision', checkpoint.decision);
            this.rpcHandlerManager.registerHandler('checkpoint:restart', checkpoint.restart);
        }

        // Scheduled automations CRUD (specs: daemon-scheduled-automations).
        // Handlers live in automationRpcHandlers.ts so they unit-test without
        // an RpcHandlerManager; directory validation reuses this.allowedRoot,
        // the same root the spawn/file RPC surface enforces.
        if (automationStore) {
            const automationHandlers = createAutomationRpcHandlers({
                store: automationStore,
                allowedRoot: this.allowedRoot,
            });
            this.rpcHandlerManager.registerHandler('automation-upsert', automationHandlers.upsert);
            this.rpcHandlerManager.registerHandler('automation-remove', automationHandlers.remove);
            this.rpcHandlerManager.registerHandler('automation-list', automationHandlers.list);
            this.automationRpcAvailable = true;
        }

        this.rpcHandlerManager.registerHandler('ai-credential:export', (params) => (
            aiCredentialRuntime.capture(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:apply', (params) => (
            aiCredentialRuntime.apply(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:purge', (params) => (
            aiCredentialRuntime.purge(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:status', (params) => (
            aiCredentialRuntime.status(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:rotation', (params) => (
            aiCredentialRuntime.rotation(params)
        ));

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            if (params === null || typeof params !== 'object' || Array.isArray(params)) {
                throw new Error('Spawn parameters must be an object');
            }
            const {
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                environmentVariables,
                additionalDirectories,
                token,
                happyToken,
                happySecret,
                mcpCallerGrantEnvelope,
                mcpConfigProjectId,
                expectedConnectors,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                parentSessionId,
                forkedFromMessageId,
                createdByAccountId,
                createdByDisplayName,
                axStep,
                bootstrapFiles,
                initialPrompt,
                exitAfterFirstTurn,
            } = params || {};
            logger.debug(`[API MACHINE] Spawning session: dir=${directory}, hasUserCreds=${!!(happyToken && happySecret)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }
            if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                throw new Error('MCP caller grant envelope must be a string');
            }
            if (
                mcpConfigProjectId !== undefined
                && (typeof mcpConfigProjectId !== 'string' || !mcpConfigProjectId.trim())
            ) {
                throw new Error('MCP config project id must be a non-empty string');
            }
            const validExpectedConnectors = readExpectedConnectors(expectedConnectors);
            const validAdditionalDirectories = parseAdditionalDirectories(additionalDirectories);
            if (validAdditionalDirectories && agent !== 'claude' && agent !== 'codex') {
                throw new Error('Additional directories are only supported for Claude and Codex');
            }
            if (
                initialPrompt !== undefined
                && (typeof initialPrompt !== 'string' || !initialPrompt.trim())
            ) {
                throw new Error('Initial prompt must be a non-empty string');
            }
            if (exitAfterFirstTurn !== undefined && typeof exitAfterFirstTurn !== 'boolean') {
                throw new Error('Exit-after-first-turn must be a boolean');
            }
            if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
                throw new Error('Model must be a non-empty string');
            }
            if (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) {
                throw new Error('Effort must be a non-empty string');
            }
            if (exitAfterFirstTurn && initialPrompt === undefined) {
                throw new Error('Run-once session requires a non-empty initial prompt');
            }
            const runOnceAgent = agent ?? 'claude';
            if (exitAfterFirstTurn && runOnceAgent !== 'claude' && runOnceAgent !== 'codex') {
                throw new Error('Run-once session is only supported for Claude and Codex');
            }

            const result = await spawnSession({
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                environmentVariables,
                additionalDirectories: validAdditionalDirectories,
                token,
                happyToken,
                happySecret,
                mcpCallerGrantEnvelope,
                mcpConfigProjectId,
                expectedConnectors: validExpectedConnectors,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                parentSessionId,
                forkedFromMessageId,
                createdByAccountId,
                createdByDisplayName,
                axStep,
                bootstrapFiles,
                initialPrompt,
                exitAfterFirstTurn,
            });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    // Bookkeeping only, and strictly after the session exists. A failure here
                    // must never downgrade a live session into a failed spawn, so both the
                    // synchronous throw and a late rejection are swallowed.
                    try {
                        await this.linkSpawnedSessionHandler?.({ sessionId: result.sessionId, directory });
                    } catch (error) {
                        logger.debug(`[API MACHINE] Project link for ${result.sessionId} failed: ${error}`);
                    }
                    return {
                        type: 'success',
                        sessionId: result.sessionId,
                        ...(result.additionalDirectories
                            ? { additionalDirectories: result.additionalDirectories }
                            : {}),
                    };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        this.syncResumeSessionRpcRegistration();
        this.syncRecoverSessionRpcRegistration();

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId, source, reason, mode } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const context: StopSessionContext = {
                ...(typeof source === 'string' ? { source } : {}),
                ...(typeof reason === 'string' ? { reason } : {}),
                ...(mode === 'force' || mode === 'if-idle' ? { mode } : {}),
            };
            const effectiveMode = resolveStopSessionMode(context);
            logger.debug(`[API MACHINE] Stop session request ${sessionId}`, {
                source: context.source,
                reason: context.reason,
                mode: effectiveMode,
            });

            const result = stopSession(sessionId, context);

            if (result.stopped) {
                logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
                return { message: 'Session stopped', stopped: true };
            }

            // Duplicate or untracked stop: safe no-op success so callers can retry
            // idempotently (the process is already gone / never here).
            if (result.reason === 'not-found') {
                logger.debug(`[API MACHINE] Session ${sessionId} not tracked; treating stop as no-op success`);
                return { message: 'Session not tracked', stopped: false, reason: 'not-found' };
            }

            // Guard refused an if-idle stop because the session is active. Return a
            // structured refusal (not an error) so a policy caller can back off and
            // re-evaluate later instead of retrying immediately or escalating.
            logger.debug(
                `[API MACHINE] Refused idle stop for active session ${sessionId} (guard=${result.guard})`,
            );
            return {
                message: 'Session active; stop skipped',
                stopped: false,
                reason: 'active',
                guard: result.guard,
                activity: result.activity,
            };
        });

        // Read opencode config models from ~/.config/opencode/opencode.json so
        // the desktop can populate the model picker before the first opencode
        // session runs. Returns { models: [] } when the file is missing or
        // unparseable — the desktop falls back to session-reported models.
        this.rpcHandlerManager.registerHandler('read-opencode-models', async () => {
            const configPath = `${homedir()}/.config/opencode/opencode.json`;
            try {
                const raw = await readFile(configPath, 'utf-8');
                const config = JSON.parse(raw) as unknown;
                if (!config || typeof config !== 'object') return { models: [] };
                const providers = (config as Record<string, unknown>).provider;
                if (!providers || typeof providers !== 'object') return { models: [] };
                const models: Array<{ code: string; value: string }> = [];
                for (const [provKey, provData] of Object.entries(providers as Record<string, unknown>)) {
                    if (!provData || typeof provData !== 'object') continue;
                    const provModels = (provData as Record<string, unknown>).models;
                    if (!provModels || typeof provModels !== 'object') continue;
                    for (const [modelKey, modelData] of Object.entries(provModels as Record<string, unknown>)) {
                        if (!modelData || typeof modelData !== 'object') continue;
                        const code = `${provKey}/${modelKey}`;
                        const name = (modelData as Record<string, unknown>).name;
                        models.push({ code, value: typeof name === 'string' && name ? name : code });
                    }
                }
                return { models };
            } catch {
                return { models: [] };
            }
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('codex-fork-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const result = await withCodexAppServerClient((client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            return withCodexAppServerClient(async (client) => {
                const { thread } = await client.readThread({
                    threadId: codexThreadId,
                    includeTurns: true,
                });
                return {
                    type: 'success',
                    points: listCodexRewindPoints(thread),
                };
            });
        });

        this.rpcHandlerManager.registerHandler('codex-duplicate-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');
            const cutAfterItemId = requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');

            try {
                return await withCodexAppServerClient((client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
                }));
            } catch (error) {
                if (error instanceof CodexForkRewindPointNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source Codex thread — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Browser bridge setup, driven by buttons on the machine screen so a
        // terminal-only Linux box needs no SSH session. See
        // specs/browser-setup-gui/.
        this.rpcHandlerManager.registerHandler('browser-setup:status', async () => {
            const chrome = await detectChrome();
            const state = await readDaemonState();
            const controlPort = state?.httpPort;
            const status = (controlPort && state?.controlSecret)
                ? await fetchBrowserStatus(controlPort, state.controlSecret)
                : null;
            return {
                chromeInstalled: Boolean(chrome),
                chromePath: chrome?.path ?? null,
                chromeVersion: chrome?.version ?? null,
                canSudo: chrome ? false : await canSudoWithoutPassword(),
                connections: status?.connections ?? [],
                daemonRunning: Boolean(controlPort),
            };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:install-chrome', async () => {
            const chrome = await detectChrome();
            const plan = planChromeInstall({
                chromePath: chrome?.path ?? null,
                canSudo: chrome ? true : await canSudoWithoutPassword(),
            });
            if (plan.action !== 'run') {
                // 'manual' deliberately reaches the UI as a non-success: no
                // root means no install, and saying otherwise would leave the
                // user hunting for a Chrome that was never placed.
                return plan;
            }
            const result = await runShell(plan.command);
            const installed = await detectChrome();
            return {
                action: 'run',
                command: plan.command,
                ok: Boolean(installed),
                chromePath: installed?.path ?? null,
                stderr: result.ok ? undefined : result.output,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:launch', async (params: any) => {
            const profile = typeof params?.profile === 'string' && params.profile.trim()
                ? params.profile.trim()
                : 'default';
            const chrome = await detectChrome();
            if (!chrome) {
                throw new Error('Chrome이 설치되어 있지 않습니다. 먼저 설치를 실행하세요.');
            }
            const userDataDir = resolveProfileUserDataDir(
                join(configuration.happyHomeDir, 'chrome-profiles'),
                profile,
            );
            const cdpPort = await pickFreeCdpPort();
            if (cdpPort === null) {
                throw new Error('사용 가능한 CDP 포트를 찾지 못했습니다.');
            }

            const wantsViewer = params?.viewer === true;
            // Ensures the viewer stack before deciding headless/display —
            // "launch under the viewer" must be the Chrome the user actually
            // sees, not a second headless instance running blind.
            const viewerState = wantsViewer
                ? await this.startViewerStack({ callerWillLaunchBrowser: true })
                : null;
            const chosen = resolveChromeDisplay({
                wantsViewer,
                viewerDisplay: viewerState?.display ?? null,
                daemonDisplayEnv: process.env.DISPLAY,
            });
            if (chosen.headless === null) {
                throw new Error('원격 화면이 아직 준비되지 않았습니다.');
            }
            const headless = chosen.headless;
            const env = chosen.display ? { DISPLAY: chosen.display } : undefined;
            let launched = launchChrome(chrome.path, {
                userDataDir,
                cdpPort,
                headless,
                display: chosen.display ?? undefined,
            }, env);
            let { pid } = launched;
            let ready = await waitForCdp(cdpPort, 15_000);
            let sandbox = true;
            if (!ready) {
                // Kernels that block unprivileged user namespaces kill Chrome's
                // zygote before it opens the CDP port, so "launched" is not
                // "running". Retry once without the sandbox and report the
                // downgrade rather than leaving a browser that never answers.
                sandbox = false;
                launched.cdpPipe.close();
                launched = launchChrome(chrome.path, {
                    userDataDir,
                    cdpPort,
                    headless,
                    display: chosen.display ?? undefined,
                    noSandbox: true,
                }, env);
                ({ pid } = launched);
                ready = await waitForCdp(cdpPort, 15_000);
            }
            if (ready) this.rememberBrowserCdpPipe(cdpPort, launched.cdpPipe);
            else launched.cdpPipe.close();
            const viewer = viewerState
                ? {
                    ...viewerState,
                    ...summariseViewerBrowser({ chromeInstalled: true, cdpPort: ready ? cdpPort : null }),
                }
                : null;
            return { profile, cdpPort, userDataDir, pid, headless, ready, sandbox, viewer };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:pair', async (params: any) => {
            const cdpPort = Number(params?.cdpPort);
            if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
                throw new Error('cdpPort is required');
            }
            return this.pairBrowser(cdpPort, params?.debuggerTier !== false);
        });

        // Remote browser screen (noVNC) — lets the user open any site and log
        // in by hand, 2FA and captcha included, with no SSH tunnel. The
        // bridge's own click/fill are ref-based and cannot drive a captcha,
        // which is why this exists. See specs/browser-remote-login/.
        this.rpcHandlerManager.registerHandler('browser-viewer:status', async () => {
            const missing = await detectMissingViewerTools();
            return {
                installed: missing.length === 0,
                missing,
                canSudo: missing.length === 0 ? false : await canSudoWithoutPassword(),
                running: this.viewer !== null,
                webPort: this.viewer?.webPort ?? null,
                display: this.viewer?.display ?? null,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:install', async () => {
            const missing = await detectMissingViewerTools();
            const plan = planViewerInstall({
                missing,
                canSudo: missing.length === 0 ? true : await canSudoWithoutPassword(),
            });
            if (plan.action !== 'run') {
                // 'manual' reaches the UI as a non-success on purpose: these
                // are system packages, so without root nothing was installed.
                return plan;
            }
            const result = await runShell(plan.command);
            const stillMissing = await detectMissingViewerTools();
            return {
                action: 'run',
                command: plan.command,
                ok: stillMissing.length === 0,
                missing: stillMissing,
                stderr: result.ok ? undefined : result.output,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:start', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) return this.startBrokerViewer(viewerKey);
            return this.startIsolatedViewerStack(viewerKey);
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:lookup', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) {
                const response = await this.browserSessionBroker.request({ op: 'lookup', viewerKey });
                if (!response.ok) throw new Error(response.code);
                return response.lease;
            }
            const lease = this.isolatedViewerLeases.get(viewerKey)
                ?? await this.isolatedViewerRegistry.get(viewerKey);
            if (!lease) return null;
            const ready = await isViewerServing(lease.webPort);
            const touched = { ...lease, lastUsedAt: Date.now() };
            if (ready) {
                this.isolatedViewerLeases.set(viewerKey, touched);
                await this.isolatedViewerRegistry.set(touched);
            }
            return { ...touched, ready };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:stop', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) {
                const response = await this.browserSessionBroker.request({ op: 'stop', viewerKey });
                if (!response.ok) throw new Error(response.code);
                return { viewerKey, stopped: response.stopped === true };
            }
            return this.withIsolatedViewerMutation(async () => {
                const lease = this.isolatedViewerLeases.get(viewerKey)
                    ?? await this.isolatedViewerRegistry.get(viewerKey);
                if (!lease) return { viewerKey, stopped: false };
                await this.stopIsolatedViewerProcesses(lease);
                if (lease.cdpPort !== null) {
                    this.browserCdpPipes.get(lease.cdpPort)?.close();
                    this.browserCdpPipes.delete(lease.cdpPort);
                }
                this.isolatedViewerLeases.delete(viewerKey);
                await this.isolatedViewerRegistry.delete(viewerKey);
                return { viewerKey, stopped: true };
            });
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:migrate-legacy', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (!this.browserSessionBroker) throw new Error('browser-broker-required');
            const response = await this.browserSessionBroker.request({ op: 'migrate-legacy', viewerKey });
            if (!response.ok) throw new Error(response.code);
            return { viewerKey, migrated: response.migrated === true };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        // Read the daemon-uid's Claude Code rate-window quota. Returns a
        // structured ClaudeCodeUsage envelope; failures (missing CLI, not
        // logged in, /usage parse drift) are encoded in the response rather
        // than thrown so the web-ui can render per-machine rows without
        // toast bombing. See specs/20260618-machine-cli-usage-quota/.
        this.rpcHandlerManager.registerHandler('claude-code-usage:read', async () => {
            return readClaudeCodeUsage();
        });

        // Register port allocation handler — sticky per (user, project)
        // composite key in 30000-40000 since specs/preview-cross-user-
        // isolation/ Phase 4. Both userId and projectId are required.
        this.rpcHandlerManager.registerHandler('allocate-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const result = await portRegistry.allocate(userId, projectId);
            logger.debug(`[API MACHINE] allocate-port ${userId}:${projectId} -> ${result.port} (reused=${result.reused})`);
            return result;
        });

        // Register read-only port lookup handler. Used by web-ui preflight
        // (specs/preview-server-lifecycle/ Phase 1) to check whether a (user,
        // project) already has a sticky port assigned before deciding to
        // start a new server. Falls back to the legacy bare-projectId entry
        // so daemons that have not yet seen the new composite key still
        // resolve the right port for the original owner.
        this.rpcHandlerManager.registerHandler('get-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const data = await portRegistry.readAll();
            const entry = data[`${userId}:${projectId}`] ?? data[projectId];
            const port = entry ? entry.port : null;
            logger.debug(`[API MACHINE] get-port ${userId}:${projectId} -> ${port}`);
            return { port };
        });

        // Register port release handler (e.g., on project deletion). userId
        // is required to scope the release to the correct (user, project).
        this.rpcHandlerManager.registerHandler('release-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const released = await portRegistry.release(userId, projectId);
            logger.debug(`[API MACHINE] release-port ${userId}:${projectId} -> released=${released}`);
            return { released };
        });

        // Register dev-server spawn handler — the web-ui hits this when
        // Phase 12 "direct server start" runs on a remote-machine session.
        // Returns an explicit {type:'success'|'error', ...} envelope so the
        // caller sees the StartServerError code (CWD_NOT_FOUND, ENOENT,
        // ...). See specs/remote-server-start/ Phase 3.
        const spawnedServers = new Map<number, ChildProcess>();
        this.rpcHandlerManager.registerHandler('start-server', async (params: any) => {
            const { command, cwd, env } = params || {};
            if (typeof command !== 'string' || typeof cwd !== 'string') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'command and cwd are required' };
            }
            try {
                const result = await startServerProcess(
                    { command, cwd, env },
                    {
                        fastFailDelayMs: 50,
                        onSpawn: (child) => {
                            if (child.pid) {
                                spawnedServers.set(child.pid, child);
                                child.on('exit', () => spawnedServers.delete(child.pid!));
                            }
                        },
                    },
                );
                logger.debug(`[API MACHINE] start-server spawned pid=${result.pid} cwd=${cwd}`);
                return { type: 'success', pid: result.pid };
            } catch (e) {
                if (e instanceof StartServerError) {
                    logger.debug(`[API MACHINE] start-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] start-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // Companion to `start-server` — signals the child with SIGTERM,
        // falling back to SIGKILL if it does not exit gracefully. Envelope
        // matches start-server: success or {code,message} error.
        // See specs/preview-server-lifecycle/ Phase 5a.
        this.rpcHandlerManager.registerHandler('stop-server', async (params: any) => {
            const { pid } = params || {};
            if (typeof pid !== 'number') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'pid is required' };
            }
            try {
                const result = await stopServerProcess({ pid });
                logger.debug(`[API MACHINE] stop-server pid=${pid} signal=${result.sentSignal}`);
                return { type: 'success', sentSignal: result.sentSignal };
            } catch (e) {
                if (e instanceof StopServerError) {
                    logger.debug(`[API MACHINE] stop-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] stop-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // NOTE: proxy-http is intentionally wired as a plain socket event
        // (see connect() — 'proxy-http-request') instead of an encrypted
        // RpcHandlerManager handler. happy-server's preview relay route
        // terminates iframe requests and needs to forward plaintext bodies
        // — it has no access to the machine encryption key, so the E2EE
        // RPC envelope can't be used. The preview payload is inherently
        // non-sensitive (it's the HTTP request flowing from the iframe,
        // and happy-server already sees it to rewrite HTML).

        // Applied last so it wins over every legacy registration above,
        // regardless of the order those modules ran in. On a BYOS machine
        // `managedHandlers` is null and nothing below executes, so the
        // existing surface is untouched.
        if (this.managedHandlers) {
            applyManagedRpcRestrictions(this.rpcHandlerManager);
            registerManagedRpcHandlers(this.rpcHandlerManager, this.managedHandlers);
        }
    }

    setAutomationKey(key: MachineAutomationKey, persistVersion: (version: number) => void, protocolVersion: number = AUTOMATION_PROTOCOL_VERSION): void {
        this.automationKey = key;
        this.automationProtocolVersion = protocolVersion;
        this.persistAutomationKeyVersion = persistVersion;
    }

    setServerAutomationCache(cache: ServerAutomationCache): void {
        this.serverAutomationCache = cache;
    }

    shouldRunLegacyAutomationScheduler(): boolean {
        return this.automationLegacyFallbackEnabled;
    }

    serverAutomationTransport(): ServerAutomationTransport {
        return {
            claim: (input) => this.socket.emitWithAck('automation-claim', input),
            start: (input) => this.socket.emitWithAck('automation-run-start', input),
            heartbeat: (input) => this.socket.emitWithAck('automation-run-heartbeat', input),
            report: (input) => this.socket.emitWithAck('automation-run-report', input),
        };
    }

    sessionFollowupTransport(): SessionFollowupTransport {
        const normalize = async (request: Promise<{ ok: boolean; value?: unknown; error?: string }>) => {
            const response = await request;
            return response.ok
                ? { ok: true as const, value: response.value }
                : { ok: false as const, error: response.error };
        };
        return {
            sync: (input) => normalize(this.socket.emitWithAck('session-followup-sync', input)),
            claim: (input) => normalize(this.socket.emitWithAck('session-followup-claim', input)),
            evaluate: (input) => normalize(this.socket.emitWithAck('session-followup-evaluate', input)),
            deliver: (input) => normalize(this.socket.emitWithAck('session-followup-deliver', input)),
        };
    }

    /**
     * Idempotent: returns the running stack if one is already up. Shared by
     * the `browser-viewer:start` RPC and `browser-setup:launch`'s `viewer`
     * option, so "launch Chrome under the viewer" never spins up a second,
     * disconnected Xvfb (specs/browser-remote-login/).
     */
    private startViewerStack(
        options: { callerWillLaunchBrowser?: boolean } = {},
    ): Promise<ViewerStackStartResult> {
        const callerWillLaunchBrowser = options.callerWillLaunchBrowser ?? false;
        const inFlight = this.viewerStartInFlight;
        if (inFlight) {
            if (inFlight.callerWillLaunchBrowser === callerWillLaunchBrowser) {
                return inFlight.promise;
            }
            // A profile-launch caller intentionally defers the default Chrome,
            // while a viewer-open caller requires it. Serialize unlike modes,
            // then re-evaluate the live stack with the second caller's policy.
            return inFlight.promise.then(() => this.startViewerStack(options));
        }
        const promise = this.startViewerStackOnce(options);
        this.viewerStartInFlight = { callerWillLaunchBrowser, promise };
        const clear = () => {
            if (this.viewerStartInFlight?.promise === promise) this.viewerStartInFlight = null;
        };
        promise.then(clear, clear);
        return promise;
    }

    private async startViewerStackOnce(
        options: { callerWillLaunchBrowser?: boolean } = {},
    ): Promise<ViewerStackStartResult> {
        const missing = await detectMissingViewerTools();
        if (missing.length > 0) {
            throw new Error(`원격 화면에 필요한 프로그램이 없습니다: ${missing.join(', ')}`);
        }
        // The cache is not evidence: the stack is spawned detached, so it both
        // outlives the daemon and can die under it. Probe before trusting it.
        const cachedAlive = this.viewer ? await isViewerServing(this.viewer.webPort) : false;
        const decision = decideViewerStackAction({
            cached: this.viewer,
            cachedAlive,
            // Scanned whenever the cache is not alive, not just when it is
            // absent — a stale entry must not stop us adopting a stack that
            // is genuinely serving, or we spawn a duplicate beside it.
            adoptable: cachedAlive ? null : await findRunningViewer(),
        });
        if (decision.action === 'reuse' && this.viewer) {
            const browser = await this.ensureViewerBrowser(
                this.viewer.display,
                options.callerWillLaunchBrowser ?? false,
            );
            return { ...this.viewer, ready: true, reused: true, ...browser };
        }
        if (decision.action === 'adopt') {
            // Left behind by a previous daemon. Re-registering it beats
            // spawning a duplicate that leaks ports until none are left.
            const adopted = { display: ':99', vncPort: null, webPort: decision.webPort };
            this.viewer = adopted;
            const browser = await this.ensureViewerBrowser(
                adopted.display,
                options.callerWillLaunchBrowser ?? false,
            );
            return { ...adopted, ready: true, reused: true, ...browser };
        }
        this.viewer = null;

        const display = ':99';
        const vncPort = await pickFreePort([...VIEWER_VNC_PORTS]);
        const webPort = await pickFreePort([...VIEWER_WEB_PORTS]);
        if (vncPort === null || webPort === null) {
            throw new Error('원격 화면에 쓸 포트를 찾지 못했습니다.');
        }
        spawnDetached('Xvfb', buildXvfbArgs({ display, width: 1920, height: 1080 }));
        await delay(1500);
        spawnDetached('x11vnc', buildX11vncArgs({ display, vncPort }));
        await delay(800);
        spawnDetached('websockify', buildWebsockifyArgs({
            webPort, vncPort, webRoot: resolveNovncWebRoot(),
        }));
        const ready = await waitForPort(webPort, 15_000);
        this.viewer = { display, vncPort, webPort };
        const browser = await this.ensureViewerBrowser(display, options.callerWillLaunchBrowser ?? false);
        return { display, vncPort, webPort, ready, reused: false, ...browser };
    }

    private startIsolatedViewerStack(viewerKey: string): Promise<IsolatedViewerStartResult> {
        const inFlight = this.isolatedViewerStarts.get(viewerKey);
        if (inFlight) return inFlight;

        const promise = this.withIsolatedViewerMutation(
            () => this.startIsolatedViewerStackOnce(viewerKey),
        );
        this.isolatedViewerStarts.set(viewerKey, promise);
        const clear = () => {
            if (this.isolatedViewerStarts.get(viewerKey) === promise) {
                this.isolatedViewerStarts.delete(viewerKey);
            }
        };
        promise.then(clear, clear);
        return promise;
    }

    private async startBrokerViewer(viewerKey: string): Promise<{
        viewerKey: string
        webPort: number
        profileDir: string
        ready: true
        browserReady: true
        bridgeReady: true
        isolation: 'container'
    }> {
        if (!this.browserSessionBroker) throw new Error('browser broker is not configured');
        const authToken = await readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile, {
            migrateFrom: configuration.legacyBrowserBridgeTokenFile,
        });
        const response = await this.browserSessionBroker.request({
            op: 'ensure',
            viewerKey,
            bridgeToken: deriveBrowserViewerBridgeToken(authToken, viewerKey),
        });
        if (!response.ok) throw new Error(response.code);
        if (!response.lease || response.lease.viewerKey !== viewerKey || !response.lease.ready) {
            throw new Error('browser-broker-owner-mismatch');
        }
        return {
            viewerKey,
            webPort: response.lease.webPort,
            profileDir: response.lease.profileVolume,
            ready: true,
            browserReady: true,
            bridgeReady: true,
            isolation: 'container',
        };
    }

    private touchBrokerViewerPort(webPort: number): void {
        if (!this.browserSessionBroker || !Number.isInteger(webPort)) return;
        const now = Date.now();
        const touchedAt = this.brokerRelayTouchedAt.get(webPort);
        if (touchedAt !== undefined && now - touchedAt < BROKER_ACTIVITY_TOUCH_INTERVAL_MS) return;
        this.brokerRelayTouchedAt.set(webPort, now);
        void this.browserSessionBroker.request({ op: 'touch-port', webPort }).then((response) => {
            if (!response.ok) logger.debug(`[API MACHINE] Browser relay activity touch failed: ${response.code}`);
        }).catch((error) => {
            logger.debug(`[API MACHINE] Browser relay activity touch failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    private withIsolatedViewerMutation<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.isolatedViewerMutation.then(operation, operation);
        this.isolatedViewerMutation = run.then(() => undefined, () => undefined);
        return run;
    }

    private async startIsolatedViewerStackOnce(viewerKey: string): Promise<IsolatedViewerStartResult> {
        const missing = await detectMissingViewerTools();
        if (missing.length > 0) {
            throw new Error(`원격 화면에 필요한 프로그램이 없습니다: ${missing.join(', ')}`);
        }

        const persisted = this.isolatedViewerLeases.get(viewerKey)
            ?? await this.isolatedViewerRegistry.get(viewerKey);
        if (persisted && await isViewerServing(persisted.webPort)) {
            this.isolatedViewerLeases.set(viewerKey, persisted);
            const browser = await this.ensureViewerBrowser(
                persisted.display,
                false,
                persisted.profileDir,
                viewerKey,
            );
            const next = {
                ...persisted,
                cdpPort: browser.browserReady ? browser.cdpPort : null,
                lastUsedAt: Date.now(),
            };
            await this.isolatedViewerRegistry.set(next);
            this.isolatedViewerLeases.set(viewerKey, next);
            return {
                viewerKey,
                slot: next.slot,
                display: next.display,
                vncPort: next.vncPort,
                webPort: next.webPort,
                profileDir: next.profileDir,
                ready: true,
                reused: true,
                ...browser,
            };
        }

        const records = await this.isolatedViewerRegistry.list();
        const occupiedSlots = new Set<number>();
        for (const record of records) {
            if (record.viewerKey === viewerKey) continue;
            if (await isViewerServing(record.webPort)) occupiedSlots.add(record.slot);
            else await this.isolatedViewerRegistry.delete(record.viewerKey);
        }
        for (const slot of VIEWER_SLOTS) {
            if (occupiedSlots.has(slot.slot)) continue;
            const ownedByCurrent = persisted?.slot === slot.slot;
            if (!ownedByCurrent && await isViewerServing(slot.webPort)) {
                occupiedSlots.add(slot.slot);
            }
        }

        const persistedSlot = persisted
            ? VIEWER_SLOTS.find((slot) => slot.slot === persisted.slot) ?? null
            : null;
        const slot = persistedSlot && !occupiedSlots.has(persistedSlot.slot)
            ? persistedSlot
            : selectViewerSlot(occupiedSlots);
        if (!slot) throw new Error('viewer-capacity-exhausted');

        const profileDir = resolveViewerProfileDir(configuration.happyHomeDir, viewerKey);
        mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        const xvfb = spawnDetached('Xvfb', buildXvfbArgs({ display: slot.display, width: 1920, height: 1080 }));
        await delay(1500);
        const x11vnc = spawnDetached('x11vnc', buildX11vncArgs({ display: slot.display, vncPort: slot.vncPort }));
        await delay(800);
        const websockify = spawnDetached('websockify', buildWebsockifyArgs({
            webPort: slot.webPort,
            vncPort: slot.vncPort,
            webRoot: resolveNovncWebRoot(),
        }));
        const ready = await waitForPort(slot.webPort, 15_000);
        const browser = await this.ensureViewerBrowser(slot.display, false, profileDir, viewerKey);
        const lease: BrowserViewerLeaseRecord = {
            viewerKey,
            slot: slot.slot,
            display: slot.display,
            vncPort: slot.vncPort,
            webPort: slot.webPort,
            cdpPort: browser.browserReady ? browser.cdpPort : null,
            profileDir,
            lastUsedAt: Date.now(),
            processIds: {
                ...(xvfb.pid ? { xvfb: xvfb.pid } : {}),
                ...(x11vnc.pid ? { x11vnc: x11vnc.pid } : {}),
                ...(websockify.pid ? { websockify: websockify.pid } : {}),
            },
        };
        await this.isolatedViewerRegistry.set(lease);
        this.isolatedViewerLeases.set(viewerKey, lease);
        return {
            viewerKey,
            slot: slot.slot,
            display: slot.display,
            vncPort: slot.vncPort,
            webPort: slot.webPort,
            profileDir,
            ready,
            reused: false,
            ...browser,
        };
    }

    private async stopIsolatedViewerProcesses(lease: BrowserViewerLeaseRecord): Promise<void> {
        for (const [kind, pid] of Object.entries(lease.processIds ?? {}) as Array<[
            'xvfb' | 'x11vnc' | 'websockify',
            number,
        ]>) {
            if (!pid) continue;
            try {
                const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
                if (!viewerProcessMatchesLease(kind, cmdline, lease)) continue;
                // Viewer processes are detached process-group leaders. Targeting
                // that exact group avoids touching another user's slot.
                process.kill(-pid, 'SIGTERM');
            } catch {
                // Already exited is an idempotent stop success.
            }
        }
    }

    /**
     * Puts a browser on the viewer display, or reuses the one already there.
     *
     * Without this the viewer is a black screen: Xvfb renders nothing on its
     * own, and the "원격 브라우저 화면 열기" flow never called the launch
     * path. Reuse is probed rather than cached so a browser that outlived the
     * daemon is adopted instead of a second Chrome being stacked onto the
     * same display, one per click.
     */
    private async ensureViewerBrowser(
        display: string,
        callerWillLaunchBrowser: boolean,
        profileDir?: string,
        viewerKey?: string,
    ): Promise<ViewerBrowserState> {
        if (decideViewerBrowserAction({ liveCdpPort: null, callerWillLaunchBrowser }).action === 'defer') {
            return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        }
        const chrome = await detectChrome();
        // Reported, never swallowed: a viewer with no Chrome serves a healthy
        // connection to an empty display, which reads as an unexplained black
        // screen (dev, 2026-08-15).
        if (!chrome) return summariseViewerBrowser({ chromeInstalled: false, cdpPort: null });

        const userDataDir = profileDir ?? resolveProfileUserDataDir(
            join(configuration.happyHomeDir, 'chrome-profiles'),
            'default',
        );
        const running = await scanChromeProcesses();
        let liveCdpPort: number | null = null;
        for (const port of CDP_PORT_RANGE) {
            if (!running.some((process) => (
                process.cdpPort === port
                && process.display === display
                && process.userDataDir === userDataDir
            ))) continue;
            if (await isCdpReachable(port)) { liveCdpPort = port; break; }
        }
        const decision = decideViewerBrowserAction({ liveCdpPort, callerWillLaunchBrowser });
        if (decision.action === 'reuse') {
            return {
                ...summariseViewerBrowser({ chromeInstalled: true, cdpPort: decision.cdpPort }),
                ...await this.pairViewerBrowser(decision.cdpPort, viewerKey),
            };
        }

        // The default profile is a Chrome singleton. If a headless or other-
        // display Chrome holds it, launching another one cannot put that
        // logged-in profile on noVNC; fail honestly instead of pairing the
        // invisible process or waiting through two doomed launch attempts.
        if (running.some((process) => process.userDataDir === userDataDir)) {
            return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        }

        const cdpPort = await pickFreeCdpPort();
        if (cdpPort === null) return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        const env = { DISPLAY: display };
        let launched = launchChrome(chrome.path, { userDataDir, cdpPort, headless: false, display }, env);
        let up = await waitForCdp(cdpPort, 15_000);
        if (!up) {
            // Same kernel/namespace fallback the launch RPC uses.
            launched.cdpPipe.close();
            launched = launchChrome(chrome.path, {
                userDataDir,
                cdpPort,
                headless: false,
                display,
                noSandbox: true,
            }, env);
            up = await waitForCdp(cdpPort, 15_000);
        }
        if (up) this.rememberBrowserCdpPipe(cdpPort, launched.cdpPipe);
        else launched.cdpPipe.close();
        const browser = summariseViewerBrowser({ chromeInstalled: true, cdpPort: up ? cdpPort : null });
        if (!browser.browserReady) return browser;
        return { ...browser, ...await this.pairViewerBrowser(cdpPort, viewerKey) };
    }

    /**
     * The shared browser-pairing contract behind both the explicit setup RPC
     * and the noVNC viewer. Keeping the existing runPairing sequence here
     * preserves extension injection, token storage, and debugger-tier checks.
     */
    private async pairBrowser(
        cdpPort: number,
        debuggerTier: boolean,
        pairingId?: string,
        viewerKey?: string,
        forceExtensionReload?: boolean,
    ): Promise<BrowserPairResult> {
        const cdpPipe = this.browserCdpPipes.get(cdpPort);
        const facts = await runPairing({
            cdpPort,
            debuggerTier,
            pairingId,
            forceExtensionReload,
            ...(viewerKey ? { viewerKey } : {}),
            ...(cdpPipe ? { browserCdpRequest: cdpPipe.request.bind(cdpPipe) } : {}),
        });
        const outcome = formatPairOutcome(facts);
        return {
            ok: outcome.ok,
            message: stripAnsi(outcome.text),
            connections: facts.connections,
            freshProfiles: facts.freshProfiles,
            debuggerTier: facts.debuggerTierActual ?? null,
        };
    }

    /** Pairing failure must not hide the login screen used to repair it. */
    private async pairViewerBrowser(cdpPort: number, viewerKey?: string): Promise<ViewerBridgeSummary> {
        try {
            const pairingId = `viewer-${cdpPort}-${randomUUID()}`;
            let result = await this.pairBrowser(cdpPort, true, pairingId, viewerKey, false);
            if (!result.ok) {
                result = await this.pairBrowser(cdpPort, true, pairingId, viewerKey, true);
            }
            return result.ok
                ? { bridgeReady: true }
                : { bridgeReady: false, bridgeMessage: result.message };
        } catch (error) {
            return {
                bridgeReady: false,
                bridgeMessage: error instanceof Error ? error.message : '브라우저 브리지를 연결하지 못했습니다.',
            };
        }
    }

    private rememberBrowserCdpPipe(cdpPort: number, cdpPipe: BrowserCdpPipe): void {
        const previous = this.browserCdpPipes.get(cdpPort);
        if (previous && previous !== cdpPipe) previous.close();
        this.browserCdpPipes.set(cdpPort, cdpPipe);
    }

    private requestServerAutomationSync(): void {
        if (!this.serverAutomationCache || this.serverAutomationSyncInFlight) return;
        const sync = syncServerAutomationDeltas({
            cache: this.serverAutomationCache,
            sync: (request) => this.socket.emitWithAck('automation-sync', request),
            ack: (request) => this.socket.emitWithAck('automation-sync-ack', request),
        }).then((result) => {
            if (result.changed > 0) logger.debug(`[API MACHINE] Applied ${result.changed} automation delta(s)`);
        }).catch((error) => {
            logger.debug(`[API MACHINE] Automation sync failed: ${error}`);
        }).finally(() => {
            this.serverAutomationSyncInFlight = null;
        });
        this.serverAutomationSyncInFlight = sync;
    }

    private async registerAutomationKey(): Promise<void> {
        this.automationLegacyFallbackEnabled = false;
        const key = this.automationKey;
        if (!key) return;
        const answer = await this.socket.emitWithAck('automation-key-register', {
            expectedKeyVersion: key.registeredKeyVersion,
            publicKey: Buffer.from(key.publicKey).toString('base64'),
            protocolVersion: this.automationProtocolVersion,
        });
        if (!answer.ok || !answer.value || !Number.isSafeInteger(answer.value.keyVersion)) {
            if (answer.error === 'feature-disabled') {
                this.automationServerKeyVersion = null;
                this.automationLegacyFallbackEnabled = true;
            }
            logger.debug(`[API MACHINE] Automation key registration unavailable: ${answer.error ?? 'invalid-response'}`);
            return;
        }
        const keyVersion = answer.value.keyVersion;
        if (keyVersion !== key.registeredKeyVersion) {
            this.persistAutomationKeyVersion?.(keyVersion);
            this.automationKey = { ...key, registeredKeyVersion: keyVersion };
        }
        this.automationServerKeyVersion = keyVersion;
        this.requestServerAutomationSync();
        await this.updateMachineMetadata((metadata) => ({
            ...(metadata || {} as any),
            automationSupport: {
                rpcAvailable: this.automationRpcAvailable,
                serverBacked: true,
                keyVersion,
                sessionFollowup: true,
                protocolVersion: this.automationProtocolVersion,
            },
        }));
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const {
                        sessionId,
                        model,
                        permissionMode,
                        environmentVariables,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors,
                    } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }
                    if (
                        environmentVariables !== undefined
                        && (
                            environmentVariables === null
                            || typeof environmentVariables !== 'object'
                            || Array.isArray(environmentVariables)
                            || Object.values(environmentVariables).some((value) => typeof value !== 'string')
                        )
                    ) {
                        throw new Error('Environment variables must contain string values only');
                    }
                    if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                        throw new Error('MCP caller grant envelope must be a string');
                    }
                    if (mcpConfigProjectId !== undefined && typeof mcpConfigProjectId !== 'string') {
                        throw new Error('MCP config project ID must be a string');
                    }
                    const validExpectedConnectors = readExpectedConnectors(expectedConnectors);

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, {
                        model,
                        permissionMode,
                        environmentVariables,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors: validExpectedConnectors,
                    });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            return result;
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    private syncRecoverSessionRpcRegistration(): void {
        const method = 'recover-happy-session';

        if (this.recoverSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const {
                        sessionId,
                        initialPrompt,
                        initialPromptLocalId,
                        appendSystemPrompt,
                        saycodeSystemPromptEnabled,
                        saycodePromptBlocks,
                        environmentVariables,
                        model,
                        permissionMode,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors,
                    } = params || {};
                    // Sanitize rather than throw: a preference must never abort a
                    // recovery. Non-boolean entries are dropped and a non-object value
                    // degrades to undefined (legacy master inheritance), mirroring
                    // MessageMetaSchema's catch(undefined) on the wire.
                    const sanitizedSaycodePromptBlocks = (() => {
                        if (
                            typeof saycodePromptBlocks !== 'object'
                            || saycodePromptBlocks === null
                            || Array.isArray(saycodePromptBlocks)
                        ) return undefined;
                        const blocks = Object.fromEntries(
                            Object.entries(saycodePromptBlocks as Record<string, unknown>)
                                .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
                        );
                        return Object.keys(blocks).length > 0 ? blocks : undefined;
                    })();

                    if (typeof sessionId !== 'string' || !sessionId.trim()) {
                        throw new Error('Session ID is required');
                    }
                    if (typeof initialPrompt !== 'string' || !initialPrompt.trim()) {
                        throw new Error('Initial prompt must be a non-empty string');
                    }
                    if (
                        initialPromptLocalId !== undefined
                        && (typeof initialPromptLocalId !== 'string' || !initialPromptLocalId.trim())
                    ) {
                        throw new Error('Initial prompt local ID must be a non-empty string');
                    }
                    if (
                        appendSystemPrompt !== undefined
                        && (typeof appendSystemPrompt !== 'string' || appendSystemPrompt.trim().length === 0)
                    ) {
                        throw new Error('Append system prompt must be a non-empty string');
                    }
                    if (
                        saycodeSystemPromptEnabled !== undefined
                        && typeof saycodeSystemPromptEnabled !== 'boolean'
                    ) {
                        throw new Error('Saycode system prompt policy must be a boolean');
                    }
                    if (
                        environmentVariables !== undefined
                        && (
                            environmentVariables === null
                            || typeof environmentVariables !== 'object'
                            || Array.isArray(environmentVariables)
                            || Object.values(environmentVariables).some((value) => typeof value !== 'string')
                        )
                    ) {
                        throw new Error('Environment variables must contain string values only');
                    }
                    if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                        throw new Error('MCP caller grant envelope must be a string');
                    }
                    if (
                        mcpConfigProjectId !== undefined
                        && (typeof mcpConfigProjectId !== 'string' || !mcpConfigProjectId.trim())
                    ) {
                        throw new Error('MCP config project id must be a non-empty string');
                    }

                    const handler = this.recoverSessionHandler;
                    if (!handler) {
                        throw new Error('Recover session handler not available');
                    }
                    return handler(sessionId, {
                        initialPrompt,
                        initialPromptLocalId,
                        appendSystemPrompt,
                        saycodeSystemPromptEnabled,
                        saycodePromptBlocks: sanitizedSaycodePromptBlocks,
                        environmentVariables,
                        model,
                        permissionMode,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors: readExpectedConnectors(expectedConnectors),
                    });
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Takes up a renewed credential — by **re-authenticating**, not by
     * relabelling.
     *
     * Two things made the obvious version wrong.
     *
     * The handshake is what presents the credential, and it reads `socket.auth`
     * at connect time, so changing only the field the constructor was given
     * left every reconnect presenting the expired token: the connection alive
     * today keeps working, and the first network flap ends the runtime in a way
     * that reads as a network fault and never resolves.
     *
     * And the live connection is **not** fine as it is. The server re-reads the
     * grant on every event against the token the handshake carried, and a
     * renewal supersedes the previous grant the moment it is issued — so a
     * connection still presenting the old bearer begins being refused
     * immediately, and is dropped by the server's own revalidation shortly
     * after. An earlier version of this comment claimed a live socket did not
     * need the new token; that was wrong, and this is the correction.
     *
     * So the connection is dropped and the reconnect path brings it back
     * authenticated with the new bearer, re-registering its RPC methods as any
     * reconnect does. A few seconds of connection is the cost; the alternative
     * is a runtime that looks connected while every request it makes is
     * refused.
     */
    replaceToken(token: string): void {
        if (token.trim() === '') throw new Error('a machine client cannot present an empty token');
        if (token === this.token) return;
        this.token = token;
        if (!this.socket) return;
        this.socket.auth = { ...(this.socket.auth as Record<string, unknown>), token };
        // Dropped, not closed for good: `disconnect` runs the reconnect path,
        // which dials again with the auth just replaced.
        if (this.socket.connected) this.socket.disconnect();
    }

    /**
     * Stops presenting a credential that is no longer valid, and stops working.
     *
     * Called when the credential expired and no renewal replaced it. The socket
     * is closed and reconnection is not attempted: a runtime that kept retrying
     * with a dead credential would look like a connectivity failure to
     * everybody, while the real answer — this runtime is no longer authorised —
     * is one the parent already knows.
     */
    stopForExpiredCredential(): void {
        logger.debug('[API MACHINE] Managed credential expired; closing the machine socket');
        /*
         * Set **before** closing, and it outlives the close.
         *
         * Closing fires `disconnect`, and the disconnect handler is what starts
         * the reconnect loop — so without a stop that survives that event the
         * runtime immediately begins retrying with the credential that just
         * expired. `startSmartReconnect` checks this flag, which is why it is a
         * field rather than a local decision here.
         */
        this.credentialStopped = true;
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        // The field is non-nullable and every other path assumes a socket
        // exists; closing is what stops the traffic, and `disconnected` is what
        // the rest of this class already checks.
        this.socket?.close();
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));
            void this.registerAutomationKey().catch((error) => {
                logger.debug(`[API MACHINE] Failed to register automation key: ${error}`);
            });

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration();
            this.startKeepAlive();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            // Tear down any live preview WebSocket tunnels — the relay path is
            // dead once the daemon socket drops, so leave no orphan TCP sockets.
            this.previewWsProxy?.closeAll();
            // specs/remote-terminal/ Phase 2 — relay path is broken once
            // the socket drops, and the server's session map entry now
            // points at a dead socket. Kill local PTYs so no orphans
            // outlive the daemon's connection. The 30s grace timer (Q4)
            // is deferred to a future remote-terminal-detach-attach spec
            // since it requires server+daemon coordinated state for any
            // real reattach value (Phase 5 review).
            const killed = killAllDaemonTerminalSessions();
            if (killed > 0) {
                logger.debug(`[API MACHINE] Killed ${killed} terminal session(s) on disconnect`);
            }
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', createRpcRequestListener({
            handleRequest: (data) => this.rpcHandlerManager.handleRequest(data),
            logger: (message) => logger.debug(`[API MACHINE] ${message}`),
            onRequest: (data) => logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data),
        }));

        // Plain-text preview proxy channel — happy-server relays iframe HTTP
        // requests here without encryption because it needs to inspect/rewrite
        // response bodies (HTML path rewriting) and has no access to the
        // machine encryption key anyway. Independent of the rpc-request
        // pipeline above.
        this.socket.on(
            'proxy-http-request',
            async (params: any, ack: (response: any) => void) => {
                try {
                    const result = await proxyHttp({
                        port: params?.port,
                        method: params?.method,
                        path: params?.path,
                        headers: params?.headers ?? {},
                        bodyB64: params?.bodyB64 ?? null,
                    });
                    logger.debug(
                        `[API MACHINE] proxy-http-request ${params?.method} ${params?.path} -> ${result.status}${result.truncated ? ' (truncated)' : ''}`,
                    );
                    ack({ type: 'success', ...result });
                } catch (e) {
                    if (e instanceof PreviewProxyError) {
                        logger.debug(`[API MACHINE] proxy-http-request failed: ${e.code} ${e.message}`);
                        ack({ type: 'error', code: e.code, message: e.message });
                        return;
                    }
                    const message = e instanceof Error ? e.message : String(e);
                    logger.debug(`[API MACHINE] proxy-http-request internal error: ${message}`);
                    ack({ type: 'error', code: 'INTERNAL', message });
                }
            },
        );

        // Preview WebSocket relay — raw byte tunnel for upgrades (noVNC /
        // websockify, ws, HMR). Bytes flow verbatim so the upstream performs the
        // actual WS handshake with the browser end-to-end. See previewWsProxy.ts.
        this.previewWsProxy = new PreviewWsProxy(
            { emit: (event: any, payload: any) => this.socket.emit(event, payload) },
            {
                logger: { debug: (msg: string) => logger.debug(msg) },
                onActivity: (port) => this.touchBrokerViewerPort(port),
            },
        );
        // Not attached on a managed runtime: the preview WebSocket proxy reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('proxy-ws-open', async (params, ack) => {
            ack(await this.previewWsProxy!.open(params));
        });
        this.socket.on('proxy-ws-data', (payload) => {
            this.previewWsProxy?.data(payload);
        });
        this.socket.on('proxy-ws-close', (payload) => {
            this.previewWsProxy?.close(payload?.tunnelId);
        });

        // specs/remote-terminal/ Phase 2 — interactive PTY relay.
        //
        // happy-server has already gated this on userId-owns-machineId
        // (terminalRelayHandler.ts ACL) so by the time `terminal-open-fwd`
        // arrives the daemon trusts the request. The `params` blob is
        // E2EE-encrypted by the originating client with the same key the
        // rpc-call pipeline uses; we decrypt to extract cols/rows/cwd/etc.
        // PTY stdout is encrypted on this side before being forwarded as
        // `terminal-frame`, so happy-server never sees plaintext.
        const machineKey = this.machine.encryptionKey;
        const machineVariant = this.machine.encryptionVariant;
        const machineId = this.machine.id;
        // Not attached on a managed runtime: the forwarded terminal opener reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('terminal-open-fwd', async (msg, ack) => {
            try {
                const { sessionId, params } = msg || {};
                if (!sessionId || typeof sessionId !== 'string') {
                    ack({ ok: false, error: 'sessionId is required' });
                    return;
                }
                // aplus-dev-studio specs/trial-auto-onboarding-budget D6 — trial
                // machines refuse shells outright; the daemon is the only layer
                // that can, because the trial user owns this daemon.
                if (resolveMachineLockdownPolicy(process.env).remoteTerminalDisabled) {
                    logger.debug('[API MACHINE] terminal-open-fwd refused: remote terminal disabled by machine policy');
                    ack({ ok: false, error: REMOTE_TERMINAL_DISABLED_ERROR });
                    return;
                }
                let opts: any = null;
                if (params && typeof params === 'string') {
                    try {
                        opts = decrypt(machineKey, machineVariant, decodeBase64(params));
                    } catch (e) {
                        logger.debug(`[API MACHINE] terminal-open-fwd decrypt failed: ${(e as Error).message}`);
                        ack({ ok: false, error: 'Failed to decrypt open params' });
                        return;
                    }
                }
                const auditUserId = typeof opts?.userId === 'string' ? opts.userId : 'remote-client';
                // specs/remote-terminal-cwd-fallback/ — never let
                // pty.spawn() chdir into a path that may not exist on
                // this daemon. decideTerminalCwd validates, auto-mkdirs
                // when safe, and falls back to homedir otherwise so the
                // user always gets a working shell instead of node-pty's
                // raw `chdir(2) failed.: No such file or directory`.
                const cwdDecision = decideTerminalCwd({
                    requested: typeof opts?.cwd === 'string' ? opts.cwd : undefined,
                    allowedRoot: this.allowedRoot,
                    homedir: homedir(),
                    fsExists: existsSync,
                    fsMkdir: (path) => mkdirSync(path, { recursive: true }),
                    validate: validatePath,
                });
                let pty: ReturnType<typeof createPtySession>;
                try {
                    pty = createPtySession({
                        userId: auditUserId,
                        shell: typeof opts?.shell === 'string' ? opts.shell : undefined,
                        args: Array.isArray(opts?.args) ? opts.args : undefined,
                        cwd: cwdDecision.cwd,
                        env: opts?.env && typeof opts.env === 'object' ? opts.env : undefined,
                        cols: Number.isInteger(opts?.cols) ? opts.cols : undefined,
                        rows: Number.isInteger(opts?.rows) ? opts.rows : undefined,
                    });
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    logger.debug(`[API MACHINE] terminal-open-fwd spawn failed: ${message}`);
                    ack({ ok: false, error: message });
                    return;
                }
                const entry = addDaemonTerminalSession(sessionId, pty, {
                    userId: auditUserId,
                    machineId,
                });
                // Emit the fallback banner BEFORE registering pty.onData
                // so the dim ANSI notice always lands ahead of the
                // shell's first prompt chunk in the terminal-frame
                // stream. Encrypt with the same machine key the regular
                // frames use; happy-server forwards untouched.
                if (cwdDecision.fallback) {
                    const banner = formatCwdFallbackBanner(cwdDecision);
                    if (banner) {
                        try {
                            const data = encodeBase64(encrypt(machineKey, machineVariant, banner));
                            this.socket.emit('terminal-frame', { sessionId, data });
                            recordBytesOut(sessionId, banner.length);
                        } catch (e) {
                            logger.debug(`[API MACHINE] terminal-open-fwd banner encrypt failed: ${(e as Error).message}`);
                        }
                    }
                    logger.debug(
                        `[REMOTE-TERMINAL] cwd-fallback session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `requested=${cwdDecision.fallback.requested} fallback=${cwdDecision.cwd} reason=${cwdDecision.fallback.reason}` +
                        (cwdDecision.fallback.error ? ` error=${JSON.stringify(cwdDecision.fallback.error)}` : ''),
                    );
                }
                // Coalescing spec: specs/platform-performance-roadmap D1 —
                // every OS-read chunk would otherwise be its own
                // encrypt+emit+relay+decrypt round trip; an output firehose
                // (yes, find /) turns into a per-chunk message storm.
                const outputCoalescer = createTerminalOutputCoalescer({
                    sessionId,
                    emit: (chunk) => {
                        try {
                            const data = encodeBase64(encrypt(machineKey, machineVariant, chunk));
                            this.socket.emit('terminal-frame', { sessionId, data });
                        } catch (e) {
                            logger.debug(`[API MACHINE] terminal-frame encrypt failed: ${(e as Error).message}`);
                        }
                    },
                });
                pty.onData((chunk) => {
                    recordBytesOut(sessionId, chunk.length);
                    outputCoalescer.push(chunk);
                });
                pty.onExit((code, signal) => {
                    // The process is gone: ship whatever output is still
                    // buffered before the close frame, so the client's last
                    // visible output isn't silently dropped.
                    outputCoalescer.flush();
                    outputCoalescer.dispose();
                    this.socket.emit('terminal-closed', { sessionId, code, signal });
                    const closedAt = Date.now();
                    // Audit log per specs/remote-terminal/ §3 #7. Body is
                    // intentionally NOT recorded — only metadata. logger.debug
                    // writes to the daemon log file without disrupting an
                    // interactive Claude session sharing the terminal.
                    logger.debug(
                        `[REMOTE-TERMINAL] close session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `exitCode=${code} signal=${signal ?? 'null'} bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} ` +
                        `durationMs=${closedAt - entry.openedAt}`,
                    );
                    removeDaemonTerminalSession(sessionId);
                });
                logger.debug(
                    `[REMOTE-TERMINAL] open session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} pid=${pty.pid}`,
                );
                ack({ ok: true, pid: pty.pid });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] terminal-open-fwd internal error: ${message}`);
                ack({ ok: false, error: 'Internal error' });
            }
        });

        // Not attached on a managed runtime: forwarded terminal frames reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('terminal-frame-fwd', (msg) => {
            const { sessionId, data } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry || typeof data !== 'string') return;
            try {
                const chunk = decrypt(machineKey, machineVariant, decodeBase64(data));
                if (typeof chunk === 'string') {
                    entry.session.write(chunk);
                    recordBytesIn(sessionId, chunk.length);
                }
            } catch (e) {
                logger.debug(`[API MACHINE] terminal-frame-fwd decrypt failed: ${(e as Error).message}`);
            }
        });

        this.socket.on('terminal-resize-fwd', (msg) => {
            const { sessionId, cols, rows } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
            entry.session.resize(cols, rows);
        });

        this.socket.on('terminal-close-fwd', (msg) => {
            const { sessionId } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            // terminate(), not kill('SIGTERM'): an interactive shell ignores
            // SIGTERM, so the old close path left a live `/bin/bash -l` and its
            // pty descriptors behind on every single terminal close
            // (specs/remote-terminal-close-leak/). terminate() escalates to
            // SIGKILL and holds its own reference to the child, so removing the
            // entry below cannot cancel the teardown.
            //
            // A graceful exit is already audited by the pty.onExit handler
            // above; only log the abnormal outcomes, so a future recurrence of
            // "close did nothing" is visible in the daemon log instead of
            // silently accumulating shells again.
            void entry.session.terminate().then((outcome) => {
                if (outcome === 'exited' || outcome === 'already-gone') return;
                logger.debug(
                    `[REMOTE-TERMINAL] terminate session=${sessionId} pid=${entry.session.pid} outcome=${outcome}`,
                );
            });
            // onExit handler clears the entry; remove explicitly in case
            // the teardown races with reconnect.
            removeDaemonTerminalSession(sessionId);
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        const publishKeepAlive = () => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
            const activity = this.runtimeActivityProvider?.();
            if (activity) {
                this.updateDaemonState((state) => ({
                    ...state,
                    status: state?.status ?? 'running',
                    activity: {
                        activeSessionCount: Math.max(0, Math.floor(activity.activeSessionCount)),
                        activeAutomationCount: Math.max(0, Math.floor(activity.activeAutomationCount)),
                        reportedAt: Date.now(),
                    },
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to publish runtime activity:', err);
                });
            }
            if (this.automationServerKeyVersion !== null) this.requestServerAutomationSync();

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const newCliVersion = packageJson.version;
            const prevCliVersion = this.lastKnownCliVersion;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;
            const cliVersionChanged = prevCliVersion !== newCliVersion;
            const automationSupportChanged = this.lastKnownAutomationRpcAvailable !== this.automationRpcAvailable;
            const autonomousQualityGateSupportChanged = this.lastKnownAutonomousQualityGateRpcAvailable !== this.autonomousQualityGateRpcAvailable;
            const automationServerKeyChanged = this.lastKnownAutomationServerKeyVersion !== this.automationServerKeyVersion;

            this.syncResumeSessionRpcRegistration();

            if (cliAvailabilityChanged || resumeSupportChanged || cliVersionChanged || automationSupportChanged || autonomousQualityGateSupportChanged || automationServerKeyChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.lastKnownCliVersion = newCliVersion;
                this.lastKnownAutomationRpcAvailable = this.automationRpcAvailable;
                this.lastKnownAutonomousQualityGateRpcAvailable = this.autonomousQualityGateRpcAvailable;
                this.lastKnownAutomationServerKeyVersion = this.automationServerKeyVersion;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
                    automationSupport: {
                        rpcAvailable: this.automationRpcAvailable,
                        serverBacked: this.automationServerKeyVersion !== null,
                        ...(this.automationServerKeyVersion !== null ? { keyVersion: this.automationServerKeyVersion } : {}),
                        sessionFollowup: true,
                        protocolVersion: this.automationProtocolVersion,
                    },
                    autonomousQualityGateSupport: {
                        apiVersion: 1,
                        rpcAvailable: this.autonomousQualityGateRpcAvailable,
                    },
                    additionalDirectories: ADDITIONAL_DIRECTORIES_CAPABILITY,
                    happyCliVersion: newCliVersion,
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        };
        publishKeepAlive();
        this.keepAliveInterval = setInterval(publishKeepAlive, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    setRuntimeActivityProvider(provider: () => {
        activeSessionCount: number;
        activeAutomationCount: number;
    }): void {
        this.runtimeActivityProvider = provider;
    }

    private startSmartReconnect() {
        // A runtime whose credential is gone does not reconnect. Retrying would
        // present a dead bearer over and over while the parent already knows
        // this runtime is not authorised.
        if (this.credentialStopped) return;
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => {
                // Re-checked when it fires, not when it was scheduled. A stop
                // that arrives in between leaves this timeout on the queue, and
                // it would reconnect with the credential that just expired.
                if (this.credentialStopped) return;
                if (!this.socket.connected) this.socket.connect();
            }, 1000);
        }
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        for (const cdpPipe of this.browserCdpPipes.values()) cdpPipe.close();
        this.browserCdpPipes.clear();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}

/** Chrome's conventional CDP port, then a small range for extra profiles. */
const CDP_PORT_RANGE = [9222, 9223, 9224, 9225, 9226, 9227, 9228] as const;

function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '127.0.0.1');
    });
}

/**
 * A distinct CDP port per profile. Reusing one port makes the second Chrome
 * fail to expose CDP at all, which surfaces later as an unexplainable
 * pairing timeout (specs/browser-setup-gui/ AC5).
 */
async function pickFreeCdpPort(): Promise<number | null> {
    for (const port of CDP_PORT_RANGE) {
        if (await isPortFree(port)) return port;
    }
    return null;
}

type RunningChrome = {
    cdpPort: number | null;
    userDataDir: string | null;
    display: string | null;
};

/** Chrome process facts that CDP itself does not expose. */
async function scanChromeProcesses(): Promise<RunningChrome[]> {
    let entries: string[];
    try {
        entries = await readdir('/proc');
    } catch {
        return [];
    }
    const running: RunningChrome[] = [];
    for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
            const port = readFlagFromCmdline(cmdline, '--remote-debugging-port');
            if (port === null) continue;
            const explicitDisplay = readFlagFromCmdline(cmdline, '--display');
            running.push({
                cdpPort: Number(port) || null,
                userDataDir: readFlagFromCmdline(cmdline, '--user-data-dir'),
                display: explicitDisplay
                    ?? readDisplayFromEnviron(await readFile(`/proc/${pid}/environ`, 'utf8')),
            });
        } catch {
            // The process may exit between listing /proc and reading it.
        }
    }
    return running;
}

/** Chrome needs a moment before its CDP endpoint answers. */
async function waitForCdp(cdpPort: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCdpReachable(cdpPort)) return true;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
}

function runShell(command: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        exec(command, { timeout: 300_000 }, (error, stdout, stderr) => {
            resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
        });
    });
}

/** The CLI formatter colours its output; the app renders plain text. */
function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First free port from the candidate list, or null when all are taken. */
async function pickFreePort(candidates: number[]): Promise<number | null> {
    for (const port of candidates) {
        if (await isPortFree(port)) return port;
    }
    return null;
}

/**
 * A viewer stack left running by a previous daemon, if any.
 *
 * Checks that the port actually serves noVNC rather than merely being bound —
 * adopting an unrelated service would hand the user someone else's page as
 * their browser screen.
 */
async function findRunningViewer(): Promise<{ webPort: number } | null> {
    for (const webPort of VIEWER_WEB_PORTS) {
        if (await isViewerServing(webPort)) return { webPort };
    }
    return null;
}

/** Whether something is listening yet — websockify takes a moment to bind. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isPortFree(port))) return true;
        await delay(300);
    }
    return false;
}

/**
 * Where the distro put noVNC's client assets. Debian/Ubuntu's `novnc`
 * package uses /usr/share/novnc; the tarball install commonly lands in
 * /usr/share/webapps/novnc. Falling back to the first existing path keeps
 * websockify from serving a 404 page that looks like a broken relay.
 */
function resolveNovncWebRoot(): string {
    const candidates = ['/usr/share/novnc', '/usr/share/webapps/novnc', '/usr/local/share/novnc'];
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
}
