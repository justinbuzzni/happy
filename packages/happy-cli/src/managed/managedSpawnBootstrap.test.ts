/**
 * The B2 spawn envelope, as the child must read it.
 *
 * The envelope carries a session raw key and a scoped bearer, so it never
 * travels as text anyone can read: the parent hands over an already-open,
 * read-only file descriptor and the child is told only its number. Nothing in
 * `argv` or the environment can then be scraped for the secret, and the
 * descriptor is closed the moment it has been parsed.
 */
import { describe, it, expect } from 'vitest';
import { openSync, writeFileSync, unlinkSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
    MANAGED_BOOTSTRAP_CHILD_FD,
    MANAGED_BOOTSTRAP_MAX_BYTES,
    parseManagedSpawnEnvelope,
    readManagedSpawnEnvelopeFromFd,
    stageManagedSpawnEnvelope,
    discardStagedManagedSpawnEnvelope,
} from '@/managed/managedSpawnBootstrap';

const HAPPY_ORIGIN = 'https://happy.example.test';
const SAYCODE_ORIGIN = 'https://studio.example.test';
const NOW = 1_800_000_000_000;

const rawKey = () => Buffer.alloc(32, 7).toString('base64');
const wrappedKey = () => Buffer.alloc(105, 9).toString('base64');

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        directory: '/workspace/project',
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: HAPPY_ORIGIN,
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: rawKey(),
            wrappedKeyBase64: wrappedKey(),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: NOW + 3_600_000,
        },
        // A different service from the Happy server, and deliberately so.
        gateway: {
            baseUrl: `${SAYCODE_ORIGIN}/api/cloud/gateway/anthropic/v1/messages`,
            capability: 'cap-1',
            provider: 'anthropic',
            endpoint: 'anthropic-messages',
            model: 'claude-opus-5',
        },
        ...over,
    };
}

/** An fd with no name left on disk, like the one the parent passes down. */
function anonymousFd(contents: string): number {
    const path = join(tmpdir(), `managed-bootstrap-${randomUUID()}`);
    writeFileSync(path, contents, { mode: 0o600 });
    const fd = openSync(path, 'r');
    unlinkSync(path);
    return fd;
}

describe('reading the spawn envelope', () => {
    it('accepts a Happy origin and a Saycode gateway that are different services', () => {
        const parsed = parseManagedSpawnEnvelope(envelope(), NOW);
        expect(parsed.bootstrap.serverOrigin).toBe(HAPPY_ORIGIN);
        expect(new URL(parsed.gateway.baseUrl).origin).toBe(SAYCODE_ORIGIN);
    });

    it('keeps the two origins apart rather than requiring one', () => {
        // Same-origin is also legitimate; what must not happen is a rule that
        // forces them together, because the two services are addressed
        // separately in production.
        const sameOrigin = envelope({
            gateway: {
                ...(envelope().gateway as Record<string, unknown>),
                baseUrl: `${HAPPY_ORIGIN}/api/cloud/gateway/anthropic/v1/messages`,
            },
        });
        expect(() => parseManagedSpawnEnvelope(sameOrigin, NOW)).not.toThrow();
    });

    it.each([
        ['bootstrap.rawKeyBase64', { rawKeyBase64: Buffer.alloc(31, 7).toString('base64') }],
        ['bootstrap.wrappedKeyBase64', { wrappedKeyBase64: Buffer.alloc(104, 9).toString('base64') }],
        ['bootstrap.serverOrigin', { serverOrigin: 'http://happy.example.test' }],
        ['bootstrap.serverOrigin', { serverOrigin: 'http://127.0.0.1.evil.test' }],
        ['bootstrap.serverOrigin', { serverOrigin: 'not-a-url' }],
        ['bootstrap.encryptionVariant', { encryptionVariant: 'legacy' }],
        ['bootstrap.sessionId', { sessionId: '' }],
        ['bootstrap.scopedToken', { scopedToken: '' }],
        ['bootstrap.tokenExpiresAt', { tokenExpiresAt: NOW - 1 }],
    ])('refuses %s', (field, over) => {
        const broken = envelope({ bootstrap: { ...(envelope().bootstrap as object), ...over } });
        expect(() => parseManagedSpawnEnvelope(broken, NOW)).toThrow(new RegExp(field.replace('.', '\\.')));
    });

    it.each([
        ['gateway.baseUrl', { baseUrl: `${SAYCODE_ORIGIN}/api/cloud/gateway/anthropic/v1/messages?k=1` }],
        ['gateway.baseUrl', { baseUrl: `https://u:p@studio.example.test/api/cloud/gateway/anthropic/v1/messages` }],
        ['gateway.baseUrl', { baseUrl: `${SAYCODE_ORIGIN}/api/cloud/gateway/evil/v1/messages` }],
        ['gateway.baseUrl', { baseUrl: `http://studio.example.test/api/cloud/gateway/anthropic/v1/messages` }],
        ['gateway.model', { model: 'claude-something-else' }],
    ])('refuses %s', (field, over) => {
        const broken = envelope({ gateway: { ...(envelope().gateway as object), ...over } });
        expect(() => parseManagedSpawnEnvelope(broken, NOW)).toThrow(new RegExp(field.replace('.', '\\.')));
    });

    it('allows plaintext only where there is no network to read it', () => {
        const loopback = envelope({
            bootstrap: { ...(envelope().bootstrap as object), serverOrigin: 'http://127.0.0.1:3005' },
        });
        expect(() => parseManagedSpawnEnvelope(loopback, NOW)).not.toThrow();
    });

    it.each([
        ['gateway.provider', { provider: 'openai' }],
        ['gateway.endpoint', { endpoint: 'openai-responses' }],
        ['gateway.baseUrl', { baseUrl: `${SAYCODE_ORIGIN}/api/cloud/gateway/openai/v1/responses` }],
    ])('refuses %s belonging to the other agent', (field, over) => {
        // Each of these is a legitimate value — for codex. Taken one field at a
        // time they all look fine, which is why the row is matched whole.
        const crossed = envelope({ gateway: { ...(envelope().gateway as object), ...over } });
        expect(() => parseManagedSpawnEnvelope(crossed, NOW))
            .toThrow(new RegExp(field.replace('.', '\\.')));
    });

    it('accepts the codex row, whole', () => {
        const codex = envelope({
            agent: 'codex',
            model: 'gpt-5',
            gateway: {
                baseUrl: `${SAYCODE_ORIGIN}/api/cloud/gateway/openai/v1/responses`,
                capability: 'cap-1', provider: 'openai', endpoint: 'openai-responses', model: 'gpt-5',
            },
        });
        expect(() => parseManagedSpawnEnvelope(codex, NOW)).not.toThrow();
    });

    it('refuses an agent this deployment does not run', () => {
        expect(() => parseManagedSpawnEnvelope(envelope({ agent: 'gemini' }), NOW)).toThrow(/agent/);
    });

    it('names only the field in its errors, never the value', () => {
        const broken = envelope({
            bootstrap: { ...(envelope().bootstrap as object), scopedToken: '' },
        });
        try {
            parseManagedSpawnEnvelope(broken, NOW);
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(String(error)).not.toContain('scoped.bearer.value');
            expect(String(error)).not.toContain(rawKey());
        }
    });
});

describe('the descriptor the envelope arrives on', () => {
    it('reads it and closes it, leaving nothing open', async () => {
        const fd = anonymousFd(JSON.stringify(envelope()));
        const parsed = await readManagedSpawnEnvelopeFromFd(fd, NOW);
        expect(parsed.bootstrap.sessionId).toBe('sess-1');
        // The descriptor is gone: fstat on a closed one is an error.
        expect(() => fstatSync(fd)).toThrow();
    });

    it('closes it even when the contents are refused', async () => {
        const fd = anonymousFd('{"version":1}');
        await expect(readManagedSpawnEnvelopeFromFd(fd, NOW)).rejects.toThrow();
        expect(() => fstatSync(fd)).toThrow();
    });

    it('refuses an envelope larger than the bound instead of reading it all', async () => {
        const padded = envelope({ initialPrompt: 'x'.repeat(MANAGED_BOOTSTRAP_MAX_BYTES) });
        const fd = anonymousFd(JSON.stringify(padded));
        await expect(readManagedSpawnEnvelopeFromFd(fd, NOW)).rejects.toThrow(/too large/i);
        expect(() => fstatSync(fd)).toThrow();
    });

    it('reads an envelope that does not arrive in one read', async () => {
        // Larger than the read buffer, so a single `read` returns a fragment.
        // Stopping there would parse a truncated envelope, or refuse a valid one.
        const long = 'y'.repeat(40_000);
        const fd = anonymousFd(JSON.stringify(envelope({ initialPrompt: long })));
        const parsed = await readManagedSpawnEnvelopeFromFd(fd, NOW);
        expect(parsed.initialPrompt).toHaveLength(40_000);
    });

    it('reads a real pipe, in fragments, to the end', async () => {
        // The descriptor a parent hands over may be a pipe, and a pipe has no
        // position: a positional read on one fails with ESPIPE, and the
        // envelope never arrives. It also arrives in pieces, whenever the
        // writer gets around to writing them.
        const { execFileSync, spawn } = await import('node:child_process');
        const { mkdtempSync } = await import('node:fs');
        const dir = mkdtempSync(join(tmpdir(), 'managed-fifo-'));
        const fifo = join(dir, 'envelope');
        execFileSync('mkfifo', [fifo]);

        const payload = JSON.stringify(envelope());
        const half = Math.floor(payload.length / 2);
        // Opening the write end first; the read open below unblocks both.
        const writer = spawn('sh', [
            '-c',
            `exec 1>"${fifo}"; printf %s ${JSON.stringify(payload.slice(0, half))};`
            + ` sleep 0.05; printf %s ${JSON.stringify(payload.slice(half))}`,
        ], { stdio: 'ignore' });

        try {
            const fd = openSync(fifo, 'r');
            const parsed = await readManagedSpawnEnvelopeFromFd(fd, NOW);
            expect(parsed.bootstrap.sessionId).toBe('sess-1');
        } finally {
            writer.kill();
            await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
        }
    }, 30_000);

    it('carries an envelope far larger than any single read, escaping included', async () => {
        // 70 KiB of prompt is inside what the parent admits, and JSON escaping
        // makes the wire form larger again. Neither may be refused here.
        const unicodePrompt = '설명해 주세요 "인용" \\ 백슬래시 '.repeat(2_500);
        const big = envelope({ initialPrompt: unicodePrompt });
        const wire = JSON.stringify(big);
        expect(Buffer.byteLength(unicodePrompt, 'utf8')).toBeGreaterThan(70 * 1024);
        expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(Buffer.byteLength(unicodePrompt, 'utf8'));

        const fd = anonymousFd(wire);
        const parsed = await readManagedSpawnEnvelopeFromFd(fd, NOW);
        expect(parsed.initialPrompt).toBe(unicodePrompt);
    }, 30_000);

    it('refuses a descriptor number that is not one', async () => {
        await expect(readManagedSpawnEnvelopeFromFd(Number.NaN, NOW)).rejects.toThrow(/descriptor/i);
    });
});

describe('handing the envelope to a child', () => {
    it('passes a descriptor and a number, never the envelope itself', async () => {
        const staged = await stageManagedSpawnEnvelope(parseManagedSpawnEnvelope(envelope(), NOW));
        try {
            // The environment carries the number the *child* will see, which is
            // the stdio slot it is placed in — not the parent's own descriptor.
            expect(staged.env).toEqual({
                HAPPY_MANAGED_BOOTSTRAP_FD: String(MANAGED_BOOTSTRAP_CHILD_FD),
            });
            expect(JSON.stringify(staged.env)).not.toContain('scoped.bearer.value');
            expect(JSON.stringify(staged.env)).not.toContain(rawKey());
            expect(staged.stdio[MANAGED_BOOTSTRAP_CHILD_FD]).toBe(staged.fd);
            expect(staged.stdio.slice(0, 3)).toEqual(['ignore', 'ignore', 'ignore']);

            // And the descriptor really does hold the envelope.
            const readBack = await readManagedSpawnEnvelopeFromFd(staged.fd, NOW);
            expect(readBack.bootstrap.sessionId).toBe('sess-1');
        } finally {
            try { closeSync(staged.fd); } catch { /* the read above closed it */ }
        }
    });

    it('leaves no file and no directory behind for anyone else to open', async () => {
        const staged = await stageManagedSpawnEnvelope(parseManagedSpawnEnvelope(envelope(), NOW));
        try {
            // No path exists, so there is nothing to open by name — the only
            // way to the bytes is a descriptor the parent handed over.
            expect(staged).not.toHaveProperty('path');
            expect(fstatSync(staged.fd).nlink).toBe(0);
        } finally {
            discardStagedManagedSpawnEnvelope(staged);
        }
    });

    it('closes the descriptor when the child never got it', async () => {
        const staged = await stageManagedSpawnEnvelope(parseManagedSpawnEnvelope(envelope(), NOW));
        discardStagedManagedSpawnEnvelope(staged);
        // A spawn that threw would otherwise leave the parent holding an open
        // copy of the envelope for the rest of its life.
        expect(() => fstatSync(staged.fd)).toThrow();
    });
});

/**
 * The parent's own output, parsed by this child.
 *
 * Produced by `buildManagedSpawnParams` in `packages/web-ui/server/
 * cloudRunSpawnWire.ts` (owned by another writer, read-only here) and pasted
 * verbatim. Two independent restatements of one wire drift silently; this
 * fails the moment they stop agreeing — it already caught a top-level
 * `version` this side required and the parent never emits.
 */
const PARENT_WIRE_OUTPUT = {
    directory: '/workspace/project',
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    initialPrompt: 'do the thing',
    initialPromptLocalId: '099cd344ff450c89a2f3712423b0e578',
    bootstrap: {
        version: 1,
        serverOrigin: 'https://happy.example.test',
        sessionId: 'sess-1',
        encryptionVariant: 'dataKey',
        rawKeyBase64: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
        wrappedKeyBase64: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ',
        scopedToken: 'scoped.bearer.value',
        tokenExpiresAt: 1800003600000,
    },
    gateway: {
        baseUrl: 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages',
        capability: 'cap-1',
        provider: 'anthropic',
        endpoint: 'anthropic-messages',
        model: 'claude-opus-5',
    },
};

describe('the wire the parent actually builds', () => {
    it('is read by this child without adjustment', () => {
        const parsed = parseManagedSpawnEnvelope(PARENT_WIRE_OUTPUT, 1_800_000_000_000);
        expect(parsed.agent).toBe('claude');
        expect(parsed.model).toBe('claude-opus-5');
        expect(parsed.effort).toBe('high');
        expect(parsed.initialPrompt).toBe('do the thing');
        expect(parsed.initialPromptLocalId).toBe('099cd344ff450c89a2f3712423b0e578');
        expect(parsed.directory).toBe('/workspace/project');
        expect(parsed.bootstrap.sessionId).toBe('sess-1');
        expect(parsed.gateway.endpoint).toBe('anthropic-messages');
        // The two services are addressed separately, and the wire says so.
        expect(new URL(parsed.gateway.baseUrl).origin)
            .not.toBe(new URL(parsed.bootstrap.serverOrigin).origin);
    });
});
