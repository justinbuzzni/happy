import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    applyExecutorNetwork,
    createNetworkCommandRunner,
    spawnExecutorHelper,
    createToolExecutor,
    executorLinkAddresses,
    DENY_CIDRS_V4,
    DENY_CIDRS_V6,
    planToolExecutorIsolation,
    type ExecutorProcess,
    type ToolExecutorDeps,
} from './toolExecutor';

const BASE = {
    identity: { uid: 10602, gid: 10600 },
    providerIdentity: { uid: 10601, gid: 10601 },
};

describe('tool executor isolation plan', () => {
    it('runs as a different uid from the provider', () => {
        expect(planToolExecutorIsolation(BASE).identity).toEqual({ uid: 10602, gid: 10600 });
        expect(() => planToolExecutorIsolation({
            ...BASE, identity: { uid: 10601, gid: 10601 },
        })).toThrow(/must not share the provider uid/);
    });

    it('never runs privileged', () => {
        expect(() => planToolExecutorIsolation({ ...BASE, identity: { uid: 0, gid: 0 } }))
            .toThrow(/unprivileged/);
    });

    it('starts in the workspace root and inherits no descriptors', () => {
        const plan = planToolExecutorIsolation(BASE);
        expect(plan.cwd).toBe('/workspace/project');
        // 하나라도 남기면 그것이 provider 자격으로 가는 통로가 된다.
        expect(plan.inheritFds).toEqual([]);
    });

    it('asks for its own pid, mount and network namespaces', () => {
        expect(planToolExecutorIsolation(BASE).namespaces)
            .toEqual({ pid: true, mount: true, net: true });
    });

    it('carries no credential-shaped environment', () => {
        for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'SESSION_SECRET', 'HAPPY_HOME_DIR']) {
            expect(() => planToolExecutorIsolation({ ...BASE, env: { PATH: '/usr/bin', [key]: 'x' } }))
                .toThrow(/must not carry/);
        }
        expect(planToolExecutorIsolation(BASE).env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin' });
    });

    it('allows the public internet but denies private, link-local, CGNAT and metadata', () => {
        const plan = planToolExecutorIsolation(BASE);
        expect(plan.network.allowPublicInternet).toBe(true);
        for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']) {
            expect(plan.network.denyCidrs).toContain(cidr);
        }
        expect(DENY_CIDRS_V4).toContain('100.64.0.0/10');
    });

    it('denies the same targets over IPv6, including v4-mapped forms', () => {
        const plan = planToolExecutorIsolation(BASE);
        // v6 를 막지 않으면 같은 목적지에 v6 로 닿는다.
        for (const cidr of ['fc00::/7', 'fe80::/10', '::ffff:169.254.0.0/112']) {
            expect(plan.network.denyCidrs6).toContain(cidr);
        }
        expect(DENY_CIDRS_V6.length).toBeGreaterThan(3);
    });

    it('opens no loopback port at all, and no raw or unix sockets', () => {
        const plan = planToolExecutorIsolation(BASE);
        // broker 가 executor 를 부르는 방향이다. 도구가 broker 로 되돌아올
        // 경로는 열지 않는다.
        expect(plan.network.allowLoopbackPorts).toEqual([]);
        expect(plan.network.allowRawSockets).toBe(false);
        expect(plan.network.allowUnixSockets).toBe(false);
    });
});


/**
 * 아래는 계획이 아니라 **실행 경로**를 본다. helper 자체는 Linux 에서만
 * 돌아가므로 여기서는 helper 프로세스를 대역으로 두고, 제품이 helper 에게
 * **무엇을 언제** 시키는지를 고정한다 — 순서가 어긋나면 규칙 없는 구간이나
 * 취소된 실행이 생긴다. helper 안에서 실제로 격리가 서는지는
 * `docker/managed-launch/verify-p4-isolation.sh` 가 실기로 판정한다.
 */
function fakeProcess(overrides: Partial<ExecutorProcess> & { events: string[] }): ExecutorProcess {
    const { events } = overrides;
    return {
        ack: Promise.resolve({ pid: 4242, status: 'ack=setup-complete pid=4242' }),
        release: () => { events.push('release'); },
        abort: () => { events.push('abort'); },
        write: () => { events.push('write'); },
        settled: Promise.resolve({ exitCode: 0, stdout: 'done', status: '' }),
        ...overrides,
    };
}

const clock = { value: 0 };

function harness(overrides: Partial<ToolExecutorDeps> = {}) {
    clock.value = 0;
    const events: string[] = [];
    let argv: string[] = [];
    const deps: ToolExecutorDeps = {
        helperPath: '/usr/local/lib/saycode/executorHelper',
        workloadPath: '/usr/local/lib/saycode/toolRunner',
        cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
        spawn: (input) => { argv = input.argv; events.push('spawn'); return fakeProcess({ events }); },
        applyNetwork: async ({ budgetMs }) => {
            events.push(`network:${budgetMs > 0 ? 'budgeted' : 'no-budget'}`);
            return { ok: true, teardown: () => { events.push('teardown'); return { cleaned: true, detail: 'clean' }; } };
        },
        killCgroup: async () => { events.push('kill-cgroup'); return { proven: true, detail: 'cgroup-empty' }; },
        monotonicNow: () => clock.value,
        ...overrides,
    };
    return { deps, events, argv: () => argv };
}

const CALL = { name: 'read_file', arguments: { path: 'a.txt' } };

describe('tool executor run', () => {
    it('applies the network policy while the child is still parked', async () => {
        const { deps, events } = harness();
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(outcome).toMatchObject({ ok: true, content: 'done', hostCleanup: 'ok' });
        // 놓아준 뒤에 규칙을 넣으면 이미 도는 도구가 규칙 없이 나간다.
        expect(events).toContain('network:budgeted');
        expect(events.indexOf('network:budgeted')).toBeLessThan(events.indexOf('release'));
    });

    it('binds the child to the supervisor generation cgroup', async () => {
        const { deps, argv } = harness();
        await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(argv()).toContain('/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0');
        // 상속시킬 fd 가 없다는 것이 helper 인자에 그대로 실린다.
        expect(argv()[5]).toBe('0');
    });

    it('re-checks the grant after the child is parked and never releases a cancelled call', async () => {
        const { deps, events } = harness();
        let calls = 0;
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            // 첫 검증은 통과하고, park 사이에 폐기된 상황.
            recheckGrant: () => (++calls === 1 ? { ok: true } : { ok: false }),
        });
        expect(outcome).toMatchObject({ ok: false, code: 'tool-unavailable' });
        expect(events).toContain('abort');
        expect(events).toContain('kill-cgroup');
        expect(events).not.toContain('release');
    });

    it('does not spawn at all when the grant is already gone', async () => {
        const { deps, events } = harness();
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: false }),
        });
        expect(outcome).toEqual({ ok: false, code: 'tool-unavailable' });
        expect(events).toEqual([]);
    });

    it('refuses to run when the network policy could not be applied', async () => {
        const { deps, events } = harness({ applyNetwork: async () => ({ ok: false, teardown: () => ({ cleaned: true, detail: 'clean' }) }) });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(outcome).toMatchObject({ ok: false, code: 'execution-failed' });
        expect(events).not.toContain('release');
    });

    it('cancels a long call through the cgroup, not a signal', async () => {
        const events: string[] = [];
        let settle: (value: { exitCode: number | null; stdout: string; status: string }) => void = () => {};
        const { deps } = harness({
            spawn: () => fakeProcess({
                events,
                settled: new Promise((resolve) => { settle = resolve; }),
            }),
            killCgroup: async () => {
                events.push('kill-cgroup');
                // cgroup.kill 이 실제로 프로세스를 끝낸 결과.
                settle({ exitCode: null, stdout: '', status: '' });
                return { proven: true, detail: 'cgroup-empty' };
            },
        });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 5,
            recheckGrant: () => ({ ok: true }),
        });
        // 정지가 증명됐다는 것까지 함께 본다.
        expect(outcome).toMatchObject({
            ok: false, code: 'execution-timeout', cancelProven: true, cancelDetail: 'cgroup-empty',
        });
        expect(events).toContain('kill-cgroup');
    });
});

describe('tool executor preparation budget and cancellation proof', () => {
    it('re-checks the grant once more between the network setup and the release', async () => {
        const { deps, events } = harness();
        let checks = 0;
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            // 입구·park 직후는 통과하고, 네트워크 설정을 마친 뒤 폐기된다.
            recheckGrant: () => ({ ok: ++checks < 3 }),
        });
        expect(outcome.ok).toBe(false);
        expect(outcome).toMatchObject({ code: 'tool-unavailable' });
        expect(events).toContain('network:budgeted');
        expect(events).not.toContain('release');
    });

    it('gives up when preparation as a whole runs past its budget', async () => {
        const { deps, events } = harness({
            applyNetwork: async () => {
                // 네트워크 설정이 예산을 다 써 버린 경우.
                clock.value += 5_000;
                return { ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) };
            },
        });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            prepareTimeoutMs: 1_000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(outcome).toMatchObject({ code: 'execution-failed' });
        expect(events).not.toContain('release');
    });

    it('reports an unproven cancellation instead of calling it stopped', async () => {
        const events: string[] = [];
        let settle: (value: { exitCode: number | null; stdout: string; status: string }) => void = () => {};
        const { deps } = harness({
            spawn: () => fakeProcess({ events, settled: new Promise((resolve) => { settle = resolve; }) }),
            killCgroup: async () => {
                settle({ exitCode: null, stdout: '', status: '' });
                // 프로세스가 남아 있는데 성공으로 보고하면 취소가 취소가 아니다.
                return { proven: false, detail: 'still-populated' };
            },
        });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 5,
            recheckGrant: () => ({ ok: true }),
        });
        expect(outcome).toMatchObject({
            ok: false, code: 'execution-timeout', cancelProven: false, cancelDetail: 'still-populated',
        });
    });

    it('tears the host-side link and NAT rule down after the call', async () => {
        const { deps, events } = harness();
        await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(events).toContain('teardown');
    });
});

describe('executor network policy commands', () => {
    function record() {
        const argv: string[][] = [];
        const budgets: number[] = [];
        const run = (limits: { budgetMs: number }) => {
            budgets.push(limits.budgetMs);
            return (command: string[]) => { argv.push(command); return { ok: true }; };
        };
        return { argv, budgets, run };
    }

    it('blocks the gateway address itself as a destination', () => {
        const { argv, run } = record();
        const outcome = applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7],
        });
        expect(outcome.ok).toBe(true);
        const { hostAddress } = executorLinkAddresses(7);
        // 게이트웨이는 다음 홉으로만 쓴다. 목적지로 열리면 호스트 서비스가 열린다.
        expect(argv.some((command) => command.includes('OUTPUT') && command.includes(`${hostAddress}/32`)))
            .toBe(true);
    });

    it('moves to another slot when the address is already taken', () => {
        const taken = executorLinkAddresses(7).hostAddress;
        const argv: string[][] = [];
        const run = () => (command: string[]) => {
            argv.push(command);
            return { ok: !(command[1] === 'addr' && command.includes(`${taken}/30`)) };
        };
        const outcome = applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7, 8],
        });
        expect(outcome.ok).toBe(true);
        expect(argv.some((command) => command.includes(`${executorLinkAddresses(8).hostAddress}/30`))).toBe(true);
    });

    it('never deletes a link another run owns', () => {
        const argv: string[][] = [];
        const run = () => (command: string[]) => {
            argv.push(command);
            // 7 번 칸의 링크는 이미 다른 실행이 갖고 있다.
            return { ok: !(command[1] === 'link' && command[2] === 'add' && command[3] === 'veth-h7') };
        };
        const outcome = applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7, 8],
        });
        expect(outcome.ok).toBe(true);
        // 남의 링크를 지우면 그 실행의 네트워크가 끊긴다.
        expect(argv.some((c) => c[1] === 'link' && c[2] === 'del' && c[3] === 'veth-h7')).toBe(false);
    });

    it('removes the NAT rule and the link on teardown', () => {
        const { argv, run } = record();
        applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7],
        }).teardown();
        expect(argv.some((command) => command.includes('-D') && command.includes('POSTROUTING'))).toBe(true);
        expect(argv.some((command) => command[1] === 'link' && command[2] === 'del')).toBe(true);
    });
});

describe('bounded termination', () => {
    it('returns even when the process never settles after an unproven cancellation', async () => {
        const events: string[] = [];
        const { deps } = harness({
            // 끝나지 않는 프로세스. cgroup.kill 이 듣지 않는 상황이다.
            spawn: () => fakeProcess({ events, settled: new Promise(() => {}) }),
            killCgroup: async () => ({ proven: false, detail: 'still-populated' }),
        });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 5,
            terminationWaitMs: 50,
            recheckGrant: () => ({ ok: true }),
        });
        // 영원히 기다리면 broker 의 이 호출도, 그 위 lifecycle 도 함께 멈춘다.
        expect(outcome).toMatchObject({
            ok: false, code: 'execution-timeout', cancelProven: false, cancelDetail: 'termination-unobserved',
        });
    });
});

describe('commands and pipes that never behave', () => {
    it('kills a network command that never returns instead of hanging the runtime', () => {
        const started = Date.now();
        // 진짜로 돌아오지 않는 명령. spawnSync 는 기본값이면 영원히 기다린다.
        const outcome = createNetworkCommandRunner({ budgetMs: 800 })(['/bin/sleep', '30']);
        const elapsed = Date.now() - started;
        expect(outcome.ok).toBe(false);
        expect(elapsed).toBeLessThan(5_000);
    });

    it('survives a real EPIPE from a helper that exits right after its ACK', async () => {
        // 실제 프로세스로 재현한다: ACK 만 내고 stdin 을 읽지 않고 곧바로 끝난다.
        const dir = mkdtempSync(join(tmpdir(), 'p4-helper-'));
        const helper = join(dir, 'helper.sh');
        writeFileSync(helper, '#!/bin/sh\necho "ack=setup-complete pid=4242" >&3\nexit 0\n', { mode: 0o755 });
        let observedPipeError = false;
        // 파이프 오류는 경주다. 한 번도 겪지 못하면 이 테스트는 아무것도
        // 증명하지 못하므로, 실제로 겪을 때까지 시도하고 못 겪으면 실패시킨다.
        for (let attempt = 0; attempt < 30 && !observedPipeError; attempt++) {
            const child = spawnExecutorHelper(helper, { argv: [], env: { PATH: '/usr/bin:/bin' } });
            const acked = await child.ack;
            expect(acked.pid).toBe(4242);
            // 이미 죽은 자식에게 쓴다. 예전에는 여기서 온 비동기 EPIPE 가
            // 프로세스를 죽였다 — try/catch 로도 잡히지 않는 자리다.
            child.release();
            child.write('{"name":"read_file"}');
            const settled = await child.settled;
            expect(settled.exitCode).toBe(0);
            if (settled.status.includes('pipe=')) observedPipeError = true;
        }
        expect(observedPipeError).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('host cleanup has its own budget', () => {
    /**
     * 실제 구현과 같은 방식의 실행기 공장: **호출 시점의 시계**로 deadline 을
     * 정하고, 시계가 그것을 지나면 아무 명령도 내지 않는다. 예산을 공유하는
     * 구현이면 시계를 앞으로 돌린 뒤의 정리가 통째로 비게 된다.
     */
    function clockedFactory(argv: string[][], clock: { ms: number }, spendPerCommandMs = 0) {
        return (limits: { budgetMs: number }) => {
            const deadline = clock.ms + limits.budgetMs;
            return (command: string[]) => {
                if (clock.ms >= deadline) return { ok: false };
                clock.ms += spendPerCommandMs;
                argv.push(command);
                return { ok: true };
            };
        };
    }

    it('tears down even after the tool ran longer than the preparation budget', () => {
        const argv: string[][] = [];
        const clock = { ms: 0 };
        const network = applyExecutorNetwork(clockedFactory(argv, clock), {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 10_000, slots: [7],
        });
        expect(network.ok).toBe(true);
        argv.length = 0;
        // 도구가 준비 예산(10초)보다 오래 돈다. 준비 deadline 은 이미 지났다.
        clock.ms += 40_000;
        // 정리는 **자기 예산**으로 시작한다. 준비 예산을 나눠 쓰면 여기서
        // 아무 명령도 나가지 않아 veth 와 NAT 규칙이 남는다.
        const cleanup = network.teardown();
        expect(cleanup).toEqual({ cleaned: true, detail: 'clean' });
        expect(argv.some((c) => c.includes('POSTROUTING') && c.includes('-D'))).toBe(true);
        expect(argv.some((c) => c[1] === 'link' && c[2] === 'del')).toBe(true);
    });

    it('cleans up the namespace when preparation itself times out', () => {
        const argv: string[][] = [];
        // 준비 예산이 두 명령 만에 바닥난다 — 실제 시한 초과와 같은 모양이다.
        const clock = { ms: 0 };
        // 준비 예산이 두 명령 만에 지난다 — 실제 시한 초과와 같은 모양이다.
        const network = applyExecutorNetwork(clockedFactory(argv, clock, 500), {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 1_000, slots: [7],
        });
        expect(network.ok).toBe(false);
        // 이름과 링크가 남으면 다음 실행이 그 칸을 못 쓴다.
        expect(argv.some((c) => c[1] === 'netns' && c[2] === 'delete')).toBe(true);
        expect(argv.some((c) => c[1] === 'link' && c[2] === 'del')).toBe(true);
    });

    it('reports a setup-time cleanup failure instead of claiming it was clean', () => {
        const argv: string[][] = [];
        const clock = { ms: 0 };
        // 준비도 정리도 실패하는 경우. 여기서 `cleaned: true` 를 지어내면
        // 남은 veth 와 netns 가 아무에게도 보고되지 않는다.
        // 주소까지는 잡히고 그 다음 설정 단계에서 실패한다. 되돌리기도 실패한다.
        const failing = () => (command: string[]) => {
            argv.push(command);
            const joined = command.join(' ');
            const ok = joined.startsWith('ip netns attach')
                || joined.startsWith('ip link add')
                || command[1] === 'addr';
            return { ok };
        };
        const network = applyExecutorNetwork(failing, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 1_000, slots: [7],
        });
        expect(network.ok).toBe(false);
        expect(network.teardown().cleaned).toBe(false);
    });

    it('reports a cleanup that did not succeed instead of assuming it did', async () => {
        const events: string[] = [];
        const { deps } = harness({
            applyNetwork: async () => ({
                ok: true,
                teardown: () => ({ cleaned: false, detail: 'left-behind:2' }),
            }),
        });
        const outcome = await createToolExecutor(deps).run({
            plan: planToolExecutorIsolation(BASE), call: CALL, timeoutMs: 1000,
            recheckGrant: () => ({ ok: true }),
        });
        expect(outcome).toMatchObject({ ok: true, hostCleanup: 'failed' });
        expect(events).not.toContain('teardown');
    });
});

describe('cleanup failures accumulate across slots', () => {
    it('does not report a clean teardown when an earlier slot left a link behind', () => {
        const argv: string[][] = [];
        // 7 번 칸: 링크는 만들어지지만 주소가 이미 쓰여 실패하고, 그 링크를
        // 지우는 것도 실패한다. 8 번 칸은 정상으로 잡힌다.
        const run = () => (command: string[]) => {
            argv.push(command);
            const joined = command.join(' ');
            if (joined === 'ip addr add 10.255.0.29/30 dev veth-h7') return { ok: false };
            if (joined === 'ip link del veth-h7') return { ok: false };
            return { ok: true };
        };
        const network = applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7, 8],
        });
        // 두 번째 칸으로 넘어가 준비 자체는 성공한다.
        expect(network.ok).toBe(true);
        // 그래도 7 번 칸의 veth 는 호스트에 남아 있다. 성공으로 접으면 그 자원이
        // 아무에게도 보고되지 않고 다음 실행이 그 칸을 영영 못 쓴다.
        expect(network.teardown()).toEqual({ cleaned: false, detail: 'left-behind:1' });
    });

    it('reports the namespace name it could not remove', () => {
        const argv: string[][] = [];
        const run = () => (command: string[]) => {
            argv.push(command);
            // 이름 제거만 실패한다 — 준비 예산이 바닥난 상황과 같은 모양이다.
            return { ok: !(command[1] === 'netns' && command[2] === 'delete') };
        };
        const network = applyExecutorNetwork(run, {
            pid: 1234, policy: planToolExecutorIsolation(BASE).network, budgetMs: 5_000, slots: [7],
        });
        expect(network.ok).toBe(true);
        // 이름이 남았다는 사실이 teardown 결과까지 이어진다.
        expect(network.teardown().cleaned).toBe(false);
    });
});
