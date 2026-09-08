import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import type { QueryOptions } from '@/claude/sdk';
import { createCheckpointRuntime } from './checkpointRuntime';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import { checkpointAttachmentPassthroughCandidates } from './checkpointAttachmentPassthrough';
import {
    CheckpointPolicyDriftError,
    resolveCheckpointProtectionCapability,
    type CheckpointProvider,
} from './checkpointExclusionPolicy';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { CheckpointTurnWorkspace } from './checkpointTurnWorkspace';
import { CheckpointTurnApplier, type CheckpointTurnApplyResult } from './checkpointTurnApply';
import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

export type CheckpointTurnPreparation = {
    operationId: string;
    checkpointId: string;
    providerPath: string;
    sandboxConfig?: SandboxConfig;
    claudeSandbox?: QueryOptions['sandbox'];
};

export type CheckpointSessionComposition = {
    sandboxConfig: SandboxConfig | undefined;
    providerPath?: string;
    beforeTurn?: () => Promise<CheckpointTurnPreparation>;
    completeTurn?: (quiesceWriters: () => Promise<void>) => Promise<CheckpointTurnApplyResult>;
    protectedBashCwd?: () => string | null;
    trackProtectedWriter?: (child: ChildProcess) => void;
    claudeSandbox?: QueryOptions['sandbox'];
};

export async function createCheckpointSessionComposition(input: {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    sessionId: string;
    sandboxConfig: SandboxConfig | undefined;
    env: Record<string, string | undefined>;
    checkpointEvents?: Pick<CheckpointEventPublisher, 'snapshot'>;
}): Promise<CheckpointSessionComposition> {
    const inputSandboxConfig = input.sandboxConfig;
    const protection = inputSandboxConfig?.checkpointProtection;
    if (!protection) return { sandboxConfig: input.sandboxConfig };
    if (!inputSandboxConfig.enabled) {
        throw new Error('checkpoint protection requires an enabled sandbox');
    }
    const context = readCheckpointSpawnContext(input.env);
    if (!context) {
        throw new Error('checkpoint protection requires authoritative checkpoint spawn context');
    }
    await mkdir(context.checkpointRoot, { recursive: true, mode: 0o700 });
    const canonicalCheckpointRoot = await realpath(context.checkpointRoot);
    const canonicalProjectPath = await realpath(input.projectPath);
    const workspaceBinding = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
    };
    const protectionState = new CheckpointProtectionStateStore(canonicalCheckpointRoot);
    const persistedProtection = await protectionState.read({
        ...workspaceBinding,
        projectPath: canonicalProjectPath,
    });
    if (persistedProtection.protection.status === 'unavailable') {
        const { checkpointProtection: _checkpointProtection, ...unprotectedSandbox } = inputSandboxConfig;
        return { sandboxConfig: unprotectedSandbox };
    }
    const capability = resolveCheckpointProtectionCapability(input);
    if (!capability.supported) {
        throw new Error(`checkpoint protection unavailable: ${capability.reason}`);
    }
    const checkpointEvents = input.checkpointEvents;
    if (!checkpointEvents) {
        throw new Error('checkpoint protection requires a durable event publisher');
    }
    const buildRuntime = (passthroughPaths: string[] | undefined) => createCheckpointRuntime({
        provider: input.provider,
        platform: input.platform,
        projectPath: input.projectPath,
        checkpointRoot: canonicalCheckpointRoot,
        binding: {
            sessionId: input.sessionId,
            projectId: context.projectId,
            worktreeId: context.worktreeId,
        },
        protection: passthroughPaths
            ? { ...protection, readOnlyPassthroughPaths: passthroughPaths }
            : protection,
    });
    // Expose the chat-attachment upload directory to the turn workspace. A
    // passthrough is a convenience, never a gate: if no candidate can be
    // prepared or the manifest rejects them all, the session must still start
    // without one rather than fail closed on an attachment feature.
    const attachmentCandidates = await checkpointAttachmentPassthroughCandidates(
        canonicalProjectPath,
    );
    const runtime = await (async () => {
        for (const candidate of attachmentCandidates) {
            try {
                return await buildRuntime([
                    ...(protection.readOnlyPassthroughPaths ?? []),
                    candidate,
                ]);
            } catch {
                continue;
            }
        }
        return buildRuntime(undefined);
    })();

    if (runtime.status !== 'protected') {
        const reason = runtime.status === 'unavailable' ? runtime.reason : 'disabled';
        throw new Error(`checkpoint protection unavailable: ${reason}`);
    }

    const turnWorkspace = new CheckpointTurnWorkspace(canonicalCheckpointRoot);
    const sandboxConfigFor = (path: string): SandboxConfig => ({
        ...inputSandboxConfig,
        sessionIsolation: 'custom',
        customWritePaths: [path],
        denyWritePaths: [...new Set([
            ...inputSandboxConfig.denyWritePaths,
            ...runtime.denyWritePaths,
            ...runtime.excludedPaths.map((excludedPath) => join(path, excludedPath)),
            ...runtime.excludedPatterns.map((pattern) => join(path, pattern)),
            canonicalProjectPath,
        ])],
    });
    const claudeSandboxFor = (config: SandboxConfig, path: string): QueryOptions['sandbox'] => {
        const sandboxRuntime = buildSandboxRuntimeConfig(config, path);
        return {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            enableWeakerNetworkIsolation: sandboxRuntime.enableWeakerNetworkIsolation,
            network: sandboxRuntime.network,
            filesystem: sandboxRuntime.filesystem,
        };
    };
    let nextOperationId = randomUUID();
    let providerPath = turnWorkspace.pathFor({ ...workspaceBinding, operationId: nextOperationId });
    const sandboxConfig = sandboxConfigFor(providerPath);
    const claudeSandbox: QueryOptions['sandbox'] | undefined = input.provider === 'claude-remote'
        ? claudeSandboxFor(sandboxConfig, providerPath)
        : undefined;
    const rotateProviderPath = () => {
        nextOperationId = randomUUID();
        providerPath = turnWorkspace.pathFor({ ...workspaceBinding, operationId: nextOperationId });
        Object.assign(sandboxConfig, sandboxConfigFor(providerPath));
        if (claudeSandbox) Object.assign(claudeSandbox, claudeSandboxFor(sandboxConfig, providerPath));
    };
    let activeTurn: CheckpointTurnPreparation | null = null;
    let frozenWorkspacePath: string | null = null;
    let acceptsProtectedWriters = false;
    const protectedWriterTree = new CheckpointWriterProcessTree();
    const beforeTurn = async () => {
        if (activeTurn) {
            throw new Error('checkpoint protected turn is already active');
        }
        const operationId = nextOperationId;
        const currentProtection = await protectionState.read({
            ...workspaceBinding,
            projectPath: canonicalProjectPath,
        });
        if (currentProtection.protection.status !== 'protected') {
            throw new Error('checkpoint protection unavailable: excluded-path');
        }
        if (currentProtection.pendingDecision) {
            throw new Error('checkpoint excluded path decision is pending');
        }
        let snapshot;
        try {
            snapshot = await runtime.beforeTurn(operationId);
        } catch (error) {
            if (error instanceof CheckpointPolicyDriftError) {
                await protectionState.reportPending({
                    ...workspaceBinding,
                    projectPath: canonicalProjectPath,
                    operationId,
                    source: 'policy-drift',
                    excluded: error.excluded,
                });
            }
            throw error;
        }
        await checkpointEvents.snapshot({
            operationId,
            checkpointId: snapshot.checkpointId,
            excluded: runtime.excludedPaths.map((path) => ({
                path,
                reason: excludedReasonFor(runtime, path),
            })),
        });
        const workspace = await turnWorkspace.prepare({
            ...workspaceBinding,
            operationId,
            checkpointId: snapshot.checkpointId,
            projectPath: canonicalProjectPath,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        activeTurn = {
            operationId,
            checkpointId: snapshot.checkpointId,
            providerPath: workspace.path,
            sandboxConfig,
            claudeSandbox,
        };
        acceptsProtectedWriters = true;
        return activeTurn;
    };
    const protectedBashCwd = () => acceptsProtectedWriters ? activeTurn?.providerPath ?? null : null;
    const completeTurn = async (quiesceWriters: () => Promise<void>) => {
        if (!activeTurn) {
            throw new Error('checkpoint protected turn is not active');
        }
        acceptsProtectedWriters = false;
        await quiesceWriters();
        await protectedWriterTree.quiesce(() => {});
        const completedTurn = activeTurn;
        if (!frozenWorkspacePath) {
            frozenWorkspacePath = (await turnWorkspace.freeze({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            })).path;
        }
        const result = await new CheckpointTurnApplier(canonicalCheckpointRoot).execute({
            ...workspaceBinding,
            operationId: completedTurn.operationId,
            checkpointId: completedTurn.checkpointId,
            projectPath: canonicalProjectPath,
            workspacePath: frozenWorkspacePath,
            excludedPaths: runtime.excludedPaths,
            excludedPatterns: runtime.excludedPatterns,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        const excluded = result.entries.flatMap((entry) => (
            entry.action === 'conflict' && runtime.excludedReason(entry.path)
                ? [{ path: entry.path, reason: excludedReasonFor(runtime, entry.path) }]
                : []
        ));
        if (excluded.length > 0) {
            await protectionState.reportPending({
                ...workspaceBinding,
                projectPath: canonicalProjectPath,
                operationId: completedTurn.operationId,
                source: 'turn-apply',
                excluded,
            });
        }
        if (result.status === 'completed') {
            await turnWorkspace.remove({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            });
            activeTurn = null;
            frozenWorkspacePath = null;
            rotateProviderPath();
        }
        return result;
    };
    const trackProtectedWriter = (child: ChildProcess) => protectedWriterTree.track(child);
    if (input.provider !== 'claude-remote') {
        return {
            sandboxConfig,
            get providerPath() { return providerPath; },
            beforeTurn,
            completeTurn,
            protectedBashCwd,
            trackProtectedWriter,
        };
    }

    return {
        sandboxConfig,
        get providerPath() { return providerPath; },
        beforeTurn,
        completeTurn,
        protectedBashCwd,
        trackProtectedWriter,
        claudeSandbox,
    };
}

function excludedReasonFor(
    runtime: Extract<Awaited<ReturnType<typeof createCheckpointRuntime>>, { status: 'protected' }>,
    path: string,
): 'secret' | 'ignored' | 'too-large' | 'file-limit' | 'total-size-limit' {
    const reason = runtime.excludedReason(path);
    if (!reason) throw new Error('checkpoint excluded conflict is missing from the policy');
    return reason;
}
