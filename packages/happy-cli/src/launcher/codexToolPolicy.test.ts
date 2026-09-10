import { describe, expect, it } from 'vitest';

import { DISABLED_CODEX_FEATURES, buildCodexToolPolicy } from './codexToolPolicy';

const BASE = {
    codexHome: '/run/saycode/codex-home',
    brokerUrl: 'http://127.0.0.1:8731',
    brokerToken: 'run-grant-token',
    env: { PATH: '/usr/bin' },
};

describe('codex tool policy', () => {
    it('registers no local execution environment', () => {
        const policy = buildCodexToolPolicy(BASE);
        expect(policy.environmentsToml).toContain('include_local = false');
        // 시퀀스여야 한다. 테이블이면 설치본이 파싱을 거부한다(0.153.4 실측).
        expect(policy.environmentsToml).toContain('environments = []');
        expect(policy.environmentsToml).not.toContain('[environments]');
        // 등록된 environment 가 하나도 없어야 한다.
        expect(policy.environmentsToml).not.toMatch(/^\s*id\s*=/m);
        expect(policy.environmentsToml).not.toMatch(/\[environments\.[A-Za-z0-9_-]+\]/);
    });

    it('disables the features that widen the tool surface', () => {
        const args = buildCodexToolPolicy(BASE).args;
        for (const feature of DISABLED_CODEX_FEATURES) {
            const index = args.indexOf(feature);
            expect(index).toBeGreaterThan(0);
            expect(args[index - 1]).toBe('--disable');
        }
        expect([...DISABLED_CODEX_FEATURES])
            .toEqual(['hooks', 'plugins', 'multi_agent', 'multi_agent_v2']);
    });

    it('does not rely on apply_patch_freeform, which upstream removed', () => {
        const policy = buildCodexToolPolicy(BASE);
        expect(policy.args.join(' ')).not.toContain('apply_patch_freeform');
        expect(policy.environmentsToml).not.toContain('apply_patch_freeform');
    });

    it('points CODEX_HOME at this run only', () => {
        expect(buildCodexToolPolicy(BASE).env.CODEX_HOME).toBe('/run/saycode/codex-home');
        expect(() => buildCodexToolPolicy({ ...BASE, codexHome: 'relative/home' }))
            .toThrow(/absolute path/);
    });

    it('registers exactly one MCP server and it is on loopback', () => {
        const args = buildCodexToolPolicy(BASE).args;
        // 서버는 하나뿐이다. 그 서버에 붙는 키(url, bearer_token_env_var)는 여럿이다.
        const mcp = args.filter((arg) => arg.includes('mcp_servers.'));
        const servers = new Set(mcp.map((arg) => arg.split('.')[1]));
        expect([...servers]).toEqual(['saycode']);
        expect(mcp).toContain('mcp_servers.saycode.url="http://127.0.0.1:8731"');
        for (const brokerUrl of ['https://example.com', 'http://10.0.0.5:1', 'http://u:p@127.0.0.1:1']) {
            expect(() => buildCodexToolPolicy({ ...BASE, brokerUrl })).toThrow();
        }
    });

    it('keeps the approved gateway credential — codex reads it via env_key', () => {
        const env = { PATH: '/usr/bin', OPENAI_API_KEY: 'capability-for-this-run' };
        expect(buildCodexToolPolicy({ ...BASE, env }).env)
            .toMatchObject({ OPENAI_API_KEY: 'capability-for-this-run' });
    });

    it('refuses credentials that were not minted for this run or paths the caller must not pick', () => {
        for (const key of ['ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN', 'HAPPY_MANAGED_X']) {
            expect(() => buildCodexToolPolicy({ ...BASE, env: { ...BASE.env, [key]: 'x' } }))
                .toThrow(/provider env must not carry/);
        }
        // 호출부가 CODEX_HOME 을 스스로 정하지 못한다.
        expect(() => buildCodexToolPolicy({ ...BASE, env: { ...BASE.env, CODEX_HOME: '/elsewhere' } }))
            .toThrow(/provider env must not carry/);
    });
});

describe('broker credential', () => {
    it('passes this run’s bearer through the env var the installed binary supports', () => {
        const policy = buildCodexToolPolicy({
            codexHome: '/run/codex-home',
            brokerUrl: 'http://127.0.0.1:8731/',
            brokerToken: 'run-grant-token',
            env: { PATH: '/usr/bin' },
        });
        // 설치본 0.153.4 의 `RawMcpServerConfig` 는 `bearer_token_env_var` 를 갖고,
        // `bearer_token` 은 "unsupported" 로 거부된다. 그래서 환경변수 경유다.
        expect(policy.args).toContain('mcp_servers.saycode.bearer_token_env_var="SAYCODE_BROKER_TOKEN"');
        expect(policy.env.SAYCODE_BROKER_TOKEN).toBe('run-grant-token');
        expect(policy.args.join(' ')).not.toContain('run-grant-token');
    });

    it('refuses to build a policy without a broker token', () => {
        expect(() => buildCodexToolPolicy({
            codexHome: '/run/codex-home', brokerUrl: 'http://127.0.0.1:8731/',
            brokerToken: '  ', env: {},
        })).toThrow(/broker token/);
    });
});
