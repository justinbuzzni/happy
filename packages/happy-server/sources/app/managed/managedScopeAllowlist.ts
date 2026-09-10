/**
 * What a managed child bearer is allowed to reach.
 *
 * This is an allowlist of *exact* routes, events and RPC names, each pinned to
 * the one session the bearer's grant names. It is deliberately not a prefix
 * rule. A prefix ("anything under this session id") looks equivalent and is
 * not: `rpc-register` joins `rpcRoom(userId, method)` with the string it was
 * handed, so a bearer that may register any name beginning with its session id
 * can claim a method nobody audited, and a route prefix would hand a child
 * every future endpoint added under a path it already reaches. Keeping the
 * names is the cost of knowing what a child can do.
 *
 * The list is derived from the consumers that actually exist today — Claude and
 * Codex sessions and the common file/shell handlers — not from a guess at what
 * a runtime might want. A provider added later extends this list together with
 * a test for its capability; an unknown method is refused, and that refusal is
 * the feature.
 *
 * Nothing here reads the database or the environment. Whether the grant behind
 * the session id is still live is a separate check the caller performs on every
 * action.
 */

import type { SessionScopedPurpose } from '@/app/auth/sessionScopedToken';

export type ManagedScopeDenial =
    | 'route-not-allowed'
    | 'method-not-allowed'
    | 'session-mismatch'
    | 'malformed-path'
    | 'lookup-scope-too-broad'
    | 'event-not-allowed'
    | 'rpc-name-not-allowed'
    | 'rpc-name-malformed'
    | 'capability-not-supported'
    /** The bearer is real and live, and this is not what it is for. */
    | 'purpose-not-allowed';

export type ManagedScopeDecision =
    | { ok: true }
    | { ok: false; reason: ManagedScopeDenial };

const ALLOW: ManagedScopeDecision = { ok: true };
const deny = (reason: ManagedScopeDenial): ManagedScopeDecision => ({ ok: false, reason });

export type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * A route template. `:sessionId` must equal the bearer's session; `:file` is a
 * free segment. Every other segment is matched literally.
 */
type RouteTemplate = { method: HttpMethod; segments: readonly string[] };

function template(method: HttpMethod, path: string): RouteTemplate {
    return { method, segments: path.split('/').filter((s) => s.length > 0) };
}

/**
 * The exact set a managed child may call.
 *
 * `POST /v1/sessions` is absent on purpose: a child may act inside the session
 * it was granted and may not create another one.
 *
 * Only `GET /v3/sessions/:sessionId/events` is listed. The POST on the same
 * path writes session events and no managed consumer needs it, so it stays out
 * rather than riding in on a shared path.
 */
const ALLOWED_ROUTES: readonly RouteTemplate[] = [
    template('GET', '/v3/sessions/:sessionId/messages'),
    template('POST', '/v3/sessions/:sessionId/messages'),
    template('GET', '/v3/sessions/:sessionId/events'),
    template('POST', '/v2/sessions/lookup'),
    template('POST', '/v1/sessions/:sessionId/attachments/request-upload'),
    template('POST', '/v1/sessions/:sessionId/attachments/request-download'),
    // The managed relay itself: an authenticated PUT/GET against this server,
    // never a third-party presigned URL.
    template('PUT', '/v1/sessions/:sessionId/attachments/:file'),
    template('GET', '/v1/sessions/:sessionId/attachments/:file'),
    /**
     * Answering a permission prompt, over HTTP.
     *
     * A browser cannot hold a managed socket — that server is the run's own
     * connection and refuses anything that is not the runner — so the answer
     * arrives here and the server relays it. Reachable by `approval-control`
     * only; the branch below refuses it for every other purpose.
     */
    template('POST', '/v1/managed/sessions/:sessionId/permission'),
];

/** The one route an approver may use that a reader may not. */
const APPROVAL_ROUTE = 'POST /v1/managed/sessions/:sessionId/permission';

/** Socket events a managed child may emit, and where each carries its session. */
const ALLOWED_EVENTS: Readonly<Record<string, 'sid' | 'sessionId'>> = {
    'session-stream': 'sid',
    'session-alive': 'sid',
    'session-end': 'sid',
    'update-metadata': 'sid',
    'update-state': 'sid',
    'usage-report': 'sessionId',
    'provider-usage-report': 'sessionId',
};

/** Events that carry no session of their own and are safe for any bearer. */
const SESSIONLESS_EVENTS: readonly string[] = ['ping', 'rpc-register', 'rpc-unregister'];

/**
 * RPC names a managed child may register, without the `${sessionId}:` prefix.
 *
 * The first group is what a Claude or Codex session registers for its own
 * lifecycle; the second is `registerCommonHandlers`, which a session registers
 * against its own working directory.
 */
const ALLOWED_RPC_NAMES: readonly string[] = [
    'permission',
    'abort',
    // `steer` is deliberately absent. It injects free text into the turn that
    // is already running, which is an instruction the run's admission never
    // covered, and the name carries no sub-mode that could be allowed on its
    // own — unlike `goal-action`, where clearing removes an instruction and
    // only setting one is refused, by the child that can read the parameters.
    'goal-action',
    'killSession',
    'mcp-reconnect',

    'bash',
    'copyFile',
    'deleteFile',
    'difftastic',
    'ensureDirectory',
    'getDirectoryTree',
    'listDirectory',
    'readFile',
    'readFileChunk',
    'renameFile',
    'ripgrep',
    'writeFile',
];

/**
 * Names a real consumer registers that this scope does not support yet.
 *
 * `switch` moves a Claude session to another local agent, which is a decision
 * about the managed runtime's own lifecycle rather than an action inside the
 * session. Refusing it as an unknown name would look like a bug at the child;
 * naming it as an unsupported capability says the contract has not been decided
 * rather than that the call was malformed.
 */
const UNSUPPORTED_RPC_NAMES: readonly string[] = ['switch'];

/**
 * Splits a request path into segments.
 *
 * A query string is dropped and each segment is decoded, so `%2e%2e` cannot
 * smuggle a traversal past a literal comparison. An undecodable segment is a
 * refusal, never a best-effort guess at what was meant.
 */
function pathSegments(path: string): string[] | null {
    const withoutQuery = path.split('?')[0].split('#')[0];
    const raw = withoutQuery.split('/').filter((segment) => segment.length > 0);
    const decoded: string[] = [];
    for (const segment of raw) {
        let value: string;
        try {
            value = decodeURIComponent(segment);
        } catch {
            return null;
        }
        if (value.length === 0 || value === '.' || value === '..' || value.includes('/')) return null;
        decoded.push(value);
    }
    return decoded;
}

/**
 * Decides one HTTP request for a managed bearer.
 *
 * `POST /v2/sessions/lookup` takes its scope from the body rather than the
 * path, so it is checked there: the request must ask for exactly the granted
 * session. Anything wider would be a way to read the account's other sessions
 * through a route whose path looks harmless.
 */
export function authorizeManagedHttpRequest(input: {
    method: string;
    path: string;
    sessionId: string;
    body?: unknown;
    /**
     * What the bearer is for. **Required**, and deliberately not optional.
     *
     * An optional field with a `runner` default is a field a new call site
     * forgets — and forgetting it here means a read token is authorised as a
     * runner, which is the exact failure this axis exists to prevent. Tokens
     * minted before this axis existed are normalised to `runner` where they
     * are decoded (`parseSessionScopedClaims`), so every caller has a value to
     * pass and none has to invent one.
     */
    purpose: SessionScopedPurpose;
}): ManagedScopeDecision {
    const segments = pathSegments(input.path);
    if (!segments) return deny('malformed-path');

    // Shape first, then method, then session — so a caller is told which of the
    // three it got wrong instead of a single opaque refusal.
    const sameShape = ALLOWED_ROUTES.filter((route) => matchesShape(route, segments));
    if (sameShape.length === 0) return deny('route-not-allowed');

    const method = input.method.toUpperCase();
    const route = sameShape.find((candidate) => candidate.method === method);
    if (!route) return deny('method-not-allowed');

    if (!matchesSession(route, segments, input.sessionId)) return deny('session-mismatch');

    /*
     * A read bearer reads. It reaches the transcript, the events, the key
     * envelope it needs to decrypt them, and attachment **downloads** — and
     * nothing that writes or runs. Handing somebody a transcript must not hand
     * them the ability to post into the session or upload into it.
     *
     * `approval-control` adds no HTTP surface of its own: answering a
     * permission prompt happens over RPC, and the read surface is what it needs
     * to show the person what they are approving.
     */
    const named = `${route.method} /${route.segments.join('/')}`;
    /*
     * Answering is the approver's one act, and **only** the approver's.
     *
     * Stated before the read/runner split rather than inside it: a permission
     * prompt exists because the run is not trusted to decide, so the run's own
     * bearer must not be able to answer it either. Written as an exception to
     * "not a runner", a runner sailed past this route entirely — it was never
     * asked about — and the run could approve itself over HTTP.
     */
    if (named === APPROVAL_ROUTE) {
        if (input.purpose !== 'approval-control') return deny('purpose-not-allowed');
    } else if (input.purpose !== 'runner' && !isReadableRoute(route)) {
        // A reader reads; nothing that writes or runs.
        return deny('purpose-not-allowed');
    }

    if (route.segments[route.segments.length - 1] === 'lookup') {
        return authorizeLookupBody(input.body, input.sessionId);
    }
    return ALLOW;
}

/**
 * The routes a non-runner bearer may use.
 *
 * Written as a list of what is allowed rather than of what is not: a route
 * added to `ALLOWED_ROUTES` later is then reachable by runners only, and
 * opening it to readers is a deliberate edit here.
 */
const READABLE_ROUTES: readonly string[] = [
    'GET /v3/sessions/:sessionId/messages',
    'GET /v3/sessions/:sessionId/events',
    'POST /v2/sessions/lookup',
    'POST /v1/sessions/:sessionId/attachments/request-download',
    'GET /v1/sessions/:sessionId/attachments/:file',
];

function isReadableRoute(route: RouteTemplate): boolean {
    return READABLE_ROUTES.includes(`${route.method} /${route.segments.join('/')}`);
}

/** Route shape without the session comparison, so a mismatch is reported as one. */
function matchesShape(route: RouteTemplate, segments: readonly string[]): boolean {
    if (route.segments.length !== segments.length) return false;
    return route.segments.every((expected, index) =>
        expected === ':sessionId' || expected === ':file' || expected === segments[index]);
}

function matchesSession(
    route: RouteTemplate,
    segments: readonly string[],
    sessionId: string,
): boolean {
    return route.segments.every((expected, index) =>
        expected !== ':sessionId' || segments[index] === sessionId);
}

function authorizeLookupBody(body: unknown, sessionId: string): ManagedScopeDecision {
    if (!body || typeof body !== 'object') return deny('lookup-scope-too-broad');
    const ids = (body as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return deny('lookup-scope-too-broad');
    if (ids.length !== 1 || ids[0] !== sessionId) return deny('lookup-scope-too-broad');
    return ALLOW;
}

/**
 * Decides one socket event for a managed bearer.
 *
 * An event that names a session must name the granted one. `ping` and the RPC
 * registration events carry no session; the name a registration claims is
 * checked by `authorizeManagedRpcName`, which is where the scope actually lives.
 */
export function authorizeManagedSocketEvent(input: {
    /** Required for the same reason as above: an omitted purpose is a runner. */
    purpose: SessionScopedPurpose;
    event: string;
    payload: unknown;
    sessionId: string;
}): ManagedScopeDecision {
    /*
     * A non-runner bearer emits nothing on this socket. Every event here
     * reports or changes what the run is doing — streaming its output, ending
     * it, rewriting its metadata — and none of that is reading a transcript or
     * answering a prompt. `rpc-register` stays reachable so an approval bearer
     * can register the one name it is allowed; the name itself is checked in
     * `authorizeManagedRpcName`.
     */
    const purpose = input.purpose;
    if (purpose !== 'runner' && !SESSIONLESS_EVENTS.includes(input.event)) {
        return deny('purpose-not-allowed');
    }
    if (purpose === 'transcript-read' && input.event !== 'ping') {
        // A reader registers nothing at all.
        return deny('purpose-not-allowed');
    }
    if (SESSIONLESS_EVENTS.includes(input.event)) return ALLOW;

    const field = ALLOWED_EVENTS[input.event];
    if (!field) return deny('event-not-allowed');
    if (!input.payload || typeof input.payload !== 'object') return deny('session-mismatch');
    const claimed = (input.payload as Record<string, unknown>)[field];
    return claimed === input.sessionId ? ALLOW : deny('session-mismatch');
}

/**
 * Decides one `rpc-register` / `rpc-unregister` name.
 *
 * The wire name is `${sessionId}:${rpcName}`. Both halves are checked: the
 * prefix must be exactly the granted session, and the remainder must be a name
 * on the list. Accepting the prefix alone would let a child register any
 * method it can spell.
 */
export function authorizeManagedRpcName(input: {
    method: string;
    sessionId: string;
    purpose: SessionScopedPurpose;
}): ManagedScopeDecision {
    const prefix = `${input.sessionId}:`;
    if (!input.method.startsWith(prefix)) return deny('session-mismatch');
    const name = input.method.slice(prefix.length);
    if (name.length === 0 || name.includes(':')) return deny('rpc-name-malformed');
    if (UNSUPPORTED_RPC_NAMES.includes(name)) return deny('capability-not-supported');
    if (!ALLOWED_RPC_NAMES.includes(name)) return deny('rpc-name-not-allowed');
    /*
     * `runner` keeps the whole list — that is the run's own credential.
     *
     * `approval-control` answers permission prompts and nothing else: not
     * `bash`, not `writeFile`, not `goal-action`. Those are the run's work, and
     * a person approving a prompt is not taking the run over.
     *
     * `transcript-read` registers nothing at all. Reading is reading.
     */
    const purpose = input.purpose;
    if (purpose === 'runner') return ALLOW;
    if (purpose === 'approval-control' && name === 'permission') return ALLOW;
    return deny('purpose-not-allowed');
}

/** Exposed so a coverage test can compare the list against real consumers. */
export const MANAGED_SCOPE_SURFACE = {
    routes: ALLOWED_ROUTES.map((route) => `${route.method} /${route.segments.join('/')}`),
    events: [...Object.keys(ALLOWED_EVENTS), ...SESSIONLESS_EVENTS],
    rpcNames: ALLOWED_RPC_NAMES,
    unsupportedRpcNames: UNSUPPORTED_RPC_NAMES,
} as const;
