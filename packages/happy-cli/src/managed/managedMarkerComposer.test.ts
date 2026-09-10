/**
 * Which terms of its own identity a machine may supply for itself.
 *
 * Every refusal here is a marker that would otherwise have been written with a
 * value nobody authorised — and the marker is what every later readiness
 * answer, receipt and fencing decision is made in the terms of.
 */
import { describe, expect, it } from 'vitest';

import { composeManagedMarker } from '@/managed/managedMarkerComposer';

const INPUT = {
    saycode_workspace: 'ws-1',
    saycode_project: 'proj-1',
    saycode_runtime: 'rt-1',
    saycode_operation: 'op-1',
    saycode_config_digest: 'digest-1',
    saycode_isolation_backend: 'privileged-launch-supervisor',
    saycode_provider_uid: '10601',
    saycode_provider_gid: '10601',
    saycode_executor_uid: '10602',
    saycode_executor_gid: '10600',
    saycode_cgroup_root: '/sys/fs/cgroup/saycode',
    saycode_verifier_key: 'kid-1',
    saycode_verifier_public_key: 'cHVibGljLWtleQ==',
    saycode_state_dir: '/var/lib/saycode/state',
    saycode_workspace_dir: '/workspace',
    saycode_volume: 'vol_1',
};

const INSTANCE = { providerMachineId: 'fly_m1', providerInstanceId: 'inst_1' };

function compose(over: {
    metadata?: Record<string, string | undefined>;
    instance?: { providerMachineId: string | null; providerInstanceId: string | null };
    happyMachineId?: string | null;
} = {}) {
    return composeManagedMarker({
        metadata: over.metadata ?? INPUT,
        instance: over.instance ?? INSTANCE,
        happyMachineId: over.happyMachineId === undefined ? 'machine-1' : over.happyMachineId,
    });
}

describe('composing the marker from the parent boot input', () => {
    it('takes each axis from whoever is entitled to answer it', () => {
        const outcome = compose();
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.record).toEqual({
            runtimeId: 'rt-1',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            keyId: 'kid-1',
            // Only the server can mint this, so it comes from the grant.
            happyMachineId: 'machine-1',
            provisioningOperationId: 'op-1',
            configDigest: 'digest-1',
            // Only this machine knows which instance is running.
            providerMachineId: 'fly_m1',
            providerInstanceId: 'inst_1',
            providerVolumeId: 'vol_1',
            stateDir: '/var/lib/saycode/state',
            workspaceDir: '/workspace',
            verifierPublicKey: 'cHVibGljLWtleQ==',
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: 10601, gid: 10601 },
                executor: { uid: 10602, gid: 10600 },
                cgroupRoot: '/sys/fs/cgroup/saycode',
            },
        });
    });

    it('separates an ordinary machine from a managed one missing an axis', () => {
        // Nothing at all is BYOS. Something-but-not-everything is a managed
        // machine that must not boot, and filling the gap in is how a receipt
        // store ends up somewhere the agent can write.
        expect(compose({ metadata: {} })).toEqual({ ok: false, reason: 'not-managed' });
        expect(compose({ metadata: { saycode_workspace: 'ws-1' } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it.each(Object.keys(INPUT))('refuses when %s is missing', (key) => {
        expect(compose({ metadata: { ...INPUT, [key]: undefined } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it.each([
        ['a uid that is not a number', { saycode_executor_uid: 'root' }],
        ['a uid that is root', { saycode_executor_uid: '0' }],
        ['a negative uid', { saycode_executor_uid: '-5' }],
        ['a uid with a decimal point', { saycode_executor_uid: '10602.5' }],
    ])('refuses %s', (_name, over) => {
        expect(compose({ metadata: { ...INPUT, ...over } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it('refuses one uid wearing both roles', () => {
        // The same rule the marker reader applies, applied before the file
        // exists — otherwise the boot writes a marker that can never activate.
        expect(compose({ metadata: { ...INPUT, saycode_executor_uid: '10601' } }))
            .toEqual({ ok: false, reason: 'uid-not-separated' });
    });

    it('refuses when the machine cannot say which instance it is', () => {
        expect(compose({ instance: { providerMachineId: null, providerInstanceId: 'inst_1' } }))
            .toEqual({ ok: false, reason: 'instance-unidentified' });
        expect(compose({ instance: { providerMachineId: 'fly_m1', providerInstanceId: '  ' } }))
            .toEqual({ ok: false, reason: 'instance-unidentified' });
    });

    it('refuses without the address the server issued', () => {
        // A runtime that named its own Happy machine id would publish readiness
        // for a machine nobody is listening on — or for somebody else's.
        expect(compose({ happyMachineId: null }))
            .toEqual({ ok: false, reason: 'happy-address-missing' });
    });

    it('does not read an axis out of a neighbouring one', () => {
        // Every value is taken by its own key. A composer that fell back to
        // another field would silently bind this runtime to another's scope.
        const outcome = compose({
            metadata: { ...INPUT, saycode_project: 'a-different-project' },
        });
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.record.projectId).toBe('a-different-project');
    });
});
