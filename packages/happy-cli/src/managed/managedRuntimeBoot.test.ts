/**
 * The root boot stage: order, refusals, and what never leaks.
 *
 * The individual pieces have their own tests. What is only visible here is the
 * sequence — a record published before the supervisor is listening names an
 * address nothing answers on, and a daemon that reads it reports a wired
 * backend that cannot prove anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    assignTreeSync,
    defaultManagedRuntimeBootDeps,
    managedLauncherSocketPath,
    runManagedRuntimeBoot,
} from '@/managed/managedRuntimeBoot';
import { readManagedLauncherBinding } from '@/daemon/launch/managedLauncherBinding';
import {
    probeIsolationBackendUnavailable,
    type ManagedIdentityResolution,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const AGENT_UID = 10_602;
const PROVIDER_UID = 10_601;
const TOKEN = 'a-token-only-this-boot-knows';

function provisioning(): ManagedProvisioningDeps {
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
    };
}

function identity(over: Partial<ManagedIdentityResolution> = {}): () => ManagedIdentityResolution {
    return () => ({
        status: 'active',
        identity: {
            runtimeId: 'rt-1',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            keyId: 'kid-1',
            happyMachineId: 'machine-1',
            provisioningOperationId: 'op-1',
            configDigest: 'digest-1',
            providerMachineId: 'provider-machine-1',
            providerInstanceId: 'provider-instance-1',
            providerVolumeId: 'vol_1',
            verifier: {} as never,
            stateDir,
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: PROVIDER_UID, gid: PROVIDER_UID },
                executor: { uid: AGENT_UID, gid: AGENT_UID },
                cgroupRoot: '/sys/fs/cgroup/saycode',
            },
        },
        ...over,
    } as ManagedIdentityResolution);
}

type Recorded = { event: string; detail?: string };


function bootDeps(over: Partial<Parameters<typeof runManagedRuntimeBoot>[0]> = {}) {
    const log: Recorded[] = [];
    const deps = {
        resolveIdentity: identity() as never,
        provisioning: provisioning(),
        makeTrustedDirectory: async (path: string, mode: number) => {
            log.push({ event: 'directory', detail: path });
            await mkdir(path, { recursive: true, mode });
            chmodSync(path, mode);
        },
        startSupervisor: async () => {
            log.push({ event: 'supervisor' });
            return { token: TOKEN };
        },
        assignWorkspace: async (input: { path: string; uid: number; gid: number }) => {
            log.push({ event: 'workspace', detail: `${input.path}:${input.uid}:${input.gid}` });
        },
        assignProviderHome: async (input: { path: string; uid: number; gid: number; mode: number }) => {
            log.push({
                event: 'provider-home',
                detail: `${input.path}:${input.uid}:${input.gid}:${input.mode.toString(8)}`,
            });
        },
        // The default for cases that are not about staging. Every case that is
        // overrides it, and the real CLI's own is asserted separately.
        inspectRestoreStaging: async () => 'clear' as const,
        // Likewise for the identity handoff: the cases about it override this,
        // and the real CLI's own is asserted in its own file.
        adoptCredential: async () => ({ status: 'absent' as const }),
        ...over,
    };
    return { deps: deps as Parameters<typeof runManagedRuntimeBoot>[0], log };
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-boot-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('the production ownership steps', () => {
    it('applies ownership to everything inside the provider home', async () => {
        /*
         * Run against a real tree with the test user's own ids — the only
         * ownership change an unprivileged process may make. What is under test
         * is the **walk**: a restore promotes this area as root, so the files
         * inside arrive owned by somebody else, and a step that touched only the
         * top level would leave the provider unable to read its own sessions.
         */
        const home = join(base, 'codex-home');
        mkdirSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'state.db'), 'x');
        const visited: string[] = [];
        await defaultManagedRuntimeBootDeps((target) => { visited.push(target); })
            .assignProviderHome({ path: home, uid: 4242, gid: 4242, mode: 0o700 });
        // The mode belongs to the home itself; the ownership belongs to
        // everything the provider will read back.
        expect(lstatSync(home).mode & 0o777).toBe(0o700);
        expect(visited).toContain(join(home, 'sessions', 'state.db'));
    });

    it('reaches every file under the root, and follows no symlink out of it', () => {
        /*
         * The files a restore promotes arrive owned by root, so what matters is
         * that the walk **reaches** them. Symlinks are left alone rather than
         * followed: a link planted in a restored tree would otherwise hand the
         * provider something outside its own home.
         */
        const home = join(base, 'walk');
        mkdirSync(join(home, 'sessions', 'nested'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'state.db'), 'x');
        writeFileSync(join(home, 'sessions', 'nested', 'deep.json'), 'y');
        symlinkSync(join(base, 'outside'), join(home, 'escape'));
        const visited: string[] = [];
        assignTreeSync(home, 4242, 4242, (target) => { visited.push(target); });
        expect(visited).toContain(join(home, 'sessions', 'state.db'));
        expect(visited).toContain(join(home, 'sessions', 'nested', 'deep.json'));
        expect(visited).not.toContain(join(home, 'escape'));
    });

    it('refuses a provider home reached through a symlink', async () => {
        const target = join(base, 'elsewhere');
        mkdirSync(target, { recursive: true });
        const link = join(base, 'linked-home');
        symlinkSync(target, link);
        await expect(defaultManagedRuntimeBootDeps().assignProviderHome({
            path: link, uid: 0, gid: 0, mode: 0o700,
        })).rejects.toThrow(/symlink/);
    });
});

describe('the root boot stage of a managed runtime', () => {
    it('makes the socket directory, starts the supervisor, then publishes it — in that order', async () => {
        const { deps, log } = bootDeps();
        const outcome = await runManagedRuntimeBoot(deps);

        expect(outcome).toEqual({
            ok: true, socketPath: managedLauncherSocketPath(stateDir), published: 'created',
        });
        expect(log.map((entry) => entry.event))
            .toEqual(['directory', 'supervisor', 'workspace', 'provider-home']);
        // And the record the daemon will read is really there, readable through
        // the same trust rules the daemon applies.
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() })).toEqual({
            ok: true,
            binding: { socketPath: managedLauncherSocketPath(stateDir), token: TOKEN },
        });
    });

    it('publishes nothing when the supervisor does not start', async () => {
        // A record with nothing behind it is worse than no record: the daemon
        // reports a wired backend and every fencing answer is a transport error.
        const { deps } = bootDeps({ startSupervisor: async () => null });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'supervisor-unavailable' });
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('publishes nothing when the supervisor throws', async () => {
        const { deps } = bootDeps({
            startSupervisor: async () => { throw new Error('/state/launcher.sock: EADDRINUSE token=secret'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'supervisor-unavailable' });
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('gives the workspace to the executor and the provider home to the provider', async () => {
        /*
         * Two uids, two directories, and swapping them breaks a different thing
         * each way: the workspace under the provider uid makes every tool write
         * fail with EACCES, and the provider's home under the executor uid puts
         * the session's own state where the code the model chose can read it.
         */
        const { deps, log } = bootDeps();
        await runManagedRuntimeBoot(deps);
        expect(log.filter((entry) => entry.event === 'workspace')).toEqual([
            { event: 'workspace', detail: `/workspace/project:${AGENT_UID}:${AGENT_UID}` },
        ]);
        expect(log.filter((entry) => entry.event === 'provider-home')).toEqual([
            { event: 'provider-home', detail: `/workspace/.codex:${PROVIDER_UID}:${PROVIDER_UID}:700` },
        ]);
        // And neither *assignment* touches the state directory: receipts, the
        // volume seal and the launcher record stay root's. (The launcher socket
        // directory is made under it — made, not handed over.)
        const assignments = log.filter((entry) => entry.event !== 'directory');
        expect(assignments.some((entry) => entry.detail?.startsWith(stateDir))).toBe(false);
    });

    it('assigns ownership after a restore, never before it', async () => {
        /*
         * A restore promotes by renaming a tree it built as root, so what it
         * promotes arrives root-owned. Ownership settled first would leave every
         * restored file unwritable by the executor — the runtime reports ready
         * and no tool can touch its own project.
         */
        const { deps, log } = bootDeps({
            restore: async () => { log.push({ event: 'restore' }); return 'restored' as const; },
        });
        await runManagedRuntimeBoot(deps);
        const events = log.map((entry) => entry.event);
        expect(events.indexOf('restore')).toBeLessThan(events.indexOf('workspace'));
        expect(events.indexOf('restore')).toBeLessThan(events.indexOf('provider-home'));
    });

    it('stops when a restore fails, without reporting the boot as done', async () => {
        // A half-laid tree with ownership applied over it looks like a prepared
        // volume. It is not one, and the parent must not be told it is.
        const { deps, log } = bootDeps({
            restore: async () => { throw new Error('promotion-failed'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'workspace-unassignable' });
        expect(log.some((entry) => entry.event === 'workspace')).toBe(false);
    });

    it('treats "no checkpoint to restore" as a start, not a failure', async () => {
        // A volume this operation created has nothing behind it. Reporting that
        // as a failed boot stops every new project from ever starting.
        const { deps } = bootDeps({ restore: async () => 'nothing-to-restore' as const });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('refuses to start when a crashed promotion left an unresolved tree', async () => {
        /*
         * The leftovers can be the **only** copy of what a destination held: a
         * rollback that did not finish is exactly why they are there. So this
         * neither sweeps them nor continues over them — a mixed tree served to
         * an agent is customer data quietly diverging from what was restored.
         */
        const { deps } = bootDeps({ inspectRestoreStaging: async () => 'unresolved' as const });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'restore-unresolved' });
    });

    it('treats an inspection that fails as unresolved, never as clear', async () => {
        const { deps } = bootDeps({
            inspectRestoreStaging: async () => { throw new Error('cannot read staging'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'restore-unresolved' });
    });

    it('starts when a recovery has proven the leftovers reclaimable', async () => {
        const { deps } = bootDeps({ inspectRestoreStaging: async () => 'clear' as const });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('hands the provider its whole home, not just the directory', async () => {
        /*
         * A restore promotes this area as root, so `sessions/` and the native
         * state database arrive root-owned. Owning only the top level lets the
         * provider write new files and read none of the ones it was given
         * back — which presents as an empty session, not as a permissions bug.
         */
        const { deps, log } = bootDeps();
        await runManagedRuntimeBoot(deps);
        const home = log.find((entry) => entry.event === 'provider-home');
        expect(home?.detail).toBe(`/workspace/.codex:${PROVIDER_UID}:${PROVIDER_UID}:700`);
    });

    it('stops when the provider home cannot be assigned', async () => {
        // codex writes its state there and dies without it. Reporting the boot
        // as done would hand the parent a runtime that cannot start a provider.
        const { deps } = bootDeps({
            assignProviderHome: async () => { throw new Error('EACCES'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'workspace-unassignable' });
    });

    it('does not start a supervisor for a marker it cannot trust', async () => {
        // "Boot anyway" here means running the agent unfenced, which is the
        // state this whole path exists to prevent.
        const started = vi.fn();
        const { deps } = bootDeps({
            resolveIdentity: (() => ({ status: 'refused', reason: 'not-root-owned' })) as never,
            startSupervisor: started as never,
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'identity-refused' });
        expect(started).not.toHaveBeenCalled();
    });

    it('separates an ordinary machine from a broken managed one', async () => {
        // No marker is a BYOS machine with nothing to do here; it must not be
        // reported as a managed runtime that failed.
        const { deps } = bootDeps({ resolveIdentity: (() => ({ status: 'absent' })) as never });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'not-managed' });
    });

    it('stops when the trusted directory cannot be made', async () => {
        const started = vi.fn();
        const { deps } = bootDeps({
            makeTrustedDirectory: async () => { throw new Error('EROFS'); },
            startSupervisor: started as never,
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'trusted-directory-unavailable' });
        expect(started).not.toHaveBeenCalled();
    });

    it('brings the published token back to the supervisor on a restart', async () => {
        /*
         * The launcher record is write-once **and** the supervisor mints a fresh
         * token whenever it is not given one. A second boot that let it mint
         * again would publish a different token for the same socket, the record
         * would refuse it, and the runtime would never start again — a
         * permanent failure produced entirely by a restart.
         */
        const first = bootDeps();
        await runManagedRuntimeBoot(first.deps);
        const offered: Array<string | undefined> = [];
        const second = bootDeps({
            startSupervisor: async ({ token }) => {
                offered.push(token);
                // A supervisor handed a token uses it; only an unspecified one
                // is minted. This fixture mirrors that.
                return { token: token ?? 'a-freshly-minted-token' };
            },
        });
        expect(await runManagedRuntimeBoot(second.deps)).toMatchObject({ ok: true });
        expect(offered).toEqual([TOKEN]);
    });

    it('adopts a record a previous boot already published', async () => {
        const first = bootDeps();
        await runManagedRuntimeBoot(first.deps);
        const second = bootDeps();
        expect(await runManagedRuntimeBoot(second.deps)).toMatchObject({ published: 'existing' });
    });

    it('refuses when a record names a different supervisor', async () => {
        await runManagedRuntimeBoot(bootDeps().deps);
        const { deps } = bootDeps({ startSupervisor: async () => ({ token: 'another-boots-token' }) });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'binding-unpublishable' });
        // The first boot stays the authority: it owns the ledger and the
        // children, and the daemon must keep talking to it.
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() })).toMatchObject({
            ok: true, binding: { token: TOKEN },
        });
    });

    it('keeps the boot token out of the environment', async () => {
        const { deps } = bootDeps();
        await runManagedRuntimeBoot(deps);
        expect(Object.values(process.env).some((value) => value === TOKEN)).toBe(false);
    });
});

describe('the identity handoff, in the boot stage', () => {
    /*
     * `run.ts` refuses to start managed without a credential on the volume, and
     * nothing inside a guest can mint one — both control-plane routes that
     * issue them require a signature no process here holds. So the boot stage
     * is where the parent's delivery becomes this runtime's own, and it happens
     * before a supervisor exists: a credential this runtime may not run as
     * should stop the boot while stopping is still cheap.
     */
    it('adopts before it starts anything', async () => {
        const order: string[] = [];
        const { deps } = bootDeps({
            adoptCredential: async () => {
                order.push('adopt');
                return { status: 'adopted' as const, machineId: 'machine-1', expiresAt: 1 };
            },
            startSupervisor: async () => {
                order.push('supervisor');
                return { token: TOKEN };
            },
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
        expect(order).toEqual(['adopt', 'supervisor']);
    });

    it('refuses the boot when the delivered identity is not one to run as', async () => {
        const { deps, log } = bootDeps({
            adoptCredential: async () => ({ status: 'refused' as const, reason: 'machine-conflict' as const }),
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
        // Nothing started, nothing published: the refusal is inert.
        expect(log.some((entry) => entry.event === 'supervisor')).toBe(false);
    });

    it('treats an adoption that throws as a refusal, never as absence', async () => {
        const { deps } = bootDeps({
            adoptCredential: async () => { throw new Error('cannot read /etc/saycode'); },
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
    });

    it('boots on when nothing was delivered', async () => {
        /*
         * A parent that has not wired the delivery yet, and a machine whose
         * credential is already on its volume, are the same thing here. What
         * happens next is the daemon's decision, made where the state directory
         * is actually read.
         */
        const { deps } = bootDeps({ adoptCredential: async () => ({ status: 'absent' as const }) });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('boots on when the credential already there is the better one', async () => {
        const { deps } = bootDeps({
            adoptCredential: async () => ({
                status: 'current' as const, machineId: 'machine-1', expiresAt: 2,
            }),
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('is wired on the deps the CLI builds', () => {
        // The lesson from the staging guard: an optional hook is one the single
        // non-test caller forgets, and its absence is silent.
        expect(typeof defaultManagedRuntimeBootDeps().adoptCredential).toBe('function');
    });
});

describe('the staging check the real CLI actually runs', () => {
    /*
     * `main.ts` boots with `defaultManagedRuntimeBootDeps()` and nothing else.
     * The guard was optional and those deps did not supply one, so in the only
     * configuration that ships, the check never ran: a runtime with leftovers
     * from a crashed promotion booted and served work over them. These cases
     * are about **that** object, not an injected stand-in.
     */
    let staging: string;

    beforeEach(() => {
        staging = join(base, 'restore-staging');
    });

    const inspect = () =>
        defaultManagedRuntimeBootDeps(() => {}, staging).inspectRestoreStaging();

    it('is present on the deps the CLI builds', () => {
        expect(typeof defaultManagedRuntimeBootDeps().inspectRestoreStaging).toBe('function');
    });

    it('calls a staging area that was never created clear', async () => {
        // Nothing staged is the ordinary case, and it must not stop a boot.
        expect(await inspect()).toBe('clear');
    });

    it('calls an empty staging directory clear', async () => {
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        expect(await inspect()).toBe('clear');
    });

    it.each([
        ['a displaced tree', 'displaced-20260910-abcdef'],
        ['a promotion journal', 'journal.json'],
        ['a checkpoint work directory', '.managed-checkpoint-4f2a'],
        ['something this code has never heard of', 'whatever-this-is'],
    ])('refuses to boot over %s, and leaves it exactly where it is', async (_name, entry) => {
        /*
         * Not `displaced-*` only. A rule that recognises names answers "clear"
         * for precisely the leftovers nobody anticipated — which are the ones
         * worth stopping for.
         */
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const path = join(staging, entry);
        writeFileSync(path, 'the only copy of something', { mode: 0o600 });
        expect(await inspect()).toBe('unresolved');
        // Never swept: this can be the only copy of a destination's previous
        // contents, and the rollback that would have restored it is the step
        // that did not finish.
        expect(readFileSync(path, 'utf8')).toBe('the only copy of something');
    });

    it('refuses a staging root that is a symlink rather than following it', async () => {
        // Following it would let whoever placed the link decide which directory
        // answers the question.
        const elsewhere = join(base, 'elsewhere');
        mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
        symlinkSync(elsewhere, staging);
        expect(await inspect()).toBe('unresolved');
    });

    it('refuses a staging root that is not a directory', async () => {
        writeFileSync(staging, 'not a directory', { mode: 0o600 });
        expect(await inspect()).toBe('unresolved');
    });

    it('refuses when it cannot read the staging root at all', async () => {
        // Being unable to look is not evidence that there is nothing there.
        if ((process.getuid?.() ?? 0) === 0) return; // root reads it regardless
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        writeFileSync(join(staging, 'displaced-1'), 'x', { mode: 0o600 });
        chmodSync(staging, 0o000);
        try {
            expect(await inspect()).toBe('unresolved');
        } finally {
            chmodSync(staging, 0o700);
        }
    });
});
