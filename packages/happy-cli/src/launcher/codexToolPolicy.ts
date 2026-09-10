/**
 * specs/managed-cloud-byos P4 — Codex provider 의 도구 경계.
 *
 * Claude 와 달리 "내장 도구를 전부 끈다" 는 SDK 옵션이 없다. 대신 도구가
 * **어디서 실행될지**를 정하는 environment 를 없앤다: local environment 가
 * 없으면 shell/exec/apply_patch/view_image 가 등록될 자리가 없고, MCP 는
 * 별도로 등록된다.
 *
 * 근거는 **설치본 `codex-cli 0.153.4` 바이너리에서 실제로 확인한 것만** 쓴다:
 *  - `EnvironmentsToml` 이 `default`, `include_local`, `environments` 를 가진다
 *  - `EnvironmentToml` 이 `id/url/program/args/env/cwd/...` 를 가진다
 *  - 파일 이름은 `environments.toml`, 오류 문구 `default environment id cannot be empty`
 *  - `-c key=value` 로 `~/.codex/config.toml` 값을 덮어쓴다 (`codex --help`)
 *  - `--disable <FEATURE>` 는 `-c features.<name>=false` 와 같다 (`codex --help`)
 *
 * **여기서 만드는 것은 설정뿐이다.** 이 설정이 실제로 도구 등록을 막는지는 이
 * 파일이 증명하지 못한다 — `verify-p4-tools.sh` 의 적대적 fixture 가 판정한다.
 * 특히 `apply_patch_freeform` 플래그는 상류에서 제거됐으므로 `false` 로 두는
 * 것을 근거로 삼지 않는다.
 */

/** `--disable` 로 끄는 것들. 각각 `features.<name>` 이다. */
export const DISABLED_CODEX_FEATURES = [
    'hooks',
    'plugins',
    'multi_agent',
    'multi_agent_v2',
] as const;

export type CodexToolPolicyInput = {
    /** 이 실행 전용 CODEX_HOME. 사용자 홈을 쓰지 않는다. */
    codexHome: string;
    /** broker 의 loopback URL. */
    brokerUrl: string;
    /**
     * 이 run 의 broker grant 토큰.
     *
     * 인자로 싣지 않는다 — 프로세스 목록에 그대로 보인다. 설치본 0.153.4 의
     * `RawMcpServerConfig` 가 갖는 `bearer_token_env_var` 로 **이름만** 넘기고
     * 값은 env 로 준다(같은 바이너리가 `bearer_token` 은 "unsupported" 로 거부).
     */
    brokerToken: string;
    env: Record<string, string>;
    /**
     * 이 run 에 확정된 effort. 없거나 `'none'` 이면 아무것도 싣지 않는다 —
     * 설치본이 정한 기본값이 그대로 남아야 한다. 키 이름은 실측이다
     * (`codex` 0.153.4 바이너리의 `model_reasoning_effort`).
     */
    effort?: string;
};

export type CodexToolPolicy = {
    /** `<codexHome>/environments.toml` 의 내용. */
    environmentsToml: string;
    /** `codex` 에 붙일 인자. 기존 provider 인자에 더해진다. */
    args: string[];
    env: Record<string, string>;
};

/*
 * `OPENAI_API_KEY` 는 여기 없다 — codex 의 managed provider 가 `env_key` 로
 * 그 이름을 읽고, 거기 실리는 것은 이 run 의 gateway capability 다
 * (`managedStartup.applyManagedGatewayEnvironment`). 금지 대상은 이 run 의
 * 것이 아닌 자격과 caller 가 정하면 안 되는 경로다.
 */
const FORBIDDEN_PROVIDER_ENV = ['ANTHROPIC_API_KEY', 'CODEX_HOME', 'CODEX_ACCESS_TOKEN'];

function assertLoopbackHttpUrl(value: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('broker url must be an absolute URL');
    }
    if (url.protocol !== 'http:') throw new Error('broker url must be http on loopback');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('broker url must be on loopback');
    }
    if (url.username !== '' || url.password !== '') {
        throw new Error('broker url must not carry credentials');
    }
}

/** grant 를 싣는 환경변수 이름. 값이 아니라 이름만 설정에 들어간다. */
export const CODEX_BROKER_TOKEN_ENV = 'SAYCODE_BROKER_TOKEN';

export function buildCodexToolPolicy(input: CodexToolPolicyInput): CodexToolPolicy {
    assertLoopbackHttpUrl(input.brokerUrl);
    if (input.brokerToken.trim() === '') throw new Error('codex policy requires a broker token');
    if (!input.codexHome.startsWith('/')) {
        throw new Error('codexHome must be an absolute path');
    }
    for (const key of Object.keys(input.env)) {
        if (FORBIDDEN_PROVIDER_ENV.includes(key) || key.startsWith('HAPPY_MANAGED_')) {
            throw new Error(`managed provider env must not carry ${key}`);
        }
    }

    /*
     * local environment 를 넣지 않는다.
     *
     * `environments` 는 **시퀀스**다. `[environments]` 테이블로 쓰면 설치본
     * 0.153.4 가 `invalid type: map, expected a sequence` 로 거부한다(실측).
     *
     * **이것만으로는 경계가 되지 않는다.** 같은 설치본에서 `gpt-6-astra` 는
     * 이 파일이 있든 없든 같은 도구를 광고했고, `functions.exec` 안에는
     * `exec_command`·`apply_patch` 가 그대로 살아 있었다. 실제로 줄어든 것은
     * feature 조합(`shell_tool`/`unified_exec`/`view_image` 등)을 껐을 때다.
     * 그래서 이 파일은 경계의 **일부**이지 경계 자체가 아니다.
     */
    const environmentsToml = [
        '# managed runtime: no local execution environment is registered.',
        'include_local = false',
        'environments = []',
        '',
    ].join('\n');

    return {
        environmentsToml,
        args: [
            // 도구 실행 표면을 넓히는 기능들을 끈다.
            ...DISABLED_CODEX_FEATURES.flatMap((feature) => ['--disable', feature]),
            // MCP 는 이 broker 하나만.
            '-c', `mcp_servers.saycode.url=${JSON.stringify(input.brokerUrl)}`,
            '-c', `mcp_servers.saycode.bearer_token_env_var=${JSON.stringify(CODEX_BROKER_TOKEN_ENV)}`,
            ...(input.effort && input.effort !== 'none'
                ? ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`]
                : []),
        ],
        env: {
            ...input.env,
            CODEX_HOME: input.codexHome,
            [CODEX_BROKER_TOKEN_ENV]: input.brokerToken,
        },
    };
}
