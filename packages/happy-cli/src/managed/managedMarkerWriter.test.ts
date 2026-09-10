import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeManagedMarker } from './managedMarkerWriter';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mm-writer-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const BOOT_INPUT = {
    saycode_workspace: 'ws_1',
    saycode_project: 'pr_1',
    saycode_runtime: 'rt_1',
    saycode_operation: 'op_1',
    saycode_config_digest: 'digest_1',
    saycode_isolation_backend: 'fly-machines',
    saycode_provider_uid: '10601',
    saycode_provider_gid: '10601',
    saycode_executor_uid: '10602',
    saycode_executor_gid: '10600',
    saycode_cgroup_root: '/sys/fs/cgroup/saycode',
    saycode_verifier_key: 'key_1',
    saycode_verifier_public_key: 'pub_1',
    saycode_state_dir: '/var/lib/saycode',
    saycode_workspace_dir: '/workspace',
    saycode_volume: 'vol_1',
};

const instance = { providerMachineId: 'machine_1', providerInstanceId: 'instance_1' };

async function bootInputAt(dir: string, value: unknown = BOOT_INPUT): Promise<string> {
    const path = join(dir, 'boot-input.json');
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
}

/**
 * The real gates refuse anything not owned by root, and tests do not run as
 * root. These stubs stand in for "the file and its ancestors are trusted" so
 * the cases below can be about everything else; the gates themselves are
 * exercised by the tests that pass their own.
 */
const trustedChain = {
    getuid: () => 0,
    lstatDir: () => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false }),
    probeIsolationBackend: () => ({ verified: false as const, reason: 'test' }),
};
const permissiveDeps = { statGate: () => null, provisioningDeps: trustedChain };

/** Every directory on the way to `target`, including it. */
function ancestorsOf(target: string): string[] {
    const parts = target.split('/').filter((part) => part.length > 0);
    const chain = ['/'];
    for (let index = 0; index < parts.length; index += 1) chain.push(`/${parts.slice(0, index + 1).join('/')}`);
    return chain;
}

describe('writeManagedMarker', () => {
    it('shouldWriteTheComposedRecordAndNothingElse', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');

        const outcome = await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: permissiveDeps,
        });

        expect(outcome).toMatchObject({ status: 'written' });
        const written = JSON.parse(await readFile(markerPath, 'utf8'));
        expect(written).toEqual((outcome as { record: unknown }).record);
        expect(written.isolation).toEqual({
            backend: 'fly-machines',
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: '/sys/fs/cgroup/saycode',
        });
        expect(written.happyMachineId).toBe('happy_1');
        expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    });

    it('shouldReportAnOrdinaryMachineWithoutWritingAnything', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const outcome = await writeManagedMarker({
            bootInputPath: await bootInputAt(dir, { unrelated: 'value' }),
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: permissiveDeps,
        });
        expect(outcome).toEqual({ status: 'not-managed' });
        await expect(stat(markerPath)).rejects.toThrow();
    });

    it('shouldRefuseRatherThanInventAMissingAxis', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const { saycode_executor_uid: _dropped, ...incomplete } = BOOT_INPUT;

        expect(await writeManagedMarker({
            bootInputPath: await bootInputAt(dir, incomplete),
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'metadata-incomplete' });
        await expect(stat(markerPath)).rejects.toThrow();
    });

    it('shouldRefuseWhenTheParentHasNotIssuedAnAddressYet', async () => {
        const dir = await scratch();
        expect(await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath: join(dir, 'managed-runtime.json'),
            instance,
            happyMachineId: null,
            deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'happy-address-missing' });
    });

    it('shouldAdoptAnIdenticalMarkerAndNeverOverwriteADifferentOne', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);
        const first = await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        });
        expect(first).toMatchObject({ status: 'written' });

        // Same boot, same answer: adopting is not rewriting.
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'adopted' });

        // A different identity at the same path is an identity swap.
        const before = await readFile(markerPath, 'utf8');
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_2', deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'identity-conflict' });
        expect(await readFile(markerPath, 'utf8')).toBe(before);
    });

    it('shouldNotAdoptAnExistingMarkerThatIsNotItselfTrusted', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);
        const written = await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        });
        expect(written).toMatchObject({ status: 'written' });
        const body = await readFile(markerPath, 'utf8');

        // Identical contents, but the file itself is now writable by anyone.
        // Adopting it would treat a marker an unprivileged process could have
        // authored as this machine's identity.
        await chmod(markerPath, 0o666);
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1',
        })).toMatchObject({ status: 'refused' });

        // A symlink pointing at the same bytes is not the marker either.
        await chmod(markerPath, 0o600);
        const elsewhere = join(dir, 'elsewhere.json');
        await writeFile(elsewhere, body, { mode: 0o600 });
        await rm(markerPath);
        await symlink(elsewhere, markerPath);
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'refused' });
    });

    it('shouldLeaveNoMarkerBehindWhenTheWriteFailsPartWay', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);

        expect(await writeManagedMarker({
            bootInputPath,
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                onSync: (path: string) => {
                    if (path.includes('managed-runtime')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                },
            },
        })).toMatchObject({ status: 'refused', reason: 'marker-unwritable' });

        // A half-written marker at the final path would be a permanent
        // identity-conflict: every later boot would refuse to adopt it and
        // refuse to replace it.
        await expect(stat(markerPath)).rejects.toThrow();
        expect((await readdir(dir)).filter((name) => name.includes('managed-runtime'))).toEqual([]);

        // And the retry succeeds.
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'written' });
    });

    it('shouldRefuseABootInputThatIsNotThereOrIsASymlink', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        expect(await writeManagedMarker({
            bootInputPath: join(dir, 'absent.json'),
            markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'boot-input-absent' });

        const real = await bootInputAt(dir);
        const link = join(dir, 'linked.json');
        await symlink(real, link);
        expect(await writeManagedMarker({
            bootInputPath: link, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'symlinked' });
        await expect(stat(markerPath)).rejects.toThrow();
    });

    it('shouldRefuseWhenAnAncestorDirectoryIsNotTrusted', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'etc/managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);

        // A marker is only as trustworthy as the directories leading to it: a
        // parent anyone can write is a parent anyone can swap the marker in.
        const refusal = await writeManagedMarker({
            bootInputPath,
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                provisioningDeps: {
                    ...trustedChain,
                    lstatDir: (path: string) => ({
                        uid: 0,
                        mode: path === dir ? 0o777 : 0o755,
                        isDirectory: true,
                        isSymbolicLink: false,
                    }),
                },
            },
        });

        expect(refusal).toMatchObject({ status: 'refused' });
        await expect(stat(markerPath)).rejects.toThrow();
    });

    it('shouldCheckTheMarkersOwnChainAndNotOnlyTheBootInputs', async () => {
        const dir = await scratch();
        const untrusted = join(dir, 'sub');
        const bootInputPath = await bootInputAt(dir);

        // The boot input sits in a trusted directory; the marker would land in
        // one that is group-writable. Checking only the input would let the
        // marker be written where someone else can replace it.
        expect(await writeManagedMarker({
            bootInputPath,
            markerPath: join(untrusted, 'managed-runtime.json'),
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                provisioningDeps: {
                    ...trustedChain,
                    lstatDir: (path: string) => ({
                        uid: 0,
                        mode: path === untrusted ? 0o775 : 0o755,
                        isDirectory: true,
                        isSymbolicLink: false,
                    }),
                },
            },
        })).toMatchObject({ status: 'refused', reason: 'untrusted-path' });
    });

    it('shouldRefuseWhenAnAncestorOfTheBootInputIsASymlink', async () => {
        const dir = await scratch();
        const bootInputPath = await bootInputAt(dir);
        const refusal = await writeManagedMarker({
            bootInputPath,
            markerPath: join(dir, 'managed-runtime.json'),
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                provisioningDeps: {
                    ...trustedChain,
                    lstatDir: (path: string) => ({
                        uid: 0,
                        mode: 0o755,
                        isDirectory: path !== dir,
                        isSymbolicLink: path === dir,
                    }),
                },
            },
        });
        expect(refusal).toMatchObject({ status: 'refused' });
    });

    it('shouldAcceptATrustedChainOfAncestors', async () => {
        const dir = await scratch();
        expect(await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath: join(dir, 'managed-runtime.json'),
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                provisioningDeps: trustedChain,
            },
        })).toMatchObject({ status: 'written' });
    });

    it('shouldNotRefuseAFirstBootJustBecauseTheMarkerDirectoryIsNotThereYet', async () => {
        // The chain that exists is trusted; the marker's own directory is not
        // there yet, which is what a first boot looks like. An earlier version
        // walked the marker *file* too and refused every one of them.
        const dir = await scratch();
        const markerPath = join(dir, 'etc/saycode/managed-runtime.json');
        const present = new Set([...ancestorsOf(dir)]);

        expect(await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: {
                statGate: () => null,
                provisioningDeps: {
                    ...trustedChain,
                    lstatDir: (path: string) => {
                        if (!present.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                        return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
                    },
                },
            },
        })).toMatchObject({ status: 'written' });
        expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    });

    it('shouldFlushTheMarkerAndItsDirectoryWhenItAdoptsAnExistingOne', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);
        await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        });

        const synced: string[] = [];
        expect(await writeManagedMarker({
            bootInputPath,
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: { ...permissiveDeps, onSync: (path: string) => { synced.push(path); } },
        })).toMatchObject({ status: 'adopted' });

        // Adopting is a claim that the marker is on the disk. The boot that
        // wrote it may have died before its directory entry was flushed, so
        // this one has to check rather than inherit the assumption.
        expect(synced).toContain(markerPath);
        expect(synced).toContain(dir);
    });

    it('shouldNotAdoptWhenTheAdoptionCannotBeFlushed', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);
        await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        });

        expect(await writeManagedMarker({
            bootInputPath,
            markerPath,
            instance,
            happyMachineId: 'happy_1',
            deps: {
                ...permissiveDeps,
                onSync: (path: string) => {
                    if (path === dir) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                },
            },
        })).toMatchObject({ status: 'refused', reason: 'marker-unwritable' });

        // And a retry, once the flush works, adopts.
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'adopted' });
    });

    it('shouldRefuseABootInputThatIsNotRootOwnedOrIsGroupWritable', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'managed-runtime.json');
        const bootInputPath = await bootInputAt(dir);
        await chmod(bootInputPath, 0o666);

        // The real gate, not the permissive one: this is the check that keeps
        // an unprivileged process from choosing the machine's identity.
        expect(await writeManagedMarker({
            bootInputPath, markerPath, instance, happyMachineId: 'happy_1',
        })).toMatchObject({ status: 'refused' });
        await expect(stat(markerPath)).rejects.toThrow();
    });

    it('shouldRefuseABootInputThatIsNotJson', async () => {
        const dir = await scratch();
        const path = join(dir, 'boot-input.json');
        await writeFile(path, 'not json', { mode: 0o600 });
        expect(await writeManagedMarker({
            bootInputPath: path,
            markerPath: join(dir, 'managed-runtime.json'),
            instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'refused', reason: 'boot-input-unreadable' });
    });

    it('shouldCreateTheMarkerDirectoryWhenItIsNotThereYet', async () => {
        const dir = await scratch();
        const markerPath = join(dir, 'etc/saycode/managed-runtime.json');
        expect(await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath, instance, happyMachineId: 'happy_1', deps: permissiveDeps,
        })).toMatchObject({ status: 'written' });
        expect((await stat(join(dir, 'etc/saycode'))).mode & 0o777).toBe(0o700);
    });

    it('shouldFlushTheMarkerAndItsDirectoryBeforeReportingItWritten', async () => {
        const dir = await scratch();
        const synced: string[] = [];
        await mkdir(join(dir, 'etc'), { recursive: true });
        await writeManagedMarker({
            bootInputPath: await bootInputAt(dir),
            markerPath: join(dir, 'etc/managed-runtime.json'),
            instance,
            happyMachineId: 'happy_1',
            deps: { ...permissiveDeps, onSync: (path: string) => { synced.push(path); } },
        });
        // A marker that is not on the disk is not a trust anchor.
        expect(synced).toContain(join(dir, 'etc/managed-runtime.json'));
        expect(synced).toContain(join(dir, 'etc'));
    });
});
