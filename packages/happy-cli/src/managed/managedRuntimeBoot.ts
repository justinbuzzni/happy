/**
 * specs/managed-cloud-byos §5.36 — the root boot stage of a managed runtime.
 *
 * This is what runs **before the daemon and before the agent uid is used for
 * anything**, as root, once per boot. It does the three things that can only
 * be done from there, and then gets out of the way:
 *
 *  1. **Makes the trusted directory** the supervisor's socket will live in —
 *     root-owned, `0700`, inside the canonical state directory the provisioning
 *     marker names. Not `/tmp`, not a path from the environment: the socket is
 *     the authority that proves generations are gone, and a socket anybody can
 *     replace is an authority anybody can impersonate.
 *  2. **Starts the supervisor and publishes where it is.** The record is
 *     written only after the socket is listening, so a daemon that finds a
 *     record finds something behind it.
 *  3. **Hands the workspace to the uid that will actually write in it.** The
 *     agent runs as a separate uid; a `root:root 0755` project root means every
 *     write the agent makes fails with `EACCES` — the tool boundary would be
 *     enforced correctly and the runtime would still be useless.
 *
 * ## What it refuses to do
 *
 * It never falls back. No marker, an untrusted marker, a state directory it
 * cannot make safe, a supervisor that will not start — each ends the boot. The
 * fallback in every one of those cases is "run the agent anyway, unfenced",
 * which is the exact state the whole design exists to prevent.
 *
 * It also never puts the boot token anywhere but the record. Not in the
 * environment it hands on, not in a log line, not in an error detail: the
 * provider process started later inherits an environment, and a token there is
 * a token the agent can read out of `/proc`.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    resolveManagedRuntimeIdentity,
    defaultProvisioningDeps,
    MANAGED_PROJECT_ROOT,
    type ManagedProvisioningDeps,
    type ManagedRuntimeIdentity,
} from '@/daemon/managedRuntimeIdentity';
import {
    readManagedLauncherBinding,
    writeManagedLauncherBinding,
} from '@/daemon/launch/managedLauncherBinding';
import { createSupervisorRuntime } from '@/launcher/main';
import {
    adoptManagedDaemonCredential,
    type ManagedCredentialAdoption,
} from '@/daemon/managedDaemonCredentialInput';

/** The socket lives here, under the state directory root already owns. */
export function managedLauncherDirectory(stateDir: string): string {
    return join(stateDir, 'launcher');
}

export function managedLauncherSocketPath(stateDir: string): string {
    return join(managedLauncherDirectory(stateDir), 'launcher.sock');
}

/**
 * Where codex keeps its own state. Beside the workspace, never inside it: the
 * executor owns the workspace tree, and codex's state is the provider's.
 */
export function managedCodexHome(): string {
    return '/workspace/.codex';
}

/**
 * Where a checkpoint restore stages its tree before promoting it.
 *
 * **On the volume**, beside the destinations, because promotion is a `rename`
 * and `rename` does not cross filesystems. Staged anywhere else — `/tmp`, the
 * state directory on the boot disk — every promotion fails with `EXDEV` and the
 * runtime comes up with the volume it was supposed to restore into untouched.
 */
export const MANAGED_RESTORE_STAGING_ROOT = '/workspace/.saycode-restore';

export type ManagedRuntimeBootRefusal =
    | 'not-managed'
    | 'identity-refused'
    | 'trusted-directory-unavailable'
    | 'supervisor-unavailable'
    | 'binding-unpublishable'
    | 'workspace-unassignable'
    /**
     * An interrupted promotion left trees whose fate nobody has established.
     * The runtime does not start and nothing is deleted — the leftovers may be
     * the only copy of what a destination used to hold.
     */
    | 'restore-unresolved'
    /**
     * The identity the parent delivered is not one this runtime may run as, or
     * could not be made its own. Separate from `identity-refused`, which is
     * about the marker: this machine knows what it is and cannot prove who it
     * is to the server.
     */
    | 'credential-unusable';

export type ManagedRuntimeBootOutcome =
    | { ok: true; socketPath: string; published: 'created' | 'existing' }
    | { ok: false; reason: ManagedRuntimeBootRefusal };

export type ManagedRuntimeBootDeps = {
    /**
     * Starts the supervisor. Injected rather than imported so this decision can
     * be exercised without a privileged process; production passes the real
     * `createSupervisorRuntime` runtime through `startSupervisor`.
     */
    startSupervisor: (input: {
        identity: ManagedRuntimeIdentity;
        socketPath: string;
        /**
         * The token a previous boot already published, when there is one.
         *
         * Given, the supervisor uses it; absent, it mints its own. This is what
         * makes a restart possible at all: the launcher record is write-once,
         * so a second boot that minted a new token would publish a token the
         * record refuses, and the runtime would never start again.
         */
        token?: string;
    }) => Promise<{ token: string } | null>;
    /** Creates a directory with an exact mode, owned by root. */
    makeTrustedDirectory: (path: string, mode: number) => Promise<void>;
    /** Gives the workspace to the uid that will write in it. */
    assignWorkspace: (input: { path: string; uid: number; gid: number }) => Promise<void>;
    /** Creates the provider's own state directory, owned by the provider uid. */
    assignProviderHome: (
        input: { path: string; uid: number; gid: number; mode: number },
    ) => Promise<void>;
    /**
     * Lays a checkpoint down, if this runtime has one to restore.
     *
     * Runs **before** ownership is applied. A restore promotes by renaming a
     * tree root built as root, so whatever it promotes arrives root-owned; if
     * ownership were settled first, every file the restore brought back would
     * be unwritable by the executor and the runtime would look ready while no
     * tool could touch its own project. Absent here means there is nothing to
     * restore (T13 supplies the archive side), not that restoring is optional.
     */
    restore?: () => Promise<'restored' | 'nothing-to-restore'>;
    /**
     * Asks what a crashed promotion left behind, and whether it may go.
     *
     * **It is not swept.** An interrupted multi-area promotion can leave the
     * *only* copy of a destination's previous contents in `displaced-*` — the
     * rollback that would have put it back is exactly the step that did not
     * finish. Deleting those trees because "the restore is over" destroys
     * customer data, and it destroys it silently, because the destination that
     * is missing them still looks like a directory.
     *
     * So this reports, and only what a recovery has **proven** reclaimable may
     * be reported as `clear`. Anything else is `unresolved`: the leftovers stay
     * exactly where they are and the boot stops, because a runtime whose areas
     * may be half-promoted cannot be allowed to serve work over them.
     */
    /**
     * **Required.** It was optional, and that is precisely how it came to be
     * missing where it matters: `defaultManagedRuntimeBootDeps` did not
     * provide one, so the real CLI booted with the guard absent and the
     * `if (deps.inspectRestoreStaging)` around it silently held. A runtime with
     * half-promoted areas started and served work. A required field cannot be
     * forgotten by the one caller that is not a test.
     */
    inspectRestoreStaging: () => Promise<'clear' | 'unresolved'>;
    /**
     * Takes the credential the parent delivered and makes it this runtime's
     * own. **Required**, for the reason above it: an optional handoff is a
     * handoff the one non-test caller forgets, and a runtime that boots without
     * one authenticates as nothing.
     */
    adoptCredential: (input: {
        stateDir: string;
        expectedMachineId: string;
        now: number;
        deps: ManagedProvisioningDeps;
    }) => Promise<ManagedCredentialAdoption>;
    provisioning?: ManagedProvisioningDeps;
    resolveIdentity?: typeof resolveManagedRuntimeIdentity;
};

export async function runManagedRuntimeBoot(
    deps: ManagedRuntimeBootDeps,
): Promise<ManagedRuntimeBootOutcome> {
    const provisioning = deps.provisioning ?? defaultProvisioningDeps;
    const identity = (deps.resolveIdentity ?? resolveManagedRuntimeIdentity)();
    // Absence is a BYOS machine and nothing to do here. A marker that exists
    // and cannot be trusted is not the same thing, and it does not become one
    // by being ignored.
    if (identity.status === 'absent') return { ok: false, reason: 'not-managed' };
    if (identity.status !== 'active') return { ok: false, reason: 'identity-refused' };

    const stateDir = identity.identity.stateDir;
    const socketPath = managedLauncherSocketPath(stateDir);

    /*
     * The identity this runtime authenticates as, before anything is started.
     *
     * It arrives from the parent — nothing in a guest can mint it, by design —
     * and `run.ts` refuses to start managed without it, so it has to be on the
     * volume by the time this returns. Done first because it is the cheapest
     * refusal: a credential this runtime may not run as should stop the boot
     * before a supervisor exists and before anything is published.
     *
     * Absence is **not** a refusal. A parent that has not wired the delivery
     * yet, and a machine whose credential is already on its volume, both land
     * here with nothing delivered; what happens next is decided by the daemon
     * when it reads the state directory, which is where that decision belongs.
     */
    let adoption: ManagedCredentialAdoption;
    try {
        adoption = await deps.adoptCredential({
            stateDir,
            expectedMachineId: identity.identity.happyMachineId,
            now: Date.now(),
            deps: provisioning,
        });
    } catch {
        // Never the error: it can carry the delivered file's contents.
        return { ok: false, reason: 'credential-unusable' };
    }
    if (adoption.status === 'refused') return { ok: false, reason: 'credential-unusable' };
    try {
        await deps.makeTrustedDirectory(managedLauncherDirectory(stateDir), 0o700);
    } catch {
        return { ok: false, reason: 'trusted-directory-unavailable' };
    }

    /*
     * What a previous boot published, if anything. Read before the supervisor
     * starts, because it decides which token the supervisor must present.
     *
     * An unreadable record is **not** treated as absent: minting a new token
     * over one that exists and cannot be read is how a runtime ends up with a
     * daemon holding one token and a supervisor answering another.
     */
    const alreadyPublished = readManagedLauncherBinding({ stateDir, deps: provisioning });
    if (!alreadyPublished.ok && alreadyPublished.reason !== 'absent') {
        return { ok: false, reason: 'binding-unpublishable' };
    }

    let started: { token: string } | null;
    try {
        started = await deps.startSupervisor({
            identity: identity.identity,
            socketPath,
            ...(alreadyPublished.ok ? { token: alreadyPublished.binding.token } : {}),
        });
    } catch {
        // The reason is the supervisor's, and it carries paths and credentials.
        // What matters here is that there is nothing to publish.
        started = null;
    }
    if (!started) return { ok: false, reason: 'supervisor-unavailable' };

    /*
     * Published only now, with the socket already listening. Written before
     * starting, a record would name an address nothing answers on, and the
     * daemon would read it and report a wired backend that cannot prove
     * anything.
     */
    const published = await writeManagedLauncherBinding({
        stateDir,
        socketPath,
        token: started.token,
        deps: provisioning,
    });
    if (!published.ok) return { ok: false, reason: 'binding-unpublishable' };

    /*
     * Two directories, two owners, and they are not interchangeable.
     *
     *  - The **workspace** goes to the *executor* uid. That is the uid tool
     *    calls run under, and it is the one that writes files there; left as
     *    `root:root 0755` every `write_file` fails with `EACCES` while the tool
     *    boundary is enforced perfectly.
     *  - **CODEX_HOME** goes to the *provider* uid at `0700`. The provider
     *    writes its own state there, and it must not be a directory the
     *    executor can read: what lands in it belongs to the session, not to the
     *    code the model chose to run.
     *
     * The state directory goes to neither. It holds the receipts, the volume
     * seal and the launcher record — anything that could write there could tell
     * the parent whatever it liked about this runtime's readiness.
     */
    const isolation = identity.identity.isolation;
    try {
        /*
         * Ordering, not politeness: ownership is applied to what is actually
         * there, and after a restore that is a tree the promotion just moved in.
         *
         * A restore reports **two different successes**, and they must not be
         * collapsed. `nothing-to-restore` is a volume this operation created
         * with no checkpoint behind it — the empty-initialized path, and a
         * normal start for a new project. A *failure* is something else
         * entirely, and it throws: read as "nothing to restore" it would clear
         * a volume holding real work.
         */
        if (deps.restore) await deps.restore();
        await deps.assignWorkspace({
            path: MANAGED_PROJECT_ROOT,
            uid: isolation.executor.uid,
            gid: isolation.executor.gid,
        });
        await deps.assignProviderHome({
            path: managedCodexHome(),
            uid: isolation.provider.uid,
            gid: isolation.provider.gid,
            mode: 0o700,
        });
    } catch {
        return { ok: false, reason: 'workspace-unassignable' };
    }

    /*
     * Leftovers from an interrupted promotion are checked **last and
     * separately**, because the answer is not "tidy up" but "may this runtime
     * serve work at all".
     *
     * A crash between two areas leaves a state nobody can name from the
     * filesystem alone: the project tree may be the new one while the provider
     * state is still the old, and the previous contents of whichever area was
     * promoted first exist only under `displaced-*`. Without a recovery that
     * proves what happened, a boot that continued would run an agent against a
     * mixed tree, and a boot that swept would delete the only copy.
     */
    let staging: 'clear' | 'unresolved';
    try {
        staging = await deps.inspectRestoreStaging();
    } catch {
        staging = 'unresolved';
    }
    if (staging !== 'clear') return { ok: false, reason: 'restore-unresolved' };

    return { ok: true, socketPath, published: published.wrote };
}

/** Where the image installs the trusted executables. Not configurable. */
const HELPER_PATH = '/usr/local/lib/saycode/exec-helper';
const WORKLOAD_PATH = '/usr/local/lib/saycode/node';

/** The lease watchdog's tick, and how long a prepared launch may sit unclaimed. */
const WATCHDOG_INTERVAL_MS = 1_000;
const RELEASE_DEADLINE_MS = 30_000;

/**
 * Makes a directory root-owned at an exact mode, and refuses anything it did
 * not make safe.
 *
 * `mkdir`'s mode argument is masked by the process umask, so it is set again
 * explicitly — a `0700` that silently became `0755` is a socket directory the
 * agent can list, and later replace entries in. An existing path that is a
 * symlink is refused rather than followed: following it would apply root
 * ownership and a permissive-looking mode to whatever it points at.
 */
function makeTrustedDirectorySync(path: string, mode: number): void {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error('trusted directory path is a symlink');
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
    chownSync(path, 0, 0);
}

/**
 * Hands a tree to the uid that will write in it.
 *
 * Recursive, and deliberately: a restored volume has directories under the
 * project root, and an agent that owns only the top level cannot write inside
 * them. Symlinks are changed with `lchown` semantics — never followed — so a
 * link planted in a restored tree cannot be used to give the agent something
 * outside the workspace.
 */
export function assignTreeSync(
    path: string,
    uid: number,
    gid: number,
    /** Injected so a test can see which paths the walk reaches. */
    chown: (target: string, uid: number, gid: number) => void = chownSync,
): void {
    const stat = lstatSync(path);
    // `chownSync` follows symlinks; `lchownSync` does not, and a link's own
    // ownership is not what governs its target anyway.
    if (stat.isSymbolicLink()) return;
    chown(path, uid, gid);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) assignTreeSync(join(path, entry), uid, gid, chown);
}

/**
 * The real boot: a **separate root supervisor process's** runtime, started
 * here and left running. The token comes from the IPC server it creates —
 * nothing in this file chooses it, so nothing in this file can weaken it.
 */
export function defaultManagedRuntimeBootDeps(
    /** Injected so a test can observe which paths ownership actually reaches. */
    chown: (target: string, uid: number, gid: number) => void = chownSync,
    /** Injected so a test can point the staging check at a real directory. */
    stagingRoot: string = MANAGED_RESTORE_STAGING_ROOT,
): ManagedRuntimeBootDeps {
    return {
        inspectRestoreStaging: async () => inspectRestoreStagingSync(stagingRoot),
        adoptCredential: (input) => adoptManagedDaemonCredential(input),
        makeTrustedDirectory: async (path, mode) => { makeTrustedDirectorySync(path, mode); },
        assignWorkspace: async ({ path, uid, gid }) => { assignTreeSync(path, uid, gid, chown); },
        assignProviderHome: async ({ path, uid, gid, mode }) => {
            const existing = lstatSync(path, { throwIfNoEntry: false });
            if (existing?.isSymbolicLink()) throw new Error('provider home path is a symlink');
            mkdirSync(path, { recursive: true, mode });
            chmodSync(path, mode);
            /*
             * The **tree**, not just the directory.
             *
             * A restore promotes this area as root, so what lands inside it —
             * `sessions/`, the provider's native state database — arrives
             * root-owned. Owning only the top level lets the provider create new
             * files and read none of the ones it is being given back, which is
             * the failure that looks like "the session is empty" rather than
             * like a permissions bug.
             */
            assignTreeSync(path, uid, gid, chown);
        },
        startSupervisor: async ({ identity, socketPath, token }) => {
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: identity.isolation.cgroupRoot,
                    helperPath: HELPER_PATH,
                    workloadPath: WORKLOAD_PATH,
                    // One uid for every generation on this runtime: the marker
                    // names it, and reuse discipline is the provisioner's.
                    // The generation is the **provider**: this is the process
                    // the supervisor launches and fences. The executor's uid is
                    // applied by the tool session, per call, and never here.
                    resolveGenerationCredentials: () => ({
                        uid: identity.isolation.provider.uid,
                        gid: identity.isolation.provider.gid,
                    }),
                },
                manifestRoot: join(identity.stateDir, 'manifest'),
                stagingRoot: join(identity.stateDir, 'staging'),
                socketPath,
                watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
                releaseDeadlineMs: RELEASE_DEADLINE_MS,
                runtimeId: identity.runtimeId,
                // The token a previous boot published, when there is one. The
                // supervisor mints its own only on a first boot; a restart that
                // minted again would publish a token the write-once record
                // refuses, and the runtime would never come back.
                ...(token ? { token } : {}),
            });
            await runtime.start();
            /*
             * A restart finds children the previous supervisor launched still
             * running, and its watch list empty. Reconciling before anything is
             * published is what arms those generations — without it a lease is
             * never enforced against them.
             */
            runtime.reconcile();
            return { token: runtime.token };
        },
    };
}

/**
 * Whether anything is left under the restore staging root.
 *
 * Deliberately blunt: **any** entry means `unresolved`. Not `displaced-*` only
 * — a journal, a partially written manifest, a lock, a name this code has never
 * heard of, all of them say the same thing, which is that a promotion did not
 * finish and nothing here can prove what state the areas are in. Matching a
 * naming convention would answer "clear" for exactly the leftovers nobody
 * anticipated, which are the ones worth stopping for.
 *
 * Nothing is deleted, moved or repaired. An interrupted promotion can leave the
 * only copy of a destination's previous contents in here, so a sweep is data
 * loss and a silent one. The recovery that can prove what happened is a
 * separate, deliberate act; this only decides whether the runtime may serve
 * work in the meantime.
 *
 * Every failure to look is `unresolved`. A staging root that cannot be read, is
 * a symlink, or is not a directory is not evidence of absence.
 */
export function inspectRestoreStagingSync(root: string): 'clear' | 'unresolved' {
    let stat;
    try {
        stat = lstatSync(root, { throwIfNoEntry: false });
    } catch {
        return 'unresolved';
    }
    // Never staged, or already cleared by a recovery that finished.
    if (!stat) return 'clear';
    // A symlink here is somebody redirecting the check away from the real
    // staging area; a plain file is a state this code cannot account for.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unresolved';
    try {
        return readdirSync(root).length === 0 ? 'clear' : 'unresolved';
    } catch {
        return 'unresolved';
    }
}
