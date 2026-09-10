/**
 * The credential a managed daemon runs on.
 *
 * A managed runtime has no human at a keyboard and no account of its own. What
 * it must never carry is the customer's bearer or private key: the daemon runs
 * code the customer's own agent can influence, and a credential that can reach
 * the account is a credential that can reach every session on it.
 *
 * So it gets a token of its own purpose, bound to the one machine it is, the
 * runtime generation it belongs to and the provisioning operation that created
 * it. The account it acts for is named — the Machine really is that owner's —
 * but the token authorises nothing an account bearer would.
 */
import { describe, expect, it } from 'vitest';

import {
    MANAGED_DAEMON_MAX_TTL_MS,
    MANAGED_DAEMON_TOKEN_SERVICE,
    createManagedDaemonTokenIssuer,
    type ManagedDaemonClaims,
} from '@/app/auth/managedDaemonToken';
import {
    SESSION_SCOPED_TOKEN_SERVICE,
    createSessionScopedTokenIssuer,
} from '@/app/auth/sessionScopedToken';

const NOW = 1_800_000_000_000;

function claims(over: Partial<ManagedDaemonClaims> = {}): ManagedDaemonClaims {
    return {
        v: 1,
        accountId: 'acc-1',
        machineId: 'machine-1',
        runtimeId: 'runtime-1',
        provisioningOperationId: 'op-1',
        daemonGrantId: 'dgrant-1',
        generation: 2,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        epoch: 3,
        expiresAt: NOW + 3_600_000,
        ...over,
    };
}

const issuer = () => createManagedDaemonTokenIssuer({ seed: 'daemon-seed-not-a-production-key' });

describe('the managed daemon token', () => {
    it('carries the machine, runtime, operation and generation it is for', async () => {
        const tokens = await issuer();
        const minted = await tokens.mint(claims(), NOW);
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        const verified = await tokens.verify(minted.token, NOW + 1_000);
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.claims).toEqual(claims());
    });

    it('is a different purpose from a session-scoped bearer', async () => {
        // The service name is bound into the signature, so a token issued for
        // one purpose cannot be presented as the other even with the same seed.
        expect(MANAGED_DAEMON_TOKEN_SERVICE).not.toBe(SESSION_SCOPED_TOKEN_SERVICE);

        const seed = 'shared-seed-not-a-production-key';
        const daemonTokens = await createManagedDaemonTokenIssuer({ seed });
        const sessionTokens = await createSessionScopedTokenIssuer({ seed });
        const minted = await daemonTokens.mint(claims(), NOW);
        if (!minted.ok) return;

        const asSession = await sessionTokens.verify(minted.token, NOW + 1_000);
        expect(asSession.ok).toBe(false);
    });

    it('refuses a token that has expired', async () => {
        const tokens = await issuer();
        const minted = await tokens.mint(claims({ expiresAt: NOW + 1_000 }), NOW);
        if (!minted.ok) return;
        expect(await tokens.verify(minted.token, NOW + 1_001))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses to mint one that is already expired', async () => {
        // A token this issuer would not accept must never leave it: the
        // failure would otherwise surface at the daemon as an opaque rejection
        // of a credential the control plane believed it had issued.
        const tokens = await issuer();
        expect(await tokens.mint(claims({ expiresAt: NOW }), NOW))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it.each([
        'accountId', 'machineId', 'runtimeId', 'provisioningOperationId',
        'daemonGrantId', 'workspaceId', 'projectId',
    ])('refuses a token missing %s', async (field) => {
        const tokens = await issuer();
        const broken = { ...claims(), [field]: '' } as ManagedDaemonClaims;
        expect(await tokens.mint(broken, NOW)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a signature from another issuer', async () => {
        const mine = await issuer();
        const theirs = await createManagedDaemonTokenIssuer({ seed: 'another-seed-not-a-key' });
        const minted = await theirs.mint(claims(), NOW);
        if (!minted.ok) return;
        expect(await mine.verify(minted.token, NOW + 1_000))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('names no session and grants nothing session-shaped', async () => {
        // A daemon credential that could name a session would be a way to act
        // as one, which is the child's scoped bearer's job and not this one's.
        const tokens = await issuer();
        const minted = await tokens.mint(claims(), NOW);
        if (!minted.ok) return;
        const verified = await tokens.verify(minted.token, NOW + 1_000);
        if (!verified.ok) return;
        expect(verified.claims).not.toHaveProperty('sessionId');
        expect(verified.claims).not.toHaveProperty('grantId');
    });

    it('names the durable grant it was issued against, and its generation', async () => {
        // Purpose separation is the signature's job. Revocation is not: a
        // credential nobody can name is a credential nobody can withdraw, and
        // "it expires eventually" is not a way to stop one that leaked.
        const tokens = await issuer();
        const minted = await tokens.mint(claims(), NOW);
        if (!minted.ok) return;
        const verified = await tokens.verify(minted.token, NOW + 1_000);
        if (!verified.ok) return;
        expect(verified.claims.daemonGrantId).toBe('dgrant-1');
        expect(verified.claims.generation).toBe(2);
    });

    it('refuses a token whose generation is not a whole number', async () => {
        const tokens = await issuer();
        expect(await tokens.mint(claims({ generation: 1.5 }), NOW))
            .toEqual({ ok: false, reason: 'malformed' });
        expect(await tokens.mint(claims({ generation: -1 }), NOW))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a lifetime longer than the ceiling', async () => {
        // The same reason the session bearer has one: a credential on a
        // runtime the customer's agent can influence should not outlive the
        // window an operator would notice a problem in.
        const tokens = await issuer();
        expect(await tokens.mint(
            claims({ expiresAt: NOW + MANAGED_DAEMON_MAX_TTL_MS + 1 }), NOW,
        )).toEqual({ ok: false, reason: 'ttl-too-long' });
        expect((await tokens.mint(
            claims({ expiresAt: NOW + MANAGED_DAEMON_MAX_TTL_MS }), NOW,
        )).ok).toBe(true);
    });
});
