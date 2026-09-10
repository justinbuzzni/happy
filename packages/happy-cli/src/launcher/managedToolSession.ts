/**
 * specs/managed-cloud-byos P4 — 한 run 의 도구 경계를 통째로 세우고 거둔다.
 *
 * 지금까지 조각들은 각각 증명됐지만 서로 만나지 않았다: 정책은 옵션을 만들고,
 * broker 는 인증하고, executor 는 격리한다. 이 파일이 그 셋을 **하나의 run** 으로
 * 묶는다 — grant 를 발급하고, broker 를 loopback 에 띄우고, 그 포트·토큰이 실린
 * provider 실행 계획을 돌려주고, 끝날 때 함께 거둔다.
 *
 * 거두는 것이 절반이다. broker 가 살아 있는데 세대가 끝났다면 그 포트는 아직
 * 도구를 실행해 주는 문이고, grant 가 살아 있는데 프로세스가 죽었다면 그 토큰을
 * 주운 쪽이 문을 열 수 있다. 그래서 `close()` 는 폐기와 종료를 함께 한다.
 */
import {
    type BrokerGrant,
    type BrokerTool,
    createToolBroker,
    mintBrokerGrant,
} from './toolBroker';
import { createManagedToolRuntime } from './managedToolRuntime';
import {
    type ExecutorIdentity,
    type ToolExecutorDeps,
    createToolExecutor,
    defaultToolExecutorDeps,
    planToolExecutorIsolation,
} from './toolExecutor';
import { type ProviderLaunchPlan, planProviderLaunch, type ProviderAgent } from './providerLaunch';
import { systemMonotonicNow } from './supervisor';

export type ManagedToolSessionInput = {
    /**
     * Passed straight through to the runtime, where every broker call goes
     * through one place. The session does not own the drain: a checkpoint and
     * the tool path have to share exactly one, and the checkpoint runner is
     * what holds it.
     */
    checkpointDrain?: {
        drain: { beginWrite: () => () => void };
        writeTools: ReadonlySet<string>;
    };
    agent: ProviderAgent;
    /** 이 run 의 provider env. gateway capability 는 여기 있어도 된다. */
    providerEnv: Record<string, string>;
    /** codex 전용 run-private CODEX_HOME. */
    codexHome?: string;
    /** 이 run 에 확정된 모델. gateway capability 가 이 하나에만 유효하다. */
    model: string;
    /** 이 run 에 확정된 effort. 고르지 않았으면 넘기지 않는다. */
    effort?: string;
    /** broker 가 알리는 도구. `scope` 밖의 이름은 등록돼 있어도 실행되지 않는다. */
    tools: BrokerTool[];
    scope: string[];
    /** grant 수명. 세대 lease 보다 길게 잡지 않는다. */
    ttlMs: number;
    identity: { executor: ExecutorIdentity; provider: ExecutorIdentity };
    /** 이 실행이 묶일 세대 cgroup. 취소와 세대 fence 가 여기로 간다. */
    cgroupPath: string;
    helperPath: string;
    workloadPath: string;
    /** 도구 한 번의 상한. */
    toolTimeoutMs: number;
    /** 취소 뒤 종료를 기다리는 상한. 넘기면 정지가 증명되지 않은 것이다. */
    terminationWaitMs?: number;
    /**
     * 정지를 증명하지 못했거나 호스트 정리에 실패한 호출. 세대 정리와 추적은
     * 상위 lifecycle 의 몫이다 — 선택 인자가 아니다.
     */
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /** 테스트가 실제 helper 없이 이 배선을 돌리기 위한 자리. */
    executorDeps?: ToolExecutorDeps;
    monotonicNow?: () => number;
};

export type ManagedToolSession = {
    /** B3 가 그대로 소비한다. broker URL·토큰이 이미 실려 있다. */
    providerPlan: ProviderLaunchPlan;
    brokerPort: number;
    /**
     * 이 run 의 자격을 없애고 **이미 실행 중인 도구까지 끝낸다.**
     *
     * 자격만 없애면 아직 park 전인 호출만 막힌다 — 이미 execve 된 도구는 계속
     * 돈다. 그것들은 세대 cgroup 안에 있으므로 `cgroup.kill` 로 함께 끝낸다.
     * 정지가 증명되지 않으면 lifecycle 에 알린다.
     */
    revoke: () => Promise<{ proven: boolean; detail: string }>;
    /**
     * 폐기·정지·종료를 함께 하고 **정지의 증거를 돌려준다**. 실패를 콜백으로만
     * 흘리면 호출자는 정지됐다고 보고하게 된다.
     */
    close: () => Promise<{ proven: boolean; detail: string }>;
};

export async function startManagedToolSession(
    input: ManagedToolSessionInput,
): Promise<ManagedToolSession> {
    const monotonicNow = input.monotonicNow ?? systemMonotonicNow;
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
        throw new Error('managed tool session requires a positive ttl');
    }
    // 계획을 먼저 세운다. 여기서 거부되면 broker 를 띄우지 않는다 — 열어 두고
    // 실패하면 그 포트가 정리되지 않은 채 남는다.
    const plan = planToolExecutorIsolation({
        identity: input.identity.executor,
        providerIdentity: input.identity.provider,
    });

    let grant: BrokerGrant | null = mintBrokerGrant({
        scope: input.scope,
        expiresMonotonic: monotonicNow() + input.ttlMs,
    });
    const token = grant.token;

    const executor = createToolExecutor(input.executorDeps ?? defaultToolExecutorDeps({
        helperPath: input.helperPath,
        workloadPath: input.workloadPath,
        cgroupPath: input.cgroupPath,
    }));
    const broker = createToolBroker(createManagedToolRuntime({
        tools: input.tools,
        plan,
        executor,
        grant: () => grant,
        monotonicNow,
        timeoutMs: input.toolTimeoutMs,
        terminationWaitMs: input.terminationWaitMs,
        onUnprovenTermination: input.onUnprovenTermination,
        checkpointDrain: input.checkpointDrain,
    }));
    // 포트 0 으로 열고 커널이 준 번호를 쓴다. 고정 포트는 다른 run 과 부딪힌다.
    const brokerPort = await broker.listen(0);

    let providerPlan: ProviderLaunchPlan;
    try {
        providerPlan = planProviderLaunch({
            agent: input.agent,
            brokerUrl: `http://127.0.0.1:${brokerPort}/`,
            brokerToken: token,
            // grant scope 와 provider 가 부를 수 있는 도구는 같은 목록이다.
            brokerTools: input.scope,
            model: input.model,
            effort: input.effort as never,
            providerEnv: input.providerEnv,
            codexHome: input.codexHome,
        });
    } catch (error) {
        // 계획이 거부되면 이 run 은 시작되지 않는다. 열어 둔 문을 닫고 나간다.
        grant = null;
        await broker.close();
        throw error;
    }

    const executorDeps = input.executorDeps ?? null;
    const fence = async (): Promise<{ proven: boolean; detail: string }> => {
        // 폐기가 먼저다. 닫는 동안 들어온 요청도 자격을 잃은 뒤에 온다.
        grant = null;
        // 이미 돌고 있는 도구는 자격과 무관하게 살아 있다. 세대째 끝낸다.
        const proof = await killGeneration();
        if (!proof.proven) {
            input.onUnprovenTermination({ tool: 'session-close', detail: proof.detail });
        }
        return proof;
    };
    const killGeneration = executorDeps
        ? executorDeps.killCgroup
        : defaultToolExecutorDeps({
            helperPath: input.helperPath,
            workloadPath: input.workloadPath,
            cgroupPath: input.cgroupPath,
        }).killCgroup;

    return {
        providerPlan,
        brokerPort,
        revoke: fence,
        close: async () => {
            const proof = await fence();
            await broker.close();
            return proof;
        },
    };
}
