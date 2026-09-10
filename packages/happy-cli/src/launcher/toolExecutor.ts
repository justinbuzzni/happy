/**
 * specs/managed-cloud-byos P4 — tool executor.
 *
 * broker 가 넘긴 호출을 **실제로 실행하는 유일한 지점**이다. provider 와 다른
 * UID·PID/mount namespace·network namespace 에서 돌고, provider 의 env·fd·홈에
 * 닿지 못한다.
 *
 * 격리는 **여기서 계획하고 supervisor 의 helper 가 집행한다.** 검증 스크립트가
 * `unshare`/`iptables`/`su` 를 직접 부르면 그건 제품이 아니라 스크립트를 검증하는
 * 것이므로, fixture 는 이 계획을 그대로 실행해야 한다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

export type ExecutorIdentity = {
    uid: number;
    gid: number;
};

export type ExecutorIsolationPlan = {
    /** 강등 대상. provider 와 반드시 다르다. */
    identity: ExecutorIdentity;
    /** 실행 cwd. 언제나 workspace root 다. */
    cwd: string;
    /** 자식 env **전체**. 여기 없는 것은 자식에 없다. */
    env: Record<string, string>;
    /** 상속시킬 fd. 도구 실행에는 아무것도 필요 없다. */
    inheritFds: number[];
    namespaces: {
        /** 다른 프로세스를 보지 못한다. */
        pid: boolean;
        /** 자기 `/proc` 을 새로 마운트한다(hidepid). */
        mount: boolean;
        /** 자기 network namespace. 정책은 아래 `network` 가 정한다. */
        net: boolean;
    };
    network: NetworkPolicy;
};

/**
 * 네트워크 정책.
 *
 * 공개 인터넷은 허용한다 — npm/git 이 막히면 도구가 쓸모없다. 막는 것은
 * **사설 대역·링크로컬·CGNAT·메타데이터**와 raw socket 이다. IPv6 도 같이
 * 막지 않으면 같은 목적지에 v6 로 닿는다.
 */
export type NetworkPolicy = {
    allowPublicInternet: boolean;
    denyCidrs: string[];
    denyCidrs6: string[];
    /*
     * loopback 예외는 **없다**. broker 가 executor 를 부르는 방향이지 그
     * 반대가 아니다 — 호출은 helper 가 물려준 stdin 으로 들어오고 결과는
     * stdout 으로 나간다. 도구에게 broker 로 붙을 경로를 열어주면 도구가
     * 자기 자신을 재귀 호출하거나 다른 run 의 broker 를 두드릴 수 있다.
     */
    allowLoopbackPorts: [];
    allowRawSockets: false;
    allowUnixSockets: false;
};

export const DENY_CIDRS_V4 = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    // 링크로컬과 그 안의 메타데이터 endpoint.
    '169.254.0.0/16',
    // CGNAT. 사설처럼 쓰이는 대역이라 같이 막는다.
    '100.64.0.0/10',
];

export const DENY_CIDRS_V6 = [
    // unique-local
    'fc00::/7',
    // link-local
    'fe80::/10',
    // IPv4-mapped 사설 대역이 v6 로 들어오는 경로
    '::ffff:10.0.0.0/104',
    '::ffff:172.16.0.0/108',
    '::ffff:192.168.0.0/112',
    '::ffff:169.254.0.0/112',
];

export function planToolExecutorIsolation(input: {
    identity: ExecutorIdentity;
    providerIdentity: ExecutorIdentity;
    /** 도구가 쓸 최소 env. 자격은 하나도 들어가지 않는다. */
    env?: Record<string, string>;
}): ExecutorIsolationPlan {
    if (input.identity.uid === input.providerIdentity.uid) {
        // 같은 UID 면 `/proc/<pid>/environ` 과 fd 가 그대로 보인다.
        throw new Error('the tool executor must not share the provider uid');
    }
    if (input.identity.uid <= 0 || input.identity.gid <= 0) {
        throw new Error('the tool executor must run unprivileged');
    }
    const env = { ...(input.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin' }) };
    for (const key of Object.keys(env)) {
        if (/TOKEN|KEY|SECRET|CAPABILITY/i.test(key) || key.startsWith('HAPPY_')) {
            throw new Error(`tool executor env must not carry ${key}`);
        }
    }
    return {
        identity: input.identity,
        cwd: MANAGED_PROJECT_ROOT,
        env,
        // 도구 실행에 물려줄 fd 는 없다. 하나라도 남기면 그것이 통로가 된다.
        inheritFds: [],
        namespaces: { pid: true, mount: true, net: true },
        network: {
            allowPublicInternet: true,
            denyCidrs: DENY_CIDRS_V4,
            denyCidrs6: DENY_CIDRS_V6,
            allowLoopbackPorts: [],
            allowRawSockets: false,
            allowUnixSockets: false,
        },
    };
}

/**
 * ── 여기부터는 계획이 아니라 **실행**이다 ──────────────────────────────
 *
 * 위의 계획을 집행하는 것은 `executorHelper` 다. TS 는 helper 를 띄우고,
 * helper 가 park 된 사이 자식의 netns 에 정책을 넣고, 놓아준다. namespace
 * 진입·`/proc` 재마운트·fd 정리·capability drop·강등은 전부 helper 안에서
 * execve **전에** 끝난다 — TS 가 그중 무엇도 대신하지 않는다.
 *
 * 취소는 signal 이 아니라 **세대 cgroup** 으로 한다. 도구는 다른 UID 라
 * `kill(2)` 이 통하지 않고, PID namespace 안에서 자식을 더 만들면 pid 하나를
 * 죽여도 남는다. helper 가 스스로를 세대 cgroup 에 넣으므로 supervisor 의
 * 세대 fence 와 여기서 거는 시한 취소가 같은 `cgroup.kill` 하나로 처리된다.
 */

/** 도구 출력 상한. 하나의 호출이 임의 크기 응답이 되지 않게 한다. */
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;

/** 호스트 정리에 주는 예산. 준비 예산과 공유하지 않는다. */
export const DEFAULT_CLEANUP_BUDGET_MS = 5_000;

/** 취소 뒤 프로세스 종료를 기다리는 상한. 넘으면 결과를 그대로 돌려준다. */
export const DEFAULT_TERMINATION_WAIT_MS = 10_000;

/** 정지가 관측될 때까지 기다리는 상한. 넘으면 증명되지 않은 것이다. */
export const CANCEL_PROOF_TIMEOUT_MS = 2_000;

/** 준비(ACK + 네트워크 설정) 전체 예산. */
export const DEFAULT_PREPARE_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 경주에만 쓰는 시한. 이긴 쪽이 정해지면 남은 타이머가 프로세스를 붙잡지
 * 않아야 한다. 반대로 **기다림이 목적인** 대기에는 쓰지 않는다 — unref 된
 * 타이머만 남으면 node 가 그 자리에서 조용히 끝나 버린다(실제로 취소 증명
 * 폴링에서 그렇게 아무 출력 없이 종료했다).
 */
function raceDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        (timer as { unref?: () => void }).unref?.();
    });
}

export type ExecutorProcess = {
    /** helper 의 ACK. `pid` 는 **부모 namespace 기준** 자식 pid 다. */
    ack: Promise<{ pid: number | null; status: string }>;
    /** park 를 풀어 execve 시킨다. */
    release: () => void;
    /** release 없이 끝낸다. execve 는 일어나지 않는다. */
    abort: () => void;
    /** 도구 호출 payload 를 자식 stdin 으로 넣는다. */
    write: (payload: string) => void;
    settled: Promise<{ exitCode: number | null; stdout: string; status: string }>;
};

export type ToolExecutorDeps = {
    /** setuid-root 신뢰 helper. */
    helperPath: string;
    /** helper 가 execve 할 도구 runner. `/usr/local/lib/saycode/` 아래여야 한다. */
    workloadPath: string;
    /** 이 실행이 묶일 세대 cgroup 디렉터리. */
    cgroupPath: string;
    spawn: (input: { argv: string[]; env: Record<string, string> }) => ExecutorProcess;
    /**
     * 자식의 netns 에 정책을 집행한다. helper 가 park 된 동안에만 유효하다 —
     * 놓아준 뒤에 넣으면 규칙 없는 구간이 생긴다. 실패하면 실행하지 않는다.
     *
     * 돌려주는 `teardown` 은 호스트에 남는 것(veth, NAT 규칙)을 지운다. 이것을
     * 부르지 않으면 실행마다 규칙이 쌓여 결국 주소가 겹친다.
     */
    applyNetwork: (input: {
        pid: number;
        policy: NetworkPolicy;
        /**
         * 이 설정에 남은 시간. **명령 자체에 걸어야 한다** — `ip` 하나가 돌아오지
         * 않으면 사후에 시간을 재 봐야 이미 늦었고, 그 사이 Node 는 멈춰 있다.
         */
        budgetMs: number;
    }) => Promise<{
        ok: boolean;
        /**
         * 호스트에 남은 것을 지운다. **자기 예산으로 돈다** — 준비 예산을
         * 나눠 쓰면 오래 걸린 정상 실행 뒤에는 남은 시간이 0 이라 정리가 통째로
         * 건너뛰어지고, veth 와 NAT 규칙이 쌓인다.
         */
        teardown: () => { cleaned: boolean; detail: string };
    }>;
    /**
     * 세대 cgroup 을 통째로 죽인다(`cgroup.kill`).
     *
     * **성공을 가정하지 않는다.** 쓰기가 실패했거나 프로세스가 남아 있으면
     * `proven: false` 다 — 죽은 것과 죽이지 못한 것을 같게 보고하면 취소가
     * 취소가 아니게 된다.
     */
    killCgroup: () => Promise<{ proven: boolean; detail: string }>;
    /** 준비 단계 전체에 시한을 거는 단조 시계. */
    monotonicNow: () => number;
};

export type ToolExecutorResult =
    /** `hostCleanup` 은 호스트에 남은 것(veth·NAT)을 지웠는지다. */
    | { ok: true; content: string; hostCleanup?: HostCleanup }
    | {
        ok: false;
        hostCleanup?: HostCleanup;
        code: 'tool-unavailable' | 'execution-failed' | 'execution-timeout';
        /** 취소를 시도한 경우, 실제로 정지가 증명됐는지. */
        cancelProven?: boolean;
        cancelDetail?: string;
    };

/** 실행 직전 재검증의 결과. broker 의 grant 판정을 그대로 받는다. */
export type HostCleanup = 'ok' | 'failed' | 'not-needed';

export type GrantRecheck = () => { ok: true } | { ok: false };

export function createToolExecutor(deps: ToolExecutorDeps) {
    return {
        /**
         * 도구 한 번 실행.
         *
         * grant 는 **두 번** 본다. broker 가 요청을 받은 시점과 helper 가 park
         * 된 시점 사이에 만료·폐기·범위 변경이 들어올 수 있고, 그 사이가 곧
         * 준비 시간이라 짧지 않다. 두 번째 검증 전에는 execve 가 없다.
         */
        async run(input: {
            plan: ExecutorIsolationPlan;
            call: { name: string; arguments: Record<string, unknown> };
            timeoutMs: number;
            /** ACK·네트워크 설정까지 **전부 합친** 준비 시한. */
            prepareTimeoutMs?: number;
            /**
             * 취소 뒤 종료를 기다리는 상한. `cgroup.kill` 이 듣지 않는 프로세스를
             * 무한정 기다리면 이 호출도, 그 위 lifecycle 도 함께 멈춘다.
             */
            terminationWaitMs?: number;
            recheckGrant: GrantRecheck;
        }): Promise<ToolExecutorResult> {
            if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
                return { ok: false, code: 'execution-failed' };
            }
            if (input.plan.cwd !== MANAGED_PROJECT_ROOT) {
                return { ok: false, code: 'execution-failed' };
            }
            if (!input.recheckGrant().ok) return { ok: false, code: 'tool-unavailable' };

            const prepareBudget = input.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
            const terminationWait = input.terminationWaitMs ?? DEFAULT_TERMINATION_WAIT_MS;
            /** 끝나기를 기다리되, 끝나지 않는 것을 기다리지는 않는다. */
            const awaitSettled = () => Promise.race([
                child.settled.then(() => true),
                raceDelay(terminationWait).then(() => false),
            ]);
            const prepareDeadline = deps.monotonicNow() + prepareBudget;
            // 준비가 늦어지는 것도 실행이 늦어지는 것이다. ACK 대기와 네트워크
            // 설정을 각각 재는 대신 **하나의 예산**으로 본다.
            const outOfTime = () => deps.monotonicNow() >= prepareDeadline;

            const child = deps.spawn({
                argv: [
                    // status(3) / release(4) — helper 가 이 자리에서 말하고 기다린다.
                    '3', '4',
                    deps.cgroupPath,
                    String(input.plan.identity.uid),
                    String(input.plan.identity.gid),
                    // 도구에 물려줄 fd 는 없다. stdin/stdout 은 3 번 미만이라
                    // helper 의 정리 대상이 아니다.
                    String(input.plan.inheritFds.length),
                    ...input.plan.inheritFds.map(String),
                    deps.workloadPath,
                ],
                env: input.plan.env,
            });

            let teardownNetwork: (() => { cleaned: boolean; detail: string }) | null = null;
            let hostCleanup: 'ok' | 'failed' | 'not-needed' = 'not-needed';
            const tearDown = () => {
                if (!teardownNetwork) return;
                const outcome = teardownNetwork();
                teardownNetwork = null;
                hostCleanup = outcome.cleaned ? 'ok' : 'failed';
            };
            const giveUp = async (
                code: 'tool-unavailable' | 'execution-failed',
            ): Promise<ToolExecutorResult> => {
                child.abort();
                const proof = await deps.killCgroup();
                tearDown();
                const settledInTime = await awaitSettled();
                return {
                    ok: false,
                    code,
                    cancelProven: proof.proven && settledInTime,
                    cancelDetail: settledInTime ? proof.detail : 'termination-unobserved',
                    hostCleanup,
                };
            };

            const acked = await Promise.race([
                child.ack,
                raceDelay(prepareBudget).then(() => ({ pid: null, status: 'prepare-timeout' })),
            ]);
            if (acked.pid === null || outOfTime()) return giveUp('execution-failed');

            // park 된 사이에 취소됐다면 여기서 끝난다 — execve 는 없었다.
            if (!input.recheckGrant().ok) return giveUp('tool-unavailable');

            // 네트워크는 **놓아주기 전에** 넣는다. 순서가 바뀌면 규칙이 없는
            // 순간에 도구가 이미 돌고 있다.
            const networked = await deps.applyNetwork({
                pid: acked.pid,
                policy: input.plan.network,
                budgetMs: Math.max(1, prepareDeadline - deps.monotonicNow()),
            });
            teardownNetwork = networked.teardown;
            if (!networked.ok || outOfTime()) return giveUp('execution-failed');

            /*
             * 네트워크 설정에도 시간이 걸린다. 놓아주기 **직전에** 한 번 더 본다 —
             * 이 검증과 `release()` 사이에는 아무 대기도 없다.
             */
            if (!input.recheckGrant().ok) return giveUp('tool-unavailable');

            child.release();
            child.write(JSON.stringify({ name: input.call.name, arguments: input.call.arguments }));

            let cancel: Promise<{ proven: boolean; detail: string }> | null = null;
            const deadline = setTimeout(() => {
                // 다른 UID 라 signal 이 통하지 않는다. 세대 cgroup 을 죽인다.
                cancel = deps.killCgroup();
            }, input.timeoutMs);
            (deadline as { unref?: () => void }).unref?.();
            let settled: { exitCode: number | null; stdout: string; status: string } | null;
            try {
                // 취소가 걸린 뒤에는 유계로 기다린다. 그러지 않으면 시한을 건
                // 호출이 시한 없이 매달린다.
                settled = await Promise.race([
                    child.settled,
                    (async () => {
                        await raceDelay(input.timeoutMs + terminationWait);
                        return null;
                    })(),
                ]);
            } finally {
                clearTimeout(deadline);
                tearDown();
            }
            if (cancel !== null) {
                const proof = await (cancel as Promise<{ proven: boolean; detail: string }>);
                return {
                    ok: false,
                    code: 'execution-timeout',
                    cancelProven: proof.proven && settled !== null,
                    cancelDetail: settled === null ? 'termination-unobserved' : proof.detail,
                    hostCleanup,
                };
            }
            if (settled === null) {
                // 시한도 취소도 없이 끝나지 않았다. 무엇이 남았는지 모른다.
                return {
                    ok: false, code: 'execution-failed',
                    cancelProven: false, cancelDetail: 'never-settled', hostCleanup,
                };
            }
            if (settled.exitCode !== 0) return { ok: false, code: 'execution-failed', hostCleanup };
            return { ok: true, content: settled.stdout.slice(0, MAX_TOOL_OUTPUT_BYTES), hostCleanup };
        },
    };
}

/*
 * ── 기본 구현 ─────────────────────────────────────────────────────────
 *
 * 여기부터는 실제 Linux 동작이다. 위의 주입 지점은 테스트용 이음매가 아니라
 * 이 구현을 담는 자리다 — fixture 도 이 구현을 그대로 쓴다.
 */

/** `10.255.<a>.<b>/30` 한 칸. 살아 있는 다른 실행과 겹치면 둘 다 깨진다. */
export function executorLinkAddresses(slot: number): { hostAddress: string; peerAddress: string } {
    const third = (slot >> 6) & 0xff;
    const base = (slot & 0x3f) * 4;
    return { hostAddress: `10.255.${third}.${base + 1}`, peerAddress: `10.255.${third}.${base + 2}` };
}

export const EXECUTOR_LINK_SLOTS = 16384;

/**
 * 자식 netns 에 정책을 집행한다.
 *
 * 새 netns 에는 `lo` 뿐이라 기본이 **차단**이다. 공개 인터넷을 쓰려면 veth 를
 * 놓아야 하고, 그러는 순간 호스트가 속한 사설망이 함께 열린다.
 *
 * 차단은 **목적지 필터**로 한다. 경로 예외(`unreachable`)만 쓰면 기본 경로가
 * 지나는 /30 이 더 긴 접두어로 이겨서 **게이트웨이 주소 자신** — 곧 호스트가
 * 그 주소에서 여는 모든 서비스 — 이 열린 채로 남는다. 실제로 그 구멍이 있었다.
 * 그래서 게이트웨이를 포함한 모든 금지 목적지를 netns 안의 필터로 막고,
 * `unreachable` 경로는 그 위에 겹쳐 둔다.
 *
 * 주소는 살아 있는 다른 실행과 겹치지 않을 때까지 칸을 옮겨 가며 잡는다. pid 로
 * 계산하면 pid 가 순환하는 순간 두 실행이 같은 /30 을 쓴다.
 */
export function applyExecutorNetwork(
    /**
     * 명령 실행기 **공장**. 시한은 실행기가 스스로 집행하고, 정리는 호출 시점에
     * 새 실행기를 받아 **자기 예산**으로 돈다.
     */
    createRun: (input: { budgetMs: number }) => (argv: string[]) => { ok: boolean },
    input: {
        pid: number;
        policy: NetworkPolicy;
        budgetMs: number;
        /** 정리에 주는 예산. 준비 예산과 공유하지 않는다. */
        cleanupBudgetMs?: number;
        slots?: number[];
    },
): { ok: boolean; teardown: () => { cleaned: boolean; detail: string } } {
    const ns = `saycode-tool-${input.pid}`;
    const cleanupBudget = input.cleanupBudgetMs ?? DEFAULT_CLEANUP_BUDGET_MS;
    const run = createRun({ budgetMs: input.budgetMs });
    /**
     * 지우지 못하고 남긴 것들. 중간 정리의 실패도 여기 쌓인다 — 한 번의 결과만
     * 보고 `cleaned: true` 라고 답하면, 앞선 칸에서 남긴 veth 가 아무에게도
     * 보고되지 않는다.
     */
    const residue: string[] = [];
    /** 준비가 실패해도 우리가 만든 것은 우리가 지운다 — 새 예산으로. */
    const cleanup = (steps: string[][]): { cleaned: boolean; detail: string } => {
        const cleanupRun = createRun({ budgetMs: cleanupBudget });
        for (const step of steps) {
            if (!cleanupRun(step).ok) residue.push(step.join(' '));
        }
        return residue.length === 0
            ? { cleaned: true, detail: 'clean' }
            : { cleaned: false, detail: `left-behind:${residue.length}` };
    };
    if (!run(['ip', 'netns', 'attach', ns, String(input.pid)]).ok) {
        // 이름을 붙이지 못했으면 지울 것도 없다 — 이것만이 참인 무조건 성공이다.
        return { ok: false, teardown: () => ({ cleaned: true, detail: 'nothing-created' }) };
    }
    // 이름 제거도 결과를 본다. 준비 예산이 바닥난 채로 부르면 이름이 남고,
    // 그 이름으로 다른 프로세스가 이 namespace 에 들어갈 수 있다.
    const dropNs = () => { cleanup([['ip', 'netns', 'delete', ns]]); };

    const candidates = input.slots ?? Array.from({ length: 64 }, (_, index) => (input.pid + index) % EXECUTOR_LINK_SLOTS);
    for (const slot of candidates) {
        const { hostAddress, peerAddress } = executorLinkAddresses(slot);
        const host = `veth-h${slot}`;
        /** 우리가 만든 링크만. peer 는 링크와 함께 사라진다. */
        const dropSteps = [['ip', 'link', 'del', host]];
        if (!run(['ip', 'link', 'add', host, 'type', 'veth', 'peer', 'name', 'veth-c', 'netns', ns]).ok) {
            /*
             * 이 이름은 **다른 실행이 쓰고 있다**. 여기서 지우면 남의 실행이
             * 네트워크를 잃는다. 만들기에 성공한 링크만 우리 것이다.
             */
            continue;
        }
        // 이미 쓰이는 칸이면 주소 배정이 실패한다. 그것이 곧 충돌 판정이다.
        if (!run(['ip', 'addr', 'add', `${hostAddress}/30`, 'dev', host]).ok) {
            // 이 실패가 시한 초과일 수도 있다. 우리 링크는 **새 예산**으로 지우고,
            // 지우지 못하면 그 사실이 `residue` 에 남아 최종 결과까지 간다.
            cleanup(dropSteps);
            continue;
        }
        const nat = ['-s', `${peerAddress}/32`, '-j', 'MASQUERADE'];
        const steps: string[][] = [
            ['ip', 'link', 'set', host, 'up'],
            ['ip', '-n', ns, 'link', 'set', 'lo', 'up'],
            ['ip', '-n', ns, 'addr', 'add', `${peerAddress}/30`, 'dev', 'veth-c'],
            ['ip', '-n', ns, 'link', 'set', 'veth-c', 'up'],
            ['ip', '-n', ns, 'route', 'add', 'default', 'via', hostAddress],
            // 게이트웨이는 **다음 홉으로만** 쓴다. 목적지로는 막는다 — 이
            // 규칙이 없으면 호스트 서비스가 executor 에게 열린다.
            ['ip', 'netns', 'exec', ns, 'iptables', '-A', 'OUTPUT', '-d', `${hostAddress}/32`, '-j', 'REJECT'],
            ...input.policy.denyCidrs.flatMap((cidr) => [
                ['ip', 'netns', 'exec', ns, 'iptables', '-A', 'OUTPUT', '-d', cidr, '-j', 'REJECT'],
                ['ip', '-n', ns, 'route', 'add', 'unreachable', cidr],
            ]),
            ...input.policy.denyCidrs6.flatMap((cidr) => [
                ['ip', 'netns', 'exec', ns, 'ip6tables', '-A', 'OUTPUT', '-d', cidr, '-j', 'REJECT'],
                ['ip', '-6', '-n', ns, 'route', 'add', 'unreachable', cidr],
            ]),
            ...(input.policy.allowPublicInternet
                ? [['iptables', '-t', 'nat', '-A', 'POSTROUTING', ...nat]]
                : []),
        ];
        for (const step of steps) {
            if (!run(step).ok) {
                /*
                 * 규칙이 반쯤 선 채로는 놓아주지 않는다. 이 실패가 시한 초과일
                 * 수도 있으므로, 정리는 **새 예산**으로 돌린다 — 준비 예산이
                 * 바닥난 채로 정리하면 아무것도 지워지지 않는다.
                 */
                /*
                 * 정리 **결과를 그대로 돌려준다**. 무조건 `cleaned: true` 로
                 * 접으면 실패가 lifecycle 에 닿지 않고 호스트에 자원이 남는다.
                 */
                const cleaned = cleanup([...dropSteps, ['ip', 'netns', 'delete', ns]]);
                return { ok: false, teardown: () => cleaned };
            }
        }
        /*
         * netns 이름을 지운다. namespace 자체는 자식이 살아 있는 한 유지되고,
         * 이름만 사라져 다른 프로세스가 `ip netns exec` 로 들어갈 길이 닫힌다.
         */
        dropNs();
        return {
            ok: true,
            // 남기면 다음 실행이 이 칸을 못 쓰고 NAT 규칙이 쌓인다. 도구가 준비
            // 예산보다 오래 돌았어도 정리는 자기 예산으로 반드시 돈다.
            teardown: () => cleanup([
                ...(input.policy.allowPublicInternet
                    ? [['iptables', '-t', 'nat', '-D', 'POSTROUTING', ...nat]]
                    : []),
                ...dropSteps,
            ]),
        };
    }
    /*
     * 빈 칸이 없거나 준비가 시한을 넘겼다. 실행은 없으므로 **지금** 되돌린다 —
     * 호출자가 teardown 을 부르는지에 맡기면 이름이 남고, 그 이름으로 다른
     * 프로세스가 이 namespace 에 들어갈 수 있다.
     */
    const cleaned = cleanup([['ip', 'netns', 'delete', ns]]);
    return { ok: false, teardown: () => cleaned };
}

/** helper 를 실제로 띄운다. status 는 fd 3, release 는 fd 4 다. */
export function spawnExecutorHelper(
    helperPath: string,
    input: { argv: string[]; env: Record<string, string> },
): ExecutorProcess {
    // 0/1/2 는 도구의 stdin/stdout/stderr 다. helper 의 fd 정리는 3 번부터라
    // 이 셋은 남고, 그 밖의 상속은 없다.
    const child = spawn(helperPath, input.argv, {
        stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
        env: input.env,
    });
    const statusPipe = child.stdio[3];
    const releasePipe = child.stdio[4];

    /*
     * 파이프 오류는 **비동기**로 온다. helper 가 ACK 뒤 곧바로 죽거나 workload
     * 가 stdin 을 읽지 않으면 write 는 그 자리에서 던지지 않고 나중에 'error'
     * (EPIPE) 를 낸다. 구독하지 않으면 그 이벤트가 프로세스를 죽인다 —
     * try/catch 로도 `child.on('error')` 로도 잡히지 않는 자리다.
     */
    let pipeError: string | null = null;
    const swallow = (stream: unknown) => {
        if (stream && typeof (stream as { on?: unknown }).on === 'function') {
            (stream as { on: (event: string, handler: (error: NodeJS.ErrnoException) => void) => void })
                .on('error', (error) => { pipeError ??= error.code ?? 'pipe-error'; });
        }
    };
    swallow(statusPipe);
    swallow(releasePipe);
    swallow(child.stdin);
    swallow(child.stdout);

    let status = '';
    let stdout = '';
    let ackResolve: (value: { pid: number | null; status: string }) => void = () => {};
    const ack = new Promise<{ pid: number | null; status: string }>((resolve) => { ackResolve = resolve; });
    let acked = false;
    const settleAck = (pid: number | null) => {
        if (acked) return;
        acked = true;
        ackResolve({ pid, status });
    };
    if (statusPipe && 'setEncoding' in statusPipe) {
        statusPipe.setEncoding('utf8');
        statusPipe.on('data', (chunk: string) => {
            status += chunk;
            const found = /\bpid=(\d+)\b/.exec(status);
            if (found) settleAck(Number(found[1]));
        });
        statusPipe.on('close', () => settleAck(null));
    } else {
        settleAck(null);
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        if (Buffer.byteLength(stdout, 'utf8') <= MAX_TOOL_OUTPUT_BYTES) stdout += chunk;
    });

    const settled = new Promise<{ exitCode: number | null; stdout: string; status: string }>((resolve) => {
        let done = false;
        const finish = (code: number | null) => {
            // spawn 오류와 close 가 함께 올 수 있다. 정산은 한 번이다.
            if (done) return;
            done = true;
            settleAck(null);
            resolve({ exitCode: code, stdout, status: pipeError ? `${status}\npipe=${pipeError}` : status });
        };
        child.on('close', (code) => finish(code));
        child.on('error', () => finish(null));
    });

    return {
        ack,
        release: () => {
            try { if (releasePipe && 'write' in releasePipe) releasePipe.write('1'); } catch { /* 끊겼으면 helper 가 stage=release 로 죽는다 */ }
        },
        abort: () => {
            try { if (releasePipe && 'end' in releasePipe) releasePipe.end(); } catch { /* 이미 닫혔다 */ }
        },
        write: (payload) => {
            try { child.stdin?.end(payload); } catch { /* 도구가 이미 죽었다 */ }
        },
        settled,
    };
}

/**
 * `ip`/`iptables` 실행기.
 *
 * `spawnSync` 는 기본적으로 **영원히** 기다린다. 그 상태에서 Node 는 이벤트
 * 루프째 멈추므로 시한도 취소도 돌지 않는다. 그래서 남은 예산을 명령마다
 * 나눠 걸고, 넘기면 SIGKILL 로 끝낸다.
 */
export function createNetworkCommandRunner(input: { budgetMs: number; now?: () => number }) {
    const now = input.now ?? Date.now;
    const deadline = now() + input.budgetMs;
    return (argv: string[]): { ok: boolean } => {
        const remaining = deadline - now();
        if (remaining <= 0) return { ok: false };
        const [command, ...args] = argv;
        const outcome = spawnSync(command!, args, {
            stdio: 'ignore',
            timeout: remaining,
            killSignal: 'SIGKILL',
        });
        // 시한 초과면 `status` 는 null 이다. 성공과 구분된다.
        return { ok: outcome.status === 0 };
    };
}

export function defaultToolExecutorDeps(config: {
    helperPath: string;
    workloadPath: string;
    cgroupPath: string;
}): ToolExecutorDeps {
    return {
        ...config,
        spawn: (input) => spawnExecutorHelper(config.helperPath, input),
        applyNetwork: async ({ pid, policy, budgetMs }) => applyExecutorNetwork(
            // 정리는 호출 시점에 **새 시한**을 받는다.
            (limits) => createNetworkCommandRunner(limits),
            { pid, policy, budgetMs },
        ),
        killCgroup: async () => {
            // 다른 UID 의 프로세스 트리를 확실히 끝내는 유일한 수단이다.
            try {
                writeFileSync(join(config.cgroupPath, 'cgroup.kill'), '1');
            } catch {
                // 실패를 "이미 사라졌다" 로 삼키지 않는다. 아래에서 실제로 본다.
            }
            /*
             * 정지의 증거는 쓰기의 성공이 아니라 **비어 있음**이다. `cgroup.kill`
             * 은 신호를 보내고 돌아오므로 그 자리에서 비어 있지 않을 수 있다 —
             * 짧게 다시 본다. 그래도 남아 있으면 정지는 증명되지 않은 것이다.
             */
            const until = Date.now() + CANCEL_PROOF_TIMEOUT_MS;
            let last = 'procs-unreadable';
            for (;;) {
                try {
                    const procs = readFileSync(join(config.cgroupPath, 'cgroup.procs'), 'utf8').trim();
                    if (procs === '') return { proven: true, detail: 'cgroup-empty' };
                    last = 'still-populated';
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        return { proven: true, detail: 'cgroup-gone' };
                    }
                    last = 'procs-unreadable';
                }
                if (Date.now() >= until) return { proven: false, detail: last };
                await delay(20);
            }
        },
        monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
    };
}
