/**
 * specs/managed-cloud-byos §5.36 — how the daemon learns where the supervisor
 * is, and with what token to speak to it.
 *
 * ## Why this is a file and not an environment variable
 *
 * The supervisor is the only thing that can prove a generation is gone. A
 * client that can reach it and authenticate can ask it to stop generations.
 * So the address and the token are **authority**, and authority must not come
 * from a place the agent can write.
 *
 * The daemon's environment is not such a place: it is inherited, it is visible
 * to anything that can read `/proc/<pid>/environ` for that uid, and a value
 * there can be supplied by whoever spawned the process. If this module read an
 * env var, then anybody who could start the daemon with a chosen environment
 * could point it at their own socket — and a daemon talking to a fake
 * supervisor would be told "proven: true" about generations that are still
 * running. There is therefore **no environment fallback**, not even as a
 * development convenience: the fallback is the vulnerability.
 *
 * Instead, the trusted boot path (root, before the agent uid exists) writes
 * this record into the canonical state directory the provisioning marker
 * already names, and root owns it. The daemon reads it the same way it reads
 * every other root-protected record on this runtime: every ancestor checked,
 * the leaf opened with `O_NOFOLLOW`, ownership and mode judged on the open
 * descriptor.
 *
 * ## The socket path is checked, not obeyed
 *
 * A record could name any path. Two things are required of the one it names:
 * it must live **inside the canonical state directory**, and its own directory
 * chain must be trusted. Without the first, a record edited before root
 * finished locking the tree could redirect the daemon anywhere on the
 * filesystem; without the second, a trusted record could name a socket in a
 * directory the agent can write, and the agent would answer the daemon's
 * fencing questions.
 *
 * ## The token never leaves this process
 *
 * It is returned to the caller and handed to `createLauncherClient`. It is
 * never logged, never put into `process.env`, and never included in a refusal
 * detail — a provider started later inherits the daemon's environment, and a
 * boot token in it is a boot token the agent can read.
 */
import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

export const MANAGED_LAUNCHER_BINDING_VERSION = 1;

/**
 * Why the daemon cannot speak to a supervisor.
 *
 * `absent` is its own answer: no record yet is not the same as a record that
 * does not hold. The caller keeps the backend unwired either way, but only one
 * of the two may become ready without anybody fixing anything.
 */
export type ManagedLauncherBindingRefusal =
    | 'absent'
    | 'unusable'
    | 'socket-outside-state-dir'
    | 'socket-path-untrusted';

export type ManagedLauncherBinding = { socketPath: string; token: string };

export type ManagedLauncherBindingOutcome =
    | { ok: true; binding: ManagedLauncherBinding }
    | { ok: false; reason: ManagedLauncherBindingRefusal };

export function managedLauncherBindingPath(stateDir: string): string {
    return join(stateDir, 'launcher-binding.json');
}

/** A token long enough to be one, and short enough not to be a payload. */
const MAX_TOKEN_LENGTH = 512;

/**
 * `a` contains `b` — as a directory, not as a string prefix.
 *
 * `/state` must not be found to contain `/statement/evil.sock`, which a bare
 * `startsWith` would allow.
 */
function isInsideDirectory(directory: string, target: string): boolean {
    const root = resolve(directory);
    const path = resolve(target);
    return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function readManagedLauncherBinding(input: {
    /** The canonical state directory from the provisioning marker. */
    stateDir: string;
    deps: ManagedProvisioningDeps;
}): ManagedLauncherBindingOutcome {
    const path = managedLauncherBindingPath(input.stateDir);
    // The parent directory is what gets walked: `trustedPathRefusal` requires
    // every component of the chain it is given to be a directory, and the chain
    // includes the target, so a file path always refuses. The leaf's own safety
    // is judged on the descriptor instead, where it can be judged atomically.
    if (trustedPathRefusal(dirname(resolve(path)), input.deps.getuid(), 'unreadable', input.deps)) {
        return { ok: false, reason: 'unusable' };
    }

    const file = readRootProtectedFile(path, input.deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') return { ok: false, reason: 'absent' };
    if (file.kind !== 'ok') return { ok: false, reason: 'unusable' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return { ok: false, reason: 'unusable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'unusable' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== MANAGED_LAUNCHER_BINDING_VERSION) return { ok: false, reason: 'unusable' };

    const socketPath = typeof record.socketPath === 'string' ? record.socketPath.trim() : '';
    const token = typeof record.token === 'string' ? record.token : '';
    if (socketPath === '' || !isAbsolute(socketPath)) return { ok: false, reason: 'unusable' };
    if (token.trim() === '' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'unusable' };

    // Named by a trusted record, but still checked: the record says where the
    // socket should be, and this says where a socket is allowed to be.
    if (!isInsideDirectory(input.stateDir, socketPath)) {
        return { ok: false, reason: 'socket-outside-state-dir' };
    }
    if (trustedPathRefusal(dirname(resolve(socketPath)), input.deps.getuid(), 'unreadable', input.deps)) {
        return { ok: false, reason: 'socket-path-untrusted' };
    }
    return { ok: true, binding: { socketPath: resolve(socketPath), token } };
}

/**
 * Writes the record, **once**, from the trusted boot path.
 *
 * Called by whatever started the supervisor, after it is listening. It is the
 * claim that a supervisor is reachable at that address with that token, so it
 * is written last and flushed — with its directory entry — before anybody may
 * act on it: a record that survives a crash while the supervisor behind it did
 * not is a daemon confidently talking to nothing.
 *
 * `O_EXCL`, and a loser never overwrites. Two boots racing must not end with
 * one daemon holding the address of a supervisor the other replaced — the
 * second reads what the first wrote and either agrees with it or refuses. The
 * same discipline the volume seal uses, for the same reason: the first writer
 * is the authority, and overwriting is how two runtimes come to disagree about
 * which process owns the ledger.
 *
 * The socket is checked before it is published. Publishing an address outside
 * the state directory would make the reader's containment check the only thing
 * standing between a daemon and somebody else's socket, and a producer that
 * writes what a reader must reject is a producer that will eventually be
 * "fixed" by loosening the reader.
 */
export async function writeManagedLauncherBinding(input: {
    stateDir: string;
    socketPath: string;
    token: string;
    deps: ManagedProvisioningDeps;
    /** Overridden only by tests; the default flushes the file and its directory. */
    syncDirectory?: (path: string) => Promise<void>;
    /** Overridden only by tests, to fail inside the window before publishing. */
    syncFile?: (handle: fs.FileHandle) => Promise<void>;
}): Promise<
    | { ok: true; wrote: 'created' | 'existing' }
    | { ok: false; reason: ManagedLauncherBindingRefusal | 'invalid' }
> {
    const socketPath = resolve(input.socketPath);
    if (input.token.trim() === '' || input.token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'invalid' };
    }
    if (!isAbsolute(input.socketPath) || !isInsideDirectory(input.stateDir, socketPath)) {
        return { ok: false, reason: 'socket-outside-state-dir' };
    }

    const path = managedLauncherBindingPath(input.stateDir);
    const body = JSON.stringify({
        version: MANAGED_LAUNCHER_BINDING_VERSION,
        socketPath,
        token: input.token,
    });
    const syncDirectory = input.syncDirectory ?? syncDirectoryEntry;
    const syncFile = input.syncFile ?? ((handle: fs.FileHandle) => handle.sync());

    /*
     * Written to a temporary of this call's own, flushed, and only then
     * published.
     *
     * Opening the final path directly was the defect: this record is never
     * overwritten, so a crash between the `open` and the flush left a partial
     * file that is not stale-but-replaceable — it is permanent. Every later
     * boot would find something there, read it, refuse it, and have no way
     * past it. The temporary carries the pid and a fresh id so two boots
     * racing never share one, and each removes only its own.
     */
    const temporary = join(input.stateDir, `.launcher-binding.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            await handle.writeFile(body);
            // Explicit rather than left to `O_CREAT`'s mode, which the process
            // umask masks: the token in here is what proves a caller is the
            // daemon, and a permissive umask would publish it readable.
            await handle.chmod(0o600);
            await syncFile(handle);
        } finally {
            await handle.close();
        }
    } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        return { ok: false, reason: 'invalid' };
    }

    try {
        // `link`, not `rename`: rename replaces, and the first writer is the
        // authority here. A second boot must read what the first published
        // rather than quietly taking its place.
        await fs.link(temporary, path);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return { ok: false, reason: 'invalid' };
        }
        // Somebody got there first. Adopted only if it says the same thing;
        // a different address means two supervisors, and this one is not the
        // authority.
        const settled = readManagedLauncherBinding({ stateDir: input.stateDir, deps: input.deps });
        if (!settled.ok) return settled;
        if (settled.binding.socketPath !== socketPath || settled.binding.token !== input.token) {
            return { ok: false, reason: 'unusable' };
        }
        /*
         * Adopting is a claim that the record is on the disk, and the boot that
         * wrote it may have died before its directory entry was flushed —
         * including one directory `fsync` that simply failed. Inheriting that
         * assumption is how both boots report success over a record that
         * vanishes on the next power cut, so this one flushes before agreeing.
         */
        await flushPublished(path, input.stateDir, syncDirectory);
        return { ok: true, wrote: 'existing' };
    }
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    // The directory entry too: without this the file can be gone after a crash
    // even though its contents were flushed.
    await syncDirectory(input.stateDir);
    return { ok: true, wrote: 'created' };
}

/** Re-flushes a record this call did not write, before reporting it durable. */
async function flushPublished(
    path: string,
    directory: string,
    syncDirectory: (path: string) => Promise<void>,
): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await syncDirectory(directory);
}

async function syncDirectoryEntry(path: string): Promise<void> {
    const dir = await fs.open(path, constants.O_RDONLY);
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
}
