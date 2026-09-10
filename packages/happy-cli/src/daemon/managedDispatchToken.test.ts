import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
    verifyManagedDispatchToken,
    type ManagedRunTokenClaims,
} from './managedDispatchToken';

const keys = generateKeyPairSync('ed25519');
const publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const verifier = parseManagedVerifierKey(publicKeyDer);

const NOW = 1_800_000_000_000;

function claims(overrides: Partial<ManagedRunTokenClaims> = {}): Record<string, unknown> {
    return {
        v: 1,
        kid: 'test-kid',
        aud: 'runtime-1',
        op: 'spawn',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        requestKey: 'req-1',
        epoch: 3,
        payloadDigest: canonicalManagedPayloadDigest({ b: 2, a: 1 }),
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    };
}

function mint(body: Record<string, unknown>, signWith = keys.privateKey): string {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    // Ed25519 hashes internally; the digest argument must be null (a named
    // digest throws ERR_OSSL_INVALID_DIGEST even for a valid signature).
    const signature = sign(null, Buffer.from(encoded, 'utf8'), signWith);
    return `${encoded}.${signature.toString('base64url')}`;
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyManagedDispatchToken>[0]> = {}) {
    return verifyManagedDispatchToken({
        token,
        verifier,
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        op: 'spawn',
        paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 2 }),
        currentEpoch: 3,
        now: NOW + 1_000,
        ...overrides,
    });
}

describe('verifyManagedDispatchToken', () => {
    it('accepts a token signed with the provisioned key', () => {
        const result = verify(mint(claims()));
        expect(result).toMatchObject({ ok: true });
        if (result.ok && result.claims.op === 'spawn') {
            expect(result.claims.requestKey).toBe('req-1');
            expect(result.claims.runId).toBe('run-1');
        }
    });

    it('rejects a signature produced by a different key', () => {
        const other = generateKeyPairSync('ed25519');
        expect(verify(mint(claims(), other.privateKey)))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a tampered payload that keeps a well-formed signature', () => {
        const token = mint(claims());
        const [body, signature] = token.split('.');
        const forged = Buffer.from(JSON.stringify(claims({ requestKey: 'req-2' })), 'utf8')
            .toString('base64url');
        expect(verify(`${forged}.${signature}`))
            .toEqual({ ok: false, reason: 'bad-signature' });
        expect(body).not.toBe(forged);
    });

    it('rejects a truncated signature without throwing', () => {
        const token = mint(claims());
        const truncated = `${token.split('.')[0]}.${token.split('.')[1]!.slice(0, 40)}`;
        expect(verify(truncated)).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('separates a malformed verifier key from a bad signature', () => {
        expect(() => parseManagedVerifierKey(Buffer.from('not-a-key')))
            .toThrowError(/managed verifier key/);
    });

    it('rejects a token minted for another runtime', () => {
        expect(verify(mint(claims({ aud: 'runtime-2' }))))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('rejects a token minted for another workspace', () => {
        expect(verify(mint(claims({ workspaceId: 'ws-2' }))))
            .toEqual({ ok: false, reason: 'wrong-workspace' });
    });

    it('rejects a lease token replayed as a spawn token', () => {
        expect(verify(mint(claims({ op: 'lease' }))))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('rejects an expired token', () => {
        expect(verify(mint(claims()), { now: NOW + 61_000 }))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects a token issued too far in the future', () => {
        expect(verify(mint(claims({ iat: NOW + 300_000, exp: NOW + 330_000 }))))
            .toEqual({ ok: false, reason: 'clock-skew' });
    });

    it('rejects a token whose lifetime exceeds the cap', () => {
        expect(verify(mint(claims({ exp: NOW + 30 * 60_000 }))))
            .toEqual({ ok: false, reason: 'ttl-too-long' });
    });

    it('rejects an epoch older than the runtime fencing token', () => {
        expect(verify(mint(claims({ epoch: 2 }))))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('refuses a spawn whose epoch is ahead of the runtime', () => {
        // A higher epoch means the server intends a new generation. Letting a
        // spawn ride that intent would start work while the previous
        // generation's children are still writing — the epoch may only be
        // raised by a lease renewal that first fences them.
        expect(verify(mint(claims({ epoch: 4 }))))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    it('refuses a stop or query whose epoch is ahead of the runtime', () => {
        for (const op of ['stop', 'query'] as const) {
            expect(verify(mint(claims({ op, epoch: 4 })), { op }))
                .toEqual({ ok: false, reason: 'epoch-mismatch' });
        }
    });

    it('accepts a lease renewal carrying a higher epoch, which is the fence path', () => {
        const token = mint(claims({
            op: 'lease', epoch: 4, renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toMatchObject({ ok: true });
    });

    it('rejects params that do not match the signed digest', () => {
        expect(verify(mint(claims()), {
            paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 3 }),
        })).toEqual({ ok: false, reason: 'payload-mismatch' });
    });

    describe('strict field parsing', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['NaN exp', { exp: Number.NaN }],
            ['missing exp', { exp: undefined }],
            ['Infinity iat', { iat: Number.POSITIVE_INFINITY }],
            ['fractional epoch', { epoch: 1.5 }],
            ['negative epoch', { epoch: -1 }],
            ['string epoch', { epoch: '3' }],
            ['unsafe integer exp', { exp: Number.MAX_SAFE_INTEGER + 2 }],
            ['empty requestKey', { requestKey: '' }],
            ['non-string requestKey', { requestKey: 7 }],
            ['missing workspaceId', { workspaceId: undefined }],
            ['wrong version', { v: 2 }],
            ['unknown op', { op: 'delete-everything' }],
        ];
        for (const [name, override] of cases) {
            it(`rejects ${name}`, () => {
                expect(verify(mint(claims(override)))).toEqual({ ok: false, reason: 'malformed' });
            });
        }
    });

    it('requires a lease sequence only on lease tokens', () => {
        const leaseToken = mint(claims({ op: 'lease', renewalSeq: 5, leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(leaseToken, { op: 'lease' })).toMatchObject({ ok: true });
        const missingSeq = mint(claims({ op: 'lease', leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(missingSeq, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('rejects a lease token whose leaseMs exceeds the cap', () => {
        const token = mint(claims({
            op: 'lease', renewalSeq: 5, leaseMs: 60 * 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('canonicalManagedPayloadDigest', () => {
    it('is stable across key order so relay reserialization does not break dispatch', () => {
        expect(canonicalManagedPayloadDigest({ a: 1, b: { c: 2, d: 3 } }))
            .toBe(canonicalManagedPayloadDigest({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it('distinguishes different values', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 2 }));
    });

    it('distinguishes an absent key from an explicit undefined-like null', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 1, b: null }));
    });
});

describe('parseManagedVerifierKey', () => {
    it('accepts a DER SPKI ed25519 key', () => {
        expect(parseManagedVerifierKey(publicKeyDer).asymmetricKeyType).toBe('ed25519');
    });

    it('rejects a non-ed25519 key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const der = rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
        expect(() => parseManagedVerifierKey(der)).toThrowError(/ed25519/);
    });
});

/**
 * Reading a runtime's status is not work, and it happens before there is any
 * work to name.
 *
 * The parent asks whether a runtime is ready *before* it creates an attempt
 * (`cloudRunWorker` calls `prepareRuntime` ahead of `beginCloudRunAttempt`),
 * so a claim shape that requires `runId` and `attemptId` can only be satisfied
 * by inventing them. An invented attempt is a real row somewhere, or a real id
 * that later collides with one — either way the ledger stops meaning what it
 * says. So the status claim carries the provisioning operation it belongs to
 * and nothing about a run at all.
 *
 * The separation is enforced in both directions: a status token may not carry
 * run, attempt or lease fields, and a work token may not carry a provisioning
 * operation. Neither is a warning — a token that mixes the two is refused.
 */
describe('the status claim', () => {
    function statusClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            v: 1,
            kid: 'test-kid',
            aud: 'runtime-1',
            op: 'status',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            provisioningOperationId: 'op-1',
            requestKey: 'req-1',
            epoch: 3,
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW,
            exp: NOW + 60_000,
            ...overrides,
        };
    }

    function verifyStatus(token: string, overrides: Record<string, unknown> = {}) {
        return verifyManagedDispatchToken({
            token,
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'status',
            paramsDigest: canonicalManagedPayloadDigest({}),
            currentEpoch: 3,
            provisioningOperationId: 'op-1',
            now: NOW + 1_000,
            ...overrides,
        } as never);
    }

    it('accepts a status token that names its provisioning operation', () => {
        const result = verifyStatus(mint(statusClaims()));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.claims.op).toBe('status');
        expect((result.claims as { provisioningOperationId?: string }).provisioningOperationId)
            .toBe('op-1');
    });

    it('refuses a status token without one', () => {
        const { provisioningOperationId: _omitted, ...without } = statusClaims();
        expect(verifyStatus(mint(without))).toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['runId', 'attemptId'])('refuses a status token carrying %s', (field) => {
        // Present at all, not merely required: a status token that can name a
        // run is a status token that can be replayed as one.
        expect(verifyStatus(mint(statusClaims({ [field]: 'smuggled' }))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['renewalSeq', 'leaseMs', 'absoluteExpiry'])(
        'refuses a status token carrying the lease field %s', (field) => {
            // Reading a status must never be able to hold a write deadline open.
            expect(verifyStatus(mint(statusClaims({ [field]: 1 }))))
                .toEqual({ ok: false, reason: 'malformed' });
        },
    );

    it('refuses a work token that carries a provisioning operation', () => {
        expect(verify(mint(claims({ provisioningOperationId: 'op-1' } as never))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a status token minted for another operation', () => {
        expect(verifyStatus(mint(statusClaims()), { op: 'query' }))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('is bound to the provisioning operation this runtime was created by', () => {
        // Lifting the epoch gate leaves the operation as the only thing tying
        // a status token to this runtime's generation. A token minted for a
        // different provisioning operation is a token for a different runtime
        // life — one whose resources this one may already have replaced.
        expect(verifyStatus(mint(statusClaims({ provisioningOperationId: 'op-someone-else' }))))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses a status token when the runtime knows of no operation', () => {
        // Fail closed: an unprovisioned runtime cannot confirm anything about
        // which operation a token belongs to.
        expect(verifyStatus(mint(statusClaims()), { provisioningOperationId: undefined }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('reads a runtime that has not been granted an epoch yet', () => {
        // A newly booted runtime holds epoch 0 until the first lease grant, and
        // the parent asks for its status precisely to find that out. Holding
        // the token to the runtime's current epoch would make the question
        // unanswerable exactly when it matters: the parent would have to know
        // the answer in order to ask.
        //
        // The token is bound to the provisioning operation instead, and the
        // runtime reports whatever epoch it currently holds. Nothing is
        // mutated by asking, so an epoch that does not match is a fact to
        // report rather than a request to refuse.
        expect(verifyStatus(mint(statusClaims({ epoch: 4 })), { currentEpoch: 0 }).ok).toBe(true);
        expect(verifyStatus(mint(statusClaims({ epoch: 0 })), { currentEpoch: 4 }).ok).toBe(true);
    });

    it('still holds work tokens to the epoch the runtime is on', () => {
        // The rule that was relaxed for reading is unchanged for writing.
        expect(verify(mint(claims({ epoch: 4 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
        expect(verify(mint(claims({ epoch: 2 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('leaves the existing work wire exactly as it was', () => {
        // The tokens already in flight carry no `provisioningOperationId` and
        // must keep verifying unchanged.
        const result = verify(mint(claims()));
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op === 'status'
            || result.claims.op === 'runtime-lease' || result.claims.op === 'checkpoint') return;
        expect(result.claims.runId).toBe('run-1');
        expect(result.claims.attemptId).toBe('attempt-1');
    });
});

/**
 * The lease a runtime is granted before there is any run to name.
 *
 * A newly booted runtime holds no lease, and the parent needs it fenced before
 * it will dispatch anything — which happens before an attempt exists. The
 * existing `lease` op cannot serve that: its claim requires a run and an
 * attempt, and the only way to satisfy it early is to invent them.
 *
 * So the grant is bound to the provisioning operation instead. It is a write,
 * not a reading: it carries the lease fields the fence path needs, and it is
 * refused if it carries a run.
 */
describe('the runtime-lease claim', () => {
    function leaseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            v: 1,
            kid: 'test-kid',
            aud: 'runtime-1',
            op: 'runtime-lease',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            provisioningOperationId: 'op-1',
            requestKey: 'req-1',
            epoch: 4,
            renewalSeq: 1,
            leaseMs: 60_000,
            absoluteExpiry: NOW + 3_600_000,
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW,
            exp: NOW + 60_000,
            ...overrides,
        };
    }

    function verifyLease(token: string, overrides: Record<string, unknown> = {}) {
        return verifyManagedDispatchToken({
            token,
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'runtime-lease',
            paramsDigest: canonicalManagedPayloadDigest({}),
            currentEpoch: 0,
            provisioningOperationId: 'op-1',
            now: NOW + 1_000,
            ...overrides,
        } as never);
    }

    it('grants an epoch to a runtime that has none yet', () => {
        const result = verifyLease(mint(leaseClaims()));
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op !== 'runtime-lease') return;
        expect(result.claims.provisioningOperationId).toBe('op-1');
        expect(result.claims.renewalSeq).toBe(1);
        expect(result.claims.leaseMs).toBe(60_000);
        expect(result.claims.absoluteExpiry).toBe(NOW + 3_600_000);
    });

    it.each(['runId', 'attemptId'])('refuses one that names %s', (field) => {
        expect(verifyLease(mint(leaseClaims({ [field]: 'smuggled' }))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['renewalSeq', 'leaseMs', 'absoluteExpiry'])('requires %s', (field) => {
        const claims = leaseClaims();
        delete claims[field];
        expect(verifyLease(mint(claims))).toEqual({ ok: false, reason: 'malformed' });
    });

    it('is bound to the provisioning operation, like a status read', () => {
        expect(verifyLease(mint(leaseClaims({ provisioningOperationId: 'op-other' }))))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('may raise the epoch, because it is the path that fences', () => {
        // The same rule the run-scoped lease has: only a renewal may carry a
        // higher epoch, and only because it performs the fence first.
        expect(verifyLease(mint(leaseClaims({ epoch: 9 })), { currentEpoch: 3 }).ok).toBe(true);
        expect(verifyLease(mint(leaseClaims({ epoch: 2 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('is not accepted where a status read was asked for', () => {
        expect(verifyLease(mint(leaseClaims()), { op: 'status' }))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('leaves the run-scoped lease wire exactly as it was', () => {
        const result = verify(mint(claims({
            op: 'lease', epoch: 4, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 3_600_000,
        } as never)), { op: 'lease', currentEpoch: 3 });
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op === 'status'
            || result.claims.op === 'runtime-lease' || result.claims.op === 'checkpoint') return;
        expect(result.claims.runId).toBe('run-1');
        expect(result.claims.attemptId).toBe('attempt-1');
    });
});
