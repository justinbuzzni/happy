import { describe, expect, it } from 'vitest';

import { bindManagedQueryOptions, resolveManagedClaudeOptions } from './managedClaudeOptions';
import { planProviderLaunch } from './providerLaunch';

const PLAN = planProviderLaunch({
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'low',
    brokerUrl: 'http://127.0.0.1:8731/',
    brokerToken: 'run-grant-token',
    brokerTools: ['read_file'],
    providerEnv: { PATH: '/usr/bin' },
});

/** BYOS 실행이 지금 쓰는 옵션 모양. 관리 실행이 아니면 그대로여야 한다. */
const BYOS_OPTIONS = {
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits' as const,
    allowedTools: ['mcp__happy__read'],
    mcpServers: { happy: { type: 'http', url: 'https://happy.example' } },
    disallowedTools: ['Write'],
};

describe('managed claude options', () => {
    it('leaves a BYOS run exactly as it was', () => {
        // 관리 실행이 아니면 이 코드는 아무것도 바꾸지 않는다.
        expect(resolveManagedClaudeOptions({ managed: false, env: {}, options: BYOS_OPTIONS }))
            .toEqual(BYOS_OPTIONS);
    });

    it('replaces the boundary options in a managed run', () => {
        // 관리 실행에서 runner 의 모델은 봉투의 모델(= 계획과 같다).
        const bound = resolveManagedClaudeOptions({
            managed: true, env: PLAN.env, options: { ...BYOS_OPTIONS, model: 'claude-opus-5' },
        });
        expect(bound.tools).toEqual([]);
        expect(bound.mcpServers).toEqual(PLAN.sdkOptions!.mcpServers);
        expect(bound.allowedTools).toEqual(['mcp__saycode-broker__read_file']);
        expect(bound.permissionMode).toBe('default');
        expect(bound.settingSources).toEqual([]);
        // run 이 확정한 모델·effort 가 이긴다. BYOS 기본값이 남으면 gateway 가 거절한다.
        expect(bound.model).toBe('claude-opus-5');
        expect(bound.effort).toBe('low');
        // 경계와 무관한 것은 그대로 둔다.
        expect(bound.disallowedTools).toEqual(['Write']);
    });

    it('fails closed when a managed run has no verified plan', () => {
        // 계획이 없으면 **기존 동작으로 되돌아가지 않는다** — 내장 도구가 열린 채
        // 도는 것이 그 fallback 의 뜻이기 때문이다.
        for (const env of [{}, { SAYCODE_PROVIDER_SDK_OPTIONS: 'not json' }]) {
            expect(() => resolveManagedClaudeOptions({ managed: true, env, options: BYOS_OPTIONS }))
                .toThrow(/managed run/);
        }
    });

    it('fails closed when the plan lost its boundary', () => {
        const broken = JSON.stringify({ ...PLAN.sdkOptions, tools: ['Bash'] });
        expect(() => resolveManagedClaudeOptions({
            managed: true, env: { SAYCODE_PROVIDER_SDK_OPTIONS: broken }, options: BYOS_OPTIONS,
        })).toThrow(/managed run/);
    });
});

/**
 * 마지막 소비 경계. `claudeRemote` 가 `query` 를 부르기 직전의 옵션 객체이며,
 * 여기서 덮이지 않은 값은 그대로 SDK 로 간다.
 */
const SDK_SHAPED = {
    cwd: '/workspace/project',
    model: 'claude-sonnet-5',
    effort: 'high' as const,
    permissionMode: 'bypassPermissions' as const,
    allowedTools: ['Bash', 'mcp__happy__read'],
    disallowedTools: ['Write'],
    mcpServers: { happy: { type: 'http', url: 'https://happy.example' }, aplus: { type: 'http', url: 'https://aplus.example' } },
    settingSources: ['user'],
    settingsPath: '/tmp/hooks.json',
};

describe('binding at the last consumption boundary', () => {
    it('leaves a BYOS query exactly as assembled', () => {
        expect(bindManagedQueryOptions(SDK_SHAPED, { managed: false, env: {} })).toEqual(SDK_SHAPED);
    });

    it('replaces every boundary field right before the SDK call', () => {
        // 관리 실행에서 runner 가 들고 오는 모델은 봉투의 모델이다(= 계획과 같아야 한다).
        const bound = bindManagedQueryOptions(
            { ...SDK_SHAPED, model: 'claude-opus-5' }, { managed: true, env: PLAN.env });
        // 내장 도구는 여기서만 꺼진다 — 중간 계층에는 이 자리가 없다.
        expect(bound.tools).toEqual([]);
        // 기존 경로가 병합해 둔 happy/aplus 서버는 남지 않는다.
        expect(bound.mcpServers).toEqual(PLAN.sdkOptions!.mcpServers);
        expect(bound.allowedTools).toEqual(['mcp__saycode-broker__read_file']);
        expect(bound.permissionMode).toBe('default');
        expect(bound.settingSources).toEqual([]);
        expect(bound.model).toBe('claude-opus-5');
        expect(bound.effort).toBe('low');
        // 경계와 무관한 것은 유지된다.
        expect(bound.settingsPath).toBe('/tmp/hooks.json');
        expect(bound.disallowedTools).toEqual(['Write']);
        expect(bound.cwd).toBe('/workspace/project');
    });

    it('fails closed in a managed run without a verified plan', () => {
        for (const env of [{}, { SAYCODE_PROVIDER_SDK_OPTIONS: 'not json' }]) {
            expect(() => bindManagedQueryOptions(SDK_SHAPED, { managed: true, env }))
                .toThrow(/managed run/);
        }
    });
});

describe('the plan must agree with what the runner was told', () => {
    it('fails closed when the runner carries a different model than the plan', () => {
        // 봉투(가격·승인)와 계획이 갈라지면 한 모델로 청구하고 다른 모델을 돌린다.
        expect(() => bindManagedQueryOptions(
            { ...SDK_SHAPED, model: 'claude-sonnet-5' }, { managed: true, env: PLAN.env },
        )).toThrow(/model/);
    });

    it('accepts a runner that carries no model of its own', () => {
        const bound = bindManagedQueryOptions(
            { ...SDK_SHAPED, model: undefined }, { managed: true, env: PLAN.env });
        expect(bound.model).toBe('claude-opus-5');
    });
});

describe('nothing survives that the plan did not choose', () => {
    const NO_EFFORT_PLAN = planProviderLaunch({
        agent: 'claude', model: 'claude-opus-5', effort: 'none',
        brokerUrl: 'http://127.0.0.1:8731/', brokerToken: 'run-grant-token',
        brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
    });

    it('removes an inherited effort when the run chose none', () => {
        const bound = bindManagedQueryOptions(
            { ...SDK_SHAPED, model: 'claude-opus-5', effort: 'high' as const },
            { managed: true, env: NO_EFFORT_PLAN.env },
        );
        // provider 기본값을 쓰라는 뜻이지, 앞 실행의 high 를 물려받으라는 뜻이 아니다.
        expect(bound.effort).toBeUndefined();
        expect('effort' in bound).toBe(true);
    });

    it('removes a fallback model — a managed run never switches models silently', () => {
        const bound = bindManagedQueryOptions(
            { ...SDK_SHAPED, model: 'claude-opus-5', fallbackModel: 'claude-haiku-4-5' },
            { managed: true, env: PLAN.env },
        );
        expect(bound.fallbackModel).toBeUndefined();
    });
});
