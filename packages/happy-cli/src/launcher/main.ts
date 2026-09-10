/**
 * specs/managed-cloud-byos §5.36 — supervisor 진입점.
 *
 * root 로 돌며 세 가지를 계속 소유한다: IPC 응답, lease watchdog tick, 그리고
 * durable 원장. **daemon 의 생사와 무관하게** 돈다 — daemon 을 죽이는 것이
 * lease 무한 연장이 되면 안 된다.
 *
 * 이 프로세스는 세대 cgroup 에 들어가지 않는다.
 */
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';

import { parseManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

import { createGenerationManifest, type GenerationKey } from './generationManifest';
import { createIpcServer } from './ipcServer';
import {
    acquireSupervisorLock,
    createLeaseWatchdog,
    createSupervisor,
    defaultSupervisorDeps,
    type LaunchHandle,
    type SupervisorConfig,
} from './supervisor';

export type SupervisorRuntimeOptions = {
    config: SupervisorConfig;
    manifestRoot: string;
    /** root 소유 스테이징 디렉터리. bootstrap 봉투가 잠깐 여기 놓인다. */
    stagingRoot: string;
    socketPath: string;
    watchdogIntervalMs: number;
    /** 준비 뒤 놓아주지 않으면 자동으로 접는다. */
    releaseDeadlineMs: number;
    /** 배타 잠금 이름. 두 supervisor 가 같은 원장을 쓰지 못하게 한다. */
    runtimeId: string;
    /**
     * 잠금 획득. 기본은 Linux 추상 소켓이며 운영에서는 그것만 쓴다.
     * 비-Linux 개발 환경의 프로세스 fixture 만 이 자리를 바꾼다.
     */
    acquireLock?: (input: { runtimeId: string; manifestRoot: string; cgroupRoot: string }) => Promise<
        { ok: true; release: () => Promise<void> } | { ok: false; reason: string }
    >;
    /** helper 에게 상속시킬 bootstrap fd 번호. */
    bootstrapFd?: number;
    /** daemon 이 속한 신뢰 그룹. 소켓의 group 을 여기로 옮긴다. */
    daemonGid?: number;
    token?: string;
};

/**
 * bootstrap 봉투를 root 소유 디렉터리에 잠깐 놓고 **읽기 전용으로 연 뒤 곧바로
 * 지운다.**
 *
 * 경로가 사라지므로 agent 가 다시 열 수 없고, 이미 열린 fd 만 유효하다. 재시작
 * 후 재사용하지 않으므로 `fsync` 로 내구성을 주장하지 않는다 — 여기서 필요한
 * 것은 배타 생성과 즉시 제거뿐이다.
 */
function assertTrustedStagingRoot(root: string, ownerUid: number): void {
    if (lstatSync(root).isSymbolicLink()) {
        throw new Error('staging root must not be a symlink');
    }
    const resolved = realpathSync(root);
    const segments = resolved.split(sep).filter(Boolean);
    let current: string = sep;
    for (const segment of [...segments, null]) {
        if (segment !== null) current = join(current, segment);
        const stat = lstatSync(current);
        // 남이 소유하거나 남이 쓸 수 있는 조상은 아래를 통째로 갈아끼울 수 있다.
        if (stat.uid !== 0 && stat.uid !== ownerUid) {
            throw new Error(`staging ancestor ${current} has an unexpected owner`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new Error(`staging ancestor ${current} is writable by others`);
        }
    }
    if (!lstatSync(resolved).isDirectory()) throw new Error('staging root must be a directory');
}

function stageBootstrap(root: string, bootstrap: Buffer): number {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertTrustedStagingRoot(root, process.getuid?.() ?? 0);
    const path = join(root, `${randomBytes(16).toString('hex')}.envelope`);
    const write = openSync(path, 'wx', 0o600);
    try {
        let written = 0;
        while (written < bootstrap.length) {
            written += writeSync(write, bootstrap, written, bootstrap.length - written);
        }
    } catch (error) {
        // 실패한 스테이징 파일을 남기지 않는다.
        try { unlinkSync(path); } catch { /* 이미 없다 */ }
        throw error;
    } finally {
        closeSync(write);
    }
    let read: number;
    try {
        read = openSync(path, 'r');
    } catch (error) {
        try { unlinkSync(path); } catch { /* 이미 없다 */ }
        throw error;
    }
    try {
        // release 보다 **먼저** 지운다. 자식이 살아 있는 동안 경로가 남아 있으면
        // 그 경로로 다시 열 수 있다.
        unlinkSync(path);
    } catch (error) {
        closeSync(read);
        throw error;
    }
    return read;
}

export function createSupervisorRuntime(options: SupervisorRuntimeOptions) {
    const manifest = createGenerationManifest(options.manifestRoot);
    // watchdog 은 supervisor 보다 먼저 있어야 한다 — supervisor 가 release 전에
    // 여기에 등록하기 때문이다. 그래서 참조를 지연시켜 묶는다.
    let watchdogRef: ReturnType<typeof createLeaseWatchdog> | null = null;
    const supervisor = createSupervisor(options.config, {
        ...defaultSupervisorDeps,
        manifest,
        enrollWatchdog: (entry) => { watchdogRef?.arm(entry); },
    });
    const watchdog = createLeaseWatchdog({
        supervisor,
        monotonicNow: defaultSupervisorDeps.monotonicNow,
        intervalMs: options.watchdogIntervalMs,
    });
    watchdogRef = watchdog;
    let releaseLock: (() => Promise<void>) | null = null;
    /** 준비돼 park 된 세대들. handle 은 일회용이다. */
    const parked = new Map<string, {
        key: GenerationKey;
        handle: LaunchHandle;
        leaseExpiresMonotonic: number;
        bootstrapFd: number;
        timer: NodeJS.Timeout;
    }>();

    const closeFd = (fd: number) => { try { closeSync(fd); } catch { /* 이미 닫혔다 */ } };

    const ipc = createIpcServer({
        socketPath: options.socketPath,
        token: options.token,
        ...(options.daemonGid !== undefined ? { daemonGid: options.daemonGid } : {}),
        handlers: {
            proveStopped: (key: GenerationKey) => manifest.proveStopped(key),
            // runtime 전체 질문이다. run/attempt 로 좁히지 않는다.
            proveBelow: ({ belowEpoch }) => manifest.proveAllBelow(belowEpoch),
            async prepareLaunch({ key, leaseExpiresMonotonic, bootstrap }) {
                // 봉투가 실제 B2 모양인지 여기서 본다. 모양을 안 보고 넘기면
                // 자식이 무엇을 받는지 supervisor 가 모르게 된다.
                try {
                    parseManagedSpawnEnvelope(JSON.parse(bootstrap.toString('utf8')), Date.now());
                } catch {
                    // 봉투 내용은 어디에도 남기지 않는다.
                    return { prepared: false, detail: 'bootstrap-invalid' };
                }
                let bootstrapFd: number;
                try {
                    bootstrapFd = stageBootstrap(options.stagingRoot, bootstrap);
                } catch {
                    return { prepared: false, detail: 'staging-failed' };
                }
                const childFd = options.bootstrapFd ?? 3;
                let prepared;
                try {
                    prepared = await supervisor.prepareLaunch({
                        key,
                        statusFd: 9,
                        releaseFd: 8,
                        // 자식은 약속된 번호로 받고, 그 자리에 방금 연 fd 를 붙인다.
                        inherit: [{ childFd, parentFd: bootstrapFd }],
                        leaseExpiresMonotonic,
                    });
                } catch {
                    closeFd(bootstrapFd);
                    return { prepared: false, detail: 'prepare-failed' };
                }
                if (prepared.kind !== 'parked') {
                    closeFd(bootstrapFd);
                    return {
                        prepared: false,
                        detail: 'stage' in prepared ? prepared.stage : prepared.kind,
                    };
                }
                const handle = randomBytes(16).toString('hex');
                const timer = setTimeout(() => {
                    const entry = parked.get(handle);
                    if (!entry) return;
                    parked.delete(handle);
                    entry.handle.abort();
                    closeFd(entry.bootstrapFd);
                }, options.releaseDeadlineMs);
                timer.unref?.();
                parked.set(handle, {
                    key, handle: prepared.handle, leaseExpiresMonotonic, bootstrapFd, timer,
                });
                return { prepared: true, pid: prepared.pid, handle };
            },

            async releaseLaunch(handle) {
                const entry = parked.get(handle);
                // 일회용이다. 같은 handle 을 두 번 쓰지 못한다.
                if (!entry) return { released: false, detail: 'unknown-handle' };
                parked.delete(handle);
                clearTimeout(entry.timer);
                try {
                    const outcome = await supervisor.releaseLaunch({
                        key: entry.key,
                        handle: entry.handle,
                        leaseExpiresMonotonic: entry.leaseExpiresMonotonic,
                    });
                    return outcome.kind === 'exec-attempted'
                        ? { released: true, detail: 'exec-attempted' }
                        : { released: false, detail: 'stage' in outcome ? outcome.stage : outcome.kind };
                } finally {
                    // 성공이든 실패든 부모 쪽 fd 는 놓는다.
                    closeFd(entry.bootstrapFd);
                }
            },

            renew: ({ key, renewalSeq, leaseExpiresMonotonic }) => {
                const result = supervisor.renewLease({ key, renewalSeq, leaseExpiresMonotonic });
                return result.renewed
                    ? { renewed: true }
                    : { renewed: false, detail: result.detail };
            },

            requestStop: (key: GenerationKey) => {
                const outcome = supervisor.stopGeneration(key);
                // 관측하지 못한 정지를 수락으로 보고하지 않는다.
                return outcome.stopped
                    ? { requested: true, detail: 'observed-empty' }
                    : { requested: false, detail: outcome.detail };
            },
        },
    });

    return {
        supervisor,
        watchdog,
        manifest,
        token: ipc.token,
        /**
         * 재시작 재조정.
         *
         * 새 프로세스는 감시 목록이 비어 있다. 그런데 이전 supervisor 가 띄운
         * 자식은 그대로 돌고 있을 수 있다 — 그 세대를 무장하지 않으면 lease 가
         * 영원히 집행되지 않는다. 그래서 **명령을 받기 전에** 원장의 열린 세대를
         * 훑어 무장하고, 이미 만료된 것은 그 자리에서 정지시킨다.
         *
         * 이 supervisor 는 이전 lease deadline 을 모른다(단조 시계는 재부팅으로
         * 리셋된다). 알 수 없는 것을 유효하다고 가정하지 않는다 — 열린 세대는
         * **즉시 만료**로 본다.
         */
        reconcile(): {
            armed: number;
            stopped: Array<{ key: GenerationKey; detail: string }>;
            unreadable: number;
        } {
            const open = manifest.listOpen();
            const stopped: Array<{ key: GenerationKey; detail: string }> = [];
            for (const record of open.records) {
                const key = { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
                // 정지 요청이 이미 나갔던 세대는 부재를 증거로 확정할 수 있다 —
                // 이 supervisor 가 배타 잠금을 들고 있고 세대 재사용이 금지돼
                // 같은 경로가 다시 생기지 않기 때문이다.
                const outcome = record.terminationRequestedAt !== null
                    ? supervisor.resolvePendingTermination(key)
                    : supervisor.stopGeneration(key);
                if (outcome.stopped) {
                    stopped.push({ key, detail: 'observed-empty' });
                    continue;
                }
                // 관측하지 못했으면 감시에 올려 다음 tick 이 다시 시도한다.
                stopped.push({ key, detail: outcome.detail });
                watchdog.arm({ key, leaseExpiresMonotonic: 0 });
            }
            return { armed: watchdog.armedCount(), stopped, unreadable: open.unreadable };
        },

        async start(): Promise<void> {
            // 두 supervisor 가 같은 원장과 cgroup 을 만지면 재조정이 서로의
            // 세대를 지운다. 잠금을 못 얻으면 시작하지 않는다.
            const lock = await (options.acquireLock ?? acquireSupervisorLock)({
                runtimeId: options.runtimeId,
                manifestRoot: options.manifestRoot,
                cgroupRoot: options.config.cgroupRoot,
            });
            if (!lock.ok) throw new Error(`supervisor lock unavailable (${lock.reason})`);
            releaseLock = lock.release;
            // 재조정이 먼저다. 명령을 받기 시작한 뒤에 하면 그 사이 새 세대가
            // 옛 세대와 섞인다.
            this.reconcile();
            watchdog.start();
            await ipc.listen();
        },
        /**
         * 종료.
         *
         * 순서가 계약이다. watchdog 을 먼저 끄고 잠금을 놓으면, 이미 release 된
         * 자식들이 감시자 없이 영원히 남는다 — 그리고 그 잠금을 잡은 다음
         * supervisor 는 원장의 열린 기록을 보고 재조정하겠지만, 그 사이는 아무도
         * 보지 않는 구간이다.
         *
         *  ① 새 요청을 막는다(IPC 닫기)
         *  ② 진행 중 launch 를 정리한다 — park 된 것은 abort, 이미 놓아준 것은
         *     아래 정지 대상이다
         *  ③ **watchdog 과 잠금을 든 채로** 열린 세대를 전부 정지·증명한다
         *  ④ 전부 증명됐을 때만 watchdog 을 끄고 잠금을 놓는다
         *
         * 하나라도 증명하지 못하면 watchdog 과 잠금을 유지한 채 실패를 알린다.
         * 감시를 놓는 것이 곧 그 자식을 잃는 것이다.
         */
        async stop(): Promise<
            { stopped: true } | { stopped: false; open: GenerationKey[]; unreadable: number }
        > {
            // ① 입구를 먼저 막는다.
            await ipc.close();

            // ② park 된 것은 exec 없이 접는다.
            for (const [handle, entry] of [...parked]) {
                parked.delete(handle);
                clearTimeout(entry.timer);
                entry.handle.abort();
                try { await entry.handle.settled; } catch { /* 이미 끝났다 */ }
                closeFd(entry.bootstrapFd);
            }

            // ③ 감시와 잠금을 든 채로 정지시킨다.
            const open: GenerationKey[] = [];
            const inventory = manifest.listOpen();
            /*
             * 읽지 못한 기록이 있으면 **무엇이 열려 있는지 모른다.** 그 상태로
             * 감시와 잠금을 놓으면 알지 못하는 자식이 감시자 없이 남는다.
             */
            const unreadable = inventory.unreadable;
            for (const record of inventory.records) {
                const key = { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
                const outcome = record.terminationRequestedAt !== null
                    ? supervisor.resolvePendingTermination(key)
                    : supervisor.stopGeneration(key);
                if (!outcome.stopped) {
                    open.push(key);
                    // 다음 tick 이 다시 시도하도록 감시에 올려 둔다.
                    watchdog.arm({ key, leaseExpiresMonotonic: 0 });
                }
            }
            if (open.length > 0 || unreadable > 0) {
                // watchdog 도 잠금도 놓지 않는다.
                return { stopped: false, open, unreadable };
            }

            // ④ 전부 증명됐다. 이제 놓아도 잃을 자식이 없다.
            watchdog.stop();
            if (releaseLock) {
                await releaseLock();
                releaseLock = null;
            }
            return { stopped: true };
        },
    };
}
