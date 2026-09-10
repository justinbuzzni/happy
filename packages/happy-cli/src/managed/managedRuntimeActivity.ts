/**
 * Whether a managed runtime is being used, and whether it may be stopped.
 *
 * The two questions are separate on purpose. "Nobody is using this" is a
 * judgement about signals; "this can be stopped" additionally requires that
 * the work already done is safely on the store. Answering the first and acting
 * as if it settled the second is how a runtime gets stopped with unsaved work
 * on its volume.
 *
 * ## A heartbeat is not use
 *
 * A connected socket proves a socket. Plan §6.3 lists what actually counts —
 * a running turn, an open tool, a user waiting to approve, writes, an active
 * terminal, real preview requests, background jobs — and what does not: a
 * watcher or a `npm run dev` sitting there is not a reason to bill forever,
 * though a job running under one is.
 *
 * ## The numbers are not here
 *
 * Fifteen minutes and seven days are proposals in the plan, to be settled by
 * measurement and pricing. A policy has to be supplied; without one this
 * answers `undecidable`, which no caller may read as permission to stop. The
 * same applies to anything it cannot see clearly: a writer whose processes
 * could not be proven stopped means something may still be writing, and an
 * approval that cannot be resumed means sleeping would lose the user's place.
 */
export type RuntimeActivitySignal =
    /** A turn is executing. */
    | { kind: 'turn-running' }
    /** A tool call is in flight. */
    | { kind: 'open-tool' }
    /** A tool ended without proving its processes stopped. */
    | { kind: 'unproven-writer' }
    /** The user has been asked something and has not answered. */
    | { kind: 'approval-pending'; resumable: boolean }
    /** A terminal session with a live client. */
    | { kind: 'active-terminal' }
    /** Work the user started that is still running. */
    | { kind: 'background-job' }
    /** A watcher or dev server. Not use on its own. */
    | { kind: 'dev-process' }
    /** A real request served by the preview. */
    | { kind: 'preview-request' }
    /** A connected client. Never use. */
    | { kind: 'socket-heartbeat' };

/**
 * Explicitly configured, never defaulted. `previewOnlyIdleGraceMs` applies
 * when the preview is the only thing that has been used — plan §6.3 keeps that
 * on its own policy.
 */
export type RuntimeIdlePolicy = {
    idleGraceMs: number;
    previewOnlyIdleGraceMs?: number;
};

export type RuntimeIdleDecision =
    | { state: 'active'; because: RuntimeActivitySignal['kind'][] }
    | { state: 'idle'; forMs: number }
    | {
        state: 'undecidable';
        reason: 'no-policy' | 'unproven-writer' | 'approval-not-resumable';
    };

/** Signals that mean the runtime is in use right now, whatever the clock says. */
const USE_NOW: ReadonlySet<RuntimeActivitySignal['kind']> = new Set([
    'turn-running',
    'open-tool',
    'active-terminal',
    'background-job',
]);

export function evaluateRuntimeIdle(input: {
    signals: readonly RuntimeActivitySignal[];
    /** When something that counts as use last happened. */
    lastActivityAtMs: number;
    now: number;
    policy: RuntimeIdlePolicy | null;
}): RuntimeIdleDecision {
    // Checked before the policy: not knowing what is still writing is a worse
    // problem than not knowing the timeouts, and neither may end in a stop.
    if (input.signals.some((signal) => signal.kind === 'unproven-writer')) {
        return { state: 'undecidable', reason: 'unproven-writer' };
    }
    if (input.signals.some((signal) => signal.kind === 'approval-pending' && !signal.resumable)) {
        return { state: 'undecidable', reason: 'approval-not-resumable' };
    }
    if (!input.policy) return { state: 'undecidable', reason: 'no-policy' };

    const because = input.signals.map((signal) => signal.kind).filter((kind) => USE_NOW.has(kind));
    if (because.length > 0) return { state: 'active', because };

    // The preview alone gets its own grace; a preview request next to real
    // work is just one more thing that happened, under the ordinary rule.
    const previewOnly = input.signals.some((signal) => signal.kind === 'preview-request');
    const grace = previewOnly
        ? input.policy.previewOnlyIdleGraceMs ?? input.policy.idleGraceMs
        : input.policy.idleGraceMs;

    const sinceMs = input.now - input.lastActivityAtMs;
    if (sinceMs <= grace) return { state: 'active', because: [] };
    return { state: 'idle', forMs: sinceMs };
}

/** What the runtime knows about its most recent checkpoint. */
export type RuntimeCheckpointState =
    | { saved: true; checkpointId: string; manifestDigest: string }
    | { saved: false; detail?: string };

export type RuntimeStopDecision =
    | { stop: true; checkpointId: string }
    | {
        stop: false;
        reason: 'not-idle' | 'undecidable' | 'no-verified-checkpoint';
        detail?: string;
    };

/**
 * Stopping needs both: nobody is using it, and the work is saved.
 *
 * A checkpoint that failed — disk full, a torn upload, anything — is not a
 * checkpoint, and the runtime must report that no save succeeded rather than
 * stopping on the strength of an older one it did not verify here.
 */
export function mayStopRuntime(input: {
    idle: RuntimeIdleDecision;
    checkpoint: RuntimeCheckpointState;
}): RuntimeStopDecision {
    if (input.idle.state === 'undecidable') {
        return { stop: false, reason: 'undecidable', detail: input.idle.reason };
    }
    if (input.idle.state !== 'idle') return { stop: false, reason: 'not-idle' };
    if (!input.checkpoint.saved) {
        return {
            stop: false,
            reason: 'no-verified-checkpoint',
            ...(input.checkpoint.detail === undefined ? {} : { detail: input.checkpoint.detail }),
        };
    }
    return { stop: true, checkpointId: input.checkpoint.checkpointId };
}
