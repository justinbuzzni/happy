import { Fastify } from "../types";
import { log, debug } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import type { Principal, SessionScopedTokenIssuer } from "@/app/auth/sessionScopedToken";
import { authorizeManagedSessionRequest } from "@/app/managed/managedSessionAccess";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            // specs/happy-server-log-volume — 성공 경로는 매 요청 실행되는 hot
            // path 다. info 로 남기면 요청당 6줄이 되고, pino-pretty 가 동기
            // in-process 스트림이라 그 비용이 이벤트 루프에 그대로 얹힌다.
            // 토큰은 어떤 레벨에서도 남기지 않는다.
            debug({ module: 'auth-decorator' }, `Auth check - path: ${request.url}, has header: ${!!authHeader}`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            debug({ module: 'auth-decorator' }, `Auth success - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}

/**
 * Adds the one decorator that may accept a managed session bearer.
 *
 * Deliberately separate from `authenticate`, and opt-in per route. Every other
 * route in this server keeps `authenticate`, which cannot resolve a scoped
 * token at all — the two kinds are signed under different privacy-kit services
 * — so a child is refused there without any route having to remember to refuse
 * it. Widening the surface a child can reach means adding this decorator to a
 * route on purpose, which is the only way it should happen.
 *
 * It runs as a `preHandler`, in the same lifecycle position the routes already
 * used, for two reasons: the account path then behaves exactly as before, and
 * the scope check needs the parsed body (`/v2/sessions/lookup` carries its
 * scope there, not in the path).
 *
 * `issuer` is supplied by the caller rather than built here. There is one
 * configured issuer per process; a second would verify against a second key and
 * quietly accept tokens the first would not.
 */
export function enableSessionScopeAuthentication(
    app: Fastify,
    getIssuer: () => SessionScopedTokenIssuer | null,
) {
    app.decorate('authenticateSessionScope', async function (request: any, reply: any) {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'Missing authorization header' });
        }
        const token = authHeader.substring(7);

        // One resolution for both kinds, shared with every other consumer of
        // the principal. Duplicating it here would let the two drift, and the
        // one that drifts is the one that accepts something it should not.
        let principal: Principal | null;
        try {
            principal = await auth.resolvePrincipal(token, {
                scopedIssuer: getIssuer() ?? undefined,
            });
        } catch (error) {
            return replyAuthorizationUnavailable(reply, error);
        }
        if (!principal) {
            return reply.code(401).send({ error: 'Invalid token' });
        }

        if (principal.kind === 'account') {
            request.userId = principal.accountId;
            request.principal = principal;
            return;
        }

        // A managed session is never converted into an account bearer. Its
        // claims say which account it acts for; whether it may do so for *this*
        // request is decided against the database, below.
        let allowed;
        try {
            allowed = await authorizeManagedSessionRequest({
                method: request.method,
                path: request.url,
                body: request.body,
                claims: principal.claims,
                now: Date.now(),
            });
        } catch (error) {
            // The authority store is unreachable. That is not a bad bearer, and
            // answering 401 would tell a healthy caller its credential is
            // invalid — and invite it to discard a token that is fine.
            return replyAuthorizationUnavailable(reply, error);
        }
        if (!allowed.ok) {
            return reply.code(403).send({ error: 'Forbidden', reason: allowed.reason });
        }

        // Set only after the route, the session and the grant have all been
        // checked. Downstream handlers keep their own `accountId: userId`
        // ownership queries; this makes the child's own scope an additional
        // condition rather than a replacement for them.
        request.userId = principal.claims.accountId;
        request.principal = principal;
        // The grant the request was authorised by, for handlers that must
        // answer *this* bearer rather than the account it acts for — a viewer
        // gets its own key envelope, and the owner's is not a substitute.
        request.managedGrant = allowed.grant;
    });
}

/**
 * Names and codes this server is willing to repeat in a log line.
 *
 * A closed list, not a shape check. `error.name` and `error.code` are ordinary
 * writable properties: a driver can put anything there, and so can a payload
 * that reached a driver. Validating the *form* of the value would not help —
 * an API key looks like an identifier — so the only safe rule is that a value
 * is logged when it is one of these exact strings and otherwise not at all.
 *
 * Adding an entry here is a decision to publish that string, which is the point.
 */
const LOGGABLE_FAILURE_LABELS: ReadonlySet<string> = new Set([
    'PrismaClientInitializationError',
    'PrismaClientKnownRequestError',
    'PrismaClientUnknownRequestError',
    'PrismaClientRustPanicError',
    'PrismaClientValidationError',
    'P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034',
]);

/** What an unrecognised failure is called, so a log line is never assembled from one. */
const UNCLASSIFIED = 'unclassified';

function classifyFailure(error: unknown): string {
    const candidate = error as { name?: unknown; code?: unknown };
    for (const value of [candidate?.code, candidate?.name]) {
        if (typeof value === 'string' && LOGGABLE_FAILURE_LABELS.has(value)) return value;
    }
    return UNCLASSIFIED;
}

/**
 * A failure to *reach* the authority, reported as one.
 *
 * The message is a fixed string plus a classifier drawn from the closed list
 * above. Nothing from the error object and nothing derived from the bearer is
 * interpolated: a driver error can carry a connection string, and an error
 * raised while handling a credential can carry the credential.
 */
function replyAuthorizationUnavailable(reply: any, error: unknown) {
    log(
        { module: 'auth-decorator', level: 'error' },
        `Authorization store unavailable (${classifyFailure(error)})`,
    );
    return reply.code(503).send({ error: 'Authorization unavailable' });
}

/**
 * The decorator, or a startup failure.
 *
 * Fastify accepts `preHandler: undefined` without complaint, so a route that
 * reads a decorator that was never registered silently loses its authentication
 * and answers everyone. That is the worst possible way for this to break, so
 * the missing decorator is a crash at registration instead.
 */
export function requireSessionScopeAuth(app: Fastify): unknown {
    const decorator = (app as unknown as { authenticateSessionScope?: unknown }).authenticateSessionScope;
    if (!decorator) {
        throw new Error(
            'authenticateSessionScope is not registered — call enableSessionScopeAuthentication before these routes',
        );
    }
    return decorator;
}
