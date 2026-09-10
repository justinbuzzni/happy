/**
 * The answer a runtime gives when the parent asks whether it is ready.
 *
 * Assembled from things only root can write and things the kernel says, never
 * from what was asked for. Reading it changes nothing: the parent asks this
 * question repeatedly, including while a runtime is expired, and an answer
 * that renewed a lease or advanced a sequence would make asking the way to
 * stay alive.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { buildManagedRuntimeStatus } from '@/managed/managedRuntimeStatus';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

const identity = {
    verifier: generateKeyPairSync('ed25519').publicKey,
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    happyMachineId: 'machine-1',
    provisioningOperationId: 'op-1',
    configDigest: 'digest-1',
    providerMachineId: 'provider-machine-1',
    providerInstanceId: 'provider-instance-1',
    providerVolumeId: 'vol_fixture_1',
    stateDir: '/state',
    isolation: { backend: 'privileged-launch-supervisor' as const, provider: { uid: 901, gid: 901 }, executor: { uid: 902, gid: 901 }, cgroupRoot: '/c' },
};

function deps(over: Record<string, unknown> = {}) {
    return {
        identity,
        lease: { epoch: 3, renewalSeq: 7, remainingMs: 30_000 },
        filesystem: {
            ok: true as const,
            projectRoot: MANAGED_PROJECT_ROOT,
            mountedVolumeId: 'vol_abc123',
            rootOnExpectedVolume: true as const,
        },
        restore: { status: 'restored' as const, checkpointId: 'ckpt-1', manifestDigest: 'd1' },
        isolation: { verified: false, backend: 'privileged-launch-supervisor' },
        ...over,
    };
}

describe('the status a runtime reports', () => {
    it('carries every axis the parent compares, from the protected identity', () => {
        const status = buildManagedRuntimeStatus(deps());
        expect(status.identity).toEqual({
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            happyMachineId: 'machine-1',
            provisioningOperationId: 'op-1',
            configDigest: 'digest-1',
            providerMachineId: 'provider-machine-1',
            providerInstanceId: 'provider-instance-1',
        });
        expect(status.epoch).toBe(3);
        expect(status.renewalSeq).toBe(7);
        expect(status.leaseRemainingMs).toBe(30_000);
        expect(status.filesystem).toEqual({
            projectRoot: MANAGED_PROJECT_ROOT,
            mountedVolumeId: 'vol_abc123',
            rootOnExpectedVolume: true,
        });
        expect(status.restore).toEqual({
            status: 'restored', checkpointId: 'ckpt-1', manifestDigest: 'd1',
        });
    });

    it('reports a runtime that has never been granted an epoch', () => {
        // Zero is the honest answer before the first grant, and the parent
        // asks precisely to learn it.
        const status = buildManagedRuntimeStatus(deps({
            lease: { epoch: 0, renewalSeq: 0, remainingMs: 0 },
        }));
        expect(status.epoch).toBe(0);
        expect(status.renewalSeq).toBe(0);
        expect(status.leaseRemainingMs).toBe(0);
    });

    it('never reports a negative remaining lease', () => {
        // An expired lease is zero remaining, not a negative number the parent
        // would have to interpret.
        const status = buildManagedRuntimeStatus(deps({
            lease: { epoch: 3, renewalSeq: 7, remainingMs: -5_000 },
        }));
        expect(status.leaseRemainingMs).toBe(0);
    });

    it('reports isolation as it was actually probed', () => {
        // No backend is implemented yet, so `false` is the true answer. A
        // status that reported `true` would be the one thing standing between
        // an unfenced runtime and real work.
        expect(buildManagedRuntimeStatus(deps()).isolation)
            .toEqual({ verified: false, backend: 'privileged-launch-supervisor' });
    });

    it('reports a filesystem it could not verify as not on the expected volume', () => {
        const status = buildManagedRuntimeStatus(deps({
            filesystem: { ok: false as const, reason: 'mount-ambiguous' as const },
        }));
        expect(status.filesystem).toEqual({
            projectRoot: MANAGED_PROJECT_ROOT,
            mountedVolumeId: '',
            rootOnExpectedVolume: false,
        });
    });

    it('is a pure reading: nothing it touches is asked to change', () => {
        // The parent polls this, including on an expired runtime. If asking
        // renewed anything, asking would be how a runtime stayed alive.
        const lease = { epoch: 3, renewalSeq: 7, remainingMs: 0 };
        const frozen = Object.freeze({ ...lease });
        const status = buildManagedRuntimeStatus(deps({ lease: frozen }));
        expect(status.leaseRemainingMs).toBe(0);
        expect(frozen).toEqual(lease);
    });
});
