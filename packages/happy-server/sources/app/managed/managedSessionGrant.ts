/**
 * The grants a managed child acts under, and the check every action makes.
 *
 * A scoped token carries a claim; this row decides whether the claim is still
 * true. The two are separate because a token cannot be recalled once handed
 * out, so the authority to act has to live somewhere the control plane can
 * withdraw it.
 *
 * Three rules this module owns — not the routes that call it:
 *
 *  - **The caller never supplies scope this server could look up, and never
 *    collects more than it asked for.** A mint presents the complete scope it
 *    signed and every field is compared exactly against the projection.
 *    Filling a missing field from the current row is what would let a delayed
 *    assertion, signed against epoch 3, be promoted to whatever the workspace
 *    happens to be now — and the same applies to time: a replayed mint is
 *    answered with the expiry it signed, not the one a later renewal wrote.
 *  - **A family is derived, not named.** It is the canonical digest of the
 *    scope's identity, so the same run, attempt and session always resolve to
 *    the same family. A caller that could choose the string could route around
 *    a revoke by picking a new one.
 *  - **Freshness is re-derived, never remembered.** Every action re-reads the
 *    authority projection and the session's owner in one consistent read. A
 *    grant minted against epoch 3 stops working when the workspace reaches
 *    epoch 4, without anyone walking the grant table to find it. A renewal
 *    extends such a grant only while it is still current; a stale one has to be
 *    re-minted rather than promoted.
 */

import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import {
    SESSION_SCOPED_PURPOSES,
    type SessionScopedPurpose,
} from '@/app/auth/sessionScopedToken';
import { canonicalDigest } from '@/app/managed/canonicalDigest';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

const UNIQUE_VIOLATION = 'P2002';

/**
 * Raised when a compare-and-set matched nothing.
 *
 * Not a failure to report: the row moved, and the answer is whatever it moved
 * to. Reading that inside the same transaction would only re-read the snapshot
 * this one started with, so the attempt is repeated in a fresh one.
 */
class ConcurrentGrantChange extends Error {}
const FOREIGN_KEY_VIOLATION = 'P2003';

/**
 * The complete scope a control-plane assertion signs.
 *
 * Every field is compared; none is defaulted. A shape that let a field be
 * omitted would make "the control plane did not say" indistinguishable from
 * "the control plane agreed with the current row".
 */
export type ManagedScope = {
    tenantId: string;
    projectId: string;
    workspaceId: string;
    runtimeId: string;
    epoch: number;
    runId: string;
    attemptId: string;
    sessionId: string;
    accountId: string;
    workspaceAuthorityVersion: number;
    runAuthorityVersion: number;
};

/**
 * The family a scope belongs to.
 *
 * Identity only: the versions and epoch are deliberately excluded, because a
 * grant that goes stale is caught by the freshness check rather than by landing
 * in a different family. Including them would give a caller a new family for
 * every version bump — the revoke bypass this derivation exists to close.
 */
export function deriveGrantFamily(
    scope: ManagedScope,
    /**
     * Part of the family, so two purposes for one scope are two grants.
     *
     * Without this a read grant and the runner's grant would be the same
     * family: minting one would either be refused as "family-exists" or replace
     * the other, which is the run losing its own credential because somebody
     * opened a transcript.
     *
     * `runner` contributes nothing to the digest, deliberately: every grant
     * that exists today is a runner grant, and changing their family value
     * would orphan every stored row from the derivation that finds it.
     */
    purpose: SessionScopedPurpose = 'runner',
    /**
     * Who holds this grant, when that is not the run itself.
     *
     * Two people approving on one run are two grants: revoking one must not end
     * the other, and each carries its own resealed key envelope. Absent for a
     * runner, which has no viewer.
     */
    viewerAccountId?: string,
    /**
     * The generation of the parent's access list this grant belongs to.
     *
     * The same axis the transcript side uses, for the same reason and now on
     * the same key: a withdrawal tombstones a family, and without a generation
     * that tombstone is the last word. On the transcript side that meant a
     * re-added member could never be issued anything again. Here it is sharper,
     * because an approval family also carries the run: a member removed and
     * re-added **during the same run** would find the same family, tombstoned,
     * and could never approve on the run they were just given access to.
     *
     * Absent on a runner, which has no viewer and no access list.
     */
    aclRevision?: number,
): string {
    if (purpose !== 'runner') {
        return canonicalDigest({
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
            runId: scope.runId,
            attemptId: scope.attemptId,
            sessionId: scope.sessionId,
            accountId: scope.accountId,
            purpose,
            viewerAccountId: viewerAccountId ?? null,
            aclRevision: aclRevision ?? null,
        });
    }
    return canonicalDigest({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        sessionId: scope.sessionId,
        accountId: scope.accountId,
    });
}

export type ScopeMismatch =
    | 'run-unknown'
    | 'run-cancelled'
    | 'authority-stale'
    | 'account-mismatch'
    | 'attempt-mismatch'
    | 'binding-mismatch';

/**
 * Postgres `INTEGER`. The sequence is compared and incremented, never wrapped:
 * a counter that rolled over would make an old signature match again.
 */
const MAX_RENEWAL_SEQ = 2_147_483_647;

/** The DEK envelope shape this server accepts, and the only thing it checks. */
const DEK_ENVELOPE_BYTES = 105;

export type GrantIssueFailure =
    | 'grant-id-reused'
    | 'sequence-exhausted'
    | ScopeMismatch
    | 'session-unknown'
    | 'session-owner-changed'
    | 'family-revoked'
    | 'family-exists'
    | 'request-conflict'
    | 'already-expired'
    /** An approver who is not the owner cannot answer without their own key. */
    | 'viewer-envelope-required'
    | 'viewer-envelope-malformed'
    /**
     * The request names an access-list generation older than one already
     * applied here. Refused rather than honoured: a late mint would restore
     * access a newer removal ended.
     */
    | 'revision-stale';

export type GrantRenewFailure =
    | 'grant-mismatch'
    | 'sequence-exhausted'
    | ScopeMismatch
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'renewal-conflict'
    | 'not-extending';

export type GrantCheckFailure =
    | ScopeMismatch
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'session-unknown'
    | 'session-owner-changed'
    | 'claims-mismatch';

export type RevokeFailure = 'run-unknown' | 'binding-mismatch' | 'revision-stale';

export type GrantResolveFailure =
    | ScopeMismatch
    | 'revision-stale'
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'session-unknown'
    | 'session-owner-changed'
    | 'already-expired'
    /** The stored row was minted for an older generation of this scope. */
    | 'grant-stale';

export type LiveGrant = {
    grantId: string;
    family: string;
    sessionId: string;
    accountId: string;
    /** Null on a read grant: there is no run to name. */
    workspaceId: string | null;
    runId: string | null;
    attemptId: string | null;
    epoch: number | null;
    workspaceAuthorityVersion: number | null;
    runAuthorityVersion: number | null;
    /** Set when somebody other than the owner is reading. */
    viewerAccountId?: string | null;
    /**
     * The session key envelope resealed for that viewer, when there is one.
     *
     * Carried on the grant so a handler can answer **this bearer** — the
     * owner's envelope is bytes a viewer cannot open, and serving it would show
     * an empty conversation instead of an honest "locked".
     */
    viewerDataEncryptionKey?: Uint8Array | null;
    renewalSeq: number;
    expiresAt: number;
    purpose: SessionScopedPurpose;
};

export type GrantResult<F> =
    | { ok: true; grant: LiveGrant; idempotent: boolean }
    | { ok: false; reason: F };

type GrantRow = {
    grantId: string; family: string; sessionId: string; accountId: string;
    /**
     * Null on a read grant — a transcript outlives its run — so every consumer
     * has to say what it does without them rather than assume they are there.
     */
    workspaceId: string | null; runId: string | null; attemptId: string | null;
    epoch: number | null;
    workspaceAuthorityVersion: number | null; runAuthorityVersion: number | null;
    renewalSeq: number; expiresAt: bigint;
    /** Stored as text; classified on the way out, never trusted as typed. */
    purpose: string;
    viewerAccountId?: string | null;
    viewerDataEncryptionKey?: Uint8Array | null;
    /** The access-list generation, on the purposes that have a viewer. */
    aclRevision?: number | null;
};

type AuthorityRow = {
    workspaceId: string;
    accountId: string;
    currentAttemptId: string;
    cancelledAt: bigint | null;
    version: number;
    workspace: {
        tenantId: string; projectId: string; runtimeId: string;
        epoch: number; version: number;
    };
};

function toLiveGrant(row: GrantRow): LiveGrant {
    return {
        grantId: row.grantId,
        family: row.family,
        sessionId: row.sessionId,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        runId: row.runId,
        attemptId: row.attemptId,
        epoch: row.epoch,
        workspaceAuthorityVersion: row.workspaceAuthorityVersion,
        runAuthorityVersion: row.runAuthorityVersion,
        renewalSeq: row.renewalSeq,
        expiresAt: Number(row.expiresAt),
        // A stored value outside the three the server knows is not classified,
        // and an unclassified grant is not one this server will act on. It is
        // never folded into `runner`, which would be reading "unknown" as
        // "execution".
        purpose: readStoredPurpose(row.purpose),
        ...(row.viewerAccountId ? { viewerAccountId: row.viewerAccountId } : {}),
        ...(row.viewerDataEncryptionKey
            ? { viewerDataEncryptionKey: row.viewerDataEncryptionKey }
            : {}),
    };
}

function readStoredPurpose(value: unknown): SessionScopedPurpose {
    if (typeof value !== 'string' || !(SESSION_SCOPED_PURPOSES as readonly string[]).includes(value)) {
        throw new Error('managed session grant carries an unknown purpose');
    }
    return value as SessionScopedPurpose;
}

const AUTHORITY_INCLUDE = {
    workspace: {
        select: { tenantId: true, projectId: true, runtimeId: true, epoch: true, version: true },
    },
} as const;

/**
 * Compares a signed scope against the projection, field by field.
 *
 * Nothing is filled in from the row. Every value the assertion signed must
 * still be the current one, so an assertion that sat in a queue while the
 * workspace moved on is refused rather than re-pointed at the new generation.
 */
function compareScope(authority: AuthorityRow | null, scope: ManagedScope): ScopeMismatch | null {
    if (!authority) return 'run-unknown';
    if (authority.cancelledAt !== null) return 'run-cancelled';
    if (authority.workspaceId !== scope.workspaceId) return 'binding-mismatch';
    if (authority.workspace.tenantId !== scope.tenantId
        || authority.workspace.projectId !== scope.projectId) {
        return 'binding-mismatch';
    }
    if (authority.accountId !== scope.accountId) return 'account-mismatch';
    if (authority.currentAttemptId !== scope.attemptId) return 'attempt-mismatch';
    if (authority.workspace.runtimeId !== scope.runtimeId
        || authority.workspace.epoch !== scope.epoch
        || authority.workspace.version !== scope.workspaceAuthorityVersion
        || authority.version !== scope.runAuthorityVersion) {
        return 'authority-stale';
    }
    return null;
}

/**
 * Compares the **stored row** against a scope, field by field.
 *
 * `compareScope` only says the caller agrees with the current projection; it
 * says nothing about the row that was minted earlier. The family deliberately
 * excludes epoch and the authority versions, so an old grant is still found by
 * a scope that has since moved on — and answering with it would hand out a
 * token whose claims describe a generation the row was never issued for. The
 * family is re-derived here too: a row whose scope hashes elsewhere is not this
 * scope's grant even when every field above matches.
 */
function compareStoredGrant(
    grant: GrantRow,
    scope: ManagedScope,
    /**
     * What the caller says this grant is for.
     *
     * Compared as its own axis **and** folded into the family below, because
     * the two answer different questions: the family says which row to look
     * for, and this says the row we found is the one the caller means. Left
     * fixed at `runner`, a read grant was never found by its own purpose — the
     * lookup returned the runner row, and every later check compared against
     * that row's authority.
     */
    purpose: SessionScopedPurpose,
    /**
     * The account the grant was resealed for, on the purposes that have one.
     *
     * Part of the family since the viewer axis exists, so leaving it out here
     * looked for a row that was never written: an `approval-control` grant is
     * stored under a family containing its approver, and a lookup without one
     * found nothing and reported the bearer's claims as wrong. It is also
     * compared on its own, for the same reason the read path compares it — one
     * viewer's row must never authorise another viewer's token, because the
     * envelope on that row is sealed for a single account.
     */
    viewerAccountId?: string | null,
    /** Part of the family since the generation axis exists; see it there. */
    aclRevision?: number | null,
): 'mismatch' | null {
    if (readStoredPurpose(grant.purpose) !== purpose) return 'mismatch';
    if ((grant.viewerAccountId ?? null) !== (viewerAccountId ?? null)) return 'mismatch';
    if ((grant.aclRevision ?? null) !== (aclRevision ?? null)) return 'mismatch';
    if (grant.sessionId !== scope.sessionId
        || grant.accountId !== scope.accountId
        || grant.workspaceId !== scope.workspaceId
        || grant.runId !== scope.runId
        || grant.attemptId !== scope.attemptId
        || grant.epoch !== scope.epoch
        || grant.workspaceAuthorityVersion !== scope.workspaceAuthorityVersion
        || grant.runAuthorityVersion !== scope.runAuthorityVersion) {
        return 'mismatch';
    }
    if (grant.family !== deriveGrantFamily(
        scope, purpose, viewerAccountId ?? undefined, aclRevision ?? undefined,
    )) return 'mismatch';
    return null;
}

export type IssueGrantInput = {
    scope: ManagedScope;
    grantId: string;
    expiresAt: number;
    requestId: string;
    now: number;
    /** Defaults to `runner`: the behaviour every existing caller relies on. */
    purpose?: SessionScopedPurpose;
    /**
     * The account that will hold an `approval-control` grant, and the session
     * key resealed for them.
     *
     * Approving means answering as the run — the response is sealed with the
     * session key — so an approver who is not the owner needs their own
     * envelope for the same reason a reader does. Absent on the runner path.
     */
    viewerAccountId?: string;
    viewerDataEncryptionKey?: string;
    /**
     * The access-list generation this grant belongs to, on the purposes that
     * have a viewer. Required in practice by every viewer-scoped caller: see
     * `deriveGrantFamily`.
     */
    aclRevision?: number;
};

/**
 * Issues a first grant or replaces an expired, non-revoked family grant.
 *
 * Order matters and is the point of the function: the revoke state, the
 * authority comparison and the expiry are all decided *before* an exact retry
 * can return a stored grant. A retry of a mint whose family was revoked in
 * between must fail, or a withdrawn child is handed a working token by
 * repeating the request that created it.
 */
export async function issueSessionGrant(
    input: IssueGrantInput,
): Promise<GrantResult<GrantIssueFailure>> {
    // A constraint violation aborts the transaction that raised it, so the
    // losing writer cannot read the winner's row from inside it; the retry
    // happens out here in a fresh transaction.
    return retryOnUniqueRace(() => issueSessionGrantOnce(input));
}

async function issueSessionGrantOnce(
    input: IssueGrantInput,
): Promise<GrantResult<GrantIssueFailure>> {
    const purpose = input.purpose ?? 'runner';
    const family = deriveGrantFamily(input.scope, purpose, input.viewerAccountId, input.aclRevision);
    const digest = canonicalDigest({
        scope: input.scope,
        grantId: input.grantId,
        expiresAt: input.expiresAt,
        // Part of the body: a retry that asks for a different purpose, viewer or
        // envelope under the same request id is a different request, not the
        // same one again.
        ...(purpose === 'runner' ? {} : {
            purpose,
            viewerAccountId: input.viewerAccountId ?? null,
            viewerDataEncryptionKey: input.viewerDataEncryptionKey ?? null,
        }),
    });
    let approverEnvelope: Uint8Array<ArrayBuffer> | null = null;
    if (purpose !== 'runner') {
        // Same rule as the read path, for the same reason: answering as the run
        // means holding the session key, and the stored envelope is the
        // owner's. A grant without one would be valid and unusable.
        if (input.viewerAccountId && input.viewerAccountId !== input.scope.accountId
            && input.viewerDataEncryptionKey === undefined) {
            return { ok: false, reason: 'viewer-envelope-required' };
        }
        if (input.viewerDataEncryptionKey !== undefined) {
            const decoded = Buffer.from(input.viewerDataEncryptionKey, 'base64');
            if (decoded.length !== DEK_ENVELOPE_BYTES || decoded[0] !== 0
                || decoded.toString('base64') !== input.viewerDataEncryptionKey) {
                return { ok: false, reason: 'viewer-envelope-malformed' };
            }
            const copy = new Uint8Array(new ArrayBuffer(decoded.length));
            copy.set(decoded);
            approverEnvelope = copy;
        }
    }

    /*
     * A viewer-scoped grant belongs to a generation of the parent's access
     * list, and the generation is part of its family. Without it, a member
     * removed and re-added **during the same run** finds the family their
     * removal tombstoned and can never approve again on the run they were just
     * given access to — the run axes make the family identical.
     */
    const aclKey: AclKey | null = purpose !== 'runner' && input.viewerAccountId && input.aclRevision !== undefined
        ? {
            sessionId: input.scope.sessionId,
            viewerAccountId: input.viewerAccountId,
            aclRevision: input.aclRevision,
        }
        : null;

    return inTx(async (tx) => {
        // Compared before anything else, and spent only at the write below: a
        // request refused further down must not burn the generation.
        if (aclKey && !await aclRevisionIsCurrent(tx, aclKey)) {
            return { ok: false, reason: 'revision-stale' as const };
        }
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        // A grant for a session that does not exist, or that belongs to another
        // account, could never resolve: minting one only moves the failure to
        // the child. The routes check the bearer; this checks the session.
        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== input.scope.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        const existingFamily = await tx.managedSessionGrant.findUnique({ where: { family } });
        // Checked before any retry can succeed: a revoked family is closed to
        // every request, including one that already produced a grant.
        if (existingFamily && (existingFamily.revokedAt !== null || existingFamily.tombstone)) {
            return { ok: false, reason: 'family-revoked' };
        }
        if (input.expiresAt <= input.now) return { ok: false, reason: 'already-expired' };

        const existingRequest = await tx.managedSessionGrant.findUnique({
            where: { requestId: input.requestId },
        });
        if (existingRequest) {
            if (existingRequest.bodyDigest !== digest || existingRequest.family !== family) {
                return { ok: false, reason: 'request-conflict' };
            }
            if (Number(existingRequest.expiresAt) <= input.now) {
                return { ok: false, reason: 'already-expired' };
            }
            // The row may have been extended by a renewal since. This request
            // only ever authorised its own expiry, so what it hands back is
            // capped at that — a replay of an old mint must not collect a
            // later renewal's lifetime. The row keeps the renewed value.
            return {
                ok: true,
                grant: {
                    ...toLiveGrant(existingRequest),
                    expiresAt: Math.min(Number(existingRequest.expiresAt), input.expiresAt),
                },
                idempotent: true,
            };
        }
        if (existingFamily) {
            // The *grant* expired, which is not the same as the run stopping.
            // Refusing forever would make a lapsed grant unrecoverable, and a
            // second row would leave two live grants for one child — so the row
            // is replaced in place, under the state it was read in. The scope
            // was compared against the current authority above; nothing new is
            // granted and no attempt is started by this.
            if (Number(existingFamily.expiresAt) > input.now) {
                return { ok: false, reason: 'family-exists' };
            }
            // The replacement must be a different grant. `expectedGrantId` is
            // what tells a renewal which grant it holds, so reusing the id it
            // is replacing would leave that check unable to tell them apart.
            if (input.grantId === existingFamily.grantId) {
                return { ok: false, reason: 'grant-id-reused' };
            }
            if (aclKey) await advanceAclRevision(tx, aclKey, input.now);
            const nextSeq = existingFamily.renewalSeq + 1;
            if (nextSeq > MAX_RENEWAL_SEQ) return { ok: false, reason: 'sequence-exhausted' };
            const replaced = await tx.managedSessionGrant.updateMany({
                where: {
                    family,
                    // The exact row that was read. A renewal that extended it,
                    // or a revoke that closed it, between the read and here
                    // makes this match nothing.
                    grantId: existingFamily.grantId,
                    renewalSeq: existingFamily.renewalSeq,
                    expiresAt: existingFamily.expiresAt,
                    revokedAt: null,
                    tombstone: false,
                },
                data: {
                    grantId: input.grantId,
                    requestId: input.requestId,
                    attemptId: input.scope.attemptId,
                    epoch: input.scope.epoch,
                    workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                    runAuthorityVersion: input.scope.runAuthorityVersion,
                    // Advanced, never reset. The sequence belongs to the family
                    // rather than to one grant: resetting it let a signature for
                    // an earlier grant match a later one at the same number,
                    // which is the ABA `expectedGrantId` alone cannot close
                    // while ids may repeat across generations.
                    renewalSeq: nextSeq,
                    expiresAt: BigInt(input.expiresAt),
                    /*
                     * The envelope too, and this is why: a replacement is a new
                     * request with a body of its own, and its body includes the
                     * session key resealed for the approver. Left out, the
                     * replaced row kept the **previous** envelope while the
                     * caller was told the mint succeeded — an approver holding
                     * a key blob it can no longer open, on a grant that reports
                     * itself healthy.
                     */
                    viewerDataEncryptionKey: approverEnvelope,
                    bodyDigest: digest,
                    updatedAt: BigInt(input.now),
                },
            });
            // Someone else moved the row first. Their result is the current
            // one, and it has to be read in a transaction that can see it.
            if (replaced.count !== 1) throw new ConcurrentGrantChange();
            const row = await tx.managedSessionGrant.findUniqueOrThrow({ where: { family } });
            return { ok: true, grant: toLiveGrant(row), idempotent: false };
        }

        if (aclKey) await advanceAclRevision(tx, aclKey, input.now);
        const created = await tx.managedSessionGrant.create({
            data: {
                grantId: input.grantId,
                family,
                sessionId: input.scope.sessionId,
                accountId: input.scope.accountId,
                purpose,
                ...(input.viewerAccountId ? { viewerAccountId: input.viewerAccountId } : {}),
                ...(input.aclRevision === undefined ? {} : { aclRevision: input.aclRevision }),
                viewerDataEncryptionKey: approverEnvelope,
                workspaceId: input.scope.workspaceId,
                runId: input.scope.runId,
                attemptId: input.scope.attemptId,
                epoch: input.scope.epoch,
                workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                runAuthorityVersion: input.scope.runAuthorityVersion,
                renewalSeq: 0,
                expiresAt: BigInt(input.expiresAt),
                requestId: input.requestId,
                bodyDigest: digest,
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true, grant: toLiveGrant(created), idempotent: false };
    });
}

/**
 * Extends a live grant in place under compare-and-set.
 *
 * A renewal is a fresh decision to keep a child alive, so it repeats every
 * check a mint makes — including the exact scope comparison — before the
 * sequence is considered. An idempotent answer is likewise only reachable once
 * those checks have passed.
 */
export async function renewSessionGrant(input: {
    scope: ManagedScope;
    /**
     * The grant the caller believes it holds.
     *
     * Names the current grant explicitly, alongside the monotonically
     * increasing family sequence. A renewal for a superseded grant must not
     * receive or extend its replacement, including an idempotent response.
     */
    expectedGrantId: string;
    expectedRenewalSeq: number;
    expiresAt: number;
    now: number;
    /**
     * Which grant for this scope. A renewal extends one grant; fixed at
     * `runner` it could only ever find the runner's, so a read grant could not
     * be renewed at all and a revoke aimed at the runner's row instead.
     */
    purpose?: SessionScopedPurpose;
    /** The approver or viewer the grant was resealed for, when it has one. */
    viewerAccountId?: string;
    /** The access-list generation, on the purposes that have a viewer. */
    aclRevision?: number;
}): Promise<GrantResult<GrantRenewFailure>> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner', input.viewerAccountId, input.aclRevision);

    return inTx(async (tx) => {
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };
        if (grant.sessionId !== input.scope.sessionId
            || grant.accountId !== input.scope.accountId
            || grant.runId !== input.scope.runId
            || grant.attemptId !== input.scope.attemptId
            || grant.workspaceId !== input.scope.workspaceId) {
            return { ok: false, reason: 'binding-mismatch' };
        }
        // Compared before anything can succeed, the idempotent answer included:
        // a caller naming a grant this family no longer has is holding a
        // superseded one, and must be told so rather than handed the new one.
        if (grant.grantId !== input.expectedGrantId) {
            return { ok: false, reason: 'grant-mismatch' };
        }
        // The scope passing the projection comparison only says the *caller* is
        // current. A grant minted against an older generation is stale, and
        // renewing must not carry it forward: that would promote it to an
        // authority it was never issued under. It has to be re-minted.
        if (grant.epoch !== input.scope.epoch
            || grant.workspaceAuthorityVersion !== input.scope.workspaceAuthorityVersion
            || grant.runAuthorityVersion !== input.scope.runAuthorityVersion) {
            return { ok: false, reason: 'authority-stale' };
        }
        // A lapsed grant cannot authorize the child; expiry alone does not
        // prove process termination. Checked before the idempotent answer, so a repeat of
        // a renewal does not hand back a grant that has since lapsed.
        if (input.now >= Number(grant.expiresAt)) return { ok: false, reason: 'expired' };

        if (grant.renewalSeq === input.expectedRenewalSeq + 1
            && Number(grant.expiresAt) === input.expiresAt) {
            return { ok: true, grant: toLiveGrant(grant), idempotent: true };
        }
        if (grant.renewalSeq !== input.expectedRenewalSeq) {
            return { ok: false, reason: 'renewal-conflict' };
        }
        // A renewal that does not extend is a lost update wearing the right
        // sequence number.
        if (input.expiresAt <= Number(grant.expiresAt)) return { ok: false, reason: 'not-extending' };
        if (grant.renewalSeq + 1 > MAX_RENEWAL_SEQ) {
            return { ok: false, reason: 'sequence-exhausted' };
        }

        const updated = await tx.managedSessionGrant.updateMany({
            where: {
                family,
                // The id is part of the condition, not only of the read: a
                // remint between the read and here must make this match nothing.
                grantId: input.expectedGrantId,
                renewalSeq: input.expectedRenewalSeq,
                revokedAt: null,
            },
            data: {
                // The generation is deliberately untouched: a renewal extends
                // a grant, it does not re-issue it under a new authority.
                renewalSeq: { increment: 1 },
                expiresAt: BigInt(input.expiresAt),
                updatedAt: BigInt(input.now),
            },
        });
        if (updated.count !== 1) return { ok: false, reason: 'renewal-conflict' };

        return {
            ok: true,
            grant: {
                ...toLiveGrant(grant),
                renewalSeq: grant.renewalSeq + 1,
                expiresAt: input.expiresAt,
            },
            idempotent: false,
        };
    });
}

export type RevokeResult =
    | { ok: true; state: 'revoked' | 'tombstoned'; alreadyRevoked: boolean }
    | { ok: false; reason: RevokeFailure };

/**
 * Withdraws a family, whether or not a grant exists for it yet.
 *
 * With nothing issued this writes a tombstone carrying the same scope a mint
 * would have, so a revoke that arrives before the mint it cancels is recorded
 * rather than being a no-op the mint then lands behind. When a mint wins the
 * insert instead, the unique violation is retried out of transaction and the
 * second pass revokes the row that actually won — the outcome is a row with
 * `revokedAt` set either way, which is what the tests assert.
 */
export async function revokeSessionGrant(input: {
    scope: ManagedScope;
    reason: string;
    now: number;
    /** Which grant to withdraw. Omitted means `runner`. */
    purpose?: SessionScopedPurpose;
    /** The approver or viewer the grant was resealed for, when it has one. */
    viewerAccountId?: string;
    /** The access-list generation, on the purposes that have a viewer. */
    aclRevision?: number;
}): Promise<RevokeResult> {
    return retryOnUniqueRace(
        () => revokeSessionGrantOnce(input),
        // Nothing to hang a tombstone on: the run was never synced, so no grant
        // can exist for it either.
        () => ({ ok: false, reason: 'run-unknown' }),
    );
}

async function revokeSessionGrantOnce(input: {
    scope: ManagedScope;
    reason: string;
    now: number;
    purpose?: SessionScopedPurpose;
    viewerAccountId?: string;
    aclRevision?: number;
}): Promise<RevokeResult> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner', input.viewerAccountId, input.aclRevision);
    /*
     * A withdrawal belongs to a generation too, and a stale one must not reach
     * the family a **newer** decision opened: a removal that overtook nothing
     * on the way out but arrives after the member was re-added would end the
     * access the re-add granted, with nothing telling the parent it had been
     * undone.
     */
    const aclKey: AclKey | null = (input.purpose ?? 'runner') !== 'runner'
        && input.viewerAccountId && input.aclRevision !== undefined
        ? {
            sessionId: input.scope.sessionId,
            viewerAccountId: input.viewerAccountId,
            aclRevision: input.aclRevision,
        }
        : null;

    return inTx(async (tx) => {
        if (aclKey && !await aclRevisionIsCurrent(tx, aclKey)) {
            return { ok: false as const, reason: 'revision-stale' as const };
        }
        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (grant) {
            // The derivation already ties the family to this scope; this catches
            // a row that somehow carries a different binding rather than
            // withdrawing something other than what the caller signed.
            if (!grant.tombstone && (grant.runId !== input.scope.runId
                || grant.workspaceId !== input.scope.workspaceId
                || grant.accountId !== input.scope.accountId
                || grant.sessionId !== input.scope.sessionId)) {
                return { ok: false, reason: 'binding-mismatch' };
            }
            if (grant.revokedAt !== null) {
                // Terminal: the first reason stands, so an audit reads what
                // actually stopped the child.
                return {
                    ok: true,
                    state: grant.tombstone ? 'tombstoned' : 'revoked',
                    alreadyRevoked: true,
                };
            }
            if (aclKey) await advanceAclRevision(tx, aclKey, input.now);
            await tx.managedSessionGrant.update({
                where: { family },
                data: {
                    revokedAt: BigInt(input.now),
                    revokedReason: input.reason,
                    updatedAt: BigInt(input.now),
                },
            });
            return { ok: true, state: 'revoked', alreadyRevoked: false };
        }

        if (aclKey) await advanceAclRevision(tx, aclKey, input.now);
        await tx.managedSessionGrant.create({
            data: {
                grantId: `tombstone:${family}`,
                family,
                ...(input.aclRevision === undefined ? {} : { aclRevision: input.aclRevision }),
                ...(input.viewerAccountId ? { viewerAccountId: input.viewerAccountId } : {}),
                // The full signed scope, so the tombstone is the same shape as
                // the grant it prevents rather than a blank placeholder.
                sessionId: input.scope.sessionId,
                accountId: input.scope.accountId,
                workspaceId: input.scope.workspaceId,
                runId: input.scope.runId,
                attemptId: input.scope.attemptId,
                epoch: input.scope.epoch,
                workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                runAuthorityVersion: input.scope.runAuthorityVersion,
                renewalSeq: 0,
                expiresAt: BigInt(input.now),
                revokedAt: BigInt(input.now),
                revokedReason: input.reason,
                tombstone: true,
                requestId: `tombstone:${family}`,
                bodyDigest: '',
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true, state: 'tombstoned', alreadyRevoked: false };
    });
}

/**
 * The check every scoped action makes.
 *
 * It takes the whole verified claim set, not an id: the token's own scope is
 * what has to be compared, and a fresh read of the row cannot stand in for
 * that. Row, projection and the session's current owner are read in one
 * transaction so the answer is consistent rather than assembled from three
 * moments.
 *
 * Token lifetime, stated rather than implied: a renewal extends the grant and
 * issues a longer token; it does not invalidate the token already handed out,
 * which stays usable until its own `expiresAt`. Tokens carry no renewal
 * sequence, so this is the only coherent reading — and the one thing that stops
 * a token early is revocation, checked here on every action. A token may never
 * outlive the row that authorises it, so a claimed expiry beyond the grant's is
 * refused rather than truncated.
 *
 * Never cached. The point of a revocable grant is that it stops working between
 * one action and the next.
 */
export async function resolveLiveGrant(input: {
    claims: SessionScopedClaims;
    now: number;
}): Promise<{ ok: true; grant: LiveGrant } | { ok: false; reason: GrantCheckFailure }> {
    const { claims } = input;

    return inTx(async (tx) => {
        const grant = await tx.managedSessionGrant.findUnique({
            where: { grantId: claims.grantId },
        });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };

        // The token may not outlive the row that authorises it, and neither may
        // be past its expiry.
        if (input.now >= Number(grant.expiresAt) || input.now >= claims.expiresAt) {
            return { ok: false, reason: 'expired' };
        }
        if (claims.expiresAt > Number(grant.expiresAt)) return { ok: false, reason: 'claims-mismatch' };

        /*
         * A read token has no run to compare against, and there is nothing to
         * invent: the row it names has no run either. What is compared instead
         * is what a read grant is made of — the session, its owner and the
         * viewer — and that comparison lives below.
         */
        if (claims.purpose === 'transcript-read') {
            if (grant.runId !== null || grant.attemptId !== null) {
                // A read token naming a runner row, or the reverse. The row is
                // the authority, and this is not it.
                return { ok: false, reason: 'claims-mismatch' };
            }
            if (grant.sessionId !== claims.sessionId || grant.accountId !== claims.accountId) {
                return { ok: false, reason: 'claims-mismatch' };
            }
            if ((grant.viewerAccountId ?? null) !== (claims.viewerAccountId ?? null)) {
                // One viewer's grant must never authorise another's token: the
                // resealed key envelope on that row is for one account.
                return { ok: false, reason: 'claims-mismatch' };
            }
            if (readStoredPurpose(grant.purpose) !== 'transcript-read') {
                return { ok: false, reason: 'claims-mismatch' };
            }
            /*
             * The generation this row was issued under, against the one that
             * stands now.
             *
             * Without this, moving the mark forward did nothing to the bearers
             * of the generation it replaced: the older row is still live, and
             * it can no longer be withdrawn either — a revoke naming its
             * generation is refused as stale, and one naming the current
             * generation tombstones a different family. A removed reader kept
             * reading until the grant lapsed.
             *
             * Checked here rather than fixed by a sweep on the writing side,
             * because this is the check that still holds when the withdrawal
             * never arrives: the parent bumps its own generation, and every
             * bearer below it stops at the next action.
             */
            if (grant.viewerAccountId !== null) {
                const mark = await tx.managedReadAclWatermark.findUnique({
                    where: {
                        sessionId_viewerAccountId: {
                            sessionId: grant.sessionId,
                            viewerAccountId: grant.viewerAccountId,
                        },
                    },
                });
                if (mark) {
                    /*
                     * A row written before this axis existed carries no
                     * generation. Skipping it left exactly the hole the axis
                     * closes: the parent advances to a new generation and
                     * withdraws the old one, and the pre-migration bearer keeps
                     * reading because its row has nothing to compare.
                     *
                     * So a mark for this pair makes a generation mandatory. No
                     * mark at all means no generations are in play for this
                     * viewer, and the row is left alone — that is the
                     * back-compatible case, and it is the only one.
                     */
                    if (grant.aclRevision === null) return { ok: false, reason: 'revoked' };
                    // Reported as revoked, because that is what it is: access
                    // the access list no longer describes.
                    // Compared only once it is known to be a number: `null`
                    // happens to order below every revision in JavaScript, and
                    // relying on that would make the line above look optional.
                    if (grant.aclRevision < mark.revision) return { ok: false, reason: 'revoked' };
                }
            }
            return { ok: true, grant: toLiveGrant(grant as never) };
        }
        if (claims.workspaceId === undefined || claims.runtimeId === undefined
            || claims.runId === undefined || claims.attemptId === undefined
            || claims.epoch === undefined || claims.workspaceAuthorityVersion === undefined
            || claims.runAuthorityVersion === undefined) {
            // Refused rather than defaulted: a runner token that cannot name its
            // run is not a runner token.
            return { ok: false, reason: 'claims-mismatch' };
        }

        const scope: ManagedScope = {
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            workspaceId: claims.workspaceId,
            runtimeId: claims.runtimeId,
            epoch: claims.epoch,
            runId: claims.runId,
            attemptId: claims.attemptId,
            sessionId: claims.sessionId,
            accountId: claims.accountId,
            workspaceAuthorityVersion: claims.workspaceAuthorityVersion,
            runAuthorityVersion: claims.runAuthorityVersion,
        };
        // Same comparison the resolve path makes: the stored row has to be the
        // one this scope was issued for, not merely a member of its family.
        // Including the purpose: the row found by `grantId` must be the grant
        // this token says it is. Without it a read token carried a runner row's
        // authority, and a runner token would have been accepted against a read
        // row just as readily.
        if (compareStoredGrant(grant, scope, claims.purpose, claims.viewerAccountId, grant.aclRevision)) {
            return { ok: false, reason: 'claims-mismatch' };
        }

        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: claims.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, scope);
        if (mismatch) return { ok: false, reason: mismatch };

        // The account a session belongs to can change under an account merge or
        // a transfer; a grant minted before that must not keep acting on it.
        const session = await tx.session.findUnique({
            where: { id: claims.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== claims.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        /*
         * And the access list, for a bearer that has a viewer.
         *
         * An approval grant is issued to a person, and that person's access can
         * end while the run continues. The check is the same one the transcript
         * side makes and it lives here for the same reason: it holds when the
         * withdrawal never arrives, because the parent moving to a new
         * generation is enough to stop every bearer below it.
         */
        if (grant.viewerAccountId) {
            const mark = await tx.managedReadAclWatermark.findUnique({
                where: {
                    sessionId_viewerAccountId: {
                        sessionId: grant.sessionId,
                        viewerAccountId: grant.viewerAccountId,
                    },
                },
            });
            if (mark) {
                // A row from before this axis existed carries no generation,
                // and a mark means generations are in play for this pair.
                if (grant.aclRevision === null || grant.aclRevision === undefined) {
                    return { ok: false, reason: 'revoked' };
                }
                if (grant.aclRevision < mark.revision) return { ok: false, reason: 'revoked' };
            }
        }

        return { ok: true, grant: toLiveGrant(grant) };
    });
}

/**
 * Re-runs an attempt once when a concurrent writer won a unique constraint.
 *
 * The violation aborts the transaction it happened in, so the recovery cannot
 * live next to the statement that raised it and an in-transaction catch would
 * be reporting success for work the database threw away. A foreign key
 * violation is not a race and is reported through `onMissingRun`.
 */
async function retryOnUniqueRace<T>(
    attempt: () => Promise<T>,
    onMissingRun?: () => T,
): Promise<T> {
    for (let remaining = 1; ; remaining--) {
        try {
            return await attempt();
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === FOREIGN_KEY_VIOLATION && onMissingRun) return onMissingRun();
            const raced = error instanceof ConcurrentGrantChange;
            if ((!raced && code !== UNIQUE_VIOLATION) || remaining === 0) {
                // A race that survives the retry is reported as the state that
                // beat it, not thrown at the caller.
                if (raced) return { ok: false, reason: 'family-exists' } as T;
                throw error;
            }
        }
    }
}

/**
 * Whether an approval grant is still good enough to send a packet on, read at
 * the moment of sending.
 *
 * Its own function rather than `readGrantRow` plus a few comparisons at the
 * call site: `readGrantRow` hides a revoked row behind a shape that looks live
 * (it filters tombstones only), so a caller reaching for it would have been one
 * missing field away from relaying an answer from a withdrawn approver. The
 * checks that matter are here, next to the row they are about.
 */
export async function checkApprovalGrantForRelay(input: {
    grantId: string;
    sessionId: string;
    accountId: string;
    viewerAccountId?: string;
    now: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = await db.managedSessionGrant.findUnique({ where: { grantId: input.grantId } });
    if (!row || row.tombstone) return { ok: false, reason: 'grant-unknown' };
    if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (input.now >= Number(row.expiresAt)) return { ok: false, reason: 'expired' };
    if (readStoredPurpose(row.purpose) !== 'approval-control') {
        return { ok: false, reason: 'purpose-not-allowed' };
    }
    if (row.sessionId !== input.sessionId || row.accountId !== input.accountId) {
        return { ok: false, reason: 'scope-mismatch' };
    }
    if ((row.viewerAccountId ?? undefined) !== input.viewerAccountId) {
        return { ok: false, reason: 'viewer-mismatch' };
    }
    return { ok: true };
}

/** Read-only view for callers that already hold a verified grant id. */
export async function readGrantRow(grantId: string): Promise<LiveGrant | null> {
    const row = await db.managedSessionGrant.findUnique({ where: { grantId } });
    return row && !row.tombstone ? toLiveGrant(row) : null;
}

export type ResolveGrantInput = {
    scope: ManagedScope;
    /** The latest the caller signed for. The answer is never later than this. */
    requestedTokenExpiresAt: number;
    now: number;
    /**
     * Which grant for this scope. Omitted means `runner`, so every existing
     * caller resolves exactly what it resolved before.
     */
    purpose?: SessionScopedPurpose;
    /**
     * The approver a non-runner grant was resealed for, when there is one.
     *
     * The family carries it, so resolving without it looks for a different row.
     */
    viewerAccountId?: string;
    /** The access-list generation, for the same reason. */
    aclRevision?: number;
};

export type ResolvedGrant = {
    grant: LiveGrant;
    /** `min(grant expiry, signed request expiry)`. */
    tokenExpiresAt: number;
};

export type ResolveGrantResult =
    | { ok: true; resolved: ResolvedGrant }
    | { ok: false; reason: GrantResolveFailure };

/**
 * Reads the current grant for a scope so a caller that lost the mint response
 * can recover it — **without writing anything**.
 *
 * This is not an idempotent replay of the original mint. The original answer is
 * gone; what this returns is the grant as it stands now, bounded by the expiry
 * the caller signed for. A grant minted to 500 and renewed to 1500, resolved
 * under a signed cap of 1000, answers 1000: not the first answer, and never the
 * renewal's own lifetime. That is why the response separates the two expiries.
 *
 * It runs every check a mint runs — authority, session ownership, revoke state,
 * expiry — in the same read, because it hands out a credential. `requestId` is
 * the caller's signed correlation only; nothing about it is stored or matched.
 * A missing, revoked or expired grant is refused: this call cannot create one,
 * resurrect one, or extend one.
 */
export async function resolveSessionGrant(
    input: ResolveGrantInput,
): Promise<ResolveGrantResult> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner', input.viewerAccountId, input.aclRevision);
    /*
     * A viewer-scoped resolve is answered against the access list too.
     *
     * The family of a superseded generation can still be perfectly live — the
     * withdrawal may not have arrived, or may never — and reading a token back
     * from it hands the caller something the authorization path will refuse on
     * its first use. Answering "stale" is the same fact, said where the caller
     * can act on it.
     */
    const aclKey: AclKey | null = (input.purpose ?? 'runner') !== 'runner'
        && input.viewerAccountId && input.aclRevision !== undefined
        ? {
            sessionId: input.scope.sessionId,
            viewerAccountId: input.viewerAccountId,
            aclRevision: input.aclRevision,
        }
        : null;

    return inTx(async (tx) => {
        // In the same transaction as the row it is about: a mark read outside
        // it could move between the two reads.
        if (aclKey && !await aclRevisionIsCurrent(tx, aclKey)) {
            return { ok: false, reason: 'revision-stale' as const };
        }
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== input.scope.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };
        // The row must be the one this exact scope was issued for. Without this
        // an authority advance leaves an old row that the fresh scope still
        // finds, and the answer would mix an old grant with a new DTO.
        if (compareStoredGrant(grant, input.scope, input.purpose ?? 'runner', input.viewerAccountId, input.aclRevision)) {
            return { ok: false, reason: 'grant-stale' };
        }

        const grantExpiresAt = Number(grant.expiresAt);
        if (!Number.isSafeInteger(grantExpiresAt)) return { ok: false, reason: 'expired' };
        if (input.now >= grantExpiresAt) return { ok: false, reason: 'expired' };
        // A cap that has already passed — or is not a real instant — authorises
        // nothing, and quietly widening it to the grant's own expiry would
        // ignore what was signed. `NaN` fails every comparison, so it is
        // rejected by shape rather than by `<=`.
        if (!Number.isSafeInteger(input.requestedTokenExpiresAt)
            || input.requestedTokenExpiresAt <= input.now) {
            return { ok: false, reason: 'already-expired' };
        }

        return {
            ok: true,
            resolved: {
                grant: toLiveGrant(grant),
                tokenExpiresAt: Math.min(grantExpiresAt, input.requestedTokenExpiresAt),
            },
        };
    });
}

/**
 * What a read grant is scoped to.
 *
 * Deliberately **not** a `ManagedScope`: a transcript outlives its run, so
 * there is no run, attempt, runtime or epoch to name. Requiring them is what
 * made a dormant project unreadable — the run had finished, the runtime was
 * gone, and the authority row a runner grant compares against did not exist.
 *
 * What it is checked against instead is ownership: the session exists, and the
 * account the caller says owns it really does. The caller is the control plane,
 * which has already proved it may act for this tenant and project; who may read
 * a project is the parent's decision, and it is not re-derived here.
 */
export type ManagedReadScope = {
    tenantId: string;
    projectId: string;
    sessionId: string;
    /** The authority. Compared against the session, never adopted from it. */
    sessionOwnerAccountId: string;
    /** Who is reading. The same account as the owner is normal, not special. */
    viewerAccountId: string;
    /**
     * Which generation of the parent's access list this request belongs to.
     *
     * **Required, and deliberately not optional.** A default would put every
     * caller on one generation forever, which is the state this axis exists to
     * leave: one generation means a removal's tombstone is permanent, so a
     * member who is re-added can never be issued anything again, and the only
     * way to make re-adding work would be to clear that tombstone — which
     * would revive the bearer the removal withdrew.
     *
     * Monotonic per (session, viewer) and owned by the parent, which is what
     * numbers its own access-list changes. This server only compares.
     */
    aclRevision: number;
};

/**
 * A read grant's family: one live grant per session **per viewer**.
 *
 * The viewer is part of it because two members of a company project reading the
 * same session are two grants — one revoked must not close the other, and one
 * viewer's resealed key envelope must never be handed to another.
 */
export function deriveReadGrantFamily(
    scope: ManagedReadScope,
    purpose: SessionScopedPurpose,
): string {
    return canonicalDigest({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        sessionOwnerAccountId: scope.sessionOwnerAccountId,
        viewerAccountId: scope.viewerAccountId,
        purpose,
        /*
         * The generation is part of the identity of the family, not a field on
         * the row. That is what makes a re-add a different row from the removal
         * that preceded it: generation N stays tombstoned and keeps every
         * bearer minted under it withdrawn, while N+1 starts clean.
         */
        aclRevision: scope.aclRevision,
    });
}

export type ReadGrantFailure =
    | 'session-unknown'
    /** The caller named an owner the session does not have. Never guessed at. */
    | 'session-owner-mismatch'
    | 'already-expired'
    | 'family-revoked'
    | 'family-exists'
    | 'request-conflict'
    | 'viewer-envelope-malformed'
    /** A viewer who is not the owner cannot read without one of their own. */
    | 'viewer-envelope-required'
    /**
     * The request names an access-list generation older than one already
     * applied here. Refused rather than honoured: a late mint would restore
     * access that a newer removal withdrew.
     */
    | 'revision-stale';

/**
 * The longest a read grant may live.
 *
 * A ceiling, and explicitly **not** a substitute for revocation: when a project
 * withdraws someone's access, the parent calls `revokeReadGrant` and the bearer
 * stops working immediately. This bounds the other case — a withdrawal that
 * never reaches this server, because the caller crashed, or a deployment that
 * has not wired the call yet. Without it "until it expires" could mean a day.
 *
 * Fifteen minutes is short enough that a missed revocation is measured in
 * minutes, and long enough that a browser reading a transcript does not spend
 * its time renewing.
 */
export const MANAGED_READ_GRANT_MAX_TTL_MS = 15 * 60_000;

/**
 * Compares this request's ACL generation against the highest one applied here,
 * advancing the mark when it is newer.
 *
 * Called inside the caller's transaction, before anything is decided, so a
 * refusal leaves nothing behind and an advance commits with the write it
 * authorised. `advance: false` is for a read-only caller, which must never move
 * the mark: resolving a token is not an access-list change.
 *
 * Equal is allowed. A retry of the current generation — a lost response, a
 * second browser tab — is the same request again, not a new one.
 */
/**
 * The (session, viewer, generation) triple the access-list mark is keyed by.
 *
 * Both viewer-scoped purposes share it: reading a transcript and approving on a
 * run are two things one access list decides, and an ACL change that ends one
 * ends the other. A runner has no viewer and never reaches this.
 */
type AclKey = { sessionId: string; viewerAccountId: string; aclRevision: number };

async function readAclMark(tx: Tx, scope: AclKey): Promise<number | null> {
    const mark = await tx.managedReadAclWatermark.findUnique({
        where: {
            sessionId_viewerAccountId: {
                sessionId: scope.sessionId,
                viewerAccountId: scope.viewerAccountId,
            },
        },
    });
    return mark ? mark.revision : null;
}

/**
 * Whether this request's generation is still current enough to act on.
 *
 * Equal is allowed: a retry of the current generation — a lost response, a
 * second browser tab — is the same request again, not a new one.
 */
async function aclRevisionIsCurrent(tx: Tx, scope: AclKey): Promise<boolean> {
    const mark = await readAclMark(tx, scope);
    return mark === null || scope.aclRevision >= mark;
}

/**
 * Moves the mark up to this request's generation.
 *
 * Called **immediately before the write it authorises**, never at the top of
 * the call. Advancing early burned the generation on requests that were then
 * refused for something else entirely — an expiry in the past, a family that
 * already existed — and the mark stayed up: the parent's real generation was
 * now below it, every later mint was refused as stale, and that viewer was
 * locked out until somebody guessed a higher number. A generation counts only
 * what was actually issued or withdrawn.
 */
async function advanceAclRevision(tx: Tx, scope: AclKey, now: number): Promise<void> {
    const mark = await readAclMark(tx, scope);
    if (mark === null) {
        await tx.managedReadAclWatermark.create({
            data: {
                sessionId: scope.sessionId,
                viewerAccountId: scope.viewerAccountId,
                revision: scope.aclRevision,
                updatedAt: BigInt(now),
            },
        });
        return;
    }
    if (scope.aclRevision <= mark) return;
    // Guarded by the value read in this transaction: a concurrent writer that
    // advanced past us loses the update rather than lowering the mark.
    await tx.managedReadAclWatermark.updateMany({
        where: {
            sessionId: scope.sessionId,
            viewerAccountId: scope.viewerAccountId,
            revision: mark,
        },
        data: { revision: scope.aclRevision, updatedAt: BigInt(now) },
    });
}

/**
 * Issues a grant for reading a transcript.
 *
 * Three things it does not do, each for a reason:
 *
 *  - It does not require a run. See `ManagedReadScope`.
 *  - It does not reseal the session key. This server holds the wrapped envelope
 *    and nothing that opens it — no plaintext key, no account private key — so
 *    a viewer envelope can only come from whoever does hold the plaintext. What
 *    arrives is stored; what does not arrive is absent, and a viewer who cannot
 *    decrypt is told that rather than handed the owner's envelope.
 *  - It does not decide who may read. That is the parent's ACL, proved by the
 *    control-plane assertion the route already verified.
 */
export async function issueReadGrant(input: {
    scope: ManagedReadScope;
    grantId: string;
    requestId: string;
    expiresAt: number;
    now: number;
    purpose?: SessionScopedPurpose;
    /** The session key envelope resealed for the viewer, base64, if there is one. */
    viewerDataEncryptionKey?: string;
}): Promise<GrantResult<ReadGrantFailure>> {
    const purpose = input.purpose ?? 'transcript-read';
    const family = deriveReadGrantFamily(input.scope, purpose);
    const digest = canonicalDigest({
        scope: input.scope,
        grantId: input.grantId,
        expiresAt: input.expiresAt,
        purpose,
        /*
         * The envelope is **part of the body**.
         *
         * Left out, a retry under the same request id with a *different*
         * envelope was answered with the first attempt's success — so the
         * viewer would be told they had a grant while the row still held the
         * envelope they no longer had a key for, and the transcript would come
         * back undecryptable with nothing reporting why.
         *
         * Included, an identical retry converges as it should and a changed one
         * is a different request, which is what it is.
         */
        viewerDataEncryptionKey: input.viewerDataEncryptionKey ?? null,
    });

    /*
     * A viewer who is not the owner **must** arrive with a resealed envelope.
     *
     * The stored envelope is sealed for the owner's account; without one of
     * their own, that viewer could hold a perfectly valid grant and never
     * decrypt a single message. Issuing it anyway would move the failure to the
     * screen, where it looks like an empty conversation. Refused at issue
     * instead, while the caller still knows why.
     */
    if (input.scope.viewerAccountId !== input.scope.sessionOwnerAccountId
        && input.viewerDataEncryptionKey === undefined) {
        return { ok: false, reason: 'viewer-envelope-required' };
    }

    let viewerEnvelope: Uint8Array<ArrayBuffer> | null = null;
    if (input.viewerDataEncryptionKey !== undefined) {
        const decoded = Buffer.from(input.viewerDataEncryptionKey, 'base64');
        // Shape only — this server cannot judge whether the box really holds
        // that session's key, and does not claim to. Re-encoding catches the
        // values `Buffer.from` accepts silently.
        if (decoded.length !== DEK_ENVELOPE_BYTES || decoded[0] !== 0
            || decoded.toString('base64') !== input.viewerDataEncryptionKey) {
            return { ok: false, reason: 'viewer-envelope-malformed' };
        }
        // Copied into a plain view: Prisma's `Bytes` is a `Uint8Array` over a
        // real `ArrayBuffer`, and a Node `Buffer` may sit on a shared one.
        const copy = new Uint8Array(new ArrayBuffer(decoded.length));
        copy.set(decoded);
        viewerEnvelope = copy;
    }

    return retryOnUniqueRace(() => inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' as const };
        // The authority, compared rather than believed. A caller that could
        // name the owner would be choosing whose session it is reading.
        if (session.accountId !== input.scope.sessionOwnerAccountId) {
            return { ok: false, reason: 'session-owner-mismatch' as const };
        }
        /*
         * Compared before anything else, including the idempotent replay below:
         * a retry of a mint from a generation that has since been superseded
         * must be refused, not answered with the grant it originally produced.
         * That replay is exactly how a withdrawn bearer would come back.
         *
         * Only compared here. The mark moves at the write, further down.
         */
        if (!await aclRevisionIsCurrent(tx, input.scope)) {
            return { ok: false, reason: 'revision-stale' as const };
        }
        if (input.expiresAt <= input.now) return { ok: false, reason: 'already-expired' as const };
        // Capped rather than refused: a caller asking for longer gets a shorter
        // grant, which is the answer that keeps working. Refusing would make a
        // generous parent unable to issue anything at all.
        const expiresAt = Math.min(input.expiresAt, input.now + MANAGED_READ_GRANT_MAX_TTL_MS);

        const existingFamily = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (existingFamily && (existingFamily.revokedAt !== null || existingFamily.tombstone)) {
            return { ok: false, reason: 'family-revoked' as const };
        }
        const existingRequest = await tx.managedSessionGrant.findUnique({
            where: { requestId: input.requestId },
        });
        if (existingRequest) {
            if (existingRequest.bodyDigest !== digest || existingRequest.family !== family) {
                return { ok: false, reason: 'request-conflict' as const };
            }
            if (Number(existingRequest.expiresAt) <= input.now) {
                return { ok: false, reason: 'already-expired' as const };
            }
            return {
                ok: true as const,
                grant: {
                    ...toLiveGrant(existingRequest as never),
                    expiresAt: Math.min(Number(existingRequest.expiresAt), input.expiresAt),
                },
                idempotent: true,
            };
        }
        if (existingFamily && Number(existingFamily.expiresAt) > input.now) {
            return { ok: false, reason: 'family-exists' as const };
        }

        const data = {
            grantId: input.grantId,
            family,
            sessionId: input.scope.sessionId,
            accountId: input.scope.sessionOwnerAccountId,
            viewerAccountId: input.scope.viewerAccountId,
            // `null` rather than an absent key: the column is nullable, and an
            // optional property widens the type Prisma accepts here.
            viewerDataEncryptionKey: viewerEnvelope,
            purpose,
            aclRevision: input.scope.aclRevision,
            renewalSeq: 0,
            expiresAt: BigInt(expiresAt),
            requestId: input.requestId,
            bodyDigest: digest,
            createdAt: BigInt(input.now),
            updatedAt: BigInt(input.now),
        };
        // The generation is spent here, on the write it authorises, and not
        // before: everything above can still refuse this request.
        await advanceAclRevision(tx, input.scope, input.now);
        const row = existingFamily
            // The previous grant for this viewer lapsed. Replaced in place, so
            // one viewer never accumulates live grants for one session.
            ? await tx.managedSessionGrant.update({ where: { family }, data })
            : await tx.managedSessionGrant.create({ data });
        return { ok: true as const, grant: toLiveGrant(row as never), idempotent: false };
    }));
}

export type ReadResolveFailure =
    | 'session-unknown'
    | 'session-owner-mismatch'
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'already-expired'
    | 'revision-stale';

export type ReadResolveResult =
    | { ok: true; resolved: { grant: LiveGrant; tokenExpiresAt: number } }
    | { ok: false; reason: ReadResolveFailure };

/**
 * Hands back a token for a read grant that already exists — **without writing
 * anything**.
 *
 * This is the answer to a question a mint cannot answer honestly. A second
 * browser tab, a page reloaded, a mint whose response was lost: each of those
 * is a caller that needs a bearer for access it already has. Asked to mint, the
 * server can only refuse (a live grant is in the way) or replace the row — and
 * replacing it invalidates the bearer the other tab is reading with. Asked to
 * resolve, it returns the grant as it stands, and both tabs read.
 *
 * It creates nothing, resurrects nothing and extends nothing: a missing,
 * revoked, expired or superseded grant is refused. The generation is still
 * compared, so a caller from an access-list generation that has since been
 * replaced is told so rather than handed the older grant's token — but the mark
 * is **not** advanced here, because reading a token back is not an access-list
 * change.
 */
export async function resolveReadGrant(input: {
    scope: ManagedReadScope;
    /** The latest the caller signed for. The answer is never later than this. */
    requestedTokenExpiresAt: number;
    now: number;
    purpose?: SessionScopedPurpose;
}): Promise<ReadResolveResult> {
    const purpose = input.purpose ?? 'transcript-read';
    const family = deriveReadGrantFamily(input.scope, purpose);

    return inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== input.scope.sessionOwnerAccountId) {
            return { ok: false, reason: 'session-owner-mismatch' };
        }
        if (!await aclRevisionIsCurrent(tx, input.scope)) {
            return { ok: false, reason: 'revision-stale' };
        }

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };
        const grantExpiresAt = Number(grant.expiresAt);
        if (!Number.isSafeInteger(grantExpiresAt) || input.now >= grantExpiresAt) {
            return { ok: false, reason: 'expired' };
        }
        // A cap that has already passed authorises nothing, and widening it to
        // the grant's own expiry would ignore what the caller signed for.
        if (!Number.isSafeInteger(input.requestedTokenExpiresAt)
            || input.requestedTokenExpiresAt <= input.now) {
            return { ok: false, reason: 'already-expired' };
        }
        return {
            ok: true,
            resolved: {
                grant: toLiveGrant(grant as never),
                tokenExpiresAt: Math.min(grantExpiresAt, input.requestedTokenExpiresAt),
            },
        };
    });
}

export type ReadRevokeFailure = 'binding-mismatch' | 'revision-stale';

export type ReadRevokeResult =
    | { ok: true; state: 'revoked' | 'tombstoned'; alreadyRevoked: boolean }
    | { ok: false; reason: ReadRevokeFailure };

/**
 * Withdraws a viewer's read grant, and closes the door behind it.
 *
 * A separate function because a read grant is found by a different family: the
 * runner path derives one from a run, and a read row has none. Left to that
 * path, a read grant simply could not be revoked — the lookup would never find
 * it, and a viewer whose access had been withdrawn upstream would keep reading
 * with a bearer nobody could take back.
 *
 * A tombstone is written when there is nothing to revoke yet, for the same
 * reason it is on the runner path: a withdrawal that arrives before the grant
 * must still prevent it. Reading is not exempt — a race between "the parent
 * removed this member" and "the browser asked for a token" is exactly when it
 * matters.
 */
export async function revokeReadGrant(input: {
    scope: ManagedReadScope;
    reason: string;
    now: number;
    purpose?: SessionScopedPurpose;
}): Promise<ReadRevokeResult> {
    const purpose = input.purpose ?? 'transcript-read';
    const family = deriveReadGrantFamily(input.scope, purpose);

    return retryOnUniqueRace(() => inTx(async (tx) => {
        /*
         * The scope is verified even though no bearer identity is.
         *
         * A revoke is authorised by the control assertion, not by whoever holds
         * a token — the viewer whose access is ending may have none. What stops
         * a made-up scope is this: the session has to exist, and it has to
         * belong to the account named as its owner. Without that check the
         * relaxed bearer rule would let a caller write tombstones against
         * sessions it merely guessed at.
         */
        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session || session.accountId !== input.scope.sessionOwnerAccountId) {
            return { ok: false as const, reason: 'binding-mismatch' as const };
        }
        /*
         * A withdrawal from an older generation is refused rather than applied.
         *
         * The case is a removal message that overtakes nothing on the way out
         * but arrives after the member was re-added: applying it would end the
         * access the *newer* decision granted, and the parent would have no way
         * to tell that its re-add had been undone. The tombstone it would have
         * written for its own generation is already there.
         */
        if (!await aclRevisionIsCurrent(tx, input.scope)) {
            return { ok: false as const, reason: 'revision-stale' as const };
        }

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (grant) {
            // The family already ties the row to this scope; this catches a row
            // that somehow carries a different binding rather than withdrawing
            // something other than what the caller named.
            if (!grant.tombstone && (grant.sessionId !== input.scope.sessionId
                || grant.accountId !== input.scope.sessionOwnerAccountId
                || (grant.viewerAccountId ?? null) !== input.scope.viewerAccountId)) {
                return { ok: false as const, reason: 'binding-mismatch' as const };
            }
            if (grant.revokedAt !== null) {
                // Terminal: the first reason stands, so an audit reads what
                // actually ended the access.
                return {
                    ok: true as const,
                    state: (grant.tombstone ? 'tombstoned' : 'revoked') as 'tombstoned' | 'revoked',
                    alreadyRevoked: true,
                };
            }
            await advanceAclRevision(tx, input.scope, input.now);
            await tx.managedSessionGrant.update({
                where: { family },
                data: {
                    revokedAt: BigInt(input.now),
                    revokedReason: input.reason,
                    updatedAt: BigInt(input.now),
                },
            });
            return { ok: true as const, state: 'revoked' as const, alreadyRevoked: false };
        }

        await advanceAclRevision(tx, input.scope, input.now);
        await tx.managedSessionGrant.create({
            data: {
                grantId: `tombstone:${family}`,
                family,
                sessionId: input.scope.sessionId,
                accountId: input.scope.sessionOwnerAccountId,
                viewerAccountId: input.scope.viewerAccountId,
                purpose,
                aclRevision: input.scope.aclRevision,
                renewalSeq: 0,
                expiresAt: BigInt(input.now),
                revokedAt: BigInt(input.now),
                revokedReason: input.reason,
                tombstone: true,
                requestId: `tombstone:${family}`,
                bodyDigest: '',
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true as const, state: 'tombstoned' as const, alreadyRevoked: false };
    }), () => ({ ok: false as const, reason: 'binding-mismatch' as const }));
}
