/**
 * Where the project root actually lives.
 *
 * `/proc/self/mountinfo` describes mounts in the kernel's terms: a device as
 * `major:minor`, a source, and a mount point. It says nothing about a provider
 * volume id — that is a concept of the provider's API, not of the filesystem.
 * So the id is never read out of a mount line, and it is never echoed back
 * from what the caller expected: the runtime reports it only when independent
 * device evidence matches the mapping root wrote at provisioning time.
 *
 * Pure: the mountinfo text and the evidence are inputs, so the whole decision
 * is exercised on every platform rather than only on the one that has /proc.
 */
import { describe, expect, it } from 'vitest';

import { resolveManagedFilesystemFacts } from '@/managed/managedRuntimeFacts';

const ROOT = '/workspace/project';

/** Real `mountinfo` shape: id parent major:minor rootInDevice mountPoint … - fstype source … */
const line = (over: Partial<{
    id: string; parent: string; dev: string; rootInDevice: string;
    mountPoint: string; fstype: string; source: string;
}> = {}) => {
    const f = {
        id: '31', parent: '1', dev: '259:1', rootInDevice: '/',
        mountPoint: '/workspace', fstype: 'ext4', source: '/dev/vdb', ...over,
    };
    return `${f.id} ${f.parent} ${f.dev} ${f.rootInDevice} ${f.mountPoint} rw,relatime shared:1 - ${f.fstype} ${f.source} rw`;
};

const binding = { providerVolumeId: 'vol_abc123', deviceMajorMinor: '259:1', fsUuid: 'uuid-1' };
// The device the opened project root really sits on. A lexical answer would be
// whatever the path spelled; this is what the descriptor reports.
const evidence = {
    readFsUuid: () => 'uuid-1',
    verifyOpenDevice: () => ({ ok: true as const }),
};

describe('the volume the project root is on', () => {
    it('reports the provisioned id once the device underneath actually matches', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: [line({ mountPoint: '/' , dev: '254:0', source: '/dev/vda1' }), line()].join('\n'),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({
            ok: true,
            projectRoot: ROOT,
            mountedVolumeId: 'vol_abc123',
            rootOnExpectedVolume: true,
        });
    });

    it('takes the mount the root is really under, not an ancestor of it', () => {
        // `/` also contains the root. A parent mount winning here would report
        // the root as being on the boot device while it sits on the volume.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: [
                line({ mountPoint: '/', dev: '254:0', source: '/dev/vda1' }),
                line({ mountPoint: '/workspace', dev: '259:1' }),
            ].join('\n'),
            projectRoot: ROOT,
            binding: { ...binding, deviceMajorMinor: '254:0' },
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'root-on-other-device' });
    });

    it('refuses when the root is on a different device than was provisioned', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line({ dev: '259:9' }),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'root-on-other-device' });
    });

    it('refuses when the filesystem identity does not match, even on the right device', () => {
        // Same device number after a reattach is not the same filesystem.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line(),
            projectRoot: ROOT,
            binding,
            readFsUuid: () => 'uuid-someone-else',
            verifyOpenDevice: () => ({ ok: true as const }),
        });
        expect(facts).toEqual({ ok: false, reason: 'volume-identity-mismatch' });
    });

    it('refuses when the evidence cannot be read at all', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line(),
            projectRoot: ROOT,
            binding,
            readFsUuid: () => null,
            verifyOpenDevice: () => ({ ok: true as const }),
        });
        expect(facts).toEqual({ ok: false, reason: 'volume-evidence-unavailable' });
    });

    it('never reads a volume id out of a mount source that looks like one', () => {
        // A source spelled `vol_abc123` is a string on a device, not proof of
        // which provider volume this is.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line({ dev: '259:9', source: 'vol_abc123' }),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'root-on-other-device' });
    });

    it('refuses when nothing is mounted over the root at all', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line({ mountPoint: '/var/lib/other' }),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'root-not-mounted' });
    });

    it.each(['/workspace-old', '/workspace/pro'])(
        'does not mistake %s for an ancestor of the root', (mountPoint) => {
            // Containment is by path segment. `/workspace/pro` is a prefix of
            // `/workspace/project` as a string and no part of it as a path —
            // matching on the string would report the root as living on a
            // volume it has never been on.
            const facts = resolveManagedFilesystemFacts({
                mountinfo: line({ mountPoint }),
                projectRoot: ROOT,
                binding,
                ...evidence,
            });
            expect(facts).toEqual({ ok: false, reason: 'root-not-mounted' });
        },
    );

    it('refuses when two mounts claim the same point on different devices', () => {
        // An overmount hides whatever is beneath it, and `mountinfo` does not
        // say which one is on top — the order in the file is not that answer.
        // Picking either is a guess, and the wrong guess approves a root that
        // is really on somebody else's device.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: [
                line({ id: '31', mountPoint: '/workspace', dev: '259:1' }),
                line({ id: '44', mountPoint: '/workspace', dev: '259:9' }),
            ].join('\n'),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'mount-ambiguous' });
    });

    it('accepts two entries for the same point when they are the same device', () => {
        // A re-mount of the same device is not an ambiguity: whichever is on
        // top, the root is on the device that was provisioned.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: [
                line({ id: '31', mountPoint: '/workspace', dev: '259:1' }),
                line({ id: '44', mountPoint: '/workspace', dev: '259:1' }),
            ].join('\n'),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toMatchObject({ ok: true, mountedVolumeId: 'vol_abc123' });
    });

    it('refuses a mount that exposes only part of its device', () => {
        // `rootInDevice` other than `/` is a bind mount of a subtree: the
        // device matches while the path the root sits at is somebody else's
        // choice, and matching the device says nothing about the content.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line({ rootInDevice: '/some/other/subtree' }),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toEqual({ ok: false, reason: 'mount-not-whole-device' });
    });

    it('refuses when the opened root is not on the device the mount claims', () => {
        // The mount table can describe a path that a symlink redirects
        // elsewhere. What the producer will actually use is the object behind
        // the descriptor, so that is what has to match.
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line(),
            projectRoot: ROOT,
            binding,
            readFsUuid: () => 'uuid-1',
            verifyOpenDevice: () => ({ ok: false as const, reason: 'root-on-other-device' as const }),
        });
        expect(facts).toEqual({ ok: false, reason: 'root-on-other-device' });
    });

    it('refuses when the root cannot be opened at all', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: line(),
            projectRoot: ROOT,
            binding,
            readFsUuid: () => 'uuid-1',
            verifyOpenDevice: () => ({ ok: false as const, reason: 'root-not-mounted' as const }),
        });
        expect(facts).toEqual({ ok: false, reason: 'root-not-mounted' });
    });

    it('skips lines it cannot parse rather than guessing at them', () => {
        const facts = resolveManagedFilesystemFacts({
            mountinfo: ['garbage', '', line()].join('\n'),
            projectRoot: ROOT,
            binding,
            ...evidence,
        });
        expect(facts).toMatchObject({ ok: true, mountedVolumeId: 'vol_abc123' });
    });

    it('refuses an empty mountinfo instead of treating it as no volume', () => {
        expect(resolveManagedFilesystemFacts({
            mountinfo: '',
            projectRoot: ROOT,
            binding,
            ...evidence,
        })).toEqual({ ok: false, reason: 'mountinfo-unreadable' });
    });
});
