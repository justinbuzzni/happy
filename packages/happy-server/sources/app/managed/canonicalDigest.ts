/**
 * Stable digest of a request body.
 *
 * Object keys are sorted so a body that survives a JSON round-trip — through a
 * relay, a proxy, or a different runtime's serializer — digests identically.
 * Without that, an exact retry would read as a conflicting body and a
 * legitimate replay would be refused.
 */

import { createHash } from 'node:crypto';

function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export function canonicalDigest(value: unknown): string {
    return createHash('sha256').update(canonicalize(value)).digest('base64url');
}
