/**
 * specs/managed-cloud-byos P4 — 계획을 실행 경계에 결속하는 제품 코드.
 *
 * provider 를 띄우고 대화·승인·턴 수명주기를 소유하는 것은 **기존 runner**
 * (`runClaude` → `loop` → `claudeRemote`, codex 는 `CodexAppServerClient`)다.
 * 그래서 여기에는 별도 실행 루프를 두지 않는다 — 두면 승인 처리가 두 벌이 된다.
 *
 * 남는 책임은 둘뿐이다: 계획이 실어 준 옵션을 **읽고 검증하는 것**, 그리고 그
 * 옵션을 기존 경로의 옵션 자리에 **덮어쓰는 것**.
 */
import { redactAutonomousGateText } from '@/daemon/autonomousQualityGateSafety';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

import { readProviderSdkOptions } from './providerLaunch';

/** 자격이 섞인 문구가 프로세스 밖으로 나가지 않게 한다. 이미 있는 규칙을 쓴다. */
export const MAX_PROVIDER_ERROR_LENGTH = 500;

export function sanitizeProviderFailure(error: unknown): string {
    const message = String((error as Error)?.message ?? error);
    return redactAutonomousGateText(message).slice(0, MAX_PROVIDER_ERROR_LENGTH);
}

/**
 * 계획을 **기존 실행 경로의 옵션에 결속한다**.
 *
 * 관리 런타임에서도 provider 를 띄우는 것은 기존 `runClaude`/`loop` 경로다.
 * 그 경로가 이미 `mcpServers`·`allowedTools`·`permissionMode` 를 조립하므로,
 * 새 채널을 만드는 대신 그 자리에 계획의 값을 **덮어쓴다** — 경계를 정하는
 * 것만 덮고 나머지(훅 경로, disallowedTools 같은 것)는 건드리지 않는다.
 */
export function applyManagedProviderPlan<T extends Record<string, unknown>>(
    options: T,
    env: Record<string, string | undefined>,
): T & {
    tools: string[];
    mcpServers: Record<string, unknown>;
    allowedTools: string[];
    permissionMode: 'default';
    settingSources: [];
    model: string;
} {
    const plan = readProviderSdkOptions(env);
    /*
     * runner 가 이미 모델을 들고 있으면 그것은 승인·과금된 봉투의 모델이다.
     * 계획과 다르면 한 모델로 청구하고 다른 모델을 돌리게 되므로 멈춘다.
     */
    const carried = (options as { model?: unknown }).model;
    if (typeof carried === 'string' && carried !== '' && carried !== plan.model) {
        throw new Error('the runner carries a different model than this run’s plan');
    }
    return {
        ...options,
        tools: plan.tools,
        mcpServers: plan.mcpServers,
        allowedTools: plan.allowedTools,
        permissionMode: plan.permissionMode,
        settingSources: plan.settingSources,
        model: plan.model,
        /*
         * 계획이 effort 를 고르지 않았으면 **명시적으로 지운다**. 그냥 두면
         * 앞 계층이 들고 온 값(BYOS 기본값이나 직전 턴의 값)이 살아남아, 고르지
         * 않은 effort 로 도는 실행이 된다.
         */
        effort: plan.effort,
        // 관리 실행은 조용히 다른 모델로 넘어가지 않는다.
        fallbackModel: undefined,
    };
}