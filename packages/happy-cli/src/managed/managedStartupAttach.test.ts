/**
 * What a managed startup does instead of starting.
 *
 * The ordinary path authenticates an account, registers a machine and creates
 * a session. A managed child does none of those: it is handed a session that
 * already exists and a bearer scoped to it. This drives the real startup
 * decision both agent entrypoints take, against a real server, and watches
 * what actually leaves the process.
 *
 * It does not claim anything about launching an agent process — no OS
 * execution happens here.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { openSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { encodeBase64, encrypt } from '@/api/encryption';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

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

const SESSION_ID = 'sess-managed-startup';
const rawKey = new Uint8Array(32).fill(7);
const wrappedKey = new Uint8Array(105).fill(9);

let server: Server;
let seen: string[] = [];

function envelopeJson(over: Record<string, unknown> = {}) {
    return JSON.stringify({
        version: 1,
        directory: MANAGED_PROJECT_ROOT,
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'b'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: serverUrl,
            sessionId: SESSION_ID,
            encryptionVariant: 'dataKey',
            rawKeyBase64: encodeBase64(rawKey),
            wrappedKeyBase64: encodeBase64(wrappedKey),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: {
            baseUrl: 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages',
            capability: 'cap-1',
            provider: 'anthropic',
            endpoint: 'anthropic-messages',
            model: 'claude-opus-5',
        },
        ...over,
    });
}

function anonymousFd(contents: string): number {
    const path = join(tmpdir(), `managed-startup-${randomUUID()}`);
    writeFileSync(path, contents, { mode: 0o600 });
    const fd = openSync(path, 'r');
    unlinkSync(path);
    return fd;
}

describe('a managed startup', () => {
    beforeAll(async () => {
        server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`);
            req.on('data', () => {});
            req.on('end', () => {
                if (req.url === '/v2/sessions/lookup') {
                    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
                        sessions: [{
                            id: SESSION_ID, seq: 3, metadataVersion: 2, agentStateVersion: 1,
                            dataEncryptionKey: encodeBase64(wrappedKey),
                            metadata: encodeBase64(encrypt(rawKey, 'dataKey', {
                                path: 'cloud://project-1/run-1', host: 'runtime', homeDir: '/root',
                                happyHomeDir: '/root/.happy', happyLibDir: '/root/.happy/lib',
                                happyToolsDir: '/root/.happy/tools',
                            })),
                            agentState: null,
                        }],
                    }));
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

    beforeEach(() => { seen = []; });

    it('is not started at all when nothing points at an envelope', async () => {
        const { readManagedStartup } = await import('@/managed/managedStartup');
        await expect(readManagedStartup({}, Date.now())).resolves.toBeNull();
        expect(seen).toEqual([]);
    });

    it('reads the envelope off the descriptor and consumes the variable', async () => {
        const { readManagedStartup } = await import('@/managed/managedStartup');
        const env: NodeJS.ProcessEnv = { HAPPY_MANAGED_BOOTSTRAP_FD: String(anonymousFd(envelopeJson())) };
        const startup = await readManagedStartup(env, Date.now());

        expect(startup).not.toBeNull();
        expect(startup!.envelope.agent).toBe('claude');
        expect(startup!.envelope.model).toBe('claude-opus-5');
        expect(startup!.envelope.effort).toBe('high');
        expect(startup!.envelope.initialPrompt).toBe('do the thing');
        expect(startup!.attachment.session.id).toBe(SESSION_ID);
        expect(startup!.attachment.session.metadata.path).toBe(MANAGED_PROJECT_ROOT);
        // Read once: a descriptor number left behind is an invitation to
        // re-read a descriptor that is now closed, or worse, a reused one.
        expect(env.HAPPY_MANAGED_BOOTSTRAP_FD).toBeUndefined();
        expect(seen).toEqual(['POST /v2/sessions/lookup']);
    });

    it('refuses a descriptor variable that is not a number, without looking anything up', async () => {
        const { readManagedStartup } = await import('@/managed/managedStartup');
        await expect(readManagedStartup({ HAPPY_MANAGED_BOOTSTRAP_FD: 'nine' }, Date.now()))
            .rejects.toThrow(/descriptor/i);
        expect(seen).toEqual([]);
    });

    it('gives the agent a client that cannot create anything', async () => {
        const { readManagedStartup } = await import('@/managed/managedStartup');
        const { ApiClient } = await import('@/api/api');
        const startup = await readManagedStartup(
            { HAPPY_MANAGED_BOOTSTRAP_FD: String(anonymousFd(envelopeJson())) }, Date.now(),
        );
        const api = ApiClient.managed(startup!.attachment);
        seen = [];

        await expect(api.getOrCreateSession({
            tag: 'x', metadata: {} as never, state: null,
        })).rejects.toThrow(/managed/i);
        await expect(api.getOrCreateMachine({
            machineId: 'm', metadata: {} as never,
        })).rejects.toThrow(/managed/i);
        // Refused in this process: nothing was attempted against the server.
        expect(seen).toEqual([]);
    });

    it('opens the session client on the scoped bearer and the envelope origin', async () => {
        const { readManagedStartup } = await import('@/managed/managedStartup');
        const { ApiClient } = await import('@/api/api');
        const startup = await readManagedStartup(
            { HAPPY_MANAGED_BOOTSTRAP_FD: String(anonymousFd(envelopeJson())) }, Date.now(),
        );
        const api = ApiClient.managed(startup!.attachment);
        const client = api.sessionSyncClient(startup!.attachment.session);
        try {
            expect(client.sessionId).toBe(SESSION_ID);
            // A managed client refuses to exist on any other origin, so its
            // existence is the assertion that the two agree.
            expect(client.getManagedOrigin()).toBe(new URL(serverUrl).origin);
        } finally {
            await client.close();
        }
    });

    it('makes the envelope the authority over anything the caller asked for', async () => {
        const { applyManagedInitialPrompt, stripAgentModelArguments } =
            await import('@/managed/managedStartup');
        const { readManagedStartup } = await import('@/managed/managedStartup');
        const startup = await readManagedStartup(
            { HAPPY_MANAGED_BOOTSTRAP_FD: String(anonymousFd(envelopeJson())) }, Date.now(),
        );

        // A launch environment carrying somebody else's prompt and model.
        const env: NodeJS.ProcessEnv = {
            HAPPY_INITIAL_PROMPT: 'a prompt from another launch',
            HAPPY_INITIAL_PROMPT_FILE: '/tmp/somebody-elses-prompt',
            HAPPY_INITIAL_PROMPT_LOCAL_ID: 'stale',
            HAPPY_INITIAL_MODEL: 'claude-cheap',
            HAPPY_INITIAL_EFFORT: 'low',
        };
        applyManagedInitialPrompt(env, startup!.envelope);

        expect(env.HAPPY_INITIAL_PROMPT).toBe('do the thing');
        expect(env.HAPPY_INITIAL_PROMPT_LOCAL_ID).toBe('b'.repeat(32));
        expect(env.HAPPY_INITIAL_MODEL).toBe('claude-opus-5');
        expect(env.HAPPY_INITIAL_EFFORT).toBe('high');
        // A staged file would otherwise win over the value just written.
        expect(env.HAPPY_INITIAL_PROMPT_FILE).toBeUndefined();
    });

    it('does not let a caller choose the model on the agent command line', async () => {
        const { stripAgentModelArguments } = await import('@/managed/managedStartup');
        // The agent CLI's own --model wins over the one this process selected,
        // so for a managed run it is a caller picking a model the run was not
        // priced for.
        expect(stripAgentModelArguments(['--model', 'claude-cheap', '--verbose']))
            .toEqual(['--verbose']);
        expect(stripAgentModelArguments(['-m', 'claude-cheap'])).toEqual([]);
        expect(stripAgentModelArguments(['--model=claude-cheap', '-p'])).toEqual(['-p']);
        expect(stripAgentModelArguments(undefined)).toBeUndefined();
        expect(stripAgentModelArguments(['--verbose'])).toEqual(['--verbose']);
    });

    it('will not fall back to a new session when the server has none', async () => {
        const { resolveManagedOfflineFallback } = await import('@/managed/managedStartup');
        expect(() => resolveManagedOfflineFallback(true)).toThrow(/managed/i);
        expect(() => resolveManagedOfflineFallback(false)).not.toThrow();
    });
});
