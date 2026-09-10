/**
 * The parent handing a managed runtime the identity it runs as.
 *
 * ## Why there is a second file at all
 *
 * The credential is minted by the parent against the control plane — the
 * runtime cannot mint it, and deliberately cannot: `daemon/bootstrap` and
 * `daemon/renew` both require the control plane's Ed25519 assertion, which no
 * process inside a guest holds. So the identity has to arrive from outside,
 * and the only channel that exists before the daemon can talk to anything is a
 * file the provider writes into the guest at start (`config.files`, with the
 * bytes carried in the machine's own configuration).
 *
 * It is **not** the provisioning marker and not the boot input beside it. Those
 * describe what this machine is, are read by the composer, and are compared
 * against on every boot. This one carries a bearer and a 32-byte machine key:
 * conflating the two would put secrets into a record whose whole purpose is to
 * be read and echoed as identity.
 *
 * ## What this module does **not** claim about the delivery
 *
 * Reaching the guest as a file says nothing about who else can read it, and it
 * is worth being exact, because the obvious reading is wrong. Fly's
 * `config.files` entry has two forms. With `raw_value` the bytes are **inline
 * base64 in the machine configuration**, so everyone who can read that machine
 * through the provider API can read them — the same audience as metadata, which
 * is precisely the audience this delivery was chosen to avoid. With
 * `secret_name` the bytes come from an app secret, which the API cannot read
 * back; that is a real channel, and its scope is the *app*, so it is only a
 * boundary if one app does not host more than one tenant's runtimes.
 *
 * So the confidentiality of what arrives here is a **deployment contract owned
 * by the parent**, not a property this module can verify or assert:
 *
 *  - the credential must be delivered by a channel the provider API cannot read
 *    back (`secret_name`-backed, or a payload this runtime can decrypt with a
 *    key that never appears in the machine configuration), and
 *  - the app's scope must be the runtime's trust boundary.
 *
 * Until the parent's side of that is implemented and reviewed, a credential
 * delivered in a machine configuration should be treated as short-lived and
 * replaceable rather than secret. What this module *can* enforce is the part
 * inside the guest, and it does: the file is refused unless it is root-owned
 * **and readable by nobody else**, judged on the descriptor that was opened.
 *
 * ## What this module does, and what it refuses
 *
 * It reads that file through the same root-protected gate the marker uses,
 * validates every field, and writes the runtime's own
 * `daemon-credential.json`. Nothing about the contents is ever logged: it is
 * the parent's input and it holds key material.
 *
 * Adoption is conditional, and both conditions are about not losing an
 * identity that is already working:
 *
 *  - A stored credential for a **different Machine** is a conflict, not
 *    something to overwrite. Two identities on one volume means whichever boots
 *    last publishes this runtime's readiness under a Machine the parent is not
 *    watching.
 *  - A stored credential for the same Machine that lives **at least as long**
 *    is kept. The delivered file is re-materialised on every start, so a
 *    restart would otherwise walk a renewed credential backwards to the one the
 *    machine was created with.
 *
 * The input file is never deleted. It is not this process's to remove — the
 * provider owns it, it is re-created on every start, and a runtime that deleted
 * it would have nothing to fall back to if its state directory were replaced.
 */
import { dirname, resolve } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedIdentityRefusal,
    type ManagedProvisioningDeps,
    type ProvisioningStat,
} from '@/daemon/managedRuntimeIdentity';
import {
    managedDaemonCredentialPath,
    readManagedDaemonCredential,
    writeManagedDaemonCredential,
    type ManagedDaemonCredential,
} from '@/daemon/managedDaemonCredential';

/** Where the provider writes it. Fixed, like the marker's own path. */
export const MANAGED_DAEMON_CREDENTIAL_INPUT_PATH = '/etc/saycode/daemon-credential.json';

/** The one shape this reader accepts. */
export const MANAGED_DAEMON_CREDENTIAL_INPUT_VERSION = 1;

const KEY_BYTES = 32;

/**
 * The gate this file is judged by, which is **not** the marker's.
 *
 * The provisioning marker is an identity record: it must be root-written, and
 * being world-readable is harmless — `assertProvisioningStat` allows `0644` for
 * exactly that reason. This file is not that. It carries a bearer and a 32-byte
 * machine key, and anything that can read it can be this runtime.
 *
 * So the ownership rule is inherited and a confidentiality rule is added: no
 * group or other bits at all. Applied to the descriptor that was actually
 * opened, not to a path that was looked at a moment earlier.
 */
function assertPrivateCredentialStat(
    stat: ProvisioningStat,
    ownerGate: (stat: ProvisioningStat) => { reason: ManagedIdentityRefusal } | null,
): { reason: ManagedIdentityRefusal } | null {
    const owner = ownerGate(stat);
    if (owner) return owner;
    // `0o077`: any read, write or execute bit for group or other.
    if ((stat.mode & 0o077) !== 0) return { reason: 'not-root-owned' };
    return null;
}

export type ManagedCredentialAdoption =
    /** Written from the delivered file. */
    | { status: 'adopted'; machineId: string; expiresAt: number }
    /** A credential at least as good is already there. */
    | { status: 'current'; machineId: string; expiresAt: number }
    /** No file was delivered. A BYOS machine, or a runtime whose parent has not wired this yet. */
    | { status: 'absent' }
    | { status: 'refused'; reason: ManagedCredentialAdoptionRefusal };

export type ManagedCredentialAdoptionRefusal =
    /** The file is there and is not something this may act on. */
    | 'input-untrusted'
    /** Present, readable, and not the record this expects. */
    | 'input-unusable'
    /** Delivered already past its expiry: nothing here can renew it. */
    | 'input-expired'
    /** A credential for another Machine is already on this volume. */
    | 'machine-conflict'
    /** The write did not complete. */
    | 'unwritable';

type ParsedInput = {
    machineId: string;
    token: string;
    machineKey: Uint8Array;
    accountPublicKey: Uint8Array;
    expiresAt: number;
    serverOrigin: string;
};

function decodeKey(value: unknown): Uint8Array | null {
    if (typeof value !== 'string' || value === '') return null;
    const decoded = Buffer.from(value, 'base64');
    // Re-encoded, because `Buffer.from` accepts a truncated or malformed string
    // silently and would leave a key that is not the key.
    if (decoded.length !== KEY_BYTES || decoded.toString('base64') !== value) return null;
    return new Uint8Array(decoded);
}

function parseInput(content: string): ParsedInput | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== MANAGED_DAEMON_CREDENTIAL_INPUT_VERSION) return null;

    const machineId = typeof record.machineId === 'string' ? record.machineId.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    const origin = typeof record.serverOrigin === 'string' ? record.serverOrigin.trim() : '';
    if (machineId === '' || token === '' || origin === '') return null;
    if (typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) return null;

    const machineKey = decodeKey(record.machineKey);
    const accountPublicKey = decodeKey(record.accountPublicKey);
    if (!machineKey || !accountPublicKey) return null;

    // An origin that is not an absolute http(s) URL is not somewhere a bearer
    // may be sent: a scheme-less value is resolved against whatever the process
    // happens to think the default is.
    let serverOrigin: string;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        serverOrigin = url.origin;
    } catch {
        return null;
    }

    return { machineId, token, machineKey, accountPublicKey, expiresAt: record.expiresAt, serverOrigin };
}

/**
 * Reads the delivered credential and makes it this runtime's own.
 *
 * Called from the boot stage, before anything authenticates: `run.ts` reads
 * `daemon-credential.json` and refuses to start managed without one, so the
 * file has to be there by then and cannot be produced later by the daemon
 * itself.
 */
export async function adoptManagedDaemonCredential(input: {
    stateDir: string;
    /** The Machine the marker says this runtime is. Compared, never adopted. */
    expectedMachineId: string;
    now: number;
    deps: ManagedProvisioningDeps;
    /** Overridden only by tests; production reads the delivered path. */
    inputPath?: string;
}): Promise<ManagedCredentialAdoption> {
    const path = input.inputPath ?? MANAGED_DAEMON_CREDENTIAL_INPUT_PATH;
    const ownerGate = input.deps.statGate ?? assertProvisioningStat;
    // Ownership from the deps (injected, because a test user is not root),
    // confidentiality from the real mode either way.
    const gate = (stat: ProvisioningStat) => assertPrivateCredentialStat(stat, ownerGate);

    // The directory it sits in, then the file's own descriptor with
    // `O_NOFOLLOW`: a path anybody else can write is a path where this file can
    // be swapped between the check and the read.
    if (trustedPathRefusal(dirname(resolve(path)), input.deps.getuid(), 'unreadable', input.deps)) {
        return { status: 'refused', reason: 'input-untrusted' };
    }
    const file = readRootProtectedFile(path, gate);
    if (file.kind === 'absent') return { status: 'absent' };
    if (file.kind !== 'ok') return { status: 'refused', reason: 'input-untrusted' };

    const delivered = parseInput(file.content);
    // The contents are never echoed, here or anywhere below.
    if (!delivered) return { status: 'refused', reason: 'input-unusable' };
    if (delivered.machineId !== input.expectedMachineId) {
        return { status: 'refused', reason: 'machine-conflict' };
    }

    /*
     * What is already on the volume, read **before** the delivered file's own
     * expiry is judged.
     *
     * The delivered file is the one the machine was created with and it is
     * re-materialised on every start, so after the first renewal it is
     * routinely the *older* of the two. Refusing on its expiry first turned a
     * perfectly healthy restart — valid renewed credential on the volume, stale
     * initial copy beside it — into a runtime that would not boot.
     */
    const stored = readManagedDaemonCredential({
        stateDir: input.stateDir,
        expectedMachineId: input.expectedMachineId,
        now: input.now,
        deps: input.deps,
    });
    if (stored.ok && stored.credential.expiresAt >= delivered.expiresAt) {
        // A renewal already on the volume outlives what was delivered. The
        // delivered file is re-materialised on every start, so adopting it
        // would walk the identity backwards on a restart.
        return {
            status: 'current',
            machineId: stored.credential.machineId,
            expiresAt: stored.credential.expiresAt,
        };
    }
    if (!stored.ok && stored.reason === 'wrong-machine') {
        // Another Machine's identity is on this volume. Overwriting it would
        // make whichever boots last publish readiness under a Machine the
        // parent is not watching.
        return { status: 'refused', reason: 'machine-conflict' };
    }
    /*
     * Only now: nothing usable is stored, and what was delivered is past its
     * life. Nothing inside a guest can renew it — both control-plane routes
     * that issue one require a signature no process here holds — so writing it
     * would produce a runtime that starts and immediately stops.
     */
    if (delivered.expiresAt <= input.now) return { status: 'refused', reason: 'input-expired' };

    const credential: ManagedDaemonCredential = {
        machineId: delivered.machineId,
        token: delivered.token,
        machineKey: delivered.machineKey,
        accountPublicKey: delivered.accountPublicKey,
        expiresAt: delivered.expiresAt,
        serverOrigin: delivered.serverOrigin,
    };
    try {
        await writeManagedDaemonCredential({ stateDir: input.stateDir, credential });
    } catch {
        // No detail: the failure path can carry the path's contents in an
        // error message, and this one holds a machine key.
        return { status: 'refused', reason: 'unwritable' };
    }
    return {
        status: 'adopted',
        machineId: credential.machineId,
        expiresAt: credential.expiresAt,
    };
}

/** Where the runtime's own copy lives, for callers that report on it. */
export { managedDaemonCredentialPath };
