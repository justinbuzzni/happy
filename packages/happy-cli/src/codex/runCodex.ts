import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import { describeCodexFailure, describeCodexInactivityAbort } from './codexAbortNotice';
import type { ReasoningEffort } from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { installBroadKillShims } from '@/utils/broadKillShims';
import { Credentials, readSettings } from '@/persistence';
import { resolveSessionSandboxConfig } from '@/sandbox/resolveSessionSandboxConfig';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';
import {
    fetchAplusMcpConfigSnapshot,
    fetchAplusMcpServersResult,
    mcpConfigFailureStatuses,
    readExpectedConnectors,
    readExpectedMcpServices,
    resolveMcpFloorServerNames,
} from '@/aplus/fetchAplusMcpServers';
import { buildConnectorToolGuidance, listExpectedMcpServices } from '@/aplus/connectorToolGuidance';
import { bridgeAplusMcpServers } from '@/aplus/mergeAplusMcpServers';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64 } from '@/api/encryption';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { createTerminationSignalHandler } from "@/codex/terminationSignals";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { resolveRemoteCodexPermissionMode } from './permissionMode';
import { isSandboxFallbackNetworkLoss } from './sandboxInitFailurePolicy';
import { readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { CodexMcpConfigSynchronizer } from './codexMcpConfigSynchronizer';
import {
    buildCodexMcpRecoveryMetadataStatuses,
    CodexMcpRuntimeRecovery,
} from './codexMcpRuntimeRecovery';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText } from './codexClearCommand';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import {
    resolveInitialSaycodeAppendSystemPrompt,
    resolveSaycodeAppendSystemPromptForMessage,
} from '@/prompt/promptProvenance';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import {
    buildCodexDeveloperInstructions,
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    isSupportedCodexReasoningEffort,
    resolveCodexSaycodePromptBlocks,
    type CodexEnhancedMode,
} from './codexPrompt';
import { discoverCodexSkillCommands } from './codexSkills';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from '@/prompt/agentOrchestrationPrompt';
import { readReconnectSessionEnvironment } from '@/daemon/reconnectSessionEnv';
import { mergeReconnectSessionMetadata } from '@/utils/reconnectSessionMetadata';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';
import {
    assertCodexAutomationServerAvailable,
    prepareCodexInitialPrompt,
    prepareCodexSessionStart,
} from './initialPrompt';
import { consumeAutomationRunOnce } from '@/utils/automationRunOnce';
import { createCodexUsageEvent } from '@/usage/providerUsageAdapters';
import {
    consumePendingInitialAppendSystemPrompt,
    consumePendingInitialEffort,
    consumePendingInitialModel,
    consumePendingInitialSaycodePromptBlocks,
    consumePendingInitialSaycodeSystemPromptEnabled,
    resolveInitialPromptPermissionMode,
} from '@/utils/initialPrompt';

import { registerCodexSteerHandler } from './codexSteerHandler';
import { createCheckpointSessionComposition } from '@/checkpoint/checkpointSessionComposition';
import { createCheckpointEventPublisher } from '@/checkpoint/checkpointEventPublisher';
import { describeCheckpointFailure } from '@/checkpoint/checkpointFailure';
import { isManagedBrokerServer } from '@/launcher/codexApproval';
import { resolveManagedCodexArguments } from '@/launcher/managedCodexOptions';
import { applyManagedGatewayEnvironment, applyManagedInitialPrompt, assertManagedWorkingDirectory, clearForeignSessionLineage, managedCodexProviderArguments, requireAccountMachineId, requireAccountToken } from '@/managed/managedStartup';
import type { RunnerPrincipal } from '@/claude/runClaude';

/** See the Claude counterpart. */
const CODEX_INITIAL_PROMPT_ACK_TIMEOUT_MS = 30_000;

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'yolo';

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    principal: RunnerPrincipal;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
}): Promise<void> {
    // Shield killall/pkill against broad kills before anything is spawned —
    // Codex has no PreToolUse hook system, so the PATH shim is its only guard.
    const managedStartup = opts.principal?.kind === 'managed' ? opts.principal.startup : null;
    const accountToken = opts.principal?.kind === 'account' ? opts.principal.credentials.token : null;
    if (managedStartup) {
        // Before every consumer, not merely before the API client. The initial
        // prompt is read out of the environment a few lines below, so applying
        // the envelope later means the child's first turn carries somebody
        // else's prompt — or none, and no acknowledgement for the one it was
        // launched to answer.
        assertManagedWorkingDirectory(process.cwd());
        // Before the reconnect environment is read, which happens within a few
        // lines and would otherwise resume a session this run has nothing to
        // do with — dropping its prompt on the way.
        clearForeignSessionLineage(process.env);
        applyManagedGatewayEnvironment(process.env, managedStartup.envelope);
        applyManagedInitialPrompt(process.env, managedStartup.envelope);
    }

    installBroadKillShims();
    const automationRunOnceRequested = consumeAutomationRunOnce(process.env);
    const reconnectSession = readReconnectSessionEnvironment(process.env);
    const reconnectSessionId = reconnectSession?.id;
    const allowAutomationReconnectPrompt = process.env.HAPPY_AUTOMATION_RESUME_PROMPT === '1';
    delete process.env.HAPPY_AUTOMATION_RESUME_PROMPT;
    const preparedInitialPrompt = prepareCodexInitialPrompt({
        env: process.env,
        reconnectSessionId,
        automationRunOnceRequested,
        allowAutomationReconnectPrompt,
    });

    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = opts.principal.kind === 'managed'
        ? ApiClient.managed(opts.principal.startup.attachment)
        : await ApiClient.create(opts.principal.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    const additionalDirectories = readAdditionalDirectoriesEnvironment(process.env);
    let machineId = settings?.machineId;
    // daemon 이 서버 지시대로 넘긴 설정(AgentTask pr_review 의 networkMode:'allowed' 등)을
    // 로컬 머신 설정보다 우선한다. 이 배선이 없어서 agent=codex 워커가 샌드박스 없이 떴고,
    // Codex 네이티브 readOnly 정책으로 떨어져 lifecycle 콜백을 전부 놓쳤다.
    const sandboxConfig = resolveSessionSandboxConfig({
        noSandbox: Boolean(opts.noSandbox),
        env: process.env,
        settings,
    });
    // See runClaude: a managed child has no account home and no machine id.
    if (!machineId && !managedStartup) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    // A managed child has no machine of its own; the runtime it runs inside is
    // the registered thing.
    if (!managedStartup) {
        await api.getOrCreateMachine({
            machineId: requireAccountMachineId(machineId),
            metadata: initialMachineMetadata
        });
    }

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    // Requester identity from the daemon's spawn RPC (specs/session-created-by).
    const createdByAccountId = process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
    const createdByDisplayName = process.env.HAPPY_CREATED_BY_DISPLAY_NAME;

    const { state, metadata: freshMetadata } = createSessionMetadata({
        flavor: 'codex',
        // Discarded for a managed run: its session metadata comes from the
        // server, opened with the key this process was handed.
        machineId: machineId ?? '',
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(createdByAccountId ? { createdBy: { accountId: createdByAccountId, displayName: createdByDisplayName } } : {}),
    });

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        freshMetadata.skills = skillCommands;
        freshMetadata.slashCommands = Array.from(new Set([...(freshMetadata.slashCommands ?? []), ...skillCommands]));
    }

    // Resume-in-place must start from the latest server metadata snapshot.
    // Rebuilding a local document here can overwrite an existing title and
    // any provider fields while still satisfying the server CAS version.
    const metadata = mergeReconnectSessionMetadata(reconnectSession?.metadata, freshMetadata);

    let response: ApiSession | null;
    if (managedStartup) {
        // Looked up, proven against the key this process holds, and placed on
        // the runtime's project root before anything reads the path.
        response = managedStartup.attachment.session;
    } else if (reconnectSession) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            ...reconnectSession,
            metadata,
            agentState: state,
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }
    assertCodexAutomationServerAvailable({
        automationRunOnceRequested,
        serverAvailable: response !== null,
        prepared: preparedInitialPrompt,
    });
    if (!response && sandboxConfig?.checkpointProtection) {
        throw new Error('checkpoint protection requires an authoritative server session');
    }
    const checkpointComposition = response
        ? await createCheckpointSessionComposition({
            provider: 'codex',
            platform: process.platform,
            projectPath: process.cwd(),
            sessionId: response.id,
            sandboxConfig,
            env: process.env,
            checkpointEvents: sandboxConfig?.checkpointProtection
                ? createCheckpointEventPublisher({
                    token: requireAccountToken(accountToken),
                    sessionId: response.id,
                    encryption: {
                        encryptionKey: response.encryptionKey,
                        encryptionVariant: response.encryptionVariant,
                    },
                })
                : undefined,
        })
        : { sandboxConfig };

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    // Assigned after handleKillSession is defined; re-attached on session swap
    // so an offline-started session still exits when archived server-side.
    let onSessionArchived: ((archiveOpts?: { stampArchive?: boolean }) => void) | undefined;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            if (onSessionArchived) {
                newSession.on('archived', onSessionArchived);
            }
        }
    });
    session = initialSession;

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages(response?.seq ?? 0);
        if (allowAutomationReconnectPrompt) {
            session.capRuntimeProcessedSeq(response?.seq ?? 0);
        }
        session.updateMetadata((meta) => mergeReconnectSessionMetadata(meta, freshMetadata));
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);

    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    // Daemon-provided per-spawn model/effort seed (HAPPY_INITIAL_MODEL /
    // HAPPY_INITIAL_EFFORT, e.g. automations). Consumed exactly once — read
    // then deleted so children never inherit. Effort is whitelisted against
    // ReasoningEffort; anything else falls back to the default.
    const initialModelSeed = consumePendingInitialModel(process.env) ?? DEFAULT_CODEX_MODEL;
    const rawInitialEffortSeed = consumePendingInitialEffort(process.env);
    if (rawInitialEffortSeed && !isSupportedCodexReasoningEffort(rawInitialEffortSeed)) {
        logger.debug(`[Codex] Ignoring invalid initial effort seed: ${rawInitialEffortSeed}`);
    }
    const initialEffortSeed = isSupportedCodexReasoningEffort(rawInitialEffortSeed)
        ? rawInitialEffortSeed
        : DEFAULT_CODEX_EFFORT;
    const initialSaycodeSystemPromptEnabled = consumePendingInitialSaycodeSystemPromptEnabled(
        process.env,
    );
    const initialSaycodePromptBlocks = consumePendingInitialSaycodePromptBlocks(process.env);
    const initialAppendSystemPrompt = resolveInitialSaycodeAppendSystemPrompt({
        appendSystemPrompt: consumePendingInitialAppendSystemPrompt(process.env),
        saycodeSystemPromptEnabled: initialSaycodeSystemPromptEnabled,
    });
    let currentModel: string | undefined = initialModelSeed;
    let currentEffort: ReasoningEffort | undefined = initialEffortSeed;
    let currentAppendSystemPrompt: string | undefined = initialAppendSystemPrompt;
    let currentSaycodeSystemPromptEnabled: boolean | undefined = initialSaycodeSystemPromptEnabled;
    let currentSaycodePromptBlocks: CodexEnhancedMode['saycodePromptBlocks'] = initialSaycodePromptBlocks;

    const resetTurnScopedOptions = () => {
        currentPermissionMode = DEFAULT_CODEX_PERMISSION_MODE;
        currentModel = initialModelSeed;
        currentEffort = initialEffortSeed;
        // Cached append prompt and account preference survive turn-scoped abort resets.
        logger.debug('[Codex] Reset turn-scoped options after abort');
    };

    const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
        // A managed run answers exactly the prompt its envelope was admitted
        // for. A message posted to this session by the account owner arrives
        // here as an ordinary user turn: it would change the model, the
        // permission mode and the system prompt, then queue another turn —
        // spending this run's capability on work that passed no admission and
        // silently replacing the selection that was priced. Refused before any
        // of that happens; a new prompt needs a new run.
        //
        // This is the general free-text path only. Permission answers and tool
        // responses arrive as their own RPCs, bound to an approval this run is
        // already waiting on, and are untouched.
        if (managedStartup) {
            logger.debug('[managed] Refusing a user turn that did not come from an admitted run');
            return;
        }

        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        // Resolve permission mode (validated + downgrade-guarded in permissionMode.ts)
        const messagePermissionMode = resolveRemoteCodexPermissionMode(
            currentPermissionMode,
            message.meta?.permissionMode as PermissionMode | undefined,
        );
        if (messagePermissionMode !== currentPermissionMode) {
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] Keeping current permission mode: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve effort — passed straight to sendTurnAndWait. Validate the
        // incoming value against ReasoningEffort so a stale/garbage entry on
        // the wire doesn't poison the per-turn options.
        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[Codex] Effort reset to default`);
            } else if (isSupportedCodexReasoningEffort(incoming)) {
                messageEffort = incoming;
                currentEffort = messageEffort;
                logger.debug(`[Codex] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        const hasAppendSystemPrompt = message.meta?.hasOwnProperty('appendSystemPrompt') ?? false;
        if (hasAppendSystemPrompt) {
            logger.debug(`[Codex] Append system prompt updated from user message: ${message.meta?.appendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        if (message.meta?.hasOwnProperty('saycodeSystemPromptEnabled')) {
            currentSaycodeSystemPromptEnabled = message.meta.saycodeSystemPromptEnabled ?? true;
            logger.debug(`[Codex] Saycode system prompt ${currentSaycodeSystemPromptEnabled ? 'enabled' : 'disabled'} by user message`);
        }

        currentSaycodePromptBlocks = resolveCodexSaycodePromptBlocks(
            currentSaycodePromptBlocks,
            message.meta,
        );

        messageAppendSystemPrompt = resolveSaycodeAppendSystemPromptForMessage({
            current: currentAppendSystemPrompt,
            incoming: message.meta?.appendSystemPrompt,
            hasIncoming: hasAppendSystemPrompt,
            saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
        });
        currentAppendSystemPrompt = messageAppendSystemPrompt;

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            appendSystemPrompt: messageAppendSystemPrompt,
            saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
            saycodePromptBlocks: currentSaycodePromptBlocks,
            effort: messageEffort,
        };
        const enqueueResult = enqueueCodexUserText({
            text: message.content.text,
            mode: enhancedMode,
            queue: messageQueue,
            attachments: attachmentsForThisMessage,
        });
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error) => {
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    });
    session.onUserMessage(handleUserMessage);
    const initialPromptDelivered = await prepareCodexSessionStart({
        // An offline start has no session to confirm against; the guard above
        // (`assertCodexAutomationServerAvailable`) already refused that case,
        // and `prepareCodexSessionStart` refuses again if no confirmer reaches
        // it. This condition only supplies the confirmer when one can exist.
        ...(preparedInitialPrompt.requireConfirmedDelivery && response
            ? {
                confirmDelivery: (localId: string) => session.awaitMessageAck(
                    localId, CODEX_INITIAL_PROMPT_ACK_TIMEOUT_MS,
                ),
            }
            : {}),
        prepared: preparedInitialPrompt,
        sendSessionMessage: (envelope, localId) => session.sendSessionProtocolMessage(envelope, localId),
        pushPrompt: (prompt) => {
            messageQueue.unshiftIsolated(prompt, {
                permissionMode: resolveInitialPromptPermissionMode(
                    currentPermissionMode ?? 'default',
                    allowAutomationReconnectPrompt,
                ),
                model: currentModel,
                appendSystemPrompt: currentAppendSystemPrompt,
                saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
                saycodePromptBlocks: currentSaycodePromptBlocks,
                effort: currentEffort,
            });
            logger.debug('[START] Delivered initial prompt from HAPPY_INITIAL_PROMPT');
        },
        reportStarted: response ? async () => {
            try {
                logger.debug(`[START] Reporting session ${response.id} to daemon`);
                const result = await notifyDaemonSessionStarted(response.id, metadata, {
                    encryptionKey: encodeBase64(response.encryptionKey),
                    encryptionVariant: response.encryptionVariant,
                    seq: response.seq,
                    metadataVersion: response.metadataVersion,
                    agentStateVersion: response.agentStateVersion,
                });
                if (result.error) {
                    logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
                } else {
                    logger.debug(`[START] Reported session ${response.id} to daemon`);
                }
            } catch (error) {
                logger.debug('[START] Failed to report to daemon (may not be running):', error);
            }
        } : undefined,
    });
    // A run-once marker is only valid together with the fresh prompt supplied by
    // the automation daemon. This prevents an incomplete or accidentally resumed
    // startup from treating a later interactive message as the automation turn.
    const exitAfterFirstTurn = preparedInitialPrompt.exitAfterFirstTurn && initialPromptDelivered;
    let thinking = false;
    let currentTurnId: string | null = null;
    let currentProviderTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetTurnScopedOptions();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async (killOpts?: { stampArchive?: boolean }) => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing —
            // unless the caller says the session may still be alive
            // server-side (sync-fatal 401/403), in which case leave the
            // metadata alone so the session stays resumable.
            if (session) {
                if (killOpts?.stampArchive ?? true) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                }

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    // The daemon stops sessions with a bare SIGTERM (daemon/run.ts) — the idle
    // reaper, the stop-session RPC and Ctrl-C all land here, never on the
    // killSession RPC above. Without a handler Node's default disposition kills
    // us on the spot, so sendSessionDeath/flush/close never run and the tail of
    // the conversation is lost. runClaude has had these handlers all along;
    // the Codex runner never grew them.
    const handleTerminationSignal = createTerminationSignalHandler({
        terminate: handleKillSession,
        forceExit: (code) => process.exit(code),
    });
    process.on('SIGTERM', () => { void handleTerminationSignal('SIGTERM'); });
    process.on('SIGINT', () => { void handleTerminationSignal('SIGINT'); });

    // Exit when the session is archived/deleted server-side: the web archive
    // button (ephemeral with reason='archived') or a fatal 404 from the
    // message sync. Without this the syncs stop but the process lingers.
    // Mirrors the 'archived' listener in runClaude. Also attached to swapped
    // sessions via onSessionSwap (offline start → reconnect).
    onSessionArchived = (archiveOpts?: { stampArchive?: boolean }) => {
        logger.debug('[Codex] Session archived server-side, terminating...', archiveOpts);
        void handleKillSession(archiveOpts);
    };
    session.on('archived', onSessionArchived);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    client = new CodexAppServerClient(
        checkpointComposition.sandboxConfig,
        checkpointComposition.beforeTurn,
        checkpointComposition.completeTurn,
        // Explicit, and only ever from the verified envelope: it turns off the
        // account-rotation proxy and pins the provider this run may use.
        /*
         * B2 의 provider 고정 인자 뒤에 이 run 의 도구 경계(broker 등록·자격
         * 환경변수 이름·기능 차단·effort)를 얹는다. 관리 실행인데 검증된 계획이
         * 없으면 기존 동작으로 되돌아가지 않고 멈춘다.
         */
        resolveManagedCodexArguments({
            managed: managedStartup !== null,
            env: process.env,
            base: managedStartup ? managedCodexProviderArguments(managedStartup.envelope) : null,
        }),
    );

    registerCodexSteerHandler({
        client,
        session,
        managedRun: managedStartup !== null,
        onFailure: (message) => {
            logger.debug(`[Codex] Active-turn steer failed: ${message}`);
        },
    });

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch (error) {
            logger.debug('[Codex] Goal command API failed; falling back to normal turn:', error);
            return false;
        }
    };
    session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }
        if (managedStartup && command.type === 'set') {
            // A managed run answers exactly the prompt its envelope was
            // admitted for. A goal carries a free-text instruction into every
            // turn after it — work no admission covered. Refused here, before
            // the thread or the provider is touched; clearing a goal removes an
            // instruction rather than adding one, so it stays.
            throw new Error('A managed run cannot be given a new objective');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await handleCodexGoalCommand(command, threadId);
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});

        /*
         * 이 run 이 스스로 등록한 broker 로의 호출은 사람에게 물을 것이 없다 —
         * 그 서버를 등록한 것이 우리이고, 어떤 도구를 쓸 수 있는지는 broker 가
         * grant scope 로 최종 강제한다. 그 밖의 승인은 전부 기존 경로 그대로다.
         */
        if (isManagedBrokerServer({
            managed: managedStartup !== null,
            env: process.env,
            serverName: params.serverName,
        })) {
            return 'approved';
        }

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input, {
                serverName: params.serverName,
            });
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);

        if (msg.type === 'codex_usage') {
            try {
                session.sendProviderUsageEvent(createCodexUsageEvent({
                    sessionId: session.sessionId,
                    responseId: String(msg.response_id ?? ''),
                    occurredAt: Date.now(),
                    model: currentModel ?? DEFAULT_CODEX_MODEL,
                    usage: msg.usage as Parameters<typeof createCodexUsageEvent>[0]['usage'],
                }));
            } catch (error) {
                logger.warn('[Codex] Failed to normalize provider usage data:', error);
            }
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            // Codex may settle a watchdog interrupt with status 'completed', so the
            // inactivity notice applies here too, not just to turn_aborted.
            const inactivityNotice = describeCodexInactivityAbort(msg);
            const failure = describeCodexFailure(msg);
            if (inactivityNotice) {
                const message = failure ? `${inactivityNotice} Provider error: ${failure}` : inactivityNotice;
                messageBuffer.addMessage(message, 'status');
                session.sendSessionEvent({ type: 'message', message });
            } else if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const inactivityNotice = describeCodexInactivityAbort(msg);
            const failure = describeCodexFailure(msg);
            if (inactivityNotice) {
                // Our own watchdog force-stopped a hung turn: without this the turn
                // ends silently and the user never learns why nothing came back.
                // Keep the provider error visible when the event carries both.
                const message = failure ? `${inactivityNotice} Provider error: ${failure}` : inactivityNotice;
                messageBuffer.addMessage(message, 'status');
                session.sendSessionEvent({ type: 'message', message });
            } else if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                currentProviderTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            currentProviderTurnId = mapped.currentProviderTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session, {
        protectedBashCwd: checkpointComposition.protectedBashCwd,
        trackProtectedBashProcess: checkpointComposition.trackProtectedWriter,
    });
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    // Account-only: the aplus MCP config belongs to a user, and a managed run
    // has none. Skipped rather than attempted with a scoped bearer.
    const initialAplusMcpSnapshot = accountToken === null ? null : await fetchAplusMcpConfigSnapshot(
        accountToken,
        requireAccountMachineId(machineId),
        { sessionId: session.sessionId },
    );
    const initialAplusMcpResult = initialAplusMcpSnapshot?.result ?? null;
    for (const status of initialAplusMcpResult ? mcpConfigFailureStatuses(initialAplusMcpResult) : []) {
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            mcpServers: [
                ...(currentMetadata.mcpServers ?? []).filter((server) => server.name !== status.name),
                status,
            ],
        }));
    }
    const initialAplusMcpServers = initialAplusMcpSnapshot?.servers ?? {};
    const baseMcpServers = {
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url]
        }
    };
    const bridgeOptions = { bridgeCommand: bridgeEntrypoint, nodeExecPath: process.execPath };
    const listExternalServices = (mcpServers: Record<string, unknown>) => listExpectedMcpServices({
        expectedConnectors: readExpectedConnectors(),
        expectedMcpServices: readExpectedMcpServices(),
        configuredServerNames: Object.keys(mcpServers),
    });
    const listConfiguredExternalServices = (mcpServers: Record<string, unknown>) => listExpectedMcpServices({
        expectedConnectors: [],
        expectedMcpServices: [],
        configuredServerNames: Object.keys(mcpServers),
    });
    let currentDeveloperInstructions: string | undefined = buildConnectorToolGuidance(listExternalServices({
        ...baseMcpServers,
        ...initialAplusMcpServers,
    }));
    const mcpConfigSynchronizer = new CodexMcpConfigSynchronizer({
        baseServers: baseMcpServers,
        initialAplusServers: initialAplusMcpServers,
        floorServerNames: resolveMcpFloorServerNames(initialAplusMcpServers, readExpectedConnectors()),
        fetchAplusServers: async () => {
            // 조회 직전에 교환해야 새 grant 로 조회된다. 24시간을 넘겨 사는
            // 세션이 403 으로 마지막 정상 설정에 갇히는 것을 막는다.
            const account = requireAccountMachineId(machineId);
            await refreshMcpCallerGrantIfExpiring(requireAccountToken(accountToken), account);
            return fetchAplusMcpServersResult(
                requireAccountToken(accountToken),
                account,
                { sessionId: session.sessionId, lifecycle: 'turn' },
            );
        },
        bridgeAplusServers: (servers) => bridgeAplusMcpServers(servers, bridgeOptions),
        onStatus: (status) => {
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                mcpServers: [
                    ...(currentMetadata.mcpServers ?? []).filter((server) => server.name !== status.name),
                    status,
                ],
            }));
        },
    });
    const mcpRuntimeRecovery = new CodexMcpRuntimeRecovery(client);
    let appendSystemPromptInjected = false;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        if (opts.resumeThreadId) {
            await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers: mcpConfigSynchronizer.mcpServers,
                developerInstructions: currentDeveloperInstructions,
            });
            appendSystemPromptInjected = true;
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            try {
                const { thread } = await client.readThread({
                    threadId: forkCodexThreadId,
                    includeTurns: true,
                });
                const envelopes = await buildCodexThreadBackfillEnvelopes({
                    thread,
                    uploadLocalImage: (attachment, imageOpts) => (
                        session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                    ),
                });
                for (const envelope of envelopes) {
                    session.sendSessionProtocolMessage(envelope);
                }
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: forkCodexThreadId,
                }));
                logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
            } catch (error) {
                logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
            }
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            if (isCodexClearText(message.message)) {
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                client.clearThreadState();
                currentTurnId = null;
                currentProviderTurnId = null;
                codexStartedSubagents = new Set<string>();
                codexActiveSubagents = new Set<string>();
                codexProviderSubagentToSessionSubagent = new Map<string, string>();
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                appendSystemPromptInjected = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                session.updateMetadata((currentMetadata) => {
                    const nextMetadata = { ...currentMetadata };
                    delete nextMetadata.codexThreadId;
                    return nextMetadata;
                });
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            // Display user messages in the UI
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }

            try {
                if (checkpointComposition.completeTurn && !client.isConnected) {
                    const expectedThreadId = client.threadId;
                    const resumed = await client.reconnectAndResumeThread();
                    if (expectedThreadId && !resumed) {
                        throw new Error('checkpoint protection could not resume the Codex thread');
                    }
                }
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                // 샌드박스 초기화가 실패했고, 이 턴의 모드가 하필 네트워크를 잃는
                // 네이티브 정책으로 떨어지는 경우다. 조용히 돌면 몇 분 뒤 턴 안의
                // 네트워크 호출이 DNS 에서 실패할 때가 돼서야 드러난다 — 그 자리에서
                // 사유를 밝히고 턴을 멈춘다. 네트워크가 남는 모드는 그대로 진행한다.
                if (
                    client.sandboxInitFailed
                    && isSandboxFallbackNetworkLoss(sandboxConfig, executionPolicy.sandbox)
                ) {
                    const notice = `Sandbox initialization failed, so permission mode `
                        + `'${message.mode.permissionMode}' falls back to Codex's native read-only `
                        + `policy, which has no network access at all — but this session requested `
                        + `network (networkMode=${sandboxConfig?.networkMode}). Refusing to run the `
                        + `turn without it. Original error: ${client.sandboxInitFailureReason}`;
                    logger.warn(`[Codex] ${notice}`);
                    messageBuffer.addMessage(notice, 'status');
                    session.sendSessionEvent({ type: 'message', message: notice });
                    continue;
                }

                const mcpSync = await mcpConfigSynchronizer.sync({
                    threadId: client.threadId,
                    resumeThread: client.threadId
                        ? async ({ threadId, mcpServers }) => {
                            const nextDeveloperInstructions = buildCodexDeveloperInstructions({
                                connectorGuidance: buildConnectorToolGuidance(listExternalServices(mcpServers)),
                                agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
                                mode: message.mode,
                            });
                            const resumed = await client.resumeThread({
                                threadId,
                                writableRoots: additionalDirectories,
                                mcpServers,
                                developerInstructions: nextDeveloperInstructions ?? null,
                            });
                            currentDeveloperInstructions = nextDeveloperInstructions;
                            return resumed;
                        }
                        : undefined,
                });

                const nextDeveloperInstructions = buildCodexDeveloperInstructions({
                    connectorGuidance: buildConnectorToolGuidance(listExternalServices(mcpSync.mcpServers)),
                    agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
                    mode: message.mode,
                });
                if (client.threadId && nextDeveloperInstructions !== currentDeveloperInstructions) {
                    await client.resumeThread({
                        threadId: client.threadId,
                        writableRoots: additionalDirectories,
                        mcpServers: mcpSync.mcpServers,
                        developerInstructions: nextDeveloperInstructions ?? null,
                    });
                    currentDeveloperInstructions = nextDeveloperInstructions;
                }

                // Start thread on first turn (thread persists across mode changes)
                let activeThreadId = client.threadId;
                if (!client.hasActiveThread() || !activeThreadId) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        writableRoots: additionalDirectories,
                        mcpServers: mcpSync.mcpServers,
                        developerInstructions: nextDeveloperInstructions,
                    });
                    activeThreadId = startedThread.threadId;
                    currentDeveloperInstructions = nextDeveloperInstructions;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                const runtimeRecovery = await mcpRuntimeRecovery.recoverBeforeTurn({
                    threadId: activeThreadId,
                    mcpServers: mcpSync.mcpServers,
                    expectedServerNames: listConfiguredExternalServices(mcpSync.mcpServers),
                    developerInstructions: currentDeveloperInstructions,
                });
                if (runtimeRecovery.status !== 'ready') {
                    const metadataStatuses = buildCodexMcpRecoveryMetadataStatuses({
                        recovery: runtimeRecovery,
                        connectorNames: readExpectedConnectors(),
                        checkedAt: Date.now(),
                    });
                    for (const metadataStatus of metadataStatuses) {
                        session.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            mcpServers: [
                                ...(currentMetadata.mcpServers ?? []).filter(
                                    (server) => server.name !== metadataStatus.name,
                                ),
                                metadataStatus,
                            ],
                        }));
                    }
                }

                const goalCommand = parseCodexGoalCommand(message.message);
                if (goalCommand && await handleCodexGoalCommand(goalCommand, activeThreadId)) {
                    continue;
                }

                const includeAppendSystemPrompt = Boolean(
                    message.mode.saycodeSystemPromptEnabled === undefined
                    && message.mode.appendSystemPrompt
                    && !appendSystemPromptInjected,
                );
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                if ((message.attachments?.length ?? 0) > 0) {
                    logger.debug('[Codex] Prepared image inputs for turn', {
                        inputCount: imageInputs.inputItems.length,
                        skippedCount: imageInputs.skipped,
                    });
                }
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
                const turnPrompt = buildCodexTurnPrompt({
                    message: message.message,
                    mode: message.mode,
                    includeAppendSystemPrompt,
                    hasTitle: session.hasTitle(),
                });

                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    writableRoots: additionalDirectories,
                    effort: message.mode.effort,
                    extraInputItems: imageInputs.inputItems,
                });
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                // No task_complete/turn_aborted was ever received for this turn, so the
                // session-protocol mapper's turn state is left open. Without an explicit
                // close here, the durable transcript keeps an unclosed turn forever (the
                // 'thinking' ephemeral below still gets set false, but that is live-only
                // and does not repair what a reload/observer reads from history), and the
                // dangling currentTurnId would make the mapper treat the NEXT task_started
                // as a nested continuation (task_started no-ops while currentTurnId is set),
                // silently dropping turn-start too. Synthesize the same close the mapper
                // would have produced from a real turn_aborted, reusing its guard logic
                // (harmless no-op if currentTurnId is already null).
                logger.warn('Error in codex session:', error);
                const failureMessage = describeCheckpointFailure(error) ?? 'Process exited unexpectedly';
                messageBuffer.addMessage(failureMessage, 'status');
                session.sendSessionEvent({ type: 'message', message: failureMessage });
                const closed = mapCodexMcpMessageToSessionEnvelopes(
                    { type: 'turn_aborted', status: 'failed' },
                    {
                        currentTurnId,
                        currentProviderTurnId,
                        startedSubagents: codexStartedSubagents,
                        activeSubagents: codexActiveSubagents,
                        providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                    },
                );
                currentTurnId = closed.currentTurnId;
                currentProviderTurnId = closed.currentProviderTurnId;
                codexStartedSubagents = closed.startedSubagents;
                codexActiveSubagents = closed.activeSubagents;
                codexProviderSubagentToSessionSubagent = closed.providerSubagentToSessionSubagent;
                for (const envelope of closed.envelopes) {
                    session.sendSessionProtocolMessage(envelope);
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                if (exitAfterFirstTurn) {
                    logger.debug('[codex]: Automation turn completed, exiting run-once session');
                    shouldExit = true;
                }
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
