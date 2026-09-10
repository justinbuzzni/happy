/**
 * What a managed daemon credential opens, and what it does not.
 *
 * The credential names an account because the Machine really is that
 * account's — that is how the runtime appears in the customer's list. It
 * authorises nothing that account could do. No session, no listing, no
 * administration: what it opens is one machine's own control and status, and
 * only while the grant behind it is live.
 *
 * Two checks, and both are needed. The signature says the token was issued
 * here and has not been altered; the grant row says it has not been withdrawn
 * since. A signature alone cannot express a withdrawal, and no amount of
 * cryptography makes a revoked credential stop verifying.
 */
import type { ManagedDaemonClaims, ManagedDaemonTokenIssuer } from '@/app/auth/managedDaemonToken';
import { resolveManagedDaemonGrant } from '@/app/managed/managedDaemonGrant';

/**
 * A principal that is not an account.
 *
 * Deliberately shaped so nothing downstream can mistake it for one: it carries
 * no `userId` and no `sessionId`, only the claims it was issued with. Code
 * reaching for an account id on this finds nothing to act as.
 */
export type ManagedDaemonPrincipal = {
    kind: 'managed-daemon';
    claims: ManagedDaemonClaims;
};

export type ManagedDaemonAccessResult =
    | { ok: true; principal: ManagedDaemonPrincipal }
    | {
        ok: false;
        reason:
            | 'token-invalid'
            | 'machine-mismatch'
            | 'unknown-grant'
            | 'revoked'
            | 'expired'
            | 'stale-generation'
            | 'scope-mismatch'
            | 'stale-epoch'
            | 'machine-not-owned'
            | 'workspace-unknown';
    };

export async function authorizeManagedDaemonRequest(input: {
    token: string;
    issuer: Pick<ManagedDaemonTokenIssuer, 'verify'>;
    /** The machine this request is addressed to. */
    machineId: string;
    now: number;
}): Promise<ManagedDaemonAccessResult> {
    const verified = await input.issuer.verify(input.token, input.now);
    // One reason for every way a token can fail to be one: a caller learning
    // *which* way would be learning whether a given credential exists.
    if (!verified.ok) return { ok: false, reason: 'token-invalid' };

    const claims = verified.claims;
    // The credential is for one machine. Presenting it against another is
    // exactly what an account bearer would sail through, and what this
    // boundary exists to refuse.
    if (claims.machineId !== input.machineId) return { ok: false, reason: 'machine-mismatch' };

    // Read on every request: a withdrawal has to take effect now, and a
    // renewal has to make the credential minted before it unusable even though
    // its signature is still good.
    const resolved = await resolveManagedDaemonGrant({
        daemonGrantId: claims.daemonGrantId,
        generation: claims.generation,
        claims: {
            accountId: claims.accountId,
            machineId: claims.machineId,
            runtimeId: claims.runtimeId,
            provisioningOperationId: claims.provisioningOperationId,
            workspaceId: claims.workspaceId,
            projectId: claims.projectId,
            epoch: claims.epoch,
        },
        now: input.now,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    return { ok: true, principal: { kind: 'managed-daemon', claims } };
}
