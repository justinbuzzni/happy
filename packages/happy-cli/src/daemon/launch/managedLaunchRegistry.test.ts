import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createManagedLaunchRegistry, type ManagedLaunchScope } from './managedLaunchRegistry';

const NOW = 1_800_000_000_000;
const SCOPE: ManagedLaunchScope = {
    operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1',
    epoch: 3, workspaceId: 'ws-1', projectId: 'project-1',
};
const ENCRYPTION = { encryptionKey: 'key-1', encryptionVariant: 'dataKey' as const };

function registry() {
    const reg = createManagedLaunchRegistry();
    reg.register({
        launchId: 'launch-1', scope: SCOPE, sessionId: 's-1', hostPids: [4242],
        encryption: ENCRYPTION, expiresAt: NOW + 60_000, secret: randomBytes(32),
    });
    return reg;
}

const base = {
    launchId: 'launch-1', seq: 1, sessionId: 's-1',
    hostPid: { present: true as const, pid: 4242 },
    encryption: { applicable: true as const, value: ENCRYPTION }, now: NOW,
};

describe('trusted launch registry', () => {
    it('an empty registry admits nothing', () => {
        expect(createManagedLaunchRegistry().admit(base)).toEqual({ ok: false, reason: 'unknown-launch' });
    });

    it('admits a report from a registered launch', () => {
        expect(registry().admit(base)).toMatchObject({ ok: true, record: { scope: SCOPE } });
    });

    it('refuses a replayed or reordered sequence', () => {
        const reg = registry();
        expect(reg.admit({ ...base, seq: 5 }).ok).toBe(true);
        expect(reg.admit({ ...base, seq: 5 })).toEqual({ ok: false, reason: 'replayed-sequence' });
        expect(reg.admit({ ...base, seq: 4 })).toEqual({ ok: false, reason: 'replayed-sequence' });
        expect(reg.admit({ ...base, seq: 6 }).ok).toBe(true);
    });

    it('refuses a host pid this launch never created', () => {
        expect(registry().admit({ ...base, hostPid: { present: true, pid: 9999 } }))
            .toEqual({ ok: false, reason: 'host-pid-mismatch' });
    });

    it('refuses a submitted host pid that is not a positive safe integer', () => {
        // 부재로 접으면 잘못된 값을 실어 검사를 건너뛸 수 있다.
        expect(registry().admit({ ...base, hostPid: { present: true, pid: null } }))
            .toEqual({ ok: false, reason: 'host-pid-invalid' });
    });

    it('allows a report that carries no host pid — it steers no adoption', () => {
        expect(registry().admit({ ...base, hostPid: { present: false } }).ok).toBe(true);
    });

    it('refuses a swapped encryption identity', () => {
        expect(registry().admit({
            ...base,
            encryption: { applicable: true, value: { encryptionKey: 'other', encryptionVariant: 'dataKey' } },
        })).toEqual({ ok: false, reason: 'encryption-mismatch' });
        expect(registry().admit({
            ...base,
            encryption: { applicable: true, value: { encryptionKey: 'key-1', encryptionVariant: 'legacy' } },
        })).toEqual({ ok: false, reason: 'encryption-mismatch' });
    });

    it('the session comes from registration, not from the first report', () => {
        const reg = registry();
        expect(reg.get('launch-1')?.sessionId).toBe('s-1');
        // 아직 아무 보고도 없었는데 다른 세션을 주장하면 **첫 보고부터** 거부다.
        expect(reg.admit({ ...base, sessionId: 's-other' }))
            .toEqual({ ok: false, reason: 'session-mismatch' });
        expect(reg.admit(base).ok).toBe(true);
    });

    it('refuses a report that omits the registered encryption identity', () => {
        expect(registry().admit({ ...base, encryption: { applicable: true, value: null } }))
            .toEqual({ ok: false, reason: 'encryption-mismatch' });
    });

    it('does not check the envelope on a report kind that cannot carry one', () => {
        // `session-runtime` 에는 봉투 자리가 없다.
        expect(registry().admit({ ...base, encryption: { applicable: false } }).ok).toBe(true);
    });

    it('refuses an encryption identity when the launch registered none', () => {
        const reg = createManagedLaunchRegistry();
        reg.register({
            launchId: 'launch-1', scope: SCOPE, sessionId: 's-1', hostPids: [4242],
            expiresAt: NOW + 60_000, secret: randomBytes(32),
        });
        expect(reg.admit(base)).toEqual({ ok: false, reason: 'encryption-mismatch' });
        expect(reg.admit({ ...base, encryption: { applicable: true, value: null } }).ok).toBe(true);
    });

    it('refuses at and after the launch expiry, and on an unusable clock', () => {
        expect(registry().admit({ ...base, now: NOW + 60_000 }))
            .toEqual({ ok: false, reason: 'launch-expired' });
        expect(registry().admit({ ...base, now: Number.NaN }))
            .toEqual({ ok: false, reason: 'launch-expired' });
    });

    it('does not advance the sequence when the report is refused', () => {
        const reg = registry();
        expect(reg.admit({ ...base, seq: 7, hostPid: { present: true, pid: 9999 } }).ok).toBe(false);
        // 거부가 seq 를 태우면 정당한 보고가 재생으로 잘못 몰린다.
        expect(reg.admit({ ...base, seq: 7 }).ok).toBe(true);
    });

    it('refuses to register the same launch twice', () => {
        const reg = registry();
        expect(() => reg.register({
            launchId: 'launch-1', scope: SCOPE, sessionId: 's-1', hostPids: [1],
            expiresAt: NOW + 1, secret: randomBytes(32),
        })).toThrow(/already registered/);
    });

    it('refuses registrations that cannot be trusted', () => {
        const reg = createManagedLaunchRegistry();
        const ok = { launchId: 'l', scope: SCOPE, sessionId: 's-1', hostPids: [1], expiresAt: NOW + 1 };
        expect(() => reg.register({ ...ok, secret: randomBytes(31) })).toThrow(/32 bytes/);
        expect(() => reg.register({ ...ok, hostPids: [0], secret: randomBytes(32) })).toThrow(/host pid/);
        expect(() => reg.register({ ...ok, expiresAt: 0, secret: randomBytes(32) })).toThrow(/expiry/);
        expect(() => reg.register({ ...ok, sessionId: '  ', secret: randomBytes(32) }))
            .toThrow(/precreated sessionId/);
    });

    it('evicting an expired launch makes its reports unknown, not allowed', () => {
        const reg = registry();
        expect(reg.evictExpired(NOW + 60_000)).toBe(1);
        expect(reg.admit(base)).toEqual({ ok: false, reason: 'unknown-launch' });
        expect(reg.secretFor('launch-1')).toBeNull();
    });
});
