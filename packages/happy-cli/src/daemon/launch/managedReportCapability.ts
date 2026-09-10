/**
 * specs/managed-cloud-byos — managed lifecycle report 의 **per-launch** 증명.
 *
 * daemon 전역 `controlSecret` 은 이 자리에 쓸 수 없다. managed runtime 에서
 * 그 값은 agent 자신의 도구가 읽을 수 있어(`controlServer.ts` 주석) "이 호스트의
 * 무언가"만 증명하고 **어느 launch 가 말하는지**는 증명하지 못한다. 그 근거로
 * 보고를 받아들이면 임의 코드가 다른 Run 의 session id 를 위조한다.
 *
 * 그래서 capability 는 launch 마다 다르고, launcher 가 만들어 보호된 FD 봉투로
 * child 에게만 준다. 부모 B2 params 에는 들어가지 않는다.
 *
 * 무엇에 묶이는가 — **전부** 서명 대상이다:
 *   - `launchId`  어느 launch 인지
 *   - `kind`      보고 종류. 종류를 바꿔 다른 검사를 타지 못한다.
 *   - `seq`       재생 방지. 같은 값 재사용은 거부이며 증가만 허용한다.
 *   - `expiresAt` 만료
 *   - 파싱된 **본문 전체**의 canonical digest. `sessionId` 만으로는 부족하다 —
 *     `metadata.hostPid` / `hostPid` 가 daemon 이 어느 프로세스를 채택할지
 *     정하고 encryption scope 도 본문에 있다.
 *
 * 이것은 **프로세스 종료를 증명하지 않는다.** 보고는 자기주장이고, 종료 증거는
 * 커널/backend 몫이다.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalManagedPayloadDigest } from '../managedDispatchToken';

/** 헤더 이름. 값은 아래 인코딩된 capability 하나뿐이다. */
export const MANAGED_REPORT_CAPABILITY_HEADER = 'x-happy-managed-report';

export const MANAGED_REPORT_KINDS = ['session-started', 'session-runtime'] as const;
export type ManagedReportKind = (typeof MANAGED_REPORT_KINDS)[number];

/** 파싱 전에 거는 상한. 헤더 하나가 임의 크기 입력이 되지 않게 한다. */
export const MAX_CAPABILITY_BYTES = 4096;

export type ManagedReportCapabilityClaims = {
    v: 1;
    launchId: string;
    kind: ManagedReportKind;
    seq: number;
    expiresAt: number;
    /** 본문 전체의 canonical digest. */
    bodyDigest: string;
};

export type CapabilityFailure =
    | 'malformed'
    | 'too-large'
    | 'unsupported-version'
    | 'bad-signature'
    | 'expired'
    | 'body-mismatch'
    | 'wrong-kind';

export type CapabilityVerification =
    | { ok: true; claims: ManagedReportCapabilityClaims }
    | { ok: false; reason: CapabilityFailure };

const MAX_ID_LENGTH = 200;

function isSafePositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_ID_LENGTH && trimmed === value ? trimmed : null;
}

function encodePayload(claims: ManagedReportCapabilityClaims): string {
    // 서명 대상은 canonical 직렬화다. 키 순서가 바뀌어도 같은 서명이 나온다.
    return Buffer.from(JSON.stringify({
        v: claims.v,
        launchId: claims.launchId,
        kind: claims.kind,
        seq: claims.seq,
        expiresAt: claims.expiresAt,
        bodyDigest: claims.bodyDigest,
    })).toString('base64url');
}

function sign(payload: string, secret: Buffer): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * launcher 가 child 에게 줄 capability 를 만든다.
 *
 * 본문은 아직 없으므로 digest 는 호출부가 넘긴다 — 즉 launcher 는 child 가 보낼
 * 본문을 미리 알아야 하는 것이 아니라, child 가 보고할 때마다 자기 secret 으로
 * 서명한다. 그래서 이 함수는 launcher 와 child 양쪽에서 같은 코드를 쓴다.
 */
export function mintManagedReportCapability(input: {
    secret: Buffer | Uint8Array;
    launchId: string;
    kind: ManagedReportKind;
    seq: number;
    expiresAt: number;
    body: unknown;
}): string {
    const launchId = readId(input.launchId);
    if (!launchId) throw new Error('managed report capability requires a launchId');
    if (!MANAGED_REPORT_KINDS.includes(input.kind)) {
        throw new Error('managed report capability requires a known kind');
    }
    if (!isSafePositiveInt(input.seq) || !isSafePositiveInt(input.expiresAt)) {
        throw new Error('managed report capability requires positive safe integers');
    }
    const secret = Buffer.from(input.secret);
    if (secret.length < 32) throw new Error('managed report capability secret must be >= 32 bytes');
    const payload = encodePayload({
        v: 1,
        launchId,
        kind: input.kind,
        seq: input.seq,
        expiresAt: input.expiresAt,
        bodyDigest: canonicalManagedPayloadDigest(input.body),
    });
    return `${payload}.${sign(payload, secret)}`;
}

/** capability 에서 서명 없이 `launchId` 만 꺼낸다 — secret 을 고르기 위해서다. */
export function readCapabilityLaunchId(capability: string): string | null {
    if (typeof capability !== 'string' || capability.length > MAX_CAPABILITY_BYTES) return null;
    const [payload] = capability.split('.');
    if (!payload) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        return readId((parsed as { launchId?: unknown }).launchId);
    } catch {
        return null;
    }
}

/**
 * 서명·만료·종류·본문 일치를 확인한다. 여기서 통과해도 **scope 검사는 별개다**
 * — launch registry 가 hostPid·encryption·session 결속과 재생을 본다.
 */
export function verifyManagedReportCapability(input: {
    capability: string;
    secret: Buffer | Uint8Array;
    kind: ManagedReportKind;
    body: unknown;
    now: number;
}): CapabilityVerification {
    if (typeof input.capability !== 'string') return { ok: false, reason: 'malformed' };
    if (Buffer.byteLength(input.capability, 'utf8') > MAX_CAPABILITY_BYTES) {
        return { ok: false, reason: 'too-large' };
    }
    const parts = input.capability.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [payload, signature] = parts as [string, string];
    if (!payload || !signature) return { ok: false, reason: 'malformed' };

    const secret = Buffer.from(input.secret);
    const expected = Buffer.from(sign(payload, secret), 'utf8');
    const received = Buffer.from(signature, 'utf8');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        return { ok: false, reason: 'bad-signature' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return { ok: false, reason: 'unsupported-version' };
    const launchId = readId(record.launchId);
    const bodyDigest = readId(record.bodyDigest);
    if (!launchId || !bodyDigest) return { ok: false, reason: 'malformed' };
    if (!isSafePositiveInt(record.seq) || !isSafePositiveInt(record.expiresAt)) {
        return { ok: false, reason: 'malformed' };
    }
    if (typeof record.kind !== 'string'
        || !MANAGED_REPORT_KINDS.includes(record.kind as ManagedReportKind)) {
        return { ok: false, reason: 'malformed' };
    }
    // 종류가 다르면 다른 검사를 타게 된다.
    if (record.kind !== input.kind) return { ok: false, reason: 'wrong-kind' };
    if (!Number.isFinite(input.now)) return { ok: false, reason: 'expired' };
    if (input.now >= record.expiresAt) return { ok: false, reason: 'expired' };
    if (canonicalManagedPayloadDigest(input.body) !== bodyDigest) {
        return { ok: false, reason: 'body-mismatch' };
    }
    return {
        ok: true,
        claims: {
            v: 1,
            launchId,
            kind: record.kind as ManagedReportKind,
            seq: record.seq,
            expiresAt: record.expiresAt,
            bodyDigest,
        },
    };
}
