/**
 * The trusted boot channel between the supervisor and the daemon.
 *
 * What is tested is the part that decides authority: where the address may
 * come from, where the socket it names may live, and what happens when the
 * record is missing, forged or unreadable. A daemon that accepts a bad answer
 * here talks to something that is not the supervisor, and everything that
 * follows — "this generation is proven stopped" included — is that thing's
 * word.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    MANAGED_LAUNCHER_BINDING_VERSION,
    managedLauncherBindingPath,
    readManagedLauncherBinding,
    writeManagedLauncherBinding,
} from '@/daemon/launch/managedLauncherBinding';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const TOKEN = 'boot-token-that-only-root-wrote';

/** Reality for mode, symlinks and containment; ownership injected as root. */
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

function write(record: unknown): void {
    writeFileSync(managedLauncherBindingPath(stateDir), JSON.stringify(record), { mode: 0o600 });
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: MANAGED_LAUNCHER_BINDING_VERSION,
        socketPath: join(stateDir, 'launcher.sock'),
        token: TOKEN,
        ...over,
    };
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'launcher-binding-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('the daemon reading where its supervisor is', () => {
    it('accepts the record the trusted boot path wrote', () => {
        write(record());
        expect(readManagedLauncherBinding({ stateDir, deps: deps() })).toEqual({
            ok: true,
            binding: { socketPath: join(stateDir, 'launcher.sock'), token: TOKEN },
        });
    });

    it('separates "no record yet" from "a record that does not hold"', () => {
        // Only one of the two may become ready without anybody fixing anything.
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'absent' });
        write(record({ version: 99 }));
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a record that is not root-owned', () => {
        // Anyone who can write the record can name the socket, and a socket
        // they own answers fencing questions however they like.
        write(record());
        expect(readManagedLauncherBinding({
            stateDir,
            deps: deps({ statGate: () => ({ reason: 'not-root-owned' }) }),
        })).toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a socket outside the canonical state directory', () => {
        // A record naming somewhere else is a record redirecting the daemon at
        // something that is not this runtime's supervisor.
        write(record({ socketPath: join(base, 'elsewhere.sock') }));
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'socket-outside-state-dir' });
    });

    it('does not read containment as a string prefix', () => {
        // `/…/state-evil` is not inside `/…/state`.
        const sibling = `${stateDir}-evil`;
        mkdirSync(sibling, { mode: 0o700 });
        write(record({ socketPath: join(sibling, 'launcher.sock') }));
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'socket-outside-state-dir' });
    });

    it('refuses a socket whose directory anybody else can write', () => {
        // The record can be trusted and the socket still be the agent's.
        const open = join(stateDir, 'open');
        mkdirSync(open);
        // `mkdir` 의 mode 는 umask 로 깎인다 — 명시적으로 되돌려야 실제로
        // 남이 쓸 수 있는 디렉터리가 된다.
        chmodSync(open, 0o777);
        write(record({ socketPath: join(open, 'launcher.sock') }));
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'socket-path-untrusted' });
    });

    it('refuses a socket reached through a symlinked directory', () => {
        const outside = join(base, 'outside');
        mkdirSync(outside, { mode: 0o700 });
        symlinkSync(outside, join(stateDir, 'link'));
        write(record({ socketPath: join(stateDir, 'link', 'launcher.sock') }));
        // Following it would put the socket outside the state directory while
        // the written path still looked like it was inside.
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }).ok).toBe(false);
    });

    it.each([
        ['a relative socket path', { socketPath: 'launcher.sock' }],
        ['no socket path', { socketPath: '' }],
        ['no token', { token: '   ' }],
        ['a token that is a payload', { token: 'x'.repeat(513) }],
        ['a token that is not a string', { token: 42 }],
    ])('refuses %s', (_name, over) => {
        write(record(over));
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a record that is not JSON, and one that is not an object', () => {
        writeFileSync(managedLauncherBindingPath(stateDir), 'not json', { mode: 0o600 });
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'unusable' });
        write([record()]);
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('never puts the token where a later provider could read it', () => {
        // A provider inherits the daemon's environment. A boot token in it is a
        // boot token the agent can read out of /proc.
        write(record());
        const before = { ...process.env };
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }).ok).toBe(true);
        expect(Object.entries(process.env).some(([, value]) => value === TOKEN)).toBe(false);
        expect(process.env).toEqual(before);
    });

    it('reads no environment variable to find the supervisor', () => {
        // The fallback is the vulnerability: an inherited value is chosen by
        // whoever started the daemon.
        process.env.SAYCODE_LAUNCHER_SOCKET = join(stateDir, 'launcher.sock');
        process.env.SAYCODE_LAUNCHER_TOKEN = TOKEN;
        try {
            expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
                .toEqual({ ok: false, reason: 'absent' });
        } finally {
            delete process.env.SAYCODE_LAUNCHER_SOCKET;
            delete process.env.SAYCODE_LAUNCHER_TOKEN;
        }
    });
});

describe('the boot path publishing where the supervisor is', () => {
    const socketPath = () => join(stateDir, 'launcher.sock');

    it('writes a record the daemon then reads back', async () => {
        // The two halves are one contract. A writer that produced something
        // the reader rejects is a writer that gets "fixed" by loosening the
        // reader, which is how the check stops being a check.
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: TOKEN, deps: deps(),
        })).toEqual({ ok: true, wrote: 'created' });
        expect(readManagedLauncherBinding({ stateDir, deps: deps() })).toEqual({
            ok: true, binding: { socketPath: socketPath(), token: TOKEN },
        });
    });

    it('does not publish an address the reader would have to refuse', async () => {
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: join(base, 'elsewhere.sock'), token: TOKEN, deps: deps(),
        })).toEqual({ ok: false, reason: 'socket-outside-state-dir' });
        // Nothing written: a refused publish must not leave a record behind.
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('refuses to publish without a token', async () => {
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: '  ', deps: deps(),
        })).toEqual({ ok: false, reason: 'invalid' });
    });

    it('adopts an identical record rather than rewriting it', async () => {
        await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: TOKEN, deps: deps(),
        });
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: TOKEN, deps: deps(),
        })).toEqual({ ok: true, wrote: 'existing' });
    });

    it('never overwrites a record naming another supervisor', async () => {
        // The first writer is the authority. Overwriting would leave the daemon
        // holding the address of a supervisor that was replaced, while the
        // replaced one still owns the ledger and the children.
        await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: TOKEN, deps: deps(),
        });
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: 'a-second-boots-token', deps: deps(),
        })).toEqual({ ok: false, reason: 'unusable' });
        // And the first record is still the one that is there.
        expect(readManagedLauncherBinding({ stateDir, deps: deps() })).toEqual({
            ok: true, binding: { socketPath: socketPath(), token: TOKEN },
        });
    });

    it('flushes the record and its directory entry before anybody acts on it', async () => {
        // A record that survives a crash while the supervisor behind it did not
        // is a daemon confidently talking to nothing.
        const synced: string[] = [];
        expect(await writeManagedLauncherBinding({
            stateDir,
            socketPath: socketPath(),
            token: TOKEN,
            deps: deps(),
            syncDirectory: async (path) => { synced.push(path); },
        })).toEqual({ ok: true, wrote: 'created' });
        expect(synced).toEqual([stateDir]);
    });
});

describe('publishing survives a crash in the middle of it', () => {
    /*
     * The record is never overwritten, which is what makes a half-written one
     * fatal: it is not a stale file that the next boot replaces, it is a
     * permanent obstacle. Every later boot finds something at the path, reads
     * it, and refuses — and there is no path back short of somebody deleting
     * the file by hand.
     *
     * So the file at the final path is only ever a complete, flushed one:
     * written to a temporary of this call's own and published by `link`, which
     * still refuses to replace an existing record.
     */
    const socketPath = () => join(stateDir, 'launcher.sock');

    function leftovers(): string[] {
        return readdirSync(stateDir).filter((name) => name !== 'launcher-binding.json');
    }

    it('leaves nothing behind when the write itself fails', async () => {
        const full = await writeManagedLauncherBinding({
            stateDir,
            socketPath: socketPath(),
            token: TOKEN,
            deps: deps(),
            // Fails after the temporary exists, which is exactly the window
            // that used to leave a partial file at the final path.
            syncFile: async () => { throw new Error('injected file fsync failure'); },
        });
        expect(full.ok).toBe(false);
        // Nothing published, and no temporary of ours left in the directory.
        expect(readManagedLauncherBinding({ stateDir, deps: deps() }))
            .toEqual({ ok: false, reason: 'absent' });
        expect(leftovers()).toEqual([]);

        // And the next boot works, rather than inheriting a permanent refusal.
        expect(await writeManagedLauncherBinding({
            stateDir, socketPath: socketPath(), token: TOKEN, deps: deps(),
        })).toEqual({ ok: true, wrote: 'created' });
        expect(leftovers()).toEqual([]);
    });

    it('refuses the publish when the directory entry cannot be flushed', async () => {
        // Reporting success here would tell the caller the address is durable
        // when the file can still vanish. The supervisor it names would then be
        // unreachable by a daemon that is certain it knows where it is.
        const result = await writeManagedLauncherBinding({
            stateDir,
            socketPath: socketPath(),
            token: TOKEN,
            deps: deps(),
            syncDirectory: async () => { throw new Error('injected directory fsync failure'); },
        }).catch(() => ({ ok: false as const, reason: 'invalid' as const }));
        expect(result.ok).toBe(false);
    });

    it('flushes again when it adopts a record it did not publish', async () => {
        /*
         * Adoption is a claim that the record is on the disk. The boot that
         * wrote it may have died before its directory entry was flushed, so
         * inheriting that assumption is how a record vanishes on the next power
         * cut while both boots reported success.
         */
        let syncs = 0;
        const call = {
            stateDir,
            socketPath: socketPath(),
            token: TOKEN,
            deps: deps(),
            syncDirectory: async () => {
                syncs++;
                if (syncs === 1) throw new Error('injected directory fsync failure');
            },
        };
        const first = await writeManagedLauncherBinding(call).catch(() => ({ ok: false as const }));
        expect(first.ok).toBe(false);
        expect(syncs).toBe(1);

        const second = await writeManagedLauncherBinding(call);
        expect(second.ok).toBe(true);
        expect(syncs).toBe(2);
    });
});
