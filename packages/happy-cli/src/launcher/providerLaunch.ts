/**
 * specs/managed-cloud-byos P4 — provider 실행 계획.
 *
 * B3(daemon 배선)가 소비하는 API 다. 여기서 정하는 것은 **무엇을 어떤 자격으로
 * 어디서 돌릴지**이고, 실제로 띄우는 것은 supervisor 의 `prepareLaunch` 다.
 *
 * 두 개의 신뢰 영역을 가른다:
 *  - **provider**: 이 run 의 gateway capability 를 소비한다. 내장 도구는 없고,
 *    도구는 신뢰된 broker 하나로만 온다.
 *  - **tool executor**: broker 뒤에서 임의 프로젝트 코드를 돌린다. provider 의
 *    자격을 하나도 갖지 못하며 다른 UID·namespace 에 산다.
 *
 * cwd 는 `MANAGED_PROJECT_ROOT` 로 고정한다. 호출자가 고르지 못한다 — 다른
 * 디렉터리에서 시작한 run 은 승인받은 workspace 밖 파일을 고치면서 안에 있다고
 * 보고한다(`managedStartup.assertManagedWorkingDirectory` 와 같은 이유).
 */
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

import {
    CLAUDE_EFFORT_LEVELS,
    type ClaudeEffort,
    assertProviderEnv,
    buildClaudeToolPolicy,
} from './claudeToolPolicy';
import { DISABLED_CODEX_FEATURES, buildCodexToolPolicy } from './codexToolPolicy';

export type ProviderAgent = 'claude' | 'codex';

/** provider 프로세스가 자기 SDK 옵션을 읽는 자리. 계획이 직접 싣는다. */
export const PROVIDER_SDK_OPTIONS_ENV = 'SAYCODE_PROVIDER_SDK_OPTIONS';

/** codex provider 가 자기 실행 인자를 읽는 자리. 같은 이유로 계획이 싣는다. */
export const PROVIDER_CODEX_ARGS_ENV = 'SAYCODE_PROVIDER_CODEX_ARGS';

/** 두 provider 공통으로, 이 run 에 확정된 모델이 실리는 자리. */
export const PROVIDER_MODEL_ENV = 'SAYCODE_PROVIDER_MODEL';

export type ProviderLaunchRequest = {
    agent: ProviderAgent;
    /** broker 의 loopback URL. supervisor 가 띄운 다른 UID 의 프로세스다. */
    brokerUrl: string;
    /** 이 run 의 broker grant 토큰. provider 는 이것으로만 broker 에 붙는다. */
    brokerToken: string;
    /** 이 run 이 쓸 수 있는 broker 도구 이름들(= grant scope). */
    brokerTools?: string[];
    /** 이 run 에 확정된 모델. gateway capability 가 이 하나에만 유효하다. */
    model: string;
    /**
     * 이 run 에 확정된 effort. `'none'` 이거나 없으면 provider 기본값을 그대로 둔다 —
     * 우리가 대신 고르지 않는다.
     */
    effort?: ClaudeEffort | 'none';
    /** 이 run 의 provider env. gateway capability 는 여기 있어도 된다. */
    providerEnv: Record<string, string>;
    /** codex 전용: 이 실행 전용 CODEX_HOME. */
    codexHome?: string;
};

export type ProviderLaunchPlan = {
    agent: ProviderAgent;
    /** 항상 `/workspace/project`. */
    cwd: string;
    env: Record<string, string>;
    /** codex 에 붙일 인자. claude 는 SDK 옵션으로 간다. */
    args: string[];
    /** 실행 전에 supervisor 가 써야 할 파일들. root 소유로 만든다. */
    files: Array<{ path: string; contents: string; mode: number }>;
    /** claude SDK 에 그대로 넘기는 옵션. */
    sdkOptions: {
        tools: string[];
        mcpServers: Record<string, { type: 'http'; url: string; headers: { authorization: string } }>;
        permissionMode: 'default';
        allowedTools: string[];
        settingSources: [];
        model: string;
        effort?: ClaudeEffort;
    } | null;
};

export function planProviderLaunch(request: ProviderLaunchRequest): ProviderLaunchPlan {
    assertProviderEnv(request.providerEnv);

    if (request.agent === 'claude') {
        const policy = buildClaudeToolPolicy({
            brokerUrl: request.brokerUrl,
            brokerToken: request.brokerToken,
            brokerTools: request.brokerTools,
            model: request.model,
            effort: request.effort,
            env: request.providerEnv,
        });
        const sdkOptions = {
            model: policy.model,
            // 고르지 않았으면 키가 없다. 있으면 그 값 그대로.
            ...policy.sdkEffortOption,
            tools: policy.tools,
            mcpServers: policy.mcpServers,
            permissionMode: policy.permissionMode,
            allowedTools: policy.allowedTools,
            settingSources: policy.settingSources,
        };
        return {
            agent: 'claude',
            cwd: MANAGED_PROJECT_ROOT,
            /*
             * 옵션을 계획의 env 에 싣는다. 실행 경계에서 옵션을 바깥이 채워 넣을
             * 수 있으면, 계획대로 검사한 것과 실제로 돈 것이 다를 수 있다.
             */
            env: { ...policy.env, [PROVIDER_SDK_OPTIONS_ENV]: JSON.stringify(sdkOptions) },
            args: [],
            files: [],
            sdkOptions,
        };
    }

    if (!request.codexHome) {
        throw new Error('codex launch requires a run-private codexHome');
    }
    const policy = buildCodexToolPolicy({
        codexHome: request.codexHome,
        // codex 의 같은 개념. 설치본 0.153.4 가 `model_reasoning_effort` 를 갖는다(실측).
        effort: request.effort,
        brokerUrl: request.brokerUrl,
        // Claude 에만 자격을 넘기고 codex 를 빠뜨리면, codex run 은 broker 에
        // 붙지 못한 채 도구 없이 돈다.
        brokerToken: request.brokerToken,
        env: request.providerEnv,
    });
    return {
        agent: 'codex',
        cwd: MANAGED_PROJECT_ROOT,
        // 인자도 계획의 env 에 실어 실행 경계에 결속한다(claude 의 sdkOptions 와 같은 이유).
        env: {
            ...policy.env,
            [PROVIDER_CODEX_ARGS_ENV]: JSON.stringify(policy.args),
            [PROVIDER_MODEL_ENV]: request.model,
        },
        args: policy.args,
        files: [{
            path: `${request.codexHome}/environments.toml`,
            contents: policy.environmentsToml,
            // provider 가 읽기만 한다. 자기 정책을 다시 쓸 수 있으면 정책이 아니다.
            mode: 0o444,
        }],
        sdkOptions: null,
    };
}


/**
 * provider 프로세스가 자기 SDK 옵션을 읽는 **제품 경로**.
 *
 * 계획이 env 에 실었다는 사실만으로는 강제가 아니다 — 읽는 쪽이 하네스에만
 * 있으면 실제 실행은 무엇이든 될 수 있다. 그래서 읽기도 제품이 하고, 여기서
 * 경계를 다시 확인한다: 내장 도구 없음, 승인 프롬프트로 대체하지 않음, 파일
 * 시스템 설정 안 읽음, broker 하나, 그리고 미리 허가된 도구가 실재할 것.
 */
export function readProviderSdkOptions(env: Record<string, string | undefined>): {
    tools: string[];
    mcpServers: Record<string, { type: 'http'; url: string; headers: { authorization: string } }>;
    permissionMode: 'default';
    allowedTools: string[];
    settingSources: [];
    model: string;
    effort?: ClaudeEffort;
} {
    const raw = env[PROVIDER_SDK_OPTIONS_ENV];
    if (raw === undefined || raw === '') throw new Error('the provider environment carries no sdk options');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('the provider sdk options are unreadable');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the provider sdk options are unreadable');
    }
    const options = parsed as Record<string, unknown>;
    if (!Array.isArray(options.tools) || options.tools.length !== 0) {
        throw new Error('the provider sdk options must disable every built-in tool');
    }
    if (options.permissionMode !== 'default') {
        throw new Error('the provider sdk options must not replace the boundary with a permission mode');
    }
    if (!Array.isArray(options.settingSources) || options.settingSources.length !== 0) {
        throw new Error('the provider sdk options must load no filesystem settings');
    }
    const servers = options.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)
        || Object.keys(servers as Record<string, unknown>).length !== 1) {
        throw new Error('the provider sdk options must carry exactly one broker');
    }
    if (!Array.isArray(options.allowedTools) || options.allowedTools.length === 0) {
        throw new Error('the provider sdk options must pre-authorize this run’s broker tools');
    }
    if (typeof options.model !== 'string' || options.model.trim() === '') {
        // 모델이 없으면 SDK 가 스스로 고른다. gateway 는 그 모델을 모른다.
        throw new Error('the provider sdk options must name this run’s model');
    }
    if ('effort' in options && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(String(options.effort))) {
        throw new Error('the provider sdk options carry an effort the SDK does not have');
    }
    return options as unknown as ReturnType<typeof readProviderSdkOptions>;
}

/**
 * codex provider 가 자기 실행 인자를 읽는 **제품 경로**.
 *
 * 읽으면서 경계를 다시 확인한다: broker 가 계획대로 등록돼 있고, 자격은 값이
 * 아니라 환경변수 이름으로 넘어가며, 인자가 문자열 배열일 것.
 */
export function readProviderCodexArgs(env: Record<string, string | undefined>): string[] {
    const raw = env[PROVIDER_CODEX_ARGS_ENV];
    if (raw === undefined || raw === '') throw new Error('the provider environment carries no codex arguments');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('the provider codex arguments are unreadable');
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
        throw new Error('the provider codex arguments are unreadable');
    }
    const args = parsed as string[];
    /*
     * **정확 일치로 판정한다.**
     *
     * 문자열이 들어 있는지만 보면 `--disable` 을 전부 지운 인자도, 뒤에 붙어 앞의
     * 결정을 뒤집는 `-c features.hooks=true` 도 통과한다. codex 는 나중 `-c` 가
     * 이기므로 "포함" 검사는 경계가 아니다. 그래서 이 함수는 계획이 만드는 것과
     * **같은 규칙으로 다시 만들어** 비교한다: 인자 순서까지 같아야 한다.
     */
    const expected = canonicalCodexArguments(args);
    if (expected === null || expected.length !== args.length
        || expected.some((entry, index) => entry !== args[index])) {
        throw new Error('the provider codex arguments are not the ones this run planned');
    }
    return args;
}

/**
 * 인자에서 읽어 낸 값으로 **계획이 만들었을 인자열을 재구성한다**.
 *
 * 재구성한 것과 실제가 다르면 누가 지웠거나 덧붙인 것이다.
 */
function canonicalCodexArguments(args: string[]): string[] | null {
    const url = /^mcp_servers\.saycode\.url=(".*")$/;
    const bearer = /^mcp_servers\.saycode\.bearer_token_env_var=(".*")$/;
    const effort = /^model_reasoning_effort=(".*")$/;
    let brokerUrl: string | null = null;
    let bearerEnv: string | null = null;
    let chosenEffort: string | null = null;
    const disabled: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const entry = args[index]!;
        if (entry === '--disable') {
            const feature = args[index + 1];
            if (feature === undefined) return null;
            disabled.push(feature);
            index += 1;
            continue;
        }
        if (entry === '-c') {
            const value = args[index + 1];
            if (value === undefined) return null;
            const foundUrl = url.exec(value);
            const foundBearer = bearer.exec(value);
            const foundEffort = effort.exec(value);
            if (foundUrl) {
                if (brokerUrl !== null) return null;
                brokerUrl = foundUrl[1]!;
            } else if (foundBearer) {
                if (bearerEnv !== null) return null;
                bearerEnv = foundBearer[1]!;
            } else if (foundEffort) {
                if (chosenEffort !== null) return null;
                chosenEffort = foundEffort[1]!;
            } else {
                // 계획이 만들지 않는 설정이다.
                return null;
            }
            index += 1;
            continue;
        }
        // `--disable`/`-c` 밖의 인자는 계획에 없다.
        return null;
    }
    if (brokerUrl === null || bearerEnv === null) return null;
    if (disabled.length !== DISABLED_CODEX_FEATURES.length
        || DISABLED_CODEX_FEATURES.some((feature, index) => feature !== disabled[index])) {
        return null;
    }
    return [
        ...DISABLED_CODEX_FEATURES.flatMap((feature) => ['--disable', feature]),
        '-c', `mcp_servers.saycode.url=${brokerUrl}`,
        '-c', `mcp_servers.saycode.bearer_token_env_var=${bearerEnv}`,
        ...(chosenEffort !== null ? ['-c', `model_reasoning_effort=${chosenEffort}`] : []),
    ];
}