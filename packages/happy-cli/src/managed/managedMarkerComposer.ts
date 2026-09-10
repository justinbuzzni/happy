/**
 * Turning the parent's boot input into the marker this runtime is judged by.
 *
 * The marker is the trust anchor: `resolveManagedRuntimeIdentity` reads it and
 * every readiness answer, receipt and fencing decision downstream is made in
 * the terms it sets. So the question this module answers is narrow and
 * important — **which of those terms may this machine supply for itself?**
 *
 * The answer is: none of the ones that identify it.
 *
 *  - The workspace, project, runtime, operation, config digest, state and
 *    workspace directories, the two uids, the cgroup root, the volume id and
 *    the verifier's public key all come from the **boot input file the parent
 *    placed into the machine at creation** (`config.files[]`: a known guest
 *    path with a base64 `raw_value`). A machine that filled any of them in
 *    would be answering a question about itself with its own claim.
 *
 *    A file, not a metadata lookup, and deliberately. Reading machine metadata
 *    from inside the guest means holding a provider API credential — one that
 *    can create, stop and inspect every machine in the app — in order to learn
 *    what the parent already knew when it created this one. The file carries
 *    exactly this machine's input and needs no credential at all. The same
 *    values also go out as machine metadata from the same producer, but that
 *    copy exists for the parent's ownership checks on the provider side.
 *  - The provider machine and instance ids come from what the machine can
 *    observe about itself, and they are the only axes where that is correct:
 *    they say *which instance is running*, which nothing else can know.
 *  - The Happy machine id comes from the bootstrap grant, because it is an
 *    address that only the server can issue.
 *
 * Nothing here has a default. A missing axis is a refusal, not a blank to fill:
 * the marker with an invented state directory is a marker that puts the receipt
 * store somewhere the agent can write, and the marker with an invented uid is
 * one that hands the workspace to the provider.
 *
 * This module composes and validates. Writing it down — once, root-owned,
 * never overwritten — is `writeManagedMarker`'s job in the boot stage.
 */
export type ManagedMarkerRecord = {
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    happyMachineId: string;
    provisioningOperationId: string;
    configDigest: string;
    providerMachineId: string;
    providerInstanceId: string;
    providerVolumeId: string;
    stateDir: string;
    workspaceDir: string;
    verifierPublicKey: string;
    isolation: {
        backend: string;
        provider: { uid: number; gid: number };
        executor: { uid: number; gid: number };
        cgroupRoot: string;
    };
};

export type ManagedMarkerRefusal =
    /** The provider recorded no managed metadata: this is not a managed machine. */
    | 'not-managed'
    | 'metadata-incomplete'
    | 'uid-not-separated'
    | 'instance-unidentified'
    | 'happy-address-missing';

export type ManagedMarkerOutcome =
    | { ok: true; record: ManagedMarkerRecord }
    | { ok: false; reason: ManagedMarkerRefusal };

/** The keys the parent writes into the boot input (and into metadata). */
const KEYS = {
    workspace: 'saycode_workspace',
    project: 'saycode_project',
    runtime: 'saycode_runtime',
    operation: 'saycode_operation',
    configDigest: 'saycode_config_digest',
    backend: 'saycode_isolation_backend',
    providerUid: 'saycode_provider_uid',
    providerGid: 'saycode_provider_gid',
    executorUid: 'saycode_executor_uid',
    executorGid: 'saycode_executor_gid',
    cgroupRoot: 'saycode_cgroup_root',
    verifierKeyId: 'saycode_verifier_key',
    verifierPublicKey: 'saycode_verifier_public_key',
    stateDir: 'saycode_state_dir',
    workspaceDir: 'saycode_workspace_dir',
    volume: 'saycode_volume',
} as const;

function text(metadata: Record<string, string | undefined>, key: string): string | null {
    const value = metadata[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A uid or gid as the parent wrote it: a decimal, unprivileged, whole. */
function id(metadata: Record<string, string | undefined>, key: string): number | null {
    const raw = text(metadata, key);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function composeManagedMarker(input: {
    /**
     * The parsed boot input the parent placed at the known guest path. Reading
     * that path safely is the boot stage's job; what the values may be is here.
     */
    metadata: Record<string, string | undefined>;
    /** What the machine can observe about which instance it is. */
    instance: { providerMachineId: string | null; providerInstanceId: string | null };
    /** The address the bootstrap grant issued. Only the server can mint it. */
    happyMachineId: string | null;
}): ManagedMarkerOutcome {
    const { metadata } = input;
    // No managed metadata at all is an ordinary machine, not a broken one.
    if (Object.keys(KEYS).every((name) => text(metadata, KEYS[name as keyof typeof KEYS]) === null)) {
        return { ok: false, reason: 'not-managed' };
    }

    const strings = {
        workspaceId: text(metadata, KEYS.workspace),
        projectId: text(metadata, KEYS.project),
        runtimeId: text(metadata, KEYS.runtime),
        provisioningOperationId: text(metadata, KEYS.operation),
        configDigest: text(metadata, KEYS.configDigest),
        backend: text(metadata, KEYS.backend),
        cgroupRoot: text(metadata, KEYS.cgroupRoot),
        keyId: text(metadata, KEYS.verifierKeyId),
        verifierPublicKey: text(metadata, KEYS.verifierPublicKey),
        stateDir: text(metadata, KEYS.stateDir),
        workspaceDir: text(metadata, KEYS.workspaceDir),
        providerVolumeId: text(metadata, KEYS.volume),
    };
    const numbers = {
        providerUid: id(metadata, KEYS.providerUid),
        providerGid: id(metadata, KEYS.providerGid),
        executorUid: id(metadata, KEYS.executorUid),
        executorGid: id(metadata, KEYS.executorGid),
    };
    if (Object.values(strings).some((value) => value === null)
        || Object.values(numbers).some((value) => value === null)) {
        return { ok: false, reason: 'metadata-incomplete' };
    }
    // The same rule the marker reader applies, applied before the file exists:
    // one uid for both roles lets the executor read the provider's environment
    // and descriptors, and a marker written that way would never activate.
    if (numbers.providerUid === numbers.executorUid) {
        return { ok: false, reason: 'uid-not-separated' };
    }

    const providerMachineId = input.instance.providerMachineId?.trim() ?? '';
    const providerInstanceId = input.instance.providerInstanceId?.trim() ?? '';
    if (providerMachineId === '' || providerInstanceId === '') {
        return { ok: false, reason: 'instance-unidentified' };
    }
    const happyMachineId = input.happyMachineId?.trim() ?? '';
    if (happyMachineId === '') return { ok: false, reason: 'happy-address-missing' };

    return {
        ok: true,
        record: {
            runtimeId: strings.runtimeId!,
            workspaceId: strings.workspaceId!,
            projectId: strings.projectId!,
            keyId: strings.keyId!,
            happyMachineId,
            provisioningOperationId: strings.provisioningOperationId!,
            configDigest: strings.configDigest!,
            providerMachineId,
            providerInstanceId,
            providerVolumeId: strings.providerVolumeId!,
            stateDir: strings.stateDir!,
            workspaceDir: strings.workspaceDir!,
            verifierPublicKey: strings.verifierPublicKey!,
            isolation: {
                backend: strings.backend!,
                provider: { uid: numbers.providerUid!, gid: numbers.providerGid! },
                executor: { uid: numbers.executorUid!, gid: numbers.executorGid! },
                cgroupRoot: strings.cgroupRoot!,
            },
        },
    };
}
