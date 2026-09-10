/**
 * Attaching to a session someone else created.
 *
 * A managed child is given one session id, the raw key for that session, and a
 * bearer scoped to it. It creates nothing: no account authentication, no
 * machine registration, no `POST /v1/sessions`, no key of its own. What it
 * must do is prove the session it was pointed at is the one the key belongs
 * to — exactly one record for that id, and a wrapped key matching byte for
 * byte — before the raw key is used to open anything.
 *
 * Driven against a real HTTP server: the lookup is the contract, and a stubbed
 * client would only restate the assumption.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { encodeBase64, encrypt } from '@/api/encryption';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';
import type { ManagedSpawnBootstrap } from '@/managed/managedSpawnBootstrap';

let serverUrl = '';
vi.mock('@/configuration', () => ({
    configuration: {
        get serverUrl() { return serverUrl; },
        get webappUrl() { return serverUrl; },
    },
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn() },
}));

const SESSION_ID = 'sess-managed-1';
const rawKey = new Uint8Array(32).fill(7);
const wrappedKey = new Uint8Array(105).fill(9);

let server: Server;
let seen: string[] = [];
let lookupSessions: unknown[] = [];

function bootstrap(over: Partial<ManagedSpawnBootstrap> = {}): ManagedSpawnBootstrap {
    return {
        version: 1,
        serverOrigin: serverUrl,
        sessionId: SESSION_ID,
        encryptionVariant: 'dataKey',
        rawKeyBase64: encodeBase64(rawKey),
        wrappedKeyBase64: encodeBase64(wrappedKey),
        scopedToken: 'scoped.bearer.value',
        tokenExpiresAt: Date.now() + 3_600_000,
        ...over,
    };
}

/** A record shaped like the server's, sealed with the key the child was given. */
function sessionRow(over: Record<string, unknown> = {}) {
    return {
        id: SESSION_ID,
        seq: 4,
        metadataVersion: 2,
        agentStateVersion: 1,
        dataEncryptionKey: encodeBase64(wrappedKey),
        metadata: encodeBase64(encrypt(rawKey, 'dataKey', {
            path: 'cloud://project-1/run-1', host: 'runtime', homeDir: '/root',
            happyHomeDir: '/root/.happy', happyLibDir: '/root/.happy/lib',
            happyToolsDir: '/root/.happy/tools',
        })),
        agentState: encodeBase64(encrypt(rawKey, 'dataKey', { controlledByUser: false })),
        ...over,
    };
}

describe('attaching a managed child to an existing session', () => {
    beforeAll(async () => {
        server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`);
            req.on('data', () => {});
            req.on('end', () => {
                if (req.url === '/v2/sessions/lookup') {
                    res.writeHead(200, { 'content-type': 'application/json' })
                        .end(JSON.stringify({ sessions: lookupSessions }));
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

    beforeEach(() => {
        seen = [];
        lookupSessions = [sessionRow()];
    });

    it('opens the session it was pointed at, on the root the runtime owns', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        const attached = await attachManagedSession(bootstrap(), Date.now());

        expect(attached.session.id).toBe(SESSION_ID);
        expect(attached.session.encryptionVariant).toBe('dataKey');
        // The path came out of the envelope's metadata as a `cloud://` URL and
        // is replaced by the one directory this runtime actually has.
        expect(attached.session.metadata.path).toBe(MANAGED_PROJECT_ROOT);
        expect(attached.session.metadataVersion).toBe(2);
        expect(attached.session.agentStateVersion).toBe(1);
        expect(attached.session.agentState).toEqual({ controlledByUser: false });
        // Exactly one call, and it is the lookup.
        expect(seen).toEqual(['POST /v2/sessions/lookup']);
    });

    it('creates nothing: no account auth, no machine, no session, no key', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        const encryption = await import('@/api/encryption');
        const randomSpy = vi.spyOn(encryption, 'getRandomBytes');
        try {
            await attachManagedSession(bootstrap(), Date.now());
        } finally {
            randomSpy.mockRestore();
        }
        // The only request that left this process.
        expect(seen).toEqual(['POST /v2/sessions/lookup']);
        expect(seen.some((s) => s.includes('/v1/sessions'))).toBe(false);
        expect(seen.some((s) => s.includes('/v1/machines'))).toBe(false);
        expect(seen.some((s) => s.includes('/v1/auth'))).toBe(false);
        expect(randomSpy).not.toHaveBeenCalled();
    });

    it('refuses when the id it was given is not the one and only record', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        for (const rows of [
            [],
            [sessionRow(), sessionRow({ id: 'sess-other' })],
            [sessionRow({ id: 'sess-other' })],
        ]) {
            lookupSessions = rows;
            await expect(attachManagedSession(bootstrap(), Date.now())).rejects.toThrow(/session/i);
        }
    });

    it('refuses a record whose wrapped key is not the one the key belongs to', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        lookupSessions = [sessionRow({
            dataEncryptionKey: encodeBase64(new Uint8Array(105).fill(8)),
        })];
        await expect(attachManagedSession(bootstrap(), Date.now())).rejects.toThrow(/key/i);
        // And it does not fall back to making a session it could open.
        expect(seen).toEqual(['POST /v2/sessions/lookup']);
    });

    it('refuses a record it cannot open with the key it was given', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        lookupSessions = [sessionRow({
            metadata: encodeBase64(encrypt(new Uint8Array(32).fill(1), 'dataKey', { path: '/x' })),
        })];
        await expect(attachManagedSession(bootstrap(), Date.now())).rejects.toThrow(/metadata/i);
    });

    it('says nothing about the bearer or the key when it refuses', async () => {
        const { attachManagedSession } = await import('@/managed/managedSessionAttach');
        lookupSessions = [];
        try {
            await attachManagedSession(bootstrap(), Date.now());
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(String(error)).not.toContain('scoped.bearer.value');
            expect(String(error)).not.toContain(encodeBase64(rawKey));
        }
    });

    it('sends the scoped bearer, and only to the origin it was given', async () => {
        const authorizations: Array<string | undefined> = [];
        const listener = (req: { headers: Record<string, unknown> }) =>
            authorizations.push(req.headers.authorization as string | undefined);
        server.on('request', listener as never);
        try {
            const { attachManagedSession } = await import('@/managed/managedSessionAttach');
            await attachManagedSession(bootstrap(), Date.now());
            expect(authorizations).toEqual(['Bearer scoped.bearer.value']);
        } finally {
            server.off('request', listener as never);
        }
    });
});
