/**
 * Verification of server-signed managed dispatch tokens.
 *
 * The runtime holds only a public verifier key, so a token cannot be minted
 * inside the runtime even by code that reads every byte of the daemon's memory.
 * That is the whole reason this is asymmetric: an HMAC secret placed here would
 * be inherited by every agent child (see `resolveInheritedSpawnEnvironment`,
 * which passes the daemon's entire `process.env` through on the default path)
 * and would hand arbitrary project code the authority to dispatch runs.
 *
 * This module verifies a signature and a set of bounded claims. It is not an
 * attestation of runtime identity — anyone holding the public key can verify
 * the same token. Runtime identity comes from provisioning (see
 * `managedRuntimeIdentity.ts`) and from the transport the token arrived on.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** Ed25519 signatures are always 64 bytes; anything else is malformed input. */
const ED25519_SIGNATURE_BYTES = 64;
const MAX_TOKEN_BYTES = 4096;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_TOKEN_TTL_MS = 120_000;
const MAX_LEASE_MS = 300_000;
const MAX_ID_LENGTH = 200;

export const MANAGED_PROTOCOL_VERSION = 1;

export const MANAGED_OPS = [
    'spawn', 'stop', 'query', 'lease', 'status', 'runtime-lease', 'checkpoint',
] as const;
export type ManagedOp = (typeof MANAGED_OPS)[number];

/**
 * Operations that act on a run, and therefore name one.
 *
 * `status` is deliberately outside this set: the parent asks whether a runtime
 * is ready *before* it creates an attempt, so a claim that required a run and
 * an attempt could only be satisfied by inventing them.
 */
const RUN_SCOPED_OPS: readonly ManagedOp[] = ['spawn', 'stop', 'query', 'lease'];

/** Operations bound to a provisioning operation rather than to a run. */
const PROVISIONING_SCOPED_OPS: readonly ManagedOp[] = ['status', 'runtime-lease', 'checkpoint'];

type ManagedTokenCommon = {
    v: number;
    kid: string;
    aud: string;
    workspaceId: string;
    projectId: string;
    requestKey: string;
    epoch: number;
    payloadDigest: string;
    iat: number;
    exp: number;
};

/** A token that acts on a run: it names the run and the attempt it belongs to. */
export type ManagedRunTokenClaims = ManagedTokenCommon & {
    op: 'spawn' | 'stop' | 'query' | 'lease';
    runId: string;
    attemptId: string;
    /** lease tokens only — monotonically increasing renewal counter. */
    renewalSeq?: number;
    leaseMs?: number;
    absoluteExpiry?: number;
};

/**
 * A token that reads a runtime's status, and nothing else.
 *
 * It names the provisioning operation it belongs to instead of a run, because
 * at the moment it is used there is no run to name. It carries no lease fields
 * either: reading a status must never be able to hold a write deadline open.
 */
export type ManagedStatusTokenClaims = ManagedTokenCommon & {
    op: 'status';
    provisioningOperationId: string;
};

/**
 * A lease granted to a runtime that has no run yet.
 *
 * The parent needs a runtime fenced before it will dispatch anything, and that
 * happens before an attempt exists. This is a write — it carries the fields
 * the fence path needs — and it is bound to the provisioning operation instead
 * of to a run it could only have invented.
 */
export type ManagedRuntimeLeaseTokenClaims = ManagedTokenCommon & {
    op: 'runtime-lease';
    provisioningOperationId: string;
    renewalSeq: number;
    leaseMs: number;
    absoluteExpiry: number;
};

/**
 * Permission to snapshot this runtime's volume, for one named checkpoint.
 *
 * Bound to the provisioning operation rather than a run: a checkpoint is about
 * the volume, and the volume outlives every run on it. It names the checkpoint
 * it authorises, so a token cannot be replayed to write a different one, and it
 * carries a digest of the request body — the presigned URLs and the one-time
 * key travel in the parameters, and without binding them the same signature
 * would authorise uploading this volume anywhere the caller liked.
 */
export type ManagedCheckpointTokenClaims = ManagedTokenCommon & {
    op: 'checkpoint';
    provisioningOperationId: string;
    checkpointId: string;
    /** Digest of the request parameters this token was signed for. */
    paramsDigest: string;
};

export type ManagedTokenClaims =
    | ManagedRunTokenClaims
    | ManagedStatusTokenClaims
    | ManagedRuntimeLeaseTokenClaims
    | ManagedCheckpointTokenClaims;

export type ManagedTokenFailure =
    | 'malformed'
    | 'bad-signature'
    | 'wrong-audience'
    | 'wrong-workspace'
    | 'wrong-op'
    | 'wrong-operation'
    | 'expired'
    | 'clock-skew'
    | 'ttl-too-long'
    | 'stale-epoch'
    | 'epoch-mismatch'
    | 'payload-mismatch';

export type ManagedTokenResult =
    | { ok: true; claims: ManagedTokenClaims }
    | { ok: false; reason: ManagedTokenFailure };

/**
 * A misconfigured verifier key is an operator error, not an attacker: it must
 * surface as a thrown startup failure rather than blend into `bad-signature`,
 * where it would read as "someone tried to forge a token".
 */
export function parseManagedVerifierKey(der: Buffer): KeyObject {
    let key: KeyObject;
    try {
        key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (error) {
        throw new Error(`managed verifier key is not a DER SPKI public key: ${(error as Error).message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`managed verifier key must be ed25519, got ${key.asymmetricKeyType}`);
    }
    return key;
}

/**
 * Stable digest of the dispatch parameters.
 *
 * Keys are sorted because the token travels through the happy-server relay and
 * a JSON round-trip there must not change the digest — otherwise a legitimate
 * dispatch fails as `payload-mismatch` for a reason no log would explain.
 */
export function canonicalManagedPayloadDigest(value: unknown): string {
    return createHash('sha256').update(canonicalize(value)).digest('base64url');
}

function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

/**
 * `typeof NaN === 'number'` and every comparison against NaN is false, so a
 * plain `if (exp <= now) reject` lets `exp: NaN` through as a valid token. The
 * same holds for a missing field, which arrives as `undefined`. Both are
 * rejected here rather than at each use site.
 */
function readInt(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value >= min && value <= max ? value : null;
}

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
    return trimmed;
}

function readOp(raw: unknown): ManagedOp | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const op = (raw as Record<string, unknown>).op;
    return typeof op === 'string' && MANAGED_OPS.includes(op as ManagedOp) ? (op as ManagedOp) : null;
}

function parseClaims(raw: unknown): ManagedTokenClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;

    if (readInt(record.v, MANAGED_PROTOCOL_VERSION, MANAGED_PROTOCOL_VERSION) === null) return null;
    if (typeof record.op !== 'string' || !MANAGED_OPS.includes(record.op as ManagedOp)) return null;
    const op = record.op as ManagedOp;

    const common = {
        kid: readId(record.kid),
        aud: readId(record.aud),
        workspaceId: readId(record.workspaceId),
        projectId: readId(record.projectId),
        requestKey: readId(record.requestKey),
        payloadDigest: readId(record.payloadDigest),
    };
    for (const value of Object.values(common)) {
        if (value === null) return null;
    }

    const epoch = readInt(record.epoch, 0, Number.MAX_SAFE_INTEGER);
    const iat = readInt(record.iat, 0, Number.MAX_SAFE_INTEGER);
    const exp = readInt(record.exp, 0, Number.MAX_SAFE_INTEGER);
    if (epoch === null || iat === null || exp === null) return null;

    const base: ManagedTokenCommon = {
        v: MANAGED_PROTOCOL_VERSION,
        kid: common.kid!,
        aud: common.aud!,
        workspaceId: common.workspaceId!,
        projectId: common.projectId!,
        requestKey: common.requestKey!,
        payloadDigest: common.payloadDigest!,
        epoch,
        iat,
        exp,
    };

    if (PROVISIONING_SCOPED_OPS.includes(op)) {
        const provisioningOperationId = readId(record.provisioningOperationId);
        if (provisioningOperationId === null) return null;
        // Neither shape may name a run: one is a reading, and the other is a
        // grant made before any run exists.
        for (const forbidden of ['runId', 'attemptId']) {
            if (record[forbidden] !== undefined) return null;
        }
        if (op === 'checkpoint') {
            // A checkpoint names what it writes and what it was signed for.
            // Without the digest the parameters are unauthenticated, and the
            // parameters are where the upload destinations live.
            const checkpointId = readId(record.checkpointId);
            const paramsDigest = readId(record.paramsDigest);
            if (checkpointId === null || paramsDigest === null) return null;
            // A checkpoint is not a lease: it may not hold a write deadline.
            for (const forbidden of ['renewalSeq', 'leaseMs', 'absoluteExpiry']) {
                if (record[forbidden] !== undefined) return null;
            }
            return { ...base, op, provisioningOperationId, checkpointId, paramsDigest };
        }
        if (op === 'runtime-lease') {
            // The same fields the run-scoped lease needs, for the same reasons:
            // without a sequence the grant replays forever, and without an
            // absolute expiry the server cannot bound one it already regrets.
            const renewalSeq = readInt(record.renewalSeq, 0, Number.MAX_SAFE_INTEGER);
            const leaseMs = readInt(record.leaseMs, 1, MAX_LEASE_MS);
            const absoluteExpiry = readInt(record.absoluteExpiry, 0, Number.MAX_SAFE_INTEGER);
            if (renewalSeq === null || leaseMs === null || absoluteExpiry === null) return null;
            return { ...base, op, provisioningOperationId, renewalSeq, leaseMs, absoluteExpiry };
        }
        // Refused for being *present*, not for being wrong. A status token that
        // can name a run is a status token that can be replayed as one, and a
        // status token carrying lease fields is a read that can hold a write
        // deadline open.
        // A reading must never be able to hold a write deadline open.
        for (const forbidden of ['renewalSeq', 'leaseMs', 'absoluteExpiry']) {
            if (record[forbidden] !== undefined) return null;
        }
        return { ...base, op: 'status', provisioningOperationId };
    }

    const runId = readId(record.runId);
    const attemptId = readId(record.attemptId);
    if (runId === null || attemptId === null) return null;
    // The same separation from the other side: a work token has no business
    // naming a provisioning operation, and one that does is a token built from
    // the wrong shape.
    if (record.provisioningOperationId !== undefined) return null;

    const claims: ManagedRunTokenClaims = {
        ...base,
        op: op as ManagedRunTokenClaims['op'],
        runId,
        attemptId,
    };

    if (claims.op === 'lease') {
        // A lease without a sequence could be replayed forever to hold the
        // runtime's write deadline open; without an absolute expiry the server
        // could not bound a lease it already regrets issuing.
        const renewalSeq = readInt(record.renewalSeq, 0, Number.MAX_SAFE_INTEGER);
        const leaseMs = readInt(record.leaseMs, 1, MAX_LEASE_MS);
        const absoluteExpiry = readInt(record.absoluteExpiry, 0, Number.MAX_SAFE_INTEGER);
        if (renewalSeq === null || leaseMs === null || absoluteExpiry === null) return null;
        claims.renewalSeq = renewalSeq;
        claims.leaseMs = leaseMs;
        claims.absoluteExpiry = absoluteExpiry;
    }

    return claims;
}

export function verifyManagedDispatchToken(input: {
    token: string;
    verifier: KeyObject;
    runtimeId: string;
    workspaceId: string;
    op: ManagedOp;
    paramsDigest: string;
    currentEpoch: number;
    /**
     * The provisioning operation this runtime was created by, from its
     * protected marker. Required for `status`, which has no epoch gate: the
     * operation is then the only thing tying the token to this runtime's
     * generation.
     */
    provisioningOperationId?: string;
    now: number;
}): ManagedTokenResult {
    if (typeof input.token !== 'string' || input.token.length > MAX_TOKEN_BYTES) {
        return { ok: false, reason: 'malformed' };
    }
    const separator = input.token.indexOf('.');
    if (separator <= 0 || separator === input.token.length - 1) {
        return { ok: false, reason: 'malformed' };
    }
    const body = input.token.slice(0, separator);
    const signature = Buffer.from(input.token.slice(separator + 1), 'base64url');
    if (signature.length !== ED25519_SIGNATURE_BYTES) {
        return { ok: false, reason: 'bad-signature' };
    }

    // Ed25519 takes the message directly: the algorithm argument must be null.
    // Passing 'sha512' throws ERR_OSSL_INVALID_DIGEST even for a valid pair.
    let signatureValid: boolean;
    try {
        signatureValid = cryptoVerify(null, Buffer.from(body, 'utf8'), input.verifier, signature);
    } catch {
        return { ok: false, reason: 'bad-signature' };
    }
    if (!signatureValid) return { ok: false, reason: 'bad-signature' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    // The op is read before the full parse so a token minted for another
    // operation reports `wrong-op` instead of `malformed` — the op-specific
    // required fields differ, and "malformed" would hide a replay attempt.
    const declaredOp = readOp(parsed);
    if (declaredOp !== null && declaredOp !== input.op) return { ok: false, reason: 'wrong-op' };

    const claims = parseClaims(parsed);
    if (!claims) return { ok: false, reason: 'malformed' };

    if (claims.aud !== input.runtimeId) return { ok: false, reason: 'wrong-audience' };
    if (claims.op !== input.op) return { ok: false, reason: 'wrong-op' };
    if (claims.workspaceId !== input.workspaceId) return { ok: false, reason: 'wrong-workspace' };
    if (claims.iat - input.now > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'clock-skew' };
    if (claims.exp <= input.now) return { ok: false, reason: 'expired' };
    if (claims.exp < claims.iat || claims.exp - claims.iat > MAX_TOKEN_TTL_MS) {
        return { ok: false, reason: 'ttl-too-long' };
    }
    // Epoch rules differ by operation, and collapsing them is a fencing hole.
    //
    // Work operations (spawn/stop/query) must match the epoch this runtime
    // currently holds *exactly*. Accepting a higher epoch here would let a
    // freshly signed token start work in a new generation while the previous
    // generation's children are still running and still writing — the server
    // would have "raised the epoch" without any old writer having been fenced.
    //
    // Only a lease renewal may carry a higher epoch, because that is the one
    // path that performs the fence (and refuses to persist the new epoch unless
    // every prior-generation process is provably gone).
    //
    // Reading a status is outside both rules. A newly booted runtime holds
    // epoch 0 until its first grant, and the parent asks for its status
    // precisely to find that out — an epoch gate would make the question
    // unanswerable exactly when it matters, since the parent would have to
    // know the answer in order to ask. The token is bound to the provisioning
    // operation instead, and nothing is mutated by asking, so an epoch that
    // does not match is a fact for the runtime to report rather than grounds
    // to refuse the question.
    if (claims.op === 'status' || claims.op === 'runtime-lease') {
        // Fail closed: a runtime that knows of no operation cannot confirm
        // that a token belongs to the life it is currently living, and a token
        // minted for a different provisioning operation names resources this
        // runtime may already have replaced.
        if (input.provisioningOperationId === undefined
            || claims.provisioningOperationId !== input.provisioningOperationId) {
            return { ok: false, reason: 'wrong-operation' };
        }
    }
    if (input.op !== 'status') {
        if (claims.epoch < input.currentEpoch) return { ok: false, reason: 'stale-epoch' };
        // Both lease shapes may carry a higher epoch, because both are the path
        // that performs the fence before persisting it.
        if (input.op !== 'lease' && input.op !== 'runtime-lease'
            && claims.epoch !== input.currentEpoch) {
            return { ok: false, reason: 'epoch-mismatch' };
        }
    }
    if (claims.payloadDigest !== input.paramsDigest) return { ok: false, reason: 'payload-mismatch' };

    return { ok: true, claims };
}
