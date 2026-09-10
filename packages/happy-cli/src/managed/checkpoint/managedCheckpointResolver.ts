/**
 * The production `ManagedCheckpointSource`: finds the current checkpoint and
 * brings it onto the volume, bound to what the parent said it should be.
 *
 * ## Why the binding has to be here
 *
 * `restoreManagedCheckpoint` accepts a checkpoint without naming the volume it
 * was taken on, because the ordinary recovery case is a replacement machine
 * with a brand-new volume. That is only safe if something else pins the
 * checkpoint's identity, and this is that something:
 *
 *  - the **tenant and project** come from the machine's protected boot input,
 *    never from the manifest that is being checked;
 *  - the **pointer URL** is signed by the parent for this project's prefix, so
 *    it cannot address another project's checkpoints;
 *  - the pointer names a **checkpoint id and manifest digest**, and the
 *    manifest that arrives has to hash to that digest and agree about which
 *    checkpoint it is.
 *
 * A manifest that fails any of those is refused before a single object is
 * downloaded. Without this, "no source volume constraint" would mean "any
 * checkpoint that decrypts", which is not a constraint at all.
 *
 * `null` means there is nothing to restore — a new project — and is not an
 * error. Turning it into one would fail the boot of every new project;
 * turning an error into it would clear a volume that has real work on it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openCheckpointFile } from './managedCheckpointCrypto';
import {
    checkpointManifestDigest,
    parseManagedCheckpointManifest,
    type ManagedCheckpointManifest,
} from './managedCheckpointManifest';
import { getCheckpointObject, readCheckpointPointer, type CheckpointFetch } from './managedCheckpointObjectStore';
import { MANAGED_CHECKPOINT_POINTER_VERSION } from './managedCheckpointPublisher';
import type { ManagedCheckpointSource } from './managedCheckpointRestore';
import type { CheckpointArea } from './managedCheckpointScope';

export class ManagedCheckpointResolveError extends Error {
    constructor(readonly code:
        | 'pointer-unreadable'
        | 'manifest-unreadable'
        | 'authority-mismatch'
        | 'object-missing') {
        super(`managed checkpoint resolve refused: ${code}`);
        this.name = 'ManagedCheckpointResolveError';
    }
}

/** Everything the parent vouches for, and nothing the checkpoint claims. */
export type ManagedCheckpointAuthority = {
    tenant: { companyId: string; projectId: string };
    /** Signed GET URLs, scoped by the parent to this project. */
    pointerUrl: string;
    manifestUrl: string;
    objectUrls: Map<CheckpointArea, string>;
    /** Live for this restore only; never written to the volume. */
    key: Buffer;
};

function parsePointer(body: string): { checkpointId: string; manifestDigest: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new ManagedCheckpointResolveError('pointer-unreadable');
    }
    const pointer = parsed as Partial<{ schemaVersion: number; checkpointId: string; manifestDigest: string }>;
    if (pointer.schemaVersion !== MANAGED_CHECKPOINT_POINTER_VERSION
        || typeof pointer.checkpointId !== 'string'
        || !/^[a-f0-9]{64}$/.test(pointer.checkpointId)
        || typeof pointer.manifestDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(pointer.manifestDigest)) {
        throw new ManagedCheckpointResolveError('pointer-unreadable');
    }
    return { checkpointId: pointer.checkpointId, manifestDigest: pointer.manifestDigest };
}

export function createManagedCheckpointSource(input: {
    authority: ManagedCheckpointAuthority;
    /** On the volume: the objects are project-sized. */
    downloadDir: string;
    fetchImpl?: CheckpointFetch;
}): ManagedCheckpointSource {
    return {
        async resolveLatest() {
            let pointerObject: { body: string } | null;
            try {
                pointerObject = await readCheckpointPointer({
                    url: input.authority.pointerUrl,
                    fetchImpl: input.fetchImpl,
                });
            } catch {
                throw new ManagedCheckpointResolveError('pointer-unreadable');
            }
            // No pointer: this project has never been checkpointed.
            if (!pointerObject) return null;
            const pointer = parsePointer(pointerObject.body);

            const sealedManifest = join(input.downloadDir, 'manifest.json.enc');
            const plainManifest = join(input.downloadDir, 'manifest.json');
            try {
                await getCheckpointObject({
                    url: input.authority.manifestUrl,
                    destination: sealedManifest,
                    fetchImpl: input.fetchImpl,
                });
            } catch {
                throw new ManagedCheckpointResolveError('object-missing');
            }
            let manifest: ManagedCheckpointManifest;
            try {
                await openCheckpointFile({
                    source: sealedManifest,
                    destination: plainManifest,
                    key: input.authority.key,
                    binding: {
                        companyId: input.authority.tenant.companyId,
                        projectId: input.authority.tenant.projectId,
                        checkpointId: pointer.checkpointId,
                        area: 'manifest',
                    },
                });
                manifest = parseManagedCheckpointManifest(await readFile(plainManifest, 'utf8'));
            } catch {
                throw new ManagedCheckpointResolveError('manifest-unreadable');
            }

            // The three bindings, checked before anything large is fetched.
            if (manifest.checkpointId !== pointer.checkpointId
                || checkpointManifestDigest(manifest) !== pointer.manifestDigest
                || manifest.tenant.companyId !== input.authority.tenant.companyId
                || manifest.tenant.projectId !== input.authority.tenant.projectId) {
                throw new ManagedCheckpointResolveError('authority-mismatch');
            }

            const objects = new Map<CheckpointArea, string>();
            for (const area of manifest.areas) {
                const url = input.authority.objectUrls.get(area.area);
                if (!url) throw new ManagedCheckpointResolveError('object-missing');
                const destination = join(input.downloadDir, `${area.area}.tar.gz.enc`);
                try {
                    await getCheckpointObject({ url, destination, fetchImpl: input.fetchImpl });
                } catch {
                    throw new ManagedCheckpointResolveError('object-missing');
                }
                objects.set(area.area, destination);
            }

            return { manifest, objects, key: input.authority.key };
        },
    };
}
