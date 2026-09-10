/**
 * The only place that actually looks at the kernel.
 *
 * `managedRuntimeFacts` and `managedVolumeBinding` decide; neither reads
 * anything. That split is deliberate — the decisions are testable everywhere,
 * including the machines this is written on, which have no `/proc`. What was
 * missing was the other half: something that reads the two axes those
 * decisions are given, and reads them honestly.
 *
 * Two axes, and both are read rather than assumed:
 *
 *  - **the device the project root is mounted from**, taken from
 *    `/proc/self/mountinfo`; and
 *  - **that device's filesystem identity**, taken from `/dev/disk/by-uuid`,
 *    where the kernel (through udev) publishes one symlink per filesystem.
 *
 * The UUID is matched by **device number**, never by name. The entries in that
 * directory are symlinks to `/dev/…` nodes, and matching on the link's text
 * would mean trusting a string that a name can be made to spell. `stat` on the
 * resolved node reports `rdev`, which is the same pair `mountinfo` printed, so
 * the two axes are joined on a number the kernel produced at both ends.
 *
 * Everything here answers `null` rather than throwing or guessing. A runtime
 * that cannot see where its root lives is not ready, and "not knowing" has to
 * stay distinguishable from "knowing it is wrong" — the callers grade those
 * two differently.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { deviceIdFromMajorMinor } from '@/managed/managedRuntimeDurability';
import type { ManagedVolumeObservation } from '@/managed/managedVolumeBinding';

/** Where the kernel describes this process's mounts. */
export const MOUNTINFO_PATH = '/proc/self/mountinfo';

/** Where udev publishes one symlink per filesystem identity. */
export const FS_UUID_DIR = '/dev/disk/by-uuid';

export type ManagedRuntimeObserverDeps = {
    readMountinfo?: () => string | null;
    listUuidEntries?: () => string[];
    /** The device number of a `/dev` node, as `stat` reports it. */
    deviceOf?: (path: string) => number | null;
};

export function readMountinfoText(): string | null {
    try {
        return readFileSync(MOUNTINFO_PATH, 'utf8');
    } catch {
        // Off Linux, or unreadable. Not an error to report — an absence to
        // carry, so the caller can say "I do not know" rather than "not ready".
        return null;
    }
}

function defaultListUuidEntries(): string[] {
    try {
        return readdirSync(FS_UUID_DIR);
    } catch {
        return [];
    }
}

function defaultDeviceOf(path: string): number | null {
    try {
        // Deliberately follows the symlink: the entry *is* a link to the node,
        // and the node is what carries `rdev`. What is not followed is the
        // link's *name* — the match is on the number, below.
        return statSync(path).rdev;
    } catch {
        return null;
    }
}

/**
 * The filesystem identity of a device, or `null` when it cannot be read.
 *
 * Matching is on `rdev`. A directory entry named after a UUID proves nothing
 * about which device it points at, and a device that is not published here has
 * no identity this runtime can verify — for which `null` is the correct answer,
 * not a fallback to the device number.
 */
export function readFsUuidForDevice(
    deviceMajorMinor: string,
    deps: ManagedRuntimeObserverDeps = {},
): string | null {
    const wanted = deviceIdFromMajorMinor(deviceMajorMinor);
    if (wanted === null) return null;
    const deviceOf = deps.deviceOf ?? defaultDeviceOf;
    const entries = (deps.listUuidEntries ?? defaultListUuidEntries)();
    let found: string | null = null;
    for (const entry of entries) {
        if (deviceOf(join(FS_UUID_DIR, entry)) !== wanted) continue;
        // Two names for one device means the identity is not a single answer.
        // Picking the first is a guess, and a guess here seals a volume.
        if (found !== null && found !== entry) return null;
        found = entry;
    }
    return found;
}

/**
 * What this boot can see about the volume the project root is on.
 *
 * The device comes from the deepest mount containing the root — the same rule
 * `managedRuntimeFacts` applies, and applied here through the same parser so
 * the seal and the readiness answer cannot disagree about which mount they
 * mean. Ambiguity is `null`: two mounts at one point hide each other, and
 * `mountinfo` does not say which is on top.
 */
export function observeManagedVolume(input: {
    projectRoot: string;
    deps?: ManagedRuntimeObserverDeps;
}): ManagedVolumeObservation | null {
    const deps = input.deps ?? {};
    const text = (deps.readMountinfo ?? readMountinfoText)();
    if (text === null) return null;
    const device = deviceForPath(text, input.projectRoot);
    if (device === null) return null;
    const fsUuid = readFsUuidForDevice(device, deps);
    if (fsUuid === null) return null;
    return { deviceMajorMinor: device, fsUuid };
}

/**
 * The device of the deepest mount containing `path`, or `null`.
 *
 * Exported because the seal producer and the readiness reader must agree about
 * which mount they are talking about; two implementations of "deepest" would
 * eventually pick different ones.
 */
export function deviceForPath(mountinfo: string, path: string): string | null {
    let deepest: { device: string; mountPoint: string } | null = null;
    let ambiguous = false;
    for (const rawLine of mountinfo.split('\n')) {
        const fields = rawLine.trim().split(/\s+/);
        if (fields.length < 5) continue;
        const device = fields[2]!;
        const mountPoint = fields[4]!;
        if (!/^\d+:\d+$/.test(device) || !mountPoint.startsWith('/')) continue;
        // Containment by segment: `/workspace-old` does not contain
        // `/workspace/project`.
        const contains = mountPoint === '/'
            || path === mountPoint
            || path.startsWith(`${mountPoint}/`);
        if (!contains) continue;
        if (!deepest || mountPoint.length > deepest.mountPoint.length) {
            deepest = { device, mountPoint };
            ambiguous = false;
        } else if (mountPoint.length === deepest.mountPoint.length && device !== deepest.device) {
            ambiguous = true;
        }
    }
    if (!deepest || ambiguous) return null;
    return deepest.device;
}
