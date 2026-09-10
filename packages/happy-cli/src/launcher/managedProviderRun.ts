/**
 * specs/managed-cloud-byos P4 — 도구 경계를 세운 채 **provider 를 실제로 띄운다**.
 *
 * 지금까지는 세션(broker·executor·grant)과 supervisor(세대·격리 실행)가 각각
 * 있었다. 이 파일이 둘을 한 번의 실행으로 잇는다:
 *
 *   ① 세션이 broker 를 열고 provider 계획을 만든다
 *   ② 계획이 요구하는 파일을 **release 전에** 쓴다 (root 소유, 읽기 전용)
 *   ③ supervisor 가 세대에서 provider 를 park → 등록 → release
 *   ④ 정지: 세대를 먼저 죽이고 그 다음 broker 를 닫는다
 *
 * ②가 release 전인 것이 중요하다. `environments.toml` 이 없는 채로 놓아주면
 * provider 는 정책 없이 도구를 광고한다 — 그 창이 곧 경계의 구멍이다.
 *
 * ④의 순서도 뒤집으면 안 된다. broker 를 먼저 닫으면 아직 도는 도구가 자기
 * 호출을 잃을 뿐 계속 살아 있고, 세대를 먼저 죽이면 도구와 provider 가 함께
 * 끝난 뒤 문이 닫힌다.
 */
import { resolve, sep } from 'node:path';

import {
    type ManagedProvisioningDeps,
    trustedPathRefusal,
} from '@/daemon/managedRuntimeIdentity';

import type { GenerationKey } from './generationManifest';
import type { ExecOutcome, StopOutcome } from './supervisor';
import type { ManagedToolSession } from './managedToolSession';

/**
 * 제품이 채우는 supervisor 설정.
 *
 * 호출자가 완성된 supervisor 를 건네면 그 안의 `envAllowlist` 가 계획과 다를 수
 * 있고, 바깥에서 그것을 "같다" 고 **주장**하는 것으로는 아무것도 보장되지 않는다.
 * 그래서 설정은 여기서 만들고, 호출자는 그 설정으로 supervisor 를 **만들어 주는
 * 일만** 한다.
 */
export type ProviderSupervisorConfig = {
    cgroupRoot: string;
    helperPath: string;
    workloadPath: string;
    envAllowlist: Record<string, string>;
    resolveGenerationCredentials: () => { uid: number; gid: number };
};

export type ProviderRunSupervisor = {
    execGeneration: (input: {
        key: GenerationKey;
        inherit?: Array<{ childFd: number; parentFd: number }>;
        statusFd: number;
        releaseFd: number;
        leaseExpiresMonotonic: number;
        onAcquired?: (pid: number) => Promise<void>;
    }) => Promise<ExecOutcome>;
    stopGeneration: (key: GenerationKey) => StopOutcome;
};

/**
 * 실행에 실패했을 때 호출자에게 남는 것.
 *
 * 실패를 던지면서 정리 결과까지 버리면, 세대가 남았는지도 모르고 다시 치울
 * 손잡이도 없다. 그래서 오류에 **정지 결과와 재시도 수단과 세대 식별자**를 싣는다.
 */
export class ManagedProviderLaunchError extends Error {
    readonly stopOutcome: StopOutcome;
    readonly stop: () => Promise<StopOutcome>;
    readonly key: GenerationKey;

    constructor(cause: Error, context: {
        stopOutcome: StopOutcome;
        stop: () => Promise<StopOutcome>;
        key: GenerationKey;
    }) {
        super(cause.message, { cause });
        this.name = 'ManagedProviderLaunchError';
        this.stopOutcome = context.stopOutcome;
        this.stop = context.stop;
        this.key = context.key;
    }
}

export type ManagedProviderRun = {
    outcome: ExecOutcome;
    /**
     * 세대를 정지시키고 도구 경계를 거둔다.
     *
     * **정지가 증명될 때까지 끝난 것이 아니다.** 첫 시도가 비었음을 관측하지
     * 못하면 그 실패를 그대로 돌려주고, 다시 부르면 다시 시도한다. 실패를
     * 성공으로 접거나 `observedEmptyAt: 0` 같은 값을 지어내면, 남아 있는
     * 프로세스가 정지된 것으로 원장에 남는다.
     */
    stop: () => Promise<StopOutcome>;
};

/**
 * 계획을 실제 실행으로 옮기는 스크립트.
 *
 * 신뢰 helper 는 **인자 없이** workload 하나만 execve 한다(§5.36). 그래서
 * provider 의 인자는 이 파일이 싣는다. root 소유·읽기 전용으로 두어 provider 가
 * 자기 실행 정의를 다시 쓰지 못하게 한다.
 */
export function providerWorkloadScript(input: {
    path: string;
    execPath: string;
    args: string[];
    /** 계획이 정한 실행 디렉터리. 들어가지 못하면 실행하지 않는다. */
    cwd: string;
}): { path: string; contents: string; mode: number } {
    /*
     * 접두어 비교만으로는 `/usr/local/lib/saycode/../../tmp/x` 가 통과한다.
     * 정규화한 뒤 신뢰 루트 **안**인지 본다.
     */
    const canonical = resolve(input.path);
    if (canonical !== input.path
        || !canonical.startsWith(`${TRUSTED_LAUNCH_ROOT}${sep}`)
        || canonical.slice(TRUSTED_LAUNCH_ROOT.length + 1).includes(sep)) {
        throw new Error('provider workload must live directly in the trusted directory');
    }
    if (!input.execPath.startsWith('/')) {
        throw new Error('provider exec path must be absolute');
    }
    if (!input.cwd.startsWith('/')) {
        throw new Error('provider cwd must be absolute');
    }
    const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
    const quoted = input.args.map(quote).join(' ');
    /*
     * `cd` 가 실패하면 **실행하지 않는다**. 신뢰 helper 도 supervisor 의 기본
     * 실행기도 chdir 하지 않으므로, 여기서 하지 않으면 provider 는 물려받은 아무
     * 디렉터리에서 돌면서 workspace 안에 있다고 보고한다.
     */
    return {
        path: input.path,
        contents: [
            '#!/bin/sh',
            '# managed runtime: generated launch definition. Do not edit.',
            'cd ' + quote(input.cwd) + ' || exit 70',
            'exec ' + quote(input.execPath) + ' ' + quoted,
            '',
        ].join('\n'),
        mode: 0o555,
    };
}

/** workload 가 살 수 있는 유일한 디렉터리. 경로 문자열이 아니라 정규화로 판정한다. */
export const TRUSTED_LAUNCH_ROOT = '/usr/local/lib/saycode';

/**
 * 신뢰 경로 판정.
 *
 * **잎만 보면 안 된다** — 쓰기 가능한 조상 아래의 root 소유 파일은 rename 으로
 * 갈아치울 수 있다. 조상 검사는 이미 있는 규칙을 그대로 쓴다
 * (`managedRuntimeIdentity.trustedPathRefusal`: 모든 조상이 실제 디렉터리이고,
 * 심볼릭 링크가 아니며, root/daemon 소유이고, 그룹·기타 쓰기가 없어야 한다).
 * 여기서는 그 위에 **잎 파일** 규칙만 더한다.
 */
function assertTrustedExecutable(
    path: string,
    lstatPath: (path: string) => {
        uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean;
    },
): void {
    const canonical = resolve(path);
    if (canonical !== path) throw new Error('provider exec path must already be canonical');
    // 조상 전체. 여기서 쓰기 가능한 칸이 하나라도 있으면 잎의 소유권은 의미가 없다.
    const deps = {
        getuid: () => 0,
        platform: 'linux' as NodeJS.Platform,
        lstatDir: lstatPath,
    } as unknown as ManagedProvisioningDeps;
    const parent = canonical.slice(0, canonical.lastIndexOf(sep)) || sep;
    const refused = trustedPathRefusal(parent, 0, 'state-dir-unsafe', deps);
    if (refused) throw new Error(`provider exec path is not trusted: ${refused.detail}`);
    // 잎은 디렉터리가 아니므로 위 규칙이 보지 못한다. 같은 기준으로 직접 본다.
    const leaf = lstatPath(canonical);
    if (leaf.isSymbolicLink) throw new Error('provider exec path must not be a symlink');
    if (!leaf.isFile) throw new Error('provider exec path must be a regular file');
    if (leaf.uid !== 0) throw new Error('provider exec path must be owned by root');
    // 0o022 = 그룹/기타 쓰기. 하나라도 있으면 남이 실행 내용을 갈아치울 수 있다.
    if ((leaf.mode & 0o022) !== 0) throw new Error('provider exec path must not be writable by others');
}

/**
 * 실제로 실행된 프로세스의 환경 검사.
 *
 * `sh` 가 `cd` 하면서 더하는 것들(`PWD`·`SHLVL`·`_`·`OLDPWD`)은 허용한다 —
 * 그것들은 계획을 바꾸지 않는다. 그 밖의 추가나 계획 값의 변경은 거부한다.
 */
const SHELL_ADDED_ENV = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

function assertLaunchedEnvironment(
    planned: Record<string, string>,
    actual: Record<string, string>,
): void {
    const missing = Object.keys(planned).filter((key) => actual[key] !== planned[key]);
    const extra = Object.keys(actual).filter((key) => !(key in planned) && !SHELL_ADDED_ENV.has(key));
    if (missing.length > 0 || extra.length > 0) {
        // 값은 자격을 담을 수 있으므로 이름만 말한다.
        throw new Error(
            `the launched process environment is not the plan’s: missing/changed=${missing.join(',')} extra=${extra.join(',')}`,
        );
    }
}

export async function startManagedProviderRun(input: {
    /** 제품이 만든 설정으로 supervisor 를 만든다. 설정을 바꿔 넘길 자리는 없다. */
    createSupervisor: (config: ProviderSupervisorConfig) => ProviderRunSupervisor;
    session: ManagedToolSession;
    key: GenerationKey;
    statusFd: number;
    releaseFd: number;
    leaseExpiresMonotonic: number;
    /** 계획이 요구하는 파일을 쓴다. supervisor 권한으로만 쓰인다. */
    writeFile: (file: { path: string; contents: string; mode: number }) => void;
    /**
     * provider **세대**가 정지되지 않았을 때 알린다. 도구 쪽은 세션이 이미
     * 보고하지만, 세대가 남은 것은 여기서만 알 수 있다.
     */
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /**
     * 띄운 프로세스의 실제 환경을 읽는다(`/proc/<pid>/environ`).
     *
     * 설정을 제품이 만들어도, 그 설정으로 supervisor 를 **만들어 주는** 것은
     * 호출자다. 그래서 마지막에는 주장이 아니라 실제로 도는 프로세스에서 확인한다.
     */
    readProcEnviron: (pid: number) => Record<string, string>;
    /**
     * 자식에게 물려줄 신뢰 fd. **우리가 만들지 않고 그대로 넘긴다** — B2 부트
     * 봉투처럼 호출자가 이미 신뢰 경계 안에서 연 것들이고, 여기서 해석하거나
     * 늘리지 않는다(§5.36 의 fd 정책 그대로).
     */
    inherit?: Array<{ childFd: number; parentFd: number }>;
    /** 세대 cgroup 루트와 신뢰 helper. supervisor 설정에 그대로 들어간다. */
    cgroupRoot: string;
    helperPath: string;
    /** provider 프로세스가 돌 신원. supervisor 설정에 그대로 들어간다. */
    identity: { provider: { uid: number; gid: number } };
    /**
     * park 된 pid 로 등록을 마친다. **선택 인자가 아니다** — prepare → 등록 →
     * release 계약에서 등록을 건너뛸 수 있으면 그 계약이 아니다. 여기서 던지면
     * 실행되지 않는다.
     */
    register: (pid: number) => Promise<void>;
    /** 생성할 workload 스크립트 경로. helper 가 이것을 execve 한다. */
    workloadPath: string;
    /** provider 실행 파일. 계획의 인자가 여기에 붙는다. */
    execPath: string;
    /**
     * 신뢰 파일인지 확인한다. 절대 경로라는 것만으로는 아무것도 보장되지 않는다 —
     * 링크이거나, root 소유가 아니거나, 남이 쓸 수 있는 파일이면 그 실행은
     * 계획이 정한 것이 아니다. helper 는 자기가 execve 하는 workload 만 보고,
     * 그 workload 가 다시 부르는 이 파일은 보지 못한다.
     */
    lstatPath: (path: string) => {
        uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean;
    };
}): Promise<ManagedProviderRun> {
    /**
     * 정지는 **양쪽**이다: provider 세대와 그 도구들. 한쪽만 증명된 상태를
     * 캐시하면, 남은 쪽이 살아 있는데 정지로 보고된다.
     */
    let supervisorRef: ProviderRunSupervisor | null = null;
    let provenGeneration: StopOutcome | null = null;
    let provenTools = false;
    let cached: StopOutcome | null = null;
    const stop = async (): Promise<StopOutcome> => {
        if (cached) return cached;
        // 세대가 먼저다. 도구와 provider 가 끝난 뒤에 문을 닫는다.
        // supervisor 를 만들지 못했다면 정지시킬 세대도 없다.
        const generation = provenGeneration
            ?? (supervisor ? supervisor.stopGeneration(input.key) : { stopped: true as const, observedEmptyAt: 0 });
        if (generation.stopped) provenGeneration = generation;
        if (!provenTools) {
            const tools = await input.session.close();
            provenTools = tools.proven;
            if (!tools.proven) {
                // 세대가 정지됐어도 도구가 남아 있으면 정지가 아니다.
                return { stopped: false, detail: 'tools-still-populated' };
            }
        }
        if (!generation.stopped) {
            // 세대가 남았다. 콜백으로 알리고, 실패를 그대로 돌려준다.
            input.onUnprovenTermination({ tool: 'provider-generation', detail: generation.detail });
            return generation;
        }
        cached = generation;
        return generation;
    };

    /*
     * 정책 파일과 실행 정의는 **prepare 보다 먼저** 쓴다. 신뢰 helper 는 인자
     * 검사 단계에서 workload 파일 자체를 확인하므로(§5.36), park 이후에 쓰면
     * 그 검사가 없는 파일을 보고 거부한다. 그리고 어차피 release 보다 앞이다.
     */
    /*
     * supervisor 는 **계획에서** 만든다. 실행 환경·workload·신원이 계획과
     * 갈라질 자리를 남기지 않는다. 만드는 것 자체가 실패할 수 있으므로 정리
     * 범위 안에 둔다 — 밖에 두면 이미 연 broker 와 grant 가 남는다.
     */
    /** 실패를 던지되 정리 결과와 재시도 수단을 함께 남긴다. */
    const failWith = async (error: unknown): Promise<never> => {
        const stopOutcome = await stop();
        throw new ManagedProviderLaunchError(
            error instanceof Error ? error : new Error(String(error)),
            { stopOutcome, stop, key: input.key },
        );
    };

    let supervisor: ProviderRunSupervisor;
    try {
        supervisor = input.createSupervisor({
            cgroupRoot: input.cgroupRoot,
            helperPath: input.helperPath,
            workloadPath: input.workloadPath,
            envAllowlist: input.session.providerPlan.env,
            resolveGenerationCredentials: () => input.identity.provider,
        });
        assertTrustedExecutable(input.execPath, input.lstatPath);
        for (const file of input.session.providerPlan.files) input.writeFile(file);
        input.writeFile(providerWorkloadScript({
            path: input.workloadPath,
            execPath: input.execPath,
            args: input.session.providerPlan.args,
            cwd: input.session.providerPlan.cwd,
        }));
    } catch (error) {
        // 파일을 쓰지 못했으면 실행은 없다. 열어 둔 broker 와 grant 도 없어야 한다.
        return failWith(error);
    }

    let envRefusal: Error | null = null;
    let outcome: ExecOutcome;
    try {
        outcome = await supervisor.execGeneration({
            key: input.key,
            inherit: input.inherit,
            statusFd: input.statusFd,
            releaseFd: input.releaseFd,
            leaseExpiresMonotonic: input.leaseExpiresMonotonic,
            /*
             * park 된 뒤, **놓아주기 전에** 확인하고 등록한다.
             *
             * 환경 검사가 release 뒤에 있으면 잘못된 env 를 사후에 알게 되고 그
             * 사이 사용자 코드가 이미 돈다. park 상태의 자식은 아직 execve 전이지만
             * 그 environ 이 곧 실행될 환경이다(execve 는 환경을 물려준다).
             */
            onAcquired: async (pid) => {
                try {
                    assertLaunchedEnvironment(
                        input.session.providerPlan.env,
                        input.readProcEnviron(pid),
                    );
                } catch (error) {
                    /*
                     * supervisor 는 여기서 던진 것을 붙잡아 park 를 abort 하고
                     * 실행하지 않는다(그게 우리가 원하는 것이다). 다만 그러면
                     * 이유가 outcome 에 남지 않으므로 붙들어 두었다가 아래에서
                     * 그대로 올린다.
                     */
                    envRefusal = error as Error;
                    throw error;
                }
                await input.register(pid);
            },
        });
    } catch (error) {
        return failWith(envRefusal ?? error);
    }
    if (envRefusal) {
        // 계획과 다른 환경이었다. 실행되지 않았고, 이유를 그대로 올린다.
        return failWith(envRefusal);
    }
    if (outcome.kind !== 'exec-attempted') {
        // 실행되지 않았다. 열어 둔 broker 와 grant 를 그대로 두지 않는다.
        await stop();
    }
    return { outcome, stop };
}
