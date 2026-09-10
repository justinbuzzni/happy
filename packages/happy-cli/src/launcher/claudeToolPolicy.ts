/**
 * specs/managed-cloud-byos P4 — Claude provider 의 도구 경계.
 *
 * provider 프로세스는 scoped/gateway/session/report 자격을 들고 있다. 임의
 * 프로젝트 코드를 **그 프로세스 안에서** 실행하면 그 자격이 곧 도구의 것이
 * 된다. 그래서 내장 도구를 전부 끄고, 신뢰된 broker 하나만 남긴다 — broker 는
 * 다른 UID 에서 도는 별도 프로세스라 이 자격에 닿지 못한다.
 *
 * 근거(설치본 `@anthropic-ai/claude-agent-sdk@0.3.179` 의 `sdk.d.ts`):
 *  - `tools: []` — "Disable all built-in tools"
 *  - `env` — "REPLACES the subprocess environment entirely"
 *  - `mcpServers` 의 `type:'http'` 는 `url` 만 받는다 → 다른 프로세스·다른 UID
 *
 * 여기서 만드는 것은 **옵션뿐**이다. 실제로 도구가 등록되지 않는지는 이 파일이
 * 증명하지 못한다 — 그것은 `verify-p4-tools.sh` 의 적대적 fixture 가 판정한다.
 *
 * **provider env 와 tool executor env 는 다른 것이다.** provider 는 이 run 의
 * gateway capability 를 `ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY` 로 소비한다
 * (`managedStartup.applyManagedGatewayEnvironment`) — 그게 승인된 경로다.
 * 금지 대상은 **이 run 의 것이 아닌 자격**(상속된 개인 키, 계정 토큰, daemon
 * 홈)이고, 그리고 **tool executor 에는 그 어느 것도 없어야 한다.**
 */

export const MANAGED_TOOL_BROKER_NAME = 'saycode-broker';

/** SDK 가 받는 effort 단계. `sdk.d.ts:546` 의 `EffortLevel` 과 같다. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

export type ClaudeToolPolicyInput = {
    /** broker 의 loopback URL. 다른 UID 의 프로세스가 연다. */
    brokerUrl: string;
    /**
     * 이 run 의 broker grant 토큰.
     *
     * loopback 이라고 인증을 생략하지 않는다 — 같은 호스트의 다른 프로세스도,
     * tool executor 자신도 그 포트에 붙을 수 있다. SDK 는 이 값을
     * `McpHttpServerConfig.headers` 로 실어 보낸다(`sdk.d.ts:1021-1030`).
     */
    brokerToken: string;
    /**
     * 이 run 이 쓸 수 있는 broker 도구 이름들. SDK 는 도구마다 허가를 요구하므로
     * (`permissionMode:'default'` 에서 실제로 거부되는 것을 확인했다) 이 목록을
     * 이름으로 미리 허가한다. `bypassPermissions` 는 쓰지 않는다 — 그것은 이
     * 도구들뿐 아니라 앞으로 생길 무엇이든 허가한다.
     */
    brokerTools?: string[];
    /**
     * 이 run 에 확정된 모델.
     *
     * gateway capability 는 **선택된 모델 하나**에만 유효하다. 그래서 주 호출뿐
     * 아니라 CLI 가 스스로 고르는 자리(제목 생성용 작은 모델, 하위 에이전트)도
     * 같은 값으로 고정한다 — 설치본 2.1.179 바이너리에서 확인한 이름들이다.
     */
    model: string;
    /**
     * 이 run 에 확정된 effort.
     *
     * `'none'` 이거나 없으면 **아무것도 싣지 않는다** — provider 기본값이 그대로
     * 남아야 한다는 뜻이다. 우리가 대신 고르면 사용자가 고르지 않은 값이 조용히
     * 적용된다. 값은 SDK 의 `EffortLevel` 만 받는다(`sdk.d.ts:546`).
     */
    effort?: ClaudeEffort | 'none';
    /** child 에게 줄 환경변수 **전체**. 여기 없는 것은 자식에 없다. */
    env: Record<string, string>;
};

export type ClaudeToolPolicy = {
    /** 내장 도구를 하나도 켜지 않는다. */
    tools: string[];
    mcpServers: Record<string, {
        type: 'http';
        url: string;
        headers: { authorization: string };
    }>;
    env: Record<string, string>;
    /** 승인 프롬프트로 경계를 대신하지 않는다 — 경계는 UID 다. */
    permissionMode: 'default';
    /** 이 run 에 확정된 모델. SDK 옵션과 env 양쪽에 실린다. */
    model: string;
    /** 이 run 이 고른 effort. 고르지 않았으면 `undefined` 다. */
    effort?: ClaudeEffort;
    /** SDK 옵션에 펼칠 조각. 고르지 않았으면 **빈 객체**다. */
    sdkEffortOption: { effort?: ClaudeEffort };
    /** 프롬프트 없이 실행될 도구. 이 run 의 broker 도구만 들어간다. */
    allowedTools: string[];
    /**
     * 파일시스템 설정을 하나도 읽지 않는다. 생략하면 CLI 기본대로 사용자·프로젝트
     * 설정과 CLAUDE.md 까지 읽는데, 관리 런타임에서 그것은 신뢰하지 않는 입력이다
     * (`sdk.d.ts`: "Pass `[]` to disable filesystem settings").
     */
    settingSources: [];
};

function assertLoopbackHttpUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('broker url must be an absolute URL');
    }
    if (url.protocol !== 'http:') throw new Error('broker url must be http on loopback');
    // loopback 밖으로 나가면 broker 요청이 네트워크에 실린다.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('broker url must be on loopback');
    }
    if (url.username !== '' || url.password !== '') {
        throw new Error('broker url must not carry credentials');
    }
    if (url.search !== '' || url.hash !== '') throw new Error('broker url must be a bare path');
    return url;
}

/**
 * provider env 에서 금지되는 것들.
 *
 * `ANTHROPIC_AUTH_TOKEN` 은 여기 없다 — 그것이 이 run 의 capability 를 싣는
 * 승인된 자리다. 금지되는 것은 **이 run 의 것이 아닌** 자격이다: 상속된 개인
 * API 키, 계정 OAuth 토큰, daemon 의 홈.
 */
const FORBIDDEN_PROVIDER_ENV = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'HAPPY_HOME_DIR',
];

/** tool executor 에서는 **어떤 provider 자격도** 있으면 안 된다. */
const FORBIDDEN_TOOL_ENV = [
    ...FORBIDDEN_PROVIDER_ENV,
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
];

/** provider env 검사. 승인된 capability 자리는 남기고 나머지를 막는다. */
export function assertProviderEnv(env: Record<string, string>): void {
    for (const key of Object.keys(env)) {
        if (FORBIDDEN_PROVIDER_ENV.includes(key) || key.startsWith('HAPPY_MANAGED_')) {
            throw new Error(`managed provider env must not carry ${key}`);
        }
    }
}

/**
 * tool executor env 검사.
 *
 * 여기에는 gateway capability 도 있으면 안 된다 — 도구가 그것을 들면 승인된
 * 예산과 모델 밖으로 나갈 수 있고, 그게 provider 와 도구를 가르는 이유다.
 */
export function assertToolExecutorEnv(env: Record<string, string>): void {
    for (const key of Object.keys(env)) {
        if (FORBIDDEN_TOOL_ENV.includes(key) || key.startsWith('HAPPY_MANAGED_')) {
            throw new Error(`tool executor env must not carry ${key}`);
        }
    }
}

export function buildClaudeToolPolicy(input: ClaudeToolPolicyInput): ClaudeToolPolicy {
    assertLoopbackHttpUrl(input.brokerUrl);
    assertProviderEnv(input.env);
    // 자격 없이 만든 정책은 broker 에게 거부당한다. 그 조합을 만들지 않는다.
    if (input.brokerToken.trim() === '') throw new Error('claude policy requires a broker token');
    if (typeof input.model !== 'string' || input.model.trim() === '') {
        throw new Error('claude policy requires the run’s selected model');
    }
    const chosen = input.effort ?? 'none';
    if (chosen !== 'none' && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(chosen)) {
        throw new Error(`claude policy received an effort the SDK does not have: ${chosen}`);
    }
    const effort = chosen === 'none' ? undefined : chosen as ClaudeEffort;
    return {
        tools: [],
        mcpServers: {
            [MANAGED_TOOL_BROKER_NAME]: {
                type: 'http',
                url: input.brokerUrl,
                headers: { authorization: `Bearer ${input.brokerToken}` },
            },
        },
        env: {
            ...input.env,
            // 세 자리를 모두 같은 값으로. 하나라도 다르면 그 호출만 gateway 에서 거절된다.
            ANTHROPIC_MODEL: input.model,
            ANTHROPIC_SMALL_FAST_MODEL: input.model,
            CLAUDE_CODE_SUBAGENT_MODEL: input.model,
        },
        model: input.model,
        // 고르지 않았으면 키 자체를 만들지 않는다.
        ...(effort ? { effort } : {}),
        sdkEffortOption: effort ? { effort } : {},
        permissionMode: 'default',
        allowedTools: (input.brokerTools ?? []).map(
            (tool) => `mcp__${MANAGED_TOOL_BROKER_NAME}__${tool}`,
        ),
        settingSources: [],
    };
}
