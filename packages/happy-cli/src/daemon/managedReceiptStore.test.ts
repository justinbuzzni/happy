import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    classifyManagedReceipt,
    createManagedReceiptStore,
    managedOperationKey,
    managedReceiptFileName,
    ManagedReceiptStoreError,
    type ManagedReceiptStore,
} from './managedReceiptStore';

const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let root: string;
let store: ManagedReceiptStore;
let held = true;

const lock = { assertHeld: (action: string) => { if (!held) throw new Error(`lock lost: ${action}`); } };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-receipts-'));
    held = true;
    store = createManagedReceiptStore(root, lock);
});

afterEach(() => {
    // Restore permissions first or cleanup fails on the EACCES cases.
    try { chmodSync(join(root, 'receipts'), 0o700); } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true });
});

function claim(requestKey = 'req-00000001', overrides: Record<string, unknown> = {}) {
    return store.claim({
        requestKey,
        runId: 'run-1',
        attemptId: 'attempt-1',
        epoch: 3,
        workspaceId: "ws-1",
        projectId: "proj-1",
        spawnPayloadDigest: null,
        now: 1_000,
        ...overrides,
    } as Parameters<ManagedReceiptStore['claim']>[0]);
}

function receiptPath(requestKey: string): string {
    return join(root, 'receipts', managedReceiptFileName(requestKey));
}

describe('managedReceiptFileName', () => {
    it('hashes the key so no key content reaches the filesystem', () => {
        const key = 'req-abcdefgh';
        expect(managedReceiptFileName(key))
            .toBe(`${createHash('sha256').update(key).digest('hex')}.json`);
    });

    it('rejects keys that could escape the receipts directory', () => {
        for (const key of ['../../etc/passwd', 'a/b', 'x'.repeat(201), 'short', '', 'has space']) {
            expect(() => managedReceiptFileName(key)).toThrowError(ManagedReceiptStoreError);
        }
    });
});

describe('claim', () => {
    it('creates a receipt once and reports the existing one afterwards', () => {
        const first = claim();
        expect(first.kind).toBe('created');
        const second = claim();
        expect(second.kind).toBe('exists');
        if (second.kind === 'exists') expect(second.receipt.claimedAt).toBe(1_000);
    });

    it('never re-creates a receipt whose file is corrupt', () => {
        claim();
        writeFileSync(receiptPath('req-00000001'), '{truncated');
        // Re-creating would drop what the previous attempt recorded and let the
        // same request execute a second time.
        expect(claim().kind).toBe('corrupt');
    });

    it('refuses a claim when the writer lock is not held', () => {
        held = false;
        expect(() => claim()).toThrowError(/lock lost/);
    });

    it('publishes a complete file, never an empty one', () => {
        claim();
        const parsed = JSON.parse(readFileSync(receiptPath('req-00000001'), 'utf8'));
        expect(parsed).toMatchObject({ version: 1, state: 'claimed', runId: 'run-1', rev: 1 });
    });

    it('keeps concurrent claims of the same key to a single creation', async () => {
        const results = await Promise.all(
            Array.from({ length: 20 }, () => Promise.resolve().then(() => claim('req-concurrent1'))),
        );
        expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
        expect(results.filter((r) => r.kind === 'exists')).toHaveLength(19);
    });
});

describe('strict receipt parsing', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
        ['a foreign requestKey', { requestKey: 'req-somethingelse' }],
        ['a non-string runId', { runId: 42 }],
        ['a missing attemptId', { attemptId: undefined }],
        ['a fractional epoch', { epoch: 1.5 }],
        ['a negative rev', { rev: -1 }],
        ['a string timestamp', { claimedAt: 'yesterday' }],
        ['a non-integer pid', { pid: 12.5 }],
        ['a negative pid', { pid: -3 }],
        ['an unknown state', { state: 'exploded' }],
        ['a wrong version', { version: 2 }],
    ];

    for (const [name, override] of cases) {
        it(`treats ${name} as unknown rather than valid`, () => {
            claim();
            const stored = JSON.parse(readFileSync(receiptPath('req-00000001'), 'utf8'));
            writeFileSync(receiptPath('req-00000001'), JSON.stringify({ ...stored, ...override }));
            expect(store.read('req-00000001').kind).toBe('unknown');
        });
    }

    it('accepts the receipt it wrote', () => {
        claim();
        expect(store.read('req-00000001').kind).toBe('ok');
    });
});

describe('read and exists distinguish absence from doubt', () => {
    it('reports absent for a key that was never claimed', () => {
        expect(store.read('req-00000002')).toEqual({ kind: 'absent' });
        expect(store.exists('req-00000002')).toEqual({ kind: 'absent' });
    });

    it('reports unknown — not absent — for a corrupt receipt', () => {
        claim();
        writeFileSync(receiptPath('req-00000001'), 'garbage');
        expect(store.read('req-00000001').kind).toBe('unknown');
        expect(store.exists('req-00000001').kind).toBe('present');
    });

    it.skipIf(RUNNING_AS_ROOT)('reports unknown when the receipt cannot be read', () => {
        claim();
        chmodSync(receiptPath('req-00000001'), 0o000);
        const result = store.read('req-00000001');
        expect(result.kind).toBe('unknown');
    });
});

describe('list surfaces what it could not understand', () => {
    it('returns receipts and no unknowns for a healthy store', () => {
        claim('req-00000001');
        claim('req-00000002');
        const listed = store.list();
        expect(listed.receipts).toHaveLength(2);
        expect(listed.unknown).toEqual([]);
        expect(listed.listError).toBeUndefined();
    });

    it('reports a corrupt entry instead of silently dropping it', () => {
        claim('req-00000001');
        claim('req-00000002');
        writeFileSync(receiptPath('req-00000002'), '{');
        const listed = store.list();
        // Dropping it silently would hide a possibly running child from the
        // fencing decision that reads this list.
        expect(listed.receipts).toHaveLength(1);
        expect(listed.unknown).toHaveLength(1);
    });

    it.skipIf(RUNNING_AS_ROOT)('reports a directory it cannot read', () => {
        claim('req-00000001');
        chmodSync(join(root, 'receipts'), 0o000);
        const listed = store.list();
        expect(listed.listError).toBeDefined();
        expect(listed.receipts).toEqual([]);
    });
});

describe('lease durability', () => {
    it('reports absent before any lease was written', () => {
        expect(store.readLease()).toEqual({ kind: 'absent' });
    });

    it('round-trips epoch and renewal sequence', () => {
        store.writeLease({ epoch: 4, renewalSeq: 9, updatedAt: 2_000 });
        expect(store.readLease()).toEqual({
            kind: 'ok',
            record: { version: 1, epoch: 4, renewalSeq: 9, updatedAt: 2_000 },
        });
    });

    it('never persists a usable deadline', () => {
        store.writeLease({ epoch: 4, renewalSeq: 9, updatedAt: 2_000 });
        const raw = readFileSync(join(root, 'lease.json'), 'utf8');
        expect(raw).not.toMatch(/leaseUntil|deadline|expiresAt/i);
    });

    it('reports unknown — not a fresh lease — when the record is corrupt', () => {
        store.writeLease({ epoch: 4, renewalSeq: 9, updatedAt: 2_000 });
        writeFileSync(join(root, 'lease.json'), '{"version":1,"epoch":');
        // Falling back to epoch/seq 0 would accept a renewal token that was
        // already spent, re-opening the write deadline after a restart.
        expect(store.readLease().kind).toBe('unknown');
    });

    for (const override of [
        { renewalSeq: undefined },
        { renewalSeq: 'nine' },
        { epoch: Number.NaN },
        { epoch: 1.5 },
        { renewalSeq: -1 },
        { version: 2 },
    ]) {
        it(`reports unknown for a lease record with ${JSON.stringify(override)}`, () => {
            store.writeLease({ epoch: 4, renewalSeq: 9, updatedAt: 2_000 });
            const stored = JSON.parse(readFileSync(join(root, 'lease.json'), 'utf8'));
            writeFileSync(join(root, 'lease.json'), JSON.stringify({ ...stored, ...override }));
            expect(store.readLease().kind).toBe('unknown');
        });
    }

    it.skipIf(RUNNING_AS_ROOT)('reports unknown when the lease file cannot be read', () => {
        store.writeLease({ epoch: 4, renewalSeq: 9, updatedAt: 2_000 });
        chmodSync(join(root, 'lease.json'), 0o000);
        expect(store.readLease().kind).toBe('unknown');
        chmodSync(join(root, 'lease.json'), 0o600);
    });

    it('refuses a lease write when the writer lock is not held', () => {
        held = false;
        expect(() => store.writeLease({ epoch: 1, renewalSeq: 1, updatedAt: 1 }))
            .toThrowError(/lock lost/);
    });
});

describe('tombstone and stop/spawn ordering', () => {
    it('records a stop that arrives before any dispatch', () => {
        const result = store.tombstone({
            requestKey: 'req-00000003', runId: 'run-1', attemptId: 'attempt-1', epoch: 3, now: 500,
        });
        expect(result.kind).toBe('created');
        if (result.kind === 'created') expect(result.receipt.state).toBe('tombstone');
    });

    it('makes a later claim observe the tombstone instead of creating a receipt', () => {
        store.tombstone({
            requestKey: 'req-00000003', runId: 'run-1', attemptId: 'attempt-1', epoch: 3, now: 500,
        });
        const later = claim('req-00000003');
        expect(later.kind).toBe('exists');
        if (later.kind === 'exists') expect(later.receipt.state).toBe('tombstone');
    });

    it('marks a stop that lands while a spawn is still in flight', () => {
        claim();
        store.update('req-00000001', { state: 'spawning', spawnAt: 1_100 }, 1_100);
        const updated = store.update('req-00000001', { stopRequestedAt: 1_200 }, 1_200);
        expect(updated.state).toBe('spawning');
        expect(updated.stopRequestedAt).toBe(1_200);
        expect(updated.rev).toBe(3);
    });
});

describe('update', () => {
    it('refuses to update a receipt that does not exist', () => {
        expect(() => store.update('req-00000009', { state: 'running' }, 1))
            .toThrowError(ManagedReceiptStoreError);
    });

    it('refuses to update a receipt that cannot be parsed', () => {
        claim();
        writeFileSync(receiptPath('req-00000001'), 'nope');
        expect(() => store.update('req-00000001', { state: 'running' }, 1))
            .toThrowError(ManagedReceiptStoreError);
    });

    it('refuses an update when the writer lock is not held', () => {
        claim();
        held = false;
        expect(() => store.update('req-00000001', { state: 'running' }, 1))
            .toThrowError(/lock lost/);
    });
});

describe('classifyManagedReceipt', () => {
    const base = {
        version: 1 as const,
        requestKey: 'req-00000001',
        runId: 'run-1',
        attemptId: 'attempt-1',
        epoch: 3,
        workspaceId: "ws-1",
        projectId: "proj-1",
        spawnPayloadDigest: null,
        pid: null,
        pgid: null,
        sessionId: null,
        stopRequestedAt: null,
        failureReason: null,
        claimedAt: 1,
        spawnAt: null,
        updatedAt: 1,
        rev: 1,
    };

    it('treats a receipt stuck in spawning as uncertain', () => {
        expect(classifyManagedReceipt({ ...base, state: 'spawning' }, () => true))
            .toBe('uncertain');
    });

    it('treats a spawned receipt with a live pid as determinate', () => {
        expect(classifyManagedReceipt({ ...base, state: 'spawned', pid: 10 }, () => true))
            .toBe('determinate');
    });

    it('treats a spawned receipt whose pid is gone as uncertain', () => {
        // The child may have registered a session and then died.
        expect(classifyManagedReceipt({ ...base, state: 'spawned', pid: 10 }, () => false))
            .toBe('uncertain');
    });

    it('treats claimed, running and terminal receipts as determinate', () => {
        for (const state of ['claimed', 'running', 'stopped', 'tombstone'] as const) {
            expect(classifyManagedReceipt({ ...base, state }, () => false)).toBe('determinate');
        }
    });

    it('treats a failure as determinate only with typed not-started evidence', () => {
        expect(classifyManagedReceipt(
            { ...base, state: 'failed', failureReason: 'not-started' }, () => false,
        )).toBe('determinate');
    });

    it('treats an unexplained failure as uncertain', () => {
        // The spawn may have created a child before the error surfaced; calling
        // that determinate ends the story for a run that could still be writing.
        for (const reason of [null, 'spawn-threw', 'socket-closed']) {
            expect(classifyManagedReceipt(
                { ...base, state: 'failed', failureReason: reason }, () => false,
            )).toBe('uncertain');
        }
    });
});

describe('managedOperationKey', () => {
    it('is stable for the same run and attempt so a retry deduplicates', () => {
        expect(managedOperationKey({ runId: 'run-1', attemptId: 'a-1' }))
            .toBe(managedOperationKey({ runId: 'run-1', attemptId: 'a-1' }));
    });

    it('differs for a new attempt of the same run', () => {
        expect(managedOperationKey({ runId: 'run-1', attemptId: 'a-1' }))
            .not.toBe(managedOperationKey({ runId: 'run-1', attemptId: 'a-2' }));
    });

    it('differs for the same attempt id under a different run', () => {
        expect(managedOperationKey({ runId: 'run-1', attemptId: 'a-1' }))
            .not.toBe(managedOperationKey({ runId: 'run-2', attemptId: 'a-1' }));
    });

    it('does not let a boundary shift collide two different pairs', () => {
        // 'ab' + 'c' and 'a' + 'bc' must not hash to the same key.
        expect(managedOperationKey({ runId: 'ab', attemptId: 'c' }))
            .not.toBe(managedOperationKey({ runId: 'a', attemptId: 'bc' }));
    });

    it('produces a key the receipt store accepts as a filename', () => {
        expect(() => managedReceiptFileName(managedOperationKey({ runId: 'run-1', attemptId: 'a-1' })))
            .not.toThrow();
    });

    it('is not the client request key, whose uniqueness scope includes the actor', () => {
        // Two actors may legitimately send the same requestKey for different
        // Runs; deriving from run/attempt ids is what keeps them apart here.
        const key = managedOperationKey({ runId: 'run-1', attemptId: 'a-1' });
        expect(key).not.toContain('req-');
        expect(key.startsWith('mop.')).toBe(true);
    });

    it('refuses to derive a key from missing ids', () => {
        expect(() => managedOperationKey({ runId: '', attemptId: 'a-1' }))
            .toThrowError(ManagedReceiptStoreError);
    });
});
