/**
 * Session lineage environment variables must never be inherited implicitly.
 *
 * HAPPY_RECONNECT_* attaches a child to an EXISTING happy session and
 * HAPPY_FORK* attaches provider-conversation lineage. They are only valid
 * when the daemon sets them explicitly for one specific spawn (resumeSession
 * / fork RPC). If they leak through `...process.env` — e.g. a resumed child
 * auto-restarts the daemon on version mismatch, and the daemon inherits the
 * child's env — every session the daemon spawns afterwards reconnects to the
 * same happy session. That is the 2026-07-19 incident: chats from every
 * project queued into one session and replayed each other's prompts.
 *
 * APLUS_SESSION_* is the session's own web URL/id exported for agent shell
 * subprocesses (sessionUrlEnv.ts). Scrub it here so a daemon-spawned session
 * starts without stale identity; the child session factory then writes its
 * confirmed current id.
 *
 * SAYCODE_AGENT_* grants per-session orchestration scope. A daemon restarted
 * by one agent must not leak that agent's root/depth/id into unrelated spawns;
 * tracked sessions re-add their captured capability explicitly on resume.
 *
 * HAPPY_CHECKPOINT_* binds protected checkpoint state to one daemon-verified
 * project/worktree. It follows the same no-implicit-inheritance rule.
 */
import {
    CHECKPOINT_SPAWN_CONTEXT_ENV_KEY,
    readCheckpointSpawnContext,
} from '@/checkpoint/checkpointSpawnContext'

// 'HAPPY_INITIAL_' covers HAPPY_INITIAL_PROMPT(_LOCAL_ID) and the
// HAPPY_INITIAL_MODEL / HAPPY_INITIAL_EFFORT spawn seeds.
export const SESSION_LINEAGE_ENV_PREFIXES = ['HAPPY_RECONNECT_', 'HAPPY_FORK', 'HAPPY_CREATED_BY', 'HAPPY_INITIAL_', 'HAPPY_AUTOMATION_', 'HAPPY_ADDITIONAL_DIRECTORIES', 'HAPPY_CHECKPOINT_', 'APLUS_SESSION_', 'SAYCODE_AGENT_'] as const

const SAYCODE_AGENT_ENV_KEYS = [
    'SAYCODE_AGENT_ENV',
    'SAYCODE_AGENT_ROOT',
    // The tree siblings may live in (saycode-cli 0.4.0, Desktop ADR-061). Without it a
    // resumed hub silently shrinks back to its own worktree.
    'SAYCODE_AGENT_SCOPE',
    'SAYCODE_AGENT_DEPTH',
    'SAYCODE_AGENT_MAX_SPAWN',
    'SAYCODE_AGENT_ID',
] as const

type SaycodeAgentEnvironmentKey = typeof SAYCODE_AGENT_ENV_KEYS[number]
const CHECKPOINT_CONTEXT_KEY = CHECKPOINT_SPAWN_CONTEXT_ENV_KEY
type SessionScopedEnvironmentKey = SaycodeAgentEnvironmentKey | typeof CHECKPOINT_CONTEXT_KEY

export type SaycodeAgentEnvironment = Partial<Record<SessionScopedEnvironmentKey, string>>

function isLineageKey(key: string): boolean {
    return SESSION_LINEAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Returns a copy of `env` without lineage variables (and without undefined values). */
export function scrubSessionLineageEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const scrubbed: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isLineageKey(key)) continue
        scrubbed[key] = value
    }
    return scrubbed
}

/** Builds one child environment after removing stale inherited lineage. */
export function buildSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
): Record<string, string> {
    return {
        ...scrubSessionLineageEnv(inherited),
        ...explicit,
    }
}

export function overlayManagedCredentialEnvironment(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return { ...stripManagedCredentialConflicts(requested, managed), ...managed }
}

export function stripManagedCredentialConflicts(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    const effectiveRequested = { ...requested }
    for (const key of Object.keys(managed)) delete effectiveRequested[key]
    if (managed.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic') {
        delete effectiveRequested.ANTHROPIC_API_KEY
        delete effectiveRequested.CLAUDE_CODE_OAUTH_TOKEN
        delete effectiveRequested.ANTHROPIC_MODEL
        delete effectiveRequested.ANTHROPIC_SMALL_FAST_MODEL
        delete effectiveRequested.ANTHROPIC_CUSTOM_HEADERS
        delete effectiveRequested.CLAUDE_CODE_USE_BEDROCK
        delete effectiveRequested.CLAUDE_CODE_USE_VERTEX
        delete effectiveRequested.CLAUDE_CODE_USE_FOUNDRY
    }
    return effectiveRequested
}

export function buildManagedSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return overlayManagedCredentialEnvironment(
        buildSessionSpawnEnvironment(inherited, explicit),
        managed,
    )
}

/** Retains only the per-session Saycode capability needed by a later resume. */
export function captureSaycodeAgentEnvironment(
    env: NodeJS.ProcessEnv,
): SaycodeAgentEnvironment | undefined {
    const captured: SaycodeAgentEnvironment = {}
    if (env.SAYCODE_AGENT_ENV === '1' && env.SAYCODE_AGENT_ROOT?.trim()) {
        Object.assign(captured, Object.fromEntries(
            SAYCODE_AGENT_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
        ))
    }
    const encodedCheckpointContext = env[CHECKPOINT_CONTEXT_KEY]
    if (encodedCheckpointContext && readCheckpointSpawnContext(env)) {
        captured[CHECKPOINT_CONTEXT_KEY] = encodedCheckpointContext
    }
    return Object.keys(captured).length > 0 ? captured : undefined
}

/** Restores one tracked session's capability without inheriting the caller's. */
export function buildResumedSessionSpawnEnvironment(input: {
    inherited: NodeJS.ProcessEnv
    explicit: Record<string, string>
    runtime?: Record<string, string>
    automation?: Record<string, string>
    agentEnvironment?: SaycodeAgentEnvironment
    sessionId: string
}): Record<string, string> {
    return buildSessionSpawnEnvironment(input.inherited, {
        ...scrubSessionLineageEnv(input.runtime ?? {}),
        ...scrubSessionLineageEnv(input.automation ?? {}),
        ...input.explicit,
        ...(input.agentEnvironment ?? {}),
        APLUS_SESSION_ID: input.sessionId,
    })
}

/**
 * Sets or removes the confirmed-delivery switch on a **final** child
 * environment.
 *
 * Applied after the merge because the daemon's own environment is inherited
 * wholesale on the default path: deleting the key from the caller's extras is
 * not enough, since a value already present in `process.env` would survive the
 * merge and turn the switch on for a launch that never asked for it.
 *
 * The switch changes delivery behaviour only. It is not an identity and grants
 * no permission.
 */
export function applyConfirmedPromptDeliveryFlag(
    env: Record<string, string>,
    required: boolean,
): Record<string, string> {
    if (required) return { ...env, HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' }
    const { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: _removed, ...rest } = env
    return rest
}
