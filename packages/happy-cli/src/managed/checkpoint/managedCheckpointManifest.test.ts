import { describe, expect, it } from 'vitest';

import {
    MANAGED_CHECKPOINT_MANIFEST_VERSION,
    checkpointManifestDigest,
    parseManagedCheckpointManifest,
    serializeManagedCheckpointManifest,
    type ManagedCheckpointManifest,
} from './managedCheckpointManifest';

function manifest(overrides: Partial<ManagedCheckpointManifest> = {}): ManagedCheckpointManifest {
    return {
        schemaVersion: MANAGED_CHECKPOINT_MANIFEST_VERSION,
        checkpointId: 'a'.repeat(64),
        tenant: { companyId: 'co_1', projectId: 'pr_1' },
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'managed-runtime@1.2.3' },
        createdAtMs: 1_700_000_000_000,
        areas: [{ area: 'project', archiveSha256: 'b'.repeat(64), archiveBytes: 128, entryCount: 1 }],
        entries: [{ area: 'project', path: 'src/index.ts', type: 'file', bytes: 10, mode: 0o644, sha256: 'c'.repeat(64) }],
        excluded: [{ area: 'project', path: 'node_modules/x', reason: 'regeneratable' }],
        worktrees: [{ name: 'feature', path: '.worktrees/feature' }],
        ...overrides,
    };
}

describe('managed checkpoint manifest', () => {
    it('shouldRoundTripThroughSerializationUnchanged', () => {
        const value = manifest();
        expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(value))).toEqual(value);
    });

    it('shouldRejectAForeignSchemaVersion', () => {
        expect(() => parseManagedCheckpointManifest(JSON.stringify(manifest({ schemaVersion: 2 as never }))))
            .toThrow('managed checkpoint manifest is not readable');
    });

    it('shouldRejectUnknownFieldsRatherThanIgnoringThem', () => {
        const raw = JSON.parse(serializeManagedCheckpointManifest(manifest()));
        raw.retentionDays = 30;
        expect(() => parseManagedCheckpointManifest(JSON.stringify(raw)))
            .toThrow('managed checkpoint manifest is not readable');
    });

    it('shouldRejectAnEntryPathThatEscapesItsArea', () => {
        expect(() => parseManagedCheckpointManifest(serializeManagedCheckpointManifest(manifest({
            entries: [{ area: 'project', path: '../outside', type: 'file', bytes: 1, mode: 0o644, sha256: 'c'.repeat(64) }],
        })))).toThrow('unsafe checkpoint path');
    });

    it('shouldProduceTheSameDigestRegardlessOfKeyOrder', () => {
        const value = manifest();
        const reordered = JSON.parse(JSON.stringify({
            excluded: value.excluded,
            entries: value.entries,
            areas: value.areas,
            createdAtMs: value.createdAtMs,
            image: value.image,
            volume: value.volume,
            worktrees: value.worktrees,
            tenant: { projectId: 'pr_1', companyId: 'co_1' },
            checkpointId: value.checkpointId,
            schemaVersion: value.schemaVersion,
        })) as ManagedCheckpointManifest;
        expect(checkpointManifestDigest(reordered)).toBe(checkpointManifestDigest(value));
    });

    it('shouldChangeTheDigestWhenAnyBoundFieldChanges', () => {
        const base = checkpointManifestDigest(manifest());
        const mutated = [
            manifest({ tenant: { companyId: 'co_2', projectId: 'pr_1' } }),
            manifest({ tenant: { companyId: 'co_1', projectId: 'pr_2' } }),
            manifest({ volume: { volumeId: 'vol_2', deviceUuid: 'dev-1' } }),
            manifest({ image: { imageVersion: 'managed-runtime@1.2.4' } }),
            manifest({ areas: [{ area: 'project', archiveSha256: 'd'.repeat(64), archiveBytes: 128, entryCount: 1 }] }),
            manifest({ entries: [{ area: 'project', path: 'src/index.ts', type: 'file', bytes: 11, mode: 0o644, sha256: 'c'.repeat(64) }] }),
        ].map(checkpointManifestDigest);
        expect(new Set([base, ...mutated]).size).toBe(mutated.length + 1);
    });
});
