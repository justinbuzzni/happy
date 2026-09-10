import { describe, expect, it } from 'vitest';

import {
    evaluateRuntimeIdle,
    mayStopRuntime,
    type RuntimeActivitySignal,
    type RuntimeIdlePolicy,
} from './managedRuntimeActivity';

const policy: RuntimeIdlePolicy = { idleGraceMs: 900_000, previewOnlyIdleGraceMs: 3_600_000 };

function evaluate(signals: RuntimeActivitySignal[], sinceMs = 1_000_000, now = 2_000_000, override?: RuntimeIdlePolicy | null) {
    return evaluateRuntimeIdle({
        signals,
        lastActivityAtMs: sinceMs,
        now,
        policy: override === undefined ? policy : override,
    });
}

describe('evaluateRuntimeIdle', () => {
    it('shouldNotTreatASocketHeartbeatAsUse', () => {
        // A connected client proves a socket, not a person.
        expect(evaluate([{ kind: 'socket-heartbeat' }])).toMatchObject({ state: 'idle' });
    });

    it('shouldTreatARunningTurnOrAnOpenToolAsUse', () => {
        expect(evaluate([{ kind: 'turn-running' }])).toMatchObject({ state: 'active' });
        expect(evaluate([{ kind: 'open-tool' }])).toMatchObject({ state: 'active' });
        expect(evaluate([{ kind: 'active-terminal' }])).toMatchObject({ state: 'active' });
        expect(evaluate([{ kind: 'background-job' }])).toMatchObject({ state: 'active' });
    });

    it('shouldNotCallAWatcherOrDevServerUseOnItsOwn', () => {
        // `npm run dev` sitting there is not a reason to bill forever.
        expect(evaluate([{ kind: 'dev-process' }])).toMatchObject({ state: 'idle' });
        expect(evaluate([{ kind: 'dev-process' }, { kind: 'socket-heartbeat' }])).toMatchObject({ state: 'idle' });
        // A real job running under it is.
        expect(evaluate([{ kind: 'dev-process' }, { kind: 'background-job' }])).toMatchObject({ state: 'active' });
    });

    it('shouldRefuseToDecideWhileAWriterCouldNotBeProvenStopped', () => {
        // Something may still be writing to the volume. Neither "idle" nor a
        // checkpoint means anything until that is settled.
        expect(evaluate([{ kind: 'unproven-writer' }]))
            .toEqual({ state: 'undecidable', reason: 'unproven-writer' });
        expect(evaluate([{ kind: 'unproven-writer' }, { kind: 'socket-heartbeat' }]))
            .toEqual({ state: 'undecidable', reason: 'unproven-writer' });
    });

    it('shouldOnlySleepThroughAnApprovalThatCanBeResumed', () => {
        expect(evaluate([{ kind: 'approval-pending', resumable: true }])).toMatchObject({ state: 'idle' });
        expect(evaluate([{ kind: 'approval-pending', resumable: false }]))
            .toEqual({ state: 'undecidable', reason: 'approval-not-resumable' });
    });

    it('shouldGivePreviewOnlyUseItsOwnGrace', () => {
        const previewOnly: RuntimeActivitySignal[] = [{ kind: 'preview-request' }];
        // Past the ordinary grace, inside the preview one.
        expect(evaluate(previewOnly, 1_000_000, 2_000_000)).toMatchObject({ state: 'active' });
        // Past both.
        expect(evaluate(previewOnly, 1_000_000, 5_000_000)).toMatchObject({ state: 'idle' });
        // A preview request alongside real work uses the ordinary rule.
        expect(evaluate([...previewOnly, { kind: 'turn-running' }], 1_000_000, 5_000_000))
            .toMatchObject({ state: 'active' });
    });

    it('shouldStayActiveUntilTheConfiguredGraceHasPassed', () => {
        expect(evaluate([], 1_000_000, 1_000_001)).toMatchObject({ state: 'active' });
        expect(evaluate([], 1_000_000, 1_900_001)).toMatchObject({ state: 'idle', forMs: 900_001 });
    });

    it('shouldRefuseToDecideWithoutAConfiguredPolicy', () => {
        // The numbers in the plan are proposals. A runtime with no policy
        // configured must never conclude that it may be stopped.
        expect(evaluate([], 1_000_000, 9_000_000, null))
            .toEqual({ state: 'undecidable', reason: 'no-policy' });
    });

    it('shouldReportWhichSignalsKeptItActive', () => {
        const decision = evaluate([{ kind: 'open-tool' }, { kind: 'socket-heartbeat' }, { kind: 'background-job' }]);
        expect(decision).toMatchObject({ state: 'active' });
        expect((decision as { because: string[] }).because.sort()).toEqual(['background-job', 'open-tool']);
    });
});

describe('mayStopRuntime', () => {
    it('shouldRefuseToStopWithoutAVerifiedCheckpoint', () => {
        expect(mayStopRuntime({
            idle: { state: 'idle', forMs: 1_000 },
            checkpoint: { saved: false, detail: 'disk full' },
        })).toEqual({ stop: false, reason: 'no-verified-checkpoint', detail: 'disk full' });
    });

    it('shouldRefuseToStopWhileTheRuntimeIsNotIdle', () => {
        expect(mayStopRuntime({
            idle: { state: 'active', because: ['open-tool'] },
            checkpoint: { saved: true, checkpointId: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
        })).toEqual({ stop: false, reason: 'not-idle' });
    });

    it('shouldRefuseToStopWhenIdlenessCouldNotBeDecided', () => {
        expect(mayStopRuntime({
            idle: { state: 'undecidable', reason: 'unproven-writer' },
            checkpoint: { saved: true, checkpointId: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
        })).toEqual({ stop: false, reason: 'undecidable', detail: 'unproven-writer' });
    });

    it('shouldAllowAStopOnlyWhenBothHold', () => {
        expect(mayStopRuntime({
            idle: { state: 'idle', forMs: 1_000 },
            checkpoint: { saved: true, checkpointId: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
        })).toEqual({ stop: true, checkpointId: 'a'.repeat(64) });
    });
});
