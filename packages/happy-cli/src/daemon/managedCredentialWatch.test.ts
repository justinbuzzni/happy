/**
 * What a running managed daemon does as its credential changes underneath it.
 *
 * Two failures are worth more than the others here: a renewal that is never
 * picked up (the socket works until the first network flap and then never comes
 * back, which reads as a network fault), and an expiry that is treated as one
 * (the runtime reconnects forever with a dead bearer while the parent has
 * already moved on).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { decideManagedCredentialAction, readManagedCredentialAction } from '@/daemon/managedCredentialWatch';
import {
    MANAGED_DAEMON_CREDENTIAL_VERSION,
    managedDaemonCredentialPath,
} from '@/daemon/managedDaemonCredential';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const NOW = 1_800_000_000_000;
const MACHINE = 'machine-1';
const CURRENT = { token: 'first.bearer', expiresAt: NOW + 60_000 };

function deps(): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const stat = lstatSync(path);
            return {
                uid: 0, mode: stat.mode,
                isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        statGate: () => null,
        probeIsolationBackend: probeIsolationBackendUnavailable,
    };
}

function write(over: Record<string, unknown> = {}): void {
    writeFileSync(managedDaemonCredentialPath(stateDir), JSON.stringify({
        version: MANAGED_DAEMON_CREDENTIAL_VERSION,
        machineId: MACHINE,
        token: 'first.bearer',
        machineKey: Buffer.alloc(32, 9).toString('base64'),
        accountPublicKey: Buffer.alloc(32, 3).toString('base64'),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
        ...over,
    }), { mode: 0o600 });
}

function act(now = NOW) {
    return readManagedCredentialAction({
        stateDir, expectedMachineId: MACHINE, current: CURRENT, now, deps: deps(),
    });
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'credential-watch-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('a managed daemon watching its own credential', () => {
    it('does nothing while the credential is the one it holds', () => {
        write();
        expect(act()).toEqual({ kind: 'unchanged' });
    });

    it('takes up a renewal for the next connection', () => {
        // The handshake copies the token at connect time. A renewal that was
        // not taken up keeps presenting the expired one on every reconnect.
        write({ token: 'renewed.bearer', expiresAt: NOW + 600_000 });
        expect(act()).toEqual({ kind: 'renewed', token: 'renewed.bearer', expiresAt: NOW + 600_000 });
    });

    it('stops when nobody renewed it in time', () => {
        write({ expiresAt: NOW });
        expect(act()).toEqual({ kind: 'stop', reason: 'expired' });
    });

    it('stops when the record was removed under a running daemon', () => {
        // The parent withdrew it. Reconnecting anyway would look like a network
        // fault while the real answer is that this runtime is not authorised.
        expect(act()).toEqual({ kind: 'stop', reason: 'withdrawn' });
    });

    it('stops rather than adopting a credential for another Machine', () => {
        // The marker says which Machine this runtime is. A record disagreeing
        // with it would publish this runtime's readiness somewhere else.
        write({ machineId: 'machine-2' });
        expect(act()).toEqual({ kind: 'stop', reason: 'wrong-machine' });
    });

    it('keeps working through a record it cannot read', () => {
        /*
         * A partial write — the parent replacing it right now — is not a reason
         * to end a healthy runtime. The credential in hand is still good until
         * it expires on its own, and expiry is checked separately.
         */
        writeFileSync(managedDaemonCredentialPath(stateDir), '{half', { mode: 0o600 });
        expect(act()).toEqual({ kind: 'unchanged' });
    });

    it('stops once the credential in hand has expired, even if the record is unreadable', () => {
        /*
         * "Cannot read the record" is a reason to keep using what we hold — but
         * only for as long as what we hold is valid. Without that bound, a
         * record that stays unreadable (a partial write nobody finished, a file
         * the parent removed and replaced badly) keeps a runtime alive on a
         * dead bearer forever, and every server call fails in a way that looks
         * like a network fault.
         */
        writeFileSync(managedDaemonCredentialPath(stateDir), '{half', { mode: 0o600 });
        expect(act(CURRENT.expiresAt - 1)).toEqual({ kind: 'unchanged' });
        expect(act(CURRENT.expiresAt + 1)).toEqual({ kind: 'stop', reason: 'expired' });
    });

    it('does not confuse "cannot read" with "expired"', () => {
        // Both are `ok: false`. Collapsing them either ends healthy runtimes on
        // a transient read, or keeps dead ones alive on a real expiry.
        expect(decideManagedCredentialAction({
            current: CURRENT, now: NOW, latest: { ok: false, reason: 'unusable' },
        })).toEqual({ kind: 'unchanged' });
        expect(decideManagedCredentialAction({
            current: CURRENT, now: NOW, latest: { ok: false, reason: 'expired' },
        })).toEqual({ kind: 'stop', reason: 'expired' });
    });
});
