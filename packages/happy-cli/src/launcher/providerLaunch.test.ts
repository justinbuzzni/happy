import { describe, expect, it } from 'vitest';

import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

import { planProviderLaunch, readProviderCodexArgs, readProviderSdkOptions } from './providerLaunch';

const BROKER = 'http://127.0.0.1:8731';

describe('provider launch plan (the API B3 consumes)', () => {
    it('always starts in the runtime project root — the caller cannot pick it', () => {
        for (const agent of ['claude', 'codex'] as const) {
            const plan = planProviderLaunch({
                model: 'claude-sonnet-5',
                brokerToken: 'run-grant-token',
                agent, brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
                codexHome: '/run/saycode/codex',
            });
            expect(plan.cwd).toBe(MANAGED_PROJECT_ROOT);
            expect(plan.cwd).toBe('/workspace/project');
        }
    });

    it('claude gets no built-in tools and exactly one trusted broker', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
        });
        expect(plan.sdkOptions?.tools).toEqual([]);
        expect(Object.values(plan.sdkOptions?.mcpServers ?? {})).toEqual([{
            type: 'http',
            url: BROKER,
            // 자격 없이 넘기면 broker 가 `tools/list` 부터 거부한다.
            headers: { authorization: 'Bearer run-grant-token' },
        }]);
        expect(plan.args).toEqual([]);
    });

    it('carries this run\'s gateway capability into the provider', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER,
            providerEnv: {
                PATH: '/usr/bin',
                ANTHROPIC_BASE_URL: 'https://happy.example/api/cloud/gateway/anthropic',
                ANTHROPIC_AUTH_TOKEN: 'capability-for-this-run',
            },
        });
        expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe('capability-for-this-run');
    });

    it('refuses credentials that were not minted for this run', () => {
        expect(() => planProviderLaunch({
            model: 'claude-sonnet-5',
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER,
            providerEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'someone-elses' },
        })).toThrow(/must not carry/);
    });

    it('codex gets a run-private CODEX_HOME and a read-only environments file', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            brokerToken: 'run-grant-token',
            agent: 'codex', brokerUrl: BROKER,
            providerEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'capability-for-this-run' },
            codexHome: '/run/saycode/codex',
        });
        expect(plan.env.CODEX_HOME).toBe('/run/saycode/codex');
        expect(plan.env.OPENAI_API_KEY).toBe('capability-for-this-run');
        expect(plan.files).toHaveLength(1);
        expect(plan.files[0]!.path).toBe('/run/saycode/codex/environments.toml');
        expect(plan.files[0]!.contents).toContain('environments = []');
        // provider 가 자기 정책을 다시 쓸 수 있으면 정책이 아니다.
        expect(plan.files[0]!.mode).toBe(0o444);
    });

    it('codex without a run-private home is refused', () => {
        expect(() => planProviderLaunch({
            model: 'claude-sonnet-5',
            brokerToken: 'run-grant-token',
            agent: 'codex', brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
        })).toThrow(/run-private codexHome/);
    });

    it('the broker must be on loopback for either agent', () => {
        for (const agent of ['claude', 'codex'] as const) {
            expect(() => planProviderLaunch({
                model: 'claude-sonnet-5',
                brokerToken: 'run-grant-token',
                agent, brokerUrl: 'https://example.com',
                providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/saycode/codex',
            })).toThrow();
        }
    });
});

describe('the plan carries its own SDK options', () => {
    it('binds the claude sdk options into the provider environment', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        // 실행 경계에서 계획과 옵션이 갈라지면 안 된다. 옵션은 계획의 env 에
        // 실려 그 프로세스에만 간다 — 바깥에서 채워 넣을 자리를 남기지 않는다.
        expect(JSON.parse(plan.env.SAYCODE_PROVIDER_SDK_OPTIONS)).toEqual(plan.sdkOptions);
    });

    it('does not put SDK options into a codex environment', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            agent: 'codex', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/codex',
        });
        expect(plan.sdkOptions).toBeNull();
        expect(plan.env.SAYCODE_PROVIDER_SDK_OPTIONS).toBeUndefined();
    });
});

describe('reading the plan’s sdk options back', () => {
    it('returns exactly what the plan put there', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        expect(readProviderSdkOptions(plan.env)).toEqual(plan.sdkOptions);
    });

    it('refuses an environment that carries no options or a broken one', () => {
        expect(() => readProviderSdkOptions({})).toThrow(/no sdk options/);
        expect(() => readProviderSdkOptions({ SAYCODE_PROVIDER_SDK_OPTIONS: 'not json' }))
            .toThrow(/unreadable/);
    });

    it('refuses options that lost the boundary', () => {
        const plan = planProviderLaunch({
            model: 'claude-sonnet-5',
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        for (const broken of [
            { ...plan.sdkOptions, tools: ['Bash'] },
            { ...plan.sdkOptions, permissionMode: 'bypassPermissions' },
            { ...plan.sdkOptions, settingSources: ['user'] },
            { ...plan.sdkOptions, mcpServers: {} },
            { ...plan.sdkOptions, allowedTools: [] },
        ]) {
            expect(() => readProviderSdkOptions({
                SAYCODE_PROVIDER_SDK_OPTIONS: JSON.stringify(broken),
            })).toThrow();
        }
    });
});

describe('the run’s effort travels with the plan', () => {
    it('puts an explicit effort into the sdk options and codex config', () => {
        const claude = planProviderLaunch({
            agent: 'claude', model: 'claude-opus-5', effort: 'max',
            brokerUrl: BROKER, brokerToken: 'run-grant-token', brokerTools: ['read_file'],
            providerEnv: { PATH: '/usr/bin' },
        });
        expect(claude.sdkOptions?.effort).toBe('max');
        expect(JSON.parse(claude.env.SAYCODE_PROVIDER_SDK_OPTIONS).effort).toBe('max');

        const codex = planProviderLaunch({
            agent: 'codex', model: 'gpt-6-astra', effort: 'low',
            brokerUrl: BROKER, brokerToken: 'run-grant-token',
            providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/codex',
        });
        // 설치본 0.153.4 의 키. 이름을 지어내지 않았다.
        expect(codex.args).toContain('model_reasoning_effort="low"');
    });

    it('leaves the provider default alone when the run chose none', () => {
        for (const effort of ['none', undefined] as const) {
            const claude = planProviderLaunch({
                agent: 'claude', model: 'claude-opus-5', effort,
                brokerUrl: BROKER, brokerToken: 'run-grant-token', brokerTools: ['read_file'],
                providerEnv: { PATH: '/usr/bin' },
            });
            expect('effort' in (claude.sdkOptions ?? {})).toBe(false);
            const codex = planProviderLaunch({
                agent: 'codex', model: 'gpt-6-astra', effort,
                brokerUrl: BROKER, brokerToken: 'run-grant-token',
                providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/codex',
            });
            expect(codex.args.join(' ')).not.toContain('model_reasoning_effort');
        }
    });

    it('refuses to read back options with an effort the SDK does not have', () => {
        const plan = planProviderLaunch({
            agent: 'claude', model: 'claude-opus-5', effort: 'high',
            brokerUrl: BROKER, brokerToken: 'run-grant-token', brokerTools: ['read_file'],
            providerEnv: { PATH: '/usr/bin' },
        });
        expect(() => readProviderSdkOptions({
            SAYCODE_PROVIDER_SDK_OPTIONS: JSON.stringify({ ...plan.sdkOptions, effort: 'ultra' }),
        })).toThrow(/effort/);
    });
});

describe('reading codex arguments back is a structural check', () => {
    const PLANNED = planProviderLaunch({
        agent: 'codex', model: 'gpt-6-astra', effort: 'low',
        brokerUrl: 'http://127.0.0.1:8731/', brokerToken: 'run-grant-token',
        providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/codex',
    }).args;

    const read = (args: string[]) => readProviderCodexArgs({
        SAYCODE_PROVIDER_CODEX_ARGS: JSON.stringify(args),
    });

    it('accepts exactly what the plan generates', () => {
        expect(read(PLANNED)).toEqual(PLANNED);
    });

    it('refuses arguments with the feature disables stripped', () => {
        // 문자열로 broker 만 보면 `--disable` 을 전부 지운 인자가 통과한다.
        const withoutDisables = PLANNED.filter((entry, index) =>
            entry !== '--disable' && PLANNED[index - 1] !== '--disable');
        expect(() => read(withoutDisables)).toThrow(/not the ones this run planned/);
    });

    it('refuses a single missing disable', () => {
        for (const feature of ['hooks', 'plugins', 'multi_agent', 'multi_agent_v2']) {
            const index = PLANNED.indexOf(feature);
            const missing = PLANNED.filter((_, at) => at !== index && at !== index - 1);
            expect(() => read(missing)).toThrow(/not the ones this run planned/);
        }
    });

    it('refuses anything the plan did not generate', () => {
        for (const extra of [
            ['-c', 'features.hooks=true'],
            ['-c', 'mcp_servers.other.url="http://127.0.0.1:9/"'],
            ['--dangerously-bypass-approvals-and-sandbox'],
            ['-c', 'model_reasoning_effort="max"'],
        ]) {
            // 뒤에 붙은 값이 앞의 결정을 뒤집을 수 있으므로, 계획 밖의 인자는 전부 거부한다.
            expect(() => read([...PLANNED, ...extra])).toThrow();
        }
    });

    it('refuses a duplicated broker registration', () => {
        const duplicated = [...PLANNED, '-c', 'mcp_servers.saycode.url="http://127.0.0.1:9999/"'];
        expect(() => read(duplicated)).toThrow();
    });
});
