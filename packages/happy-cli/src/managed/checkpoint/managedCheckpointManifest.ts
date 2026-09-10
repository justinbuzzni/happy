/**
 * The manifest a managed checkpoint is verified against.
 *
 * A checkpoint is two things that must not drift apart: the encrypted archives
 * and the statement of what they contain. This file is the statement. It is
 * bound to the tenant, the project, the volume and the image version, because
 * a restore that only checked "the bytes arrived intact" would happily lay
 * another company's project down on this volume — the checksum would pass.
 *
 * `checkpointManifestDigest` is what `recordManagedRestoreCompletion` stores as
 * `manifestDigest`. It is computed over a canonical form so that two encoders
 * of the same manifest cannot disagree; JSON key order is not part of the
 * statement, and every field that is part of it must change the digest.
 *
 * Nothing about retention or cost lives here. Those numbers are undecided, and
 * a default written into a manifest schema becomes the decision.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { classifyCheckpointEntry } from './managedCheckpointScope';

export const MANAGED_CHECKPOINT_MANIFEST_VERSION = 1;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200);

const entrySchema = z.object({
    area: z.enum(['project', 'provider-state']),
    path: z.string().min(1),
    type: z.enum(['file', 'directory', 'symlink']),
    bytes: z.number().int().min(0),
    mode: z.number().int().min(0),
    sha256: sha256Hex,
    linkTarget: z.string().min(1).optional(),
    /**
     * Content carried in the manifest instead of in the archive, for the small
     * files a checkpoint has to rewrite rather than copy — today only the
     * sanitized `.git/config`. The tar cannot hold a version of a file that
     * differs from the one on disk, and the alternative to rewriting it is
     * shipping the credentials in it.
     */
    inline: z.string().max(64 * 1024).optional(),
}).strict();

const excludedSchema = z.object({
    area: z.enum(['project', 'provider-state']),
    path: z.string().min(1),
    reason: z.enum([
        'regeneratable', 'credential', 'personal-history', 'too-large', 'link-escape',
        'unsupported-type', 'not-allowlisted', 'worktree-out-of-scope',
    ]),
}).strict();

const manifestSchema = z.object({
    schemaVersion: z.literal(MANAGED_CHECKPOINT_MANIFEST_VERSION),
    checkpointId: sha256Hex,
    tenant: z.object({ companyId: identifier, projectId: identifier }).strict(),
    volume: z.object({ volumeId: identifier, deviceUuid: identifier }).strict(),
    image: z.object({ imageVersion: identifier }).strict(),
    createdAtMs: z.number().int().min(0),
    areas: z.array(z.object({
        area: z.enum(['project', 'provider-state']),
        archiveSha256: sha256Hex,
        archiveBytes: z.number().int().min(0),
        entryCount: z.number().int().min(0),
    }).strict()).min(1),
    entries: z.array(entrySchema),
    excluded: z.array(excludedSchema),
    /**
     * Linked worktrees whose working tree lives inside the archived root,
     * recorded as root-relative paths so the pair of absolute pointers can be
     * rebuilt wherever the checkpoint is restored. Registrations pointing
     * outside the root are not listed — they are dropped from the archive.
     */
    worktrees: z.array(z.object({
        name: z.string().min(1),
        path: z.string().min(1),
    }).strict()),
}).strict();

export type ManagedCheckpointManifest = z.infer<typeof manifestSchema>;
export type ManagedCheckpointEntry = z.infer<typeof entrySchema>;

/**
 * Canonical JSON: objects with sorted keys, arrays in their given order.
 * Array order is content, not encoding — reordering entries changes what the
 * manifest says was archived, so it is allowed to change the digest.
 */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${fields.join(',')}}`;
}

export function checkpointManifestDigest(manifest: ManagedCheckpointManifest): string {
    return createHash('sha256').update(canonicalize(manifest)).digest('hex');
}

export function serializeManagedCheckpointManifest(manifest: ManagedCheckpointManifest): string {
    return canonicalize(manifestSchema.parse(manifest));
}

export function parseManagedCheckpointManifest(raw: string): ManagedCheckpointManifest {
    let parsed: unknown;
    try {
        parsed = manifestSchema.parse(JSON.parse(raw));
    } catch {
        // The manifest's own contents never reach the caller: it is attacker-
        // reachable input on the restore side.
        throw new Error('managed checkpoint manifest is not readable');
    }
    const manifest = parsed as ManagedCheckpointManifest;
    // Path safety is the scope module's rule, not a second copy of it here —
    // a manifest that names a path the producer could not have produced is
    // refused before anything is extracted against it.
    for (const entry of manifest.entries) {
        classifyCheckpointEntry({
            area: entry.area,
            path: entry.path,
            type: entry.type,
            bytes: entry.bytes,
            linkTarget: entry.linkTarget,
        });
    }
    return manifest;
}
