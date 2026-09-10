/**
 * A managed client only ever talks to the origin it was given.
 *
 * `assertManagedAttachmentUrl` guards the URLs the *server* hands back, but the
 * two metadata POSTs and the socket are built from `configuration.serverUrl` —
 * a process-wide value this client does not own. If those two disagree, the
 * scoped bearer goes to whatever the global config points at, and no later
 * check can call it back. So the disagreement has to be fatal before anything
 * is sent: before the socket, before the common handlers, before any request.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Metadata } from '@/api/types';

let seen: string[] = [];
let uploadReply: unknown = {};
let downloadReply: unknown = {};
let server: Server;
let serverUrl = '';

vi.mock('@/configuration', () => ({
    configuration: {
        get serverUrl() { return serverUrl; },
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn() },
}));

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/workspace/project', host: 'localhost', homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
        } as Metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };
}

describe('what counts as the same origin', () => {
    /**
     * The real-server test below covers case and a trailing slash; a default
     * port cannot be covered there, because binding 443 is not something a
     * test may do. This pins the same normalisation at the pure level.
     */
    it.each([
        ['https://relay.test', 'https://relay.test/'],
        ['https://relay.test', 'HTTPS://Relay.test'],
        ['https://relay.test', 'https://relay.test:443'],
        ['https://relay.test', 'HTTPS://Relay.test:443/'],
        ['http://relay.test', 'http://relay.test:80/'],
    ])('reads %s out of %s', async (canonical, spelling) => {
        serverUrl = canonical;
        const { assertManagedServerOrigin } = await import('@/api/apiSession');
        expect(assertManagedServerOrigin({ serverOrigin: spelling })).toBe(canonical);
    });

    it('still separates origins that only look alike', async () => {
        serverUrl = 'https://relay.test';
        const { assertManagedServerOrigin } = await import('@/api/apiSession');
        for (const other of [
            'https://relay.test:8443', 'http://relay.test', 'https://relay.test.evil',
            'https://evil.test', 'https://relay.test:443:443',
        ]) {
            expect(() => assertManagedServerOrigin({ serverOrigin: other })).toThrow();
        }
    });
});

describe('a managed client and the origin it was configured with', () => {
    beforeAll(async () => {
        // A real server, so "nothing was sent" is observed rather than mocked.
        server = createServer((req, res) => {
            const line = `${req.method} ${req.url}`;
            seen.push(line);
            req.on('data', () => {});
            req.on('end', () => {
                if (line.includes('request-upload')) {
                    res.writeHead(200, { 'content-type': 'application/json' })
                        .end(JSON.stringify(uploadReply));
                    return;
                }
                if (line.includes('request-download')) {
                    res.writeHead(200, { 'content-type': 'application/json' })
                        .end(JSON.stringify(downloadReply));
                    return;
                }
                if (req.method === 'GET' && line.includes('.enc')) {
                    res.writeHead(200, { 'content-type': 'application/octet-stream' })
                        .end(Buffer.from([9, 9, 9]));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('refuses to exist when the two origins disagree, before reaching the network', async () => {
        const { ApiSessionClient } = await import('@/api/apiSession');
        seen = [];

        expect(() => new ApiSessionClient('scoped-token', makeSession(), {
            serverOrigin: 'https://relay.example.test',
        })).toThrow(/origin/i);

        // The socket is created in the constructor, so a throw that came too
        // late would still show up here as a connection attempt.
        await new Promise((r) => setTimeout(r, 250));
        expect(seen).toEqual([]);
    }, 20_000);

    /**
     * An origin is a normalised thing, and it has to stay normalised.
     *
     * `HTTPS://Relay.test:443/` and `https://relay.test` are the same origin,
     * so the constructor accepts either. If the raw text is then kept and
     * compared against a parsed `URL.origin`, every managed call built from it
     * is refused — the client would admit itself and then reject the very
     * server it was configured for.
     */
    it('uses the canonical origin for the whole flow, not the text it was given', async () => {
        const { ApiSessionClient } = await import('@/api/apiSession');
        const { port } = server.address() as { port: number };
        const client = new ApiSessionClient('scoped-token', makeSession(), {
            // Same origin as the server, spelled differently.
            serverOrigin: `HTTP://127.0.0.1:${port}/`,
        });
        try {
            seen = [];
            uploadReply = {
                ref: `sessions/test-session-id/attachments/a.enc`,
                uploadUrl: `${serverUrl}/v1/sessions/test-session-id/attachments/a.enc`,
                method: 'PUT',
            };
            downloadReply = {
                downloadUrl: `${serverUrl}/v1/sessions/test-session-id/attachments/a.enc`,
            };

            await client.uploadLocalImageAttachmentEnvelope({
                data: new Uint8Array([1, 2, 3]), name: 'shot.png', mimeType: 'image/png',
            } as never);
            await expect(client.downloadAttachment((uploadReply as { ref: string }).ref))
                .resolves.toBeInstanceOf(Uint8Array);

            // Every leg went to this server: two metadata POSTs and two blob
            // transfers, all on the one origin.
            expect(seen.filter((s) => s.includes('request-upload'))).toHaveLength(1);
            expect(seen.filter((s) => s.includes('request-download'))).toHaveLength(1);
            expect(seen.filter((s) => s.startsWith('PUT'))).toHaveLength(1);
            expect(seen.filter((s) => s.startsWith('GET') && s.includes('a.enc'))).toHaveLength(1);
        } finally {
            await client.close();
        }
    }, 20_000);

    it('accepts the matching origin', async () => {
        const { ApiSessionClient } = await import('@/api/apiSession');
        const client = new ApiSessionClient('scoped-token', makeSession(), {
            serverOrigin: new URL(serverUrl).origin,
        });
        expect(client.sessionId).toBe('test-session-id');
        // Proves the observation above is not vacuous: a client that was
        // allowed to exist does reach this server, and is seen doing it.
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5_000 });
        await client.close();
    }, 20_000);
});
