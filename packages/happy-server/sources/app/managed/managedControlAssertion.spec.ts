import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

import { canonicalDigest } from '@/app/managed/canonicalDigest';
import * as controlAssertion from '@/app/managed/managedControlAssertion';
import {
    CONTROL_ASSERTION_PURPOSE,
    MAX_ASSERTION_LIFETIME_MS,
    createControlAssertionVerifier,
    encodeControlAssertion,
    encodeControlAssertionPayload,
    parseControlVerifierKeys,
    type ControlAssertionPayload,
    type ControlOperation,
} from '@/app/managed/managedControlAssertion';

/** Pure: no database, no ambient environment. */

const AUDIENCE = 'https://happy.example.test';
const NOW = 1_800_000_000_000;
const BODY = { runId: 'run-1', sessionId: 'session-1', epoch: 3 };

function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return { privateKey, base64: Buffer.from(raw).toString('base64') };
}

const control = keyPair();
const stranger = keyPair();

function verifier(over: { audience?: string; keys?: string } = {}) {
    const built = createControlAssertionVerifier({
        audience: over.audience ?? AUDIENCE,
        verifierKeys: over.keys ?? JSON.stringify({ 'control-1': control.base64 }),
    });
    if (!built) throw new Error('expected a verifier');
    return built;
}

function payload(over: Partial<ControlAssertionPayload> = {}): ControlAssertionPayload {
    return {
        kid: 'control-1',
        aud: AUDIENCE,
        purpose: CONTROL_ASSERTION_PURPOSE,
        op: 'grant-mint',
        // Recomputed by the verifier from the request body it actually received.
        bodyDigest: 'PLACEHOLDER',
        iat: NOW,
        exp: NOW + 60_000,
        ...over,
    };
}

function assertion(
    over: Partial<ControlAssertionPayload> = {},
    key = control.privateKey,
    body: unknown = BODY,
): string {
    const bytes = encodeControlAssertionPayload(payload({ bodyDigest: canonicalDigest(body), ...over }));
    return encodeControlAssertion(bytes, signBytes(null, bytes, key));
}

function check(assertionText: string, over: {
    operation?: ControlOperation; body?: unknown; now?: number;
} = {}) {
    return verifier().verify({
        assertion: assertionText,
        operation: over.operation ?? 'grant-mint',
        body: over.body ?? BODY,
        now: over.now ?? NOW,
    });
}

describe('configuration', () => {
    it('has no verifier when no keys are configured', () => {
        // Fail-closed: the caller must refuse control routes outright rather
        // than fall back to the account bearer alone.
        expect(createControlAssertionVerifier({ audience: AUDIENCE, verifierKeys: undefined })).toBeNull();
        expect(createControlAssertionVerifier({ audience: AUDIENCE, verifierKeys: '  ' })).toBeNull();
    });

    it('refuses to start with keys but no audience', () => {
        expect(() => createControlAssertionVerifier({
            audience: undefined, verifierKeys: JSON.stringify({ 'control-1': control.base64 }),
        })).toThrow(/AUDIENCE/);
    });

    it('rejects a malformed key map instead of ignoring it', () => {
        expect(() => parseControlVerifierKeys('not json')).toThrow(/JSON/);
        expect(() => parseControlVerifierKeys('[]')).toThrow(/JSON object/);
        expect(() => parseControlVerifierKeys('{}')).toThrow(/at least one key/);
        expect(() => parseControlVerifierKeys(JSON.stringify({ k: 123 }))).toThrow(/base64/);
        expect(() => parseControlVerifierKeys(JSON.stringify({ k: 'c2hvcnQ=' }))).toThrow(/32-byte/);
    });

    it('exposes verification only, never signing', () => {
        // This server must not be able to produce a control assertion: that
        // ability is the authority to mint, and a leak here would hand it over.
        expect(Object.keys(verifier())).toEqual(['verify']);
        expect(Object.keys(controlAssertion).filter((name) => /sign|privateKey/i.test(name)))
            .toEqual([]);
    });
});

describe('a valid assertion', () => {
    it('is accepted and names the key that signed it', () => {
        expect(check(assertion())).toEqual({ ok: true, keyId: 'control-1', operation: 'grant-mint' });
    });

    it('is accepted up to the instant before it expires', () => {
        expect(check(assertion(), { now: NOW + 59_999 })).toMatchObject({ ok: true });
    });

    it('tolerates a small amount of clock skew ahead of this server', () => {
        expect(check(assertion({ iat: NOW + 3_000, exp: NOW + 63_000 })))
            .toMatchObject({ ok: true });
    });
});

describe('what an assertion is bound to', () => {
    it('refuses a signature from a key this server does not verify', () => {
        expect(check(assertion({}, stranger.privateKey)))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses an unknown key id', () => {
        expect(check(assertion({ kid: 'rotated-out' })))
            .toEqual({ ok: false, reason: 'unknown-key' });
    });

    it('refuses an assertion minted for another deployment', () => {
        expect(check(assertion({ aud: 'https://other.example.test' })))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('refuses an assertion for another protocol', () => {
        expect(check(assertion({ purpose: 'some-other-protocol' })))
            .toEqual({ ok: false, reason: 'wrong-purpose' });
    });

    it('refuses to let one operation authorise another', () => {
        // A revoke assertion must not mint, and vice versa.
        expect(check(assertion({ op: 'grant-revoke' }), { operation: 'grant-mint' }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
        expect(check(assertion({ op: 'grant-mint' }), { operation: 'grant-revoke' }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses a body that changed after signing', () => {
        expect(check(assertion(), { body: { ...BODY, sessionId: 'someone-else' } }))
            .toEqual({ ok: false, reason: 'body-mismatch' });
        expect(check(assertion(), { body: { ...BODY, extra: 1 } }))
            .toEqual({ ok: false, reason: 'body-mismatch' });
    });

    it('binds the body by value, not by key order', () => {
        expect(check(assertion({}, control.privateKey, BODY), {
            body: { epoch: 3, sessionId: 'session-1', runId: 'run-1' },
        })).toMatchObject({ ok: true });
    });
});

describe('the validity window', () => {
    it('refuses an expired assertion at and past its expiry', () => {
        expect(check(assertion(), { now: NOW + 60_000 })).toEqual({ ok: false, reason: 'expired' });
        expect(check(assertion(), { now: NOW + 600_000 })).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses one issued further ahead than clock skew explains', () => {
        expect(check(assertion({ iat: NOW + 60_000, exp: NOW + 90_000 })))
            .toEqual({ ok: false, reason: 'not-yet-valid' });
    });

    it('refuses a window longer than the maximum', () => {
        expect(check(assertion({ exp: NOW + MAX_ASSERTION_LIFETIME_MS + 1 })))
            .toEqual({ ok: false, reason: 'lifetime-too-long' });
        expect(check(assertion({ exp: NOW + MAX_ASSERTION_LIFETIME_MS })))
            .toMatchObject({ ok: true });
    });

    it('refuses a window that ends before it starts', () => {
        expect(check(assertion({ iat: NOW, exp: NOW }))).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('malformed input', () => {
    it('refuses anything that is not payload.signature', () => {
        for (const value of ['', '.', 'onlyonepart', 'a.b.c', '!!!.???']) {
            expect(check(value), value).toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('refuses a payload that is not a complete object', () => {
        const bad = Buffer.from(JSON.stringify({ kid: 'control-1' }), 'utf8');
        expect(check(encodeControlAssertion(bad, signBytes(null, bad, control.privateKey))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses non-integer timestamps rather than coercing them', () => {
        expect(check(assertion({ iat: 1.5 as number }))).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('the read operations are their own', () => {
    it('accepts an assertion signed for each new operation', () => {
        for (const op of ['authority-snapshot', 'grant-resolve'] as const) {
            expect(check(assertion({ op }), { operation: op }))
                .toMatchObject({ ok: true, operation: op });
        }
    });

    it('does not let a read assertion authorise a write, or the reverse', () => {
        // A signed look must never be replayable as a change, and a signed
        // change must not be usable to collect a credential.
        for (const [signedOp, usedOp] of [
            ['authority-snapshot', 'authority-sync'],
            ['grant-resolve', 'grant-mint'],
            ['grant-mint', 'grant-resolve'],
            ['authority-sync', 'authority-snapshot'],
            // The daemon grant is a different authority from the session
            // grant: one is a runtime's identity, the other a child's licence
            // to act inside a conversation. Sharing an operation between them
            // would let an assertion signed to keep a session alive keep a
            // machine's identity alive too.
            ['grant-renew', 'daemon-renew'],
            ['daemon-renew', 'grant-renew'],
            ['grant-resolve', 'daemon-resolve'],
            ['daemon-resolve', 'grant-resolve'],
            ['daemon-bootstrap', 'daemon-renew'],
            ['daemon-resolve', 'daemon-renew'],
        ] as const) {
            expect(check(assertion({ op: signedOp }), { operation: usedOp }))
                .toEqual({ ok: false, reason: 'wrong-operation' });
        }
    });
});
