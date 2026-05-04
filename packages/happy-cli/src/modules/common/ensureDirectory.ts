/**
 * Ensures a directory exists under the daemon's allowed working
 * directory, creating any missing parents along the way. The complement
 * to `validatePath` — same prefix-match defense, but does the mkdir
 * instead of just refusing.
 *
 * specs/project-workspace-auto-create/ Phase 1.
 *
 * Used by the `ensureDirectory` RPC handler (so web-ui can guarantee
 * a project's workspaceDir exists before opening a terminal there) and
 * by `writeFile` (Phase 2 — so first-write to a new project doesn't
 * fail with ENOENT on the parent).
 *
 * Idempotent: returns success even when the directory already exists.
 * `mkdir({ recursive: true })` already swallows EEXIST, so this is
 * effectively a single fs call plus the path validation gate.
 */

import { mkdir } from 'fs/promises';
import { validatePath } from './pathSecurity';

export interface EnsureDirectoryResult {
    success: boolean;
    resolvedPath?: string;
    error?: string;
}

export async function ensureDirectory(
    targetPath: string,
    workingDirectory: string,
): Promise<EnsureDirectoryResult> {
    const validation = validatePath(targetPath, workingDirectory);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }
    try {
        await mkdir(validation.resolvedPath!, { recursive: true });
        return { success: true, resolvedPath: validation.resolvedPath };
    } catch (e) {
        return {
            success: false,
            resolvedPath: validation.resolvedPath,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
