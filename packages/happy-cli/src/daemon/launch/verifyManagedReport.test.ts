import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import type { ManagedReportClaim } from '../controlServer';
import { createManagedLaunchRegistry, type ManagedLaunchScope } from './managedLaunchRegistry';
import {
    MANAGED_REPORT_CAPABILITY_HEADER,
    mintManagedReportCapability,
} from './managedReportCapability';
import { createManagedReportVerifier } from './verifyManagedReport';

const NOW = 1_800_000_000_000;
const SECRET = randomBytes(32);
const SCOPE: ManagedLaunchScope = {
    operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1',
    epoch: 3, workspaceId: 'ws-1', projectId: 'project-1',
};
const ENCRYPTION = {
    encryptionKey: 'key-1', encryptionVariant: 'dataKey' as const,
    seq: 1, metadataVersion: 1, agentStateVersion: 1,
};

function setup(over: { pids?: number[]; expiresAt?: number } = {}) {
    const registry = createManagedLaunchRegistry();
    registry.register({
        launchId: 'launch-1', scope: SCOPE, sessionId: 's-1', hostPids: over.pids ?? [4242],
        encryption: { encryptionKey: 'key-1', encryptionVariant: 'dataKey' },
        expiresAt: over.expiresAt ?? NOW + 60_000, secret: SECRET,
    });
    return { registry, verify: createManagedReportVerifier({ registry, now: () => NOW }) };
}

function startedClaim(over: { report?: unknown; seq?: number; secret?: Buffer } = {}): ManagedReportClaim {
    const report = (over.report ?? {
        sessionId: 's-1', metadata: { hostPid: 4242 }, encryption: ENCRYPTION,
    }) as ManagedReportClaim & { sessionId: string };
    const capability = mintManagedReportCapability({
        secret: over.secret ?? SECRET, launchId: 'launch-1', kind: 'session-started',
        seq: over.seq ?? 1, expiresAt: NOW + 60_000, body: report,
    });
    return {
        kind: 'session-started',
        sessionId: (report as { sessionId: string }).sessionId,
        headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
        report: report as never,
    };
}

describe('managed report verifier', () => {
    it('accepts a report signed by its own launch and matching the registry', () => {
        expect(setup().verify(startedClaim())).toEqual({ ok: true });
    });

    it('refuses when no capability header is present', () => {
        const claim = startedClaim();
        expect(setup().verify({ ...claim, headers: {} }))
            .toEqual({ ok: false, reason: 'capability-missing' });
    });

    it('refuses a duplicated header rather than choosing one', () => {
        const claim = startedClaim();
        const capability = claim.headers[MANAGED_REPORT_CAPABILITY_HEADER] as string;
        expect(setup().verify({ ...claim, headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: [capability, capability] } }))
            .toEqual({ ok: false, reason: 'capability-missing' });
    });

    it('refuses a capability minted by an unknown launch', () => {
        const registry = createManagedLaunchRegistry();
        const verify = createManagedReportVerifier({ registry, now: () => NOW });
        expect(verify(startedClaim())).toEqual({ ok: false, reason: 'unknown-launch' });
    });

    it('refuses a capability signed with another secret', () => {
        expect(setup().verify(startedClaim({ secret: randomBytes(32) })))
            .toEqual({ ok: false, reason: 'capability-bad-signature' });
    });

    it('refuses a correct session id whose hostPid was swapped', () => {
        // 서명 대상 자체를 바꿨으므로 body digest 에서 먼저 걸린다.
        const claim = startedClaim();
        const forged = {
            ...claim,
            report: { sessionId: 's-1', metadata: { hostPid: 9999 }, encryption: ENCRYPTION },
        } as ManagedReportClaim;
        expect(setup().verify(forged)).toEqual({ ok: false, reason: 'capability-body-mismatch' });
    });

    it('refuses a hostPid this launch never created even when properly signed', () => {
        const claim = startedClaim({
            report: { sessionId: 's-1', metadata: { hostPid: 9999 }, encryption: ENCRYPTION },
        });
        expect(setup().verify(claim)).toEqual({ ok: false, reason: 'host-pid-mismatch' });
    });

    it('refuses a swapped encryption identity', () => {
        const claim = startedClaim({
            report: {
                sessionId: 's-1', metadata: { hostPid: 4242 },
                encryption: { ...ENCRYPTION, encryptionKey: 'other-key' },
            },
        });
        expect(setup().verify(claim)).toEqual({ ok: false, reason: 'encryption-mismatch' });
    });

    it('refuses the same report replayed', () => {
        const { verify } = setup();
        const claim = startedClaim({ seq: 4 });
        expect(verify(claim)).toEqual({ ok: true });
        expect(verify(claim)).toEqual({ ok: false, reason: 'replayed-sequence' });
    });

    it('refuses a launch reporting a session it was not registered for', () => {
        // child 가 capability secret 을 가지고 있으므로 아무 session id 나 서명해
        // 보낼 수 있다. 본문 HMAC 는 "이 launch 가 만든 본문" 까지만 말한다 —
        // **어느 세션을 보고할 자격이 있는지**는 등록된 SID 가 답한다.
        const { registry, verify } = setup();
        registry.register({
            launchId: 'launch-2', scope: SCOPE, sessionId: 's-2', hostPids: [4242],
            expiresAt: NOW + 60_000, secret: SECRET,
        });
        const body = { sessionId: 's-1', metadata: { hostPid: 4242 } };
        const capability = mintManagedReportCapability({
            secret: SECRET, launchId: 'launch-2', kind: 'session-started',
            seq: 1, expiresAt: NOW + 60_000, body,
        });
        expect(verify({
            kind: 'session-started', sessionId: 's-1',
            headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
            report: body,
        })).toEqual({ ok: false, reason: 'session-mismatch' });
    });

    it('refuses a session mismatch even on the very first report of a launch', () => {
        const { verify } = setup();
        const body = { sessionId: 's-other', metadata: { hostPid: 4242 }, encryption: ENCRYPTION };
        const capability = mintManagedReportCapability({
            secret: SECRET, launchId: 'launch-1', kind: 'session-started',
            seq: 1, expiresAt: NOW + 60_000, body,
        });
        expect(verify({
            kind: 'session-started', sessionId: 's-other',
            headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
            report: body,
        })).toEqual({ ok: false, reason: 'session-mismatch' });
    });

    it('refuses a report whose hostPid is present but not a positive safe integer', () => {
        const { verify } = setup();
        // z.any 를 통과한 문자열/음수가 원문 그대로 콜백까지 흘러간다.
        for (const hostPid of ['4242', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            const body = { sessionId: 's-1', hostPid };
            const capability = mintManagedReportCapability({
                secret: SECRET, launchId: 'launch-1', kind: 'session-runtime',
                seq: 1, expiresAt: NOW + 60_000, body,
            });
            expect(verify({
                kind: 'session-runtime', sessionId: 's-1',
                headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
                report: body,
            })).toEqual({ ok: false, reason: 'host-pid-invalid' });
        }
    });

    it('an invalid hostPid refusal does not burn the sequence', () => {
        const { verify } = setup();
        const bad = { sessionId: 's-1', hostPid: '4242' };
        verify({
            kind: 'session-runtime', sessionId: 's-1',
            headers: {
                [MANAGED_REPORT_CAPABILITY_HEADER]: mintManagedReportCapability({
                    secret: SECRET, launchId: 'launch-1', kind: 'session-runtime',
                    seq: 3, expiresAt: NOW + 60_000, body: bad,
                }),
            },
            report: bad,
        });
        const good = { sessionId: 's-1', hostPid: 4242 };
        expect(verify({
            kind: 'session-runtime', sessionId: 's-1',
            headers: {
                [MANAGED_REPORT_CAPABILITY_HEADER]: mintManagedReportCapability({
                    secret: SECRET, launchId: 'launch-1', kind: 'session-runtime',
                    seq: 3, expiresAt: NOW + 60_000, body: good,
                }),
            },
            report: good,
        })).toEqual({ ok: true });
    });

    it('refuses an expired launch', () => {
        const { verify } = setup({ expiresAt: NOW });
        expect(verify(startedClaim()).ok).toBe(false);
    });

    it('a runtime report cannot reuse a session-started capability', () => {
        const body = { sessionId: 's-1', hostPid: 4242 };
        const capability = mintManagedReportCapability({
            secret: SECRET, launchId: 'launch-1', kind: 'session-started',
            seq: 1, expiresAt: NOW + 60_000, body,
        });
        expect(setup().verify({
            kind: 'session-runtime', sessionId: 's-1',
            headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
            report: body,
        })).toEqual({ ok: false, reason: 'capability-wrong-kind' });
    });

    it('accepts a runtime report bound to the same launch and pid', () => {
        const body = { sessionId: 's-1', hostPid: 4242 };
        const capability = mintManagedReportCapability({
            secret: SECRET, launchId: 'launch-1', kind: 'session-runtime',
            seq: 1, expiresAt: NOW + 60_000, body,
        });
        expect(setup().verify({
            kind: 'session-runtime', sessionId: 's-1',
            headers: { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
            report: body,
        })).toEqual({ ok: true });
    });
});
