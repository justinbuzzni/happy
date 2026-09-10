/**
 * The envelope a managed Cloud spawn hands to the child, and how it is read.
 *
 * ## Why a file descriptor
 *
 * The envelope carries the session's raw key and a scoped bearer. Anything in
 * `argv` is world-readable through `/proc`, and anything in the environment is
 * inherited by every process the agent later starts — the daemon passes its
 * whole `process.env` down on the ordinary spawn path. So the parent opens the
 * envelope, passes the *descriptor*, and only its number travels in the
 * environment. The number alone is useless to anyone who did not inherit it.
 *
 * The read is bounded and runs to EOF — a single `read` may return fewer bytes
 * than are there — and the descriptor is closed on every path, including a
 * refusal: a descriptor left open is a copy of the secret that outlives the
 * parse.
 *
 * Descriptor inheritance by stdio position is a POSIX arrangement; this path
 * is written for the Linux runtimes managed Cloud actually runs on.
 *
 * ## What is checked
 *
 * `bootstrap.serverOrigin` is the **Happy** server — precreate, control and
 * lookup. `gateway.baseUrl` is the **Saycode** public origin plus one approved
 * provider path. They are separate services and may be separate origins; a
 * check that forced them together would be a check that cannot run in
 * production. What is refused is a gateway URL carrying credentials, a query,
 * a fragment, an unapproved path, or plaintext transport.
 *
 * Errors name the field and nothing else. A message that quoted the value
 * would put a bearer or a key into a log line.
 */
import { promises as fs, closeSync, openSync, read } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

/** The agents this deployment actually runs, mirroring the parent's list. */
export const MANAGED_SPAWN_AGENTS = ['claude', 'codex'] as const;
export type ManagedSpawnAgent = (typeof MANAGED_SPAWN_AGENTS)[number];

export const MANAGED_SPAWN_WIRE_VERSION = 1;

/** The one variable that says a spawn is managed, carrying only a number. */
export const MANAGED_BOOTSTRAP_FD_ENV = 'HAPPY_MANAGED_BOOTSTRAP_FD';

/**
 * The child's hard ceiling on an envelope, in bytes.
 *
 * Derived from what the parent can actually admit rather than from what an
 * envelope usually weighs: `cloudRunRoutes` reads at most 1 MiB of request
 * body, and the admission payload cap is configurable beneath that. The
 * envelope adds the bootstrap and gateway fields around that payload — two
 * base64 keys, a token, an origin, a capability — and JSON escaping can double
 * the byte count of a prompt that is mostly non-ASCII or quoted.
 *
 * 2 MiB therefore holds any payload the parent can accept plus that overhead,
 * with room to spare. It is a transport guard, not a product limit: a prompt
 * the parent admitted must never fail here, and this side does not decide how
 * large a prompt a user may write.
 */
export const MANAGED_BOOTSTRAP_MAX_BYTES = 2 * 1024 * 1024;

const RAW_KEY_BYTES = 32;
/** version 1 + ephemeral public key 32 + nonce 24 + (32 payload + 16 tag). */
const WRAPPED_KEY_BYTES = 105;

/**
 * The gateway routes this child may call, as whole rows.
 *
 * The agent, the provider, the endpoint name and the path are one fact, not
 * four independent strings: a row that mixed `claude` with the OpenAI endpoint
 * would run one provider and bill another. The parent registers exactly these
 * routes, so they are compared as a unit rather than each field being accepted
 * on its own.
 */
export const GATEWAY_ROUTES: ReadonlyArray<{
    agent: ManagedSpawnAgent;
    provider: string;
    endpoint: string;
    /** The whole route, as the parent registers and signs it. */
    path: string;
    /**
     * How much of that route the client is given.
     *
     * Each client appends the rest itself, so handing over the whole route
     * produces a doubled path that is not a route at all: the Anthropic SDK
     * builds `new URL(baseURL + '/v1/messages')`, and the Codex provider
     * appends `/responses` to `base_url`.
     */
    clientBasePath: string;
}> = [
    {
        agent: 'claude', provider: 'anthropic', endpoint: 'anthropic-messages',
        path: '/api/cloud/gateway/anthropic/v1/messages',
        clientBasePath: '/api/cloud/gateway/anthropic',
    },
    {
        agent: 'codex', provider: 'openai', endpoint: 'openai-responses',
        path: '/api/cloud/gateway/openai/v1/responses',
        clientBasePath: '/api/cloud/gateway/openai/v1',
    },
];

export type ManagedSpawnBootstrap = {
    version: typeof MANAGED_SPAWN_WIRE_VERSION;
    serverOrigin: string;
    sessionId: string;
    encryptionVariant: 'dataKey';
    rawKeyBase64: string;
    wrappedKeyBase64: string;
    scopedToken: string;
    tokenExpiresAt: number;
};

export type ManagedSpawnGateway = {
    baseUrl: string;
    capability: string;
    provider: string;
    endpoint: string;
    model: string;
};

export type ManagedSpawnEnvelope = {
    directory: string;
    agent: ManagedSpawnAgent;
    model: string;
    effort: string;
    initialPrompt: string;
    initialPromptLocalId: string;
    bootstrap: ManagedSpawnBootstrap;
    gateway: ManagedSpawnGateway;
};

export class ManagedSpawnEnvelopeError extends Error {
    readonly field: string;
    constructor(field: string, detail: string) {
        super(`${field}: ${detail}`);
        this.name = 'ManagedSpawnEnvelopeError';
        this.field = field;
    }
}

function fail(field: string, detail: string): never {
    throw new ManagedSpawnEnvelopeError(field, detail);
}

function object(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(field, 'must be an object');
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') fail(field, 'must be a non-empty string');
    return value;
}

function base64OfExactly(value: unknown, field: string, bytes: number): string {
    const raw = text(value, field);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) fail(field, 'must be base64');
    const decoded = Buffer.from(raw, 'base64');
    // A value that only looks like base64 does not survive the round trip.
    if (decoded.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
        fail(field, 'must be base64');
    }
    if (decoded.byteLength !== bytes) fail(field, `must decode to ${bytes} bytes`);
    return raw;
}

function httpsOrigin(value: unknown, field: string): string {
    const raw = text(value, field);
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return fail(field, 'must be an absolute URL');
    }
    // Plaintext would carry the bearer and the key in the clear. The one
    // exception is a loopback address, where there is no network to read —
    // the same rule the server side of this contract already applies.
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        fail(field, 'must use https, or http on loopback');
    }
    return raw;
}

function parseBootstrap(value: unknown, now: number): ManagedSpawnBootstrap {
    const raw = object(value, 'bootstrap');
    if (raw.version !== MANAGED_SPAWN_WIRE_VERSION) fail('bootstrap.version', 'unsupported version');
    const serverOrigin = httpsOrigin(raw.serverOrigin, 'bootstrap.serverOrigin');
    if (raw.encryptionVariant !== 'dataKey') {
        // A legacy-variant session is sealed with an account secret this child
        // does not have and must never be given.
        fail('bootstrap.encryptionVariant', 'must be dataKey');
    }
    const tokenExpiresAt = raw.tokenExpiresAt;
    if (!Number.isSafeInteger(tokenExpiresAt)) fail('bootstrap.tokenExpiresAt', 'must be an integer');
    if ((tokenExpiresAt as number) <= now) fail('bootstrap.tokenExpiresAt', 'has already passed');
    return {
        version: MANAGED_SPAWN_WIRE_VERSION,
        serverOrigin,
        sessionId: text(raw.sessionId, 'bootstrap.sessionId'),
        encryptionVariant: 'dataKey',
        rawKeyBase64: base64OfExactly(raw.rawKeyBase64, 'bootstrap.rawKeyBase64', RAW_KEY_BYTES),
        wrappedKeyBase64: base64OfExactly(
            raw.wrappedKeyBase64, 'bootstrap.wrappedKeyBase64', WRAPPED_KEY_BYTES,
        ),
        scopedToken: text(raw.scopedToken, 'bootstrap.scopedToken'),
        tokenExpiresAt: tokenExpiresAt as number,
    };
}

function parseGateway(
    value: unknown,
    agent: ManagedSpawnAgent,
    selectedModel: string,
): ManagedSpawnGateway {
    const raw = object(value, 'gateway');
    const baseUrl = httpsOrigin(raw.baseUrl, 'gateway.baseUrl');
    const url = new URL(baseUrl);
    if (url.username !== '' || url.password !== '') fail('gateway.baseUrl', 'must not carry credentials');
    if (url.search !== '' || url.hash !== '') fail('gateway.baseUrl', 'must be a bare path');

    const provider = text(raw.provider, 'gateway.provider');
    const endpoint = text(raw.endpoint, 'gateway.endpoint');
    const route = GATEWAY_ROUTES.find((candidate) => candidate.agent === agent);
    if (!route) fail('gateway.provider', 'no gateway route for this agent');
    // One row, matched whole. Any single field being plausible on its own is
    // exactly the mistake this is here to prevent.
    if (provider !== route.provider) fail('gateway.provider', 'is not this agent\'s provider');
    if (endpoint !== route.endpoint) fail('gateway.endpoint', 'is not this agent\'s endpoint');
    if (url.pathname !== route.path) fail('gateway.baseUrl', 'path is not this agent\'s route');

    const model = text(raw.model, 'gateway.model');
    // Two model axes that disagree bill one model while running another.
    if (model !== selectedModel) fail('gateway.model', 'differs from the selected model');
    return {
        baseUrl,
        capability: text(raw.capability, 'gateway.capability'),
        provider,
        endpoint,
        model,
    };
}

export function parseManagedSpawnEnvelope(value: unknown, now: number): ManagedSpawnEnvelope {
    const raw = object(value, 'envelope');
    // The version lives on `bootstrap`, which is where the parent puts it; the
    // params object around it carries none, so requiring one here would refuse
    // every real envelope.
    const agent = text(raw.agent, 'agent');
    if (!(MANAGED_SPAWN_AGENTS as readonly string[]).includes(agent)) fail('agent', 'is not supported');
    const directory = text(raw.directory, 'directory');
    // The root is the literal, not whatever the envelope would like it to be.
    if (directory !== MANAGED_PROJECT_ROOT) fail('directory', 'is not the managed project root');
    const model = text(raw.model, 'model');
    return {
        directory,
        agent: agent as ManagedSpawnAgent,
        model,
        effort: text(raw.effort, 'effort'),
        initialPrompt: text(raw.initialPrompt, 'initialPrompt'),
        initialPromptLocalId: text(raw.initialPromptLocalId, 'initialPromptLocalId'),
        bootstrap: parseBootstrap(raw.bootstrap, now),
        gateway: parseGateway(raw.gateway, agent as ManagedSpawnAgent, model),
    };
}

/**
 * Reads the envelope off an inherited descriptor and closes it.
 *
 * Bounded: one read of at most the cap plus a byte, so an oversized envelope
 * is refused rather than buffered. The descriptor is closed in `finally`,
 * because a refusal that leaves it open leaves the secret readable.
 */
export async function readManagedSpawnEnvelopeFromFd(
    fd: number,
    now: number,
): Promise<ManagedSpawnEnvelope> {
    if (!Number.isInteger(fd) || fd < 0) {
        throw new ManagedSpawnEnvelopeError('descriptor', 'must be a non-negative integer');
    }
    try {
        // One read is not a guarantee of the whole file: a short read is legal
        // and says nothing about EOF. Read until the descriptor reports zero
        // bytes, and stop the moment more than the cap has arrived.
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.alloc(16 * 1024);
            const bytes = await readOnce(fd, chunk);
            if (bytes === 0) break;
            total += bytes;
            if (total > MANAGED_BOOTSTRAP_MAX_BYTES) {
                throw new ManagedSpawnEnvelopeError('envelope', 'is too large');
            }
            chunks.push(chunk.subarray(0, bytes));
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            // The text is not repeated: it is the envelope.
            throw new ManagedSpawnEnvelopeError('envelope', 'is not valid JSON');
        }
        return parseManagedSpawnEnvelope(parsed, now);
    } finally {
        // Closed on every path. A refusal that leaves it open leaves a readable
        // copy of the secret behind for the rest of the process's life.
        try { closeSync(fd); } catch { /* already gone */ }
    }
}

/**
 * One sequential read.
 *
 * The position is `null` deliberately: a descriptor may be a pipe, and a pipe
 * has no position — a positional read on one fails with `ESPIPE`. The parent
 * hands over a freshly opened descriptor at offset zero, so reading
 * sequentially from wherever it stands is both correct and the only thing that
 * works for every kind of descriptor this can be.
 */
function readOnce(fd: number, into: Buffer): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        read(fd, into, 0, into.length, null, (error, bytes) => {
            if (error) reject(error);
            else resolve(bytes);
        });
    });
}

/**
 * The descriptor number the child sees.
 *
 * A spawned process is handed descriptors by position: 0, 1 and 2 are its
 * standard streams, so the first slot available for anything else is 3. The
 * parent's own number for the same open file is different and irrelevant to
 * the child — what goes in the environment is the number the child will use.
 */
export const MANAGED_BOOTSTRAP_CHILD_FD = 3;

export type StagedManagedSpawnEnvelope = {
    /** The parent's descriptor, to be placed in the child's stdio slot. */
    fd: number;
    /** Exactly one variable, carrying exactly one number. */
    env: Record<string, string>;
    /** The stdio layout that actually hands the descriptor over. */
    stdio: Array<'ignore' | number>;
};

/**
 * Writes the envelope somewhere only an inherited descriptor can reach it.
 *
 * The file is unlinked while still open, so it has no name from the moment it
 * exists: nothing on the filesystem can be opened by another process, and the
 * only route to the bytes is the descriptor handed to the child. The secrets
 * never appear in `argv` or in the environment, which the agent inherits
 * wholesale and can print.
 */
export async function stageManagedSpawnEnvelope(
    envelope: ManagedSpawnEnvelope,
): Promise<StagedManagedSpawnEnvelope> {
    // A private directory of our own, created 0700 before anything is written:
    // a file in the shared temp directory is briefly visible to every user on
    // the machine between creation and unlink, and mode bits on the file do
    // not close that window for a reader who opened it first.
    const dir = await fs.mkdtemp(join(tmpdir(), 'happy-managed-'));
    const path = join(dir, 'bootstrap.json');
    let fd: number | null = null;
    try {
        // Exclusive create: never an existing path, never a symlink someone
        // else planted.
        await fs.writeFile(path, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
        fd = openSync(path, 'r');
        return {
            fd,
            env: { [MANAGED_BOOTSTRAP_FD_ENV]: String(MANAGED_BOOTSTRAP_CHILD_FD) },
            stdio: ['ignore', 'ignore', 'ignore', fd],
        };
    } catch (error) {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* nothing to close */ }
        }
        throw error;
    } finally {
        // The name goes as soon as the descriptor exists — or immediately, if
        // it never did. Either way nothing is left for another process to open,
        // and the directory goes with it.
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Closes a staged descriptor the child never received.
 *
 * A spawn that throws leaves the parent holding an open copy of the envelope;
 * the caller owns closing it, and this names that duty rather than leaving it
 * to a comment.
 */
export function discardStagedManagedSpawnEnvelope(staged: StagedManagedSpawnEnvelope): void {
    try { closeSync(staged.fd); } catch { /* already gone */ }
}
