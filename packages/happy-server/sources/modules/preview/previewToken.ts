/**
 * Short-lived signed token for remote preview URLs.
 *
 * Browsers load iframe resources via GET and cannot attach an Authorization
 * header, so we sign the (userId, machineId, port) triple into a URL-safe
 * token that the preview route verifies on every request.
 *
 * Format: `{base64url(json_payload)}.{base64url(hmac_sha256(payload))}`
 *
 * The shared secret is `HANDY_MASTER_SECRET` (same as auth). Verification uses
 * a constant-time compare.
 */

import crypto from 'node:crypto';

export interface PreviewTokenPayload {
    userId: string;
    machineId: string;
    port: number;
}

export interface SignedPreviewToken {
    token: string;
    expiresAt: number;
}

export interface PreviewTokenOptions {
    secret?: string;
    ttlMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface EncodedPayload extends PreviewTokenPayload {
    exp: number;
}

function getSecret(override?: string): string {
    const secret = override ?? process.env.HANDY_MASTER_SECRET;
    if (!secret) {
        throw new Error('previewToken: HANDY_MASTER_SECRET is not set');
    }
    return secret;
}

function sign(payloadB64: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function encodePayload(payload: EncodedPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodePayload(encoded: string): EncodedPayload | null {
    try {
        const json = Buffer.from(encoded, 'base64url').toString('utf-8');
        const parsed = JSON.parse(json);
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.userId === 'string' &&
            typeof parsed.machineId === 'string' &&
            Number.isInteger(parsed.port) &&
            Number.isInteger(parsed.exp)
        ) {
            return parsed as EncodedPayload;
        }
        return null;
    } catch {
        return null;
    }
}

export function signPreviewToken(
    payload: PreviewTokenPayload,
    options: PreviewTokenOptions = {},
): SignedPreviewToken {
    const secret = getSecret(options.secret);
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = Date.now() + ttlMs;

    const payloadB64 = encodePayload({ ...payload, exp: expiresAt });
    const sig = sign(payloadB64, secret);
    return { token: `${payloadB64}.${sig}`, expiresAt };
}

export function verifyPreviewToken(
    token: string,
    options: PreviewTokenOptions = {},
): PreviewTokenPayload | null {
    const secret = getSecret(options.secret);

    if (typeof token !== 'string' || !token.includes('.')) {
        return null;
    }

    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) {
        return null;
    }

    const expected = sign(payloadB64, secret);
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(sig);
    if (expectedBuf.length !== actualBuf.length) {
        return null;
    }
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        return null;
    }

    const payload = decodePayload(payloadB64);
    if (!payload) {
        return null;
    }
    if (payload.exp <= Date.now()) {
        return null;
    }

    return { userId: payload.userId, machineId: payload.machineId, port: payload.port };
}
