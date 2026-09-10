/**
 * The durable identity a managed Cloud daemon runs on.
 *
 * ## Why a row and not just a token
 *
 * A credential nobody can name is a credential nobody can withdraw. Purpose
 * separation — a daemon token cannot be presented as a session bearer — is the
 * signature's job and is already done. Revocation is not: "it expires
 * eventually" is not a way to stop one that has leaked, so the token names
 * this row and every check reads it.
 *
 * ## Generations
 *
 * A renewal supersedes the credential in place and moves the generation. A
 * token minted before it still verifies as a signature — nothing can un-sign
 * it — so the generation is what makes it unusable, on the next check rather
 * than at the end of a lifetime nobody chose.
 *
 * ## Separate from key custody
 *
 * This answers whether a daemon may still act. The Machine's wrapped key
 * answers what it can read. Revoking one does not silently invalidate the
 * other, and collapsing them would make a key rotation look like a withdrawal.
 */
import { createHash } from 'node:crypto';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002';

/** The subset of the client both a transaction and the root client provide. */
type TransactionClient = {
    managedDaemonGrant: typeof db.managedDaemonGrant;
};

/**
 * What the resolve path reads. The grant, the projection and the Machine are
 * three tables and one decision, so a caller that mints against them reads
 * them in a single snapshot.
 */
type SnapshotClient = TransactionClient & {
    managedWorkspaceAuthority: typeof db.managedWorkspaceAuthority;
    machine: typeof db.machine;
};

export type ManagedDaemonScope = {
    accountId: string;
    machineId: string;
    runtimeId: string;
    provisioningOperationId: string;
    workspaceId: string;
    projectId: string;
    epoch: number;
};

export type ManagedDaemonGrantRow = ManagedDaemonScope & {
    daemonGrantId: string;
    generation: number;
    expiresAt: bigint;
    revokedAt: bigint | null;
    requestId: string;
    renewalRequestId: string | null;
};

export type IssueResult =
    | { ok: true; grant: ManagedDaemonGrantRow; idempotent: boolean }
    | { ok: false; reason: 'request-body-changed' | 'runtime-grant-exists' };

export type RenewResult =
    | { ok: true; grant: ManagedDaemonGrantRow; idempotent: boolean }
    | { ok: false; reason: 'unknown-grant' | 'generation-conflict' | 'revoked' | 'request-body-changed' };

export type RevokeResult =
    | { ok: true }
    | { ok: false; reason: 'unknown-grant' };

export type ResolveResult =
    | { ok: true; grant: ManagedDaemonGrantRow }
    | {
        ok: false;
        reason: 'unknown-grant' | 'revoked' | 'expired' | 'stale-generation'
            | 'scope-mismatch' | 'stale-epoch' | 'machine-not-owned' | 'workspace-unknown';
    };

/** The request body, hashed, so an exact retry is told from a different one. */
function bodyDigest(input: {
    scope: ManagedDaemonScope;
    daemonGrantId: string;
    expiresAt: number;
}): string {
    return createHash('sha256').update(JSON.stringify([
        input.daemonGrantId,
        input.scope.accountId,
        input.scope.machineId,
        input.scope.runtimeId,
        input.scope.provisioningOperationId,
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.epoch,
        input.expiresAt,
    ])).digest('hex');
}

function toRow(record: {
    daemonGrantId: string; accountId: string; machineId: string; runtimeId: string;
    provisioningOperationId: string; workspaceId: string; projectId: string;
    epoch: number; generation: number; expiresAt: bigint; revokedAt: bigint | null;
    requestId: string; renewalRequestId: string | null;
}): ManagedDaemonGrantRow {
    return {
        daemonGrantId: record.daemonGrantId,
        accountId: record.accountId,
        machineId: record.machineId,
        runtimeId: record.runtimeId,
        provisioningOperationId: record.provisioningOperationId,
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        epoch: record.epoch,
        generation: record.generation,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt,
        requestId: record.requestId,
        renewalRequestId: record.renewalRequestId,
    };
}

export async function issueManagedDaemonGrant(input: {
    scope: ManagedDaemonScope;
    daemonGrantId: string;
    requestId: string;
    /** Chosen by the caller. This module never picks a lifetime. */
    expiresAt: number;
    now: number;
    /**
     * An outer transaction to join.
     *
     * The caller may have written rows this issue must commit or abandon
     * with — a Machine created for a grant that then fails to issue is a
     * machine nobody asked for.
     */
    tx?: TransactionClient;
}): Promise<IssueResult> {
    // Inside a caller's transaction the retry cannot happen here. The unique
    // violation has already aborted that transaction, so every further
    // statement in it fails with "current transaction is aborted" — the
    // caller would receive that instead of the P2002 it recognises, and could
    // no longer tell a convergence race from a database fault. The
    // transaction belongs to the caller, so the recovery does too: it retries
    // the whole thing, which re-reads the authority, the Machine and the key
    // material rather than patching up around a failure it cannot see.
    if (input.tx) return issueManagedDaemonGrantOnce(input);

    // Standalone, this owns the transaction and can recover in place. Two
    // replicas can both find no row and both insert; `inTx` retries
    // serialization failures (P2034) and not unique violations, so the loser
    // is caught here and re-read *outside* its failed transaction.
    for (let remaining = 1; ; remaining--) {
        try {
            return await issueManagedDaemonGrantOnce(input);
        } catch (error) {
            if ((error as { code?: string }).code !== UNIQUE_VIOLATION || remaining === 0) throw error;
        }
    }
}

async function issueManagedDaemonGrantOnce(input: {
    scope: ManagedDaemonScope;
    daemonGrantId: string;
    requestId: string;
    expiresAt: number;
    now: number;
    tx?: TransactionClient;
}): Promise<IssueResult> {
    const digest = bodyDigest(input);
    const run = async (tx: TransactionClient): Promise<IssueResult> => {
        const existing = await tx.managedDaemonGrant.findUnique({
            where: { requestId: input.requestId },
        });
        if (existing) {
            // The control plane retries. A second row would be a second
            // credential that also looks current, so an exact retry returns
            // what it already produced and a changed body is refused.
            if (existing.bodyDigest !== digest) {
                return { ok: false, reason: 'request-body-changed' as const };
            }
            return { ok: true, grant: toRow(existing), idempotent: true };
        }

        // A different request naming a runtime generation that already has a
        // grant is a question with an answer, not a database error: this
        // generation already has its credential.
        const forRuntime = await tx.managedDaemonGrant.findUnique({
            where: {
                runtimeId_provisioningOperationId: {
                    runtimeId: input.scope.runtimeId,
                    provisioningOperationId: input.scope.provisioningOperationId,
                },
            },
        });
        if (forRuntime) {
            return forRuntime.bodyDigest === digest
                // Same body under a new request id: the caller asked for what
                // already exists, so it gets it rather than a refusal.
                ? { ok: true, grant: toRow(forRuntime), idempotent: true }
                : { ok: false, reason: 'runtime-grant-exists' as const };
        }

        const created = await tx.managedDaemonGrant.create({
            data: {
                daemonGrantId: input.daemonGrantId,
                accountId: input.scope.accountId,
                machineId: input.scope.machineId,
                runtimeId: input.scope.runtimeId,
                provisioningOperationId: input.scope.provisioningOperationId,
                workspaceId: input.scope.workspaceId,
                projectId: input.scope.projectId,
                epoch: input.scope.epoch,
                generation: 0,
                expiresAt: BigInt(input.expiresAt),
                requestId: input.requestId,
                bodyDigest: digest,
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true, grant: toRow(created), idempotent: false };
    };
    return input.tx ? run(input.tx) : inTx(run);
}

export async function renewManagedDaemonGrant(input: {
    daemonGrantId: string;
    /** The generation the caller believes is current. */
    expectedGeneration: number;
    expiresAt: number;
    requestId: string;
    now: number;
    /**
     * An outer transaction to join.
     *
     * A caller that has already compared the projection, the Machine's owner
     * and the row's scope needs those comparisons and this write to be one
     * decision. Read in a transaction of their own, they are a snapshot that a
     * promotion or an ownership change can invalidate before the renewal
     * lands — and a renewal that extends a credential for a generation that
     * has since been fenced keeps alive exactly what the fence cut off.
     */
    tx?: TransactionClient;
}): Promise<RenewResult> {
    const digest = createHash('sha256').update(JSON.stringify([
        input.daemonGrantId, input.expectedGeneration, input.expiresAt,
    ])).digest('hex');

    const run = async (tx: TransactionClient): Promise<RenewResult> => {
        const existing = await tx.managedDaemonGrant.findUnique({
            where: { daemonGrantId: input.daemonGrantId },
        });
        if (!existing) return { ok: false, reason: 'unknown-grant' as const };
        // A revoked grant is never revived. A renewal that resurrected one
        // would undo a withdrawal by retrying it.
        if (existing.revokedAt !== null) return { ok: false, reason: 'revoked' as const };

        // The renewal has its own request identity, on its own column: writing
        // it over the issue's would leave the row describing one request with
        // the digest of another, and the original issue retry would then miss
        // its row and collide on the unique index.
        if (existing.renewalRequestId === input.requestId) {
            return existing.renewalBodyDigest === digest
                // The response was lost and the same request came back. It
                // converges on what it already did rather than advancing again.
                ? { ok: true, grant: toRow(existing), idempotent: true }
                : { ok: false, reason: 'request-body-changed' as const };
        }

        // Compare-and-set on the generation: two control-plane replicas
        // renewing the same grant must not both succeed, and the loser must
        // not walk the generation backwards.
        const updated = await tx.managedDaemonGrant.updateMany({
            where: {
                daemonGrantId: input.daemonGrantId,
                generation: input.expectedGeneration,
                revokedAt: null,
            },
            data: {
                generation: input.expectedGeneration + 1,
                expiresAt: BigInt(input.expiresAt),
                renewalRequestId: input.requestId,
                renewalBodyDigest: digest,
                updatedAt: BigInt(input.now),
            },
        });
        if (updated.count !== 1) return { ok: false, reason: 'generation-conflict' as const };

        const reread = await tx.managedDaemonGrant.findUnique({
            where: { daemonGrantId: input.daemonGrantId },
        });
        if (!reread) return { ok: false, reason: 'unknown-grant' as const };
        return { ok: true, grant: toRow(reread), idempotent: false };
    };
    return input.tx ? run(input.tx) : inTx(run);
}

export async function revokeManagedDaemonGrant(input: {
    daemonGrantId: string;
    /** Reason code only — never provider text or request content. */
    reason: string;
    now: number;
}): Promise<RevokeResult> {
    const updated = await db.managedDaemonGrant.updateMany({
        where: { daemonGrantId: input.daemonGrantId, revokedAt: null },
        data: { revokedAt: BigInt(input.now), revokedReason: input.reason, updatedAt: BigInt(input.now) },
    });
    if (updated.count === 1) return { ok: true };
    const exists = await db.managedDaemonGrant.findUnique({
        where: { daemonGrantId: input.daemonGrantId },
    });
    // Already revoked is the outcome the caller asked for.
    return exists ? { ok: true } : { ok: false, reason: 'unknown-grant' };
}

/**
 * Decides whether a credential naming this grant may still act.
 *
 * Read on every check rather than at issue time: a withdrawal has to take
 * effect without waiting for a token to expire, and a renewal has to make the
 * credential minted before it unusable even though its signature is still
 * valid.
 */
export async function resolveManagedDaemonGrant(input: {
    daemonGrantId: string;
    generation: number;
    /**
     * A snapshot to read in.
     *
     * The row, the projection and the Machine are three reads, and this
     * function hands out nothing but decides whether a credential may be.
     * Callers that mint pass one to avoid combining different committed states.
     * A snapshot does not authorize later use after a fence; consumers must
     * continue checking the live grant and authority.
     */
    tx?: SnapshotClient;
    /**
     * Everything the credential asserts, compared against the row.
     *
     * The row is the authority and the token only names it — so a token whose
     * signature is valid but whose scope disagrees is a token for something
     * else, and matching the id and generation alone would admit it.
     */
    claims: ManagedDaemonScope;
    now: number;
}): Promise<ResolveResult> {
    const reader: SnapshotClient = input.tx ?? db;
    const existing = await reader.managedDaemonGrant.findUnique({
        where: { daemonGrantId: input.daemonGrantId },
    });
    if (!existing) return { ok: false, reason: 'unknown-grant' };
    if (existing.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (BigInt(input.now) >= existing.expiresAt) return { ok: false, reason: 'expired' };
    // A renewal supersedes the credential in place. Nothing can un-sign the one
    // minted before it, so this is what makes it unusable.
    if (existing.generation !== input.generation) return { ok: false, reason: 'stale-generation' };

    const row = toRow(existing);
    const claims = input.claims;
    if (
        row.accountId !== claims.accountId
        || row.machineId !== claims.machineId
        || row.runtimeId !== claims.runtimeId
        || row.provisioningOperationId !== claims.provisioningOperationId
        || row.workspaceId !== claims.workspaceId
        || row.projectId !== claims.projectId
        || row.epoch !== claims.epoch
    ) {
        return { ok: false, reason: 'scope-mismatch' };
    }

    // Read here rather than taken as an argument: the fencing axis is what the
    // control plane recorded, and a check satisfied by a number the caller
    // passed in is a check the caller performs on itself.
    const authority = await reader.managedWorkspaceAuthority.findUnique({
        where: { workspaceId: row.workspaceId },
    });
    if (!authority) return { ok: false, reason: 'workspace-unknown' };
    // Exact, on every axis. "Not lower" would admit a credential for an epoch
    // the control plane has not reached, and a projection naming a different
    // runtime or project is a projection about something else.
    if (authority.epoch !== row.epoch
        || authority.runtimeId !== row.runtimeId
        || authority.projectId !== row.projectId) {
        return { ok: false, reason: 'stale-epoch' };
    }

    // The Machine really has to be the account's. Every id in the token can
    // line up with its own row while naming a machine that belongs to somebody
    // else, and that is the case this closes.
    const machine = await reader.machine.findUnique({ where: { id: row.machineId } });
    if (!machine || machine.accountId !== row.accountId) {
        return { ok: false, reason: 'machine-not-owned' };
    }

    return { ok: true, grant: row };
}
