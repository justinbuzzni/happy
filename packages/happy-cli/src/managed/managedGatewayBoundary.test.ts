/**
 * Where the approved gateway actually has to hold.
 *
 * Three things decide whether a managed run spends only its own capability:
 * the URL the SDK ends up calling, the provider the agent CLI is configured
 * with, and whether anything on the machine can substitute a different account
 * on the way. All three are properties of the agent's real configuration, not
 * of the envelope we parsed.
 */
import { describe, it, expect } from 'vitest';

import {
    managedClaudeGatewayBaseUrl,
    managedCodexProviderArguments,
    applyManagedGatewayEnvironment,
} from '@/managed/managedStartup';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

const SAYCODE = 'https://studio.example.test';

function envelope(agent: 'claude' | 'codex'): ManagedSpawnEnvelope {
    const claude = agent === 'claude';
    return {
        directory: '/workspace/project',
        agent,
        model: claude ? 'claude-opus-5' : 'gpt-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
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
            baseUrl: claude
                ? `${SAYCODE}/api/cloud/gateway/anthropic/v1/messages`
                : `${SAYCODE}/api/cloud/gateway/openai/v1/responses`,
            capability: 'capability-for-this-run',
            provider: claude ? 'anthropic' : 'openai',
            endpoint: claude ? 'anthropic-messages' : 'openai-responses',
            model: claude ? 'claude-opus-5' : 'gpt-5',
        },
    };
}

describe('the base URL each SDK is given', () => {
    it('stops where the Anthropic SDK starts appending', () => {
        // `client.js` builds `new URL(baseURL + path)` with path `/v1/messages`
        // (`resources/messages/messages.js:35`). Handing it the full endpoint
        // produces `/anthropic/v1/messages/v1/messages`, which is not a route.
        const base = managedClaudeGatewayBaseUrl(envelope('claude'));
        expect(base).toBe(`${SAYCODE}/api/cloud/gateway/anthropic`);
        expect(`${base}/v1/messages`).toBe(envelope('claude').gateway.baseUrl);
    });

    it('stops where the Codex provider starts appending', () => {
        // The Codex provider appends `/responses` to `base_url`.
        const args = managedCodexProviderArguments(envelope('codex'));
        const baseUrl = args[args.indexOf('-c') + 1];
        expect(args).toContain(`model_providers.saycode-managed.base_url="${SAYCODE}/api/cloud/gateway/openai/v1"`);
        expect(baseUrl).toBeDefined();
    });

    it('refuses an endpoint that is not the route this agent was approved for', () => {
        const crossed = envelope('claude');
        crossed.gateway.baseUrl = `${SAYCODE}/api/cloud/gateway/openai/v1/responses`;
        expect(() => managedClaudeGatewayBaseUrl(crossed)).toThrow(/gateway/i);
    });
});

describe('the provider the Codex CLI is configured with', () => {
    it('is pinned as whole configuration, not left to whatever is on disk', () => {
        const args = managedCodexProviderArguments(envelope('codex'));
        // Every axis the CLI would otherwise take from the user's config file.
        expect(args).toContain('model_providers.saycode-managed.env_key="OPENAI_API_KEY"');
        expect(args).toContain('model_providers.saycode-managed.wire_api="responses"');
        expect(args).toContain('model_providers.saycode-managed.requires_openai_auth=false');
        expect(args).toContain('model_provider="saycode-managed"');
    });

    it('carries the capability in the environment the provider reads', () => {
        const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'someone-elses-key' };
        applyManagedGatewayEnvironment(env, envelope('codex'));
        expect(env.OPENAI_API_KEY).toBe('capability-for-this-run');
        expect(env.OPENAI_BASE_URL).toBe(`${SAYCODE}/api/cloud/gateway/openai/v1`);
    });
});
