/**
 * The runtime's answer to "are you ready?", assembled for the parent.
 *
 * Every field comes from something the runtime cannot talk itself into: the
 * protected provisioning marker, the kernel's own view of where the project
 * root is mounted, the completion record only root can write, and the
 * isolation backend's own answer. Nothing here is taken from the request.
 *
 * Reading changes nothing. The parent polls this — including on a runtime
 * whose lease has expired — and a reading that renewed a lease or advanced a
 * sequence would make asking the way to stay alive.
 */
import { MANAGED_PROJECT_ROOT, type ManagedRuntimeIdentity } from '@/daemon/managedRuntimeIdentity';
import type { ManagedFilesystemFacts } from '@/managed/managedRuntimeFacts';
import type { ManagedRestoreState } from '@/managed/managedRestoreState';

export const MANAGED_RUNTIME_STATUS_VERSION = 1;

export type ManagedRuntimeStatus = {
    version: typeof MANAGED_RUNTIME_STATUS_VERSION;
    identity: {
        runtimeId: string;
        workspaceId: string;
        projectId: string;
        happyMachineId: string;
        provisioningOperationId: string;
        configDigest: string;
        providerMachineId: string;
        providerInstanceId: string;
    };
    epoch: number;
    renewalSeq: number;
    leaseRemainingMs: number;
    filesystem: {
        projectRoot: string;
        mountedVolumeId: string;
        rootOnExpectedVolume: boolean;
    };
    restore: ManagedRestoreState;
    isolation: { verified: boolean; backend: string };
};

export function buildManagedRuntimeStatus(input: {
    identity: ManagedRuntimeIdentity;
    /** What the runtime currently holds; never renewed by reading it. */
    lease: { epoch: number; renewalSeq: number; remainingMs: number };
    filesystem: ManagedFilesystemFacts;
    restore: ManagedRestoreState;
    isolation: { verified: boolean; backend: string };
}): ManagedRuntimeStatus {
    return {
        version: MANAGED_RUNTIME_STATUS_VERSION,
        identity: {
            runtimeId: input.identity.runtimeId,
            workspaceId: input.identity.workspaceId,
            projectId: input.identity.projectId,
            happyMachineId: input.identity.happyMachineId,
            provisioningOperationId: input.identity.provisioningOperationId,
            configDigest: input.identity.configDigest,
            providerMachineId: input.identity.providerMachineId,
            providerInstanceId: input.identity.providerInstanceId,
        },
        epoch: input.lease.epoch,
        renewalSeq: input.lease.renewalSeq,
        // An expired lease is nothing remaining. A negative number would be a
        // value the parent has to interpret, and interpretations differ.
        leaseRemainingMs: Math.max(0, input.lease.remainingMs),
        filesystem: input.filesystem.ok
            ? {
                projectRoot: input.filesystem.projectRoot,
                mountedVolumeId: input.filesystem.mountedVolumeId,
                rootOnExpectedVolume: true,
            }
            : {
                // A volume that could not be verified is reported as no volume
                // rather than as the one that was expected: naming it here
                // would be this runtime agreeing with a claim it could not
                // check.
                projectRoot: MANAGED_PROJECT_ROOT,
                mountedVolumeId: '',
                rootOnExpectedVolume: false,
            },
        restore: input.restore,
        isolation: { verified: input.isolation.verified, backend: input.isolation.backend },
    };
}
