/**
 * specs/managed-cloud-byos §5.36 — the credential a managed daemon runs as.
 *
 * ## Why a managed daemon cannot use the ordinary path
 *
 * `authAndSetupMachineIfNeeded` does two things that are right for BYOS and
 * wrong here. It runs an **interactive** authentication when no credential is
 * on disk — there is nobody at a terminal in a cloud runtime — and it invents a
 * machine id with `randomUUID()`. The parent has already registered this
 * runtime's Machine and holds its id; a daemon that generated its own would
 * publish readiness for a machine nobody is listening on, and the marker check
 * would refuse the boot anyway.
 *
 * So the managed path consumes a credential the trusted parent issued, and
 * consumes it from a place the agent cannot write.
 *
 * ## What is in it, and why each part
 *
 *  - `machineId` — the Machine the parent registered. An address, not a name
 *    this process may choose.
 *  - `token` — a bearer of the **daemon's own purpose**. Never the account
 *    bearer: that one reaches every session on the account, and this process
 *    runs code the customer's agent can influence.
 *  - `machineKey` — the raw 32 bytes the parent wrapped for this Machine.
 *    Without it the daemon cannot read anything encrypted for the machine. It
 *    is a secret, which is exactly why it lives here and not in the boot input
 *    file: this record is rewritable on renewal, and root-only.
 *  - `expiresAt` — the daemon credential is short-lived by design. It is
 *    recorded so an expired one is *known* to be expired rather than discovered
 *    when the server refuses it.
 *  - `serverOrigin` — which Happy this credential is for. A credential is only
 *    valid against the server that issued it, and sending it elsewhere is
 *    sending a bearer token to a host of somebody else's choosing.
 *
 * ## Never a fallback
 *
 * Every failure to read this is a refusal. There is no path from "the managed
 * credential is missing or expired" to "authenticate as a person instead" —
 * that path ends with a cloud runtime holding an account bearer.
 */
import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

export const MANAGED_DAEMON_CREDENTIAL_VERSION = 1;

/** The raw machine key is 32 bytes; anything else is not that key. */
const MACHINE_KEY_BYTES = 32;

export type ManagedDaemonCredential = {
    machineId: string;
    token: string;
    machineKey: Uint8Array;
    /**
     * The account public key the machine key was wrapped for.
     *
     * Public, and carried rather than derived: `Credentials` of the `dataKey`
     * kind are the pair, and a daemon that filled this in from anywhere else
     * would be claiming its key belongs to an account nobody said it did.
     */
    accountPublicKey: Uint8Array;
    expiresAt: number;
    serverOrigin: string;
};

export type ManagedDaemonCredentialRefusal =
    | 'absent'
    | 'unusable'
    | 'expired'
    | 'wrong-machine';

export type ManagedDaemonCredentialOutcome =
    | { ok: true; credential: ManagedDaemonCredential }
    | { ok: false; reason: ManagedDaemonCredentialRefusal };

export function managedDaemonCredentialPath(stateDir: string): string {
    return join(stateDir, 'daemon-credential.json');
}

export function readManagedDaemonCredential(input: {
    stateDir: string;
    /** The Machine the marker says this runtime is. Compared, never adopted. */
    expectedMachineId: string;
    now: number;
    deps: ManagedProvisioningDeps;
}): ManagedDaemonCredentialOutcome {
    const path = managedDaemonCredentialPath(input.stateDir);
    // The parent directory is walked; the leaf is judged on its own descriptor
    // with `O_NOFOLLOW`, where it can be judged atomically.
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
    if (record.version !== MANAGED_DAEMON_CREDENTIAL_VERSION) return { ok: false, reason: 'unusable' };

    const machineId = typeof record.machineId === 'string' ? record.machineId.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    const serverOrigin = typeof record.serverOrigin === 'string' ? record.serverOrigin.trim() : '';
    const expiresAt = record.expiresAt;
    const machineKeyB64 = typeof record.machineKey === 'string' ? record.machineKey : '';
    const publicKeyB64 = typeof record.accountPublicKey === 'string' ? record.accountPublicKey : '';
    if (machineId === '' || token === '' || serverOrigin === ''
        || machineKeyB64 === '' || publicKeyB64 === '') {
        return { ok: false, reason: 'unusable' };
    }
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
        return { ok: false, reason: 'unusable' };
    }
    // An origin that is not an absolute http(s) URL is not somewhere a bearer
    // may be sent. A relative or scheme-less value would be resolved against
    // whatever the process happens to think the default is.
    let origin: string;
    try {
        const url = new URL(serverOrigin);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        origin = url.origin;
    } catch {
        return { ok: false, reason: 'unusable' };
    }

    const machineKey = Buffer.from(machineKeyB64, 'base64');
    // Re-encoding catches the values `Buffer.from` silently accepts: a short
    // string, a truncated one, anything that is not this key.
    if (machineKey.length !== MACHINE_KEY_BYTES
        || machineKey.toString('base64') !== machineKeyB64) {
        return { ok: false, reason: 'unusable' };
    }
    const accountPublicKey = Buffer.from(publicKeyB64, 'base64');
    if (accountPublicKey.length !== MACHINE_KEY_BYTES
        || accountPublicKey.toString('base64') !== publicKeyB64) {
        return { ok: false, reason: 'unusable' };
    }

    // Compared against the marker, because the two are separate records and a
    // credential for another Machine is a credential that would publish this
    // runtime's readiness somewhere else.
    if (machineId !== input.expectedMachineId) return { ok: false, reason: 'wrong-machine' };
    // Expiry is its own answer: renewal can fix it, and the caller should say
    // so rather than reporting a runtime with no credential at all.
    if (expiresAt <= input.now) return { ok: false, reason: 'expired' };

    return {
        ok: true,
        credential: {
            machineId,
            token,
            machineKey: new Uint8Array(machineKey),
            accountPublicKey: new Uint8Array(accountPublicKey),
            expiresAt,
            serverOrigin: origin,
        },
    };
}

/**
 * Writes the credential, replacing whatever was there.
 *
 * Unlike the launcher binding and the volume seal, this record is **meant** to
 * be replaced: renewal issues a new bearer for the same Machine, and a daemon
 * that could not take the new one would stop working when the old one expired.
 * What must not change is which Machine it is for — that is the caller's check,
 * and `readManagedDaemonCredential` refuses a mismatch on the way back in.
 *
 * Written to a temporary file in the same directory and renamed, so a crash
 * leaves either the old credential or the new one, never a half-written record
 * that reads as `unusable` and takes the runtime down.
 */
export async function writeManagedDaemonCredential(input: {
    stateDir: string;
    credential: ManagedDaemonCredential;
    /** Overridden only by tests; the default flushes the file and its directory. */
    syncDirectory?: (path: string) => Promise<void>;
    /** Overridden only by tests, to fail inside the window before publishing. */
    syncFile?: (handle: fs.FileHandle) => Promise<void>;
}): Promise<void> {
    const path = managedDaemonCredentialPath(input.stateDir);
    /*
     * A temporary of this call's own, created exclusively.
     *
     * One shared `.new` name is one shared **inode**: two refreshers — a
     * heartbeat and a reconnect, two daemons overlapping across a restart —
     * open it together, and the first to rename publishes a file the second is
     * still writing into. What comes back out is then neither credential, and
     * the runtime reads a token that was never issued.
     */
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify({
        version: MANAGED_DAEMON_CREDENTIAL_VERSION,
        machineId: input.credential.machineId,
        token: input.credential.token,
        machineKey: Buffer.from(input.credential.machineKey).toString('base64'),
        accountPublicKey: Buffer.from(input.credential.accountPublicKey).toString('base64'),
        expiresAt: input.credential.expiresAt,
        serverOrigin: input.credential.serverOrigin,
    });
    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            await handle.writeFile(body);
            // Explicit rather than left to `O_CREAT`'s mode, which the umask
            // masks: this file holds the machine key.
            await handle.chmod(0o600);
            await (input.syncFile ?? ((h: fs.FileHandle) => h.sync()))(handle);
        } finally {
            await handle.close();
        }
        // `rename`, unlike the seal and the binding: a renewed credential is
        // *meant* to replace the previous one, and the replacement is atomic.
        await fs.rename(temporary, path);
    } catch (error) {
        // Only this call's own temporary. Removing temporaries as a class would
        // delete the file a concurrent writer is about to publish.
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
    await (input.syncDirectory ?? syncDirectoryEntry)(input.stateDir);
}

async function syncDirectoryEntry(path: string): Promise<void> {
    const dir = await fs.open(path, constants.O_RDONLY);
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
}
