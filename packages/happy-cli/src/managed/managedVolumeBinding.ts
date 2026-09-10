/**
 * What volume this runtime is actually on, decided once and then held to.
 *
 * The parent knows the provider's volume id and nothing else: a kernel device
 * number and a filesystem UUID do not exist until something is attached and
 * mounted, and the control plane never sees them. Inventing them there would
 * be the parent asserting a fact it cannot observe.
 *
 * So the runtime observes them — as root, on the boot that has them — and
 * **seals** the three axes together. From then on the seal is the expectation
 * and every later reading is compared against it. Re-observing both sides on
 * every read would compare a value with itself, which is not a check.
 *
 * ## What a mismatch means
 *
 * A provider volume id can be reassigned, and a device number is reused freely
 * across reboots. If the sealed triple stops matching, this is not the volume
 * the record was written about — which is exactly the case where continuing
 * would let a runtime call somebody else's disk its own workspace. There is no
 * repair here: the seal is never rewritten, and the runtime reports not ready.
 *
 * The seal lives beside the restore record under the runtime's own `stateDir`,
 * not under the launch supervisor's manifest root — those are different owners
 * with different lifetimes, and sharing a directory makes one able to break the
 * other.
 */
import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';
import type { ManagedVolumeBinding } from '@/managed/managedRuntimeFacts';

export const MANAGED_VOLUME_SEAL_VERSION = 1;

/** What the runtime can see about the volume its project root is on. */
export type ManagedVolumeObservation = {
    /** e.g. `259:1`. Meaningful only on the boot that observed it. */
    deviceMajorMinor: string;
    /** The filesystem's own identity. Survives reattachment; a device number does not. */
    fsUuid: string;
};

export type ManagedVolumeBindingOutcome =
    | { ok: true; binding: ManagedVolumeBinding; seal: 'created' | 'existing' }
    | {
        ok: false;
        reason:
            /** The runtime could not read where its root lives. Not knowing is not ready. */
            | 'unobservable'
            /** A seal exists and does not describe what is mounted now. */
            | 'sealed-mismatch'
            /** A seal exists and cannot be trusted. Never overwritten. */
            | 'seal-unusable';
    };

export function managedVolumeSealPath(stateDir: string): string {
    return join(stateDir, 'managed-volume.json');
}

type SealedRecord = ManagedVolumeBinding;

function parseSeal(raw: unknown): SealedRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.version !== MANAGED_VOLUME_SEAL_VERSION) return null;
    const fields = {
        providerVolumeId: record.providerVolumeId,
        deviceMajorMinor: record.deviceMajorMinor,
        fsUuid: record.fsUuid,
    };
    for (const value of Object.values(fields)) {
        if (typeof value !== 'string' || value.trim() === '') return null;
    }
    return fields as SealedRecord;
}

function readSeal(
    stateDir: string,
    deps: ManagedProvisioningDeps,
): SealedRecord | 'absent' | 'unusable' {
    const path = managedVolumeSealPath(stateDir);
    // The **parent directory** is walked, not the file: the chain check requires
    // every component to be a directory, so handing it a file path refuses
    // always. The leaf is judged on its open descriptor instead.
    if (trustedPathRefusal(dirname(resolve(path)), deps.getuid(), 'unreadable', deps)) {
        return 'unusable';
    }
    const file = readRootProtectedFile(path, deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') return 'absent';
    if (file.kind !== 'ok') return 'unusable';
    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return 'unusable';
    }
    return parseSeal(parsed) ?? 'unusable';
}

/**
 * Seals the volume on first sight, and verifies it on every boot after.
 *
 * `observe` returns `null` when the runtime cannot tell — a mount table it
 * could not read, a root that is not on its own device, a UUID the kernel does
 * not report. That is refused rather than sealed: a seal made from a guess is
 * worse than no seal, because everything after it compares against the guess.
 */
export async function resolveManagedVolumeBinding(input: {
    stateDir: string;
    /** The provider's id for the volume this operation attached. From the marker. */
    providerVolumeId: string;
    /** Reads the device and filesystem identity of the project root. Root only. */
    observe: () => ManagedVolumeObservation | null;
    deps: ManagedProvisioningDeps;
    /** Overridden only by tests; the default flushes the file and its directory. */
    syncDirectory?: (path: string) => Promise<void>;
    /** Overridden only by tests, to fail inside the window before publishing. */
    syncFile?: (handle: fs.FileHandle) => Promise<void>;
}): Promise<ManagedVolumeBindingOutcome> {
    const syncDirectory = input.syncDirectory ?? (async (target: string) => {
        const dir = await fs.open(target, constants.O_RDONLY);
        try {
            await dir.sync();
        } finally {
            await dir.close();
        }
    });
    const syncFile = input.syncFile ?? ((handle: fs.FileHandle) => handle.sync());

    const sealed = readSeal(input.stateDir, input.deps);
    if (sealed === 'unusable') return { ok: false, reason: 'seal-unusable' };

    const observed = input.observe();
    if (!observed
        || observed.deviceMajorMinor.trim() === ''
        || observed.fsUuid.trim() === '') {
        return { ok: false, reason: 'unobservable' };
    }
    const binding: ManagedVolumeBinding = {
        providerVolumeId: input.providerVolumeId,
        deviceMajorMinor: observed.deviceMajorMinor,
        fsUuid: observed.fsUuid,
    };

    if (sealed !== 'absent') {
        /*
         * All three axes. The provider id alone is not enough — it can be
         * reassigned — and the device number alone is not either, since the
         * kernel reuses those. The filesystem UUID is the one that follows the
         * data, and it is compared together with the other two so that a
         * runtime cannot agree with a record about a volume it is not on.
         */
        if (sealed.providerVolumeId !== binding.providerVolumeId
            || sealed.fsUuid !== binding.fsUuid) {
            return { ok: false, reason: 'sealed-mismatch' };
        }
        /*
         * The device number is **this boot's** observation, not part of the
         * identity, so the seal's copy is replaced rather than compared.
         *
         * The kernel assigns `major:minor` at attach time: the same provider
         * volume reattached after a restart, or moved to another host, comes
         * back as a different number with nothing about the data changed.
         * Comparing it refused that volume *permanently* — the seal is never
         * rewritten, so the runtime could never start on its own data again.
         *
         * What is compared is what actually follows the data: the filesystem's
         * own UUID, together with the provider id that says which volume was
         * attached. Either alone is too weak — a provider id can be reassigned,
         * and a UUID says nothing about which volume the provider gave us.
         */
        /*
         * Agreeing with a seal this boot did not write is a claim that it is on
         * the disk. The boot that wrote it may have died before its directory
         * entry was flushed, or that flush may simply have failed, so this one
         * flushes rather than inheriting the assumption — a seal that vanishes
         * is a runtime that re-seals whatever volume it next finds as its own.
         */
        if (!await flushSeal(managedVolumeSealPath(input.stateDir), input.stateDir, syncDirectory)) {
            return { ok: false, reason: 'seal-unusable' };
        }
        return {
            ok: true,
            binding: { ...sealed, deviceMajorMinor: binding.deviceMajorMinor },
            seal: 'existing',
        };
    }

    const path = managedVolumeSealPath(input.stateDir);

    /*
     * Written to a temporary of this call's own, flushed, and only then
     * published.
     *
     * Opening the seal's own path directly was the defect. The seal is never
     * rewritten — that is the property everything after it relies on — so a
     * crash between the `open` and the flush does not leave a stale file the
     * next boot replaces. It leaves a permanent one: unusable to every later
     * boot, and there is no way past it from inside the runtime.
     */
    const temporary = join(input.stateDir, `.volume-seal.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            await handle.writeFile(JSON.stringify({
                version: MANAGED_VOLUME_SEAL_VERSION,
                ...binding,
            }));
            // Explicit rather than left to `O_CREAT`'s masked mode.
            await handle.chmod(0o600);
            await syncFile(handle);
        } finally {
            await handle.close();
        }
    } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        return { ok: false, reason: 'seal-unusable' };
    }

    try {
        // `link`, not `rename`: two producers racing must not both believe they
        // sealed it, and replacing a seal that is already the authority is the
        // thing this refuses to do.
        await fs.link(temporary, path);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return { ok: false, reason: 'seal-unusable' };
        }
        const settled = readSeal(input.stateDir, input.deps);
        if (settled === 'absent' || settled === 'unusable') {
            return { ok: false, reason: 'seal-unusable' };
        }
        // Same rule as above: the durable identity is the provider id and the
        // filesystem UUID; the device number is what this boot happens to see.
        if (settled.providerVolumeId !== binding.providerVolumeId
            || settled.fsUuid !== binding.fsUuid) {
            return { ok: false, reason: 'sealed-mismatch' };
        }
        /*
         * Adopting says the seal is on the disk. The boot that wrote it may
         * have died before its directory entry was flushed — or that flush may
         * simply have failed — so this one flushes rather than inheriting the
         * assumption. A seal that vanishes is a runtime that re-seals somebody
         * else's volume as its own.
         */
        if (!await flushSeal(path, input.stateDir, syncDirectory)) {
            return { ok: false, reason: 'seal-unusable' };
        }
        return {
            ok: true,
            binding: { ...settled, deviceMajorMinor: binding.deviceMajorMinor },
            seal: 'existing',
        };
    }
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    // The directory entry too: without this the file can be gone after a crash
    // even though its contents were flushed.
    try {
        await syncDirectory(input.stateDir);
    } catch {
        return { ok: false, reason: 'seal-unusable' };
    }
    return { ok: true, binding, seal: 'created' };
}

/**
 * Flushes a seal this call did not write, and its directory entry.
 *
 * Reports failure rather than throwing: the caller turns it into
 * `seal-unusable`, because a seal that cannot be proved durable is not one to
 * proceed on.
 */
async function flushSeal(
    path: string,
    directory: string,
    syncDirectory: (path: string) => Promise<void>,
): Promise<boolean> {
    try {
        const handle = await fs.open(path, constants.O_RDONLY);
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        await syncDirectory(directory);
        return true;
    } catch {
        return false;
    }
}
