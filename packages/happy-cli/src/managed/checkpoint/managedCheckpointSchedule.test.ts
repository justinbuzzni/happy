import { describe, expect, it } from 'vitest';

import {
    decideCheckpoint,
    recordCheckpointOutcome,
    type CheckpointScheduleState,
    type CheckpointSchedulePolicy,
} from './managedCheckpointSchedule';

const policy: CheckpointSchedulePolicy = { periodMs: 300_000, onTurnBoundary: true };

const clean: CheckpointScheduleState = {
    lastSuccessAtMs: 1_000_000,
    lastSuccessCheckpointId: 'a'.repeat(64),
    consecutiveFailures: 0,
};

describe('decideCheckpoint', () => {
    it('shouldNotCheckpointWithoutAConfiguredPolicy', () => {
        // The RPO target and the period are undecided; a runtime with no
        // policy does not invent one.
        expect(decideCheckpoint({ state: clean, now: 9_000_000, policy: null, trigger: 'periodic', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: false, reason: 'no-policy' });
    });

    it('shouldTakeOneAtATurnBoundaryWhenThePolicySaysSo', () => {
        expect(decideCheckpoint({ state: clean, now: 1_000_001, policy, trigger: 'turn-boundary', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: true, reason: 'turn-boundary' });
        expect(decideCheckpoint({
            state: clean, now: 1_000_001, policy: { ...policy, onTurnBoundary: false },
            trigger: 'turn-boundary', idle: { state: 'idle', forMs: 1 },
        })).toEqual({ take: false, reason: 'not-due' });
    });

    it('shouldTakeAPeriodicOneOnlyOnceThePeriodHasElapsed', () => {
        expect(decideCheckpoint({ state: clean, now: 1_200_000, policy, trigger: 'periodic', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: false, reason: 'not-due' });
        expect(decideCheckpoint({ state: clean, now: 1_400_000, policy, trigger: 'periodic', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: true, reason: 'periodic' });
    });

    it('shouldNotCheckpointWhileSomethingMayStillBeWriting', () => {
        // The archive would capture a moment that never existed.
        expect(decideCheckpoint({
            state: clean, now: 9_000_000, policy, trigger: 'periodic',
            idle: { state: 'undecidable', reason: 'unproven-writer' },
        })).toEqual({ take: false, reason: 'unproven-writer' });
    });

    it('shouldStillCheckpointWhileTheRuntimeIsBusy', () => {
        // Being in use is the reason a periodic checkpoint exists; the drain
        // inside the publisher is what makes it consistent.
        expect(decideCheckpoint({
            state: clean, now: 1_400_000, policy, trigger: 'periodic',
            idle: { state: 'active', because: ['open-tool'] },
        })).toEqual({ take: true, reason: 'periodic' });
    });

    it('shouldNotStartOneBeforeTheLastAttemptHasSettled', () => {
        expect(decideCheckpoint({
            state: { ...clean, inFlight: true }, now: 9_000_000, policy, trigger: 'periodic',
            idle: { state: 'idle', forMs: 1 },
        })).toEqual({ take: false, reason: 'in-flight' });
    });

    it('shouldBackOffAfterRepeatedFailuresInsteadOfRetryingEveryPeriod', () => {
        const failing = { ...clean, consecutiveFailures: 3, lastAttemptAtMs: 1_400_000 };
        const backoffPolicy = { ...policy, failureBackoffMs: 600_000 };
        expect(decideCheckpoint({ state: failing, now: 1_500_000, policy: backoffPolicy, trigger: 'periodic', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: false, reason: 'backoff' });
        expect(decideCheckpoint({ state: failing, now: 2_100_000, policy: backoffPolicy, trigger: 'periodic', idle: { state: 'idle', forMs: 1 } }))
            .toEqual({ take: true, reason: 'periodic' });
    });

    it('shouldTakeAFirstCheckpointForARuntimeThatHasNeverHadOne', () => {
        expect(decideCheckpoint({
            state: { consecutiveFailures: 0 }, now: 1, policy, trigger: 'periodic', idle: { state: 'idle', forMs: 1 },
        })).toEqual({ take: true, reason: 'no-checkpoint-yet' });
    });
});

describe('recordCheckpointOutcome', () => {
    it('shouldAdvanceTheSavedPointOnlyOnSuccess', () => {
        const next = recordCheckpointOutcome({
            state: clean,
            outcome: { saved: true, checkpointId: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) },
            now: 2_000_000,
        });
        expect(next).toEqual({
            lastSuccessAtMs: 2_000_000,
            lastSuccessCheckpointId: 'b'.repeat(64),
            lastSuccessManifestDigest: 'c'.repeat(64),
            lastAttemptAtMs: 2_000_000,
            consecutiveFailures: 0,
            inFlight: false,
        });
    });

    it('shouldNotMoveTheSavedPointWhenTheCheckpointFailed', () => {
        // Disk full, a torn upload — the last good checkpoint is still the one
        // from before, and the age reported must reflect that.
        const next = recordCheckpointOutcome({
            state: clean,
            outcome: { saved: false, detail: 'disk full' },
            now: 2_000_000,
        });
        expect(next.lastSuccessAtMs).toBe(clean.lastSuccessAtMs);
        expect(next.lastSuccessCheckpointId).toBe(clean.lastSuccessCheckpointId);
        expect(next.consecutiveFailures).toBe(1);
        expect(next.lastFailureDetail).toBe('disk full');
        expect(next.inFlight).toBe(false);
    });

    it('shouldCountFailuresUntilOneSucceeds', () => {
        let state = clean;
        for (let index = 0; index < 3; index += 1) {
            state = recordCheckpointOutcome({ state, outcome: { saved: false }, now: 2_000_000 + index });
        }
        expect(state.consecutiveFailures).toBe(3);
        state = recordCheckpointOutcome({
            state,
            outcome: { saved: true, checkpointId: 'd'.repeat(64), manifestDigest: 'e'.repeat(64) },
            now: 3_000_000,
        });
        expect(state.consecutiveFailures).toBe(0);
    });

    it('shouldReportTheAgeOfWhatIsActuallySavedNotOfTheLastAttempt', () => {
        const failed = recordCheckpointOutcome({ state: clean, outcome: { saved: false }, now: 2_000_000 });
        // 1_000_000 is when the last *successful* one happened.
        expect(3_000_000 - failed.lastSuccessAtMs!).toBe(2_000_000);
    });
});
