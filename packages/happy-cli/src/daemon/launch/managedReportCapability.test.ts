import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
    MANAGED_REPORT_CAPABILITY_HEADER,
    MAX_CAPABILITY_BYTES,
    mintManagedReportCapability,
    readCapabilityLaunchId,
    verifyManagedReportCapability,
} from './managedReportCapability';

const SECRET = randomBytes(32);
const OTHER = randomBytes(32);
const NOW = 1_800_000_000_000;
const BODY = { sessionId: 's-1', metadata: { hostPid: 4242 } };

function mint(over: Partial<Parameters<typeof mintManagedReportCapability>[0]> = {}): string {
    return mintManagedReportCapability({
        secret: SECRET, launchId: 'launch-1', kind: 'session-started',
        seq: 1, expiresAt: NOW + 60_000, body: BODY, ...over,
    });
}

function verify(capability: string, over: Partial<Parameters<typeof verifyManagedReportCapability>[0]> = {}) {
    return verifyManagedReportCapability({
        capability, secret: SECRET, kind: 'session-started', body: BODY, now: NOW, ...over,
    });
}

describe('managed report capability', () => {
    it('mints and verifies a capability bound to this launch, kind, seq and body', () => {
        const result = verify(mint());
        expect(result).toMatchObject({
            ok: true,
            claims: { launchId: 'launch-1', kind: 'session-started', seq: 1 },
        });
    });

    it('exposes a stable header name', () => {
        expect(MANAGED_REPORT_CAPABILITY_HEADER).toBe('x-happy-managed-report');
    });

    it('reads the launch id without a signature so the right secret can be chosen', () => {
        expect(readCapabilityLaunchId(mint())).toBe('launch-1');
        expect(readCapabilityLaunchId('not-a-capability')).toBeNull();
        expect(readCapabilityLaunchId('x'.repeat(MAX_CAPABILITY_BYTES + 1))).toBeNull();
    });

    it('refuses another launch secret', () => {
        expect(verify(mint(), { secret: OTHER })).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a body that is not the one signed', () => {
        // 같은 sessionId, 다른 hostPid — daemon 이 채택할 프로세스가 바뀐다.
        const swapped = { sessionId: 's-1', metadata: { hostPid: 9999 } };
        expect(verify(mint(), { body: swapped })).toEqual({ ok: false, reason: 'body-mismatch' });
    });

    it('key order in the body does not change the verdict', () => {
        const reordered = { metadata: { hostPid: 4242 }, sessionId: 's-1' };
        expect(verify(mint(), { body: reordered })).toMatchObject({ ok: true });
    });

    it('refuses a capability replayed at the other report path', () => {
        expect(verify(mint({ kind: 'session-runtime' }), { kind: 'session-started' }))
            .toEqual({ ok: false, reason: 'wrong-kind' });
    });

    it('refuses at and after the expiry, and refuses an unusable clock', () => {
        expect(verify(mint(), { now: NOW + 60_000 })).toEqual({ ok: false, reason: 'expired' });
        expect(verify(mint(), { now: Number.NaN })).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses malformed shapes without throwing', () => {
        for (const capability of ['', '.', 'a.b.c', 'notbase64.sig', 'x'.repeat(10)]) {
            expect(verify(capability).ok).toBe(false);
        }
    });

    it('bounds the input before parsing it', () => {
        expect(verify('x'.repeat(MAX_CAPABILITY_BYTES + 1))).toEqual({ ok: false, reason: 'too-large' });
    });

    it('refuses a tampered payload even when the signature is well formed', () => {
        const capability = mint();
        const [payload, signature] = capability.split('.');
        const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
        claims.seq = 99;
        const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
        expect(verify(forged)).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses to mint on inputs that cannot be trusted', () => {
        expect(() => mint({ secret: randomBytes(31) })).toThrow(/32 bytes/);
        expect(() => mint({ seq: 0 })).toThrow(/positive safe integers/);
        expect(() => mint({ expiresAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/positive safe integers/);
        expect(() => mint({ launchId: '  ' })).toThrow(/launchId/);
    });

    it('does not carry any body content — only a digest', () => {
        const capability = mint({ body: { sessionId: 's-1', secretish: 'sk-live-LEAK' } });
        expect(capability).not.toContain('sk-live-LEAK');
        expect(Buffer.from(capability.split('.')[0]!, 'base64url').toString('utf8'))
            .not.toContain('sk-live-LEAK');
    });
});
