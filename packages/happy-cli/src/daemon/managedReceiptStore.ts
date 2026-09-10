/**
 * Durable state for managed dispatch: one receipt per request, plus the lease
 * pointer that fencing reads.
 *
 * Every write lands before the answer goes out. A receipt is created with
 * `link()` rather than `open(..., 'wx')` because `link` publishes a file that
 * is already complete — with `wx` a crash between create and write leaves a
 * zero-byte file that a later reader cannot distinguish from a real claim, and
 * "unreadable so let's start over" is how a request gets executed twice.
 *
 * What is deliberately *not* stored: prompts, tokens, environment, directory
 * contents. A receipt holds identifiers and lifecycle, nothing a leak would
 * make interesting.
 *
 * Nothing here decides that a session stopped. The store records what the
 * daemon observed locally; proving that no process survived is the job of
 * cgroup emptiness or a provider stop, neither of which this process can see.
 */

import {
    closeSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * `claimed` a request was accepted and nothing has been started.
 * `spawning` about to spawn; the pid is not known yet.
 * `spawned`  a pid exists; the session id is not known yet.
 * `running`  the child reported its session.
 * `stopping` a stop was requested and signalled.
 * `tombstone` a stop arrived before any spawn; later spawns must refuse.
 */
export const MANAGED_RECEIPT_STATES = [
    'claimed', 'spawning', 'spawned', 'running', 'stopping', 'stopped', 'failed', 'tombstone',
] as const;
export type ManagedReceiptState = (typeof MANAGED_RECEIPT_STATES)[number];

export type ManagedReceipt = {
    version: 1;
    requestKey: string;
    runId: string;
    attemptId: string;
    epoch: number;
    /** Scope the operation was signed for; a duplicate must match it. */
    workspaceId: string;
    projectId: string;
    /**
     * Digest of the signed spawn params. Not the params — a digest is enough to
     * detect a conflicting duplicate and carries no request content.
     * A stop carries its own digest and is never compared against this one.
     */
    spawnPayloadDigest: string | null;
    state: ManagedReceiptState;
    pid: number | null;
    pgid: number | null;
    sessionId: string | null;
    /** Set when a stop lands while the spawn is still in flight. */
    stopRequestedAt: number | null;
    failureReason: string | null;
    claimedAt: number;
    spawnAt: number | null;
    updatedAt: number;
    rev: number;
};

export type ManagedLeaseRecord = {
    version: 1;
    epoch: number;
    renewalSeq: number;
    updatedAt: number;
};

export type ManagedClaimResult =
    | { kind: 'created'; receipt: ManagedReceipt }
    | { kind: 'exists'; receipt: ManagedReceipt }
    /** Present but unreadable. Never re-created — that would re-run the request. */
    | { kind: 'corrupt'; requestKey: string };

/**
 * Absence and doubt are different answers and callers act on them differently:
 * `absent` permits a first dispatch, `unknown` must block one.
 */
export type ManagedReceiptLookup =
    | { kind: 'absent' }
    | { kind: 'unknown'; detail: string }
    | { kind: 'ok'; receipt: ManagedReceipt };

export type ManagedLeaseLookup =
    | { kind: 'absent' }
    | { kind: 'unknown'; detail: string }
    | { kind: 'ok'; record: ManagedLeaseRecord };

export type ManagedReceiptListing = {
    receipts: ManagedReceipt[];
    /** Entries present on disk that could not be parsed. Never dropped. */
    unknown: Array<{ file: string; detail: string }>;
    /** Set when the directory itself could not be read. */
    listError?: string;
};

function isTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): boolean {
    return value === null || isTimestamp(value);
}

function isNullablePid(value: unknown): boolean {
    return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function isNullableString(value: unknown): boolean {
    return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 400);
}

/**
 * Every field is checked, including `requestKey` against the key the caller
 * looked up. A receipt whose key does not match the file it was found in means
 * the store was tampered with or a hash collided; either way it is not a
 * receipt this daemon may act on.
 */
function parseReceipt(raw: unknown, expectedRequestKey: string): ManagedReceipt | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1) return null;
    if (r.requestKey !== expectedRequestKey) return null;
    if (typeof r.runId !== 'string' || !r.runId) return null;
    if (typeof r.attemptId !== 'string' || !r.attemptId) return null;
    if (typeof r.state !== 'string' || !MANAGED_RECEIPT_STATES.includes(r.state as ManagedReceiptState)) return null;
    if (!Number.isSafeInteger(r.epoch) || (r.epoch as number) < 0) return null;
    if (!Number.isSafeInteger(r.rev) || (r.rev as number) < 1) return null;
    if (!isTimestamp(r.claimedAt) || !isTimestamp(r.updatedAt)) return null;
    if (!isNullableTimestamp(r.spawnAt) || !isNullableTimestamp(r.stopRequestedAt)) return null;
    if (!isNullablePid(r.pid) || !isNullablePid(r.pgid)) return null;
    if (!isNullableString(r.sessionId) || !isNullableString(r.failureReason)) return null;
    if (typeof r.workspaceId !== 'string' || !r.workspaceId) return null;
    if (typeof r.projectId !== 'string' || !r.projectId) return null;
    if (!isNullableString(r.spawnPayloadDigest)) return null;
    return r as unknown as ManagedReceipt;
}

function parseLease(raw: unknown): ManagedLeaseRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1) return null;
    if (!Number.isSafeInteger(r.epoch) || (r.epoch as number) < 0) return null;
    if (!Number.isSafeInteger(r.renewalSeq) || (r.renewalSeq as number) < 0) return null;
    if (!isTimestamp(r.updatedAt)) return null;
    return r as unknown as ManagedLeaseRecord;
}

export class ManagedReceiptStoreError extends Error {
    constructor(readonly code: 'INVALID_REQUEST_KEY' | 'WRITER_LOCK_LOST' | 'RECEIPT_MISSING', message: string) {
        super(message);
        this.name = 'ManagedReceiptStoreError';
    }
}

const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * The request key reaches us from the network and becomes part of a path, so it
 * is both validated and hashed. Validation keeps a malformed key from being
 * silently accepted; hashing means no key content — traversal sequences
 * included — ever reaches the filesystem.
 */
export function managedReceiptFileName(requestKey: string): string {
    if (!REQUEST_KEY_PATTERN.test(requestKey)) {
        throw new ManagedReceiptStoreError('INVALID_REQUEST_KEY', 'managed request key is not well formed');
    }
    return `${createHash('sha256').update(requestKey).digest('hex')}.json`;
}

/**
 * The key a managed operation is filed under.
 *
 * The client's `requestKey` is deliberately NOT used. Its uniqueness scope on
 * the server is (actor, project, requestKey), so two actors in the same
 * workspace may legitimately send the same string for two different Runs — on
 * this daemon that would collide into one receipt and the second Run would be
 * answered with the first one's outcome. The server-generated run and attempt
 * ids have no such overlap.
 *
 * The derivation also gives retry semantics for free: a retry of the same
 * attempt hashes to the same key and is deduplicated, while an intentional new
 * attempt carries a new attemptId and is therefore a new operation. A stop must
 * derive its key the same way so the tombstone lands on the same receipt.
 */
export function managedOperationKey(input: { runId: string; attemptId: string }): string {
    if (!input.runId || !input.attemptId) {
        throw new ManagedReceiptStoreError('INVALID_REQUEST_KEY', 'managed operation key needs run and attempt ids');
    }
    const digest = createHash('sha256')
        .update(input.runId).update('\u0000').update(input.attemptId)
        .digest('hex');
    return `mop.${digest}`;
}

export type ManagedStoreLock = { assertHeld: (action: string) => void };

/** Same mapping as `managedReceiptFileName`, but never throws during a listing. */
function managedReceiptFileNameSafe(requestKey: string): string | null {
    try {
        return managedReceiptFileName(requestKey);
    } catch {
        return null;
    }
}

export function createManagedReceiptStore(root: string, lock: ManagedStoreLock) {
    const receiptsDir = join(root, 'receipts');
    const tmpDir = join(root, 'tmp');
    const leasePath = join(root, 'lease.json');

    const ensureDirs = () => {
        mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
        mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    };

    const fsyncDir = (dir: string) => {
        const fd = openSync(dir, 'r');
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    };

    /** Writes a complete file and forces it to disk before it is published. */
    const writeTmp = (value: unknown): string => {
        ensureDirs();
        const path = join(tmpDir, randomBytes(16).toString('hex'));
        const fd = openSync(path, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(value));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        return path;
    };

    const receiptPath = (requestKey: string) => join(receiptsDir, managedReceiptFileName(requestKey));

    const read = (requestKey: string): ManagedReceiptLookup => {
        let raw: string;
        try {
            raw = readFileSync(receiptPath(requestKey), 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Only a missing file means "never claimed". EACCES/EIO mean the
            // record may exist and say something we must not overwrite.
            if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
            return { kind: 'unknown', detail: code ?? 'read failed' };
        }
        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch {
            return { kind: 'unknown', detail: 'not JSON' };
        }
        const receipt = parseReceipt(parsedJson, requestKey);
        return receipt ? { kind: 'ok', receipt } : { kind: 'unknown', detail: 'failed validation' };
    };

    const exists = (requestKey: string): { kind: 'absent' } | { kind: 'present' } | { kind: 'unknown'; detail: string } => {
        try {
            readFileSync(receiptPath(requestKey));
            return { kind: 'present' };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
            return { kind: 'unknown', detail: code ?? 'read failed' };
        }
    };

    const publish = (requestKey: string, receipt: ManagedReceipt): ManagedClaimResult => {
        const tmp = writeTmp(receipt);
        try {
            linkSync(tmp, receiptPath(requestKey));
            fsyncDir(receiptsDir);
            return { kind: 'created', receipt };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const existing = read(requestKey);
            // The file is there but will not parse. Re-creating it would drop
            // whatever the previous attempt recorded and let the request run a
            // second time, so this is escalated instead.
            if (existing.kind !== 'ok') return { kind: 'corrupt', requestKey };
            return { kind: 'exists', receipt: existing.receipt };
        } finally {
            try {
                unlinkSync(tmp);
            } catch {
                // Already consumed by link(), or removed by a previous attempt.
            }
        }
    };

    return {
        read,
        exists,

        /** Accept a request exactly once. Never re-runs an existing one. */
        claim(input: {
            requestKey: string;
            runId: string;
            attemptId: string;
            epoch: number;
            workspaceId?: string;
            projectId?: string;
            spawnPayloadDigest?: string | null;
            now: number;
        }): ManagedClaimResult {
            lock.assertHeld('managed receipt claim');
            return publish(input.requestKey, {
                version: 1,
                requestKey: input.requestKey,
                runId: input.runId,
                attemptId: input.attemptId,
                epoch: input.epoch,
                workspaceId: input.workspaceId ?? 'unknown',
                projectId: input.projectId ?? 'unknown',
                spawnPayloadDigest: input.spawnPayloadDigest ?? null,
                state: 'claimed',
                pid: null,
                pgid: null,
                sessionId: null,
                stopRequestedAt: null,
                failureReason: null,
                claimedAt: input.now,
                spawnAt: null,
                updatedAt: input.now,
                rev: 1,
            });
        },

        /**
         * Records a stop for a request that was never claimed, so a dispatch
         * that arrives afterwards has something durable to refuse against. The
         * server's outbox can emit a stop before a dispatch reaches the runtime.
         */
        tombstone(input: {
            requestKey: string; runId: string; attemptId: string; epoch: number;
            workspaceId?: string; projectId?: string; now: number;
        }): ManagedClaimResult {
            lock.assertHeld('managed receipt tombstone');
            return publish(input.requestKey, {
                version: 1,
                requestKey: input.requestKey,
                runId: input.runId,
                attemptId: input.attemptId,
                epoch: input.epoch,
                workspaceId: input.workspaceId ?? 'unknown',
                projectId: input.projectId ?? 'unknown',
                spawnPayloadDigest: null,
                state: 'tombstone',
                pid: null,
                pgid: null,
                sessionId: null,
                stopRequestedAt: input.now,
                failureReason: null,
                claimedAt: input.now,
                spawnAt: null,
                updatedAt: input.now,
                rev: 1,
            });
        },

        update(requestKey: string, patch: Partial<Omit<ManagedReceipt, 'version' | 'requestKey' | 'rev'>>, now: number): ManagedReceipt {
            lock.assertHeld('managed receipt update');
            const current = read(requestKey);
            if (current.kind !== 'ok') {
                throw new ManagedReceiptStoreError(
                    'RECEIPT_MISSING',
                    `managed receipt not usable for update (${current.kind})`,
                );
            }
            const next: ManagedReceipt = { ...current.receipt, ...patch, updatedAt: now, rev: current.receipt.rev + 1 };
            const tmp = writeTmp(next);
            renameSync(tmp, receiptPath(requestKey));
            fsyncDir(receiptsDir);
            return next;
        },

        /**
         * Fencing reads this list to decide what may still be running. An entry
         * that cannot be parsed, or a directory that cannot be read, is
         * reported rather than skipped — a silent omission would look like
         * "nothing is running" and let a new writable generation open over a
         * live child.
         */
        list(): ManagedReceiptListing {
            let names: string[];
            try {
                names = readdirSync(receiptsDir);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') return { receipts: [], unknown: [] };
                return { receipts: [], unknown: [], listError: code ?? 'readdir failed' };
            }
            const receipts: ManagedReceipt[] = [];
            const unknown: Array<{ file: string; detail: string }> = [];
            for (const name of names) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(readFileSync(join(receiptsDir, name), 'utf8'));
                } catch (error) {
                    unknown.push({ file: name, detail: (error as NodeJS.ErrnoException).code ?? 'unparsable' });
                    continue;
                }
                const key = (parsed as { requestKey?: unknown } | null)?.requestKey;
                const receipt = typeof key === 'string' ? parseReceipt(parsed, key) : null;
                if (receipt && managedReceiptFileNameSafe(receipt.requestKey) === name) receipts.push(receipt);
                else unknown.push({ file: name, detail: 'failed validation' });
            }
            return { receipts, unknown };
        },

        /**
         * A corrupt or unreadable lease is never reported as a fresh one.
         * Treating it as epoch 0 / seq 0 would accept a renewal token that was
         * already spent and re-open the runtime's write deadline after a
         * restart, which is exactly what the sequence exists to prevent.
         */
        readLease(): ManagedLeaseLookup {
            let raw: string;
            try {
                raw = readFileSync(leasePath, 'utf8');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
                return { kind: 'unknown', detail: code ?? 'read failed' };
            }
            let parsedJson: unknown;
            try {
                parsedJson = JSON.parse(raw);
            } catch {
                return { kind: 'unknown', detail: 'not JSON' };
            }
            const record = parseLease(parsedJson);
            return record ? { kind: 'ok', record } : { kind: 'unknown', detail: 'failed validation' };
        },

        /**
         * Persists epoch and renewal sequence only. The usable deadline is
         * never written: after a restart the runtime must obtain a freshly
         * signed lease before it may execute anything.
         */
        writeLease(record: Omit<ManagedLeaseRecord, 'version'>): ManagedLeaseRecord {
            lock.assertHeld('managed lease write');
            const next: ManagedLeaseRecord = { version: 1, ...record };
            const tmp = writeTmp(next);
            renameSync(tmp, leasePath);
            fsyncDir(root);
            return next;
        },
    };
}

export type ManagedReceiptStore = ReturnType<typeof createManagedReceiptStore>;

/**
 * Whether the outcome of this receipt is known.
 *
 * `spawning` is uncertain by construction: the process may or may not have been
 * created before the crash, and nothing on this host can tell which. `spawned`
 * with a dead pid is uncertain too — the child may have registered a session
 * and then died. Both must go to reconciliation rather than be retried.
 */
export function classifyManagedReceipt(
    receipt: ManagedReceipt,
    isPidAlive: (pid: number) => boolean,
): 'determinate' | 'uncertain' {
    switch (receipt.state) {
        case 'spawning':
            return 'uncertain';
        case 'spawned':
            return receipt.pid !== null && isPidAlive(receipt.pid) ? 'determinate' : 'uncertain';
        case 'failed':
            // `failed` is only written when the spawn reported, in a typed
            // field, that nothing was started. Anything else stays uncertain.
            return receipt.failureReason === 'not-started' ? 'determinate' : 'uncertain';
        default:
            return 'determinate';
    }
}
