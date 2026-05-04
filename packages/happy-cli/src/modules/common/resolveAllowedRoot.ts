/**
 * Decide which absolute path the daemon's machine-scoped RPC handlers
 * (registerCommonHandlers in this module, getDirectoryTree / readFile
 * / writeFile / etc.) should treat as the allowed working-directory
 * subtree for `validatePath`.
 *
 * Historically apiMachine.ts passed `process.cwd()` here, which made
 * the RPC surface depend on whichever shell the user happened to start
 * `happy daemon start` in. That is brittle — see
 * specs/daemon-rpc-workspace-rebase/ for the failure case discovered in
 * cross-identity-machine-socket Phase 5 (Files tab refusing the
 * project's own workspace path because the daemon was started from
 * `/`).
 *
 * This helper rebases the allowed root onto information the daemon
 * already publishes at registration time:
 *   1. Absolute `registryWorkspaceRoot` → used verbatim.
 *   2. Relative `registryWorkspaceRoot` → resolved against `homeDir`.
 *   3. None → fall back to `homeDir`, so the user's whole home subtree
 *      is reachable. Path traversal is still blocked by `validatePath`
 *      itself; we only widen the allowed prefix.
 */

import { resolve } from 'path';

export interface ResolveAllowedRootInput {
    /** workspaceRoot from the machine-registry settings. May be null/undefined. */
    registryWorkspaceRoot?: string | null;
    /** Absolute path to the user's home directory (`os.homedir()`). */
    homeDir: string;
}

function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '') || value;
}

export function resolveAllowedRoot(input: ResolveAllowedRootInput): string {
    const { registryWorkspaceRoot, homeDir } = input;
    if (!registryWorkspaceRoot) return homeDir;
    const trimmed = stripTrailingSlash(registryWorkspaceRoot);
    if (trimmed.startsWith('/')) return trimmed;
    return resolve(homeDir, trimmed);
}
