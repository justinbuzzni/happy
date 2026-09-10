/**
 * Recovering a managed daemon's identity without reissuing its bootstrap.
 *
 * The bootstrap body is immutable and a runtime generation may hold exactly one
 * grant, so once that grant is committed no variation of the original request
 * can ask for a longer life — not a later expiry under the same body, and not a
 * new request id, which would collide on the same generation. That is
 * deliberate: the machine key is write-once, and a bootstrap that could be
 * asked again is a bootstrap that could be asked with different key material.
 *
 * What is left to recover is the *credential*, and these two routes are that
 * path. They never create a Machine, never touch key material, and never widen
 * a scope: they extend or re-read the grant that already exists and mint
 * against it. The daemon cannot reach them — both require the control plane's
 * own Ed25519 assertion alongside the account bearer, and both operations are
 * signed for separately from the session grant's, so an assertion that keeps a
 * conversation alive cannot keep a runtime's identity alive.
 */

import { z } from 'zod';

import { type Fastify } from '../types';
import { CONTROL_ASSERTION_HEADER } from './managedControlRoutes';
import type { ControlOperation } from '@/app/managed/managedControlAssertion';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import {
    MANAGED_DAEMON_MAX_TTL_MS,
    parseManagedDaemonClaims,
} from '@/app/auth/managedDaemonToken';
import { Prisma } from '@prisma/client';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
    renewManagedDaemonGrant,
    resolveManagedDaemonGrant,
} from '@/app/managed/managedDaemonGrant';

/** The scope every request here states and the row must already agree with. */
const scopeSchema = z.object({
    accountId: z.string(),
    machineId: z.string(),
    runtimeId: z.string(),
    provisioningOperationId: z.string(),
    workspaceId: z.string(),
    projectId: z.string(),
    epoch: z.number().int().min(0),
});

const renewSchema = z.object({
    scope: scopeSchema,
    daemonGrantId: z.string(),
    /** The generation the caller believes is current; the renewal is a CAS. */
    expectedGeneration: z.number().int().min(0),
    requestId: z.string(),
    expiresAt: z.number().int().min(0),
}).strict();

const resolveSchema = z.object({
    scope: scopeSchema,
    daemonGrantId: z.string(),
    generation: z.number().int().min(0),
    expiresAt: z.number().int().min(0),
}).strict();

/**
 * Every submitted identifier, judged by the parser the credential will be read
 * back through.
 *
 * The same probe the bootstrap route uses, and for the same reason: conditions
 * restated per route drift from the token's, and an id that passes here but not
 * there is one that mutates rows and then fails at mint. Requiring the parsed
 * value to equal the submitted one also refuses ' machine ', which the parser
 * would otherwise trim into a different identity than the row holds.
 */
function isCanonicalIdentifier(value: string): boolean {
    return parseManagedDaemonClaims({
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
}

/**
 * A refusal raised from inside the writing transaction, so it rolls back.
 * Returned instead, it would commit whatever the transaction had written.
 */
class RenewRefused extends Error {
    constructor(
        readonly reason: string,
        readonly status: number,
        /**
         * Extra facts the caller needs to correct the request, and only ones it
         * has already proved it may see. A generation is returned here after
         * ownership, scope and the projection have all matched, so it tells the
         * holder of a grant something about its own grant and nothing else.
         */
        readonly detail: Record<string, unknown> = {},
    ) { super(reason); }
}

/** How many times a renewal may be replayed after losing a locking read. */
const MAX_RENEW_ATTEMPTS = 2;

/**
 * A locking read that lost to a commit made after this transaction's snapshot.
 *
 * `inTx` retries PostgreSQL's serialization failures on its own, but only the
 * ones Prisma reports as P2034. The same failure raised inside a raw locking
 * read arrives as P2010 — "raw query failed" — with the driver's code in
 * `meta`, which `inTx` cannot recognise. Recognised here instead: the retry
 * re-runs on a fresh snapshot, where the change that caused it is visible and
 * the comparisons decide against it.
 */
function isSerializationConflict(error: unknown): boolean {
    const known = error as { code?: string; meta?: { code?: unknown } } | null;
    return known?.code === 'P2010' && String(known?.meta?.code) === '40001';
}

type Scope = z.infer<typeof scopeSchema>;

function identifiersOf(scope: Scope, ...rest: string[]): string[] {
    return [
        scope.accountId, scope.machineId, scope.runtimeId,
        scope.provisioningOperationId, scope.workspaceId, scope.projectId,
        ...rest,
    ];
}

export function managedDaemonRenewRoutes(
    app: Fastify,
    getRuntime: () => ManagedControlRuntime | null,
) {
    /**
     * Refuses before Fastify validates the body — `onRequest` runs ahead of
     * schema validation, so an anonymous caller with a malformed body is turned
     * away rather than told the route's shape.
     *
     * A second copy of the guard in `managedControlRoutes`. The two are kept
     * identical on purpose and both are covered by the same refusal tests; they
     * will be unified once that module's current review closes.
     */
    async function requireConfigured(
        _request: unknown,
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) {
        if (!getRuntime()) {
            return reply.code(503).send({ error: 'Managed control is not configured' });
        }
    }

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

    /**
     * Extends a grant that already exists, in place, and hands back a
     * credential for the generation the renewal produced.
     *
     * An expired grant is renewable here and only here: the daemon holding the
     * expired credential cannot present the control plane's assertion, so
     * nothing reachable from the runtime can extend its own life. What is
     * refused is a revoked grant — reviving one would undo a withdrawal by
     * retrying it — and a grant whose workspace has since been fenced to
     * another generation, which is a credential for something nobody is
     * running.
     */
    app.post('/v1/managed/control/daemon/renew', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: renewSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'daemon-renew');
        if (!runtime) return;
        const body = request.body;
        if (body.scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        const identifiers = identifiersOf(body.scope, body.daemonGrantId, body.requestId);
        if (!identifiers.every(isCanonicalIdentifier)) {
            return reply.code(400).send({ error: 'malformed' });
        }
        if (body.expiresAt <= now) return reply.code(400).send({ error: 'expired' });
        if (body.expiresAt - now > MANAGED_DAEMON_MAX_TTL_MS) {
            return reply.code(400).send({ error: 'ttl-too-long' });
        }

        // Everything this renewal rests on is read inside the transaction that
        // writes it. Read outside, they are a snapshot: a generation promoted
        // or a Machine reassigned between the check and the update lands on an
        // authority that no longer holds, and the renewal then keeps alive
        // exactly what the change was meant to end.
        let renewed: Awaited<ReturnType<typeof renewManagedDaemonGrant>> | null = null;
        for (let attempt = 1; ; attempt++) {
        try {
            renewed = null;
            await inTx(async (tx) => {
                const existing = await tx.managedDaemonGrant.findUnique({
                    where: { daemonGrantId: body.daemonGrantId },
                });
                if (!existing) throw new RenewRefused('unknown-grant', 409);
                // Ownership from the row. `renewManagedDaemonGrant` is
                // addressed by grant id alone, so nothing below establishes
                // whose grant this is — without this any bearer that learned an
                // id could extend the life of somebody else's runtime.
                if (existing.accountId !== request.userId) {
                    throw new RenewRefused('Bearer does not own this scope', 403);
                }
                // Exact, on every axis the credential asserts. A renewal naming
                // a different machine or runtime than the row would extend one
                // identity while describing another.
                if (existing.machineId !== body.scope.machineId
                    || existing.runtimeId !== body.scope.runtimeId
                    || existing.provisioningOperationId !== body.scope.provisioningOperationId
                    || existing.workspaceId !== body.scope.workspaceId
                    || existing.projectId !== body.scope.projectId
                    || existing.epoch !== body.scope.epoch) {
                    throw new RenewRefused('scope-mismatch', 409);
                }

                // Locked before they are read, and this is what makes reading
                // them inside the transaction mean anything. The transaction's
                // snapshot is taken when it opens, so a promotion committed
                // after that is invisible to an ordinary read here — moving the
                // check inside the transaction without this would look correct
                // and still renew against a generation that no longer exists.
                //
                // A locking read of a row changed since the snapshot fails with
                // a serialization error instead of returning the stale version,
                // and `inTx` re-runs the whole thing on a fresh snapshot, where
                // the comparison below sees the new generation. `FOR SHARE`
                // rather than `FOR UPDATE`: this transaction does not modify
                // either row, it only refuses to decide without them.
                await tx.$queryRaw`
                    SELECT 1 FROM "ManagedWorkspaceAuthority"
                    WHERE "workspaceId" = ${existing.workspaceId} FOR SHARE`;
                await tx.$queryRaw`
                    SELECT 1 FROM "Machine" WHERE "id" = ${existing.machineId} FOR SHARE`;

                // The projection is the fencing axis, read here rather than
                // taken from the body: a check satisfied by a number the caller
                // passed in is a check the caller performs on itself.
                const authority = await tx.managedWorkspaceAuthority.findUnique({
                    where: { workspaceId: existing.workspaceId },
                });
                if (!authority
                    || authority.epoch !== existing.epoch
                    || authority.runtimeId !== existing.runtimeId
                    || authority.projectId !== existing.projectId) {
                    throw new RenewRefused('workspace-authority-mismatch', 409);
                }

                // And the Machine really has to still be this account's. Every
                // id in the row can line up while naming a machine that has
                // been reassigned, and that is the case this closes.
                const machine = await tx.machine.findUnique({
                    where: { id: existing.machineId },
                });
                if (!machine || machine.accountId !== existing.accountId) {
                    throw new RenewRefused('machine-not-owned', 409);
                }

                renewed = await renewManagedDaemonGrant({
                    daemonGrantId: body.daemonGrantId,
                    expectedGeneration: body.expectedGeneration,
                    expiresAt: body.expiresAt,
                    requestId: body.requestId,
                    now,
                    tx: tx as never,
                });
                if (!renewed.ok) {
                    // Thrown, not returned: a refusal returned from inside the
                    // transaction commits whatever it has already written.
                    //
                    // A lost acknowledgement leaves the control plane holding a
                    // generation the row has moved past, and once the renewal's
                    // own body has expired it cannot converge by resending it.
                    // The current generation goes back with the refusal so the
                    // correction is a fact rather than a guess: a caller that
                    // guessed would walk the CAS forward on a number it does
                    // not know, which is how two replicas both "succeed".
                    throw new RenewRefused(renewed.reason, 409,
                        renewed.reason === 'generation-conflict'
                            ? { currentGeneration: existing.generation }
                            : {});
                }

                // The last act. The work above can wait on locks, and a
                // generation advanced to a lifetime that has already passed is
                // a renewal that recovered nothing. While the transaction is
                // open the refusal costs nothing.
                if (Date.now() >= body.expiresAt) throw new RenewRefused('expired', 400);
            });
            break;
        } catch (error) {
            if (error instanceof RenewRefused) {
                return reply.code(error.status).send({ error: error.reason, ...error.detail });
            }
            if (!isSerializationConflict(error) || attempt >= MAX_RENEW_ATTEMPTS) throw error;
        }
        }
        // TypeScript narrows the assignment inside the closure to `never`; the
        // value is what the transaction produced.
        const result = renewed as Awaited<ReturnType<typeof renewManagedDaemonGrant>> | null;
        if (!result || !result.ok) {
            return reply.code(500).send({ error: 'daemon grant was not renewed' });
        }

        // Never longer than the row, and never longer than what was signed for.
        const expiresAt = Math.min(Number(result.grant.expiresAt), body.expiresAt);
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
            expiresAt,
            // The clock as it is at the mint, not as it was on arrival: the row
            // work above can wait, and a credential minted against the older
            // reading can already be dead while reported as a success.
        }, Date.now());
        if (!minted.ok) return reply.code(400).send({ error: minted.reason });

        return reply.send({
            token: minted.token,
            daemonGrantId: result.grant.daemonGrantId,
            generation: result.grant.generation,
            machineId: result.grant.machineId,
            expiresAt,
            idempotent: result.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    /**
     * Mints again for the grant as it stands, changing nothing.
     *
     * For the case where the grant is healthy and only the credential was lost
     * — an acknowledgement that never arrived, a runtime restarted before it
     * stored its token. `resolveManagedDaemonGrant` is what judges it: the row,
     * the projection and the Machine's owner are all re-read there, so a grant
     * that has been revoked, superseded or fenced yields nothing here.
     */
    app.post('/v1/managed/control/daemon/resolve', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: resolveSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'daemon-resolve');
        if (!runtime) return;
        const body = request.body;
        if (body.scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        if (!identifiersOf(body.scope, body.daemonGrantId).every(isCanonicalIdentifier)) {
            return reply.code(400).send({ error: 'malformed' });
        }
        if (body.expiresAt <= now) return reply.code(400).send({ error: 'expired' });
        if (body.expiresAt - now > MANAGED_DAEMON_MAX_TTL_MS) {
            return reply.code(400).send({ error: 'ttl-too-long' });
        }

        // One snapshot for all three reads. The grant, the projection and the
        // Machine's owner decide together whether a credential may be minted,
        // and read separately they can disagree: the second read can land
        // after a promotion the first did not see, so the three describe two
        // different states of the world.
        //
        // What this gives is that consistency, not freshness. A snapshot is
        // taken when the transaction opens and does not see what commits after
        // it, so a promotion landing mid-flight is decided against the state at
        // the start — the same limitation the renewal above closes with locking
        // reads, and not yet closed here.
        const resolved = await db.$transaction(
            (tx) => resolveManagedDaemonGrant({
                daemonGrantId: body.daemonGrantId,
                generation: body.generation,
                claims: body.scope,
                now,
                tx: tx as never,
            }),
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        if (!resolved.ok) return reply.code(409).send({ error: resolved.reason });

        const expiresAt = Math.min(Number(resolved.grant.expiresAt), body.expiresAt);
        const minted = await runtime.daemonTokens.mint({
            v: 1,
            accountId: resolved.grant.accountId,
            machineId: resolved.grant.machineId,
            runtimeId: resolved.grant.runtimeId,
            provisioningOperationId: resolved.grant.provisioningOperationId,
            workspaceId: resolved.grant.workspaceId,
            projectId: resolved.grant.projectId,
            epoch: resolved.grant.epoch,
            daemonGrantId: resolved.grant.daemonGrantId,
            generation: resolved.grant.generation,
            expiresAt,
        }, Date.now());
        if (!minted.ok) return reply.code(400).send({ error: minted.reason });

        return reply.send({
            token: minted.token,
            daemonGrantId: resolved.grant.daemonGrantId,
            generation: resolved.grant.generation,
            machineId: resolved.grant.machineId,
            expiresAt,
            serverUrl: runtime.publicUrl,
        });
    });
}
