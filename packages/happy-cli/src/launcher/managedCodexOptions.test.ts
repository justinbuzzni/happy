import { describe, expect, it } from 'vitest';

import { resolveManagedCodexArguments } from './managedCodexOptions';
import { planProviderLaunch } from './providerLaunch';

const PLAN = planProviderLaunch({
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'low',
    brokerUrl: 'http://127.0.0.1:8731/',
    brokerToken: 'run-grant-token',
    providerEnv: { PATH: '/usr/bin' },
    codexHome: '/run/codex-home',
});

/** B2 가 이미 정하는 provider 고정 인자. 우리 것과 함께 가야 한다. */
const B2_ARGS = ['-c', 'model_providers.saycode.base_url="https://gw.example"', '-c', 'model_provider="saycode"'];

describe('managed codex arguments', () => {
    it('leaves a BYOS run alone', () => {
        expect(resolveManagedCodexArguments({ managed: false, env: {}, base: null })).toBeNull();
        expect(resolveManagedCodexArguments({ managed: false, env: {}, base: B2_ARGS })).toEqual(B2_ARGS);
    });

    it('keeps the B2 provider pinning and adds this run’s boundary', () => {
        const args = resolveManagedCodexArguments({ managed: true, env: PLAN.env, base: B2_ARGS });
        // B2 가 정한 것은 그대로 남는다.
        for (const entry of B2_ARGS) expect(args).toContain(entry);
        // 그리고 계획의 경계가 함께 간다.
        expect(args!.join(' ')).toContain('mcp_servers.saycode.url=');
        expect(args!.join(' ')).toContain('mcp_servers.saycode.bearer_token_env_var=');
        expect(args!.join(' ')).toContain('model_reasoning_effort="low"');
        expect(args!.filter((entry) => entry === '--disable')).toHaveLength(4);
    });

    it('fails closed when a managed run has no verified plan', () => {
        for (const env of [{}, { SAYCODE_PROVIDER_CODEX_ARGS: 'not json' }]) {
            expect(() => resolveManagedCodexArguments({ managed: true, env, base: B2_ARGS }))
                .toThrow(/managed run/);
        }
    });

    it('fails closed when the plan lost the broker', () => {
        expect(() => resolveManagedCodexArguments({
            managed: true,
            env: { SAYCODE_PROVIDER_CODEX_ARGS: JSON.stringify(['--disable', 'hooks']) },
            base: B2_ARGS,
        })).toThrow(/managed run/);
    });
});
