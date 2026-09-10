/**
 * The parent's identity handoff, on a real filesystem.
 *
 * Real files, real modes, real symlinks; only ownership is injected, because
 * the test user is not root. What is asserted is the boundary this crosses: a
 * file written from outside the guest becomes the credential the daemon runs
 * as, or it does not become anything at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    MANAGED_DAEMON_CREDENTIAL_INPUT_VERSION,
    adoptManagedDaemonCredential,
} from '@/daemon/managedDaemonCredentialInput';
import {
    managedDaemonCredentialPath,
    readManagedDaemonCredential,
    writeManagedDaemonCredential,
} from '@/daemon/managedDaemonCredential';
import { assertProvisioningStat, probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;
let inputDir: string;
let inputPath: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const MACHINE = 'machine-managed-1';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const MACHINE_KEY = Buffer.alloc(32, 3);
const ACCOUNT_KEY = Buffer.alloc(32, 4);

function deps(over: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const stat = lstatSync(path, { throwIfNoEntry: false });
            if (!stat) {
                const error = new Error(`ENOENT: lstat '${path}'`);
                (error as NodeJS.ErrnoException).code = 'ENOENT';
                throw error;
            }
            return {
                uid: 0,
                mode: stat.mode,
                isDirectory: stat.isDirectory(),
                isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        statGate: () => null,
        probeIsolationBackend: probeIsolationBackendUnavailable,
        ...over,
    };
}

function delivered(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: MANAGED_DAEMON_CREDENTIAL_INPUT_VERSION,
        machineId: MACHINE,
        token: 'daemon.scoped.bearer.from.parent',
        machineKey: MACHINE_KEY.toString('base64'),
        accountPublicKey: ACCOUNT_KEY.toString('base64'),
        expiresAt: NOW + HOUR,
        serverOrigin: 'https://happy.example.test',
        ...over,
    };
}

function deliver(record: unknown = delivered()): void {
    writeFileSync(inputPath, JSON.stringify(record), { mode: 0o600 });
}

function adopt(over: { now?: number; expectedMachineId?: string } = {}) {
    return adoptManagedDaemonCredential({
        stateDir,
        expectedMachineId: over.expectedMachineId ?? MACHINE,
        now: over.now ?? NOW,
        deps: deps(),
        inputPath,
    });
}

function stored(over: { now?: number; expectedMachineId?: string } = {}) {
    return readManagedDaemonCredential({
        stateDir,
        expectedMachineId: over.expectedMachineId ?? MACHINE,
        now: over.now ?? NOW,
        deps: deps(),
    });
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'daemon-handoff-'));
    stateDir = join(base, 'state');
    inputDir = join(base, 'etc-saycode');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
    mkdirSync(inputDir, { mode: 0o700, recursive: true });
    inputPath = join(inputDir, 'daemon-credential.json');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('taking the identity the parent delivered', () => {
    it('writes the credential the daemon then reads back', async () => {
        // The two halves are one contract: a handoff that produced something
        // the reader rejects is a handoff that gets "fixed" by loosening the
        // reader.
        deliver();
        expect(await adopt()).toEqual({
            status: 'adopted', machineId: MACHINE, expiresAt: NOW + HOUR,
        });
        const read = stored();
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.credential.token).toBe('daemon.scoped.bearer.from.parent');
        expect(Buffer.from(read.credential.machineKey)).toEqual(MACHINE_KEY);
        expect(read.credential.serverOrigin).toBe('https://happy.example.test');
    });

    it('writes it readable only by its owner', async () => {
        deliver();
        await adopt();
        const mode = lstatSync(managedDaemonCredentialPath(stateDir)).mode & 0o777;
        expect(mode & 0o077).toBe(0);
    });

    it('never puts the delivered secrets in the environment', async () => {
        // A provider started later inherits the daemon's environment.
        deliver();
        const before = { ...process.env };
        await adopt();
        const key = MACHINE_KEY.toString('base64');
        expect(Object.values(process.env).some((value) => value?.includes(key))).toBe(false);
        expect(Object.values(process.env).some((value) => value?.includes('daemon.scoped.bearer.from.parent'))).toBe(false);
        expect(process.env).toEqual(before);
    });

    it('leaves the delivered file where it is', async () => {
        /*
         * Not this process's to remove: the provider owns it and re-creates it
         * on every start, and a runtime whose state directory is later replaced
         * has nothing else to fall back to.
         */
        deliver();
        await adopt();
        expect(JSON.parse(readFileSync(inputPath, 'utf8')).machineId).toBe(MACHINE);
    });

    it('reports absence as absence, not as a failure', async () => {
        // A BYOS machine, or a parent that has not wired this yet. The boot
        // stage decides what that means; this does not turn it into a refusal.
        expect(await adopt()).toEqual({ status: 'absent' });
    });
});

describe('what it refuses to take', () => {
    it('refuses a file anybody else could have written', async () => {
        deliver();
        expect(await adoptManagedDaemonCredential({
            stateDir,
            expectedMachineId: MACHINE,
            now: NOW,
            deps: deps({ statGate: () => ({ reason: 'not-root-owned' }) }),
            inputPath,
        })).toEqual({ status: 'refused', reason: 'input-untrusted' });
        expect(stored().ok).toBe(false);
    });

    it('refuses a file reached through a directory anybody can write', async () => {
        // The record can be genuine and still be swapped between the check and
        // the read.
        chmodSync(inputDir, 0o777);
        deliver();
        const outcome = await adopt();
        expect(outcome).toEqual({ status: 'refused', reason: 'input-untrusted' });
    });

    it('refuses a symlink standing where the file should be', async () => {
        const elsewhere = join(base, 'elsewhere.json');
        writeFileSync(elsewhere, JSON.stringify(delivered()), { mode: 0o600 });
        symlinkSync(elsewhere, inputPath);
        expect((await adopt()).status).toBe('refused');
        expect(stored().ok).toBe(false);
    });

    it('refuses an input file that another uid can read', async () => {
        /*
         * The marker's gate allows `0644` — it is an identity record, and being
         * world-readable costs nothing. This file is a bearer and a 32-byte
         * machine key: anything that can read it can *be* this runtime, so it
         * is judged by a stricter rule than the record beside it.
         *
         * Real modes on a real file; only ownership is injected, because the
         * test user is not root.
         */
        deliver();
        chmodSync(inputPath, 0o644);
        expect(await adopt()).toEqual({ status: 'refused', reason: 'input-untrusted' });
        expect(stored().ok).toBe(false);
    });

    it.each([
        ['group-readable', 0o640],
        ['group-writable', 0o620],
        ['world-readable', 0o604],
        ['executable by anyone else', 0o601],
    ])('refuses one that is %s', async (_name, mode) => {
        deliver();
        chmodSync(inputPath, mode);
        expect((await adopt()).status).toBe('refused');
    });

    it.each([
        ['a version this reader does not know', { version: 99 }],
        ['no machine id', { machineId: '   ' }],
        ['no token', { token: '' }],
        ['a machine key that is not 32 bytes', { machineKey: Buffer.alloc(16, 3).toString('base64') }],
        ['a machine key that is not base64', { machineKey: 'not base64!!' }],
        ['an account key that is not 32 bytes', { accountPublicKey: Buffer.alloc(64, 4).toString('base64') }],
        ['an expiry that is not a number', { expiresAt: 'soon' }],
        ['an origin with no scheme', { serverOrigin: 'happy.example.test' }],
        ['an origin that is not http', { serverOrigin: 'file:///etc/passwd' }],
    ])('refuses %s, and writes nothing', async (_name, over) => {
        deliver(delivered(over));
        expect(await adopt()).toEqual({ status: 'refused', reason: 'input-unusable' });
        expect(stored().ok).toBe(false);
    });

    it('refuses a record that is not JSON, and one that is not an object', async () => {
        writeFileSync(inputPath, 'not json', { mode: 0o600 });
        expect(await adopt()).toEqual({ status: 'refused', reason: 'input-unusable' });
        deliver([delivered()]);
        expect(await adopt()).toEqual({ status: 'refused', reason: 'input-unusable' });
    });

    it('takes the credential already on the volume when the delivered copy has lapsed', async () => {
        /*
         * The delivered file is the one the machine was created with, and the
         * provider re-materialises it on every start — so after the first
         * renewal it is routinely the older of the two. Judging its expiry
         * before looking at the volume turned an ordinary restart into a
         * runtime that would not boot.
         */
        await writeManagedDaemonCredential({
            stateDir,
            credential: {
                machineId: MACHINE,
                token: 'renewed.bearer',
                machineKey: new Uint8Array(MACHINE_KEY),
                accountPublicKey: new Uint8Array(ACCOUNT_KEY),
                expiresAt: NOW + 10 * HOUR,
                serverOrigin: 'https://happy.example.test',
            },
        });
        deliver(delivered({ expiresAt: NOW - 1 }));
        expect(await adopt()).toEqual({
            status: 'current', machineId: MACHINE, expiresAt: NOW + 10 * HOUR,
        });
        const read = stored();
        expect(read.ok && read.credential.token).toBe('renewed.bearer');
    });

    it('refuses a credential delivered already expired', async () => {
        // Nothing inside the guest can renew it: the renew route requires the
        // control plane's own signature. Writing it would produce a runtime
        // that starts and immediately stops.
        deliver(delivered({ expiresAt: NOW - 1 }));
        expect(await adopt()).toEqual({ status: 'refused', reason: 'input-expired' });
        expect(stored().ok).toBe(false);
    });

    it('refuses a credential for a Machine this runtime is not', async () => {
        // The marker says which Machine this is. A credential for another one
        // would publish this runtime's readiness where nobody is watching.
        deliver(delivered({ machineId: 'machine-somebody-else' }));
        expect(await adopt()).toEqual({ status: 'refused', reason: 'machine-conflict' });
        expect(stored().ok).toBe(false);
    });

    it('refuses to overwrite another Machine\'s credential already on this volume', async () => {
        await writeManagedDaemonCredential({
            stateDir,
            credential: {
                machineId: 'machine-that-was-here-first',
                token: 'existing.bearer',
                machineKey: new Uint8Array(MACHINE_KEY),
                accountPublicKey: new Uint8Array(ACCOUNT_KEY),
                expiresAt: NOW + HOUR,
                serverOrigin: 'https://happy.example.test',
            },
        });
        deliver();
        expect(await adopt()).toEqual({ status: 'refused', reason: 'machine-conflict' });
        // And the one that was there is untouched.
        const read = stored({ expectedMachineId: 'machine-that-was-here-first' });
        expect(read.ok && read.credential.token).toBe('existing.bearer');
    });
});

describe('a restart, with the delivered file still there', () => {
    it('keeps a renewed credential rather than walking it backwards', async () => {
        /*
         * The provider re-materialises the delivered file on every start. If
         * adoption were unconditional, every restart would replace a renewed
         * credential with the one the machine was created with — and that one
         * may already be expired.
         */
        deliver();
        await adopt();
        await writeManagedDaemonCredential({
            stateDir,
            credential: {
                machineId: MACHINE,
                token: 'renewed.bearer',
                machineKey: new Uint8Array(MACHINE_KEY),
                accountPublicKey: new Uint8Array(ACCOUNT_KEY),
                expiresAt: NOW + 10 * HOUR,
                serverOrigin: 'https://happy.example.test',
            },
        });

        expect(await adopt()).toEqual({
            status: 'current', machineId: MACHINE, expiresAt: NOW + 10 * HOUR,
        });
        const read = stored();
        expect(read.ok && read.credential.token).toBe('renewed.bearer');
    });

    it('takes the delivered one when what is stored has lapsed', async () => {
        // The other direction: a machine that sat stopped past its credential's
        // life starts again on the identity the parent re-delivered.
        await writeManagedDaemonCredential({
            stateDir,
            credential: {
                machineId: MACHINE,
                token: 'stale.bearer',
                machineKey: new Uint8Array(MACHINE_KEY),
                accountPublicKey: new Uint8Array(ACCOUNT_KEY),
                expiresAt: NOW - 1,
                serverOrigin: 'https://happy.example.test',
            },
        });
        deliver();
        expect((await adopt()).status).toBe('adopted');
        const read = stored();
        expect(read.ok && read.credential.token).toBe('daemon.scoped.bearer.from.parent');
    });

    it('adopts again when the parent delivered a longer-lived credential', async () => {
        deliver();
        await adopt();
        deliver(delivered({ token: 'second.bearer', expiresAt: NOW + 5 * HOUR }));
        expect(await adopt()).toEqual({
            status: 'adopted', machineId: MACHINE, expiresAt: NOW + 5 * HOUR,
        });
        const read = stored();
        expect(read.ok && read.credential.token).toBe('second.bearer');
    });
});

describe('root: private credential adoption boundaries', () => {
    /*
     * Folded in from root's own fixture, assertions unchanged. The first case
     * judges the mode through the *public* ownership gate — the one the marker
     * uses — so it proves the confidentiality rule is this module's own and not
     * something inherited from a stricter injected stat.
     */
    it('refuses an input file readable by another uid', async () => {
        deliver(); chmodSync(inputPath, 0o644);
        const result = await adoptManagedDaemonCredential({
            stateDir, expectedMachineId: MACHINE, now: NOW, inputPath,
            deps: deps({ statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }) }),
        });
        expect(result).toMatchObject({ status: 'refused', reason: 'input-untrusted' });
        expect(stored().ok).toBe(false);
    });

    it('keeps a valid renewed credential when the initial delivered copy expired', async () => {
        await writeManagedDaemonCredential({
            stateDir,
            credential: {
                machineId: MACHINE, token: 'renewed-token',
                machineKey: new Uint8Array(MACHINE_KEY), accountPublicKey: new Uint8Array(ACCOUNT_KEY),
                expiresAt: NOW + HOUR, serverOrigin: 'https://happy.example.test',
            },
        });
        deliver(delivered({ expiresAt: NOW - 1 }));
        expect(await adopt()).toEqual({ status: 'current', machineId: MACHINE, expiresAt: NOW + HOUR });
        const result = stored(); expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('stored credential lost');
        expect(result.credential.token).toBe('renewed-token');
    });
});
