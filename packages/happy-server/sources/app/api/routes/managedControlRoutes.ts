/**
 * The control plane's write surface.
 *
 * Two independent proofs are required on every route here, and neither is
 * sufficient alone. The account bearer says which account is being acted for;
 * the Ed25519 assertion says the control plane asked. A stolen account token
 * would otherwise be enough to mint session grants for that account, which is
 * the authority this server is being asked to delegate in the first place.
 *
 * A scoped bearer is never accepted. `auth.verifyToken` refuses one by
 * construction — the two token kinds are signed under different services — so a
 * managed child cannot reach these routes even if it learns their paths.
 *
 * The decisions themselves live in `managedAuthorityProjection` and
 * `managedSessionGrant`. These handlers translate HTTP and check who is asking;
 * they do not decide what is allowed, so a second caller of those functions
 * cannot be weaker than this one.
 */

import { z } from 'zod';

import { type Fastify } from '../types';
import { CONTROL_ASSERTION_PURPOSE, type ControlOperation } from '@/app/managed/managedControlAssertion';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import {
    readAuthoritySnapshot,
    syncRunAuthority,
    syncWorkspaceAuthority,
} from '@/app/managed/managedAuthorityProjection';
import { MANAGED_DAEMON_MAX_TTL_MS, parseManagedDaemonClaims } from '@/app/auth/managedDaemonToken';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { issueManagedDaemonGrant } from '@/app/managed/managedDaemonGrant';
import {
    issueReadGrant,
    resolveReadGrant,
    issueSessionGrant,
    revokeReadGrant,
    renewSessionGrant,
    resolveSessionGrant,
    revokeSessionGrant,
    type ManagedScope,
} from '@/app/managed/managedSessionGrant';

export const CONTROL_ASSERTION_HEADER = 'x-happy-control-assertion';

const identifier = z.string().trim().min(1).max(200);
const version = z.number().int().min(0);
/**
 * An instant this server will compare and store. `z.number().int()` alone
 * accepts values past `Number.MAX_SAFE_INTEGER`, where JSON round-trips stop
 * being exact — so the bound is stated here rather than assumed from the
 * validator's version.
 */
const instant = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    .refine(Number.isSafeInteger, { message: 'must be a safe integer' });

const scopeSchema = z.object({
    tenantId: identifier,
    projectId: identifier,
    workspaceId: identifier,
    runtimeId: identifier,
    epoch: version,
    runId: identifier,
    attemptId: identifier,
    sessionId: identifier,
    accountId: identifier,
    workspaceAuthorityVersion: version,
    runAuthorityVersion: version,
}).strict();

const workspaceSyncSchema = z.object({
    ownerAccountId: identifier,
    expectedVersion: version,
    body: z.object({
        workspaceId: identifier,
        tenantId: identifier,
        projectId: identifier,
        epoch: version,
        runtimeId: identifier,
    }).strict(),
}).strict();

const runSyncSchema = z.object({
    expectedVersion: version,
    body: z.object({
        runId: identifier,
        workspaceId: identifier,
        accountId: identifier,
        currentAttemptId: identifier,
        cancelled: z.boolean(),
    }).strict(),
}).strict();

/** Rolls the transaction back: a refusal must not commit what it wrote. */
class MachineBootstrapConflict extends Error {}
class WorkspaceAuthorityChanged extends Error {}
/**
 * The request's lifetime ran out while its rows were being written.
 *
 * Thrown so the transaction rolls back: while it is still open this is fully
 * recoverable, and committing a grant for a lifetime that has already passed
 * leaves a row nobody can mint against and a bootstrap that cannot be reissued
 * under the same body.
 */
class BootstrapExpiredDuringWrite extends Error {}

class DaemonGrantRefused extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

/** How many times the bootstrap transaction may be replayed after a race. */
const MAX_BOOTSTRAP_ATTEMPTS = 2;

/**
 * The wrapped machine key's wire shape, from `wrapDataEncryptionKey`
 * (happy-cli src/api/encryption.ts:94): a version byte, then the bundle
 * `libsodiumEncryptForPublicKey` produces — ephemeral public key (32), nonce
 * (24), and the box over a 32-byte machine key with its 16-byte MAC.
 */
const MACHINE_KEY_ENVELOPE_BYTES = 1 + 32 + 24 + 32 + 16;
const MACHINE_KEY_ENVELOPE_VERSION = 0;

const daemonBootstrapSchema = z.object({
    accountId: z.string(),
    machineId: z.string(),
    runtimeId: z.string(),
    provisioningOperationId: z.string(),
    workspaceId: z.string(),
    projectId: z.string(),
    epoch: z.number().int().min(0),
    daemonGrantId: z.string(),
    requestId: z.string(),
    expiresAt: z.number().int().min(0),
    /** Encrypted machine metadata, as the ordinary machine route takes it. */
    metadata: z.string(),
    /** The account's share of the machine key, wrapped. Write-once. */
    dataEncryptionKey: z.string(),
    /** The server's share, when the deployment provisions one. */
    serverDataEncryptionKey: z.string().nullish(),
});

const mintSchema = z.object({
    scope: scopeSchema,
    grantId: identifier,
    requestId: identifier,
    expiresAt: z.number().int().min(1),
    /**
     * What the grant is for. Omitted means `runner`, which is what every
     * caller before this axis existed was asking for.
     *
     * An unrecognised value is a 400 rather than a default: the server owns
     * this enumeration, and reading an unknown purpose as `runner` would hand
     * execution to a caller who asked for something else entirely.
     */
    purpose: z.enum(['runner', 'transcript-read', 'approval-control']).optional(),
}).strict();

const renewSchema = z.object({
    scope: scopeSchema,
    /**
     * Which grant for this scope is being renewed. Omitted means `runner`.
     *
     * Signed with the rest of the body, so a caller cannot be made to extend a
     * grant of a different purpose than the one it asked about — and without it
     * a read grant could not be renewed at all, because the lookup only ever
     * found the runner's row.
     */
    purpose: z.enum(['runner', 'transcript-read', 'approval-control']).optional(),
    /**
     * The grant the caller believes it holds.
     *
     * Required and signed with the rest of the body. Together with the
     * monotonically increasing family sequence, this identifies the grant
     * generation the caller intends to renew.
     */
    expectedGrantId: identifier,
    expectedRenewalSeq: version,
    expiresAt: z.number().int().min(1),
}).strict();

const snapshotSchema = z.object({
    requestId: identifier,
    tenantId: identifier,
    projectId: identifier,
    workspaceId: identifier,
    runId: identifier,
    accountId: identifier,
}).strict();

const resolveSchema = z.object({
    requestId: identifier,
    scope: scopeSchema,
    requestedTokenExpiresAt: instant,
    /** Which grant for this scope to resolve. Omitted means `runner`. */
    purpose: z.enum(['runner', 'transcript-read', 'approval-control']).optional(),
}).strict();

/**
 * A read grant names no run, and that is the shape of this body.
 *
 * `sessionOwnerAccountId` is the authority the request is checked against — the
 * server compares it with the session and refuses a mismatch rather than
 * adopting whatever the caller said. `viewerAccountId` is who is reading, which
 * may legitimately be a different account on a company project.
 */
const readScopeSchema = z.object({
    tenantId: identifier,
    projectId: identifier,
    sessionId: identifier,
    sessionOwnerAccountId: identifier,
    viewerAccountId: identifier,
    /**
     * The generation of the parent's access list this call belongs to.
     *
     * Required. Every read-grant write is compared against the highest
     * generation this server has applied for the pair, so a message that
     * arrives late — an old mint, an old revoke — is refused rather than
     * silently undoing a newer decision.
     */
    aclRevision: z.number().int().min(0),
}).strict();

const readMintSchema = z.object({
    scope: readScopeSchema,
    grantId: identifier,
    requestId: identifier,
    expiresAt: z.number().int().min(1),
    /**
     * The session key envelope resealed for the viewer, base64.
     *
     * Produced by whoever holds the plaintext key — this server holds only the
     * wrapped envelope and nothing that opens it, so it never makes one and
     * never substitutes the owner's. Absent means the viewer will be told it
     * cannot decrypt, which is the honest answer.
     */
    viewerDataEncryptionKey: z.string().min(1).optional(),
    purpose: z.enum(['transcript-read']).optional(),
}).strict();

/**
 * Answering is bound to a run, so this body carries the full run scope.
 *
 * The difference from reading, stated in the shape: a transcript outlives its
 * run and names none, while an approval is an act on the run that is asking —
 * an answer for a superseded attempt would be answering a question nobody is
 * still posing.
 */
const approvalMintSchema = z.object({
    scope: scopeSchema,
    grantId: identifier,
    requestId: identifier,
    expiresAt: z.number().int().min(1),
    /** The Happy account that will answer. */
    viewerAccountId: identifier,
    /**
     * The generation of the parent's access list this grant belongs to.
     *
     * Required. It is part of the family, and without it a member removed and
     * re-added during the same run finds the family their removal tombstoned —
     * an approval family carries the run, so the two are identical.
     */
    aclRevision: z.number().int().min(0),
    /** The session key resealed for that account, base64. Required unless it owns the session. */
    viewerDataEncryptionKey: z.string().min(1).optional(),
}).strict();

/**
 * Withdrawing one approver's ability to answer.
 *
 * The viewer is part of the family, so it is named here: without it this would
 * find the runner's row, and the answer to "revoke this approver" would be
 * closing the run's own credential instead.
 */
/**
 * Reading a token back for an approval grant that already exists.
 *
 * The recovery path, and deliberately not a mint: a browser loses its bearer on
 * a reload, a new tab or a restart, and minting again is refused for the live
 * family — or, if it were allowed to replace it, would kill the bearer the
 * other tab is answering with.
 */
const approvalResolveSchema = z.object({
    scope: scopeSchema,
    viewerAccountId: identifier,
    /** The generation the caller believes is current; see the mint. */
    aclRevision: z.number().int().min(0),
    requestedTokenExpiresAt: z.number().int().min(1),
}).strict();

const approvalRevokeSchema = z.object({
    scope: scopeSchema,
    reason: z.string().trim().min(1).max(200),
    viewerAccountId: identifier,
    /**
     * The generation this withdrawal belongs to.
     *
     * Compared, so a removal that arrives after the member was re-added is
     * refused rather than ending the access the re-add granted.
     */
    aclRevision: z.number().int().min(0),
}).strict();

/**
 * Reading a token back for a grant that already exists.
 *
 * The recovery path, and deliberately not a mint: a fresh page load, a second
 * tab, or a lost mint response must not rotate the grant the other holder is
 * using. Nothing is written, and the answer is bounded by the expiry the caller
 * signed for.
 */
const readResolveSchema = z.object({
    scope: readScopeSchema,
    requestedTokenExpiresAt: z.number().int().min(1),
    purpose: z.enum(['transcript-read']).optional(),
}).strict();

const readRevokeSchema = z.object({
    scope: readScopeSchema,
    reason: z.string().trim().min(1).max(200),
    purpose: z.enum(['transcript-read']).optional(),
}).strict();

const revokeSchema = z.object({
    scope: scopeSchema,
    reason: z.string().trim().min(1).max(200),
    /**
     * Which grant to withdraw. Omitted means `runner`, so an existing caller
     * withdraws exactly what it withdrew before — and a revoke aimed at a read
     * grant no longer silently closes the run's own credential instead.
     */
    purpose: z.enum(['runner', 'transcript-read', 'approval-control']).optional(),
    /**
     * The viewer the grant was resealed for, when the purpose has one.
     *
     * Part of the family, so omitting it on a non-runner purpose looks for a
     * row that was never written. `/grants/approval/revoke` is the route that
     * does not need the owner's bearer; this one keeps it.
     */
    viewerAccountId: identifier.optional(),
}).strict();

/**
 * Failures that are the caller's mistake about state rather than a refusal to
 * let them act. Everything else is 403: the request was understood and denied.
 */
const CONFLICT_REASONS = new Set([
    'version-conflict', 'body-conflict', 'request-conflict',
    'family-exists', 'renewal-conflict', 'not-extending',
    // Both are the caller's mistake about the family's current state, not a
    // refusal to let it act.
    'grant-id-reused', 'sequence-exhausted',
    // The caller is behind the access list it is acting on: it should re-read
    // its own state, which is a conflict rather than a denial.
    'revision-stale',
]);

function failureStatus(reason: string): number {
    if (CONFLICT_REASONS.has(reason)) return 409;
    if (reason === 'run-unknown' || reason === 'workspace-missing' || reason === 'grant-unknown') return 404;
    return 403;
}

export function managedControlRoutes(
    app: Fastify,
    getRuntime: () => ManagedControlRuntime | null,
) {
    /**
     * Refuses before Fastify validates the body.
     *
     * Fastify runs schema validation ahead of `preHandler`, so an authentication
     * check placed there answers 400 to an anonymous caller with a malformed
     * body — telling them the route's shape before establishing they may ask at
     * all. `onRequest` runs first, which is where both the bearer and the
     * unconfigured refusal belong.
     */
    async function requireConfigured(
        _request: unknown,
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) {
        if (!getRuntime()) {
            // Unconfigured is refusal, never a fallback to the bearer alone.
            return reply.code(503).send({ error: 'Managed control is not configured' });
        }
    }

    /**
     * The second proof, checked against the exact body this handler will act on
     * — which is why it cannot move any earlier than the parsed request.
     */
    function authorize(
        request: { headers: Record<string, unknown>; body: unknown; userId: string },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
        operation: ControlOperation,
    ): ManagedControlRuntime | null {
        const runtime = getRuntime();
        if (!runtime) {
            reply.code(503).send({ error: 'Managed control is not configured' });
            return null;
        }
        const header = request.headers[CONTROL_ASSERTION_HEADER];
        if (typeof header !== 'string' || header.length === 0) {
            reply.code(403).send({ error: 'Missing control assertion' });
            return null;
        }
        const verified = runtime.assertions.verify({
            assertion: header,
            operation,
            body: request.body,
            now: Date.now(),
        });
        if (!verified.ok) {
            reply.code(403).send({ error: 'Invalid control assertion', reason: verified.reason });
            return null;
        }
        return runtime;
    }

    app.post('/v1/managed/control/authority/workspace', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: workspaceSyncSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-sync')) return;
        // The workspace row carries no owner of its own, so the caller states
        // which account it is acting for and the bearer has to be that account.
        if (request.body.ownerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await syncWorkspaceAuthority({
            body: request.body.body,
            expectedVersion: request.body.expectedVersion,
            now: Date.now(),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ version: result.version, idempotent: result.idempotent });
    });

    app.post('/v1/managed/control/authority/run', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: runSyncSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-sync')) return;
        if (request.body.body.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await syncRunAuthority({
            body: request.body.body,
            expectedVersion: request.body.expectedVersion,
            now: Date.now(),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ version: result.version, idempotent: result.idempotent });
    });

    /**
     * Reads both projections so a control plane that lost its own memory can
     * sign the next body against what this server actually holds.
     *
     * A signed POST rather than a GET: the verifier binds the request body, so
     * a GET's path and query would carry no proof at all.
     */
    app.post('/v1/managed/control/authority/snapshot', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: snapshotSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-snapshot')) return;
        if (request.body.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const snapshot = await readAuthoritySnapshot({
            tenantId: request.body.tenantId,
            projectId: request.body.projectId,
            workspaceId: request.body.workspaceId,
            runId: request.body.runId,
            accountId: request.body.accountId,
        });
        // A mismatch is a refusal, never a `null` that reads as "create it".
        if (!snapshot.ok) return reply.code(403).send({ error: snapshot.reason });
        return reply.send({
            requestId: request.body.requestId,
            workspace: snapshot.workspace,
            run: snapshot.run,
        });
    });

    /**
     * Registers the Machine a managed runtime will run as, and issues that
     * runtime's own credential.
     *
     * ## Why the daemon never gets the account bearer
     *
     * The Machine belongs to the caller's account — that is how the runtime
     * appears in their list — but the daemon runs code the customer's own
     * agent can influence. An account bearer reaches every session on that
     * account, so what goes to the runtime is a credential of its own purpose
     * that names the account and can act as nothing on it.
     *
     * ## Why the key material comes from the caller
     *
     * `POST /v1/machines` treats `dataEncryptionKey` as write-once: an
     * existing key is never replaced. So the trusted parent stores the
     * envelopes durably *before* the first call and resends the same ones on
     * every retry — if it minted a fresh key after a lost response, it would
     * hold a key this server never kept and the daemon could never attach.
     * This route follows the same rule: it creates the Machine when absent and
     * otherwise adopts what is stored, never overwriting.
     */
    app.post('/v1/managed/control/daemon/bootstrap', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: daemonBootstrapSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'daemon-bootstrap');
        if (!runtime) return;
        const body = request.body;
        if (body.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();

        // Everything the credential will assert, checked before a single row
        // is written. These used to be caught at mint — after the Machine and
        // the grant existed — so a refusal left rows behind and the corrected
        // retry collided on the digest of the body it was fixing.
        const identifiers = [
            body.accountId, body.machineId, body.runtimeId, body.provisioningOperationId,
            body.workspaceId, body.projectId, body.daemonGrantId, body.requestId,
        ];
        // Judged by the parser the credential will be read back through, not by
        // a second set of conditions written here. An emptiness check alone let
        // an id longer than the token's ceiling commit the Machine and the
        // grant and fail only at mint — the refusal-after-mutation this route
        // was restructured to prevent. It also let ' machine ' through, which
        // the parser trims: the row would hold the padded id while the token
        // claimed the trimmed one, one credential naming two identities.
        //
        // The probe puts the candidate in every id slot and requires it to come
        // back unchanged, so the ceiling and the trimming stay defined in one
        // place and canonical form is required without changing what tokens
        // accept. `generation` is not submitted — the grant row owns it — and
        // the numeric axes are checked below on their own terms.
        const isCanonicalIdentifier = (value: string): boolean => parseManagedDaemonClaims({
            v: 1,
            accountId: value,
            machineId: value,
            runtimeId: value,
            provisioningOperationId: value,
            daemonGrantId: value,
            generation: 0,
            workspaceId: value,
            projectId: value,
            epoch: 0,
            expiresAt: 1,
        })?.machineId === value;
        if (!identifiers.every(isCanonicalIdentifier)) {
            return reply.code(400).send({ error: 'malformed' });
        }
        if (body.expiresAt <= now) return reply.code(400).send({ error: 'expired' });
        if (body.expiresAt - now > MANAGED_DAEMON_MAX_TTL_MS) {
            return reply.code(400).send({ error: 'ttl-too-long' });
        }
        // The envelope's shape is the one its single assembly point produces
        // (`wrapDataEncryptionKey`, happy-cli src/api/encryption.ts:94):
        // version 0x00 ‖ ephemeralPub(32) ‖ nonce(24) ‖ box(32-byte machine key
        // + 16-byte MAC). Canonical base64 alone accepted `AQ==`, a version-1
        // byte, and anything short or long — and this key is write-once, so a
        // wrong one is registered permanently and the machine can never be
        // read by the account it was supposedly wrapped for.
        //
        // Shape is all this server can judge. It does not hold the machine key
        // or the recipient's private key, so whether the box actually contains
        // that key is not something it can claim — and it does not.
        const decodeEnvelope = (value: string): Buffer | null => {
            const decoded = Buffer.from(value, 'base64');
            if (decoded.length !== MACHINE_KEY_ENVELOPE_BYTES) return null;
            if (decoded[0] !== MACHINE_KEY_ENVELOPE_VERSION) return null;
            return decoded.toString('base64') === value ? decoded : null;
        };
        const keyBytes = decodeEnvelope(body.dataEncryptionKey);
        if (!keyBytes) return reply.code(400).send({ error: 'malformed' });
        const serverKeyBytes = body.serverDataEncryptionKey
            ? decodeEnvelope(body.serverDataEncryptionKey)
            : null;
        if (body.serverDataEncryptionKey && !serverKeyBytes) {
            return reply.code(400).send({ error: 'malformed' });
        }

        // The projection first, and exactly. A credential minted for a
        // workspace the control plane has never projected — or for a
        // generation, runtime or project other than the one it recorded — is a
        // credential for something nobody has fenced. Checked before anything
        // is written, so a refusal leaves no machine and no grant behind.
        const authority = await db.managedWorkspaceAuthority.findUnique({
            where: { workspaceId: body.workspaceId },
        });
        if (!authority
            || authority.epoch !== body.epoch
            || authority.runtimeId !== body.runtimeId
            || authority.projectId !== body.projectId) {
            return reply.code(409).send({ error: 'workspace-authority-mismatch' });
        }

        const submittedKey = keyBytes;
        const submittedServerKey = serverKeyBytes;

        // Every field of the precreate body is immutable. A retry that changed
        // one is a different request wearing the same id, and adopting it would
        // hand back a credential for a machine whose contents the parent cannot
        // read.
        const machineMismatch = (existing: {
            metadata: string;
            dataEncryptionKey: Uint8Array | null;
            serverDataEncryptionKey: Uint8Array | null;
        }) => {
            if (existing.metadata !== body.metadata) return true;
            if (existing.dataEncryptionKey
                && !Buffer.from(existing.dataEncryptionKey).equals(submittedKey)) return true;
            // Both directions. Stored-null against submitted-non-null used to
            // compare equal, which let a different body through as if it were
            // the same request — and only once the machine already had a key,
            // where adopting the wrong one is unrecoverable.
            const storedServer = existing.serverDataEncryptionKey
                ? Buffer.from(existing.serverDataEncryptionKey)
                : null;
            if ((storedServer === null) !== (submittedServerKey === null)) {
                // Before the account share exists the machine is still
                // unwritten, and the submitted body is what will fill it.
                if (existing.dataEncryptionKey) return true;
            } else if (storedServer && submittedServerKey && !storedServer.equals(submittedServerKey)) {
                return true;
            }
            return false;
        };

        // Two replicas retrying together both find no machine and both insert.
        // The loser gets a unique violation, which is a convergence signal
        // rather than an error the caller should ever see.
        //
        // The recovery is to run the whole transaction again, not to patch up
        // around it afterwards. Everything this decision rests on — the
        // projection, the Machine, the key material — was read inside the
        // transaction that failed, and a repair built on those reads is built
        // on a snapshot the database has already rejected. The retry is
        // bounded: a second violation would mean a third writer, and this is
        // not a place to loop against the database.
        let issued: Awaited<ReturnType<typeof issueManagedDaemonGrant>> | null = null;
        for (let attempt = 1; ; attempt++) {
          try {
            // A previous attempt may have got as far as issuing before failing.
            issued = null;
            await inTx(async (tx) => {
                // Re-read inside the transaction that writes. The check above
                // happened before this section and a generation raised in
                // between would otherwise be committed against.
                const settledAuthority = await tx.managedWorkspaceAuthority.findUnique({
                    where: { workspaceId: body.workspaceId },
                });
                if (!settledAuthority
                    || settledAuthority.epoch !== body.epoch
                    || settledAuthority.runtimeId !== body.runtimeId
                    || settledAuthority.projectId !== body.projectId) {
                    throw new WorkspaceAuthorityChanged();
                }

                const existing = await tx.machine.findFirst({
                where: { accountId: request.userId, id: body.machineId },
            });
            if (existing) {
                if (machineMismatch(existing)) {
                    // Thrown, not returned: a refusal returned from inside the
                    // transaction commits whatever it has already written.
                    throw new MachineBootstrapConflict();
                }
                if (!existing.dataEncryptionKey) {
                    // Write-once, and only from absent. `updateMany` with the
                    // null guard makes the loser of a race a no-op rather than
                    // an overwrite.
                    const claimed = await tx.machine.updateMany({
                        where: { id: existing.id, dataEncryptionKey: null },
                        data: {
                            dataEncryptionKey: new Uint8Array(submittedKey),
                            ...(submittedServerKey
                                ? { serverDataEncryptionKey: new Uint8Array(submittedServerKey) }
                                : {}),
                        },
                    });
                    // Read back what actually landed, whether this call won the
                    // guard or not. The row above was read before it ran, so a
                    // loser would otherwise carry on believing its own material
                    // was stored — and hand back a credential for a machine
                    // whose contents it cannot read.
                    const settled = await tx.machine.findFirst({ where: { id: existing.id } });
                    const lost = claimed.count === 0;
                    if (!settled || !settled.dataEncryptionKey
                        || machineMismatch(settled)
                        || (lost && !Buffer.from(settled.dataEncryptionKey).equals(submittedKey))) {
                        throw new MachineBootstrapConflict();
                    }
                }
                } else {
                    await tx.machine.create({
                    data: {
                        id: body.machineId,
                        accountId: request.userId,
                        metadata: body.metadata,
                        dataEncryptionKey: new Uint8Array(submittedKey),
                        ...(submittedServerKey
                            ? { serverDataEncryptionKey: new Uint8Array(submittedServerKey) }
                            : {}),
                        },
                    });
                }

                // Same transaction: a Machine created for a grant that then
                // fails to issue is a machine nobody asked for, and a grant
                // without its machine is a credential for nothing.
                issued = await issueManagedDaemonGrant({
                    scope: {
                        accountId: request.userId,
                        machineId: body.machineId,
                        runtimeId: body.runtimeId,
                        provisioningOperationId: body.provisioningOperationId,
                        workspaceId: body.workspaceId,
                        projectId: body.projectId,
                        epoch: body.epoch,
                    },
                    daemonGrantId: body.daemonGrantId,
                    requestId: body.requestId,
                    expiresAt: body.expiresAt,
                    now,
                    tx: tx as never,
                });
                if (!issued.ok) {
                    // Same reason: the grant issue reports a refusal rather
                    // than throwing, and a Machine created alongside it would
                    // otherwise commit — a machine nobody asked for, which then
                    // makes every corrected retry look like a mismatch.
                    throw new DaemonGrantRefused(issued.reason);
                }

                // The last act of the transaction. The work above can wait on
                // locks and be re-run, so the lifetime checked on arrival may
                // already be spent by now. While this transaction is open the
                // refusal is free — nothing is kept — which is why the check
                // belongs here and not only at mint.
                if (Date.now() >= body.expiresAt) throw new BootstrapExpiredDuringWrite();
            });
            break;
          } catch (error) {
            if (error instanceof WorkspaceAuthorityChanged) {
                return reply.code(409).send({ error: 'workspace-authority-mismatch' });
            }
            if (error instanceof MachineBootstrapConflict) {
                return reply.code(409).send({ error: 'machine-bootstrap-mismatch' });
            }
            if (error instanceof DaemonGrantRefused) {
                return reply.code(409).send({ error: error.reason });
            }
            if (error instanceof BootstrapExpiredDuringWrite) {
                return reply.code(400).send({ error: 'expired' });
            }
            if ((error as { code?: string }).code !== 'P2002') throw error;
            // The other replica got there first. On the next pass the Machine
            // and the grant are found rather than created, and the same
            // comparisons decide whether what it stored is this body.
            if (attempt >= MAX_BOOTSTRAP_ATTEMPTS) {
                // Still colliding after a clean re-read, so this is not two
                // replicas converging on one body: an identifier in it already
                // belongs to something else — a reused grant id, most often.
                // That is a conflict, and calling it a server fault would
                // invite the caller to retry it forever.
                return reply.code(409).send({ error: 'daemon-grant-conflict' });
            }
          }
        }
        if (!issued) return reply.code(500).send({ error: 'daemon grant was not issued' });

        const result = issued as Awaited<ReturnType<typeof issueManagedDaemonGrant>>;
        if (!result.ok) return reply.code(409).send({ error: result.reason });

        // Minted from the stored row, never from the request: a credential must
        // never claim more than the grant that authorises it.
        const minted = await runtime.daemonTokens.mint({
            v: 1,
            accountId: result.grant.accountId,
            machineId: result.grant.machineId,
            runtimeId: result.grant.runtimeId,
            provisioningOperationId: result.grant.provisioningOperationId,
            workspaceId: result.grant.workspaceId,
            projectId: result.grant.projectId,
            epoch: result.grant.epoch,
            daemonGrantId: result.grant.daemonGrantId,
            generation: result.grant.generation,
            // The lower of the two, always. An idempotent retry can return a
            // row that has since been renewed to a later expiry, and minting
            // against that would let a replayed original request collect a
            // credential outliving what it asked for.
            expiresAt: Math.min(Number(result.grant.expiresAt), body.expiresAt),
            // Read again here rather than reusing the arrival time. What
            // happens in between is unbounded, and minting against the older
            // reading would hand back a credential already expired in real
            // time and report it as a success.
            //
            // This is the backstop, not the recovery: the transaction refuses
            // and rolls back while it still can. Past its commit the grant is
            // durable and its body is immutable, so a new lifetime is not
            // reachable from here at all — not by resending this body with a
            // later expiry, and not by a new request id, which would collide
            // on the one grant this runtime generation may have. The control
            // plane recovers it by renewing the existing grant under its own
            // fresh proof.
        }, Date.now());
        if (!minted.ok) return reply.code(400).send({ error: minted.reason });

        return reply.send({
            token: minted.token,
            daemonGrantId: result.grant.daemonGrantId,
            generation: result.grant.generation,
            machineId: result.grant.machineId,
            expiresAt: Math.min(Number(result.grant.expiresAt), body.expiresAt),
            idempotent: result.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/mint', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: mintSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-mint');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        const issued = await issueSessionGrant({
            scope,
            grantId: request.body.grantId,
            requestId: request.body.requestId,
            expiresAt: request.body.expiresAt,
            now,
            ...(request.body.purpose ? { purpose: request.body.purpose } : {}),
        });
        if (!issued.ok) return reply.code(failureStatus(issued.reason)).send({ error: issued.reason });

        /*
         * This route mints **run-scoped** tokens, and the run axes are now
         * nullable on the row because a read grant has none. A row reaching
         * here without them is not a shape to paper over with defaults — it is
         * a grant that was issued through the read path and must be minted
         * through the read path too.
         */
        const bound = issued.grant;
        if (bound.workspaceId === null || bound.runId === null || bound.attemptId === null
            || bound.epoch === null || bound.workspaceAuthorityVersion === null
            || bound.runAuthorityVersion === null) {
            return reply.code(409).send({ error: 'grant-not-run-scoped' });
        }

        // The token is minted from the stored grant, not from the request: a
        // bearer must never claim more than the row that authorises it.
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: bound.grantId,
            accountId: bound.accountId,
            sessionId: bound.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: bound.workspaceId,
            runtimeId: scope.runtimeId,
            runId: bound.runId,
            attemptId: bound.attemptId,
            epoch: bound.epoch,
            workspaceAuthorityVersion: bound.workspaceAuthorityVersion,
            runAuthorityVersion: bound.runAuthorityVersion,
            expiresAt: issued.grant.expiresAt,
            // From the stored grant, not the request: the token says what the
            // row authorises, and a caller that asked for one purpose and was
            // given another must be able to see that and refuse.
            purpose: issued.grant.purpose,
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: issued.grant.grantId,
            expiresAt: issued.grant.expiresAt,
            renewalSeq: issued.grant.renewalSeq,
            purpose: issued.grant.purpose,
            idempotent: issued.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/renew', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: renewSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-renew');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        const renewed = await renewSessionGrant({
            scope,
            expectedGrantId: request.body.expectedGrantId,
            expectedRenewalSeq: request.body.expectedRenewalSeq,
            expiresAt: request.body.expiresAt,
            now,
            ...(request.body.purpose ? { purpose: request.body.purpose } : {}),
        });
        if (!renewed.ok) return reply.code(failureStatus(renewed.reason)).send({ error: renewed.reason });

        /*
         * Same rule as the mint route: this surface is run-scoped, and a row
         * without run axes came from the read path and belongs to it.
         */
        const bound = renewed.grant;
        if (bound.workspaceId === null || bound.runId === null || bound.attemptId === null
            || bound.epoch === null || bound.workspaceAuthorityVersion === null
            || bound.runAuthorityVersion === null) {
            return reply.code(409).send({ error: 'grant-not-run-scoped' });
        }

        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: bound.grantId,
            accountId: bound.accountId,
            sessionId: bound.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: bound.workspaceId,
            runtimeId: scope.runtimeId,
            runId: bound.runId,
            attemptId: bound.attemptId,
            epoch: bound.epoch,
            workspaceAuthorityVersion: bound.workspaceAuthorityVersion,
            runAuthorityVersion: bound.runAuthorityVersion,
            expiresAt: bound.expiresAt,
            // Carried across the renewal: a renewal extends a grant, it does
            // not reclassify one.
            purpose: bound.purpose,
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: renewed.grant.grantId,
            expiresAt: renewed.grant.expiresAt,
            renewalSeq: renewed.grant.renewalSeq,
            purpose: renewed.grant.purpose,
            idempotent: renewed.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    /**
     * Recovers the token for a grant that already exists.
     *
     * It writes nothing, but it issues a credential, so it carries the same two
     * proofs and the same scope checks as a mint. The token's expiry is the
     * lesser of the grant's own and the one the caller signed for, and the
     * expiry is re-checked at the moment of issue: the read may have waited on
     * the database long enough for the grant to lapse in between.
     */
    app.post('/v1/managed/control/grants/resolve', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: resolveSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-resolve');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const resolved = await resolveSessionGrant({
            scope,
            requestedTokenExpiresAt: request.body.requestedTokenExpiresAt,
            now: Date.now(),
            ...(request.body.purpose ? { purpose: request.body.purpose } : {}),
        });
        if (!resolved.ok) {
            return reply.code(failureStatus(resolved.reason)).send({ error: resolved.reason });
        }
        const { grant, tokenExpiresAt } = resolved.resolved;

        // Issued against the clock now, not the one the read started with.
        const issuedAt = Date.now();
        if (tokenExpiresAt <= issuedAt) {
            return reply.code(403).send({ error: 'expired' });
        }
        // Same rule again: a row without run axes is a read grant, and this
        // surface resolves run-scoped ones.
        if (grant.workspaceId === null || grant.runId === null || grant.attemptId === null
            || grant.epoch === null || grant.workspaceAuthorityVersion === null
            || grant.runAuthorityVersion === null) {
            return reply.code(409).send({ error: 'grant-not-run-scoped' });
        }
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: grant.grantId,
            accountId: grant.accountId,
            sessionId: grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: grant.workspaceId,
            runtimeId: scope.runtimeId,
            runId: grant.runId,
            attemptId: grant.attemptId,
            epoch: grant.epoch,
            workspaceAuthorityVersion: grant.workspaceAuthorityVersion,
            runAuthorityVersion: grant.runAuthorityVersion,
            expiresAt: tokenExpiresAt,
            purpose: grant.purpose,
        }, issuedAt);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            requestId: request.body.requestId,
            scope,
            grantId: grant.grantId,
            token: minted.token,
            tokenExpiresAt,
            grantExpiresAt: grant.expiresAt,
            purpose: grant.purpose,
            renewalSeq: grant.renewalSeq,
        });
    });

    /**
     * Issues a bearer for reading a transcript.
     *
     * Separate from `grants/mint` because what it produces is a different kind
     * of thing: no run, a viewer, and a lifetime governed by a project's access
     * list rather than by a run's. Sharing the route would mean one assertion
     * could mint either, and a control plane authorised to start work would be
     * authorised to hand out reading — and the reverse.
     */
    app.post('/v1/managed/control/grants/read/mint', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: readMintSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'read-grant-mint');
        if (!runtime) return;
        const scope = request.body.scope;
        /*
         * The bearer is the **viewer**, not the owner.
         *
         * A shared project is read by a member whose Happy account is not the
         * session owner's, and that member's token is what the parent has —
         * the owner's bearer is not available and must not be invented. So the
         * comparison here is "you are minting for yourself", and the ownership
         * claim is verified where it can be: against the session row, inside
         * `issueReadGrant`, which refuses a mismatch rather than adopting it.
         *
         * What decides that this viewer *may* read this project is the control
         * assertion this route already required — the parent's ACL, proved by a
         * signature only the parent holds. Requiring the owner's bearer instead
         * made every shared read impossible.
         */
        if (scope.viewerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer is not the viewer of this scope' });
        }

        const now = Date.now();
        const issued = await issueReadGrant({
            scope,
            grantId: request.body.grantId,
            requestId: request.body.requestId,
            expiresAt: request.body.expiresAt,
            now,
            ...(request.body.viewerDataEncryptionKey
                ? { viewerDataEncryptionKey: request.body.viewerDataEncryptionKey }
                : {}),
        });
        if (!issued.ok) return reply.code(failureStatus(issued.reason)).send({ error: issued.reason });

        // Minted from the stored row, and in the read shape: no run axes, and
        // the viewer the row records rather than the one the request claimed.
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: issued.grant.grantId,
            accountId: issued.grant.accountId,
            sessionId: issued.grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            expiresAt: issued.grant.expiresAt,
            purpose: issued.grant.purpose,
            ...(issued.grant.viewerAccountId ? { viewerAccountId: issued.grant.viewerAccountId } : {}),
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: issued.grant.grantId,
            expiresAt: issued.grant.expiresAt,
            purpose: issued.grant.purpose,
            viewerAccountId: issued.grant.viewerAccountId ?? null,
            idempotent: issued.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    /**
     * Withdraws one viewer's reading.
     *
     * The run-scoped revoke cannot reach these rows — it derives its family
     * from a run, and a read grant has none — so without this a viewer removed
     * from a project kept a bearer nobody could take back.
     */
    /**
     * Issues a bearer for answering permission prompts on a live run.
     *
     * Separate from the read route because the authority is different: this one
     * is compared against the **current** run authority, so a grant cannot be
     * minted for an attempt that has been superseded. Separate from the runner
     * route because what it authorises is one narrow act — the allowlist gives
     * it the `permission` RPC and nothing else.
     */
    app.post('/v1/managed/control/grants/read/resolve', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: readResolveSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'read-grant-resolve');
        if (!runtime) return;
        const scope = request.body.scope;
        // Same rule as the mint route: the parent holds the viewer's token, and
        // a caller may only recover a bearer for itself.
        if (scope.viewerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer is not the viewer of this scope' });
        }

        const resolved = await resolveReadGrant({
            scope,
            requestedTokenExpiresAt: request.body.requestedTokenExpiresAt,
            now: Date.now(),
        });
        if (!resolved.ok) {
            return reply.code(failureStatus(resolved.reason)).send({ error: resolved.reason });
        }
        const { grant, tokenExpiresAt } = resolved.resolved;

        // Against the clock now, not the one the read started with.
        const issuedAt = Date.now();
        if (tokenExpiresAt <= issuedAt) return reply.code(403).send({ error: 'expired' });
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: grant.grantId,
            accountId: grant.accountId,
            sessionId: grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            expiresAt: tokenExpiresAt,
            purpose: grant.purpose,
            ...(grant.viewerAccountId ? { viewerAccountId: grant.viewerAccountId } : {}),
        }, issuedAt);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: grant.grantId,
            /** The token's own expiry, which may be earlier than the grant's. */
            expiresAt: tokenExpiresAt,
            grantExpiresAt: grant.expiresAt,
            purpose: grant.purpose,
            viewerAccountId: grant.viewerAccountId ?? null,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/approval/mint', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: approvalMintSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'approval-grant-mint');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        // The bearer is the approver, as on the read route: the parent holds
        // that member's token, never the session owner's.
        if (request.body.viewerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer is not the approver of this scope' });
        }

        const now = Date.now();
        const issued = await issueSessionGrant({
            scope,
            grantId: request.body.grantId,
            requestId: request.body.requestId,
            expiresAt: request.body.expiresAt,
            now,
            purpose: 'approval-control',
            viewerAccountId: request.body.viewerAccountId,
            aclRevision: request.body.aclRevision,
            ...(request.body.viewerDataEncryptionKey
                ? { viewerDataEncryptionKey: request.body.viewerDataEncryptionKey }
                : {}),
        });
        if (!issued.ok) return reply.code(failureStatus(issued.reason)).send({ error: issued.reason });

        const bound = issued.grant;
        if (bound.workspaceId === null || bound.runId === null || bound.attemptId === null
            || bound.epoch === null || bound.workspaceAuthorityVersion === null
            || bound.runAuthorityVersion === null) {
            // An approval grant without a run is not one: the run is what it
            // answers for.
            return reply.code(409).send({ error: 'grant-not-run-scoped' });
        }
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: bound.grantId,
            accountId: bound.accountId,
            sessionId: bound.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: bound.workspaceId,
            runtimeId: scope.runtimeId,
            runId: bound.runId,
            attemptId: bound.attemptId,
            epoch: bound.epoch,
            workspaceAuthorityVersion: bound.workspaceAuthorityVersion,
            runAuthorityVersion: bound.runAuthorityVersion,
            expiresAt: bound.expiresAt,
            purpose: bound.purpose,
            ...(bound.viewerAccountId ? { viewerAccountId: bound.viewerAccountId } : {}),
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: bound.grantId,
            expiresAt: bound.expiresAt,
            purpose: bound.purpose,
            viewerAccountId: bound.viewerAccountId ?? null,
            idempotent: issued.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/approval/resolve', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: approvalResolveSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'approval-grant-resolve');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        // The approver's own bearer, as on the mint. Withdrawal is the one that
        // relaxes this, because there the bearer may be gone by design.
        if (request.body.viewerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer is not the approver of this scope' });
        }

        /*
         * The same resolve the runner path uses, with the approval family's own
         * axes. That matters here more than on the transcript side: an approval
         * names the run it answers for, so the run axes are compared against
         * the current authority and a grant from a superseded attempt is
         * refused rather than handed back — answering a question nobody is
         * still posing is the thing this whole purpose exists to prevent.
         */
        const resolved = await resolveSessionGrant({
            scope,
            requestedTokenExpiresAt: request.body.requestedTokenExpiresAt,
            now: Date.now(),
            purpose: 'approval-control',
            viewerAccountId: request.body.viewerAccountId,
            aclRevision: request.body.aclRevision,
        });
        if (!resolved.ok) {
            return reply.code(failureStatus(resolved.reason)).send({ error: resolved.reason });
        }
        const { grant, tokenExpiresAt } = resolved.resolved;
        if (grant.workspaceId === null || grant.runId === null || grant.attemptId === null
            || grant.epoch === null || grant.workspaceAuthorityVersion === null
            || grant.runAuthorityVersion === null) {
            // An approval grant without a run is not one.
            return reply.code(409).send({ error: 'grant-not-run-scoped' });
        }

        const issuedAt = Date.now();
        if (tokenExpiresAt <= issuedAt) return reply.code(403).send({ error: 'expired' });
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: grant.grantId,
            accountId: grant.accountId,
            sessionId: grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: grant.workspaceId,
            runtimeId: scope.runtimeId,
            runId: grant.runId,
            attemptId: grant.attemptId,
            epoch: grant.epoch,
            workspaceAuthorityVersion: grant.workspaceAuthorityVersion,
            runAuthorityVersion: grant.runAuthorityVersion,
            expiresAt: tokenExpiresAt,
            purpose: grant.purpose,
            ...(grant.viewerAccountId ? { viewerAccountId: grant.viewerAccountId } : {}),
        }, issuedAt);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: grant.grantId,
            /** The token's own expiry, which may be earlier than the grant's. */
            expiresAt: tokenExpiresAt,
            grantExpiresAt: grant.expiresAt,
            purpose: grant.purpose,
            viewerAccountId: grant.viewerAccountId ?? null,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/approval/revoke', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: approvalRevokeSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'approval-grant-revoke')) return;
        /*
         * The approver's own bearer is **not** required, for the same reason it
         * is not on the read path: the removals that matter — a member dropped
         * from the project, an account unlinked, a credential already gone —
         * are exactly the ones where that bearer cannot be produced. The
         * authority is the signed control assertion, and the scope is still
         * verified in full, viewer included; only the bearer identity is
         * relaxed.
         */
        const result = await revokeSessionGrant({
            scope: request.body.scope as ManagedScope,
            reason: request.body.reason,
            now: Date.now(),
            purpose: 'approval-control',
            viewerAccountId: request.body.viewerAccountId,
            aclRevision: request.body.aclRevision,
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ state: result.state, alreadyRevoked: result.alreadyRevoked });
    });

    app.post('/v1/managed/control/grants/read/revoke', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: readRevokeSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'read-grant-revoke');
        if (!runtime) return;
        const scope = request.body.scope;
        /*
         * Withdrawal does **not** require the viewer's own bearer.
         *
         * The case that matters is precisely the one where it is unavailable: a
         * member removed from a project, an account unlinked, a credential
         * already revoked. Requiring the viewer to co-operate in ending their
         * own access would mean the removals that matter most are the ones that
         * cannot be carried out.
         *
         * What authorises this is the **control assertion** — a signature only
         * the trusted parent holds, checked above — and it is the parent that
         * owns the access list. The bearer is not the authority here.
         *
         * The scope is still fully specified and still checked: the session
         * must exist and must belong to the account named as its owner, so a
         * revoke cannot be aimed at a scope the caller made up. Only the
         * *bearer identity* requirement is relaxed, not the scope.
         */
        const result = await revokeReadGrant({
            scope, reason: request.body.reason, now: Date.now(),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ state: result.state, alreadyRevoked: result.alreadyRevoked });
    });

    app.post('/v1/managed/control/grants/revoke', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: revokeSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'grant-revoke')) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await revokeSessionGrant({
            scope,
            reason: request.body.reason,
            now: Date.now(),
            ...(request.body.purpose ? { purpose: request.body.purpose } : {}),
            ...(request.body.viewerAccountId ? { viewerAccountId: request.body.viewerAccountId } : {}),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ state: result.state, alreadyRevoked: result.alreadyRevoked });
    });
}

export const MANAGED_CONTROL_PURPOSE = CONTROL_ASSERTION_PURPOSE;
