/**
 * Writes the machine's identity marker, once, from the boot input the parent
 * placed on it.
 *
 * The marker is the trust anchor: `resolveManagedRuntimeIdentity` reads it and
 * everything downstream — which uids exist, which cgroup root, which project
 * this machine is — follows from what it says. Two consequences shape this
 * file.
 *
 * **It is written exactly once.** `O_EXCL`, root-owned, `0600`, flushed with
 * its directory entry before it is treated as written. A second write to the
 * same path is an identity swap, so an existing marker is adopted only when it
 * says the same thing and otherwise refused — never overwritten.
 *
 * **Nothing here invents a value.** `composeManagedMarker` decides what a
 * complete identity is; this stage only reads the input safely and puts the
 * answer on disk. A missing axis is a refusal, because a marker with a guessed
 * uid in it is worse than no marker: the boot would continue and the isolation
 * would be wrong.
 *
 * The boot input itself is read through the same gate the marker reader uses —
 * root-owned, not a symlink, not group-writable. Without that, an unprivileged
 * process on the machine could choose the machine's identity by writing that
 * file first.
 *
 * `not-managed` is not a failure. It is an ordinary BYOS machine, and the
 * caller should exit cleanly rather than treat the absence of managed metadata
 * as a broken boot.
 */
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
    assertProvisioningStat,
    defaultProvisioningDeps,
    managedProvisioningPath,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
    type ProvisioningStat,
} from '@/daemon/managedRuntimeIdentity';
import {
    composeManagedMarker,
    type ManagedMarkerRecord,
    type ManagedMarkerRefusal,
} from './managedMarkerComposer';

/** Where the parent places the boot input when it creates the machine. */
export const MANAGED_BOOT_INPUT_PATH = '/etc/saycode/boot-input.json';

export type ManagedMarkerWriteRefusal =
    | ManagedMarkerRefusal
    | 'boot-input-absent'
    | 'boot-input-unreadable'
    | 'symlinked'
    | 'not-root-owned'
    | 'world-or-group-writable'
    | 'not-a-regular-file'
    | 'too-large'
    | 'unreadable'
    | 'identity-conflict'
    | 'untrusted-path'
    | 'marker-unwritable';

export type ManagedMarkerWriteOutcome =
    | { status: 'written'; record: ManagedMarkerRecord }
    /** An identical marker was already there; it is left exactly as it is. */
    | { status: 'adopted'; record: ManagedMarkerRecord }
    /** Not a managed machine. Ordinary, and not an error. */
    | { status: 'not-managed' }
    | { status: 'refused'; reason: ManagedMarkerWriteRefusal; detail?: string };

export type ManagedMarkerWriterDeps = {
    /** Trust decision about the boot input. Defaults to the marker reader's. */
    statGate?: (stat: ProvisioningStat) => { reason: string } | null;
    /** How the ancestor walk sees the filesystem. Defaults to the real one. */
    provisioningDeps?: ManagedProvisioningDeps;
    /** Observability seam: every path flushed, in order. */
    onSync?: (path: string) => void;
};

function serialize(record: ManagedMarkerRecord): string {
    return JSON.stringify(record);
}

/** `fsync` the marker and the directory entry that names it. */
async function flushMarker(
    markerPath: string,
    directory: string,
    onSync?: (path: string) => void,
): Promise<void> {
    const handle = await open(markerPath, 'r');
    try {
        await handle.sync();
        onSync?.(markerPath);
    } finally {
        await handle.close();
    }
    const directoryHandle = await open(directory, 'r');
    try {
        await directoryHandle.sync();
        onSync?.(directory);
    } finally {
        await directoryHandle.close();
    }
}

/** Every directory on the way to `target`, outermost first. */
function ancestorChain(target: string): string[] {
    const parts = resolve(dirname(target)).split('/').filter((part) => part.length > 0);
    const chain = ['/'];
    for (let index = 0; index < parts.length; index += 1) {
        chain.push(`/${parts.slice(0, index + 1).join('/')}`);
    }
    return chain;
}

/**
 * The reader's own chain policy, applied to what exists.
 *
 * `trustedPathRefusal` is not re-implemented here: whatever
 * `resolveManagedRuntimeIdentity` will refuse when it reads the marker back is
 * what this must refuse before writing it, and two copies of that rule would
 * drift. What is added is where to stop — the marker's directory is
 * legitimately absent on a first boot, and demanding it already exist would
 * refuse every first boot.
 */
function untrustedAncestor(targets: string[], deps: ManagedProvisioningDeps): string | null {
    const daemonUid = deps.getuid();
    for (const target of targets) {
        const chain = ancestorChain(target);
        let deepestExisting: string | null = null;
        for (const component of chain) {
            try {
                deps.lstatDir(component);
                deepestExisting = component;
            } catch (error) {
                // Nothing here, so nothing below it exists either — and what
                // does not exist cannot have been tampered with.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
                return `${component}: ${(error as NodeJS.ErrnoException).code ?? 'stat failed'}`;
            }
        }
        if (deepestExisting === null) continue;
        const refusal = trustedPathRefusal(deepestExisting, daemonUid, 'unreadable', deps);
        if (refusal) return refusal.detail;
    }
    return null;
}

export async function writeManagedMarker(input: {
    bootInputPath?: string;
    /** Defaults to the exact path `resolveManagedRuntimeIdentity` reads. */
    markerPath?: string;
    instance: { providerMachineId: string | null; providerInstanceId: string | null };
    happyMachineId: string | null;
    deps?: ManagedMarkerWriterDeps;
}): Promise<ManagedMarkerWriteOutcome> {
    const bootInputPath = input.bootInputPath ?? MANAGED_BOOT_INPUT_PATH;
    // Not a literal: the reader owns where the marker lives, and a second
    // spelling of that path here would be a marker nothing reads.
    const markerPath = input.markerPath ?? managedProvisioningPath();
    const gate = input.deps?.statGate ?? assertProvisioningStat;

    // The files are checked, and so is everything leading to them — **before
    // anything is created**. A parent someone else can write is a parent
    // someone else can swap the marker in, and `mkdir` would follow a symlink
    // there without complaint. `resolveManagedRuntimeIdentity` walks the same
    // chain when it reads the marker back, so a marker written into an
    // untrusted chain would be refused later anyway, after the boot had
    // already treated it as this machine's identity.
    //
    // The walk is over *directories*, and it stops where the chain stops
    // existing: the marker's own directory is legitimately absent on a first
    // boot, and refusing that would refuse every first boot. What exists must
    // be trusted; what does not exist yet will be created 0700 below.
    const provisioningDeps = input.deps?.provisioningDeps ?? defaultProvisioningDeps;
    const untrusted = untrustedAncestor([bootInputPath, markerPath], provisioningDeps);
    if (untrusted) return { status: 'refused', reason: 'untrusted-path', detail: untrusted };

    const file = readRootProtectedFile(bootInputPath, gate as typeof assertProvisioningStat);
    if (file.kind === 'absent') return { status: 'refused', reason: 'boot-input-absent' };
    if (file.kind === 'refused') {
        return { status: 'refused', reason: file.reason as ManagedMarkerWriteRefusal, detail: file.detail };
    }

    let metadata: Record<string, string | undefined>;
    try {
        const parsed: unknown = JSON.parse(file.content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
        metadata = parsed as Record<string, string | undefined>;
    } catch {
        // The file's contents are not echoed: it is the parent's input and may
        // carry values that do not belong in a log line.
        return { status: 'refused', reason: 'boot-input-unreadable' };
    }

    const composed = composeManagedMarker({
        metadata,
        instance: input.instance,
        happyMachineId: input.happyMachineId,
    });
    if (!composed.ok) {
        if (composed.reason === 'not-managed') return { status: 'not-managed' };
        return { status: 'refused', reason: composed.reason };
    }

    const body = serialize(composed.record);
    const directory = dirname(markerPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    // Written under a name of this call's own, completed and flushed there,
    // and only then published. Writing straight to the final path leaves a
    // half-written marker behind on any failure — and because the marker is
    // never overwritten, that partial file becomes a permanent
    // identity-conflict that no later boot can get past.
    const temporary = join(directory, `.managed-runtime.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            await handle.writeFile(body);
            // Explicit, not left to `O_CREAT`'s mode: that one is masked by the
            // process umask, so on a machine with a permissive umask the marker
            // would be created exactly as permissive.
            await handle.chmod(0o600);
            await handle.sync();
            input.deps?.onSync?.(markerPath);
        } finally {
            await handle.close();
        }
    } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        return { status: 'refused', reason: 'marker-unwritable' };
    }

    try {
        // `link`, not `rename`: rename replaces, and replacing the marker is
        // exactly the identity swap this refuses to perform.
        await link(temporary, markerPath);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return { status: 'refused', reason: 'marker-unwritable' };
        }
        // Something is already there. Same identity is the same boot happening
        // again; a different one is this machine being told it is a different
        // machine, and that is refused rather than resolved. The existing file
        // is read through the same gate the marker reader uses — an adopted
        // marker that an unprivileged process could have authored would be an
        // identity anyone on the box could choose.
        const existing = readRootProtectedFile(markerPath, gate as typeof assertProvisioningStat);
        if (existing.kind === 'absent') return { status: 'refused', reason: 'marker-unwritable' };
        if (existing.kind === 'refused') {
            return { status: 'refused', reason: existing.reason as ManagedMarkerWriteRefusal, detail: existing.detail };
        }
        if (existing.content !== body) return { status: 'refused', reason: 'identity-conflict' };
        // Adopting is a claim that the marker is on the disk, and the boot
        // that wrote it may have died before its directory entry was flushed.
        // This one verifies rather than inheriting the assumption — a marker
        // that vanishes on the next power cut takes the machine's identity
        // with it.
        try {
            await flushMarker(markerPath, directory, input.deps?.onSync);
        } catch {
            return { status: 'refused', reason: 'marker-unwritable' };
        }
        return { status: 'adopted', record: composed.record };
    }
    await unlink(temporary).catch(() => undefined);

    // Until the directory entry is on the disk the marker can vanish, and a
    // machine that loses its marker resolves as BYOS on the next boot.
    try {
        const directoryHandle = await open(directory, 'r');
        try {
            await directoryHandle.sync();
            input.deps?.onSync?.(directory);
        } finally {
            await directoryHandle.close();
        }
    } catch {
        return { status: 'refused', reason: 'marker-unwritable' };
    }

    return { status: 'written', record: composed.record };
}
