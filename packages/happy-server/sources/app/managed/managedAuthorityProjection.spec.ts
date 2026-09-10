import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type {
    readRunScopeAuthority as ReadRunScopeAuthority,
    readAuthoritySnapshot as ReadAuthoritySnapshot,
    syncRunAuthority as SyncRunAuthority,
    syncWorkspaceAuthority as SyncWorkspaceAuthority,
    RunAuthorityBody,
    WorkspaceAuthorityBody,
} from '@/app/managed/managedAuthorityProjection';

/**
 * Real-PostgreSQL suite, opt-in only.
 *
 * The guarantees under test are the database's — two writers at one version, a
 * cancellation landing between read and write, two identical first inserts — so
 * a fake would only assert that the fake agrees with itself.
 *
 * It runs only when `HAPPY_MANAGED_TEST_DATABASE_URL` names a database whose
 * owner accepts these writes, never on the ambient `DATABASE_URL`. Cleanup is
 * limited to the ids this file generated: no truncate, reset, or unscoped
 * delete, so the suite stays incapable of clearing a database that is not its
 * own.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

// `@/storage/db` is a module-level singleton built from `DATABASE_URL` at
// import time, so the redirect has to happen before the dynamic imports below.
// The source is untouched; the fixture restores what it changed in `afterAll`.
const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
};

if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
}

function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const NOW = 1_800_000_000_000;

let db: PrismaClient;
let syncWorkspaceAuthority: typeof SyncWorkspaceAuthority;
let syncRunAuthority: typeof SyncRunAuthority;
let readRunScopeAuthority: typeof ReadRunScopeAuthority;
let readAuthoritySnapshot: typeof ReadAuthoritySnapshot;

/** Every id this file created, so cleanup never reaches beyond them. */
const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();

let workspaceId: string;
let runId: string;

function newWorkspaceId(): string {
    const id = `ws-${randomUUID()}`;
    createdWorkspaceIds.add(id);
    return id;
}

function newRunId(): string {
    const id = `run-${randomUUID()}`;
    createdRunIds.add(id);
    return id;
}

function workspaceBody(over: Partial<WorkspaceAuthorityBody> = {}): WorkspaceAuthorityBody {
    return {
        workspaceId,
        tenantId: 'tenant-1',
        projectId: 'project-1',
        epoch: 1,
        runtimeId: 'runtime-1',
        ...over,
    };
}

function runBody(over: Partial<RunAuthorityBody> = {}): RunAuthorityBody {
    return {
        runId,
        workspaceId,
        // A bare string is enough here: these columns carry no foreign key, and
        // this file tests the projection's CAS rules, not ownership. The grant
        // owner checks land later and must use a real Account/Session fixture —
        // a placeholder there would assert nothing about who owns what.
        accountId: 'account-1',
        currentAttemptId: 'attempt-1',
        cancelled: false,
        ...over,
    };
}

function uniqueViolation(): Error {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
    });
}

type TransactionFn = (...args: never[]) => unknown;

/**
 * Swaps `db.$transaction` and hands back the exact restore. `vi.spyOn` does not
 * work here: Prisma resolves `$transaction` through a proxy, so restoring the
 * spy leaves the property gone.
 */
function replaceTransaction(
    impl: (original: TransactionFn, ...args: never[]) => unknown,
): () => void {
    const original = (db as unknown as { $transaction: TransactionFn }).$transaction.bind(db);
    (db as unknown as { $transaction: TransactionFn }).$transaction =
        ((...args: never[]) => impl(original, ...args)) as TransactionFn;
    return () => {
        (db as unknown as { $transaction: TransactionFn }).$transaction = original;
    };
}

describe.skipIf(!enabled)('managed authority projection (real PostgreSQL)', () => {
    beforeEach(async () => {
        if (!syncWorkspaceAuthority) {
            const projection = await import('@/app/managed/managedAuthorityProjection');
            syncWorkspaceAuthority = projection.syncWorkspaceAuthority;
            syncRunAuthority = projection.syncRunAuthority;
            readRunScopeAuthority = projection.readRunScopeAuthority;
            readAuthoritySnapshot = projection.readAuthoritySnapshot;
            db = (await import('@/storage/db')).db as unknown as PrismaClient;
        }
        workspaceId = newWorkspaceId();
        runId = newRunId();
    });

    afterEach(async () => {
        // Runs first: a run row references its workspace.
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
    });

    afterAll(async () => {
        // Proves the cleanup above actually covered what the suite created,
        // rather than leaving rows behind in someone's database.
        expect(await db.managedRunAuthority.count({
            where: { runId: { in: [...createdRunIds] } },
        })).toBe(0);
        expect(await db.managedWorkspaceAuthority.count({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        })).toBe(0);
        await db.$disconnect();
        restoreEnv();
    });

    describe('workspace authority', () => {
        it('creates at version 1 from expectedVersion 0', async () => {
            const result = await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            expect(result).toMatchObject({ ok: true, version: 1, idempotent: false });
        });

        it('refuses a create that claims a non-zero version', async () => {
            expect(await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 3, now: NOW }))
                .toEqual({ ok: false, reason: 'version-conflict' });
        });

        it('advances the version on an accepted update', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            const result = await syncWorkspaceAuthority({
                body: workspaceBody({ epoch: 2, runtimeId: 'runtime-2' }), expectedVersion: 1, now: NOW,
            });
            expect(result).toMatchObject({ ok: true, version: 2, idempotent: false });
        });

        it('returns the stored row for an exact retry instead of advancing again', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            const body = workspaceBody({ epoch: 2 });
            const first = await syncWorkspaceAuthority({ body, expectedVersion: 1, now: NOW });
            const retry = await syncWorkspaceAuthority({ body, expectedVersion: 1, now: NOW });
            expect(first).toMatchObject({ ok: true, version: 2, idempotent: false });
            expect(retry).toMatchObject({ ok: true, version: 2, idempotent: true });
        });

        it('refuses a different body at a version already consumed', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            await syncWorkspaceAuthority({ body: workspaceBody({ epoch: 2 }), expectedVersion: 1, now: NOW });
            // Two control-plane replicas disagreeing about version 1 must not
            // both be accepted; the second is a conflict, not a retry.
            expect(await syncWorkspaceAuthority({
                body: workspaceBody({ epoch: 5 }), expectedVersion: 1, now: NOW,
            })).toEqual({ ok: false, reason: 'version-conflict' });
        });

        it('refuses to move the ownership binding', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            expect(await syncWorkspaceAuthority({
                body: workspaceBody({ projectId: 'project-2' }), expectedVersion: 1, now: NOW,
            })).toEqual({ ok: false, reason: 'immutable-binding-changed' });
        });

        it('refuses an epoch that goes backwards', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody({ epoch: 5 }), expectedVersion: 0, now: NOW });
            expect(await syncWorkspaceAuthority({
                body: workspaceBody({ epoch: 4 }), expectedVersion: 1, now: NOW,
            })).toEqual({ ok: false, reason: 'epoch-regression' });
        });

        it('refuses a runtime swap that does not advance the epoch', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            // Grants minted for runtime-1 would keep passing the epoch check
            // while naming a runtime that no longer exists.
            expect(await syncWorkspaceAuthority({
                body: workspaceBody({ runtimeId: 'runtime-2' }), expectedVersion: 1, now: NOW,
            })).toEqual({ ok: false, reason: 'runtime-change-without-epoch' });
        });

        it('accepts a runtime swap that comes with a new epoch', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            expect(await syncWorkspaceAuthority({
                body: workspaceBody({ runtimeId: 'runtime-2', epoch: 2 }), expectedVersion: 1, now: NOW,
            })).toMatchObject({ ok: true, version: 2 });
        });

        it('does not turn a concurrent first insert of the same body into an error', async () => {
            const body = workspaceBody();
            // Two control-plane replicas issuing the identical create must both
            // see the accepted row: a 500 for the loser breaks the retry
            // contract every caller depends on.
            const [a, b] = await Promise.all([
                syncWorkspaceAuthority({ body, expectedVersion: 0, now: NOW }),
                syncWorkspaceAuthority({ body, expectedVersion: 0, now: NOW }),
            ]);
            expect(a).toMatchObject({ ok: true, version: 1 });
            expect(b).toMatchObject({ ok: true, version: 1 });
            expect([a, b].filter((r) => r.ok && r.idempotent)).toHaveLength(1);
        });

        it('recovers when the insert itself loses to a unique violation', async () => {
            // Concurrent callers serialize under this isolation level, so the
            // case above never reaches the violation. This one injects it: the
            // violation aborts its transaction, so recovery must happen in a
            // fresh one. Everything past the injection is the real database.
            let injected = false;
            const restore = replaceTransaction((original, ...args) => {
                if (injected) return original(...args);
                injected = true;
                return Promise.reject(uniqueViolation());
            });

            try {
                expect(await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW }))
                    .toMatchObject({ ok: true, version: 1 });
            } finally {
                restore();
            }
            expect(injected).toBe(true);
            expect(await db.managedWorkspaceAuthority.count({ where: { workspaceId } })).toBe(1);
        });

        it('fails closed rather than spinning when the violation does not clear', async () => {
            let attempts = 0;
            const restore = replaceTransaction(() => {
                attempts++;
                return Promise.reject(uniqueViolation());
            });
            try {
                // A violation that survives the retry is not a race any more,
                // and a conflict the caller can act on beats an endless loop.
                expect(await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW }))
                    .toEqual({ ok: false, reason: 'version-conflict' });
                expect(attempts).toBe(2);
            } finally {
                restore();
            }
        });

        it('does not swallow an unrelated database failure', async () => {
            const restore = replaceTransaction(() => Promise.reject(
                new Prisma.PrismaClientKnownRequestError('Timed out', {
                    code: 'P2024', clientVersion: Prisma.prismaVersion.client,
                }),
            ));
            try {
                await expect(syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW }))
                    .rejects.toMatchObject({ code: 'P2024' });
            } finally {
                restore();
            }
        });

        it('lets exactly one of two concurrent writers win at the same version', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            const [a, b] = await Promise.all([
                syncWorkspaceAuthority({ body: workspaceBody({ epoch: 2 }), expectedVersion: 1, now: NOW }),
                syncWorkspaceAuthority({ body: workspaceBody({ epoch: 3 }), expectedVersion: 1, now: NOW }),
            ]);
            expect([a, b].filter((r) => r.ok)).toHaveLength(1);
            const stored = await db.managedWorkspaceAuthority.findUniqueOrThrow({ where: { workspaceId } });
            expect(stored.version).toBe(2);
        });
    });

    describe('the recovery snapshot', () => {
        function snapshotInput(over: Record<string, unknown> = {}) {
            return {
                tenantId: 'tenant-1',
                projectId: 'project-1',
                workspaceId,
                runId,
                accountId: 'account-1',
                ...over,
            };
        }

        it('reports nothing before either projection exists', async () => {
            expect(await readAuthoritySnapshot(snapshotInput()))
                .toEqual({ ok: true, workspace: null, run: null });
        });

        it('reports a workspace that exists before its run', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            expect(await readAuthoritySnapshot(snapshotInput())).toEqual({
                ok: true,
                workspace: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1', version: 1,
                },
                run: null,
            });
        });

        it('returns both once they exist, at their current versions', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({
                body: runBody({ currentAttemptId: 'attempt-2' }), expectedVersion: 1, now: NOW,
            });
            expect(await readAuthoritySnapshot(snapshotInput())).toMatchObject({
                ok: true,
                workspace: { version: 1, epoch: 1 },
                run: { currentAttemptId: 'attempt-2', version: 2, cancelled: false },
            });
        });

        it.each([
            ['a workspace under another tenant', { tenantId: 'tenant-other' }, 'workspace-mismatch'],
            ['a workspace under another project', { projectId: 'project-other' }, 'workspace-mismatch'],
            ['a run in another workspace', { workspaceId: 'ws-other' }, 'run-workspace-mismatch'],
            ['a run owned by another account', { accountId: 'account-2' }, 'run-account-mismatch'],
        ])('refuses %s instead of reporting it missing', async (_label, over, reason) => {
            // Hiding a mismatch behind `null` would read as "create it".
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            expect(await readAuthoritySnapshot(snapshotInput(over))).toEqual({ ok: false, reason });
        });

        it('reads both projections from one snapshot while a writer commits between them', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });

            let workspaceWasRead!: () => void;
            const workspaceRead = new Promise<void>((resolve) => { workspaceWasRead = resolve; });
            let releaseRunQuery!: () => void;
            const runMayQuery = new Promise<void>((resolve) => { releaseRunQuery = resolve; });
            let armed = true;

            /**
             * Gates the reader's **second** query before it executes.
             *
             * Blocking after the run row had already been read would prove
             * nothing: it would have taken the old value either way. The point
             * is that the run query runs *after* another transaction committed
             * both rows, and still has to answer from the reader's snapshot.
             */
            function gate<T extends object>(client: T): T {
                return new Proxy(client, {
                    get(target, prop, receiver) {
                        const value = Reflect.get(target, prop, receiver);
                        if (prop !== 'managedWorkspaceAuthority' && prop !== 'managedRunAuthority') {
                            return value;
                        }
                        const isRun = prop === 'managedRunAuthority';
                        return new Proxy(value as object, {
                            get(model, key, modelReceiver) {
                                const inner = Reflect.get(model, key, modelReceiver);
                                if (key !== 'findUnique') return inner;
                                return async (...args: unknown[]) => {
                                    if (isRun) await runMayQuery;
                                    const result = await (inner as (...a: unknown[]) => Promise<unknown>)
                                        .apply(model, args);
                                    if (!isRun) workspaceWasRead();
                                    return result;
                                };
                            },
                        });
                    },
                });
            }

            const restore = replaceTransaction((original, ...args) => {
                const [fn, options] = args as unknown as [
                    (tx: unknown) => Promise<unknown>, unknown,
                ];
                if (!armed) return (original as (...a: never[]) => unknown)(...args);
                return (original as unknown as (
                    f: (tx: unknown) => Promise<unknown>, o: unknown,
                ) => Promise<unknown>)((tx) => fn(gate(tx as object)), options);
            });

            /**
             * The same gate on the client itself, so a version of the read that
             * skipped the transaction is still gated — and fails on the values
             * it returns rather than by hanging on a signal that never comes.
             */
            const restoreClient = (() => {
                const originals = ['managedWorkspaceAuthority', 'managedRunAuthority'] as const;
                const saved = originals.map((name) => [name, (db as never)[name]] as const);
                for (const [name, model] of saved) {
                    Object.defineProperty(db, name, {
                        configurable: true,
                        value: (gate({ [name]: model }) as never)[name],
                    });
                }
                return () => {
                    for (const [name, model] of saved) {
                        Object.defineProperty(db, name, { configurable: true, value: model });
                    }
                };
            })();

            let snapshot: Awaited<ReturnType<typeof readAuthoritySnapshot>>;
            try {
                const reading = readAuthoritySnapshot({
                    tenantId: 'tenant-1', projectId: 'project-1',
                    workspaceId, runId, accountId: 'account-1',
                });
                await workspaceRead;
                // Everything after this point must not be gated — the writer is
                // a different transaction and has to be able to commit.
                armed = false;
                // The writer must not be gated: it goes through the transaction
                // client, which is only wrapped while `armed`.
                restoreClient();

                // One transaction advancing **both** projections together.
                await db.$transaction(async (tx) => {
                    await tx.managedWorkspaceAuthority.update({
                        where: { workspaceId },
                        data: { epoch: 2, version: 2, updatedAt: BigInt(NOW) },
                    });
                    await tx.managedRunAuthority.update({
                        where: { runId },
                        data: { currentAttemptId: 'attempt-2', version: 2, updatedAt: BigInt(NOW) },
                    });
                });

                releaseRunQuery();
                snapshot = await reading;
            } finally {
                releaseRunQuery();
                restore();
                restoreClient();
            }

            // The committed pair the reader started from — never the old
            // workspace beside the new run.
            expect(snapshot).toMatchObject({
                ok: true,
                workspace: { version: 1, epoch: 1 },
                run: { version: 1, currentAttemptId: 'attempt-1' },
            });

            // The write really did land.
            expect(await readAuthoritySnapshot({
                tenantId: 'tenant-1', projectId: 'project-1',
                workspaceId, runId, accountId: 'account-1',
            })).toMatchObject({
                ok: true,
                workspace: { version: 2, epoch: 2 },
                run: { version: 2, currentAttemptId: 'attempt-2' },
            });
        }, 20_000);

        it('writes nothing', async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const before = await Promise.all([
                db.managedWorkspaceAuthority.findMany({ where: { workspaceId: { in: [...createdWorkspaceIds] } }, orderBy: { workspaceId: 'asc' } }),
                db.managedRunAuthority.findMany({ where: { runId: { in: [...createdRunIds] } }, orderBy: { runId: 'asc' } }),
            ]);
            await readAuthoritySnapshot(snapshotInput());
            expect(await Promise.all([
                db.managedWorkspaceAuthority.findMany({ where: { workspaceId: { in: [...createdWorkspaceIds] } }, orderBy: { workspaceId: 'asc' } }),
                db.managedRunAuthority.findMany({ where: { runId: { in: [...createdRunIds] } }, orderBy: { runId: 'asc' } }),
            ])).toEqual(before);
        });
    });

    describe('run authority', () => {
        beforeEach(async () => {
            await syncWorkspaceAuthority({ body: workspaceBody(), expectedVersion: 0, now: NOW });
        });

        it('creates at version 1 and reads back through the workspace', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            expect(await readRunScopeAuthority(runId)).toMatchObject({
                runId,
                accountId: 'account-1',
                currentAttemptId: 'attempt-1',
                cancelled: false,
                epoch: 1,
                tenantId: 'tenant-1',
            });
        });

        it('refuses a run naming a workspace this server has not been told about', async () => {
            expect(await syncRunAuthority({
                body: runBody({ workspaceId: newWorkspaceId() }), expectedVersion: 0, now: NOW,
            })).toEqual({ ok: false, reason: 'workspace-missing' });
        });

        it('advances the attempt independently of the workspace version', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const advanced = await syncRunAuthority({
                body: runBody({ currentAttemptId: 'attempt-2' }), expectedVersion: 1, now: NOW,
            });
            expect(advanced).toMatchObject({ ok: true, version: 2 });
            // The workspace did not move because a run advanced.
            expect(await readRunScopeAuthority(runId))
                .toMatchObject({ runVersion: 2, workspaceVersion: 1 });
        });

        it('pins the account per run, not per workspace', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const otherRun = newRunId();
            await syncRunAuthority({
                body: { ...runBody(), runId: otherRun, accountId: 'account-2' },
                expectedVersion: 0,
                now: NOW,
            });
            // The same project legitimately runs under a different account.
            expect((await readRunScopeAuthority(runId))?.accountId).toBe('account-1');
            expect((await readRunScopeAuthority(otherRun))?.accountId).toBe('account-2');
        });

        it('refuses to move a run to another account', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            expect(await syncRunAuthority({
                body: runBody({ accountId: 'account-2' }), expectedVersion: 1, now: NOW,
            })).toEqual({ ok: false, reason: 'immutable-binding-changed' });
            // Refused, and not half-applied: a live grant must not keep working
            // while the actor behind it changed.
            expect((await readRunScopeAuthority(runId))?.accountId).toBe('account-1');
        });

        it('treats cancellation as terminal in both directions', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            await syncRunAuthority({ body: runBody({ cancelled: true }), expectedVersion: 1, now: NOW });

            expect(await syncRunAuthority({
                body: runBody({ cancelled: false }), expectedVersion: 2, now: NOW,
            })).toEqual({ ok: false, reason: 'run-cancelled' });
            expect(await syncRunAuthority({
                body: runBody({ currentAttemptId: 'attempt-9' }), expectedVersion: 2, now: NOW,
            })).toEqual({ ok: false, reason: 'run-cancelled' });
        });

        it('returns the stored row for an exact retry', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const body = runBody({ currentAttemptId: 'attempt-2' });
            await syncRunAuthority({ body, expectedVersion: 1, now: NOW });
            expect(await syncRunAuthority({ body, expectedVersion: 1, now: NOW }))
                .toMatchObject({ ok: true, version: 2, idempotent: true });
        });

        it('does not turn a concurrent first insert of the same run into an error', async () => {
            const body = runBody();
            const [a, b] = await Promise.all([
                syncRunAuthority({ body, expectedVersion: 0, now: NOW }),
                syncRunAuthority({ body, expectedVersion: 0, now: NOW }),
            ]);
            expect(a).toMatchObject({ ok: true, version: 1 });
            expect(b).toMatchObject({ ok: true, version: 1 });
            expect([a, b].filter((r) => r.ok && r.idempotent)).toHaveLength(1);
        });

        it('lets exactly one of two concurrent attempt advances win', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const [a, b] = await Promise.all([
                syncRunAuthority({ body: runBody({ currentAttemptId: 'attempt-2' }), expectedVersion: 1, now: NOW }),
                syncRunAuthority({ body: runBody({ currentAttemptId: 'attempt-3' }), expectedVersion: 1, now: NOW }),
            ]);
            expect([a, b].filter((r) => r.ok)).toHaveLength(1);
            const stored = await db.managedRunAuthority.findUniqueOrThrow({ where: { runId } });
            expect(stored.version).toBe(2);
            expect(['attempt-2', 'attempt-3']).toContain(stored.currentAttemptId);
        });

        it('does not let a cancellation racing an advance leave the run un-cancelled', async () => {
            await syncRunAuthority({ body: runBody(), expectedVersion: 0, now: NOW });
            const [cancel, advance] = await Promise.all([
                syncRunAuthority({ body: runBody({ cancelled: true }), expectedVersion: 1, now: NOW }),
                syncRunAuthority({ body: runBody({ currentAttemptId: 'attempt-2' }), expectedVersion: 1, now: NOW }),
            ]);
            expect([cancel, advance].filter((r) => r.ok)).toHaveLength(1);
            const stored = await db.managedRunAuthority.findUniqueOrThrow({ where: { runId } });
            if (cancel.ok) {
                // Whichever won, a run recorded as cancelled stays cancelled.
                expect(stored.cancelledAt).not.toBeNull();
                expect(await syncRunAuthority({
                    body: runBody({ currentAttemptId: 'attempt-3' }), expectedVersion: 2, now: NOW,
                })).toEqual({ ok: false, reason: 'run-cancelled' });
            } else {
                expect(stored.currentAttemptId).toBe('attempt-2');
            }
        });
    });
});
