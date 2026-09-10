/**
 * managed lifecycle report 검증기 — `controlServer` 가 부르는 그 함수.
 *
 * 두 단계를 **둘 다** 통과해야 한다:
 *   1. per-launch capability: 서명·만료·보고 종류·**본문 전체 digest**
 *   2. launch scope: 등록된 launch 인가, seq 가 전진하는가, hostPid 가 이
 *      launch 것인가, encryption 신원이 그대로인가, session 결속이 맞는가
 *
 * capability 만으로는 부족하다 — 서명은 "이 본문을 이 launch 가 만들었다" 까지만
 * 말하고, 그 launch 가 그 프로세스·세션을 보고할 자격이 있는지는 원장이 답한다.
 *
 * **registry 나 capability 가 없으면 거부다.** 허용 기본값을 두지 않는다.
 * 그리고 이 검증은 프로세스가 끝났음을 증명하지 않는다 — 보고는 자기주장이고,
 * 종료 증거는 커널/backend 몫이다.
 */
import type { ManagedReportClaim } from '../controlServer';
import {
    MANAGED_REPORT_CAPABILITY_HEADER,
    readCapabilityLaunchId,
    verifyManagedReportCapability,
} from './managedReportCapability';
import type { ManagedLaunchEncryption, ManagedLaunchRegistry } from './managedLaunchRegistry';

export type ManagedReportVerdict = { ok: true } | { ok: false; reason: string };

function readHeader(headers: Record<string, unknown>): string | null {
    const raw = headers[MANAGED_REPORT_CAPABILITY_HEADER];
    // Node 는 중복 헤더를 배열로 준다. 어느 쪽을 믿을지 고르지 않고 거부한다.
    if (typeof raw !== 'string') return null;
    return raw.trim() ? raw : null;
}

type HostPidField = { present: false } | { present: true; pid: number | null };

/**
 * 보고가 daemon 의 프로세스 채택을 움직이는 값. 종류마다 자리가 다르다.
 *
 * **부재와 잘못된 값을 구분한다.** 두 스키마 모두 이 자리를 느슨하게 받으므로
 * `'4242'` 나 `-1` 이 검증을 지나 콜백까지 원문으로 흘러간다. 잘못된 값을
 * `null`(부재)로 접으면 그 자체가 검사를 건너뛰는 방법이 된다.
 */
function readHostPid(claim: ManagedReportClaim): HostPidField {
    const raw = claim.kind === 'session-started'
        ? (() => {
            const metadata = claim.report.metadata;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
            return (metadata as { hostPid?: unknown }).hostPid;
        })()
        : claim.report.hostPid;
    if (raw === undefined || raw === null) return { present: false };
    const valid = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0;
    return { present: true, pid: valid ? raw : null };
}

/**
 * `session-runtime` 은 봉투를 싣지 않는 종류다. 그것을 "봉투 없음" 으로 읽으면
 * 정당한 runtime 보고가 전부 mismatch 가 된다.
 */
function readEncryption(
    claim: ManagedReportClaim,
): { applicable: false } | { applicable: true; value: ManagedLaunchEncryption | null } {
    if (claim.kind !== 'session-started') return { applicable: false };
    const encryption = claim.report.encryption;
    if (!encryption) return { applicable: true, value: null };
    return {
        applicable: true,
        value: {
            encryptionKey: encryption.encryptionKey,
            encryptionVariant: encryption.encryptionVariant,
        },
    };
}

export function createManagedReportVerifier(input: {
    registry: ManagedLaunchRegistry;
    now: () => number;
}): (claim: ManagedReportClaim) => ManagedReportVerdict {
    return (claim) => {
        const capability = readHeader(claim.headers);
        if (!capability) return { ok: false, reason: 'capability-missing' };
        const launchId = readCapabilityLaunchId(capability);
        if (!launchId) return { ok: false, reason: 'capability-malformed' };
        const secret = input.registry.secretFor(launchId);
        // 알 수 없는 launch 와 서명 실패를 같은 이유로 접지 않는다 — 다만 어느
        // 쪽도 통과시키지 않는다.
        if (!secret) return { ok: false, reason: 'unknown-launch' };

        const now = input.now();
        const verified = verifyManagedReportCapability({
            capability, secret, kind: claim.kind, body: claim.report, now,
        });
        if (!verified.ok) return { ok: false, reason: `capability-${verified.reason}` };

        const admitted = input.registry.admit({
            launchId,
            seq: verified.claims.seq,
            sessionId: claim.sessionId,
            hostPid: readHostPid(claim),
            encryption: readEncryption(claim),
            now,
        });
        if (!admitted.ok) return { ok: false, reason: admitted.reason };
        return { ok: true };
    };
}
