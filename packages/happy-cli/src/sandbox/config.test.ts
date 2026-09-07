import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSandboxRuntimeConfig, filterCredentialsFromEnv } from './config';
import type { SandboxConfig } from '@/persistence';

const sessionPath = '/tmp/happy-session';

function resolveLikeRuntime(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }
    return resolve(sessionPath, expandedHome);
}

function expectedSharedAgentStatePaths(): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    return [...new Set([
        resolveLikeRuntime(codexHome),
        resolveLikeRuntime(claudeConfigDir),
    ])];
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/projects',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('buildSandboxRuntimeConfig', () => {
    it('builds strict filesystem isolation', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'strict' }),
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const withWorkspaceRoot = buildSandboxRuntimeConfig(createConfig(), sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);

        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            createConfig({ workspaceRoot: undefined }),
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('builds custom isolation from explicit custom paths', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/sandbox', 'relative/write'],
                extraWritePaths: ['/tmp', '../scratch'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/sandbox`,
            resolve(sessionPath, 'relative/write'),
            '/tmp',
            resolve(sessionPath, '../scratch'),
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('maps blocked and allowed network modes', () => {
        const blocked = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'blocked', allowLocalBinding: false }),
            sessionPath,
        );
        expect(blocked.network?.allowedDomains).toEqual([]);
        expect(blocked.network?.deniedDomains).toEqual([]);
        expect(blocked.network?.allowLocalBinding).toBe(false);
        expect(blocked.enableWeakerNetworkIsolation).toBeUndefined();

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed' }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toBeUndefined();
        expect(allowed.network?.deniedDomains).toEqual([]);
        expect(allowed.enableWeakerNetworkIsolation).toBe(true);
    });

    it('maps custom network mode from user lists', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                networkMode: 'custom',
                allowedDomains: ['*.github.com', 'api.openai.com'],
                deniedDomains: ['tracking.example.com'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.network?.allowedDomains).toEqual(['*.github.com', 'api.openai.com']);
        expect(runtimeConfig.network?.deniedDomains).toEqual(['tracking.example.com']);
    });

    it('resolves tilde and relative paths across all filesystem path fields', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/custom', 'relative/custom'],
                extraWritePaths: ['~/extra', './extra'],
                denyReadPaths: ['~/.ssh', 'relative/read'],
                denyWritePaths: ['.env', 'relative/write-deny'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/custom`,
            resolve(sessionPath, 'relative/custom'),
            `${homedir()}/extra`,
            resolve(sessionPath, './extra'),
            ...expectedSharedAgentStatePaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
        ]);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '.env'),
            resolve(sessionPath, 'relative/write-deny'),
        ]);
    });

    it('includes overridden CODEX_HOME and CLAUDE_CONFIG_DIR in allowWrite', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '~/custom-codex-home';
            process.env.CLAUDE_CONFIG_DIR = './custom-claude-config';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath);

            expect(runtimeConfig.filesystem?.allowWrite).toContain(`${homedir()}/custom-codex-home`);
            expect(runtimeConfig.filesystem?.allowWrite).toContain(resolve(sessionPath, './custom-claude-config'));
        } finally {
            if (originalCodexHome === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = originalCodexHome;
            }

            if (originalClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
            }
        }
    });
});

describe('buildSandboxRuntimeConfig with a linked git worktree', () => {
    const createdRoots: string[] = [];

    afterEach(() => {
        for (const root of createdRoots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function createLinkedWorktree(): { worktreePath: string; commonGitDir: string } {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);

        const mainRepo = join(root, 'main-repo');
        const worktreePath = join(root, 'linked-worktree');
        execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', mainRepo]);
        execFileSync('git', ['-C', mainRepo, 'config', 'user.name', 'Happy Test']);
        execFileSync('git', ['-C', mainRepo, 'config', 'user.email', 'happy-test@example.com']);
        writeFileSync(join(mainRepo, 'tracked.txt'), 'initial\n');
        execFileSync('git', ['-C', mainRepo, 'add', 'tracked.txt']);
        execFileSync('git', ['-C', mainRepo, 'commit', '-m', 'initial']);
        execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'linked', worktreePath]);

        return { worktreePath, commonGitDir: realpathSync(join(mainRepo, '.git')) };
    }

    it('adds the resolved common gitdir to allowWrite so git add/fetch/commit can write index.lock, FETCH_HEAD, and refs', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).toContain(commonGitDir);
    });

    it('does not trust an arbitrary gitdir when no commondir file exists', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        const worktreePath = join(root, 'linked-worktree');
        const worktreeGitDir = join(root, 'main-repo', '.git', 'worktrees', 'linked-worktree');
        mkdirSync(worktreeGitDir, { recursive: true });
        mkdirSync(worktreePath, { recursive: true });
        writeFileSync(join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain(worktreeGitDir);
    });

    it('does not widen allowWrite for an attacker-selected gitdir', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        writeFileSync(join(root, '.git'), 'gitdir: /\n');

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ sessionIsolation: 'strict' }), root);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/');
    });

    it('does not throw or widen allowWrite when the gitfile is unreadable', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();
        const gitFile = join(worktreePath, '.git');
        chmodSync(gitFile, 0);

        try {
            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(commonGitDir);
        } finally {
            chmodSync(gitFile, 0o600);
        }
    });

    it('does not widen allowWrite when commondir is tampered with', () => {
        const { worktreePath } = createLinkedWorktree();
        const gitFileValue = readFileSync(join(worktreePath, '.git'), 'utf8');
        const worktreeGitDir = gitFileValue.match(/^gitdir:\s*(.+)\s*$/)?.[1];
        expect(worktreeGitDir).toBeDefined();
        writeFileSync(join(worktreeGitDir!, 'commondir'), '/\n');

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ sessionIsolation: 'strict' }), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/');
    });

    it('discovers linked-worktree metadata when the session starts in a subdirectory', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();
        const nestedSessionPath = join(worktreePath, 'nested');
        mkdirSync(nestedSessionPath);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), nestedSessionPath);

        expect(runtimeConfig.filesystem?.allowWrite).toContain(commonGitDir);
    });

    it('does not add anything for a regular checkout where .git is a directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        mkdirSync(join(root, '.git'), { recursive: true });

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ workspaceRoot: undefined }), root);

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(root),
            '/tmp',
            ...expectedSharedAgentStatePathsFor(root),
        ]);
    });

    it('does not throw and adds nothing when there is no .git at all', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ workspaceRoot: undefined }), root);

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(root),
            '/tmp',
            ...expectedSharedAgentStatePathsFor(root),
        ]);
    });
});

function expectedSharedAgentStatePathsFor(sessionPathForTest: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    const expand = (pathValue: string) => {
        const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
        return isAbsolute(expandedHome) ? expandedHome : resolve(sessionPathForTest, expandedHome);
    };
    return [...new Set([expand(codexHome), expand(claudeConfigDir)])];
}

describe('filterCredentialsFromEnv', () => {
    it('removes inherited GitHub and cloud credentials while preserving runtime variables', () => {
        expect(filterCredentialsFromEnv({
            GH_TOKEN: 'github-secret',
            AWS_ACCESS_KEY_ID: 'aws-secret',
            PATH: '/usr/bin',
            APLUS_AGENT_TASK_ID: 'task-1',
        })).toEqual({
            PATH: '/usr/bin',
            APLUS_AGENT_TASK_ID: 'task-1',
        });
    });
});
