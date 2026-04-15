import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        expandPath(codexHome, sessionPath),
        expandPath(claudeConfigDir, sessionPath),
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

const CREDENTIAL_PATTERNS: RegExp[] = [
    /^(AWS|AZURE|GCP|GOOGLE)_/i,
    /^(ANTHROPIC|OPENAI|GEMINI)_API_KEY$/i,
    /_(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i,
    /^(DATABASE_URL|REDIS_URL)$/i,
    /^S3_(ACCESS_KEY|SECRET_KEY|HOST)$/i,
    /^HAPPY_(MASTER_SECRET)$/i,
];

const SAFE_ENV_ALLOWLIST = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
    'EDITOR', 'VISUAL', 'PAGER', 'TZ', 'TMPDIR',
    'WORKSPACE', 'HAPPY_PROJECT_SANDBOX_CONFIG', 'HAPPY_HOME_DIR',
    'PORT', 'HOST', 'DEBUG', 'VERBOSE',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
]);

/**
 * Filter environment variables to remove credentials before passing to sandboxed processes.
 * Allowlisted vars always pass. Credential-pattern vars are always removed. Others pass through.
 */
export function filterCredentialsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (SAFE_ENV_ALLOWLIST.has(key)) {
            filtered[key] = value;
            continue;
        }
        const isCredential = CREDENTIAL_PATTERNS.some(pattern => pattern.test(key));
        if (!isCredential) {
            filtered[key] = value;
        }
    }
    return filtered;
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sessionPath);

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead: resolvePaths(sandboxConfig.denyReadPaths, sessionPath),
            allowWrite,
            denyWrite: resolvePaths(sandboxConfig.denyWritePaths, sessionPath),
        },
    };
}
