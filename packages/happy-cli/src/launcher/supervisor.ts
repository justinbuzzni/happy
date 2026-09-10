/**
 * specs/managed-cloud-byos §5.36 — root supervisor.
 *
 * 하나의 신뢰 주체가 네 가지를 소유한다: 부트스트랩/위임, 세대 cgroup 의 생성과
 * 종료, helper 를 통한 실행, 그리고 lease watchdog.
 *
 * **supervisor 는 세대 cgroup 에 절대 들어가지 않는다.** 들어가면 그 세대를 향한
 * `cgroup.kill` 이 신뢰 관리자까지 죽이고, 복귀에 실패하면 관리자가 workload 안에
 * 남는다. 프로세스를 세대 안에 넣는 것은 helper 뿐이며, helper 는 자기 PID 를
 * 스스로 기록한 뒤에만 exec 한다.
 *
 * **watchdog 은 daemon 과 무관하게 돈다.** daemon 은 IPC client 일 뿐이고, 그것이
 * 죽어도 lease 만료 집행은 계속돼야 한다 — 그러지 않으면 daemon 을 죽이는 것이
 * 곧 lease 를 무한 연장하는 방법이 된다.
 *
 * 실행 파일·uid·cgroup 경로는 **신뢰 설정**에서만 온다. IPC 호출자는 세대를
 * 지목할 뿐 무엇을 어떤 권한으로 실행할지 고르지 못한다.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { GenerationKey, GenerationManifest } from './generationManifest';

/** 운영이 고정하는 값. IPC 로 들어오지 않는다. */
export type SupervisorConfig = {
    /**
     * child 에게 넘길 환경변수 allowlist. daemon 환경 전체를 상속시키면 이번
     * 실행과 무관한 자격증명이 그대로 따라간다(§5.7).
     */
    envAllowlist?: Record<string, string>;
    /** 위임된 cgroup 루트. 세대는 이 아래에만 만든다. */
    cgroupRoot: string;
    /** helper 실행 파일의 고정 경로 (root 소유, 0500). */
    helperPath: string;
    /** 세대가 실행할 고정 실행 파일. 호출자가 고르지 않는다. */
    workloadPath: string;
    /** 세대 uid/gid 할당기. 재사용 규율은 호출부가 소유한다. */
    resolveGenerationCredentials: (key: GenerationKey) => { uid: number; gid: number };
};

export type SupervisorDeps = {
    manifest: GenerationManifest;
    /** 단조 시계. 벽시계 점프가 lease 를 늘리면 안 된다. */
    monotonicNow: () => number;
    /** watchdog 무장. supervisor 가 release 전에 부른다. */
    enrollWatchdog?: (entry: { key: GenerationKey; leaseExpiresMonotonic: number }) => void;
    now: () => number;
    mkdir: (path: string) => void;
    writeFile: (path: string, data: string) => void;
    readFile: (path: string) => string;
    rmdir: (path: string) => void;
    /**
     * helper 를 root 자식으로 띄우고 **기동 결과만** 돌려준다.
     *
     * workload 가 끝날 때까지 기다리면 안 된다 — 그러면 오래 도는 세대의 기동
     * 결과가 그 세대가 끝날 때까지 오지 않고, watchdog 이 죽여야 할 대상을
     * 아직 "기동 중" 으로 보게 된다.
     */
    /**
     * helper 를 root 자식으로 띄우고 **ACK 시점에** 돌려준다.
     *
     * 그 시점의 자식은 cgroup 안에 있고 권한을 버렸지만 아직 exec 하지 않았다
     * (park). 호출부가 등록을 마친 뒤 `release()` 를 불러야 exec 한다. 이 두
     * 단계를 하나의 호출로 합치면 빠른 workload 의 첫 보고가 등록을 앞지른다.
     */
    launch: (input: {
        helperPath: string;
        argv: string[];
        statusFd: number;
        releaseFd: number;
        /**
         * 상속시킬 fd. **자식 쪽 번호와 부모 쪽 번호는 다르다** — 부모가 방금
         * 연 봉투는 임의 번호이고, 자식은 약속된 번호로 받아야 한다. 번호 하나만
         * 넘기면 자식이 supervisor 의 무관한 fd 를 물려받는다.
         */
        inheritFds: Array<{ childFd: number; parentFd: number }>;
        /** 최종 child env. daemon 환경 전체를 물려주지 않는다. */
        env: Record<string, string>;
    }) => Promise<LaunchHandle>;
};

export type ExecOutcome =
    /**
     * 준비가 끝났고 execve 를 시도했다. **exec 성공의 증명은 아니다** — helper 가
     * ACK 뒤 execve 전에 죽어도 여기까지는 같아 보인다. 실제로 workload 가
     * 돌았다는 증거는 workload 자신의 managed report 에서 온다.
     */
    | { kind: 'exec-attempted'; pid: number | null }
    /** 준비 단계에서 멈췄다. **아무것도 실행되지 않았다.** */
    | { kind: 'setup-refused'; stage: string }
    /** 준비는 끝났지만 execve 가 실패했다. 실행되지 않았다. */
    | { kind: 'exec-failed'; stage: string }
    /** ACK 도 오류 레코드도 없다. 무엇이 일어났는지 모른다. */
    | { kind: 'unknown'; detail: string };

const ACK_PREFIX = 'ack=setup-complete';

/**
 * helper 의 status 기록을 판정한다.
 *
 * **파이프의 EOF 만으로 성공이라고 말하지 않는다.** helper 가 ACK 전에 죽어도
 * EOF 는 온다. ACK 는 준비 완료만 뜻하고, 그 뒤 `stage=exec` 이 있으면 execve 는
 * 실패한 것이다. 세 경우를 구분하지 않으면 실패를 성공으로 보고하게 된다.
 */
export function classifyHelperStatus(input: {
    status: string;
    pid: number | null;
}): ExecOutcome {
    const lines = input.status.split('\n').map((line) => line.trim()).filter(Boolean);
    const ackLine = lines.find((line) => line.startsWith(ACK_PREFIX));
    const acked = ackLine !== undefined;
    const stageLine = lines.find((line) => line.startsWith('stage='));
    if (stageLine) {
        const stage = stageLine.split(/\s+/)[0]!.slice('stage='.length);
        // ACK 뒤의 오류는 준비가 아니라 execve 가 실패한 것이다.
        return acked
            ? { kind: 'exec-failed', stage }
            : { kind: 'setup-refused', stage };
    }
    if (!acked) return { kind: 'unknown', detail: 'no-ack-no-stage' };
    // helper 가 실은 pid 를 우선한다. spawn 이 돌려준 pid 와 다르면 그 자체가 신호다.
    const reported = /\bpid=(\d+)\b/.exec(ackLine ?? '');
    const pid = reported ? Number(reported[1]) : input.pid;
    return { kind: 'exec-attempted', pid: Number.isSafeInteger(pid) ? pid : null };
}

export function generationCgroupPath(root: string, key: GenerationKey): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key.runId) || !/^[A-Za-z0-9_-]{1,200}$/.test(key.attemptId)) {
        throw new Error('generation cgroup requires safe id segments');
    }
    if (!Number.isSafeInteger(key.epoch) || key.epoch < 0) {
        throw new Error('generation cgroup requires a non-negative safe epoch');
    }
    return join(root, `run-${key.runId}`, `attempt-${key.attemptId}`, `epoch-${key.epoch}`);
}

/**
 * 두 supervisor 가 같은 원장·cgroup 을 쓰면 재조정이 서로의 세대를 지운다.
 *
 * Linux abstract-namespace 소켓으로 소유권을 표현한다. 이름 앞의 NUL 이
 * 추상 네임스페이스를 고르고, 홀더가 죽는 순간 커널이 즉시 회수하므로 stale
 * 판정 자체가 없다(파일 락과 달리 남는 것이 없다). 두 번째 bind 는 EADDRINUSE 다.
 */
export function supervisorLockAddress(input: {
    runtimeId: string;
    manifestRoot: string;
    cgroupRoot: string;
}): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.runtimeId)) {
        throw new Error('supervisor lock requires a safe runtimeId');
    }
    /*
     * 이름을 runtimeId 로만 만들면 **같은 원장과 같은 cgroup 을 다른 id 로**
     * 여는 두 supervisor 가 서로를 막지 못한다. 잠금은 물리 자원에 걸려야 한다.
     * 경로는 심볼릭 링크를 해소해 비교한다 — 다른 이름의 같은 디렉터리가
     * 다른 자원처럼 보이면 안 된다.
     */
    const physical = [input.manifestRoot, input.cgroupRoot].map((path) => {
        try {
            return realpathSync(path);
        } catch {
            // 아직 없는 경로도 이름 그대로 자원 식별에 쓴다.
            return resolve(path);
        }
    });
    /*
     * digest 에 runtimeId 를 넣지 않는다. 넣으면 같은 원장·cgroup 을 다른 id 로
     * 여는 두 supervisor 가 다른 이름을 얻어 나란히 돈다 — 막으려던 바로 그 일이다.
     * runtimeId 는 위에서 형태만 확인하고, 잠금은 **물리 자원**에만 건다.
     */
    const digest = createHash('sha256')
        .update(JSON.stringify(physical))
        .digest('hex')
        .slice(0, 32);
    return `\0saycode-supervisor:${digest}`;
}

export async function acquireSupervisorLock(input: {
    runtimeId: string;
    manifestRoot: string;
    cgroupRoot: string;
}): Promise<
    { ok: true; release: () => Promise<void> } | { ok: false; reason: string }
> {
    // 추상 네임스페이스는 Linux 에만 있다. managed 런타임도 Linux 전용이므로
    // 다른 곳에서는 잠금을 흉내내지 않고 그 사실을 그대로 말한다.
    if (process.platform !== 'linux') return { ok: false, reason: 'not-linux' };
    const server = createServer();
    return new Promise((resolve) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
            resolve({ ok: false, reason: error.code === 'EADDRINUSE' ? 'already-held' : 'bind-failed' });
        });
        server.listen(supervisorLockAddress(input), () => {
            resolve({
                ok: true,
                release: () => new Promise<void>((done) => { server.close(() => done()); }),
            });
        });
    });
}

export type LaunchHandle = {
    /** helper 자신이 보고한 PID. caller 가 준 값이 아니다. */
    pid: number | null;
    /** exec 을 허락한다. 한 번만 유효하다. */
    release: () => void;
    /** 놓아주지 않고 끝낸다. helper 는 exec 없이 죽는다. */
    abort: () => void;
    /** helper 가 할 말을 다 한 뒤의 결과. */
    settled: Promise<{ status: string; pid: number | null }>;
};

export type StopOutcome =
    | { stopped: true; observedEmptyAt: number }
    /** 죽이라고 했지만 비었음을 관측하지 못했다. 정지로 취급하지 않는다. */
    | { stopped: false; detail: string };

export function createSupervisor(config: SupervisorConfig, deps: SupervisorDeps) {
    const generation = (key: GenerationKey) => generationCgroupPath(config.cgroupRoot, key);
    /** 세대별 마지막 renewalSeq. 재시작하면 비므로 lease 는 무조건 만료다(§5.3). */
    const leases = new Map<string, number>();
    /** 세대별 **현재 deadline**. seq 만 들고 있으면 갱신이 아무 효과가 없다. */
    const deadlines = new Map<string, number>();
    const inFlight = new Set<string>();
    const leaseId = (key: GenerationKey) => JSON.stringify([key.runId, key.attemptId, key.epoch]);
    // watchdog 등록은 supervisor 가 소유한다. 호출부가 따로 무장하면 등록되지 않은
    // 세대가 생긴다.
    const enroll = (entry: { key: GenerationKey; leaseExpiresMonotonic: number }) => {
        deps.enrollWatchdog?.(entry);
    };

    /**
     * 세대를 정지시키고 **비었음을 관측**한다.
     *
     * `cgroup.kill` 은 요청이고 `populated 0` 은 관측이다. 둘을 같은 것으로 쓰면
     * 죽지 않은 세대 위에 새 writer 를 연다. 디렉터리 제거까지 성공해야 커널이
     * "비었다" 를 확인해 준 것이다 — 비어 있지 않으면 rmdir 이 EBUSY 다.
     */
    function stopGeneration(key: GenerationKey): StopOutcome {
        const path = generation(key);
        // kill 보다 **먼저** 요청을 남긴다. 요청과 관측 사이에서 죽으면 그 사실이
        // 기록에 남아, 나중에 cgroup 이 없다는 것이 "치웠다" 로 읽히지 않는다.
        try {
            deps.manifest.recordTerminationRequested({ key, requestedAt: deps.now() });
        } catch {
            // 의도를 남기지 못했으면 kill 도 하지 않는다. 그리고 이 실패는
            // 위 허용 목록에서 `record-unreadable` 로 이어져 release/renew 도
            // 막는다 — 정지에 실패한 상태가 새 권한을 주는 일은 없다.
            return { stopped: false, detail: 'manifest-unwritable' };
        }
        try {
            deps.writeFile(join(path, 'cgroup.kill'), '1');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            // 디렉터리가 이미 없다면 이 프로세스가 아는 근거가 없다.
            if (code === 'ENOENT') return { stopped: false, detail: 'generation-absent' };
            return { stopped: false, detail: 'kill-request-failed' };
        }
        let events: string;
        try {
            events = deps.readFile(join(path, 'cgroup.events'));
        } catch {
            return { stopped: false, detail: 'events-unreadable' };
        }
        if (!/^populated 0$/m.test(events)) return { stopped: false, detail: 'still-populated' };
        try {
            deps.rmdir(path);
        } catch {
            // 커널이 아직 비었다고 보지 않는다.
            return { stopped: false, detail: 'rmdir-refused' };
        }
        const observedEmptyAt = deps.now();
        deps.manifest.recordTermination({ key, observedEmptyAt });
        return { stopped: true, observedEmptyAt };
    }

    return {
        generationCgroup: generation,

        /**
         * 신뢰 실행. 호출자는 세대만 지목하고, 무엇을 어떤 권한으로 돌릴지는
         * 설정이 정한다.
         */
        /**
         * 1단계: 세대를 준비해 자식을 park 시킨다.
         *
         * 돌려주는 것은 helper 가 스스로 보고한 PID 와 **일회용 handle** 이다.
         * caller 가 준 PID·uid·경로는 어디에도 쓰지 않는다.
         */
        async prepareLaunch(input: {
            key: GenerationKey;
            /** 자식이 받을 fd 와 그 자리에 붙일 부모 fd. */
            inherit?: Array<{ childFd: number; parentFd: number }>;
            statusFd: number;
            releaseFd: number;
            leaseExpiresMonotonic: number;
        }): Promise<
            | { kind: 'parked'; pid: number | null; handle: LaunchHandle }
            | ExecOutcome
        > {
            const path = generation(input.key);
            const credentials = config.resolveGenerationCredentials(input.key);
            const inherit = input.inherit ?? [];
            const keep = inherit.map((entry) => entry.childFd);
            const id = leaseId(input.key);
            if (inFlight.has(id)) return { kind: 'setup-refused', stage: 'already-launching' };
            if (input.statusFd === input.releaseFd
                || keep.includes(input.statusFd) || keep.includes(input.releaseFd)) {
                return { kind: 'setup-refused', stage: 'args' };
            }
            if (!Number.isSafeInteger(input.leaseExpiresMonotonic)
                || input.leaseExpiresMonotonic <= deps.monotonicNow()) {
                return { kind: 'setup-refused', stage: 'lease-already-expired' };
            }
            // 원장에 먼저 남긴다. helper 를 띄운 뒤 기록하면 그 사이 죽은 세대가
            // 재시작 재조정에서 보이지 않는다.
            const launched = deps.manifest.recordLaunch({ key: input.key, launchedAt: deps.now() });
            if (!launched.ok) return { kind: 'setup-refused', stage: launched.reason };
            // cgroup 이 없으면 helper 는 `stage=cgroup` 으로 죽는다. 원장에
            // 기록한 세대는 반드시 실재해야 한다.
            try {
                deps.mkdir(path);
            } catch {
                inFlight.delete(id);
                return { kind: 'setup-refused', stage: 'cgroup-create-failed' };
            }
            inFlight.add(id);
            let handle: LaunchHandle;
            try {
                handle = await deps.launch({
                    helperPath: config.helperPath,
                    argv: [
                        String(input.statusFd),
                        String(input.releaseFd),
                        path,
                        String(credentials.uid),
                        String(credentials.gid),
                        String(keep.length),
                        ...keep.map(String),
                        config.workloadPath,
                    ],
                    statusFd: input.statusFd,
                    releaseFd: input.releaseFd,
                    inheritFds: inherit,
                    env: { ...(config.envAllowlist ?? {}) },
                });
            } catch {
                inFlight.delete(id);
                return { kind: 'unknown', detail: 'launch-failed' };
            }
            if (handle.pid === null) {
                handle.abort();
                inFlight.delete(id);
                const settled = await handle.settled;
                return classifyHelperStatus({ status: settled.status, pid: settled.pid });
            }
            // park 된 지금 감시를 건다. release 는 그 다음이다.
            deadlines.set(id, input.leaseExpiresMonotonic);
            enroll({ key: input.key, leaseExpiresMonotonic: input.leaseExpiresMonotonic });
            return { kind: 'parked', pid: handle.pid, handle };
        },

        /** 2단계: 등록이 끝났으니 놓아준다. lease 를 여기서 한 번 더 본다. */
        async releaseLaunch(input: {
            key: GenerationKey;
            handle: LaunchHandle;
            leaseExpiresMonotonic: number;
        }): Promise<ExecOutcome> {
            const id = leaseId(input.key);
            try {
                /*
                 * 준비와 release 사이에 취소가 들어올 수 있다. `requestStop` 은
                 * 의도를 원장에 남기지만 `cgroup.kill` 은 park 된 helper 를
                 * 죽이지 못할 수도 있다(아직 exec 전이라 다른 uid 로 살아 있다).
                 * 그때 release 를 그대로 내보내면 **취소된 세대가 실행된다.**
                 * 그래서 원장 상태를 먼저 본다.
                 */
                /*
                 * **허용 목록으로 판정한다.** 거부 목록을 쓰면 목록에 없는 상태가
                 * 통과한다 — 읽지 못한 기록(`record-unreadable`)이 정확히 그
                 * 경우였고, 그때 이 세대가 취소됐는지 알 수 없는데도 놓아줬다.
                 * 놓아줘도 되는 상태는 "띄웠고 아직 종료를 관측하지 못함" 하나뿐이다.
                 */
                const proof = deps.manifest.proveStopped(input.key);
                const open = !proof.proven && proof.detail === 'termination-unknown';
                if (!open) {
                    input.handle.abort();
                    await input.handle.settled;
                    return {
                        kind: 'setup-refused',
                        stage: proof.proven ? 'already-stopped' : proof.detail,
                    };
                }
                // 갱신된 deadline 이 있으면 그것이 권위다.
                const current = deadlines.get(id) ?? input.leaseExpiresMonotonic;
                // 준비가 오래 걸려 그 사이 lease 가 지났다면 놓아주지 않는다.
                if (current <= deps.monotonicNow()) {
                    input.handle.abort();
                    await input.handle.settled;
                    return { kind: 'setup-refused', stage: 'lease-already-expired' };
                }
                input.handle.release();
                const settled = await input.handle.settled;
                return classifyHelperStatus({ status: settled.status, pid: settled.pid });
            } finally {
                inFlight.delete(id);
            }
        },

        /** 등록할 것이 없을 때의 단일 호출. 준비 직후 곧바로 놓아준다. */
        async execGeneration(input: {
            key: GenerationKey;
            inherit?: Array<{ childFd: number; parentFd: number }>;
            statusFd: number;
            releaseFd: number;
            leaseExpiresMonotonic: number;
            onAcquired?: (pid: number) => Promise<void>;
        }): Promise<ExecOutcome> {
            const prepared = await this.prepareLaunch(input);
            if (prepared.kind !== 'parked') return prepared;
            try {
                if (input.onAcquired) await input.onAcquired(prepared.pid ?? 0);
            } catch {
                prepared.handle.abort();
                const aborted = await prepared.handle.settled;
                inFlight.delete(leaseId(input.key));
                return classifyHelperStatus({ status: aborted.status, pid: aborted.pid });
            }
            return this.releaseLaunch({
                key: input.key,
                handle: prepared.handle,
                leaseExpiresMonotonic: input.leaseExpiresMonotonic,
            });
        },

        stopGeneration,

        /**
         * 정지를 요청해 두고 관측 전에 끊긴 세대를 마무리한다.
         *
         * `rmdir` 뒤 원장 기록 전에 죽으면 cgroup 은 없고 기록은 열려 있다. 그
         * 부재를 증거로 쓸 수 있는 조건은 두 가지다: 이 supervisor 가 **배타
         * 잠금**을 들고 있어 다른 supervisor 가 같은 경로를 만들 수 없고,
         * 세대 재사용이 원장에서 금지돼 같은 이름이 다시 생기지 않는다는 것.
         * 그 두 가지가 성립할 때만 "없다 = 치웠다" 가 참이다.
         *
         * 정지 요청이 없던 세대의 부재는 여전히 증거가 아니다 — 이 프로세스가
         * 죽인 적이 없으므로 누가 치웠는지 모른다.
         */
        resolvePendingTermination(key: GenerationKey): StopOutcome {
            const proof = deps.manifest.proveStopped(key);
            if (proof.proven) {
                return { stopped: true, observedEmptyAt: proof.record.observedEmptyAt ?? deps.now() };
            }
            if (proof.detail !== 'termination-pending') {
                return { stopped: false, detail: proof.detail };
            }
            try {
                deps.readFile(join(generation(key), 'cgroup.events'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                    const observedEmptyAt = deps.now();
                    deps.manifest.recordTermination({ key, observedEmptyAt });
                    return { stopped: true, observedEmptyAt };
                }
                return { stopped: false, detail: 'events-unreadable' };
            }
            // cgroup 이 아직 있다. 정지는 끝나지 않았다.
            return stopGeneration(key);
        },

        /**
         * lease 갱신. **`renewalSeq` 가 커질 때만** 받는다.
         *
         * 같은 토큰 재전송으로 deadline 을 늘리지 못하게 하는 §5.3 계약을 여기서도
         * 지킨다. epoch 이 다르면 다른 세대의 갱신이므로 거부한다. 실패를
         * 조용히 성공으로 바꾸지 않는다 — 호출부가 그 사실을 알아야 한다.
         */
        renewLease(input: {
            key: GenerationKey;
            renewalSeq: number;
            leaseExpiresMonotonic: number;
        }): { renewed: true; leaseExpiresMonotonic: number } | { renewed: false; detail: string } {
            if (!Number.isSafeInteger(input.renewalSeq) || input.renewalSeq < 0) {
                return { renewed: false, detail: 'invalid-renewal-seq' };
            }
            if (!Number.isSafeInteger(input.leaseExpiresMonotonic)) {
                return { renewed: false, detail: 'invalid-expiry' };
            }
            const id = leaseId(input.key);
            // 정지된 세대도, 정지 요청이 이미 나간 세대도 되살리지 않는다.
            // 갱신도 같은 허용 목록을 쓴다. 상태를 모르면 연장하지 않는다.
            const proof = deps.manifest.proveStopped(input.key);
            if (proof.proven || proof.detail !== 'termination-unknown') {
                return {
                    renewed: false,
                    detail: proof.proven ? 'already-stopped' : proof.detail,
                };
            }
            // 이미 지난 deadline 으로는 갱신하지 않는다 — 만료된 세대를 되살리는 셈이다.
            if (input.leaseExpiresMonotonic <= deps.monotonicNow()) {
                return { renewed: false, detail: 'lease-already-expired' };
            }
            /*
             * 이미 지난 deadline 을 들고 있는 세대는 **되살리지 않는다.**
             * watchdog tick 사이에 더 큰 seq 와 미래 deadline 이 오면, 그
             * 사이에 만료된 세대가 아무 일 없었다는 듯 이어진다. 만료를 본
             * 순간 정지 의도를 남겨 그 tick 이 확실히 집행하게 한다.
             */
            const currentDeadline = deadlines.get(id);
            if (currentDeadline !== undefined && currentDeadline <= deps.monotonicNow()) {
                try {
                    deps.manifest.recordTerminationRequested({ key: input.key, requestedAt: deps.now() });
                } catch {
                    // 기록하지 못해도 갱신은 거부한다.
                }
                return { renewed: false, detail: 'lease-expired' };
            }
            const current = leases.get(id);
            if (current !== undefined && input.renewalSeq <= current) {
                return { renewed: false, detail: 'stale-renewal' };
            }
            leases.set(id, input.renewalSeq);
            deadlines.set(id, input.leaseExpiresMonotonic);
            // seq 만 고치고 감시 deadline 을 그대로 두면 갱신이 아무 효과가 없다.
            enroll({ key: input.key, leaseExpiresMonotonic: input.leaseExpiresMonotonic });
            return { renewed: true, leaseExpiresMonotonic: input.leaseExpiresMonotonic };
        },

        /**
         * lease 가 지났으면 정지시킨다. daemon 이 살아 있는지 보지 않는다.
         *
         * 만료 판정은 **단조 시계**로 한다. 벽시계가 뒤로 가면 만료가 사라지고,
         * 앞으로 가면 살아 있는 세대가 죽는다.
         */
        enforceLease(input: { key: GenerationKey; leaseExpiresMonotonic: number }): StopOutcome | null {
            if (deps.monotonicNow() < input.leaseExpiresMonotonic) return null;
            return stopGeneration(input.key);
        },
    };
}

/** 운영 기본 구현. 테스트는 위 deps 를 주입한다. */
/**
 * daemon 과 supervisor 가 **같은 값을 읽는** 단조 시계 (밀리초).
 *
 * `/proc/uptime` 은 부팅 이후 경과이므로 어느 프로세스에서 읽어도 같고 벽시계
 * 점프의 영향을 받지 않는다. lease deadline 은 프로세스 경계를 넘어 비교되므로
 * **양쪽이 이 함수 하나만** 써야 한다 — 한쪽이 다른 시계로 물러나면 두 값이
 * 조용히 다른 원점을 갖게 되고, 그 차이는 만료 판정에서만 드러난다.
 *
 * 그래서 대체 시계를 두지 않는다. managed 는 Linux 전용이고, 여기서 읽지 못하면
 * 그 사실을 던진다.
 */
export function systemMonotonicNow(): number {
    if (process.platform !== 'linux') {
        throw new Error('system monotonic clock requires Linux (/proc/uptime)');
    }
    const uptime = readFileSync('/proc/uptime', 'utf8');
    const seconds = Number.parseFloat(uptime.split(' ')[0] ?? '');
    if (!Number.isFinite(seconds)) throw new Error('/proc/uptime is unreadable');
    return Math.floor(seconds * 1000);
}

/** status 기록 상한. helper 하나가 임의 크기 입력이 되지 않게 한다. */
export const MAX_STATUS_BYTES = 4096;
/** ACK 를 기다리는 시한. helper 가 말이 없으면 영원히 붙잡지 않는다. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

export const defaultSupervisorDeps: Omit<SupervisorDeps, 'manifest'> = {
    monotonicNow: () => systemMonotonicNow(),
    now: Date.now,
    mkdir: (path) => { mkdirSync(path, { recursive: true, mode: 0o755 }); },
    writeFile: (path, data) => { writeFileSync(path, data); },
    readFile: (path) => readFileSync(path, 'utf8'),
    rmdir: (path) => { rmdirSync(path); },
    launch: async ({ helperPath, argv, statusFd, releaseFd, inheritFds, env }) => {
        // status fd 는 stdio 배열의 그 자리에 붙는다. helper 가 CLOEXEC 를 걸어
        // execve 시 닫히고, 그 EOF 가 "여기서 더 말할 것이 없다" 는 신호다.
        // 상속시킬 fd 도 같은 번호 자리에 실제로 매핑한다.
        const slots = Math.max(statusFd, releaseFd, ...inheritFds.map((e) => e.childFd), 2) + 1;
        const stdio: Array<'ignore' | 'pipe' | number> = new Array(slots).fill('ignore');
        stdio[statusFd] = 'pipe';
        stdio[releaseFd] = 'pipe';
        // 자식의 `childFd` 자리에 부모가 연 `parentFd` 를 붙인다.
        for (const entry of inheritFds) stdio[entry.childFd] = entry.parentFd;
        const child = spawn(helperPath, argv, { stdio, env });

        let status = '';
        let settledResolve: (value: { status: string; pid: number | null }) => void = () => {};
        const settled = new Promise<{ status: string; pid: number | null }>((resolve) => {
            settledResolve = resolve;
        });
        let done = false;
        const settle = () => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            settledResolve({ status, pid: child.pid ?? null });
        };
        const deadline = setTimeout(() => {
            if (done) return;
            status += '\nstage=handshake-timeout errno=0';
            try { child.kill('SIGKILL'); } catch { /* 이미 죽었으면 그만이다 */ }
            settle();
        }, HANDSHAKE_TIMEOUT_MS);
        deadline.unref?.();

        const release = child.stdio[releaseFd];
        const pipe = child.stdio[statusFd];
        const handle: LaunchHandle = {
            pid: null,
            release: () => {
                try {
                    if (release && 'write' in release) release.write('1');
                } catch {
                    // 소켓이 끊겼다. helper 는 stage=release 로 죽는다 — 맞는 결과다.
                }
            },
            abort: () => {
                // 파이프를 닫으면 helper 의 read 가 0 을 받아 exec 없이 죽는다.
                try { if (release && 'end' in release) release.end(); } catch { /* 이미 닫혔다 */ }
            },
            settled,
        };

        child.on('error', settle);
        child.on('close', settle);

        return new Promise<LaunchHandle>((resolve) => {
            if (!pipe || !('setEncoding' in pipe)) {
                settle();
                resolve(handle);
                return;
            }
            pipe.setEncoding('utf8');
            let acked = false;
            pipe.on('data', (chunk: string) => {
                if (Buffer.byteLength(status, 'utf8') <= MAX_STATUS_BYTES) status += chunk;
                if (acked) return;
                const found = /\bpid=(\d+)\b/.exec(status);
                if (!found) return;
                acked = true;
                // ACK 시점에 돌려준다. 자식은 아직 park 상태다.
                handle.pid = Number(found[1]);
                resolve(handle);
            });
            const finish = () => {
                settle();
                if (!acked) { acked = true; resolve(handle); }
            };
            pipe.on('end', finish);
            pipe.on('close', finish);
        });
    },
};

/**
 * 자율 watchdog 루프.
 *
 * **daemon 을 조회하지 않는다.** daemon 이 죽어도 계속 돌아야 lease 만료가
 * 집행된다 — 그러지 않으면 daemon 을 죽이는 것이 lease 무한 연장이 된다.
 * 시각 판정은 단조 시계로만 한다.
 *
 * 등록은 supervisor 가 세대를 띄울 때 하고, 정지가 관측되면 스스로 빠진다.
 */
export type LeaseWatchdog = {
    arm: (input: { key: GenerationKey; leaseExpiresMonotonic: number }) => void;
    disarm: (key: GenerationKey) => void;
    /** 한 tick. 만료된 세대를 정지시키고 결과를 돌려준다. */
    tick: () => Array<{ key: GenerationKey; outcome: StopOutcome }>;
    start: () => void;
    stop: () => void;
    armedCount: () => number;
};

export function createLeaseWatchdog(input: {
    supervisor: Pick<ReturnType<typeof createSupervisor>, 'stopGeneration'>;
    monotonicNow: () => number;
    intervalMs: number;
    setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
    clearInterval?: (timer: NodeJS.Timeout) => void;
}): LeaseWatchdog {
    const armed = new Map<string, { key: GenerationKey; leaseExpiresMonotonic: number }>();
    let timer: NodeJS.Timeout | null = null;
    const keyOf = (key: GenerationKey) => JSON.stringify([key.runId, key.attemptId, key.epoch]);

    const tick = (): Array<{ key: GenerationKey; outcome: StopOutcome }> => {
        const now = input.monotonicNow();
        const results: Array<{ key: GenerationKey; outcome: StopOutcome }> = [];
        for (const [id, entry] of [...armed]) {
            if (now < entry.leaseExpiresMonotonic) continue;
            const outcome = input.supervisor.stopGeneration(entry.key);
            results.push({ key: entry.key, outcome });
            // 정지를 **관측**했을 때만 감시를 놓는다. 요청만으로 놓으면
            // 살아남은 세대가 다시는 집행되지 않는다.
            if (outcome.stopped) armed.delete(id);
        }
        return results;
    };

    return {
        arm(entry) { armed.set(keyOf(entry.key), { ...entry }); },
        disarm(key) { armed.delete(keyOf(key)); },
        tick,
        start() {
            if (timer) return;
            const schedule = input.setInterval ?? setInterval;
            timer = schedule(() => { tick(); }, input.intervalMs);
            // 이 타이머가 프로세스를 붙잡아야 supervisor 가 살아 있는다.
        },
        stop() {
            if (!timer) return;
            (input.clearInterval ?? clearInterval)(timer);
            timer = null;
        },
        armedCount: () => armed.size,
    };
}
