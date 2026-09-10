/**
 * Decides whether this daemon is a managed Cloud runtime, and refuses to guess.
 *
 * The only admissible evidence is a provisioning file the runtime's own code
 * cannot write: owned by uid 0, not writable by group or other, reached without
 * following a symlink. An environment variable is not evidence — the daemon
 * passes its whole `process.env` to agent children on the default spawn path,
 * so anything there is attacker-controlled once the first agent turn runs. A
 * signed-token echo is not evidence either: the verifier key is public, so any
 * process can perform that exchange.
 *
 * Three outcomes, and the middle one carries the weight:
 *   - absent    → no marker. An ordinary BYOS machine; nothing changes for it.
 *                 Only ENOENT produces this. A marker we cannot read (EACCES,
 *                 EIO, ELOOP) is a refusal, and so is ENOTDIR — a file sitting
 *                 where a directory belongs is producible by anyone who can
 *                 write the parent, so treating it as "not managed" would be a
 *                 switch for turning managed mode off. On Linux the directory
 *                 the marker would live in is walked before absence is granted;
 *                 off Linux, where no managed runtime can exist, a missing
 *                 marker is absence outright.
 *   - refused   → a marker exists but cannot be trusted. Managed RPCs are not
 *                 served AND legacy spawn is not restored.
 *   - active    → verified provisioning, verified state directory, and an
 *                 isolation backend that actually answered.
 *
 * Isolation is not a declaration. `isolation.backend` names a trusted launch /
 * fencing mechanism and the daemon asks that backend whether it is wired. As of
 * T04/T09 no backend is implemented, so `probeIsolationBackend` reports
 * unavailable and `active` is unreachable — by construction, not by comment.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseManagedVerifierKey } from './managedDispatchToken';
import type { KeyObject } from 'node:crypto';

const MAX_PROVISIONING_BYTES = 16 * 1024;

/**
 * Mechanisms that may ever grant isolation. None is implemented yet (T09).
 *
 * The name is deliberately not a cgroup path: T09 measured that a non-root
 * daemon cannot signal an agent running under a different uid, and that setuid
 * shell wrappers are ignored on Linux. Downgrading to another uid and later
 * terminating that process both require a privileged launcher, so the backend
 * is that launcher — a declared cgroup root is not a substitute for it.
 */
/**
 * The project root of a managed Cloud runtime, as a literal.
 *
 * Not a template and not a setting: the parent, this daemon and the launcher
 * all name the same path, and the launcher's real working directory has to be
 * this one. A caller's `Project.path`, a `workspaceDir`, or a `cloud://…` in
 * bootstrap metadata is never reinterpreted as a filesystem path. The parent
 * repository holds the same literal in its own protocol module and the wire
 * check compares them, so neither side depends on a shared package for one
 * constant.
 */
export const MANAGED_PROJECT_ROOT = '/workspace/project';

export const MANAGED_ISOLATION_BACKENDS = ['privileged-launch-supervisor'] as const;
export type ManagedIsolationBackend = (typeof MANAGED_ISOLATION_BACKENDS)[number];

export type ManagedIdentityRefusal =
    | 'not-root-owned'
    | 'world-or-group-writable'
    | 'not-a-regular-file'
    | 'symlinked'
    | 'too-large'
    | 'unreadable'
    | 'malformed'
    | 'bad-verifier-key'
    | 'state-dir-unsafe'
    | 'isolation-unverified';

export type ManagedRuntimeIdentity = {
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    /**
     * The **Happy** machine this runtime is reachable at.
     *
     * A different axis from the provider's machine id, and the only one that
     * is an address. Using a provider id in its place asks a daemon that does
     * not exist, or publishes to somebody else's machine — so it is written by
     * the provisioner and read from here, never derived.
     */
    happyMachineId: string;
    /** The provisioning operation that created this runtime. */
    provisioningOperationId: string;
    /** The configuration this runtime was created for, as the parent computes it. */
    configDigest: string;
    /** The provider resources this runtime actually runs on. */
    providerMachineId: string;
    providerInstanceId: string;
    /**
     * The volume the provider attached, by the provider's own id.
     *
     * The runtime cannot derive this. `/proc/self/mountinfo` speaks in device
     * numbers and mount sources; a `vol_…` id lives in the provider's API and
     * appears nowhere the kernel can be asked. So it is written by whoever did
     * the attaching and read from here — a runtime that named its own volume
     * would be agreeing with itself.
     */
    providerVolumeId: string;
    verifier: KeyObject;
    /** Directory the receipt store owns. Never inside the agent workspace. */
    stateDir: string;
    /**
     * The two uids this runtime runs code under, and they are **two**.
     *
     * The provider holds the gateway capability and the session key; the tool
     * executor runs code the model chose. Under one uid the executor can read
     * `/proc/<provider pid>/environ` and the provider's descriptors, and the
     * separation stops meaning anything — which is why `planToolExecutorIsolation`
     * refuses a shared uid outright. The marker is where that split is decided,
     * so it carries both and a marker naming one uid twice does not activate.
     */
    isolation: {
        backend: ManagedIsolationBackend;
        provider: { uid: number; gid: number };
        executor: { uid: number; gid: number };
        cgroupRoot: string;
    };
};

export type ManagedIdentityResolution =
    | { status: 'absent' }
    | { status: 'refused'; reason: ManagedIdentityRefusal; detail?: string }
    | { status: 'active'; identity: ManagedRuntimeIdentity };

export type IsolationProbeResult = { verified: true } | { verified: false; reason: string };

export type ManagedProvisioningDeps = {
    getuid: () => number;
    /** Managed runtimes are Linux-only; see `absenceRefusal`. */
    platform?: NodeJS.Platform;
    /** Ownership/mode of a directory, without following a final symlink. */
    lstatDir: (path: string) => { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean };
    /** Trust decision about the opened provisioning file. */
    statGate?: (stat: ProvisioningStat) => { reason: ManagedIdentityRefusal } | null;
    /**
     * Asks the privileged launch backend whether it is actually wired up —
     * meaning it can both start code under these uids and terminate it.
     * T09 owns that implementation; until then this reports unavailable.
     */
    probeIsolationBackend: (input: {
        backend: ManagedIsolationBackend;
        provider: { uid: number; gid: number };
        executor: { uid: number; gid: number };
        cgroupRoot: string;
        daemonUid: number;
    }) => IsolationProbeResult;
};

/**
 * No trusted launch backend exists yet, so managed mode cannot activate. This
 * is the activation gate: it becomes a real probe in T09 and not before.
 */
export function probeIsolationBackendUnavailable(): IsolationProbeResult {
    return { verified: false, reason: 'trusted-launch-backend-not-implemented' };
}

/**
 * How this daemon reads root-protected records on a real runtime. Exported so
 * every such read on this process uses the **same** trust rules — a second set
 * assembled at a call site is a second answer to "is this path trusted".
 */
export const defaultProvisioningDeps: ManagedProvisioningDeps = {
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    platform: process.platform,
    lstatDir: (path) => {
        const stat = lstatSync(path);
        return {
            uid: stat.uid,
            mode: stat.mode,
            isDirectory: stat.isDirectory(),
            isSymbolicLink: stat.isSymbolicLink(),
        };
    },
    probeIsolationBackend: probeIsolationBackendUnavailable,
};

export function managedProvisioningPath(root = '/etc/saycode'): string {
    return join(root, 'managed-runtime.json');
}

function readString(value: unknown, max = 200): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
}

type FileReadOutcome =
    | { kind: 'absent' }
    | { kind: 'refused'; reason: ManagedIdentityRefusal; detail?: string }
    | { kind: 'ok'; content: string };

export type ProvisioningStat = { uid: number; mode: number; isFile: boolean; size: number };

/**
 * The trust decision about the opened file, separated from the I/O so every
 * ownership and permission combination is testable without running as root.
 * `resolveManagedRuntimeIdentity` uses this by default; a test may substitute
 * a narrower gate to exercise the parsing that follows.
 */
/**
 * A uid/gid pair, or `null`. Unprivileged and whole numbers — a role that runs
 * as root is not a role that is contained by a uid.
 */
function readCredentials(raw: unknown): { uid: number; gid: number } | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const uid = record.uid;
    const gid = record.gid;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) return null;
    if (typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid <= 0) return null;
    return { uid, gid };
}

export function assertProvisioningStat(
    stat: ProvisioningStat,
): { reason: ManagedIdentityRefusal } | null {
    if (!stat.isFile) return { reason: 'not-a-regular-file' };
    if (stat.uid !== 0) return { reason: 'not-root-owned' };
    if ((stat.mode & 0o022) !== 0) return { reason: 'world-or-group-writable' };
    if (stat.size > MAX_PROVISIONING_BYTES) return { reason: 'too-large' };
    return null;
}

/**
 * Open, stat and read a root-protected file through a single descriptor.
 *
 * Exported so every root-protected read on this runtime goes through the same
 * rules — a second implementation is a second set of rules, and the one that
 * gets forgotten is the one an attacker uses.
 *
 * A stat-then-read pair checks one file and reads another if the path is
 * swapped in between, and `O_NOFOLLOW` keeps a symlink from redirecting the
 * final component at all. The read is bounded by the stat'd size so a huge or
 * growing file cannot be pulled into memory.
 */
export function readRootProtectedFile(
    path: string,
    gate: (stat: ProvisioningStat) => { reason: ManagedIdentityRefusal } | null,
): FileReadOutcome {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Only a genuinely missing path means "this is not a managed runtime".
        // ENOTDIR is not that: it means a path component is a file, which is a
        // state anyone who can write the parent can create, so treating it as
        // absence would be a switch for turning managed mode off.
        if (code === 'ENOENT') return { kind: 'absent' };
        if (code === 'ENOTDIR') {
            return { kind: 'refused', reason: 'unreadable', detail: 'ENOTDIR' };
        }
        if (code === 'ELOOP') return { kind: 'refused', reason: 'symlinked' };
        return { kind: 'refused', reason: 'unreadable', detail: code ?? 'open failed' };
    }
    try {
        const stat = fstatSync(fd);
        const refusal = gate({
            uid: stat.uid, mode: stat.mode, isFile: stat.isFile(), size: Number(stat.size),
        });
        if (refusal) return { kind: 'refused', reason: refusal.reason };

        const buffer = Buffer.allocUnsafe(Number(stat.size));
        let read = 0;
        while (read < buffer.length) {
            const chunk = readSync(fd, buffer, read, buffer.length - read, read);
            if (chunk === 0) break;
            read += chunk;
        }
        return { kind: 'ok', content: buffer.subarray(0, read).toString('utf8') };
    } catch (error) {
        return { kind: 'refused', reason: 'unreadable', detail: (error as NodeJS.ErrnoException).code ?? 'read failed' };
    } finally {
        closeSync(fd);
    }
}

/**
 * Walks a path from the filesystem root and checks every component.
 *
 * Checking only the final directory is not enough: a 0700 leaf inside a
 * writable parent can be renamed away and replaced, after which the lease and
 * receipts are read from a directory the agent controls. Each ancestor must be
 * a real directory, not a symlink, not owned by the agent, and not writable by
 * group or other. No sticky-bit exception is assumed — a shared temp directory
 * is not a safe home for fencing state, and guessing that it is would be the
 * kind of assumption this check exists to remove.
 */
function pathChain(target: string): string[] {
    const parts = resolve(target).split(sep).filter((part) => part.length > 0);
    const chain: string[] = [sep];
    for (let i = 0; i < parts.length; i += 1) {
        chain.push(sep + parts.slice(0, i + 1).join(sep));
    }
    return chain;
}

/**
 * Trust is ownership by root or by this daemon, nothing else.
 *
 * Naming the *agent* uid and refusing only that would leave every other
 * unprivileged account on the host able to own a link in the chain. Since the
 * daemon and the agent already run under different uids, refusing anything that
 * is neither root nor the daemon covers the agent case and is strictly tighter.
 */
function componentRefusal(
    stat: { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean },
    daemonUid: number,
): string | null {
    if (stat.isSymbolicLink) return 'symlink';
    if (!stat.isDirectory) return 'not a directory';
    if (stat.uid !== 0 && stat.uid !== daemonUid) return 'not owned by root or the daemon';
    if ((stat.mode & 0o022) !== 0) return 'group or world writable';
    return null;
}

export function trustedPathRefusal(
    target: string,
    daemonUid: number,
    reason: ManagedIdentityRefusal,
    deps: ManagedProvisioningDeps,
): { reason: ManagedIdentityRefusal; detail: string } | null {
    for (const component of pathChain(target)) {
        let stat: { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean };
        try {
            stat = deps.lstatDir(component);
        } catch (error) {
            return { reason, detail: `${component}: ${(error as NodeJS.ErrnoException).code ?? 'stat failed'}` };
        }
        const refusal = componentRefusal(stat, daemonUid);
        if (refusal) return { reason, detail: `${component}: ${refusal}` };
    }
    return null;
}

/**
 * Whether a missing marker may be read as "this is a BYOS machine".
 *
 * A marker that is absent because an agent deleted it from a directory it can
 * write is not the same fact as a marker that was never provisioned, and the
 * first one must not reopen the legacy surface. Only what exists can be
 * untrustworthy, so the walk stops at the deepest directory that is there: a
 * chain that simply does not exist is ordinary absence, which is what every
 * BYOS machine looks like.
 */
function absenceRefusal(
    markerPath: string,
    daemonUid: number,
    deps: ManagedProvisioningDeps,
): { reason: ManagedIdentityRefusal; detail: string } | null {
    for (const component of pathChain(dirname(resolve(markerPath)))) {
        let stat: { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean };
        try {
            stat = deps.lstatDir(component);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Nothing is here, so nothing below can exist either.
            if (code === 'ENOENT') return null;
            // ENOTDIR means a file sits where a directory belongs — producible
            // by anyone who can write the parent, so it is a tamper signal and
            // gets the same fail-closed treatment the marker itself gets.
            return { reason: 'unreadable', detail: `${component}: ${code ?? 'stat failed'}` };
        }
        const refusal = componentRefusal(stat, daemonUid);
        if (refusal) return { reason: 'not-root-owned', detail: `${component}: ${refusal}` };
    }
    return null;
}

/**
 * The state directory holds the receipts and the lease that fencing reads. If
 * agent code can write there it can fabricate a stopped receipt or roll the
 * epoch back, so it must be outside the workspace and not agent-writable —
 * along its whole path, not just at the leaf.
 */
function stateDirRefusal(
    stateDir: string,
    workspaceDir: string,
    daemonUid: number,
    deps: ManagedProvisioningDeps,
): { reason: ManagedIdentityRefusal; detail: string } | null {
    if (!isAbsolute(stateDir)) return { reason: 'state-dir-unsafe', detail: 'not absolute' };
    const resolvedState = resolve(stateDir);
    const resolvedWorkspace = resolve(workspaceDir);
    const rel = relative(resolvedWorkspace, resolvedState);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return { reason: 'state-dir-unsafe', detail: 'inside workspace' };
    }
    return trustedPathRefusal(resolvedState, daemonUid, 'state-dir-unsafe', deps);
}

export function resolveManagedRuntimeIdentity(
    path: string = managedProvisioningPath(),
    deps: ManagedProvisioningDeps = defaultProvisioningDeps,
): ManagedIdentityResolution {
    const daemonUid = deps.getuid();
    const file = readRootProtectedFile(path, deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') {
        // Absence is only interrogated where a managed runtime could actually
        // exist. Managed runtimes are Linux (the writer lock is a Linux
        // abstract socket), and off Linux this walk would refuse on things
        // that are normal there — macOS ships `/etc` as a root-owned symlink
        // to `private/etc`, and Windows has no uid at all — which would stop
        // every BYOS daemon on those platforms from starting.
        //
        // This is a boundary, not an escape hatch: a marker that *exists* is
        // still validated and still refused on every platform, so no host can
        // fall back to the legacy surface by being the wrong OS.
        const platform = deps.platform ?? process.platform;
        if (platform !== 'linux') return { status: 'absent' };
        // On Linux the walk is the premise for calling this BYOS, and without a
        // uid it cannot be established — which is a refusal, not an absence.
        if (daemonUid < 0) {
            return { status: 'refused', reason: 'unreadable', detail: 'daemon uid unavailable' };
        }
        const unsafe = absenceRefusal(path, daemonUid, deps);
        return unsafe
            ? { status: 'refused', reason: unsafe.reason, detail: unsafe.detail }
            : { status: 'absent' };
    }
    if (file.kind === 'refused') {
        return { status: 'refused', reason: file.reason, ...(file.detail ? { detail: file.detail } : {}) };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return { status: 'refused', reason: 'malformed', detail: 'not JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'refused', reason: 'malformed', detail: 'not an object' };
    }
    const record = parsed as Record<string, unknown>;

    const runtimeId = readString(record.runtimeId);
    const workspaceId = readString(record.workspaceId);
    const projectId = readString(record.projectId);
    const keyId = readString(record.keyId);
    // The axes a readiness answer is compared against. All of them come from
    // the marker only root can write: a runtime that could describe itself
    // could describe itself as somebody else's.
    const happyMachineId = readString(record.happyMachineId);
    const provisioningOperationId = readString(record.provisioningOperationId);
    const configDigest = readString(record.configDigest);
    const providerMachineId = readString(record.providerMachineId);
    const providerInstanceId = readString(record.providerInstanceId);
    const providerVolumeId = readString(record.providerVolumeId);
    const stateDir = readString(record.stateDir, 4096);
    const workspaceDir = readString(record.workspaceDir, 4096);
    const verifierKeyB64 = readString(record.verifierPublicKey, 4096);
    if (!runtimeId || !workspaceId || !projectId || !keyId || !stateDir || !workspaceDir || !verifierKeyB64
        || !happyMachineId || !provisioningOperationId || !configDigest
        || !providerMachineId || !providerInstanceId || !providerVolumeId) {
        return { status: 'refused', reason: 'malformed', detail: 'missing required field' };
    }

    let verifier: KeyObject;
    try {
        verifier = parseManagedVerifierKey(Buffer.from(verifierKeyB64, 'base64'));
    } catch (error) {
        return { status: 'refused', reason: 'bad-verifier-key', detail: (error as Error).message };
    }

    const rawIsolation = record.isolation;
    if (!rawIsolation || typeof rawIsolation !== 'object' || Array.isArray(rawIsolation)) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'missing attestation' };
    }
    const isolation = rawIsolation as Record<string, unknown>;
    const backend = readString(isolation.backend);
    const provider = readCredentials(isolation.provider);
    const executor = readCredentials(isolation.executor);
    const cgroupRoot = readString(isolation.cgroupRoot, 4096);
    if (!backend || !MANAGED_ISOLATION_BACKENDS.includes(backend as ManagedIsolationBackend)
        || !provider || !executor || !cgroupRoot) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'incomplete attestation' };
    }

    // One uid named twice is no separation at all: the executor could read the
    // provider's environment and descriptors, which is the whole thing the two
    // uids exist to prevent. Refused here rather than at launch, because a
    // runtime that admitted itself on this marker would already be answering
    // the parent as isolated.
    if (provider.uid === executor.uid) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'one uid for both roles' };
    }
    if (daemonUid < 0 || daemonUid === provider.uid || daemonUid === executor.uid) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'daemon shares a runtime uid' };
    }

    // The marker decides this runtime's identity, so an agent that can replace
    // it chooses who the runtime is. Its directory chain gets the same walk.
    const unsafeMarkerDir = trustedPathRefusal(dirname(resolve(path)), daemonUid, 'not-root-owned', deps);
    if (unsafeMarkerDir) {
        return { status: 'refused', reason: 'not-root-owned', detail: unsafeMarkerDir.detail };
    }

    const unsafeStateDir = stateDirRefusal(stateDir, workspaceDir, daemonUid, deps);
    if (unsafeStateDir) {
        return { status: 'refused', reason: unsafeStateDir.reason, detail: unsafeStateDir.detail };
    }

    // The declared cgroup root says where processes are meant to land, not that
    // they do. Only the backend can answer that, and today none can.
    const probe = deps.probeIsolationBackend({
        backend: backend as ManagedIsolationBackend,
        provider,
        executor,
        cgroupRoot,
        daemonUid,
    });
    if (!probe.verified) {
        return { status: 'refused', reason: 'isolation-unverified', detail: probe.reason };
    }

    return {
        status: 'active',
        identity: {
            runtimeId,
            workspaceId,
            projectId,
            keyId,
            happyMachineId,
            provisioningOperationId,
            configDigest,
            providerMachineId,
            providerInstanceId,
            providerVolumeId,
            verifier,
            stateDir: resolve(stateDir),
            isolation: { backend: backend as ManagedIsolationBackend, provider, executor, cgroupRoot },
        },
    };
}
