/**
 * Proof that a control-plane request came from the control plane.
 *
 * An account bearer alone is not enough for these routes. The bearer says which
 * account is being acted for; it does not say that the *control plane* asked.
 * Anything holding a stolen account token could otherwise mint session grants
 * for that account, which is the whole authority this server is being asked to
 * delegate. So every control call carries a second, independent proof: an
 * Ed25519 assertion signed by a key this server only ever verifies.
 *
 * The assertion binds the full request, not just the caller:
 *  - `aud` — this server, so an assertion minted for one deployment cannot be
 *    replayed against another;
 *  - `op` — the exact operation, so a revoke assertion cannot authorise a mint;
 *  - `bodyDigest` — the canonical digest of the whole body, so no field can be
 *    altered in flight;
 *  - `iat`/`exp` — a window of at most two minutes, so a captured assertion
 *    stops being useful.
 *
 * Verification keys come from the environment and there is no default. With
 * nothing configured the verifier does not exist and every control route
 * refuses: an unconfigured deployment must be unable to mint, not open.
 */

import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { canonicalDigest } from '@/app/managed/canonicalDigest';

/** Fixed, so an assertion for some other protocol cannot be replayed here. */
export const CONTROL_ASSERTION_PURPOSE = 'happy-managed-control';

/** The longest an assertion may be valid for. */
export const MAX_ASSERTION_LIFETIME_MS = 120_000;

/** Tolerance for clock skew between the control plane and this server. */
const CLOCK_SKEW_MS = 5_000;

export type ControlOperation =
    | 'authority-sync'
    /**
     * Reads both projections. Separate from the write op so an assertion signed
     * to look cannot be replayed to change anything.
     */
    | 'authority-snapshot'
    /**
     * Registers the managed Machine a runtime will run as and issues that
     * runtime's own daemon credential. Its own operation: an assertion signed
     * to mint a session grant must not also be able to create a machine.
     */
    | 'daemon-bootstrap'
    /**
     * Extends the life of a daemon grant that already exists, in place.
     *
     * Separate from `grant-renew`, which is the session grant's. They name
     * different authorities: a session credential lets a child act inside one
     * conversation, while this one is the identity a whole runtime runs as. An
     * assertion signed to keep a session alive must not also be able to keep a
     * machine's identity alive, and the signature is what keeps the two apart.
     */
    | 'daemon-renew'
    /**
     * Reads a daemon grant and issues a token for it. Writes nothing, but it
     * hands out a credential, so — like `grant-resolve` — it is its own
     * operation rather than a read variant of the renewal.
     */
    | 'daemon-resolve'
    | 'grant-mint'
    | 'grant-renew'
    /**
     * Reads the current grant and issues a token for it. It writes nothing, but
     * it hands out a credential, so it is its own operation rather than a
     * variant of the read above.
     */
    | 'grant-resolve'
    | 'grant-revoke'
    /**
     * Issues a grant for **reading** a transcript, and withdraws one.
     *
     * Their own operations rather than variants of the run-scoped pair: a read
     * grant names no run, is scoped to a viewer, and is withdrawn when a
     * project's access list changes rather than when a run ends. An assertion
     * signed for minting a runner's credential must not also mint a reader's.
     */
    | 'read-grant-mint'
    | 'read-grant-revoke'
    /**
     * Reads a token back for a read grant that already exists.
     *
     * Its own operation because it is not a mint and must not be reachable by
     * an assertion signed for one: it creates nothing and changes nothing, and
     * an assertion signed to *recover* a token should not also be able to issue
     * a new grant.
     */
    | 'read-grant-resolve'
    /**
     * Issues a grant for **answering a permission prompt**.
     *
     * Its own operation, and bound to a live run: an approval answers the run
     * that is asking, so unlike reading it carries the run axes and is checked
     * against the current authority. An assertion signed to hand out reading
     * must not also hand out answering.
     */
    | 'approval-grant-mint'
    /**
     * Withdraws one, and like `read-grant-revoke` it does not require the
     * approver's own bearer: the moment withdrawal matters most is the moment
     * that bearer is gone.
     */
    | 'approval-grant-revoke'
    /**
     * Reads a token back for an approval grant that already exists.
     *
     * Its own operation for the same reason reading one back on the transcript
     * side is: recovering a bearer must not be reachable by a signature that
     * was authorised to issue a new grant, nor the reverse.
     */
    | 'approval-grant-resolve';

export const CONTROL_OPERATIONS: readonly ControlOperation[] = [
    'authority-sync', 'authority-snapshot',
    'daemon-bootstrap', 'daemon-renew', 'daemon-resolve',
    'grant-mint', 'grant-renew', 'grant-resolve', 'grant-revoke',
    'read-grant-mint', 'read-grant-revoke', 'read-grant-resolve',
    'approval-grant-mint', 'approval-grant-revoke', 'approval-grant-resolve',
];

export type ControlAssertionFailure =
    | 'not-configured'
    | 'malformed'
    | 'unknown-key'
    | 'bad-signature'
    | 'wrong-audience'
    | 'wrong-purpose'
    | 'wrong-operation'
    | 'body-mismatch'
    | 'expired'
    | 'not-yet-valid'
    | 'lifetime-too-long';

export type ControlAssertionResult =
    | { ok: true; keyId: string; operation: ControlOperation }
    | { ok: false; reason: ControlAssertionFailure };

export type ControlAssertionPayload = {
    kid: string;
    aud: string;
    purpose: string;
    op: string;
    bodyDigest: string;
    iat: number;
    exp: number;
};

export type ControlAssertionVerifier = {
    verify: (input: {
        assertion: string;
        operation: ControlOperation;
        body: unknown;
        now: number;
    }) => ControlAssertionResult;
};

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_ED25519_PUBLIC_KEY_BYTES = 32;

function decodeBase64Url(value: string): Buffer | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
        return Buffer.from(value, 'base64url');
    } catch {
        return null;
    }
}

function readInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function parsePayload(raw: unknown): ControlAssertionPayload | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const kid = readString(record.kid);
    const aud = readString(record.aud);
    const purpose = readString(record.purpose);
    const op = readString(record.op);
    const bodyDigest = readString(record.bodyDigest);
    const iat = readInt(record.iat);
    const exp = readInt(record.exp);
    if (!kid || !aud || !purpose || !op || !bodyDigest || iat === null || exp === null) return null;
    return { kid, aud, purpose, op, bodyDigest, iat, exp };
}

/**
 * Reads the verification keys.
 *
 * The value is a JSON object of key id to base64 Ed25519 public key. Public
 * keys only: this server verifies control assertions and must never be able to
 * produce one, so a deployment leak cannot be turned into the authority to mint.
 */
export function parseControlVerifierKeys(raw: string | undefined): Map<string, Buffer> | null {
    if (!raw || raw.trim().length === 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('HAPPY_MANAGED_CONTROL_VERIFIER_KEYS must be JSON of { keyId: base64PublicKey }');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('HAPPY_MANAGED_CONTROL_VERIFIER_KEYS must be a JSON object');
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') {
            throw new Error(`Control verifier key "${keyId}" must be a base64 string`);
        }
        const bytes = Buffer.from(value, 'base64');
        if (bytes.length !== RAW_ED25519_PUBLIC_KEY_BYTES) {
            throw new Error(`Control verifier key "${keyId}" must be a 32-byte Ed25519 public key`);
        }
        keys.set(keyId, bytes);
    }
    if (keys.size === 0) {
        throw new Error('HAPPY_MANAGED_CONTROL_VERIFIER_KEYS must contain at least one key');
    }
    return keys;
}

/**
 * Builds a verifier, or returns null when the deployment has no control keys.
 *
 * A null verifier is the fail-closed state, not a degraded one: the caller must
 * refuse every control route rather than fall back to the account bearer alone.
 */
export function createControlAssertionVerifier(input: {
    audience: string | undefined;
    verifierKeys: string | undefined;
}): ControlAssertionVerifier | null {
    const keys = parseControlVerifierKeys(input.verifierKeys);
    if (!keys) return null;
    const audience = input.audience?.trim();
    if (!audience) {
        throw new Error('HAPPY_MANAGED_CONTROL_AUDIENCE is required when control verifier keys are set');
    }

    const publicKeys = new Map(
        [...keys].map(([keyId, raw]) => [keyId, createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
            format: 'der',
            type: 'spki',
        })]),
    );

    return {
        verify({ assertion, operation, body, now }) {
            const parts = assertion.split('.');
            if (parts.length !== 2) return { ok: false, reason: 'malformed' };
            const [encodedPayload, encodedSignature] = parts;
            const payloadBytes = decodeBase64Url(encodedPayload);
            const signature = decodeBase64Url(encodedSignature);
            if (!payloadBytes || !signature) return { ok: false, reason: 'malformed' };

            let decoded: unknown;
            try {
                decoded = JSON.parse(payloadBytes.toString('utf8'));
            } catch {
                return { ok: false, reason: 'malformed' };
            }
            const payload = parsePayload(decoded);
            if (!payload) return { ok: false, reason: 'malformed' };

            const publicKey = publicKeys.get(payload.kid);
            if (!publicKey) return { ok: false, reason: 'unknown-key' };

            // The signature is checked before anything the payload claims, so a
            // rejection never depends on unverified fields.
            if (!verifySignature(null, payloadBytes, publicKey, signature)) {
                return { ok: false, reason: 'bad-signature' };
            }

            if (payload.aud !== audience) return { ok: false, reason: 'wrong-audience' };
            if (payload.purpose !== CONTROL_ASSERTION_PURPOSE) return { ok: false, reason: 'wrong-purpose' };
            if (payload.op !== operation) return { ok: false, reason: 'wrong-operation' };
            if (payload.bodyDigest !== canonicalDigest(body)) return { ok: false, reason: 'body-mismatch' };

            if (payload.exp <= payload.iat) return { ok: false, reason: 'malformed' };
            if (payload.exp - payload.iat > MAX_ASSERTION_LIFETIME_MS) {
                return { ok: false, reason: 'lifetime-too-long' };
            }
            if (now + CLOCK_SKEW_MS < payload.iat) return { ok: false, reason: 'not-yet-valid' };
            if (now >= payload.exp) return { ok: false, reason: 'expired' };

            return { ok: true, keyId: payload.kid, operation };
        },
    };
}

/**
 * Encodes an assertion payload for signing.
 *
 * Exported for tests and for a control plane written against this contract.
 * There is no signing function here on purpose — this server holds no private
 * key for this purpose and must not grow one.
 */
export function encodeControlAssertionPayload(payload: ControlAssertionPayload): Buffer {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function encodeControlAssertion(payloadBytes: Buffer, signature: Buffer): string {
    return `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}
