/**
 * specs/managed-cloud-byos P4 — 관리 실행에서 기존 codex 경로의 인자를 결속한다.
 *
 * codex 는 이미 `CodexAppServerClient` 가 app-server 를 소유하고, 승인·이벤트·턴
 * 수명주기도 그 경로가 가진다. 그래서 P4 는 **인자만** 얹는다: broker 등록,
 * 자격을 실을 환경변수 이름, 기능 차단, 그리고 run 이 확정한 effort.
 *
 * B2 가 정하는 provider 고정 인자(`managedCodexProviderArguments`)는 그대로 두고
 * 그 뒤에 붙인다. 관리 실행인데 검증된 계획이 없으면 **되돌아가지 않고 멈춘다**.
 */
import { readProviderCodexArgs } from './providerLaunch';

export function resolveManagedCodexArguments(input: {
    managed: boolean;
    env: Record<string, string | undefined>;
    /** B2 가 만든 provider 고정 인자. 관리 실행이 아니면 그대로 돌려준다. */
    base: string[] | null;
}): string[] | null {
    if (!input.managed) return input.base;
    let planned: string[];
    try {
        planned = readProviderCodexArgs(input.env);
    } catch (error) {
        throw new Error(`this managed run has no verified provider plan: ${(error as Error).message}`);
    }
    return [...(input.base ?? []), ...planned];
}
