/**
 * Tokens a managed child holds, kept structurally apart from account tokens.
 *
 * The separation is a different privacy-kit *service*, which is bound into the
 * signature. That is what makes the two kinds non-interchangeable: an account
 * verifier cannot accept a scoped token even by mistake, and a server built
 * before this existed rejects one for the same reason. Sharing a service and
 * distinguishing by a payload field would leave every existing caller — all of
 * which flatten a verified token to `userId` — one missed check away from
 * handing a child full account authority.
 *
 * Nothing here is cached. A scoped token names a specific run and attempt whose
 * grant can be revoked at any moment, so each use is verified afresh; the
 * account cache in `auth.ts` must never see one.
 *
 * This module verifies the *shape and signature* of a bearer. Whether the grant
 * it names is still live — the row, the authority versions, the epoch — is a
 * separate check the caller performs against the database on every action.
 *
 * One constraint comes from privacy-kit: it silently drops the standard JWT
 * reserved names (`jti`, `iat`, `exp`, `sub`, `aud`, `iss`, `nbf`) from the
 * `extras` it carries. A grant id shipped as `jti` would simply disappear, so
 * the fields here avoid those names and a test pins the behaviour.
 */

import * as privacyKit from 'privacy-kit';

/** The service the existing account tokens are signed under. */
export const ACCOUNT_TOKEN_SERVICE = 'handy';
/** Deliberately distinct, so the signatures do not interchange. */
export const SESSION_SCOPED_TOKEN_SERVICE = 'happy-session-scoped';

const SCOPED_TOKEN_VERSION = 1;
const MAX_ID_LENGTH = 200;

/**
 * The full scope a scoped bearer names. Every field is carried in the signed
 * payload so a caller can compare the bearer against the authority projection
 * without a second lookup deciding what the token meant.
 */
/**
 * What a grant is for, and therefore what its token may reach.
 *
 *  - `runner` — the run itself: posting messages, registering tools. The
 *    historical behaviour and the default.
 *  - `transcript-read` — reading what was said. Deliberately **not** tied to a
 *    live run: a finished run, a stopped runtime and a session that has since
 *    been replaced all still have transcripts somebody is entitled to read.
 *  - `approval-control` — answering permission prompts. This one *is* tied to
 *    the current run, because an approval that arrived for a superseded attempt
 *    would be answering a question nobody is still asking.
 */
export const SESSION_SCOPED_PURPOSES = ['runner', 'transcript-read', 'approval-control'] as const;
export type SessionScopedPurpose = (typeof SESSION_SCOPED_PURPOSES)[number];

export type SessionScopedClaims = {
    v: number;
    /**
     * Grant identity. The database row is the authority; this only names it.
     * Not called `jti` because privacy-kit strips that name from `extras`.
     */
    grantId: string;
    /**
     * The account this run acts as. Pinned per run and session, never inherited
     * from a workspace binding — the same project may legitimately run under a
     * different account later.
     */
    accountId: string;
    sessionId: string;
    /** Immutable ownership binding of the workspace. */
    tenantId: string;
    projectId: string;
    /**
     * The execution axes, and they are **absent on a read token**.
     *
     * A transcript outlives the run that produced it: a finished run, a stopped
     * runtime and a session that has since been replaced all still have
     * transcripts somebody is entitled to read. Requiring these to read one is
     * what made a dormant project unreadable — there is no live generation to
     * name, and naming a dead one would be a claim about something that no
     * longer exists.
     *
     * `approval-control` keeps them: answering a permission prompt is an act on
     * the run that is asking, and an approval for a superseded attempt would be
     * answering a question nobody is still posing.
     */
    workspaceId?: string;
    runtimeId?: string;
    runId?: string;
    attemptId?: string;
    epoch?: number;
    /**
     * The two authority versions are separate because they move independently:
     * a workspace-level change (epoch, runtime, project) does not advance a
     * run's attempt history, and a run advancing its attempt says nothing about
     * the workspace. Collapsing them into one number would let either kind of
     * staleness pass as fresh.
     */
    workspaceAuthorityVersion?: number;
    runAuthorityVersion?: number;
    expiresAt: number;
    /** Who is reading, when that is not the account that owns the session. */
    viewerAccountId?: string;
    /**
     * Absent means `runner`: tokens minted before this axis existed are runner
     * tokens, and that is what they have always been allowed to do. An
     * unrecognised value is **refused**, never folded into the default —
     * folding it would turn "we do not know what this is for" into execution.
     */
    purpose: SessionScopedPurpose;
};

export type SessionScopedVerifyFailure =
    | 'bad-signature'
    | 'malformed'
    | 'expired';

/** Names privacy-kit removes from `extras` without reporting it. */
export const PRIVACY_KIT_RESERVED_CLAIM_NAMES: readonly string[] = [
    'jti', 'iat', 'exp', 'sub', 'aud', 'iss', 'nbf',
];

export type SessionScopedVerifyResult =
    | { ok: true; claims: SessionScopedClaims }
    | { ok: false; reason: SessionScopedVerifyFailure };

/**
 * Identifiers are taken exactly as signed.
 *
 * Trimming would let `" run-1"` and `"run-1"` both verify as the same run, so
 * a value that is not already canonical is refused rather than reinterpreted —
 * two spellings of one scope is how a comparison against the authority row
 * stops meaning what it looks like it means.
 */
function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value !== value.trim()) return null;
    return value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

function readInt(value: unknown, min: number): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value >= min ? value : null;
}

/**
 * Validates a decoded payload into claims.
 *
 * Exported so every field rule is testable directly. A payload that arrives
 * over the wire is input, not a typed object: `NaN` is a number, a missing
 * field is `undefined`, and both compare falsely against every bound.
 */
export function parseSessionScopedClaims(raw: unknown): SessionScopedClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;

    if (readInt(record.v, SCOPED_TOKEN_VERSION) !== SCOPED_TOKEN_VERSION) return null;

    /** Present on every token, whatever it is for. */
    const ids = {
        grantId: readId(record.grantId),
        accountId: readId(record.accountId),
        sessionId: readId(record.sessionId),
        tenantId: readId(record.tenantId),
        projectId: readId(record.projectId),
    };
    for (const value of Object.values(ids)) {
        if (value === null) return null;
    }

    // Absent is the pre-purpose past, and that past is `runner`. Anything else
    // that is not one of the three is not a purpose this server knows, and a
    // token it cannot classify is not a token it can authorise.
    const rawPurpose = record.purpose === undefined ? 'runner' : record.purpose;
    if (typeof rawPurpose !== 'string') return null;
    if (!(SESSION_SCOPED_PURPOSES as readonly string[]).includes(rawPurpose)) return null;
    const purpose = rawPurpose as SessionScopedPurpose;

    const expiresAt = readInt(record.expiresAt, 1);
    if (expiresAt === null) return null;

    /*
     * The execution axes travel together or not at all.
     *
     * A token carrying some of them is not a shape either side of this split
     * produces: a runner token has every one, and a read token has none. Half a
     * scope would be compared against an authority row field by field, and the
     * fields that were missing would silently pass.
     */
    const execution = {
        workspaceId: readId(record.workspaceId),
        runtimeId: readId(record.runtimeId),
        runId: readId(record.runId),
        attemptId: readId(record.attemptId),
    };
    const epoch = readInt(record.epoch, 0);
    const workspaceAuthorityVersion = readInt(record.workspaceAuthorityVersion, 0);
    const runAuthorityVersion = readInt(record.runAuthorityVersion, 0);
    const present = [...Object.values(execution), epoch, workspaceAuthorityVersion, runAuthorityVersion]
        .filter((value) => value !== null).length;
    const executionCarried = present === 7;
    if (present !== 0 && !executionCarried) return null;

    // Reading is the only thing that may travel without them. A runner or an
    // approver acts on a run, and a token that cannot name one is not either.
    if (!executionCarried && purpose !== 'transcript-read') return null;

    const viewerAccountId = record.viewerAccountId === undefined
        ? null
        : readId(record.viewerAccountId);
    if (record.viewerAccountId !== undefined && viewerAccountId === null) return null;

    return {
        v: SCOPED_TOKEN_VERSION,
        grantId: ids.grantId!,
        accountId: ids.accountId!,
        sessionId: ids.sessionId!,
        tenantId: ids.tenantId!,
        projectId: ids.projectId!,
        ...(executionCarried
            ? {
                workspaceId: execution.workspaceId!,
                runtimeId: execution.runtimeId!,
                runId: execution.runId!,
                attemptId: execution.attemptId!,
                epoch: epoch!,
                workspaceAuthorityVersion: workspaceAuthorityVersion!,
                runAuthorityVersion: runAuthorityVersion!,
            }
            : {}),
        ...(viewerAccountId ? { viewerAccountId } : {}),
        expiresAt,
        purpose,
    };
}

export type SessionScopedMintResult =
    | { ok: true; token: string }
    | { ok: false; reason: 'malformed' | 'expired' };

export type SessionScopedTokenIssuer = {
    mint: (claims: SessionScopedClaims, now: number) => Promise<SessionScopedMintResult>;
    verify: (token: string, now: number) => Promise<SessionScopedVerifyResult>;
};

/**
 * Builds the issuer for this service.
 *
 * `mint` exists so tests and, later, the control-plane path can produce a
 * bearer; issuing one in production is gated by the authority checks that own
 * that decision, not by this module.
 */
export async function createSessionScopedTokenIssuer(input: {
    seed: string;
}): Promise<SessionScopedTokenIssuer> {
    const generator = await privacyKit.createPersistentTokenGenerator({
        service: SESSION_SCOPED_TOKEN_SERVICE,
        seed: input.seed,
    });
    const verifier = await privacyKit.createPersistentTokenVerifier({
        service: SESSION_SCOPED_TOKEN_SERVICE,
        publicKey: Uint8Array.from(generator.publicKey),
    });

    return {
        async mint(claims, now) {
            // Minting applies exactly the validation verification will apply.
            // A token this issuer would refuse to accept must never leave it —
            // otherwise the failure surfaces later, at the child, as an opaque
            // rejection of a bearer the control plane believed it had issued.
            const parsed = parseSessionScopedClaims(claims);
            if (!parsed) return { ok: false, reason: 'malformed' };
            if (now >= parsed.expiresAt) return { ok: false, reason: 'expired' };

            // privacy-kit's persistent envelope is `{ user, uuid, extras }`.
            // The claims ride in `extras` and `user` is left empty on purpose:
            // any code that reaches for `.user` on this token finds nothing to
            // mistake for an account id.
            return { ok: true, token: await generator.new({ extras: parsed }) };
        },
        async verify(token, now) {
            let verified: unknown;
            try {
                verified = await verifier.verify(token);
            } catch {
                return { ok: false, reason: 'bad-signature' };
            }
            if (!verified) return { ok: false, reason: 'bad-signature' };
            if ((verified as { user?: unknown }).user) return { ok: false, reason: 'malformed' };

            const claims = parseSessionScopedClaims((verified as { extras?: unknown }).extras);
            if (!claims) return { ok: false, reason: 'malformed' };
            // Checked on every use, never once at issue time: the whole point
            // of a short-lived bearer is that it stops working on its own.
            // The boundary itself is refused — an expiry is the first instant
            // the grant is no longer valid, not the last instant it is.
            if (now >= claims.expiresAt) return { ok: false, reason: 'expired' };
            return { ok: true, claims };
        },
    };
}

/**
 * Who is making a request.
 *
 * The two kinds stay separate all the way to the call site. Flattening a
 * managed session onto a `userId` is what would let it inherit every route
 * written for an account holder.
 */
export type Principal =
    | { kind: 'account'; accountId: string; extras?: unknown }
    | { kind: 'managed-session'; claims: SessionScopedClaims };
