/**
 * The startup a managed Cloud child performs instead of the ordinary one.
 *
 * The ordinary path authenticates an account, registers a machine and creates
 * a session. None of that is available here and none of it should be: the
 * parent already created the session, and this process holds only a bearer
 * scoped to it plus that session's raw key.
 *
 * The envelope arrives on an inherited descriptor whose number is the only
 * thing in the environment, and that variable is consumed on read — a
 * descriptor number left lying around is either closed or, later, reused for
 * something else entirely.
 */
import {
    GATEWAY_ROUTES,
    MANAGED_BOOTSTRAP_FD_ENV,
    readManagedSpawnEnvelopeFromFd,
    ManagedSpawnEnvelopeError,
    type ManagedSpawnEnvelope,
} from '@/managed/managedSpawnBootstrap';
import { attachManagedSession, ManagedAttachError, type ManagedAttachment } from '@/managed/managedSessionAttach';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

export type ManagedStartup = {
    envelope: ManagedSpawnEnvelope;
    attachment: ManagedAttachment;
};

/**
 * Reads the managed envelope, if this process was given one, and attaches.
 *
 * Returns `null` for an ordinary spawn — the absence of the variable is the
 * whole signal, and nothing else in the environment can turn managed mode on.
 */
export async function readManagedStartup(
    env: NodeJS.ProcessEnv,
    now: number,
): Promise<ManagedStartup | null> {
    const raw = env[MANAGED_BOOTSTRAP_FD_ENV];
    if (raw === undefined) return null;
    // Consumed before anything can fail, so a retry cannot read a descriptor
    // that has since been closed and reassigned.
    delete env[MANAGED_BOOTSTRAP_FD_ENV];

    const fd = Number(raw);
    // `Number('')` is 0, which is a real descriptor; the text has to look like
    // a number before it is treated as one.
    if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(fd)) {
        throw new ManagedSpawnEnvelopeError('descriptor', 'must be a non-negative integer');
    }

    const envelope = await readManagedSpawnEnvelopeFromFd(fd, now);
    const attachment = await attachManagedSession(envelope.bootstrap, now);
    return { envelope, attachment };
}

/**
 * The offline branch, for a managed run.
 *
 * An unreachable server means this run cannot proceed. The ordinary path
 * answers by creating a fresh session once the server returns, which for a
 * managed run would produce a session sealed with a key the parent never saw —
 * the work would run and its output would be unreadable to everyone waiting
 * for it.
 */
export function resolveManagedOfflineFallback(managed: boolean): void {
    if (managed) {
        throw new ManagedAttachError('a managed run cannot start a new session while the server is unavailable');
    }
}


/**
 * The account bearer, for work that only an account can do.
 *
 * A managed run reaches this only through a path that should have been
 * branched away above it, so the refusal is a bug report, not a fallback.
 */
export function requireAccountMachineId(machineId: string | undefined): string {
    if (machineId === undefined) {
        throw new Error('this operation needs a registered machine; a managed run has none');
    }
    return machineId;
}

export function requireAccountToken(token: string | null): string {
    if (token === null) {
        throw new Error('this operation needs an account token; a managed run has none');
    }
    return token;
}

/**
 * Publishes the envelope's prompt and effort through the seam the agents
 * already consume.
 *
 * The daemon delivers a scheduled prompt, model and effort through
 * `HAPPY_INITIAL_*`, read exactly once by the agent startup. A managed run has
 * the same three values, verified, so it uses the same seam rather than a
 * second one that would have to be kept in step with it. The values are
 * written over anything inherited: an inherited prompt belongs to some other
 * launch.
 */
export function applyManagedInitialPrompt(
    env: NodeJS.ProcessEnv,
    envelope: ManagedSpawnEnvelope,
): void {
    env.HAPPY_INITIAL_PROMPT = envelope.initialPrompt;
    env.HAPPY_INITIAL_PROMPT_LOCAL_ID = envelope.initialPromptLocalId;
    env.HAPPY_INITIAL_MODEL = envelope.model;
    env.HAPPY_INITIAL_EFFORT = envelope.effort;
    // Confirmed delivery is part of what a managed envelope *is*, not something
    // a caller switches on. The prompt is consumed a few lines into the runner
    // and the provider is reached shortly after; without this the run answers
    // the prompt and spends its capability before anything durable records the
    // delivery, and a failure after that cannot be told from one before it.
    env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK = '1';
    // A file-staged prompt from another launch would win over the value above.
    delete env.HAPPY_INITIAL_PROMPT_FILE;
}

/**
 * Drops `--model`/`-m` from caller arguments.
 *
 * The agent CLI takes a model on its own command line, and it wins over the
 * one this process selected. For a managed run that is a caller choosing a
 * model the run was not priced for.
 */
export function stripAgentModelArguments(args: string[] | undefined): string[] | undefined {
    if (!args) return args;
    const kept: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model' || arg === '-m') {
            i++;
            continue;
        }
        if (arg.startsWith('--model=')) continue;
        kept.push(arg);
    }
    return kept;
}

/**
 * Every provider credential an agent CLI will pick up on its own.
 *
 * Listed so they can be removed. An agent that finds one of these in its
 * environment uses it instead of the gateway, which means a managed run
 * billing somebody else's key and sending the run's content to a provider the
 * approval never covered.
 */
const PROVIDER_CREDENTIAL_ENV = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
];

/**
 * Drops provider credentials from a caller-supplied environment overlay.
 *
 * `--claude-env` values are written into `process.env` after startup
 * (`claudeRemote.ts`), so they win over anything decided here. For a managed
 * run that is a caller redirecting the gateway or substituting a key after the
 * approval was made.
 */
export function stripProviderCredentialOverrides(
    overrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!overrides) return overrides;
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides)) {
        if (PROVIDER_CREDENTIAL_ENV.includes(key)) continue;
        kept[key] = value;
    }
    return kept;
}

/**
 * Prefixes naming a session some earlier launch on this runtime was attached
 * to, forked from, or asked to backfill.
 *
 * Prefixes rather than a list of keys, deliberately. The keys under them are
 * added to over time — reconnect alone carries an id, a key, a variant, a
 * snapshot and three versions, and the fork family names both a Claude session
 * and a Codex thread — and a list is a list that will be short by one. The
 * daemon scrubs the same prefixes when it spawns; this is the child doing it
 * for itself, because the environment it starts in is not always one the
 * daemon just built.
 *
 * `HAPPY_INITIAL_` is deliberately absent: those values are this run's own,
 * and are written immediately after this runs.
 */
const FOREIGN_SESSION_LINEAGE_PREFIXES = [
    'HAPPY_RECONNECT_',
    // Covers both `HAPPY_FORK_*` (the native session or thread to resume and
    // backfill from) and `HAPPY_FORKED_FROM_*` (the lineage recorded in
    // metadata).
    'HAPPY_FORK',
    'HAPPY_CREATED_BY',
];

/**
 * Forgets any session this runtime was previously attached to.
 *
 * A reused runtime can still carry an earlier launch's lineage. The runners
 * read it before anything else and act on it: a reconnect id resumes that
 * session, dropping this run's prompt as already delivered and merging the
 * foreign snapshot's metadata; a fork id reads that session's transcript off
 * disk and replays it into *this* session, then rewrites the native session id
 * to match. The result is a managed run showing somebody else's conversation
 * under its own SID.
 *
 * Cleared rather than ignored at each call site: the values reach several
 * readers across two runners, and one missed reader is the whole defect again.
 */
export function clearForeignSessionLineage(env: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(env)) {
        if (FOREIGN_SESSION_LINEAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            delete env[key];
        }
    }
}

/**
 * Points the agent at the approved gateway, and at nothing else.
 *
 * The capability is the only credential this run may spend: it was minted for
 * this run, on this model, against this endpoint. Every other provider
 * credential is cleared first — an inherited key is not a fallback here, it is
 * a way to run outside the approval entirely, and clearing is what makes the
 * gateway the only route rather than the preferred one.
 */
export function applyManagedGatewayEnvironment(
    env: NodeJS.ProcessEnv,
    envelope: ManagedSpawnEnvelope,
): void {
    for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
    const base = managedGatewayClientBaseUrl(envelope);
    if (envelope.agent === 'claude') {
        env.ANTHROPIC_BASE_URL = base;
        env.ANTHROPIC_AUTH_TOKEN = envelope.gateway.capability;
        return;
    }
    env.OPENAI_BASE_URL = base;
    env.OPENAI_API_KEY = envelope.gateway.capability;
}

/** The provider id this run's configuration is registered under. */
export const MANAGED_CODEX_PROVIDER_ID = 'saycode-managed';

/**
 * The base URL to hand a client, derived from the approved route.
 *
 * The envelope carries the whole route because that is what the parent signed
 * and prices. Each client appends its own suffix to whatever base it is given,
 * so the base is the route minus that suffix — computed from the approved row
 * rather than by trimming the string, and checked against the route so a
 * mismatch is a refusal instead of a quietly different address.
 */
export function managedGatewayClientBaseUrl(envelope: ManagedSpawnEnvelope): string {
    const route = GATEWAY_ROUTES.find((candidate) => candidate.agent === envelope.agent);
    if (!route) throw new ManagedAttachError('no gateway route for this agent');
    const url = new URL(envelope.gateway.baseUrl);
    if (url.pathname !== route.path) {
        throw new ManagedAttachError('the gateway route is not the one this agent was approved for');
    }
    return `${url.origin}${route.clientBasePath}`;
}

/** Named for the SDK it configures, so call sites read as what they set. */
export function managedClaudeGatewayBaseUrl(envelope: ManagedSpawnEnvelope): string {
    return managedGatewayClientBaseUrl(envelope);
}

/**
 * The whole provider configuration the Codex CLI is started with.
 *
 * Passed as command-line configuration rather than left to the user's config
 * file: `model_provider` there selects which of the on-disk providers is used,
 * and an on-disk provider is somebody else's account. Every axis the CLI would
 * otherwise read — base URL, which environment variable holds the key, the
 * wire protocol, whether OpenAI auth is required — is pinned here.
 */
export function managedCodexProviderArguments(envelope: ManagedSpawnEnvelope): string[] {
    const base = managedGatewayClientBaseUrl(envelope);
    const provider = `model_providers.${MANAGED_CODEX_PROVIDER_ID}`;
    return [
        '-c', `${provider}.name="Saycode managed gateway"`,
        '-c', `${provider}.base_url="${base}"`,
        '-c', `${provider}.env_key="OPENAI_API_KEY"`,
        '-c', `${provider}.requires_openai_auth=false`,
        '-c', `${provider}.wire_api="responses"`,
        '-c', `model_provider="${MANAGED_CODEX_PROVIDER_ID}"`,
    ];
}

/**
 * Requires the process to actually be standing in the runtime's project root.
 *
 * Rewriting `metadata.path` only changes what is displayed. The agent reads and
 * writes relative to the real working directory, so a managed run that started
 * somewhere else would edit files outside the workspace it was granted while
 * reporting that it was inside it.
 */
export function assertManagedWorkingDirectory(cwd: string): void {
    if (cwd !== MANAGED_PROJECT_ROOT) {
        throw new ManagedAttachError('a managed run must start in the runtime project root');
    }
}

/**
 * Which filesystem settings sources a session may load.
 *
 * `undefined` is not "none" — it is the SDK's default, which loads every source
 * Claude Code would, including `~/.claude/settings.json`. A settings file's
 * `env` block is applied to the agent and wins over the environment this
 * startup produced, so for a managed run "none" has to be said explicitly.
 */
export function managedSettingSources<T>(
    lockdown: boolean | undefined,
    configured: T[] | undefined,
): T[] | undefined {
    return lockdown ? ([] as T[]) : configured;
}
