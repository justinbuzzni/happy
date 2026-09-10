/**
 * The credential a managed daemon runs as, and every way it may not be used.
 *
 * The failure this file exists to prevent is not "the daemon does not start".
 * It is a cloud runtime that, having failed to find its own credential, falls
 * back to the ordinary path and ends up holding an account bearer — one that
 * reaches every session on that account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    MANAGED_DAEMON_CREDENTIAL_VERSION,
    managedDaemonCredentialPath,
    readManagedDaemonCredential,
    writeManagedDaemonCredential,
} from '@/daemon/managedDaemonCredential';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const NOW = 1_800_000_000_000;
const MACHINE_KEY = Buffer.alloc(32, 9);
const ACCOUNT_KEY = Buffer.alloc(32, 3);
const MACHINE = 'machine-1';

function deps(over: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const stat = lstatSync(path);
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

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: MANAGED_DAEMON_CREDENTIAL_VERSION,
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: MACHINE_KEY.toString('base64'),
        accountPublicKey: ACCOUNT_KEY.toString('base64'),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
        ...over,
    };
}

function credentialFor(over: Record<string, unknown> = {}) {
    return {
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: new Uint8Array(MACHINE_KEY),
        accountPublicKey: new Uint8Array(ACCOUNT_KEY),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
        ...over,
    };
}

function write(value: unknown): void {
    writeFileSync(managedDaemonCredentialPath(stateDir), JSON.stringify(value), { mode: 0o600 });
}

function read(over: { expectedMachineId?: string; now?: number } = {}) {
    return readManagedDaemonCredential({
        stateDir,
        expectedMachineId: over.expectedMachineId ?? MACHINE,
        now: over.now ?? NOW,
        deps: deps(),
    });
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'daemon-credential-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('reading the credential a managed daemon runs as', () => {
    it('accepts the record the parent issued', () => {
        write(record());
        const outcome = read();
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.credential).toEqual({
            machineId: MACHINE,
            token: 'daemon.scoped.bearer',
            machineKey: new Uint8Array(MACHINE_KEY),
            accountPublicKey: new Uint8Array(ACCOUNT_KEY),
            expiresAt: NOW + 60_000,
            serverOrigin: 'https://happy.example.test',
        });
    });

    it('separates absent, unusable and expired', () => {
        // Three different answers for the caller: nothing was issued yet, what
        // was issued cannot be trusted, and renewal would fix it.
        expect(read()).toEqual({ ok: false, reason: 'absent' });
        write(record({ version: 99 }));
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
        write(record({ expiresAt: NOW }));
        expect(read()).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a credential issued for another Machine', () => {
        // Using it would publish this runtime's readiness on somebody else's
        // address — and the marker, not this file, says which Machine we are.
        write(record({ machineId: 'machine-2' }));
        expect(read()).toEqual({ ok: false, reason: 'wrong-machine' });
    });

    it('refuses a record the agent could have written', () => {
        write(record());
        expect(readManagedDaemonCredential({
            stateDir,
            expectedMachineId: MACHINE,
            now: NOW,
            deps: deps({ statGate: () => ({ reason: 'not-root-owned' }) }),
        })).toEqual({ ok: false, reason: 'unusable' });
    });

    it.each([
        ['a machine key of the wrong length', { machineKey: Buffer.alloc(16, 9).toString('base64') }],
        ['a machine key that is not canonical base64', { machineKey: 'AAAA*AAA' }],
        ['an account key of the wrong length', { accountPublicKey: Buffer.alloc(31, 3).toString('base64') }],
        ['no account key', { accountPublicKey: '' }],
        ['no token', { token: '   ' }],
        ['an expiry that is not a number', { expiresAt: 'soon' }],
        ['no server origin', { serverOrigin: '' }],
        ['a server origin that is not a URL', { serverOrigin: 'happy.example.test' }],
        ['a server origin with a non-http scheme', { serverOrigin: 'file:///etc/passwd' }],
    ])('refuses %s', (_name, over) => {
        write(record(over));
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a record that is not JSON', () => {
        writeFileSync(managedDaemonCredentialPath(stateDir), 'nope', { mode: 0o600 });
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
    });
});

describe('writing the credential', () => {
    const credential = {
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: new Uint8Array(MACHINE_KEY),
        accountPublicKey: new Uint8Array(ACCOUNT_KEY),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
    };

    it('round-trips through the reader', async () => {
        await writeManagedDaemonCredential({ stateDir, credential });
        expect(read()).toEqual({ ok: true, credential });
    });

    it('replaces an earlier credential for the same Machine', async () => {
        // Renewal issues a new bearer. A record that could not be replaced would
        // stop the runtime working the moment the first one expired.
        await writeManagedDaemonCredential({ stateDir, credential });
        await writeManagedDaemonCredential({
            stateDir,
            credential: { ...credential, token: 'renewed.bearer', expiresAt: NOW + 120_000 },
        });
        const outcome = read();
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.credential.token).toBe('renewed.bearer');
    });

    it('leaves no readable file at a temporary name', async () => {
        // The write is a rename, so a crash leaves the old credential or the
        // new one — never a half-written record that reads as unusable.
        await writeManagedDaemonCredential({ stateDir, credential });
        expect(() => readFileSync(`${managedDaemonCredentialPath(stateDir)}.new`)).toThrow();
    });

    it('writes it readable only by its owner', async () => {
        await writeManagedDaemonCredential({ stateDir, credential });
        const mode = lstatSync(managedDaemonCredentialPath(stateDir)).mode & 0o777;
        expect(mode & 0o077).toBe(0);
    });

    it('flushes the directory entry', async () => {
        const synced: string[] = [];
        await writeManagedDaemonCredential({
            stateDir, credential, syncDirectory: async (path) => { synced.push(path); },
        });
        expect(synced).toEqual([stateDir]);
    });

    it('does not keep the key anywhere a later process inherits', async () => {
        // The machine key is a secret. It belongs in this file and in memory,
        // and nowhere a provider started later can read it.
        await writeManagedDaemonCredential({ stateDir, credential });
        const encoded = Buffer.from(MACHINE_KEY).toString('base64');
        expect(Object.values(process.env).some((value) => value?.includes(encoded))).toBe(false);
        chmodSync(managedDaemonCredentialPath(stateDir), 0o600);
    });
});

describe('two refreshers writing at the same time', () => {
    /*
     * The credential is refreshed by whoever notices it is close to expiry, and
     * "whoever" can be two callers at once — a heartbeat and a reconnect, or
     * two daemons briefly overlapping across a restart.
     *
     * With one shared temporary name they open the *same inode*: the first
     * renames it into place while the second is still writing, and the second's
     * bytes land inside the file that is already published. What comes back out
     * is neither credential.
     */
    it('never lets one writer land inside the other\'s published file', async () => {
        const first = credentialFor({ machineId: 'machine-first', token: 'token-first' });
        const second = credentialFor({ machineId: 'machine-first', token: 'token-second' });

        // Hold both fully written files before publication, then publish in a
        // known order. Each publication must expose that writer's entire value.
        const firstEntered = deferred();
        const secondEntered = deferred();
        const releaseFirst = deferred();
        const releaseSecond = deferred();
        const slow = writeManagedDaemonCredential({
            stateDir, credential: first,
            syncFile: async (handle) => {
                firstEntered.resolve();
                await releaseFirst.promise;
                await handle.sync();
            },
        });
        const other = writeManagedDaemonCredential({
            stateDir, credential: second,
            syncFile: async (handle) => {
                secondEntered.resolve();
                await releaseSecond.promise;
                await handle.sync();
            },
        });
        try {
            await Promise.all([firstEntered.promise, secondEntered.promise]);
            releaseFirst.resolve();
            await slow;
            const firstRead = read({ expectedMachineId: 'machine-first' });
            expect(firstRead).toMatchObject({ ok: true, credential: { token: first.token } });
            releaseSecond.resolve();
            await other;
            const secondRead = read({ expectedMachineId: 'machine-first' });
            expect(secondRead).toMatchObject({ ok: true, credential: { token: second.token } });
        } finally {
            releaseFirst.resolve();
            releaseSecond.resolve();
            await Promise.allSettled([slow, other]);
        }

        const readBack = read({ expectedMachineId: 'machine-first' });
        expect(readBack.ok).toBe(true);
        if (!readBack.ok) return;
        const credential = readBack.credential;
        // Whichever won, it is *one* of them in full — not a mixture.
        expect([first.token, second.token]).toContain(credential.token);
        expect(credential.machineId).toBe('machine-first');
        // And no temporary of either writer is left in the state directory.
        expect(readdirSync(stateDir).filter((name) => name.includes('tmp') || name.endsWith('.new')))
            .toEqual([]);
    });

    it('removes its own temporary when the write fails, and nobody else\'s', async () => {
        const other = join(stateDir, 'daemon-credential.json.someone-elses.tmp');
        writeFileSync(other, 'not mine', { mode: 0o600 });
        await expect(writeManagedDaemonCredential({
            stateDir,
            credential: credentialFor(),
            syncFile: async () => { throw new Error('injected file fsync failure'); },
        })).rejects.toThrow();
        // The other writer's file is untouched: cleaning up "temporaries" as a
        // class would delete the file a concurrent writer is about to publish.
        expect(readFileSync(other, 'utf8')).toBe('not mine');
        expect(readdirSync(stateDir).filter((name) => name.endsWith('.tmp')))
            .toEqual(['daemon-credential.json.someone-elses.tmp']);
    });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}
