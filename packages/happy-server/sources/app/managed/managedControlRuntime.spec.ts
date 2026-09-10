import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { createManagedControlRuntime } from '@/app/managed/managedControlRuntime';

/** Pure: no database, no ambient environment. */

const { publicKey } = generateKeyPairSync('ed25519');
const KEY = Buffer
    .from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
    .toString('base64');

function env(publicUrl: string) {
    return {
        HAPPY_MANAGED_CONTROL_VERIFIER_KEYS: JSON.stringify({ 'control-1': KEY }),
        HAPPY_MANAGED_CONTROL_AUDIENCE: 'https://happy.example.test',
        HAPPY_MANAGED_SCOPED_TOKEN_SEED: 'test-seed-not-a-production-key',
        HAPPY_MANAGED_PUBLIC_URL: publicUrl,
    };
}

describe('the origin managed URLs are built from', () => {
    it('accepts https anywhere', async () => {
        const runtime = await createManagedControlRuntime(env('https://relay.example.test'));
        expect(runtime?.publicUrl).toBe('https://relay.example.test');
    });

    it('accepts plain http only for localhost', async () => {
        const runtime = await createManagedControlRuntime(env('http://localhost:3005'));
        expect(runtime?.publicUrl).toBe('http://localhost:3005');
        await expect(createManagedControlRuntime(env('http://relay.example.test')))
            .rejects.toThrow(/https/i);
        // Not part of the existing contract; left refused rather than widened
        // as a side effect of this change.
        await expect(createManagedControlRuntime(env('http://127.0.0.1:3005')))
            .rejects.toThrow(/https/i);
    });

    it('refuses a scheme that is neither, however local it looks', async () => {
        // The previous condition was "not https AND not localhost", so any
        // scheme reached the loopback exemption.
        for (const url of ['ftp://localhost/x', 'file://localhost/x', 'ws://localhost']) {
            await expect(createManagedControlRuntime(env(url)), url).rejects.toThrow(/https/i);
        }
    });

    it('refuses a URL carrying credentials rather than dropping them', async () => {
        // `new URL(...).origin` discards these silently, so the value that
        // would be published is not the value that was configured.
        await expect(createManagedControlRuntime(env('https://user:secret@relay.example.test')))
            .rejects.toThrow(/origin/i);
        await expect(createManagedControlRuntime(env('https://user@relay.example.test')))
            .rejects.toThrow(/origin/i);
    });

    it('refuses a path, query or fragment rather than dropping them', async () => {
        for (const url of [
            'https://relay.example.test/base',
            'https://relay.example.test/?q=1',
            'https://relay.example.test/#f',
        ]) {
            await expect(createManagedControlRuntime(env(url)), url).rejects.toThrow(/origin/i);
        }
    });

    it('accepts a bare origin with or without its trailing slash', async () => {
        for (const url of ['https://relay.example.test', 'https://relay.example.test/']) {
            const runtime = await createManagedControlRuntime(env(url));
            expect(runtime?.publicUrl, url).toBe('https://relay.example.test');
        }
    });

    it('still refuses a value that is not a URL at all', async () => {
        await expect(createManagedControlRuntime(env('relay.example.test')))
            .rejects.toThrow(/absolute URL/i);
    });
});
