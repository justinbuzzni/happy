import { describe, expect, it } from 'vitest';

import { applyManagedProviderPlan, sanitizeProviderFailure } from './providerEntry';
import { planProviderLaunch } from './providerLaunch';

const PLAN = planProviderLaunch({
    agent: 'claude',
    model: 'claude-sonnet-5',
    brokerUrl: 'http://127.0.0.1:8731/',
    brokerToken: 'run-grant-token',
    brokerTools: ['read_file'],
    providerEnv: { PATH: '/usr/bin' },
});

describe('binding the plan into the existing claude run options', () => {
    it('replaces the boundary-bearing options and leaves the rest alone', () => {
        const existing = {
            mcpServers: { aplus: { type: 'http', url: 'https://elsewhere' } },
            allowedTools: ['Bash'],
            permissionMode: 'bypassPermissions',
            disallowedTools: ['Write'],
            hookSettingsPath: '/tmp/hooks.json',
        };
        const bound = applyManagedProviderPlan(existing, PLAN.env);
        // 경계를 정하는 것들은 계획이 이긴다.
        expect(bound.mcpServers).toEqual(PLAN.sdkOptions!.mcpServers);
        expect(bound.allowedTools).toEqual(PLAN.sdkOptions!.allowedTools);
        expect(bound.permissionMode).toBe('default');
        expect(bound.settingSources).toEqual([]);
        expect(bound.tools).toEqual([]);
        expect(bound.model).toBe('claude-sonnet-5');
        // 경계와 무관한 것은 그대로 둔다 — 기존 경로를 재설계하지 않는다.
        expect(bound.hookSettingsPath).toBe('/tmp/hooks.json');
        expect(bound.disallowedTools).toEqual(['Write']);
    });

    it('refuses to bind when the environment carries no plan', () => {
        expect(() => applyManagedProviderPlan({}, {})).toThrow(/no sdk options/);
    });
});

describe('provider failures carry no credentials', () => {
    it('redacts before the message leaves the process', () => {
        const detail = sanitizeProviderFailure(
            new Error('request failed: authorization: Bearer sk-live-abcdefghijklmnop token=hunter2'),
        );
        expect(detail).not.toContain('sk-live-abcdefghijklmnop');
        expect(detail).not.toContain('hunter2');
        expect(detail).toContain('[REDACTED]');
    });
});
