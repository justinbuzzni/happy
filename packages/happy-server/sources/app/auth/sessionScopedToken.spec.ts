import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';

import { auth } from '@/app/auth/auth';
import {
    ACCOUNT_TOKEN_SERVICE,
    PRIVACY_KIT_RESERVED_CLAIM_NAMES,
    SESSION_SCOPED_TOKEN_SERVICE,
    createSessionScopedTokenIssuer,
    parseSessionScopedClaims,
    type SessionScopedClaims,
    type SessionScopedTokenIssuer,
} from '@/app/auth/sessionScopedToken';

/**
 * The two token kinds must not be interchangeable in either direction. A scoped
 * token an account verifier accepts would hand a child full account authority;
 * an account token a scoped verifier accepts would let any account bearer act
 * as one specific run.
 */

const SEED = 'test-seed-not-a-production-key';
const NOW = 1_800_000_000_000;

/**
 * `auth.init()` derives its keys from `HANDY_MASTER_SECRET`. Taking that from
 * the ambient shell makes the suite pass or fail depending on who runs it, so
 * the fixture supplies its own and restores the environment afterwards.
 */
const FIXTURE_MASTER_SECRET = 'test-master-secret-not-a-production-key';

function scope(overrides: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    return {
        v: 1,
        grantId: 'grant-1',
        accountId: 'account-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        runtimeId: 'runtime-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        epoch: 3,
        workspaceAuthorityVersion: 7,
        runAuthorityVersion: 2,
        purpose: 'runner' as const,
        expiresAt: NOW + 60_000,
        ...overrides,
    };
}

let issuer: SessionScopedTokenIssuer;

async function mintOk(claims: SessionScopedClaims = scope(), now = NOW): Promise<string> {
    const minted = await issuer.mint(claims, now);
    if (!minted.ok) throw new Error(`expected a mint, got ${minted.reason}`);
    return minted.token;
}

beforeAll(async () => {
    vi.stubEnv('HANDY_MASTER_SECRET', FIXTURE_MASTER_SECRET);
    // The auth module is a process-wide singleton whose `init` is idempotent,
    // so it is initialised once here rather than per case.
    await auth.init();
});

afterAll(() => {
    vi.unstubAllEnvs();
});

beforeEach(async () => {
    issuer = await createSessionScopedTokenIssuer({ seed: SEED });
});

describe('purpose separation between account and scoped tokens', () => {
    it('mints a scoped token the scoped verifier accepts', async () => {
        const verified = await issuer.verify(await mintOk(), NOW + 1_000);
        expect(verified).toMatchObject({ ok: true });
        if (verified.ok) {
            expect(verified.claims.sessionId).toBe('session-1');
            expect(verified.claims.grantId).toBe('grant-1');
            expect(verified.claims.workspaceId).toBe('workspace-1');
            expect(verified.claims.runtimeId).toBe('runtime-1');
        }
    });

    it('is signed under a different service than account tokens', () => {
        expect(SESSION_SCOPED_TOKEN_SERVICE).not.toBe(ACCOUNT_TOKEN_SERVICE);
    });

    it('the account verifier refuses a scoped token', async () => {
        // The generic account path must never resolve a scoped bearer: every
        // existing caller flattens its result to a user id.
        await expect(auth.verifyToken(await mintOk())).resolves.toBeNull();
    });

    it('an older server built only with the account verifier refuses it too', async () => {
        const token = await mintOk();
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: ACCOUNT_TOKEN_SERVICE,
            seed: SEED,
        });
        const legacyVerifier = await privacyKit.createPersistentTokenVerifier({
            service: ACCOUNT_TOKEN_SERVICE,
            publicKey: Uint8Array.from(generator.publicKey),
        });
        await expect(legacyVerifier.verify(token)).resolves.toBeFalsy();
    });

    it('the scoped verifier refuses an account token', async () => {
        const accountToken = await auth.createToken('account-1');
        expect(await issuer.verify(accountToken, NOW))
            .toMatchObject({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a token signed with a different seed', async () => {
        const other = await createSessionScopedTokenIssuer({ seed: 'a-different-seed-entirely' });
        const minted = await other.mint(scope(), NOW);
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        expect(await issuer.verify(minted.token, NOW))
            .toMatchObject({ ok: false, reason: 'bad-signature' });
    });
});

describe('privacy-kit reserved claim names', () => {
    it('silently drops them from extras, which is why none are used', async () => {
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: SESSION_SCOPED_TOKEN_SERVICE,
            seed: SEED,
        });
        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: SESSION_SCOPED_TOKEN_SERVICE,
            publicKey: Uint8Array.from(generator.publicKey),
        });
        for (const name of PRIVACY_KIT_RESERVED_CLAIM_NAMES) {
            const token = await generator.new({ extras: { [name]: 'value', keep: 'yes' } });
            const decoded = await verifier.verify(token) as
                { extras?: Record<string, unknown> } | null;
            // Either the whole token stops verifying or the claim is gone from
            // `extras` — both mean data cannot be carried under these names,
            // and neither reports why.
            expect(decoded?.extras?.[name], name).toBeUndefined();
        }
    });

    it('uses none of them in the claim set', () => {
        for (const name of PRIVACY_KIT_RESERVED_CLAIM_NAMES) {
            expect(Object.keys(scope())).not.toContain(name);
        }
    });
});

describe('expiry is checked on every verification', () => {
    it('refuses a token at and past its own expiry', async () => {
        const token = await mintOk(scope({ expiresAt: NOW + 1_000 }));
        // The expiry instant is the first moment the grant is invalid.
        expect(await issuer.verify(token, NOW + 1_000))
            .toMatchObject({ ok: false, reason: 'expired' });
        expect(await issuer.verify(token, NOW + 1_001))
            .toMatchObject({ ok: false, reason: 'expired' });
    });

    it('accepts it up to the instant before', async () => {
        const token = await mintOk(scope({ expiresAt: NOW + 1_000 }));
        expect(await issuer.verify(token, NOW + 999)).toMatchObject({ ok: true });
    });

    it('never caches a verification result', async () => {
        const token = await mintOk(scope({ expiresAt: NOW + 1_000 }));
        expect(await issuer.verify(token, NOW)).toMatchObject({ ok: true });
        // A cached answer would keep an expired or revoked grant alive for the
        // life of the cache.
        expect(await issuer.verify(token, NOW + 5_000))
            .toMatchObject({ ok: false, reason: 'expired' });
    });

    it('refuses to mint a token that is already expired', async () => {
        expect(await issuer.mint(scope({ expiresAt: NOW }), NOW))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses to mint claims it would not accept', async () => {
        expect(await issuer.mint(scope({ runId: '' }), NOW))
            .toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('claims are validated, not trusted', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
        ['a missing grantId', { grantId: undefined }],
        ['an empty sessionId', { sessionId: '' }],
        ['a missing accountId', { accountId: undefined }],
        ['a missing tenantId', { tenantId: undefined }],
        ['a missing projectId', { projectId: undefined }],
        ['a missing workspaceId', { workspaceId: undefined }],
        ['a missing runtimeId', { runtimeId: undefined }],
        ['a missing runId', { runId: undefined }],
        ['a missing attemptId', { attemptId: undefined }],
        ['a fractional epoch', { epoch: 1.5 }],
        ['a negative epoch', { epoch: -1 }],
        ['a fractional workspace version', { workspaceAuthorityVersion: 2.5 }],
        ['a fractional run version', { runAuthorityVersion: 2.5 }],
        ['a NaN expiry', { expiresAt: Number.NaN }],
        ['a missing expiry', { expiresAt: undefined }],
        ['a zero expiry', { expiresAt: 0 }],
        ['an unsafe expiry', { expiresAt: Number.MAX_SAFE_INTEGER + 2 }],
        ['a wrong version', { v: 2 }],
    ];

    for (const [name, override] of cases) {
        it(`rejects ${name}`, () => {
            expect(parseSessionScopedClaims({ ...scope(), ...override })).toBeNull();
        });
    }

    it('rejects an identifier that is not already canonical', () => {
        // Accepting `" run-1"` as `"run-1"` would make two spellings of one
        // scope compare equal against the authority row.
        for (const runId of [' run-1', 'run-1 ', '\trun-1', 'run-1\n']) {
            expect(parseSessionScopedClaims({ ...scope(), runId })).toBeNull();
        }
    });

        it('reads a token minted before purposes existed as a runner token', () => {
            // Those tokens are runner tokens, and that is what they have always
            // been allowed to do. Refusing them would end every live session.
            const claims = parseSessionScopedClaims({ ...scope() });
            expect(claims?.purpose).toBe('runner');
        });

        it.each([['transcript-read'], ['approval-control'], ['runner']])(
            'carries %s through unchanged', (purpose) => {
                expect(parseSessionScopedClaims({ ...scope(), purpose })?.purpose).toBe(purpose);
            });

        it('reads a transcript token that names no run', () => {
            /*
             * The shape a read bearer actually has: a session, a project, a
             * purpose — and no run, because the run it would name has finished.
             * Requiring one is what made a dormant project unreadable.
             */
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...rest } = scope() as Record<string, unknown>;
            const claims = parseSessionScopedClaims({
                ...rest, purpose: 'transcript-read', viewerAccountId: 'viewer-1',
            });
            expect(claims?.purpose).toBe('transcript-read');
            expect(claims?.runId).toBeUndefined();
            expect(claims?.viewerAccountId).toBe('viewer-1');
        });

        it.each([['runner'], ['approval-control']])(
            'refuses a %s token that names no run', (purpose) => {
                // Acting on a run means being able to say which one. Only
                // reading may travel without that.
                const { workspaceId, runtimeId, runId, attemptId, epoch,
                    workspaceAuthorityVersion, runAuthorityVersion, ...rest } = scope() as Record<string, unknown>;
                expect(parseSessionScopedClaims({ ...rest, purpose })).toBeNull();
            });

        it('refuses a token carrying only part of a run scope', () => {
            // Half a scope is compared field by field against an authority row,
            // and the missing halves pass silently.
            const { attemptId, ...rest } = scope() as Record<string, unknown>;
            expect(parseSessionScopedClaims({ ...rest, purpose: 'transcript-read' })).toBeNull();
            expect(parseSessionScopedClaims({ ...rest })).toBeNull();
        });

        it.each([['administrator'], [''], [42], [null]])(
            'refuses a purpose this server does not know: %s', (purpose) => {
                /*
                 * Never folded into `runner`. Folding would read "we cannot
                 * classify this token" as "this token may execute", which is
                 * the one direction the mistake must not go.
                 */
                expect(parseSessionScopedClaims({ ...scope(), purpose } as never)).toBeNull();
            });


    it('accepts a complete claim set', () => {
        expect(parseSessionScopedClaims(scope())).toMatchObject({ sessionId: 'session-1' });
    });

    it('rejects a non-object payload', () => {
        for (const value of [null, 7, 'x', []]) {
            expect(parseSessionScopedClaims(value)).toBeNull();
        }
    });
});

describe('principal resolution keeps the two kinds apart', () => {
    it('resolves an account bearer as an account principal', async () => {
        const token = await auth.createToken('account-1');
        expect(await auth.resolvePrincipal(token, { scopedIssuer: issuer, now: NOW }))
            .toMatchObject({ kind: 'account', accountId: 'account-1' });
    });

    it('resolves a scoped bearer as a managed-session principal', async () => {
        const principal = await auth.resolvePrincipal(await mintOk(), { scopedIssuer: issuer, now: NOW });
        expect(principal).toMatchObject({ kind: 'managed-session' });
        if (principal?.kind === 'managed-session') {
            expect(principal.claims.runId).toBe('run-1');
            // Deliberately not flattened onto a user id: a caller has to decide
            // what a managed session may do rather than inherit account routes.
            expect('userId' in principal).toBe(false);
            expect('accountId' in principal).toBe(false);
        }
    });

    it('tries the account path first and only then the scoped one', async () => {
        const attempted: string[] = [];
        const token = await mintOk();
        await auth.resolvePrincipal(token, {
            scopedIssuer: {
                verify: async (candidate, now) => {
                    attempted.push('scoped');
                    return issuer.verify(candidate, now);
                },
            },
            now: NOW,
        });
        // BYOS keeps its behaviour: the account verifier runs first and
        // unchanged, and the scoped path is reached only when it found nothing.
        expect(attempted).toEqual(['scoped']);
    });

    it('does not consult the scoped issuer for a valid account bearer', async () => {
        let consulted = false;
        const token = await auth.createToken('account-1');
        await auth.resolvePrincipal(token, {
            scopedIssuer: {
                verify: async (candidate, now) => {
                    consulted = true;
                    return issuer.verify(candidate, now);
                },
            },
            now: NOW,
        });
        expect(consulted).toBe(false);
    });

    it('returns null when neither kind verifies', async () => {
        expect(await auth.resolvePrincipal('not-a-token', { scopedIssuer: issuer, now: NOW }))
            .toBeNull();
    });

    it('resolves nothing scoped when no issuer is configured', async () => {
        // Activation is off by default: with no issuer the scoped kind does not
        // exist and the bearer is simply unauthenticated.
        expect(await auth.resolvePrincipal(await mintOk(), { now: NOW })).toBeNull();
    });
});
