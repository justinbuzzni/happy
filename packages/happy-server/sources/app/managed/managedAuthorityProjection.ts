/**
 * The control plane's authority, projected into rows this server can enforce.
 *
 * Happy has no run lifecycle of its own. The control plane owns it and syncs
 * the parts every scoped action must be checked against: which runtime
 * generation a workspace is on, which attempt a run is currently allowed to
 * use, and whether that run has been cancelled for good.
 *
 * Two versions, not one. A workspace change (epoch, runtime) and a run change
 * (attempt, cancellation) move independently, so a single counter would let
 * either kind of staleness pass as fresh. Each is a monotonic CAS token the
 * caller must present as `expectedVersion`.
 *
 * Retries are exact-body idempotent: the same request at the same version
 * returns the stored row, while a *different* body at that version is a
 * conflict. Silently accepting the second would let two control-plane replicas
 * disagree about what the current authority says.
 */

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { canonicalDigest } from '@/app/managed/canonicalDigest';

/**
 * Re-runs an attempt when a concurrent writer won the insert.
 *
 * Verified against PostgreSQL: a unique violation raised inside a transaction
 * aborts it, so the losing writer cannot read the winner's row from within the
 * same transaction — every statement after it fails. Catching P2002 next to the
 * `create` therefore does not work, and surfacing it would turn the loser of an
 * identical concurrent create into a 500, breaking the idempotency contract the
 * control plane retries against.
 *
 * So the retry happens one level up, in a fresh transaction. By then the
 * winner's row is visible and the ordinary exact-retry comparison decides the
 * outcome. The bound exists because a second violation would mean something
 * other than a race, and a fail-closed conflict beats spinning.
 */
async function withConcurrentInsertRetry<T>(
    attempt: () => Promise<AuthoritySyncResult<T>>,
): Promise<AuthoritySyncResult<T>> {
    for (let remaining = 1; ; remaining--) {
        try {
            return await attempt();
        } catch (error) {
            if ((error as { code?: string }).code !== UNIQUE_VIOLATION || remaining === 0) {
                if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
                    return { ok: false, reason: 'version-conflict' };
                }
                throw error;
            }
        }
    }
}

const UNIQUE_VIOLATION = 'P2002';

export type WorkspaceAuthorityBody = {
    workspaceId: string;
    tenantId: string;
    projectId: string;
    epoch: number;
    runtimeId: string;
};

export type RunAuthorityBody = {
    runId: string;
    workspaceId: string;
    accountId: string;
    currentAttemptId: string;
    cancelled: boolean;
};

export type AuthoritySyncFailure =
    | 'version-conflict'
    | 'body-conflict'
    | 'immutable-binding-changed'
    | 'epoch-regression'
    | 'run-cancelled'
    | 'workspace-missing'
    | 'runtime-change-without-epoch';

export type AuthoritySyncResult<T> =
    | { ok: true; version: number; row: T; idempotent: boolean }
    | { ok: false; reason: AuthoritySyncFailure };

/**
 * Applies a workspace projection update under compare-and-set.
 *
 * The ownership binding is immutable: a workspace that changed tenant or
 * project would silently move every grant issued under it into a different
 * blast radius, so that is refused rather than versioned. The epoch may only
 * advance — accepting a lower one would revive grants a fence already excluded.
 */
export async function syncWorkspaceAuthority(input: {
    body: WorkspaceAuthorityBody;
    expectedVersion: number;
    now: number;
}): Promise<AuthoritySyncResult<{ workspaceId: string; epoch: number }>> {
    const digest = canonicalDigest(input.body);

    return withConcurrentInsertRetry(() => inTx(async (tx) => {
        const existing = await tx.managedWorkspaceAuthority.findUnique({
            where: { workspaceId: input.body.workspaceId },
        });

        if (!existing) {
            if (input.expectedVersion !== 0) return { ok: false, reason: 'version-conflict' };
            // A concurrent identical create surfaces as P2002 and aborts this
            // transaction; `withConcurrentInsertRetry` re-reads in a fresh one.
            const created = await tx.managedWorkspaceAuthority.create({
                data: {
                    workspaceId: input.body.workspaceId,
                    tenantId: input.body.tenantId,
                    projectId: input.body.projectId,
                    epoch: input.body.epoch,
                    runtimeId: input.body.runtimeId,
                    version: 1,
                    bodyDigest: digest,
                    createdAt: BigInt(input.now),
                    updatedAt: BigInt(input.now),
                },
            });
            return {
                ok: true,
                version: created.version,
                row: { workspaceId: created.workspaceId, epoch: created.epoch },
                idempotent: false,
            };
        }

        // A retry of the update that produced the current state.
        if (existing.version === input.expectedVersion + 1 && existing.bodyDigest === digest) {
            return {
                ok: true,
                version: existing.version,
                row: { workspaceId: existing.workspaceId, epoch: existing.epoch },
                idempotent: true,
            };
        }
        if (existing.version !== input.expectedVersion) {
            return { ok: false, reason: 'version-conflict' };
        }
        if (existing.tenantId !== input.body.tenantId || existing.projectId !== input.body.projectId) {
            return { ok: false, reason: 'immutable-binding-changed' };
        }
        if (input.body.epoch < existing.epoch) {
            return { ok: false, reason: 'epoch-regression' };
        }
        // A runtime swap is a new generation by definition. Allowing one at the
        // same epoch would leave grants minted for the old runtime passing the
        // epoch check while pointing at a runtime that no longer exists.
        if (input.body.runtimeId !== existing.runtimeId && input.body.epoch === existing.epoch) {
            return { ok: false, reason: 'runtime-change-without-epoch' };
        }

        const updated = await tx.managedWorkspaceAuthority.updateMany({
            where: { workspaceId: input.body.workspaceId, version: input.expectedVersion },
            data: {
                epoch: input.body.epoch,
                runtimeId: input.body.runtimeId,
                version: { increment: 1 },
                bodyDigest: digest,
                updatedAt: BigInt(input.now),
            },
        });
        // Another writer committed between the read and the write.
        if (updated.count !== 1) return { ok: false, reason: 'version-conflict' };

        return {
            ok: true,
            version: input.expectedVersion + 1,
            row: { workspaceId: input.body.workspaceId, epoch: input.body.epoch },
            idempotent: false,
        };
    }));
}

/**
 * Applies a run projection update under compare-and-set.
 *
 * Cancellation is terminal: once recorded, no later sync may un-cancel the run
 * or move it to another attempt. That is what makes "a cancelled run cannot be
 * resurrected under a new grant id" enforceable here rather than a convention
 * the mint path is trusted to remember.
 */
export async function syncRunAuthority(input: {
    body: RunAuthorityBody;
    expectedVersion: number;
    now: number;
}): Promise<AuthoritySyncResult<{ runId: string; currentAttemptId: string; cancelled: boolean }>> {
    const digest = canonicalDigest(input.body);

    return withConcurrentInsertRetry(() => inTx(async (tx) => {
        const workspace = await tx.managedWorkspaceAuthority.findUnique({
            where: { workspaceId: input.body.workspaceId },
            select: { workspaceId: true },
        });
        // A run may not name a workspace this server has never been told about:
        // there would be no epoch to check its grants against.
        if (!workspace) return { ok: false, reason: 'workspace-missing' };

        const existing = await tx.managedRunAuthority.findUnique({
            where: { runId: input.body.runId },
        });

        if (!existing) {
            if (input.expectedVersion !== 0) return { ok: false, reason: 'version-conflict' };
            const created = await tx.managedRunAuthority.create({
                data: {
                    runId: input.body.runId,
                    workspaceId: input.body.workspaceId,
                    accountId: input.body.accountId,
                    currentAttemptId: input.body.currentAttemptId,
                    cancelledAt: input.body.cancelled ? BigInt(input.now) : null,
                    version: 1,
                    bodyDigest: digest,
                    createdAt: BigInt(input.now),
                    updatedAt: BigInt(input.now),
                },
            });
            return {
                ok: true,
                version: created.version,
                row: {
                    runId: created.runId,
                    currentAttemptId: created.currentAttemptId,
                    cancelled: created.cancelledAt !== null,
                },
                idempotent: false,
            };
        }

        if (existing.version === input.expectedVersion + 1 && existing.bodyDigest === digest) {
            return {
                ok: true,
                version: existing.version,
                row: {
                    runId: existing.runId,
                    currentAttemptId: existing.currentAttemptId,
                    cancelled: existing.cancelledAt !== null,
                },
                idempotent: true,
            };
        }
        if (existing.version !== input.expectedVersion) {
            return { ok: false, reason: 'version-conflict' };
        }
        if (existing.workspaceId !== input.body.workspaceId) {
            return { ok: false, reason: 'immutable-binding-changed' };
        }
        // The account a run acts as is fixed for that run's lifetime. Moving it
        // would let a live grant keep working while the actor behind it changed.
        if (existing.accountId !== input.body.accountId) {
            return { ok: false, reason: 'immutable-binding-changed' };
        }
        // Terminal means terminal, in both directions: neither a new attempt
        // nor an un-cancel is accepted afterwards.
        if (existing.cancelledAt !== null) return { ok: false, reason: 'run-cancelled' };

        const updated = await tx.managedRunAuthority.updateMany({
            where: { runId: input.body.runId, version: input.expectedVersion, cancelledAt: null },
            data: {
                // accountId is deliberately absent: it is pinned at creation.
                currentAttemptId: input.body.currentAttemptId,
                cancelledAt: input.body.cancelled ? BigInt(input.now) : null,
                version: { increment: 1 },
                bodyDigest: digest,
                updatedAt: BigInt(input.now),
            },
        });
        if (updated.count !== 1) return { ok: false, reason: 'version-conflict' };

        return {
            ok: true,
            version: input.expectedVersion + 1,
            row: {
                runId: input.body.runId,
                currentAttemptId: input.body.currentAttemptId,
                cancelled: input.body.cancelled,
            },
            idempotent: false,
        };
    }));
}

/** Current authority for one run, as the grant checks need it. */
export async function readRunScopeAuthority(runId: string) {
    const run = await db.managedRunAuthority.findUnique({
        where: { runId },
        include: { workspace: true },
    });
    if (!run) return null;
    return {
        runId: run.runId,
        accountId: run.accountId,
        currentAttemptId: run.currentAttemptId,
        cancelled: run.cancelledAt !== null,
        runVersion: run.version,
        workspaceId: run.workspaceId,
        tenantId: run.workspace.tenantId,
        projectId: run.workspace.projectId,
        epoch: run.workspace.epoch,
        runtimeId: run.workspace.runtimeId,
        workspaceVersion: run.workspace.version,
    };
}

export type AuthoritySnapshotWorkspace = {
    workspaceId: string;
    tenantId: string;
    projectId: string;
    epoch: number;
    runtimeId: string;
    version: number;
};

export type AuthoritySnapshotRun = {
    runId: string;
    workspaceId: string;
    accountId: string;
    currentAttemptId: string;
    cancelled: boolean;
    version: number;
};

export type AuthoritySnapshotMismatch =
    | 'workspace-mismatch'
    | 'run-workspace-mismatch'
    | 'run-account-mismatch';

export type AuthoritySnapshotResult =
    | {
        ok: true;
        workspace: AuthoritySnapshotWorkspace | null;
        run: AuthoritySnapshotRun | null;
    }
    | { ok: false; reason: AuthoritySnapshotMismatch };

/**
 * Both projections as one consistent read, for a control plane recovering the
 * body it has to sign next.
 *
 * `null` means "this server has no such row", and it is the only thing that may
 * be read as an invitation to create one. A row that exists but disagrees with
 * the caller's ids is **not** reported as missing: hiding a mismatch behind
 * `null` would turn "you are looking at someone else's workspace" into "go
 * ahead and sync it". For the same reason a missing run says nothing about who
 * may run it — the caller still has to pass every other check to act.
 */
export async function readAuthoritySnapshot(input: {
    tenantId: string;
    projectId: string;
    workspaceId: string;
    runId: string;
    accountId: string;
}): Promise<AuthoritySnapshotResult> {
    return inTx(async (tx) => {
        const [workspace, run] = await Promise.all([
            tx.managedWorkspaceAuthority.findUnique({
                where: { workspaceId: input.workspaceId },
            }),
            tx.managedRunAuthority.findUnique({ where: { runId: input.runId } }),
        ]);

        if (workspace && (workspace.tenantId !== input.tenantId
            || workspace.projectId !== input.projectId)) {
            return { ok: false, reason: 'workspace-mismatch' };
        }
        if (run && run.workspaceId !== input.workspaceId) {
            return { ok: false, reason: 'run-workspace-mismatch' };
        }
        if (run && run.accountId !== input.accountId) {
            return { ok: false, reason: 'run-account-mismatch' };
        }

        return {
            ok: true,
            workspace: workspace
                ? {
                    workspaceId: workspace.workspaceId,
                    tenantId: workspace.tenantId,
                    projectId: workspace.projectId,
                    epoch: workspace.epoch,
                    runtimeId: workspace.runtimeId,
                    version: workspace.version,
                }
                : null,
            run: run
                ? {
                    runId: run.runId,
                    workspaceId: run.workspaceId,
                    accountId: run.accountId,
                    currentAttemptId: run.currentAttemptId,
                    cancelled: run.cancelledAt !== null,
                    version: run.version,
                }
                : null,
        };
    });
}
