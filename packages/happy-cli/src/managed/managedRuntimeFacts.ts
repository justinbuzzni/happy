/**
 * What the kernel says about where the project root lives.
 *
 * ## Why a provider volume id cannot be read from here
 *
 * `/proc/self/mountinfo` describes mounts in the kernel's terms: a device as
 * `major:minor`, the source that was mounted, and where it landed. A provider
 * volume id (`vol_…`) exists in the provider's API and nowhere in this file.
 * A source string that happens to spell one is a string, not evidence.
 *
 * So the id is never derived from a mount line, and it is never echoed back
 * from what the caller expected either — echoing would make the check a
 * tautology. It is reported only when the device the root actually sits on
 * matches the mapping root recorded at provisioning time, and the filesystem
 * identity on that device matches too: a reattached volume can reuse a device
 * number without being the same filesystem.
 *
 * Pure. The mountinfo text, the identity reader and the device check are
 * inputs, so the decision runs everywhere rather than only where `/proc`
 * exists — and the device check itself is a real `O_NOFOLLOW` open in
 * `managedRuntimeDurability`.
 */
import { deviceIdFromMajorMinor, type DeviceCheck } from '@/managed/managedRuntimeDurability';

/** The mapping root wrote at provisioning: a provider id and the evidence for it. */
export type ManagedVolumeBinding = {
    providerVolumeId: string;
    /** The device the volume was attached as, e.g. `259:1`. */
    deviceMajorMinor: string;
    /** The filesystem's own identity on that device. */
    fsUuid: string;
};

export type ManagedFilesystemFacts =
    | {
        ok: true;
        projectRoot: string;
        mountedVolumeId: string;
        rootOnExpectedVolume: true;
    }
    | {
        ok: false;
        reason:
            | 'mountinfo-unreadable'
            | 'root-not-mounted'
            | 'root-on-other-device'
            | 'mount-ambiguous'
            | 'mount-not-whole-device'
            | 'volume-identity-mismatch'
            | 'volume-evidence-unavailable';
    };

type MountEntry = { deviceMajorMinor: string; mountPoint: string; rootInDevice: string };

/**
 * The mount a path is really on: the deepest mount point that contains it.
 *
 * `/` contains everything, so the first match is almost always the wrong one —
 * it would report the root as living on the boot device while it sits on the
 * attached volume. Containment is by path segment, so `/workspace-old` is not
 * an ancestor of `/workspace/project`.
 */
function mountFor(entries: MountEntry[], path: string): MountEntry[] {
    let deepest: MountEntry[] = [];
    for (const entry of entries) {
        const contains = entry.mountPoint === '/'
            || path === entry.mountPoint
            || path.startsWith(`${entry.mountPoint}/`);
        if (!contains) continue;
        const current = deepest[0];
        if (!current || entry.mountPoint.length > current.mountPoint.length) {
            deepest = [entry];
        } else if (entry.mountPoint.length === current.mountPoint.length) {
            // Every mount at that same point, kept: `mountinfo` does not say
            // which of them is on top, so the caller decides whether the set
            // agrees rather than this function picking one.
            deepest.push(entry);
        }
    }
    return deepest;
}

function parseMountinfo(text: string): MountEntry[] {
    const entries: MountEntry[] = [];
    for (const rawLine of text.split('\n')) {
        // id parent major:minor rootInDevice mountPoint options… - fstype source…
        const fields = rawLine.trim().split(/\s+/);
        if (fields.length < 5) continue;
        const deviceMajorMinor = fields[2];
        const rootInDevice = fields[3];
        const mountPoint = fields[4];
        if (!/^\d+:\d+$/.test(deviceMajorMinor)) continue;
        if (!mountPoint.startsWith('/')) continue;
        if (!rootInDevice.startsWith('/')) continue;
        entries.push({ deviceMajorMinor, mountPoint, rootInDevice });
    }
    return entries;
}

export function resolveManagedFilesystemFacts(input: {
    mountinfo: string;
    projectRoot: string;
    binding: ManagedVolumeBinding;
    /** Reads the filesystem identity of a device; `null` when it cannot be read. */
    readFsUuid: (deviceMajorMinor: string) => string | null;
    /**
     * Confirms the opened project root is on a given device.
     *
     * The mount table describes paths; a symlink can make the path the
     * producer would actually open resolve somewhere else entirely. This asks
     * the descriptor rather than the string.
     */
    verifyOpenDevice: (path: string, expectedDevice: number) => DeviceCheck;
}): ManagedFilesystemFacts {
    const entries = parseMountinfo(input.mountinfo);
    // Nothing parsed is not "no volume mounted" — it is not knowing, and a
    // runtime that does not know where its root lives is not ready.
    if (entries.length === 0) return { ok: false, reason: 'mountinfo-unreadable' };

    const candidates = mountFor(entries, input.projectRoot);
    if (candidates.length === 0) return { ok: false, reason: 'root-not-mounted' };
    // Two mounts at one point hide each other, and the file does not say which
    // is on top. Picking either is a guess, and the wrong guess approves a root
    // that is really on another device.
    const devices = new Set(candidates.map((entry) => entry.deviceMajorMinor));
    const subtrees = new Set(candidates.map((entry) => entry.rootInDevice));
    if (devices.size > 1 || subtrees.size > 1) return { ok: false, reason: 'mount-ambiguous' };

    const mount = candidates[0];
    if (mount.deviceMajorMinor !== input.binding.deviceMajorMinor) {
        return { ok: false, reason: 'root-on-other-device' };
    }
    // A bind mount exposes a subtree of a device at a path someone chose. The
    // device would match while the content behind the root is not the volume's
    // own root, so device agreement proves nothing about what is there.
    if (mount.rootInDevice !== '/') return { ok: false, reason: 'mount-not-whole-device' };

    // Asked of the descriptor, not of the path: this is the object the
    // producer would actually write into.
    const expectedDevice = deviceIdFromMajorMinor(mount.deviceMajorMinor);
    if (expectedDevice === null) return { ok: false, reason: 'mountinfo-unreadable' };
    const opened = input.verifyOpenDevice(input.projectRoot, expectedDevice);
    if (!opened.ok) return { ok: false, reason: opened.reason };

    const fsUuid = input.readFsUuid(mount.deviceMajorMinor);
    if (fsUuid === null) return { ok: false, reason: 'volume-evidence-unavailable' };
    // A device number is reused across reattachments; the filesystem's own
    // identity is what says this is the volume that was provisioned.
    if (fsUuid !== input.binding.fsUuid) return { ok: false, reason: 'volume-identity-mismatch' };

    return {
        ok: true,
        projectRoot: input.projectRoot,
        // Reported only now: the id is the provisioner's, released by evidence
        // rather than repeated back unchecked.
        mountedVolumeId: input.binding.providerVolumeId,
        rootOnExpectedVolume: true,
    };
}
