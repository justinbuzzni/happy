import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

describe('createCheckpointSessionComposition', () => {
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-composition-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 1024,
        maxFiles: 100,
        maxTotalBytes: 4096,
    };
    const checkpointEvents = {
        snapshot: async () => ({
            id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
        }),
    };

    function contextEnv() {
        return {
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                schemaVersion: 1,
                projectId: 'project-1',
                worktreeId: null,
                checkpointRoot,
            }),
        };
    }

    it('does not create a gate when checkpoint protection was not explicitly configured', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({});
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        });

        expect(result).toEqual({ sandboxConfig });
    });

    it('fails closed without a daemon-owned binding or on an unsupported platform', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({ checkpointProtection: protection });
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        })).rejects.toThrow('authoritative checkpoint spawn context');
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'linux',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: contextEnv(),
        })).rejects.toThrow('unsupported-platform');
        await expect(lstat(join(projectPath, '.aplus'))).rejects.toThrow();
    });

    it('fails closed when a protected runtime has no durable event publisher', async () => {
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
        })).rejects.toThrow('durable event publisher');
        await expect(lstat(join(projectPath, '.aplus'))).rejects.toThrow();
    });

    it.each(['claude-remote', 'codex'] as const)(
        'binds %s sandbox and turn gate to the same protected runtime',
        async (provider) => {
            const result = await createCheckpointSessionComposition({
                provider,
                platform: 'darwin',
                projectPath,
                sessionId: 'session-1',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: protection,
                    denyWritePaths: ['existing-deny'],
                }),
                env: contextEnv(),
                checkpointEvents,
            });
            const canonicalProjectPath = await realpath(projectPath);
            if (!result.sandboxConfig) throw new Error('expected protected sandbox config');

            expect(result.providerPath).toEqual(expect.any(String));
            expect(result.sandboxConfig.sessionIsolation).toBe('custom');
            expect(result.sandboxConfig.customWritePaths).toEqual([result.providerPath]);
            expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
                'existing-deny',
                canonicalProjectPath,
                join(canonicalProjectPath, '**', '.env*'),
            ]));
            expect(result.beforeTurn).toEqual(expect.any(Function));
            const turn = await result.beforeTurn?.();
            const canonicalCheckpointRoot = await realpath(checkpointRoot);
            expect(turn).toMatchObject({
                operationId: expect.any(String),
                checkpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
                providerPath: result.providerPath,
                sandboxConfig: {
                    denyWritePaths: expect.arrayContaining([canonicalProjectPath]),
                },
            });
            expect(turn!.providerPath.startsWith(`${canonicalCheckpointRoot}${sep}`)).toBe(true);
            await expect(readFile(join(turn!.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
            if (provider === 'claude-remote') {
                expect(turn!.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        allowWrite: expect.arrayContaining([turn!.providerPath]),
                        denyWrite: expect.arrayContaining([canonicalProjectPath]),
                    },
                });
                expect(turn!.claudeSandbox?.filesystem?.denyWrite).toEqual(expect.arrayContaining([
                    join(turn!.providerPath, '**', '.env*'),
                ]));
                expect(result.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        denyWrite: expect.arrayContaining([
                            join(result.providerPath!, 'existing-deny'),
                            join(canonicalProjectPath, '**', '.env*'),
                            canonicalProjectPath,
                        ]),
                    },
                });
            } else {
                expect(result.claudeSandbox).toBeUndefined();
            }
        },
    );

    it('waits for a durable snapshot event acknowledgement before opening the provider turn', async () => {
        const snapshot = vi.fn()
            .mockRejectedValueOnce(new Error('event server unavailable'))
            .mockResolvedValueOnce({
                id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: true,
            });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents: { snapshot },
        });

        await expect(result.beforeTurn?.()).rejects.toThrow('event server unavailable');
        expect(result.protectedBashCwd?.()).toBeNull();
        const retry = await result.beforeTurn?.();

        expect(retry).toBeDefined();
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(snapshot.mock.calls[1]?.[0]).toEqual(snapshot.mock.calls[0]?.[0]);
        expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
            operationId: retry?.operationId,
            checkpointId: retry?.checkpointId,
        });
    });

    it('applies an isolated diff only after the provider writer tree is quiescent', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        expect(result.protectedBashCwd?.()).toBeNull();
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        expect(result.protectedBashCwd?.()).toBe(turn.providerPath);
        await writeFile(join(turn.providerPath, 'source.txt'), 'agent change');

        let releaseQuiescence!: () => void;
        const quiescence = new Promise<void>((resolve) => {
            releaseQuiescence = resolve;
        });
        const completion = result.completeTurn(() => quiescence);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        releaseQuiescence();
        await expect(completion).resolves.toMatchObject({
            status: 'completed',
            entries: [{ path: 'source.txt', action: 'write', outcome: 'written' }],
        });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent change');
        expect(result.protectedBashCwd?.()).toBeNull();
    });

    it('rotates the sandbox to a never-reused provider workspace after each completed turn', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'first turn');
        await result.completeTurn(async () => {});
        const second = await result.beforeTurn();

        expect(second.providerPath).not.toBe(first.providerPath);
        expect(result.providerPath).toBe(second.providerPath);
        expect(result.sandboxConfig?.customWritePaths).toEqual([second.providerPath]);
        expect(result.claudeSandbox?.filesystem?.allowWrite).toContain(second.providerPath);
        expect(result.claudeSandbox?.filesystem?.allowWrite).not.toContain(first.providerPath);
        expect(second.operationId).not.toBe(first.operationId);
        expect(second.checkpointId).not.toBe(first.checkpointId);
        await expect(readFile(join(second.providerPath, 'source.txt'), 'utf8')).resolves.toBe('first turn');
        await result.completeTurn(async () => {});
    });

    it('records a daemon-readable pending decision when policy drift blocks dispatch', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        await writeFile(join(projectPath, '.env.production'), 'secret');

        await expect(result.beforeTurn?.()).rejects.toMatchObject({
            name: 'CheckpointPolicyDriftError',
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: expect.any(String),
                source: 'policy-drift',
                excluded: [{ path: '.env.production', reason: 'secret' }],
            },
        });
    });

    it('records an excluded-path conflict discovered by the turn applier', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        await writeFile(join(turn.providerPath, '.env.future'), 'sandbox bypass');

        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({
            entries: [{ path: '.env.future', action: 'conflict', outcome: 'conflict' }],
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: turn.operationId,
                source: 'turn-apply',
                excluded: [{ path: '.env.future', reason: 'secret' }],
            },
        });
        await expect(result.beforeTurn?.()).rejects.toThrow('excluded path decision is pending');
    });

    it('starts a restarted session without checkpoint protection after explicit disable', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        } as const;
        await state.reportPending({
            ...binding,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [],
        });
        await state.resolveDecision({
            ...binding,
            operationId: 'turn-1',
            decision: 'disable-protection',
        });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        expect(result.beforeTurn).toBeUndefined();
        expect(result.sandboxConfig?.checkpointProtection).toBeUndefined();
        expect(result.sandboxConfig?.enabled).toBe(true);
    });

    it('exposes files written to .aplus/uploads/ before a turn through the provider path', async () => {
        await writeFile(join(projectPath, '.gitignore'), '.aplus/\n');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        await mkdir(join(projectPath, '.aplus', 'uploads'), { recursive: true });
        await writeFile(join(projectPath, '.aplus', 'uploads', 'attachment.txt'), 'uploaded content');
        await writeFile(join(projectPath, '.aplus', '.env.production'), 'dummy-secret');

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        await expect(readFile(join(turn.providerPath, '.aplus', 'uploads', 'attachment.txt'), 'utf8'))
            .resolves.toBe('uploaded content');
        await expect(lstat(join(turn.providerPath, '.aplus', '.env.production'))).rejects.toThrow();
    });

    it('exposes .aplus/uploads through the provider path when the root gitignore never mentions .aplus', async () => {
        await writeFile(join(projectPath, '.gitignore'), 'dist/\n');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        await writeFile(join(projectPath, '.aplus', 'uploads', 'attachment.txt'), 'narrow shape');

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        await expect(readFile(join(turn.providerPath, '.aplus', 'uploads', 'attachment.txt'), 'utf8'))
            .resolves.toBe('narrow shape');
    });

    it('does not reject with policy drift when a file larger than maxFileBytes is uploaded after composition', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        await result.completeTurn(async () => {});

        await mkdir(join(projectPath, '.aplus', 'uploads'), { recursive: true });
        const largeBuffer = Buffer.alloc(4096, 1);
        await writeFile(join(projectPath, '.aplus', 'uploads', 'oversized.bin'), largeBuffer);

        await expect(result.beforeTurn?.()).resolves.toBeDefined();
    });

    it('falls back to no passthrough when .aplus/.gitignore exists with tracked content', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus', '.gitignore'), 'uploads/\n');
        await writeFile(join(projectPath, '.aplus', 'tracked.txt'), 'keep me');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        // No passthrough was registered, so the upload directory is absent from
        // the workspace — but the project's own tracked file is still snapshotted.
        await expect(lstat(join(turn.providerPath, '.aplus', 'uploads'))).rejects.toThrow();
        await expect(readFile(join(turn.providerPath, '.aplus', 'tracked.txt'), 'utf8'))
            .resolves.toBe('keep me');
    });
});
