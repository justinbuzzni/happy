import { describe, it, expect } from 'vitest';
import { signPreviewToken, verifyPreviewToken } from '@/modules/preview/previewToken';

const SECRET = 'test-secret-0123456789abcdef';

describe('previewToken', () => {
    it('round-trips a payload through sign and verify', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const payload = verifyPreviewToken(signed.token, { secret: SECRET });
        expect(payload).toEqual({ userId: 'u1', machineId: 'm1', port: 3000 });
    });

    it('returns expiresAt roughly ttlMs in the future', () => {
        const before = Date.now();
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET, ttlMs: 60_000 },
        );
        const after = Date.now();
        expect(signed.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
        expect(signed.expiresAt).toBeLessThanOrEqual(after + 60_000);
    });

    it('returns null when the token has expired', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET, ttlMs: -1000 }, // already expired
        );
        expect(verifyPreviewToken(signed.token, { secret: SECRET })).toBeNull();
    });

    it('returns null when the signature does not match', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        expect(verifyPreviewToken(signed.token, { secret: 'different-secret' })).toBeNull();
    });

    it('returns null when the payload has been tampered with', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        // Replace the payload segment with another valid base64url value but keep
        // the original signature — verify should reject.
        const [, sig] = signed.token.split('.');
        const forgedPayload = Buffer
            .from(JSON.stringify({ userId: 'attacker', machineId: 'm1', port: 3000, exp: Date.now() + 60_000 }))
            .toString('base64url');
        const forged = `${forgedPayload}.${sig}`;
        expect(verifyPreviewToken(forged, { secret: SECRET })).toBeNull();
    });

    it('returns null for a malformed token', () => {
        expect(verifyPreviewToken('not-a-token', { secret: SECRET })).toBeNull();
        expect(verifyPreviewToken('', { secret: SECRET })).toBeNull();
        expect(verifyPreviewToken('only-one-segment.', { secret: SECRET })).toBeNull();
    });

    it('rejects a signature with the wrong length (length-safe compare)', () => {
        const signed = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        const [payload] = signed.token.split('.');
        // Truncated signature
        const truncated = `${payload}.shortsig`;
        expect(verifyPreviewToken(truncated, { secret: SECRET })).toBeNull();
    });

    it('binds token to the exact (userId, machineId, port) triple', () => {
        const forUser1 = signPreviewToken(
            { userId: 'u1', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        // Same token cannot be repurposed for another (userId, machineId, port)
        // — the payload is signed as-is, so a different triple yields a
        // different signed token.
        const forUser2 = signPreviewToken(
            { userId: 'u2', machineId: 'm1', port: 3000 },
            { secret: SECRET },
        );
        expect(forUser1.token).not.toBe(forUser2.token);
        expect(verifyPreviewToken(forUser1.token, { secret: SECRET })?.userId).toBe('u1');
        expect(verifyPreviewToken(forUser2.token, { secret: SECRET })?.userId).toBe('u2');
    });
});
