/**
 * specs/managed-cloud-byos P4 — broker 와 executor 를 하나의 run 으로 묶는다.
 *
 * broker 는 실행하지 않고 executor 는 인증하지 않는다. 둘을 잇는 곳이 여기다.
 * 제품이 도구를 실행하는 경로는 이 조립을 거치는 것 하나뿐이고, 격리 실증
 * fixture 도 같은 함수를 부른다 — fixture 가 스스로 `unshare` 를 부르면
 * 검증되는 것은 fixture 자신이다.
 *
 * 실행 직전 재검증이 이 파일의 이유다. broker 가 요청을 인가한 시점과 도구가
 * 실제로 execve 되는 시점 사이에는 helper 준비 시간이 있고, 그 사이에 grant 가
 * 만료·폐기되거나 세대가 취소될 수 있다. 인가를 입구에서 한 번만 하면 그
 * 구간에 들어온 취소가 무시된다.
 */
import {
    type BrokerGrant,
    type BrokerToolCall,
    type BrokerToolResult,
    type ToolBrokerDeps,
} from './toolBroker';
import { type ExecutorIsolationPlan, createToolExecutor } from './toolExecutor';

export function createManagedToolRuntime(input: {
    tools: ToolBrokerDeps['tools'];
    plan: ExecutorIsolationPlan;
    executor: ReturnType<typeof createToolExecutor>;
    /** 현재 유효한 자격. 폐기되면 `null`, 재발급되면 **다른 객체**다. */
    grant: () => BrokerGrant | null;
    monotonicNow: () => number;
    /** 한 호출의 상한. 넘으면 세대 cgroup 으로 끝낸다. */
    timeoutMs: number;
    /** 취소 뒤 종료를 기다리는 상한. */
    terminationWaitMs?: number;
    /**
     * 정지를 증명하지 못한 호출. **버리지 않는다** — 남은 프로세스가 있는지
     * 모르는 상태이므로 세대 정리와 추적은 상위 lifecycle 의 몫이다.
     *
     * 선택 인자가 아니다. 빠뜨릴 수 있게 두면 production 이 조용히 빠뜨린다.
     */
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /**
     * Holds writes while a checkpoint is taken. Passed as one object because
     * the gate and the set of tools it applies to are not independently
     * useful — a drain with no write tools would silently hold nothing.
     *
     * This is the only place a drain can work: inside the executor the tool
     * runs under a different uid, in its own pid and mount namespaces, with no
     * way to see anything on this side.
     */
    checkpointDrain?: {
        drain: { beginWrite: () => () => void };
        writeTools: ReadonlySet<string>;
    };
}): ToolBrokerDeps {
    const execute = async (call: BrokerToolCall): Promise<BrokerToolResult> => {
        let writeFinished: (() => void) | null = null;
        if (input.checkpointDrain?.writeTools.has(call.name)) {
            try {
                writeFinished = input.checkpointDrain.drain.beginWrite();
            } catch {
                return { ok: false, code: 'checkpoint-paused' };
            }
        }
        let terminationProven = true;
        try {
            return await runCall(call, () => { terminationProven = false; });
        } finally {
            // A write whose processes could not be proven stopped is not over.
            // Releasing it here would let a checkpoint start while something
            // is still writing to the workspace — and the archive would then
            // hold a moment that never existed. The gate stays held; a drain
            // waiting on it fails on its budget, which is the honest outcome.
            if (terminationProven) writeFinished?.();
        }
    };

    const runCall = async (
        call: BrokerToolCall,
        onUnprovenTermination: () => void,
    ): Promise<BrokerToolResult> => {
        // 입구에서 인가한 그 자격을 붙든다. 그 사이 재발급된 자격이 이 호출을
        // 대신 인가하면, 폐기가 폐기가 아니게 된다.
        const admitted = input.grant();
        const outcome = await input.executor.run({
            plan: input.plan,
            call,
            timeoutMs: input.timeoutMs,
            terminationWaitMs: input.terminationWaitMs,
            recheckGrant: () => {
                const current = input.grant();
                if (!current || current !== admitted) return { ok: false };
                if (input.monotonicNow() >= current.expiresMonotonic) return { ok: false };
                if (!current.scope.has(call.name)) return { ok: false };
                return { ok: true };
            },
        });
        /*
         * 호스트에 남은 것(veth·NAT 규칙)도 lifecycle 의 문제다. 실패를 알리지
         * 않으면 자원이 조용히 쌓여 결국 다음 실행이 주소를 잡지 못한다.
         */
        if (outcome.hostCleanup === 'failed') {
            input.onUnprovenTermination({ tool: call.name, detail: 'host-cleanup-failed' });
        }
        if (outcome.ok) return { ok: true, content: outcome.content };
        if (outcome.cancelProven === false) {
            onUnprovenTermination();
            input.onUnprovenTermination({ tool: call.name, detail: outcome.cancelDetail });
        }
        return { ok: false, code: outcome.code };
    };
    return {
        tools: input.tools,
        execute,
        grant: input.grant,
        monotonicNow: input.monotonicNow,
    };
}
