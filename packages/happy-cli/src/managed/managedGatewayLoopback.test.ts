/**
 * The request the installed SDK actually makes.
 *
 * Everything else about the gateway is a rule about strings: that a base plus
 * a suffix equals a route, that a key is in the right variable. What decides
 * whether a managed run spends its own capability is the HTTP request that
 * leaves the process, so this makes one — with the SDK this repository has
 * installed, against a server that records what arrives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';

import { applyManagedGatewayEnvironment } from '@/managed/managedStartup';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

type Received = { method: string; url: string; headers: Record<string, string>; body: string };

let server: Server;
let origin = '';
let received: Received[] = [];

function envelope(agent: 'claude' | 'codex'): ManagedSpawnEnvelope {
    const claude = agent === 'claude';
    return {
        directory: '/workspace/project',
        agent,
        model: claude ? 'claude-opus-5' : 'gpt-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'e'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: {
            // A loopback origin, so the route below is one this test can serve.
            baseUrl: claude
                ? `${origin}/api/cloud/gateway/anthropic/v1/messages`
                : `${origin}/api/cloud/gateway/openai/v1/responses`,
            capability: 'capability-for-this-run',
            provider: claude ? 'anthropic' : 'openai',
            endpoint: claude ? 'anthropic-messages' : 'openai-responses',
            model: claude ? 'claude-opus-5' : 'gpt-5',
        },
    };
}

describe('what the installed SDK sends when a managed run is configured', () => {
    beforeAll(async () => {
        server = createServer((request: IncomingMessage, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                received.push({
                    method: request.method ?? '',
                    url: request.url ?? '',
                    headers: request.headers as Record<string, string>,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
                    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
                    content: [{ type: 'text', text: 'ok' }],
                    stop_reason: 'end_turn', stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                }));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('reaches the approved route exactly once, with the capability and no other key', async () => {
        received = [];
        const env: NodeJS.ProcessEnv = {
            // What an ordinary machine would have lying around.
            ANTHROPIC_API_KEY: 'someone-elses-key',
            CLAUDE_CODE_OAUTH_TOKEN: 'someone-elses-oauth',
        };
        applyManagedGatewayEnvironment(env, envelope('claude'));

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        // Constructed exactly the way the agent constructs it: from the
        // environment this startup produced, with nothing passed in.
        const client = new Anthropic({
            baseURL: env.ANTHROPIC_BASE_URL,
            authToken: env.ANTHROPIC_AUTH_TOKEN,
            apiKey: env.ANTHROPIC_API_KEY ?? null,
            maxRetries: 0,
        });
        await client.messages.create({
            model: 'claude-opus-5',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'do the thing' }],
        });

        expect(received).toHaveLength(1);
        const [call] = received;
        // The whole point: not `/anthropic/v1/messages/v1/messages`.
        expect(call.url).toBe('/api/cloud/gateway/anthropic/v1/messages');
        expect(call.method).toBe('POST');
        expect(JSON.parse(call.body).model).toBe('claude-opus-5');

        // The capability, and nothing that came off this machine.
        expect(call.headers.authorization).toBe('Bearer capability-for-this-run');
        expect(call.headers['x-api-key']).toBeUndefined();
        const rendered = JSON.stringify(call.headers);
        expect(rendered).not.toContain('someone-elses-key');
        expect(rendered).not.toContain('someone-elses-oauth');
    }, 30_000);

    it('would have missed the route if handed the whole endpoint', async () => {
        received = [];
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        // The defect this derivation exists to prevent, stated as an observed
        // request rather than as a rule about string concatenation.
        const client = new Anthropic({
            baseURL: envelope('claude').gateway.baseUrl,
            authToken: 'capability-for-this-run',
            apiKey: null,
            maxRetries: 0,
        });
        await client.messages.create({
            model: 'claude-opus-5',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'do the thing' }],
        });

        expect(received[0].url).toBe('/api/cloud/gateway/anthropic/v1/messages/v1/messages');
    }, 30_000);

    it('sends the Codex provider base to the responses route', async () => {
        received = [];
        const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'another-accounts-key' };
        applyManagedGatewayEnvironment(env, envelope('codex'));

        // The Codex provider appends `/responses` to `base_url`; this is that
        // request, made against the base the startup produced.
        const response = await fetch(`${env.OPENAI_BASE_URL}/responses`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.OPENAI_API_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'gpt-5', input: 'do the thing' }),
        });
        expect(response.status).toBe(200);
        expect(received).toHaveLength(1);
        expect(received[0].url).toBe('/api/cloud/gateway/openai/v1/responses');
        expect(received[0].headers.authorization).toBe('Bearer capability-for-this-run');
    }, 30_000);
});
