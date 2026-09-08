import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { CheckpointEventDetail } from './checkpointContract';

export type CheckpointProvider = 'claude-remote' | 'codex' | string;

export type CheckpointProtectionCapability =
    | { supported: true }
    | {
        supported: false;
        reason: 'unsupported-platform' | 'unsupported-provider';
    };

export type CheckpointExclusionPolicy = {
    projectPath: string;
    secretPatterns: string[];
    maxFileBytes: number;
    maxFiles: number;
    maxTotalBytes: number;
    readOnlyPassthroughPaths?: string[];
};

type CheckpointExcludedPath = CheckpointEventDetail['summary']['excluded'][number];

export type CheckpointExclusionManifest = {
    excluded: CheckpointExcludedPath[];
    denyWritePaths: string[];
    readOnlyPassthroughPaths: string[];
    fingerprint: string;
};

export class CheckpointPolicyDriftError extends Error {
    readonly action = 'restart-sandbox-or-disable-protection' as const;

    constructor(readonly excluded: CheckpointExcludedPath[] = []) {
        super('checkpoint exclusion policy changed; restart sandbox or disable protection');
        this.name = 'CheckpointPolicyDriftError';
    }
}

export function resolveCheckpointProtectionCapability(input: {
    platform: NodeJS.Platform;
    provider: CheckpointProvider;
}): CheckpointProtectionCapability {
    if (input.platform !== 'darwin') {
        return { supported: false, reason: 'unsupported-platform' };
    }
    if (input.provider !== 'claude-remote' && input.provider !== 'codex') {
        return { supported: false, reason: 'unsupported-provider' };
    }
    return { supported: true };
}

export class CheckpointExclusionGuard {
    readonly manifest: CheckpointExclusionManifest;
    private readonly policy: CheckpointExclusionPolicy;

    private constructor(policy: CheckpointExclusionPolicy, manifest: CheckpointExclusionManifest) {
        this.policy = policy;
        this.manifest = manifest;
    }

    get secretPatterns(): string[] {
        return [...this.policy.secretPatterns];
    }

    excludedReason(path: string): CheckpointExcludedPath['reason'] | null {
        const manifestEntry = this.manifest.excluded.find((entry) => entry.path === path);
        if (manifestEntry) return manifestEntry.reason;
        return ignore().add(this.policy.secretPatterns).ignores(path) ? 'secret' : null;
    }

    static async create(policy: CheckpointExclusionPolicy): Promise<CheckpointExclusionGuard> {
        const canonicalProjectPath = await realpath(policy.projectPath);
        const canonicalPolicy = {
            ...policy,
            projectPath: canonicalProjectPath,
            secretPatterns: normalizeSecretPatterns(policy.secretPatterns),
        };
        return new CheckpointExclusionGuard(
            canonicalPolicy,
            await buildCheckpointExclusionManifest(canonicalPolicy),
        );
    }

    async dispatchAfterPolicyCheck<T>(dispatch: () => Promise<T>): Promise<T> {
        const current = await buildCheckpointExclusionManifest(this.policy);
        if (current.fingerprint !== this.manifest.fingerprint) {
            throw new CheckpointPolicyDriftError(changedExclusions(
                this.manifest.excluded,
                current.excluded,
            ));
        }
        return dispatch();
    }
}

function changedExclusions(
    previous: CheckpointExcludedPath[],
    current: CheckpointExcludedPath[],
): CheckpointExcludedPath[] {
    const previousByPath = new Map(previous.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
    return [...new Set([...previousByPath.keys(), ...currentByPath.keys()])]
        .filter((path) => previousByPath.get(path)?.reason !== currentByPath.get(path)?.reason)
        .map((path) => currentByPath.get(path) ?? previousByPath.get(path)!)
        .sort((left, right) => left.path.localeCompare(right.path));
}

async function buildCheckpointExclusionManifest(
    policy: CheckpointExclusionPolicy,
): Promise<CheckpointExclusionManifest> {
    validateLimits(policy);
    const projectPath = resolve(policy.projectPath);
    const files = await listProjectFiles(projectPath);
    const secretMatcher = ignore().add(policy.secretPatterns);
    const excluded: CheckpointExcludedPath[] = [];
    const candidates: Array<{ path: string; size: number }> = [];

    for (const file of files) {
        if (secretMatcher.ignores(file.path)) {
            excluded.push({ path: file.path, reason: 'secret' });
        } else if (file.ignored) {
            excluded.push({ path: file.path, reason: 'ignored' });
        } else if (file.size > policy.maxFileBytes) {
            excluded.push({ path: file.path, reason: 'too-large' });
        } else {
            candidates.push(file);
        }
    }

    let totalBytes = 0;
    let includedFiles = 0;
    for (const file of candidates) {
        if (includedFiles >= policy.maxFiles) {
            excluded.push({ path: file.path, reason: 'file-limit' });
        } else if (totalBytes + file.size > policy.maxTotalBytes) {
            excluded.push({ path: file.path, reason: 'total-size-limit' });
        } else {
            includedFiles += 1;
            totalBytes += file.size;
        }
    }

    excluded.sort((left, right) => left.path.localeCompare(right.path));
    const readOnlyPassthroughPaths = normalizeReadOnlyPassthroughPaths(
        policy.readOnlyPassthroughPaths ?? [],
    );
    for (const path of readOnlyPassthroughPaths) {
        const exclusion = excluded.find((entry) => (
            entry.reason === 'ignored'
            && (entry.path === path || path.startsWith(`${entry.path}/`))
        ));
        const absolutePath = join(projectPath, path);
        const stats = await lstat(absolutePath);
        const canonicalPath = await realpath(absolutePath);
        const canonicalRelativePath = relative(projectPath, canonicalPath);
        const exclusionStats = exclusion
            ? await lstat(join(projectPath, exclusion.path))
            : null;
        if (
            !exclusion
            || !exclusionStats?.isDirectory()
            || exclusionStats.isSymbolicLink()
            || !stats.isDirectory()
            || stats.isSymbolicLink()
            || canonicalRelativePath === ''
            || canonicalRelativePath === '..'
            || canonicalRelativePath.startsWith(`..${sep}`)
            || isAbsolute(canonicalRelativePath)
        ) {
            throw new Error('checkpoint read-only passthrough must be an ignored directory');
        }
    }
    const denyWritePaths = [...new Set([
        ...policy.secretPatterns.map((pattern) => join(projectPath, pattern)),
        ...excluded.map((entry) => join(projectPath, entry.path)),
    ])].sort();
    const fingerprint = createHash('sha256')
        .update(JSON.stringify({
            secretPatterns: [...policy.secretPatterns].sort(),
            limits: [policy.maxFileBytes, policy.maxFiles, policy.maxTotalBytes],
            excluded,
            denyWritePaths,
            readOnlyPassthroughPaths,
        }))
        .digest('hex');

    return { excluded, denyWritePaths, readOnlyPassthroughPaths, fingerprint };
}

function normalizeReadOnlyPassthroughPaths(paths: string[]): string[] {
    return [...new Set(paths.map((path) => {
        if (
            path.length === 0
            || path.includes('\0')
            || /^(?:[A-Za-z]:|[\\/])/.test(path)
            || path.split(/[\\/]+/).includes('..')
        ) {
            throw new Error('checkpoint read-only passthrough must be a project-relative path');
        }
        return path.split(/[\\/]+/).filter(Boolean).join('/');
    }))].sort();
}

function normalizeSecretPatterns(patterns: string[]): string[] {
    return [...new Set(patterns.map((pattern) => {
        if (
            pattern.length === 0
            || pattern.startsWith('/')
            || pattern.startsWith('!')
            || pattern.split('/').includes('..')
        ) {
            throw new Error('checkpoint secret patterns must be project-relative deny globs');
        }
        return pattern.includes('/') ? pattern : `**/${pattern}`;
    }))].sort();
}

function validateLimits(policy: CheckpointExclusionPolicy): void {
    for (const value of [policy.maxFileBytes, policy.maxFiles, policy.maxTotalBytes]) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error('checkpoint exclusion limits must be non-negative safe integers');
        }
    }
}

async function readGitignore(directory: string): Promise<string | null> {
    try {
        return await readFile(join(directory, '.gitignore'), 'utf8');
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

type IgnoreScope = { directory: string; matcher: Ignore };
type ProjectEntry = { path: string; size: number; ignored: boolean };

async function listProjectFiles(projectPath: string): Promise<ProjectEntry[]> {
    const files: ProjectEntry[] = [];
    await scanDirectory(projectPath, projectPath, [], files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function scanDirectory(
    projectPath: string,
    directory: string,
    scopes: IgnoreScope[],
    files: ProjectEntry[],
): Promise<void> {
    const gitignore = await readGitignore(directory);
    const directoryPath = relative(projectPath, directory).split(sep).join('/');
    const localScopes = gitignore === null
        ? scopes
        : [...scopes, { directory: directoryPath, matcher: ignore().add(gitignore) }];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (directory === projectPath && entry.name === '.git') continue;
        const absolutePath = join(directory, entry.name);
        const filePath = relative(projectPath, absolutePath).split(sep).join('/');
        const ignored = entry.name !== '.gitignore'
            && isIgnored(filePath, entry.isDirectory(), localScopes);
        if (ignored) {
            files.push({ path: filePath, size: 0, ignored: true });
        } else if (entry.isDirectory()) {
            await scanDirectory(projectPath, absolutePath, localScopes, files);
        } else {
            files.push({ path: filePath, size: (await lstat(absolutePath)).size, ignored: false });
        }
    }
}

function isIgnored(path: string, isDirectory: boolean, scopes: IgnoreScope[]): boolean {
    let ignored = false;
    for (const scope of scopes) {
        const scopedPath = scope.directory === ''
            ? path
            : path.startsWith(`${scope.directory}/`)
                ? path.slice(scope.directory.length + 1)
                : null;
        if (scopedPath === null) continue;
        const result = scope.matcher.test(isDirectory ? `${scopedPath}/` : scopedPath);
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
    }
    return ignored;
}
