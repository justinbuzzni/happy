/**
 * specs/managed-cloud-byos P4 — 관리 실행에서 기존 claude 경로의 옵션을 결속한다.
 *
 * 관리 런타임도 provider 를 띄우는 것은 기존 `runClaude` → `loop` → `claudeRemote`
 * 경로다. 새 채널을 만들지 않고, 그 경로가 이미 조립하는 옵션 자리에 계획의 값을
 * 넣는다.
 *
 * **관리 실행에서 계획이 없으면 기존 동작으로 되돌아가지 않는다.** 그 fallback 은
 * "내장 도구가 열린 채 관리 세션이 돈다" 는 뜻이고, 그것이 P4 가 막으려는 상태다.
 * BYOS 실행은 이 함수가 손대지 않는다.
 */
import { applyManagedProviderPlan } from './providerEntry';

/**
 * **마지막 소비 경계**에서 계획을 덮는다.
 *
 * 중간 계층(loop 옵션)에 값을 뿌리면 그 계층이 필드를 모르거나 mode 값으로 다시
 * 덮어써서 조용히 사라진다 — 실제로 `tools`·`effort`·`settingSources` 가 그렇게
 * 없어졌다. 그래서 `query` 를 부르기 직전, 이미 조립이 끝난 옵션 객체 위에
 * 한 번만 덮는다. 그 뒤로는 아무도 바꾸지 않는다.
 */
export function bindManagedQueryOptions<T extends object>(
    options: T,
    input: { managed: boolean; env: Record<string, string | undefined> },
): ManagedClaudeOptions<T> {
    return resolveManagedClaudeOptions({
        managed: input.managed,
        env: input.env,
        options: options as unknown as Record<string, unknown>,
    }) as unknown as ManagedClaudeOptions<T>;
}

export type ManagedClaudeOptions<T> = T & Partial<{
    tools: string[];
    mcpServers: Record<string, unknown>;
    allowedTools: string[];
    permissionMode: string;
    settingSources: string[];
    model: string;
    effort: string;
}>;

export function resolveManagedClaudeOptions<T extends Record<string, unknown>>(input: {
    /** 이 실행이 관리 런타임인가. `managedStartup !== null` 과 같은 값이다. */
    managed: boolean;
    env: Record<string, string | undefined>;
    options: T;
}): ManagedClaudeOptions<T> {
    if (!input.managed) return input.options;
    try {
        return applyManagedProviderPlan(input.options, input.env) as unknown as ManagedClaudeOptions<T>;
    } catch (error) {
        // 이유는 계획 검증에서 온다. 여기서는 관리 실행이라는 사실만 덧붙인다.
        throw new Error(`this managed run has no verified provider plan: ${(error as Error).message}`);
    }
}
