/**
 * The credential a managed Cloud daemon runs on.
 *
 * ## Why it is not the customer's bearer
 *
 * A managed runtime has no human at a keyboard and no account of its own. The
 * Machine it registers as really does belong to a customer's account — that is
 * how the runtime shows up in their list — but the daemon runs code the
 * customer's own agent can influence, and an account bearer is a credential
 * that reaches every session on that account. Copying one into the runtime
 * would make "the agent read a file" and "the agent has the account" the same
 * event.
 *
 * So the daemon gets a credential of its own purpose. It names the account it
 * acts for and nothing that account could do: no session, no grant, no admin.
 *
 * ## What it is bound to
 *
 * The machine it is, the runtime generation it belongs to, the provisioning
 * operation that created it, and the workspace and project it serves. A token
 * that outlived any of those would be a token for a runtime that no longer
 * exists — and the resources named in it may already have been reassigned.
 *
 * The service name is bound into privacy-kit's signature, so a token issued
 * here cannot be presented as a session-scoped bearer even if both were derived
 * from the same seed. That separation is the whole point of a distinct purpose,
 * and it is checked rather than assumed.
 */
import * as privacyKit from 'privacy-kit';

/** Bound into the signature: a different purpose is a different service. */
export const MANAGED_DAEMON_TOKEN_SERVICE = 'happy-managed-daemon';

const MANAGED_DAEMON_TOKEN_VERSION = 1;
const MAX_ID_LENGTH = 200;

/**
 * The longest a daemon credential may live.
 *
 * The same reason the session bearer has a ceiling: this one sits on a runtime
 * the customer's own agent can influence, and a credential that outlives the
 * window an operator would notice a problem in is a credential that cannot be
 * withdrawn in time. Renewal is the way to stay alive, not a long lifetime.
 */
export const MANAGED_DAEMON_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the token asserts.
 *
 * No `sessionId` and no session `grantId`: acting as a session is the child's
 * scoped bearer's job, and a daemon credential that could name one would be a
 * way to do that job without holding that bearer.
 *
 * It does name its own durable grant and that grant's generation. Purpose
 * separation is the signature's job; revocation is not. A credential nobody
 * can name is a credential nobody can withdraw, and "it expires eventually" is
 * not a way to stop one that has leaked. The row is the authority — this only
 * names it, and the generation is what a revocation moves.
 */
export type ManagedDaemonClaims = {
    v: number;
    /** The account this Machine belongs to. Named, never acted as. */
    accountId: string;
    machineId: string;
    runtimeId: string;
    provisioningOperationId: string;
    /** The durable grant row this credential was issued against. */
    daemonGrantId: string;
    /** Moved by a revocation; a token from an older one is refused. */
    generation: number;
    workspaceId: string;
    projectId: string;
    /** The runtime generation this credential was issued for. */
    epoch: number;
    expiresAt: number;
};

export type ManagedDaemonMintResult =
    | { ok: true; token: string }
    | { ok: false; reason: 'malformed' | 'expired' | 'ttl-too-long' };

export type ManagedDaemonVerifyResult =
    | { ok: true; claims: ManagedDaemonClaims }
    | { ok: false; reason: 'bad-signature' | 'malformed' | 'expired' };

export type ManagedDaemonTokenIssuer = {
    mint: (claims: ManagedDaemonClaims, now: number) => Promise<ManagedDaemonMintResult>;
    verify: (token: string, now: number) => Promise<ManagedDaemonVerifyResult>;
};

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

function readInt(value: unknown, min: number): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null;
}

export function parseManagedDaemonClaims(raw: unknown): ManagedDaemonClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (readInt(record.v, MANAGED_DAEMON_TOKEN_VERSION) !== MANAGED_DAEMON_TOKEN_VERSION) return null;

    const ids = {
        accountId: readId(record.accountId),
        machineId: readId(record.machineId),
        runtimeId: readId(record.runtimeId),
        provisioningOperationId: readId(record.provisioningOperationId),
        daemonGrantId: readId(record.daemonGrantId),
        workspaceId: readId(record.workspaceId),
        projectId: readId(record.projectId),
    };
    for (const value of Object.values(ids)) {
        if (value === null) return null;
    }

    const epoch = readInt(record.epoch, 0);
    const generation = readInt(record.generation, 0);
    const expiresAt = readInt(record.expiresAt, 0);
    if (epoch === null || generation === null || expiresAt === null) return null;

    // Anything session-shaped is refused rather than ignored: a token that
    // carried one would be read as one by something eventually.
    if (record.sessionId !== undefined || record.grantId !== undefined) return null;

    return {
        v: MANAGED_DAEMON_TOKEN_VERSION,
        accountId: ids.accountId!,
        machineId: ids.machineId!,
        runtimeId: ids.runtimeId!,
        provisioningOperationId: ids.provisioningOperationId!,
        daemonGrantId: ids.daemonGrantId!,
        generation,
        workspaceId: ids.workspaceId!,
        projectId: ids.projectId!,
        epoch,
        expiresAt,
    };
}

export async function createManagedDaemonTokenIssuer(input: {
    seed: string;
}): Promise<ManagedDaemonTokenIssuer> {
    const generator = await privacyKit.createPersistentTokenGenerator({
        service: MANAGED_DAEMON_TOKEN_SERVICE,
        seed: input.seed,
    });
    const verifier = await privacyKit.createPersistentTokenVerifier({
        service: MANAGED_DAEMON_TOKEN_SERVICE,
        publicKey: Uint8Array.from(generator.publicKey),
    });

    return {
        async mint(claims, now) {
            // Minting applies exactly what verification will apply: a token
            // this issuer would refuse must never leave it, or the failure
            // surfaces at the daemon as an opaque rejection of a credential
            // the control plane believed it had issued.
            const parsed = parseManagedDaemonClaims(claims);
            if (!parsed) return { ok: false, reason: 'malformed' };
            if (now >= parsed.expiresAt) return { ok: false, reason: 'expired' };
            if (parsed.expiresAt - now > MANAGED_DAEMON_MAX_TTL_MS) {
                return { ok: false, reason: 'ttl-too-long' };
            }
            // `user` is left empty deliberately: anything reaching for it finds
            // nothing to mistake for an account principal.
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
            const extras = (verified as { extras?: unknown }).extras;
            const parsed = parseManagedDaemonClaims(extras);
            if (!parsed) return { ok: false, reason: 'malformed' };
            if (now >= parsed.expiresAt) return { ok: false, reason: 'expired' };
            return { ok: true, claims: parsed };
        },
    };
}
