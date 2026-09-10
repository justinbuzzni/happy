/**
 * The record of what a managed volume was originally made from.
 *
 * This module records; it does not restore. Laying a checkpoint down belongs
 * to `CheckpointRestoreExecutor`, which already has the plan, the ledger
 * binding, the safety checkpoint and an exclusive store lock — and handles the
 * content a real workspace has rather than a map of strings.
 *
 * What is tested here is the part that does not exist anywhere else: a durable,
 * root-protected answer to "was this volume prepared, and from what?", bound to
 * the volume it is about.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync, lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    managedRestoreManifestPath,
    readManagedRestoreState,
    recordManagedRestoreCompletion,
    type ManagedVolumeIdentity,
} from '@/managed/managedRestoreState';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const VOLUME: ManagedVolumeIdentity = {
    volumeId: 'vol_abc123', deviceUuid: 'uuid-1', createdByThisOperation: true,
};
const EXISTING: ManagedVolumeIdentity = { ...VOLUME, createdByThisOperation: false };

/**
 * The real filesystem for mode, symlinks and containment; ownership is
 * injected because the test user is not root. `lstatDir` reports the ancestors
 * above the temporary directory as root-owned, which is what they are on a
 * real runtime.
 */
function deps(over: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        /*
         * Reality for everything except ownership.
         *
         * An earlier version returned `isDirectory: true` for every path and
         * invented a stat for paths that do not exist. Both are lies the code
         * under test asks about: the walk refuses a component that is not a
         * directory, and it refuses a component it cannot stat. With those
         * answers faked, a caller that walked a **file** path — which can never
         * be trusted, and never is — looked correct here while being
         * permanently refused on a real runtime.
         */
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
                // Ownership only is injected — the test user is not root.
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

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-record-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('recording that a volume was prepared', () => {
    it('records an empty initialisation on a volume this operation created', async () => {
        const state = await recordManagedRestoreCompletion({
            stateDir, volume: VOLUME, outcome: { status: 'empty-initialized' }, deps: deps(),
        });
        expect(state).toEqual({
            status: 'empty-initialized', checkpointId: null, manifestDigest: null,
        });
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() })).toEqual(state);
    });

    it('records a completed restore with the checkpoint it came from', async () => {
        const state = await recordManagedRestoreCompletion({
            stateDir,
            volume: VOLUME,
            outcome: { status: 'restored', checkpointId: 'ckpt-1', manifestDigest: 'digest-1' },
            deps: deps(),
        });
        expect(state).toEqual({
            status: 'restored', checkpointId: 'ckpt-1', manifestDigest: 'digest-1',
        });
    });

    it('refuses to record on a volume this operation did not create', async () => {
        // The absence of a record is not evidence of a new volume: a record
        // can be lost, and a reused volume with no record still holds real
        // work.
        await expect(recordManagedRestoreCompletion({
            stateDir, volume: EXISTING, outcome: { status: 'empty-initialized' }, deps: deps(),
        })).rejects.toThrow(/not created by this operation/i);
    });

    it('adopts an existing record instead of rewriting it', async () => {
        const origin = await recordManagedRestoreCompletion({
            stateDir,
            volume: VOLUME,
            outcome: { status: 'restored', checkpointId: 'ckpt-1', manifestDigest: 'digest-1' },
            deps: deps(),
        });
        // A later boot of the same volume, with no checkpoint this time.
        const second = await recordManagedRestoreCompletion({
            stateDir, volume: EXISTING, outcome: { status: 'empty-initialized' }, deps: deps(),
        });
        expect(second).toEqual(origin);
        expect(second.status).toBe('restored');
    });

    it('refuses a record that belongs to another volume', async () => {
        await recordManagedRestoreCompletion({
            stateDir, volume: VOLUME, outcome: { status: 'empty-initialized' }, deps: deps(),
        });
        await expect(recordManagedRestoreCompletion({
            stateDir,
            volume: { ...EXISTING, volumeId: 'vol_other' },
            outcome: { status: 'empty-initialized' },
            deps: deps(),
        })).rejects.toThrow(/another volume/i);
    });

    it('flushes the record and its directory entry before returning', async () => {
        // A record that survives a crash while the work behind it did not is
        // exactly the failure this file exists to prevent, so the claim is only
        // made once it is durable.
        const syncs: string[] = [];
        const { promises: fsPromises } = await import('node:fs');
        const realOpen = fsPromises.open;
        const openSpy = async (...args: Parameters<typeof realOpen>) => {
            const handle = await realOpen(...args);
            const realSync = handle.sync.bind(handle);
            handle.sync = async () => {
                syncs.push(String(args[0]));
                return realSync();
            };
            return handle;
        };
        (fsPromises as { open: typeof realOpen }).open = openSpy as typeof realOpen;
        try {
            await recordManagedRestoreCompletion({
                stateDir, volume: VOLUME, outcome: { status: 'empty-initialized' }, deps: deps(),
            });
        } finally {
            (fsPromises as { open: typeof realOpen }).open = realOpen;
        }
        expect(syncs).toEqual([managedRestoreManifestPath(stateDir), stateDir]);
    });
});

describe('reading the record back', () => {
    it('reports pending when nothing has been recorded', () => {
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() }))
            .toEqual({ status: 'pending', checkpointId: null, manifestDigest: null });
    });

    it('reports failed for a record that is there and does not hold', async () => {
        // Something wrote it and it is wrong, which is a different answer from
        // not having started.
        writeFileSync(managedRestoreManifestPath(stateDir), 'not json', { mode: 0o600 });
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() }))
            .toMatchObject({ status: 'failed' });
    });

    it('refuses a record reached through a symlink', async () => {
        // The agent can write inside the workspace. A record it could redirect
        // is a record it could use to call a half-prepared volume ready.
        const elsewhere = join(base, 'planted.json');
        writeFileSync(elsewhere, JSON.stringify({
            version: 1, volumeId: VOLUME.volumeId, deviceUuid: VOLUME.deviceUuid,
            status: 'restored', checkpointId: 'ckpt-x', manifestDigest: 'd',
        }), { mode: 0o600 });
        symlinkSync(elsewhere, managedRestoreManifestPath(stateDir));
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() }))
            .toMatchObject({ status: 'failed' });
    });

    it('refuses a record under a directory the agent could replace', async () => {
        expect(readManagedRestoreState({
            stateDir,
            volume: VOLUME,
            deps: deps({
                lstatDir: (path) => ({
                    uid: path === stateDir ? DAEMON_UID + 1 : 0,
                    mode: path === stateDir ? 0o40777 : 0o40755,
                    isDirectory: true,
                    isSymbolicLink: false,
                }),
            }),
        })).toMatchObject({ status: 'failed' });
    });

    it('refuses a record whose device is not the one now mounted', async () => {
        await recordManagedRestoreCompletion({
            stateDir, volume: VOLUME, outcome: { status: 'empty-initialized' }, deps: deps(),
        });
        // A provider id can be reassigned; the filesystem's own identity is
        // what says this is the same volume.
        expect(readManagedRestoreState({
            stateDir, volume: { ...VOLUME, deviceUuid: 'uuid-other' }, deps: deps(),
        })).toMatchObject({ status: 'failed' });
    });
});
