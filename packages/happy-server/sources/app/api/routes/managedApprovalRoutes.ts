/**
 * Answering a permission prompt from a browser.
 *
 * ## Why this is an HTTP route and not a socket call
 *
 * The managed socket server is the **run's own connection**: its registry is
 * keyed by run, and it refuses any bearer that is not the runner. A person
 * approving a prompt is not the run, so they have no socket to speak on. The
 * answer therefore arrives over HTTP and this server relays it on the
 * connection that already exists.
 *
 * ## What is checked, and why each check is here
 *
 *  - **The purpose.** Only `approval-control` reaches this route; the allowlist
 *    refuses a read bearer, because reading a transcript is not deciding what
 *    the run may do.
 *  - **The grant, freshly.** `authenticateSessionScope` re-reads it on every
 *    request, so a withdrawn approver stops being able to answer immediately.
 *  - **The run.** An approval is an act on the run that is asking. The grant
 *    carries the run it was minted for, and the scope check that issued it
 *    compared that against the live authority — an answer for a superseded
 *    attempt is answering a question nobody is still posing.
 *
 * The response body is opaque here: it is sealed with the session key, which
 * this server does not hold. It is relayed exactly as received.
 */
import { z } from 'zod';

import { dispatchManagedRpc, managedRpcServer } from '@/app/api/socket/managed/managedDelivery';
import type { Fastify } from '../types';
import { requireSessionScopeAuth } from '@/app/api/utils/enableAuthentication';

/**
 * Base64, and nothing else.
 *
 * The child decodes this with `decodeBase64` before it decrypts. Anything that
 * is not base64 — an object, a JSON string, a field this server added — throws
 * inside the child's RPC manager, which catches it and answers with an
 * *encrypted error*. That error is a perfectly well-formed acknowledgement, so
 * the delivery layer reports success and the person is told their answer went
 * through. Refusing the shape here is what keeps that from being possible.
 */
const base64Payload = z.string().min(1).max(65_536).regex(/^[A-Za-z0-9+/]+={0,2}$/);

const answerSchema = z.object({
    /**
     * Correlates this call with its acknowledgement. Not the permission
     * request's id — that one lives *inside* the sealed payload, where the
     * child reads it, because this server cannot construct or read it.
     */
    requestId: z.string().min(1).max(200),
    /**
     * The whole `PermissionResponse` — `{ id, approved, ... }` — sealed with
     * the session key by the browser and base64-encoded, exactly as the child's
     * RPC manager expects to receive it.
     *
     * Relayed **verbatim**. This server holds no key that opens it, so it can
     * neither add the id nor wrap it in an envelope of its own: a payload this
     * server assembled would be one the child cannot decrypt.
     */
    payload: base64Payload,
}).strict();

export function managedApprovalRoutes(app: Fastify) {
    app.post('/v1/managed/sessions/:sessionId/permission', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            params: z.object({ sessionId: z.string().min(1) }),
            body: answerSchema,
        },
    }, async (request, reply) => {
        const principal = request.principal;
        if (!principal || principal.kind !== 'managed-session') {
            // The decorator only sets `managedGrant` for a managed bearer, so
            // this is unreachable through it; stated because the claims below
            // are what the recipient re-checks, and they must be that bearer's.
            return reply.code(403).send({ error: 'Forbidden', reason: 'purpose-not-allowed' });
        }
        const grant = request.managedGrant;
        // The allowlist already refused every other purpose; this states the
        // same rule where the handler can be read on its own.
        if (!grant || grant.purpose !== 'approval-control') {
            return reply.code(403).send({ error: 'Forbidden', reason: 'purpose-not-allowed' });
        }
        const { sessionId } = request.params as { sessionId: string };
        if (grant.sessionId !== sessionId) {
            return reply.code(403).send({ error: 'Forbidden', reason: 'session-mismatch' });
        }

        const dispatched = await dispatchManagedRpc(managedRpcServer(), {
            sessionId,
            accountId: grant.accountId,
            rpcName: 'permission',
            requestId: request.body.requestId,
            // The sealed payload itself, as the child's RPC manager reads it.
            params: request.body.payload,
            /*
             * Re-checked where the socket is, immediately before the emit.
             * The grant was live when this request was authorised; the packet
             * may then sit in another replica's queue, and an approver whose
             * access ended in that window must not have their answer applied.
             */
            // The claims this request was authorised on, carried whole. The
            // recipient re-runs the full check against them rather than
            // trusting either the claims or this server's earlier answer.
            approval: { claims: principal.claims },
        });
        if (!dispatched.ok) {
            /*
             * Never reported as answered. "We could not reach the run" must not
             * read as "the prompt is decided" — it is still open, and the
             * person can try again.
             */
            return reply.code(dispatched.reason === 'no-target' ? 409 : 503)
                .send({ error: 'Not relayed', reason: dispatched.reason });
        }
        /*
         * What comes back is the child's own answer, sealed with the session
         * key. It is returned untouched, and the caller is the one that can
         * tell what it says.
         *
         * This route does **not** claim the prompt was answered, and it cannot:
         * the child's permission handler returns the same shape for an id it
         * recognises and one it does not — an answer for a request that has
         * already been resolved, or was never open, is dropped inside the child
         * and still acknowledges. `relayed` is the strongest true statement
         * this server can make; whether it was *applied* is visible to the
         * caller in the session's own agent state.
         */
        if (typeof dispatched.result !== 'string') {
            return reply.code(502).send({ error: 'Not relayed', reason: 'malformed-response' });
        }
        return reply.send({ relayed: true, response: dispatched.result });
    });
}
