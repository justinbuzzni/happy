/**
 * The boot path end to end: a record on the canonical state directory, the
 * client the daemon builds from it, and a **real supervisor answering over a
 * real Unix socket**.
 *
 * The unit tests above this one prove the record is judged correctly. What they
 * cannot prove is that the values they accept are the values that make a
 * working client — a binding that reads fine and produces a client nobody can
 * authenticate with is a backend that silently never answers, and a daemon in
 * that state reports "not fenced" forever without anything looking broken.
 *
 * The supervisor runs in this process here. Its separate-process lifetime is
 * `launcher/supervisorProcess.test.ts`'s subject; what is under test here is the
 * daemon's half of the handshake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSupervisorRuntime } from '@/launcher/main';
import {
    MANAGED_LAUNCHER_BINDING_VERSION,
    managedLauncherBindingPath,
    readManagedLauncherBinding,
} from '@/daemon/launch/managedLauncherBinding';
import { createLauncherClient, createUnixSocketRequest } from '@/daemon/launch/launcherClient';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;
let runtime: ReturnType<typeof createSupervisorRuntime> | null = null;

const DAEMON_UID = process.getuid?.() ?? 0;

function deps(): ManagedProvisioningDeps {
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

/** The supervisor the trusted boot path starts, before the agent uid exists. */
async function startSupervisor(): Promise<{ socketPath: string; token: string }> {
    const socketPath = join(stateDir, 'launcher.sock');
    runtime = createSupervisorRuntime({
        config: {
            cgroupRoot: '/sys/fs/cgroup/saycode',
            helperPath: '/usr/local/lib/saycode/exec-helper',
            workloadPath: '/usr/local/lib/saycode/node',
            resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
        },
        manifestRoot: join(base, 'manifest'),
        stagingRoot: join(base, 'staging'),
        socketPath,
        watchdogIntervalMs: 1_000,
        releaseDeadlineMs: 2_000,
        runtimeId: `boot-fixture-${process.pid}`,
        // 운영은 Linux 추상 소켓 잠금을 쓴다. 이 자리만 바꾼다 — 잠금 계약은
        // launcher 쪽 전용 테스트가 확인한다.
        acquireLock: async () => ({ ok: true, release: async () => {} }),
    });
    await runtime.start();
    return { socketPath, token: runtime.token };
}

/** What the trusted boot path leaves behind for the daemon. */
function writeBinding(input: { socketPath: string; token: string }): void {
    writeFileSync(
        managedLauncherBindingPath(stateDir),
        JSON.stringify({
            version: MANAGED_LAUNCHER_BINDING_VERSION,
            socketPath: input.socketPath,
            token: input.token,
        }),
        { mode: 0o600 },
    );
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'launcher-boot-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(async () => {
    await runtime?.stop().catch(() => { /* 이미 멈췄다 */ });
    runtime = null;
    rmSync(base, { recursive: true, force: true });
});

describe('the daemon binding itself to its supervisor', () => {
    it('answers a real fencing question through the record the boot path wrote', async () => {
        const started = await startSupervisor();
        writeBinding(started);

        const binding = readManagedLauncherBinding({ stateDir, deps: deps() });
        expect(binding.ok).toBe(true);
        if (!binding.ok) return;
        const backend = createLauncherClient({
            token: binding.binding.token,
            deps: createUnixSocketRequest(binding.binding.socketPath, 5_000),
        });

        // Nothing was ever launched, so every generation below the ceiling is
        // provably gone — and the proof came over the socket, from the process
        // that owns the ledger.
        expect(await backend.proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER }))
            .toMatchObject({ proven: true });
    }, 30_000);

    it('produces a client the supervisor rejects when the record carries the wrong token', async () => {
        const started = await startSupervisor();
        writeBinding({ socketPath: started.socketPath, token: 'not-the-boot-token' });

        const binding = readManagedLauncherBinding({ stateDir, deps: deps() });
        expect(binding.ok).toBe(true);
        if (!binding.ok) return;
        const backend = createLauncherClient({
            token: binding.binding.token,
            deps: createUnixSocketRequest(binding.binding.socketPath, 5_000),
        });

        // A record can be well-formed and still not be this supervisor's. The
        // refusal has to arrive as "not proven", never as a proof — an
        // unauthenticated client that read as `proven: true` would let a
        // daemon promote over generations it cannot see.
        expect(await backend.proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER }))
            .toMatchObject({ proven: false });
    }, 30_000);

    it('reports not-proven rather than proven when no supervisor is listening', async () => {
        // The socket path is inside the state directory and the record is
        // sound; there is simply nothing behind it. Absence of an answer must
        // never read as an answer.
        writeBinding({ socketPath: join(stateDir, 'launcher.sock'), token: 'boot-token' });
        const binding = readManagedLauncherBinding({ stateDir, deps: deps() });
        expect(binding.ok).toBe(true);
        if (!binding.ok) return;
        const backend = createLauncherClient({
            token: binding.binding.token,
            deps: createUnixSocketRequest(binding.binding.socketPath, 1_000),
        });
        expect(await backend.proveGenerationStopped({ belowEpoch: 5 }))
            .toMatchObject({ proven: false });
    }, 30_000);
});
