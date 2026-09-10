import { describe, expect, it } from 'vitest';

import { assertManagedAttachmentUrl, type ManagedCredentialMode } from './apiSession';

/**
 * The URL contract a managed child applies before a scoped bearer is sent
 * anywhere. Pure: no network, no server.
 */

const managed: ManagedCredentialMode = { serverOrigin: 'https://relay.example.test' };
const SESSION = 'session-1';

describe('a URL a managed child will send its bearer to', () => {
    it('accepts the relay origin under its own session', () => {
        const url = assertManagedAttachmentUrl(
            `https://relay.example.test/v1/sessions/${SESSION}/attachments/blob.enc`,
            managed, SESSION,
        );
        expect(url.origin).toBe('https://relay.example.test');
    });

    it('refuses another origin, however similar', () => {
        for (const raw of [
            'https://relay.example.test.evil/v1/sessions/session-1/attachments/b.enc',
            'https://evil.test/v1/sessions/session-1/attachments/b.enc',
            'http://relay.example.test/v1/sessions/session-1/attachments/b.enc',
            'https://relay.example.test:8443/v1/sessions/session-1/attachments/b.enc',
        ]) {
            expect(() => assertManagedAttachmentUrl(raw, managed, SESSION), raw)
                .toThrow(/server origin/);
        }
    });

    it('refuses credentials embedded in the URL', () => {
        expect(() => assertManagedAttachmentUrl(
            'https://user:secret@relay.example.test/v1/sessions/session-1/attachments/b.enc',
            managed, SESSION,
        )).toThrow(/credentials|server origin/);
    });

    it('refuses a path outside this session', () => {
        expect(() => assertManagedAttachmentUrl(
            'https://relay.example.test/v1/sessions/someone-else/attachments/b.enc',
            managed, SESSION,
        )).toThrow(/under this session/);
        expect(() => assertManagedAttachmentUrl(
            'https://relay.example.test/v1/machines/m1/attachments/b.enc',
            managed, SESSION,
        )).toThrow(/under this session/);
    });

    it('refuses something that is not an absolute URL', () => {
        expect(() => assertManagedAttachmentUrl('/v1/sessions/session-1/attachments/b.enc', managed, SESSION))
            .toThrow(/absolute/);
    });

    it('encodes the session the same way the request does', () => {
        const odd = 'session with space';
        expect(() => assertManagedAttachmentUrl(
            `https://relay.example.test/v1/sessions/${encodeURIComponent(odd)}/attachments/b.enc`,
            managed, odd,
        )).not.toThrow();
    });
});

/**
 * The redirect contract, driven through a real HTTP server.
 *
 * A 307 is answered after the request has been sent, so the bearer is already
 * on the wire by the time the client sees it. Refusing to follow one is the
 * only place that can be prevented, and it has to hold on every call — the two
 * metadata POSTs as much as the blob transfers.
 */
describe('a managed client never follows a redirect', () => {
    it('refuses a 307 on metadata and on blobs, and leaks nothing to the target', async () => {
        const { createServer } = await import('node:http');
        const axios = (await import('axios')).default;

        const seen: Array<{ path: string; auth: string | undefined }> = [];
        const decoy = createServer((req, res) => {
            seen.push({ path: req.url ?? '', auth: req.headers.authorization });
            res.writeHead(200).end('leaked');
        });
        await new Promise<void>((r) => decoy.listen(0, '127.0.0.1', r));
        const decoyPort = (decoy.address() as { port: number }).port;

        const origin = createServer((req, res) => {
            res.writeHead(307, { location: `http://127.0.0.1:${decoyPort}${req.url}` }).end();
        });
        await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
        const originPort = (origin.address() as { port: number }).port;

        try {
            for (const call of [
                () => axios.post(`http://127.0.0.1:${originPort}/v1/sessions/s/attachments/request-upload`,
                    {}, { headers: { Authorization: 'Bearer scoped' }, maxRedirects: 0 }),
                () => axios.post(`http://127.0.0.1:${originPort}/v1/sessions/s/attachments/request-download`,
                    {}, { headers: { Authorization: 'Bearer scoped' }, maxRedirects: 0 }),
                () => axios.put(`http://127.0.0.1:${originPort}/v1/sessions/s/attachments/b.enc`,
                    Buffer.from('x'), { headers: { Authorization: 'Bearer scoped' }, maxRedirects: 0 }),
                () => axios.get(`http://127.0.0.1:${originPort}/v1/sessions/s/attachments/b.enc`,
                    { headers: { Authorization: 'Bearer scoped' }, maxRedirects: 0 }),
            ]) {
                await expect(call()).rejects.toMatchObject({ response: { status: 307 } });
            }
            // The bearer never reached the redirect target.
            expect(seen).toEqual([]);
        } finally {
            await new Promise<void>((r) => origin.close(() => r()));
            await new Promise<void>((r) => decoy.close(() => r()));
        }
    }, 20_000);

    it('is configured on all four managed call sites', async () => {
        // A shape assertion, and it is only that: the transport behaviour is
        // proven above, while this pins that every one of the four calls opts
        // in. Comment text is excluded by matching a property line.
        const source = await (await import('node:fs/promises'))
            .readFile(new URL('./apiSession.ts', import.meta.url), 'utf8');
        const properties = source.match(/^\s+(\.\.\.\(this\.managed \? \{ )?maxRedirects: (this\.managed \? 0 : 5|0)/gm) ?? [];
        // request-upload, request-download, blob PUT, blob GET.
        expect(properties.length).toBe(4);
    });
});
