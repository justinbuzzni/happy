/**
 * When to take a checkpoint, and what the last one actually proved.
 *
 * Two jobs, and the second is the one that keeps the first honest. Deciding
 * "it is time" is arithmetic; deciding "the last good checkpoint is this one,
 * from this moment" is what every age and RPO number downstream is computed
 * from. An attempt that failed must not move that point — a runtime that
 * reported the age of its last *attempt* would look freshly saved right up
 * until someone needed the data.
 *
 * ## The period is not here
 *
 * Plan §7 asks for periodic checkpoints against an RPO target, and that target
 * is not settled. Without a configured policy this takes none, and no caller
 * may read the absence of a checkpoint as a reason to stop a runtime.
 *
 * ## Being busy is not a reason to skip
 *
 * A periodic checkpoint exists precisely for the runtime that is in use; the
 * drain inside the publisher is what makes the archive consistent, not
 * waiting for quiet. The one thing that does stop it is not knowing what is
 * still writing — an unproven writer means the archive would capture a moment
 * that never existed.
 */
import type { RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

export type CheckpointSchedulePolicy = {
    /** How often a running runtime checkpoints. Configured, never defaulted. */
    periodMs: number;
    /** Whether the end of a turn is itself a reason. */
    onTurnBoundary: boolean;
    /** How long to wait after a failure before trying again. */
    failureBackoffMs?: number;
};

export type CheckpointScheduleState = {
    /** When the last **successful** checkpoint completed. */
    lastSuccessAtMs?: number;
    lastSuccessCheckpointId?: string;
    lastSuccessManifestDigest?: string;
    /** When something was last attempted, successful or not. */
    lastAttemptAtMs?: number;
    lastFailureDetail?: string;
    consecutiveFailures: number;
    inFlight?: boolean;
};

export type CheckpointTrigger = 'periodic' | 'turn-boundary';

export type CheckpointDecision =
    | { take: true; reason: 'periodic' | 'turn-boundary' | 'no-checkpoint-yet' }
    | {
        take: false;
        reason: 'no-policy' | 'not-due' | 'in-flight' | 'backoff' | 'unproven-writer';
    };

export function decideCheckpoint(input: {
    state: CheckpointScheduleState;
    now: number;
    policy: CheckpointSchedulePolicy | null;
    trigger: CheckpointTrigger;
    idle: RuntimeIdleDecision;
}): CheckpointDecision {
    // Whatever else is true, an archive taken while something may still be
    // writing is not a checkpoint of any moment.
    if (input.idle.state === 'undecidable' && input.idle.reason === 'unproven-writer') {
        return { take: false, reason: 'unproven-writer' };
    }
    if (!input.policy) return { take: false, reason: 'no-policy' };
    if (input.state.inFlight === true) return { take: false, reason: 'in-flight' };

    const backoffMs = input.policy.failureBackoffMs;
    if (input.state.consecutiveFailures > 0
        && backoffMs !== undefined
        && input.state.lastAttemptAtMs !== undefined
        && input.now - input.state.lastAttemptAtMs < backoffMs) {
        // Retrying every period against a full disk produces a failure log and
        // nothing else.
        return { take: false, reason: 'backoff' };
    }

    // Nothing saved yet: the first one is due regardless of the clock, because
    // there is no point to measure an interval from.
    if (input.state.lastSuccessAtMs === undefined) return { take: true, reason: 'no-checkpoint-yet' };

    if (input.trigger === 'turn-boundary') {
        return input.policy.onTurnBoundary
            ? { take: true, reason: 'turn-boundary' }
            : { take: false, reason: 'not-due' };
    }
    return input.now - input.state.lastSuccessAtMs >= input.policy.periodMs
        ? { take: true, reason: 'periodic' }
        : { take: false, reason: 'not-due' };
}

export type CheckpointAttemptOutcome =
    | { saved: true; checkpointId: string; manifestDigest: string }
    | { saved: false; detail?: string };

/**
 * Folds an attempt into the state. The saved point moves only on success —
 * that is the whole contract.
 */
export function recordCheckpointOutcome(input: {
    state: CheckpointScheduleState;
    outcome: CheckpointAttemptOutcome;
    now: number;
}): CheckpointScheduleState {
    if (input.outcome.saved) {
        return {
            lastSuccessAtMs: input.now,
            lastSuccessCheckpointId: input.outcome.checkpointId,
            lastSuccessManifestDigest: input.outcome.manifestDigest,
            lastAttemptAtMs: input.now,
            consecutiveFailures: 0,
            inFlight: false,
        };
    }
    return {
        ...input.state,
        lastAttemptAtMs: input.now,
        consecutiveFailures: input.state.consecutiveFailures + 1,
        ...(input.outcome.detail === undefined ? {} : { lastFailureDetail: input.outcome.detail }),
        inFlight: false,
    };
}
