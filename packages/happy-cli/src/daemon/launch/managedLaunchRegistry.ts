/**
 * 이 daemon 이 신뢰하는 launch 들. **launcher 만** 여기에 기록을 만든다.
 *
 * 보고는 자기주장이므로, 받아들이려면 "이 주장이 어느 launch 의 것인가" 를
 * 되물을 수 있는 원장이 있어야 한다. 그 원장이 이것이다.
 *
 * 여기 없는 launch 의 보고는 거부다. **비어 있는 registry 는 "아무나 통과" 가
 * 아니라 "아무도 통과 못 함" 이다** — 검증기가 배선되지 않은 상태의 기본값이
 * 허용이면, 그 기본값 자체가 우회 경로가 된다.
 *
 * 무엇을 판정하지 **않는가**: 프로세스가 살아 있는지, 끝났는지. 보고는 종료를
 * 증명하지 못하며 그 증거는 커널/backend 몫이다. 여기서는 "이 보고를 이 launch
 * 가 할 수 있는가" 만 본다.
 */

export type ManagedLaunchScope = {
    operationKey: string;
    runId: string;
    attemptId: string;
    epoch: number;
    workspaceId: string;
    projectId: string;
};

/**
 * child 가 쓸 encryption 신원. launcher 가 bootstrap 으로 준 그 값이며,
 * 보고 본문이 다른 값을 들고 오면 세션은 같은데 봉투만 바꾼 보고다.
 */
export type ManagedLaunchEncryption = {
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
};

export type ManagedLaunchRecord = {
    launchId: string;
    scope: ManagedLaunchScope;
    /** launcher 가 exec 한 프로세스들. 보고의 hostPid 는 이 안이어야 한다. */
    hostPids: ReadonlySet<number>;
    encryption: ManagedLaunchEncryption | null;
    expiresAt: number;
    /**
     * 이 launch 가 보고할 수 있는 **유일한** 세션. launcher 가 등록할 때
     * 확정한다 — B2 가 미리 만든 세션이며 child 가 정하는 값이 아니다.
     *
     * 첫 보고가 이 값을 정하게 두면 안 된다. child 가 capability secret 을
     * 가지고 있으므로 아무 세션 id 나 서명해 보낼 수 있고, 그러면 launch A 의
     * secret 으로 다른 Run 의 세션을 자기 것으로 못 박는다. 본문 전체 HMAC 는
     * "이 launch 가 이 본문을 만들었다" 까지만 말하지 **어느 세션을 보고할
     * 자격이 있는지**는 말하지 못한다.
     */
    sessionId: string;
    /** 마지막으로 받아들인 seq. 같거나 작은 값은 재생이다. */
    lastSeq: number;
};

export type LaunchScopeFailure =
    | 'unknown-launch'
    | 'host-pid-invalid'
    | 'launch-expired'
    | 'replayed-sequence'
    | 'host-pid-mismatch'
    | 'encryption-mismatch'
    | 'session-mismatch';

export type LaunchScopeVerdict =
    | { ok: true; record: ManagedLaunchRecord }
    | { ok: false; reason: LaunchScopeFailure };

export type ManagedLaunchRegistry = {
    /** launcher 전용. 같은 launchId 재등록은 거부한다. */
    register: (input: {
        launchId: string;
        scope: ManagedLaunchScope;
        /** B2 가 미리 만든 세션. 선택 항목이 아니다. */
        sessionId: string;
        hostPids: Iterable<number>;
        encryption?: ManagedLaunchEncryption | null;
        expiresAt: number;
        secret: Buffer | Uint8Array;
    }) => void;
    /** capability 서명 검증에 쓸 secret. 없으면 null. */
    secretFor: (launchId: string) => Buffer | null;
    /**
     * scope 검사. 통과하면 seq 를 전진시키고 필요한 결속을 확정한다.
     * **부작용이 있는 이유**: 재생 방지와 session 결속은 "확인했다" 가 아니라
     * "이 값으로 못 박았다" 여야 한다.
     */
    admit: (input: {
        launchId: string;
        seq: number;
        sessionId: string;
        /**
         * 보고가 실은 채택 대상. **부재와 잘못된 값은 다르다** — 부재는 채택을
         * 움직이지 않지만, 문자열이나 음수는 스키마를 통과해 그대로 콜백까지
         * 흘러가므로 거부해야 한다.
         */
        hostPid: { present: false } | { present: true; pid: number | null };
        /**
         * `session-runtime` 스키마에는 encryption 자리가 없다. 그래서 "이
         * 보고가 봉투를 말할 수 있는 종류인가" 를 먼저 가른다 — 그러지 않으면
         * 정당한 runtime 보고가 매번 mismatch 로 막힌다.
         */
        encryption:
            | { applicable: false }
            | { applicable: true; value: ManagedLaunchEncryption | null };
        now: number;
    }) => LaunchScopeVerdict;
    get: (launchId: string) => ManagedLaunchRecord | null;
    /** 만료된 기록을 지운다. 지워진 launch 의 보고는 `unknown-launch` 다. */
    evictExpired: (now: number) => number;
};

function isSafePositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function createManagedLaunchRegistry(): ManagedLaunchRegistry {
    const records = new Map<string, ManagedLaunchRecord>();
    const secrets = new Map<string, Buffer>();

    return {
        register(input) {
            if (!input.launchId.trim()) throw new Error('launch registration requires a launchId');
            if (records.has(input.launchId)) {
                // 같은 id 를 다시 등록하면 seq 와 session 결속이 초기화된다.
                throw new Error('launch already registered');
            }
            if (!input.sessionId.trim()) {
                throw new Error('launch registration requires the precreated sessionId');
            }
            if (!isSafePositiveInt(input.expiresAt)) {
                throw new Error('launch registration requires a positive safe expiry');
            }
            const secret = Buffer.from(input.secret);
            if (secret.length < 32) throw new Error('launch secret must be >= 32 bytes');
            const hostPids = new Set<number>();
            for (const pid of input.hostPids) {
                if (!isSafePositiveInt(pid)) throw new Error('launch host pid must be a positive safe integer');
                hostPids.add(pid);
            }
            records.set(input.launchId, {
                launchId: input.launchId,
                scope: { ...input.scope },
                hostPids,
                encryption: input.encryption ? { ...input.encryption } : null,
                expiresAt: input.expiresAt,
                sessionId: input.sessionId,
                lastSeq: 0,
            });
            secrets.set(input.launchId, secret);
        },

        secretFor(launchId) {
            return secrets.get(launchId) ?? null;
        },

        admit(input) {
            const record = records.get(input.launchId);
            if (!record) return { ok: false, reason: 'unknown-launch' };
            if (!Number.isFinite(input.now) || input.now >= record.expiresAt) {
                return { ok: false, reason: 'launch-expired' };
            }
            // 같은 seq 재전송도 재생이다.
            if (!isSafePositiveInt(input.seq) || input.seq <= record.lastSeq) {
                return { ok: false, reason: 'replayed-sequence' };
            }
            // 보고가 hostPid 를 실었다면 이 launch 가 만든 프로세스여야 한다.
            // 값을 실었는데 정수가 아니면 부재로 접지 않는다 — 접으면 잘못된
            // 값을 실어 검사를 건너뛸 수 있다.
            if (input.hostPid.present) {
                if (input.hostPid.pid === null) return { ok: false, reason: 'host-pid-invalid' };
                if (!record.hostPids.has(input.hostPid.pid)) {
                    return { ok: false, reason: 'host-pid-mismatch' };
                }
            }
            // 봉투를 말할 수 있는 보고에서만 본다. 등록된 신원이 있으면 보고가
            // 그것을 실어야 한다 — 빠뜨리는 것으로 검사를 건너뛰면 daemon 이
            // 봉투 없는 세션을 저장하게 된다.
            if (input.encryption.applicable) {
                const reported = input.encryption.value;
                if (record.encryption) {
                    if (!reported
                        || record.encryption.encryptionKey !== reported.encryptionKey
                        || record.encryption.encryptionVariant !== reported.encryptionVariant) {
                        return { ok: false, reason: 'encryption-mismatch' };
                    }
                } else if (reported) {
                    return { ok: false, reason: 'encryption-mismatch' };
                }
            }
            // 등록 시 확정된 세션과 정확히 같아야 한다. 첫 보고가 정하지 않는다.
            if (record.sessionId !== input.sessionId) {
                return { ok: false, reason: 'session-mismatch' };
            }

            record.lastSeq = input.seq;
            return { ok: true, record };
        },

        get(launchId) {
            return records.get(launchId) ?? null;
        },

        evictExpired(now) {
            let removed = 0;
            for (const [launchId, record] of records) {
                if (now >= record.expiresAt) {
                    records.delete(launchId);
                    secrets.delete(launchId);
                    removed += 1;
                }
            }
            return removed;
        },
    };
}
