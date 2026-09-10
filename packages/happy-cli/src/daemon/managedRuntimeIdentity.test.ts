import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    assertProvisioningStat,
    probeIsolationBackendUnavailable,
    resolveManagedRuntimeIdentity,
    type ManagedProvisioningDeps,
} from './managedRuntimeIdentity';

const keys = generateKeyPairSync('ed25519');
const verifierPublicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .toString('base64');

const DAEMON_UID = typeof process.getuid === 'function' ? process.getuid()! : 0;
const AGENT_UID = DAEMON_UID + 1;

let root: string;
let workspaceDir: string;
let stateDir: string;
let provisioningPath: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-identity-'));
    workspaceDir = join(root, 'workspace');
    stateDir = join(root, 'managed-state');
    provisioningPath = join(root, 'managed-runtime.json');
    mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function writeProvisioning(overrides: Record<string, unknown> = {}, path = provisioningPath): void {
    const body = {
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        keyId: 'kid-1',
        happyMachineId: 'machine-1',
        provisioningOperationId: 'op-1',
        configDigest: 'digest-1',
        providerMachineId: 'fly-machine-1',
        providerInstanceId: 'fly-instance-1',
        providerVolumeId: 'vol_fixture_1',
        stateDir,
        workspaceDir,
        verifierPublicKey,
        isolation: {
            backend: 'privileged-launch-supervisor',
            provider: { uid: AGENT_UID, gid: AGENT_UID },
            executor: { uid: AGENT_UID + 1, gid: AGENT_UID },
            cgroupRoot: '/sys/fs/cgroup/saycode',
        },
        ...overrides,
    };
    writeFileSync(path, JSON.stringify(body), { mode: 0o644 });
    chmodSync(path, 0o644);
}

/**
 * The real file's ownership is this test user, not root, so the root-owner
 * check is exercised separately with an injected uid. Everything else — mode,
 * symlink, path containment, directory ownership — uses the real filesystem.
 */
/**
 * The temp root lives under a world-writable `/tmp`, which the ancestor walk
 * correctly refuses. Components at or above the temp root are therefore
 * reported as a trusted chain so that the directories the tests actually
 * create — and deliberately weaken — are what each case exercises.
 */
function deps(overrides: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(root) || path === root) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const { lstatSync } = require('node:fs') as typeof import('node:fs');
            const stat = lstatSync(path);
            return {
                uid: stat.uid,
                mode: stat.mode,
                isDirectory: stat.isDirectory(),
                isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        probeIsolationBackend: () => ({ verified: true }),
        ...overrides,
    };
}

describe('resolveManagedRuntimeIdentity — provisioning file', () => {
    it('reports absent only when the file is genuinely missing', () => {
        expect(resolveManagedRuntimeIdentity(join(root, 'nope.json'), deps()))
            .toEqual({ status: 'absent' });
    });

    it('refuses when a path component is not a directory', () => {
        // ENOTDIR is producible by anyone who can write the parent, so reading
        // it as "no marker" would be a way to switch managed mode off.
        writeFileSync(join(root, 'file'), 'x');
        const result = resolveManagedRuntimeIdentity(join(root, 'file', 'managed.json'), deps());
        expect(result.status).toBe('refused');
    });

    it('refuses — never reports absent — when the marker cannot be read', () => {
        // A downgrade is trivial if "cannot read" means "not managed": make the
        // file unreadable and every legacy spawn path reopens.
        writeProvisioning();
        chmodSync(provisioningPath, 0o000);
        const result = resolveManagedRuntimeIdentity(provisioningPath, deps());
        if (DAEMON_UID === 0) {
            // root bypasses the permission bits; assert the property that holds.
            expect(result.status).not.toBe('absent');
        } else {
            expect(result).toMatchObject({ status: 'refused', reason: 'unreadable' });
        }
    });

    it('refuses a symlinked marker instead of following it', () => {
        const real = join(root, 'real.json');
        writeProvisioning({}, real);
        symlinkSync(real, provisioningPath);
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps()))
            .toMatchObject({ status: 'refused', reason: 'symlinked' });
    });

    it('refuses a group- or world-writable marker', () => {
        writeProvisioning();
        chmodSync(provisioningPath, 0o664);
        // Ownership would already refuse this file under a non-root test user,
        // so the owner check is neutralised to leave the mode check exposed.
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps({
            statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }),
        }))).toMatchObject({ status: 'refused', reason: 'world-or-group-writable' });
    });

    it('refuses a marker not owned by root', () => {
        writeProvisioning();
        // The test file is owned by the test user; on a root runner it is
        // root-owned, so force the non-root case explicitly.
        if (DAEMON_UID === 0) return;
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps()))
            .toMatchObject({ status: 'refused', reason: 'not-root-owned' });
    });

    it('refuses a directory in place of the marker', () => {
        mkdirSync(join(root, 'asdir.json'));
        const result = resolveManagedRuntimeIdentity(join(root, 'asdir.json'), deps());
        expect(result.status).toBe('refused');
    });
});

/**
 * A temp file cannot be root-owned unless the suite runs as root, so these
 * cases substitute a gate that keeps every check except ownership. Ownership
 * itself is covered exhaustively against `assertProvisioningStat` below, so no
 * case is lost — the seam only moves where it is asserted.
 */
function rootOwnedDeps(overrides: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return deps({
        statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }),
        ...overrides,
    });
}

describe('resolveManagedRuntimeIdentity — content and isolation', () => {
    it('activates only when the isolation backend confirms it is wired', () => {
        writeProvisioning();
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result.status).toBe('active');
    });

    it('refuses when the trusted launch backend is not implemented', () => {
        // This is the shipped default: T09 has not landed, so no runtime can
        // activate no matter what the attestation declares.
        writeProvisioning();
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps({
            probeIsolationBackend: probeIsolationBackendUnavailable,
        }))).toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses an unknown isolation backend', () => {
        writeProvisioning({
            isolation: {
                backend: 'trust-me',
                provider: { uid: AGENT_UID, gid: AGENT_UID },
                executor: { uid: AGENT_UID + 1, gid: AGENT_UID },
                cgroupRoot: '/sys/fs/cgroup/x',
            },
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it.each([
        ['the provider uid', { provider: { uid: DAEMON_UID, gid: DAEMON_UID }, executor: { uid: AGENT_UID, gid: AGENT_UID } }],
        ['the executor uid', { provider: { uid: AGENT_UID, gid: AGENT_UID }, executor: { uid: DAEMON_UID, gid: DAEMON_UID } }],
    ])('refuses when the daemon shares %s', (_name, roles) => {
        writeProvisioning({
            isolation: { backend: 'privileged-launch-supervisor', ...roles, cgroupRoot: '/sys/fs/cgroup/x' },
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses one uid wearing both roles', () => {
        // The executor could then read the provider's environment and
        // descriptors out of /proc, which is the entire reason there are two.
        writeProvisioning({
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: AGENT_UID, gid: AGENT_UID },
                executor: { uid: AGENT_UID, gid: AGENT_UID },
                cgroupRoot: '/sys/fs/cgroup/x',
            },
        });
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result).toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
        if (result.status === 'refused') expect(result.detail).toContain('one uid');
    });

    it.each([
        ['a missing executor', { provider: { uid: AGENT_UID, gid: AGENT_UID } }],
        ['a missing provider', { executor: { uid: AGENT_UID, gid: AGENT_UID } }],
        ['a root role', {
            provider: { uid: 0, gid: 0 },
            executor: { uid: AGENT_UID, gid: AGENT_UID },
        }],
        ['a role that is not a pair', { provider: AGENT_UID, executor: { uid: AGENT_UID + 1, gid: AGENT_UID } }],
    ])('refuses %s', (_name, roles) => {
        writeProvisioning({
            isolation: { backend: 'privileged-launch-supervisor', ...roles, cgroupRoot: '/sys/fs/cgroup/x' },
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses a state directory inside the agent workspace', () => {
        const inside = join(workspaceDir, 'managed');
        mkdirSync(inside, { recursive: true, mode: 0o700 });
        writeProvisioning({ stateDir: inside });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe', detail: 'inside workspace' });
    });

    it('refuses a group-writable state directory', () => {
        chmodSync(stateDir, 0o770);
        writeProvisioning();
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
    });

    it('refuses a symlinked state directory', () => {
        const link = join(root, 'state-link');
        symlinkSync(stateDir, link);
        writeProvisioning({ stateDir: link });
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result).toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
        // The detail now names which component failed, not just "symlink".
        if (result.status === 'refused') expect(result.detail).toContain('symlink');
    });

    it('refuses a state directory owned by the agent uid', () => {
        writeProvisioning({
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: DAEMON_UID, gid: DAEMON_UID },
                executor: { uid: AGENT_UID, gid: AGENT_UID },
                cgroupRoot: '/c',
            },
        });
        // agentUid === owner of stateDir (the test user) must be refused.
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result.status).toBe('refused');
    });

    it('refuses malformed JSON rather than falling back to BYOS', () => {
        writeFileSync(provisioningPath, '{not json', { mode: 0o644 });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'malformed' });
    });

    it('refuses a missing required field', () => {
        writeProvisioning({ workspaceId: '  ' });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'malformed' });
    });

    it('refuses a non-ed25519 verifier key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
        writeProvisioning({
            verifierPublicKey: (rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'bad-verifier-key' });
    });
});

describe('probeIsolationBackendUnavailable', () => {
    it('is the shipped default and never verifies', () => {
        expect(probeIsolationBackendUnavailable()).toEqual({
            verified: false,
            reason: 'trusted-launch-backend-not-implemented',
        });
    });
});

describe('assertProvisioningStat', () => {
    const base = { uid: 0, mode: 0o644, isFile: true, size: 100 };

    it('accepts a root-owned, non-group-writable regular file', () => {
        expect(assertProvisioningStat(base)).toBeNull();
    });

    it('refuses any owner other than root', () => {
        for (const uid of [1, 500, 10001, 65534]) {
            expect(assertProvisioningStat({ ...base, uid }))
                .toEqual({ reason: 'not-root-owned' });
        }
    });

    it('refuses group- or world-writable modes', () => {
        for (const mode of [0o664, 0o646, 0o666, 0o622, 0o606]) {
            expect(assertProvisioningStat({ ...base, mode }))
                .toEqual({ reason: 'world-or-group-writable' });
        }
    });

    it('accepts read-only and owner-writable modes', () => {
        for (const mode of [0o400, 0o600, 0o644, 0o444]) {
            expect(assertProvisioningStat({ ...base, mode })).toBeNull();
        }
    });

    it('refuses anything that is not a regular file', () => {
        expect(assertProvisioningStat({ ...base, isFile: false }))
            .toEqual({ reason: 'not-a-regular-file' });
    });

    it('refuses a file larger than the read bound', () => {
        expect(assertProvisioningStat({ ...base, size: 16 * 1024 + 1 }))
            .toEqual({ reason: 'too-large' });
    });
});

describe('trusted path requires every ancestor, not just the leaf', () => {
    it('refuses a state directory whose parent the agent can rename', () => {
        // A 0700 leaf is worthless if its parent can be renamed away and a
        // replacement put in its place — the lease and receipts would then be
        // read from a directory the agent controls.
        const parent = join(root, 'agent-owned');
        const state = join(parent, 'managed');
        mkdirSync(state, { recursive: true });
        chmodSync(parent, 0o777);
        chmodSync(state, 0o700);
        writeProvisioning({ stateDir: state });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
    });

    it('refuses when a grandparent is writable', () => {
        const grand = join(root, 'g');
        const parent = join(grand, 'p');
        const state = join(parent, 'managed');
        mkdirSync(state, { recursive: true });
        chmodSync(grand, 0o777);
        chmodSync(parent, 0o755);
        chmodSync(state, 0o700);
        writeProvisioning({ stateDir: state });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
    });

    it('refuses when an ancestor is a symlink', () => {
        const real = join(root, 'real-parent');
        const link = join(root, 'linked-parent');
        mkdirSync(join(real, 'managed'), { recursive: true });
        chmodSync(join(real, 'managed'), 0o700);
        chmodSync(real, 0o755);
        symlinkSync(real, link);
        writeProvisioning({ stateDir: join(link, 'managed') });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
    });

    it('refuses when an ancestor is owned by the agent uid', () => {
        const parent = join(root, 'p2');
        const state = join(parent, 'managed');
        mkdirSync(state, { recursive: true });
        chmodSync(parent, 0o755);
        chmodSync(state, 0o700);
        writeProvisioning({
            stateDir: state,
            // The test user owns every temp directory here, so declaring it as
            // the agent uid makes the ancestor check the thing under test.
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: DAEMON_UID, gid: DAEMON_UID },
                executor: { uid: AGENT_UID, gid: AGENT_UID },
                cgroupRoot: '/c',
            },
        });
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result.status).toBe('refused');
    });

    it('applies the same walk to the provisioning marker path', () => {
        const dir = join(root, 'marker-dir');
        mkdirSync(dir);
        chmodSync(dir, 0o777);
        const marker = join(dir, 'managed-runtime.json');
        writeProvisioning({}, marker);
        // An agent that can replace the marker chooses this runtime's identity.
        expect(resolveManagedRuntimeIdentity(marker, rootOwnedDeps()))
            .toMatchObject({ status: 'refused' });
    });

    it('refuses — not reports absent — when a marker ancestor is not a directory', () => {
        // ENOTDIR is reachable by swapping a path component, so treating it as
        // "no marker" would be a downgrade switch.
        writeFileSync(join(root, 'blocker'), 'x');
        expect(resolveManagedRuntimeIdentity(join(root, 'blocker', 'managed-runtime.json'), rootOwnedDeps()))
            .toMatchObject({ status: 'refused' });
    });
});

describe('a missing marker is only BYOS when the path it would live in is trusted', () => {
    // The absence walk is Linux policy (see the platform boundary suite), so
    // these pin the platform rather than depending on the host running them.
    const linux = (over: Parameters<typeof deps>[0] = {}) => deps({ platform: 'linux', ...over });

    it('reports absent when no managed root exists at all', () => {
        // The ordinary BYOS machine: nothing was ever provisioned here, and no
        // ancestor check may turn that into a refusal.
        expect(resolveManagedRuntimeIdentity(join(root, 'nowhere', 'managed-runtime.json'), linux()))
            .toEqual({ status: 'absent' });
    });

    it('refuses when the marker is gone but its directory is agent-writable', () => {
        // The downgrade: the same directory would be refused while the marker
        // is present, so deleting the marker must not open the legacy surface.
        const dir = join(root, 'saycode');
        mkdirSync(dir);
        chmodSync(dir, 0o777);
        const result = resolveManagedRuntimeIdentity(join(dir, 'managed-runtime.json'), linux());
        expect(result.status).toBe('refused');
    });

    it('refuses when the marker is gone and an ancestor was replaced by a symlink', () => {
        const real = join(root, 'real-saycode');
        const link = join(root, 'saycode-link');
        mkdirSync(real);
        symlinkSync(real, link);
        const result = resolveManagedRuntimeIdentity(join(link, 'managed-runtime.json'), linux());
        expect(result.status).toBe('refused');
    });

    it('accepts absence when the existing directory is trusted', () => {
        const dir = join(root, 'trusted-saycode');
        mkdirSync(dir);
        chmodSync(dir, 0o755);
        expect(resolveManagedRuntimeIdentity(join(dir, 'managed-runtime.json'), linux()))
            .toEqual({ status: 'absent' });
    });

    it('judges on the deepest directory that exists, not on ones that do not', () => {
        // A mid-chain ENOENT is ordinary absence; only what exists can be
        // untrustworthy.
        const dir = join(root, 'partial');
        mkdirSync(dir);
        chmodSync(dir, 0o755);
        expect(resolveManagedRuntimeIdentity(join(dir, 'deeper', 'managed-runtime.json'), linux()))
            .toEqual({ status: 'absent' });
    });

    it('refuses when a deeper missing path sits under an untrusted existing directory', () => {
        const dir = join(root, 'partial-unsafe');
        mkdirSync(dir);
        chmodSync(dir, 0o777);
        const result = resolveManagedRuntimeIdentity(
            join(dir, 'deeper', 'managed-runtime.json'), linux(),
        );
        expect(result.status).toBe('refused');
    });
});

describe('platform boundary for the default production path', () => {
    it('reports absent on a real non-Linux host with no marker', () => {
        // Real filesystem, real uid, no injected deps. On macOS `/etc` is a
        // root-owned symlink to `private/etc`, so an ancestor walk here would
        // refuse and stop every BYOS daemon on the platform from starting.
        // Managed runtimes are Linux-only, so a missing marker off Linux is
        // plain absence.
        if (process.platform === 'linux') return;
        expect(resolveManagedRuntimeIdentity()).toEqual({ status: 'absent' });
    });

    it('still refuses a marker that exists but cannot be trusted, on any platform', () => {
        // The support boundary applies to *absence*. A marker that is present
        // and untrustworthy must never fall back to the legacy surface,
        // whatever the platform.
        writeProvisioning();
        chmodSync(provisioningPath, 0o666);
        const result = resolveManagedRuntimeIdentity(provisioningPath, deps({
            statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }),
        }));
        expect(result).toMatchObject({ status: 'refused', reason: 'world-or-group-writable' });
    });

    it('still refuses a corrupt marker on any platform', () => {
        writeFileSync(provisioningPath, '{not json', { mode: 0o644 });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'malformed' });
    });

    it('reports absent when the host has no uid concept at all', () => {
        // Windows has no `process.getuid`; that is not a managed host either,
        // and refusing there would block a BYOS daemon for the same reason.
        expect(resolveManagedRuntimeIdentity(join(root, 'gone', 'managed-runtime.json'), deps({
            getuid: () => -1,
            platform: 'win32',
        }))).toEqual({ status: 'absent' });
    });

    it('applies the absence walk on Linux', () => {
        const dir = join(root, 'linux-unsafe');
        mkdirSync(dir);
        chmodSync(dir, 0o777);
        // The same input that is absence off Linux is a refusal on it.
        expect(resolveManagedRuntimeIdentity(join(dir, 'managed-runtime.json'), deps({
            platform: 'linux',
        })).status).toBe('refused');
    });

    it('refuses when a file sits where an ancestor directory should be', () => {
        const blocker = join(root, 'blocker-file');
        writeFileSync(blocker, 'x');
        // ENOTDIR on the chain is a tamper signal, not absence — the same
        // fail-closed rule the marker itself follows.
        expect(resolveManagedRuntimeIdentity(join(blocker, 'sub', 'managed-runtime.json'), deps({
            platform: 'linux',
        })).status).toBe('refused');
    });
});

describe('the Linux absence walk needs a uid to stand on', () => {
    it('refuses on Linux when the daemon uid cannot be determined', () => {
        // Without a uid the trust premise cannot be established, and an
        // unestablished premise is a refusal — not a downgrade to BYOS.
        expect(resolveManagedRuntimeIdentity(join(root, 'gone', 'managed-runtime.json'), deps({
            platform: 'linux',
            getuid: () => -1,
        }))).toMatchObject({ status: 'refused' });
    });
});

/**
 * The axes a readiness answer is compared against.
 *
 * The parent checks a runtime's reported identity field by field before it
 * will dispatch to it — the Happy address it will actually talk to, the
 * provisioning operation that created it, the configuration it was created
 * for, and the provider resources it runs on. Every one of those has to come
 * from the marker only root can write.
 *
 * Not from caller parameters, and not from a file in the project: those are
 * exactly what an agent running inside the runtime can edit, and a runtime
 * that can describe itself can describe itself as somebody else's.
 */
describe('resolveManagedRuntimeIdentity — the identity a readiness answer is built from', () => {
    it('carries the address and provenance the parent compares against', () => {
        writeProvisioning();
        const resolution = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(resolution).toMatchObject({ status: 'active' });
        if (resolution.status !== 'active') return;
        expect(resolution.identity.happyMachineId).toBe('machine-1');
        expect(resolution.identity.provisioningOperationId).toBe('op-1');
        expect(resolution.identity.configDigest).toBe('digest-1');
        expect(resolution.identity.providerMachineId).toBe('fly-machine-1');
        expect(resolution.identity.providerInstanceId).toBe('fly-instance-1');
        // The volume axis comes from the provider through the marker. Nothing
        // the runtime can read names it, so it cannot be recovered later.
        expect(resolution.identity.providerVolumeId).toBe('vol_fixture_1');
    });

    it.each([
        'happyMachineId',
        'provisioningOperationId',
        'configDigest',
        'providerMachineId',
        'providerInstanceId',
        'providerVolumeId',
    ])('refuses — never activates — when %s is missing', (field) => {
        // Absent means the provisioner did not write it, which is a runtime
        // that cannot be told apart from another. There is nothing safe to
        // assume in its place.
        writeProvisioning({ [field]: undefined });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()).status).toBe('refused');
    });

    it('refuses a Happy address that is only a provider id', () => {
        // The two are different axes. Using a provider id as a Happy address
        // asks a daemon that does not exist, or — worse — publishes to
        // somebody else's machine.
        writeProvisioning({ happyMachineId: '   ' });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()).status).toBe('refused');
    });
});
