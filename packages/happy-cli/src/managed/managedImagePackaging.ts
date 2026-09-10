/**
 * Where the managed runtime image puts the pieces the isolated executor runs,
 * and what they must look like when it gets there.
 *
 * The executor's trusted helper refuses to `execve` anything that is not
 * root-owned or that is writable by group or other. `0755` would clear that
 * bar too, so `0555` is not what makes the workload runnable — it is a
 * read-only contract that goes further than the helper requires: nothing in
 * the running image has a reason to rewrite the code the agent is about to
 * become. The two files it reads are `0444` for the same reason.
 *
 * The check below compares the **exact** bits rather than a minimum, so a
 * packaging drift is a build failure instead of a silently looser image.
 *
 * This module exists so there is exactly one statement of that layout. The
 * image build follows it, `assertManagedImageLayout` checks it from inside the
 * built image, and `startManagedToolSession` takes its `workloadPath` from it —
 * three consumers that would otherwise each carry their own copy of the same
 * path and drift apart silently.
 *
 * `sqlite3` is here for the same reason: without it every project with a
 * SQLite database fails its checkpoint preflight (`unsupported-database`), and
 * an image that ships without it turns that into the normal case.
 */
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const MANAGED_IMAGE_LIB_DIR = '/usr/local/lib/saycode';

export type ManagedImageArtifact = {
    path: string;
    /** Exact permission bits, not a minimum. */
    mode: number;
    role: 'executable' | 'data';
};

/**
 * The executor's `execve` target. Fixed, because the helper validates the path
 * it was handed and a caller that could choose it could choose anything.
 */
export const MANAGED_TOOL_WORKLOAD_PATH = join(MANAGED_IMAGE_LIB_DIR, 'tool-workload');

export const MANAGED_IMAGE_ARTIFACTS: readonly ManagedImageArtifact[] = [
    { path: MANAGED_TOOL_WORKLOAD_PATH, mode: 0o555, role: 'executable' },
    { path: join(MANAGED_IMAGE_LIB_DIR, 'tool-workload.mjs'), mode: 0o444, role: 'data' },
    { path: join(MANAGED_IMAGE_LIB_DIR, 'toolRuntime.cjs'), mode: 0o444, role: 'data' },
];

/** Programs the image must carry for a checkpoint to be able to complete. */
export const MANAGED_IMAGE_PROGRAMS: readonly string[] = ['sqlite3'];

export type ManagedImageLayoutProblem =
    | { path: string; reason: 'missing' }
    | { path: string; reason: 'not-a-regular-file' }
    | { path: string; reason: 'not-root-owned'; uid: number }
    | { path: string; reason: 'wrong-mode'; mode: number; expected: number }
    | { path: string; reason: 'program-missing' };

export type ManagedImageLayoutDeps = {
    lstatPath: (path: string) => Promise<{ uid: number; mode: number; isFile: boolean }>;
    /** Resolves a program on PATH; `null` when it is not there. */
    findProgram: (name: string) => Promise<string | null>;
};

export const defaultManagedImageLayoutDeps: ManagedImageLayoutDeps = {
    lstatPath: async (path) => {
        const entry = await lstat(path);
        return { uid: entry.uid, mode: entry.mode & 0o7777, isFile: entry.isFile() };
    },
    findProgram: async (name) => {
        for (const directory of (process.env.PATH ?? '').split(':')) {
            if (!directory) continue;
            const candidate = join(directory, name);
            try {
                await access(candidate, constants.X_OK);
                return candidate;
            } catch { /* keep looking */ }
        }
        return null;
    },
};

/**
 * Checks the layout of a built image. Reports every problem rather than the
 * first: a build that is wrong in three places should say so once.
 *
 * `prefix` exists for verifying a staged tree before it becomes an image; in
 * the image itself it is empty.
 */
export async function assertManagedImageLayout(input?: {
    prefix?: string;
    deps?: Partial<ManagedImageLayoutDeps>;
}): Promise<ManagedImageLayoutProblem[]> {
    const deps = { ...defaultManagedImageLayoutDeps, ...input?.deps };
    const prefix = input?.prefix ?? '';
    const problems: ManagedImageLayoutProblem[] = [];

    for (const artifact of MANAGED_IMAGE_ARTIFACTS) {
        const path = `${prefix}${artifact.path}`;
        let entry: { uid: number; mode: number; isFile: boolean };
        try {
            entry = await deps.lstatPath(path);
        } catch {
            problems.push({ path: artifact.path, reason: 'missing' });
            continue;
        }
        // `lstat`, so a symlink is a finding rather than something followed to
        // a file that happens to look right.
        if (!entry.isFile) {
            problems.push({ path: artifact.path, reason: 'not-a-regular-file' });
            continue;
        }
        if (entry.uid !== 0) problems.push({ path: artifact.path, reason: 'not-root-owned', uid: entry.uid });
        if (entry.mode !== artifact.mode) {
            problems.push({ path: artifact.path, reason: 'wrong-mode', mode: entry.mode, expected: artifact.mode });
        }
    }

    for (const program of MANAGED_IMAGE_PROGRAMS) {
        if (await deps.findProgram(program) === null) {
            problems.push({ path: program, reason: 'program-missing' });
        }
    }
    return problems;
}
