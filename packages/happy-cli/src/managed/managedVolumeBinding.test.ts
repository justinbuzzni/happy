/**
 * The volume a runtime is on: sealed once, verified after.
 *
 * The real filesystem for the record, real `lstat` for the trusted-path walk;
 * only ownership is injected, because the test user is not root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    managedVolumeSealPath,
    resolveManagedVolumeBinding,
    type ManagedVolumeObservation,
} from '@/managed/managedVolumeBinding';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const VOLUME = 'vol_provider_1';
const OBSERVED: ManagedVolumeObservation = { deviceMajorMinor: '259:1', fsUuid: 'fs-uuid-1' };

function deps(over: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const stat = lstatSync(path, { throwIfNoEntry: false });
            if (!stat) {
                const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`);
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

const resolve = (over: Partial<Parameters<typeof resolveManagedVolumeBinding>[0]> = {}) =>
    resolveManagedVolumeBinding({
        stateDir,
        providerVolumeId: VOLUME,
        observe: () => OBSERVED,
        deps: deps(),
        ...over,
    });

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-volume-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a volume that came back on a different device number', () => {
    it('is still the same volume, and is not refused', async () => {
        /*
         * Device numbers are assigned by the kernel at attach time. The same
         * provider volume, reattached after a restart or moved to another host,
         * routinely comes back as a different `major:minor` — nothing about the
         * data changed. A seal that pinned it would refuse that volume forever,
         * and "forever" is the word that matters: the seal is never rewritten,
         * so the runtime could never start again on its own data.
         */
        expect(await resolve()).toMatchObject({ ok: true, seal: 'created' });
        expect(await resolve({
            observe: () => ({ deviceMajorMinor: '253:7', fsUuid: OBSERVED.fsUuid }),
        })).toMatchObject({ ok: true, seal: 'existing' });
    });

    it('is refused when the filesystem on it is a different one', async () => {
        // The identity that follows the data is the filesystem UUID. A volume id
        // can be reassigned; if the UUID differs this is not our volume.
        await resolve();
        expect(await resolve({
            observe: () => ({ deviceMajorMinor: OBSERVED.deviceMajorMinor, fsUuid: 'another-fs' }),
        })).toEqual({ ok: false, reason: 'sealed-mismatch' });
    });
});

describe('sealing the volume on first sight', () => {
    it('seals what it observed and reports it', async () => {
        const outcome = await resolve();
        expect(outcome).toEqual({
            ok: true,
            seal: 'created',
            binding: { providerVolumeId: VOLUME, ...OBSERVED },
        });
    });

    it('adopts the seal on the next boot instead of writing again', async () => {
        await resolve();
        const again = await resolve();
        expect(again).toMatchObject({ ok: true, seal: 'existing' });
    });

    it('refuses to seal what it could not observe', async () => {
        // A seal made from a guess is worse than no seal: everything after it
        // compares against the guess.
        expect(await resolve({ observe: () => null }))
            .toEqual({ ok: false, reason: 'unobservable' });
        expect(() => lstatSync(managedVolumeSealPath(stateDir))).toThrow();
    });

    it.each([
        ['empty device', { deviceMajorMinor: '   ', fsUuid: 'fs-uuid-1' }],
        ['empty uuid', { deviceMajorMinor: '259:1', fsUuid: '' }],
    ])('refuses %s rather than sealing it', async (_name, observed) => {
        expect(await resolve({ observe: () => observed as ManagedVolumeObservation }))
            .toEqual({ ok: false, reason: 'unobservable' });
        expect(() => lstatSync(managedVolumeSealPath(stateDir))).toThrow();
    });
});

describe('holding the runtime to what it sealed', () => {
    /*
     * The device number is **not** in this table, and it used to be.
     *
     * That row encoded the defect rather than the intent: the kernel assigns
     * `major:minor` at attach time, so the same volume reattached comes back
     * with a different one and the runtime was refused permanently — the seal
     * is never rewritten. The identity that follows the data is above.
     */
    it.each([
        ['a reassigned provider volume', { providerVolumeId: 'vol_provider_2' }],
        ['a different filesystem', { fsUuid: 'fs-uuid-2' }],
    ])('refuses %s', async (_name, change) => {
        await resolve();
        const changed = { ...OBSERVED, ...change } as ManagedVolumeObservation & {
            providerVolumeId?: string;
        };
        const outcome = await resolve({
            providerVolumeId: changed.providerVolumeId ?? VOLUME,
            observe: () => ({
                deviceMajorMinor: changed.deviceMajorMinor,
                fsUuid: changed.fsUuid,
            }),
        });
        expect(outcome).toEqual({ ok: false, reason: 'sealed-mismatch' });
    });

    it('never rewrites the seal it refused', async () => {
        await resolve();
        await resolve({ observe: () => ({ deviceMajorMinor: '8:0', fsUuid: 'other' }) });
        // The original seal still stands, and the runtime agrees with it again.
        expect(await resolve()).toMatchObject({ ok: true, seal: 'existing' });
    });

    it('adopts the winner when another producer sealed first', async () => {
        /*
         * Two producers on one volume. The loser must not overwrite a seal that
         * is already the authority — it reads what the winner wrote.
         *
         * The window is between reading the seal and creating it, so the
         * observation is what opens it here: that is exactly where the other
         * producer lands.
         */
        const outcome = await resolve({
            observe: () => {
                writeFileSync(
                    managedVolumeSealPath(stateDir),
                    JSON.stringify({ version: 1, providerVolumeId: VOLUME, ...OBSERVED }),
                    { mode: 0o600 },
                );
                return OBSERVED;
            },
        });
        expect(outcome).toEqual({
            ok: true,
            seal: 'existing',
            binding: { providerVolumeId: VOLUME, ...OBSERVED },
        });
    });

    it('refuses when the winner sealed a different volume', async () => {
        const outcome = await resolve({
            observe: () => {
                writeFileSync(
                    managedVolumeSealPath(stateDir),
                    JSON.stringify({
                        version: 1, providerVolumeId: 'vol_provider_9',
                        deviceMajorMinor: '8:0', fsUuid: 'other',
                    }),
                    { mode: 0o600 },
                );
                return OBSERVED;
            },
        });
        expect(outcome).toEqual({ ok: false, reason: 'sealed-mismatch' });
    });

    it.each([
        ['not json', 'nonsense'],
        ['another version', JSON.stringify({ version: 99, providerVolumeId: VOLUME, ...OBSERVED })],
        ['a missing axis', JSON.stringify({ version: 1, providerVolumeId: VOLUME, fsUuid: 'x' })],
    ])('refuses a seal that is %s, without overwriting it', async (_name, contents) => {
        writeFileSync(managedVolumeSealPath(stateDir), contents, { mode: 0o600 });
        expect(await resolve()).toEqual({ ok: false, reason: 'seal-unusable' });
        // Untouched: a record that cannot be trusted is not repaired by
        // replacing it with what this boot happens to see.
        expect(lstatSync(managedVolumeSealPath(stateDir)).size).toBe(contents.length);
    });

    it('does not observe at all when the seal cannot be trusted', async () => {
        writeFileSync(managedVolumeSealPath(stateDir), 'nonsense', { mode: 0o600 });
        let observed = 0;
        await resolve({ observe: () => { observed += 1; return OBSERVED; } });
        expect(observed).toBe(0);
    });
});

describe('sealing survives a crash in the middle of it', () => {
    /*
     * The seal is never rewritten — that is what makes it a seal — so a
     * half-written one is not a stale file the next boot replaces. It is a
     * permanent refusal: every later boot reads it, calls it unusable, and the
     * runtime never starts on its own data again.
     */
    function leftovers(): string[] {
        const sealName = managedVolumeSealPath(stateDir).split('/').pop();
        return readdirSync(stateDir).filter((name) => name !== sealName);
    }

    it('leaves nothing behind when the write itself fails', async () => {
        const failed = await resolve({
            syncFile: async () => { throw new Error('injected file fsync failure'); },
        });
        expect(failed.ok).toBe(false);
        expect(() => lstatSync(managedVolumeSealPath(stateDir))).toThrow();
        expect(leftovers()).toEqual([]);

        // The next boot seals normally rather than inheriting a dead end.
        expect(await resolve()).toMatchObject({ ok: true, seal: 'created' });
        expect(leftovers()).toEqual([]);
    });

    it('flushes again when it adopts a seal it did not write', async () => {
        // The boot that wrote the seal may have died before its directory entry
        // reached the disk. Adopting without flushing inherits that assumption,
        // and a seal that vanishes takes the runtime's claim on its volume.
        let syncs = 0;
        const call = {
            syncDirectory: async () => {
                syncs++;
                if (syncs === 1) throw new Error('injected directory fsync failure');
            },
        };
        expect((await resolve(call)).ok).toBe(false);
        expect(syncs).toBe(1);
        expect(await resolve(call)).toMatchObject({ ok: true, seal: 'existing' });
        expect(syncs).toBe(2);
    });
});
