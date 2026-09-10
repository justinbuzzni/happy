/**
 * Reading the two axes a volume seal is made of.
 *
 * The deciders that consume this are already tested; what is tested here is
 * the reading itself — which mount is meant, how a filesystem identity is
 * matched to a device, and that every way of not knowing answers `null` rather
 * than something that looks like knowledge.
 */
import { describe, expect, it } from 'vitest';

import {
    FS_UUID_DIR,
    deviceForPath,
    observeManagedVolume,
    readFsUuidForDevice,
} from '@/managed/managedRuntimeObserver';

/** Real `mountinfo` shape: id parent major:minor rootInDevice mountPoint … */
const MOUNTINFO = [
    '21 1 259:0 / / rw,relatime shared:1 - ext4 /dev/root rw',
    '38 21 259:1 / /workspace rw,relatime shared:2 - ext4 /dev/vdb rw',
    '44 21 0:44 / /workspace-old rw,relatime shared:3 - tmpfs tmpfs rw',
].join('\n');

describe('the mount the project root is really on', () => {
    it('takes the deepest mount that contains the path, not the first', () => {
        // `/` contains everything. Taking the first match reports the root as
        // living on the boot device while it sits on the attached volume.
        expect(deviceForPath(MOUNTINFO, '/workspace/project')).toBe('259:1');
    });

    it('does not read containment as a string prefix', () => {
        // `/workspace-old` is not an ancestor of `/workspace/project`.
        expect(deviceForPath(MOUNTINFO, '/workspace-old/thing')).toBe('0:44');
        expect(deviceForPath(MOUNTINFO, '/workspace/project')).toBe('259:1');
        // And a *deeper* name that merely shares a prefix must not win either:
        // `/workspace/pro` is a longer string than `/workspace`, so a prefix
        // test picks it and reports the root on a device it is not on.
        const decoy = `${MOUNTINFO}\n60 21 8:5 / /workspace/pro rw - ext4 /dev/vdd rw`;
        expect(deviceForPath(decoy, '/workspace/project')).toBe('259:1');
    });

    it('refuses to pick when two devices are mounted at the same point', () => {
        // `mountinfo` does not say which is on top; either choice is a guess,
        // and the wrong guess seals the root against a volume it is not on.
        const shadowed = `${MOUNTINFO}\n50 21 259:9 / /workspace rw - ext4 /dev/vdc rw`;
        expect(deviceForPath(shadowed, '/workspace/project')).toBeNull();
    });

    it('ignores lines that are not mounts', () => {
        expect(deviceForPath('garbage\n\nalso garbage', '/workspace/project')).toBeNull();
    });
});

describe('the filesystem identity of a device', () => {
    const entries = ['1111-aaaa', '2222-bbbb'];
    const rdev = (path: string): number | null => {
        if (path === `${FS_UUID_DIR}/1111-aaaa`) return 259 * 256 + 1;
        if (path === `${FS_UUID_DIR}/2222-bbbb`) return 259 * 256 + 9;
        return null;
    };

    it('matches on the device number, never on the entry name', () => {
        // The name is a string anyone naming a device can spell; `rdev` is what
        // the kernel reported at both ends.
        expect(readFsUuidForDevice('259:1', { listUuidEntries: () => entries, deviceOf: rdev }))
            .toBe('1111-aaaa');
    });

    it('answers null for a device that publishes no identity', () => {
        // Not "fall back to the device number": a device number is reused, and
        // an identity that is really a device number would let a reattached
        // volume pass as the same filesystem.
        expect(readFsUuidForDevice('8:0', { listUuidEntries: () => entries, deviceOf: rdev }))
            .toBeNull();
    });

    it('answers null when two names point at one device', () => {
        expect(readFsUuidForDevice('259:1', {
            listUuidEntries: () => ['1111-aaaa', 'duplicate'],
            deviceOf: (path) => (path.endsWith('nothing') ? null : 259 * 256 + 1),
        })).toBeNull();
    });

    it('answers null when the directory cannot be listed', () => {
        expect(readFsUuidForDevice('259:1', { listUuidEntries: () => [], deviceOf: rdev })).toBeNull();
    });

    it('answers null for a device number the kernel would not print', () => {
        expect(readFsUuidForDevice('not-a-device', { listUuidEntries: () => entries, deviceOf: rdev }))
            .toBeNull();
    });
});

describe('what this boot can observe about its volume', () => {
    const deps = {
        readMountinfo: () => MOUNTINFO,
        listUuidEntries: () => ['1111-aaaa'],
        deviceOf: () => 259 * 256 + 1,
    };

    it('reports the device and identity of the mount under the project root', () => {
        expect(observeManagedVolume({ projectRoot: '/workspace/project', deps }))
            .toEqual({ deviceMajorMinor: '259:1', fsUuid: '1111-aaaa' });
    });

    it('observes nothing when the mount table cannot be read', () => {
        // The producer turns this into a refusal to seal. Sealing on a guess is
        // how a volume full of real work gets labelled as freshly initialised.
        expect(observeManagedVolume({
            projectRoot: '/workspace/project',
            deps: { ...deps, readMountinfo: () => null },
        })).toBeNull();
    });

    it('observes nothing when the device has no readable identity', () => {
        expect(observeManagedVolume({
            projectRoot: '/workspace/project',
            deps: { ...deps, listUuidEntries: () => [] },
        })).toBeNull();
    });
});
