import { describe, expect, it } from 'vitest';

import { createCheckpointDrain, CheckpointDrainRefusal } from './managedCheckpointDrain';

describe('createCheckpointDrain', () => {
    it('shouldDrainImmediatelyWhenNothingIsInFlight', async () => {
        const drain = createCheckpointDrain();
        const held = await drain.drain(1000);
        expect(drain.isDraining()).toBe(true);
        held.release();
        expect(drain.isDraining()).toBe(false);
    });

    it('shouldWaitForInFlightWritesBeforeTheDrainResolves', async () => {
        const drain = createCheckpointDrain();
        const done = drain.beginWrite();
        let drained = false;
        const pending = drain.drain(1000).then((held) => { drained = true; return held; });
        await Promise.resolve();
        expect(drained).toBe(false);
        done();
        await pending;
        expect(drained).toBe(true);
    });

    it('shouldRefuseNewWritesWhileDrainingAndAdmitThemAfterRelease', async () => {
        const drain = createCheckpointDrain();
        const held = await drain.drain(1000);
        expect(() => drain.beginWrite()).toThrow(CheckpointDrainRefusal);
        held.release();
        expect(() => drain.beginWrite()).not.toThrow();
    });

    it('shouldOpenTheGateAgainWhenInFlightWorkOutlastsTheBudget', async () => {
        let fire: (() => void) | null = null;
        const drain = createCheckpointDrain({ setTimer: (run) => { fire = run; return { cancel: () => undefined }; } });
        drain.beginWrite();
        const pending = drain.drain(50);
        fire!();
        await expect(pending).rejects.toMatchObject({ code: 'drain-timeout' });
        // A checkpoint that could not start must not leave the agent unable to
        // write.
        expect(drain.isDraining()).toBe(false);
        expect(() => drain.beginWrite()).not.toThrow();
    });

    it('shouldRefuseASecondConcurrentDrain', async () => {
        const drain = createCheckpointDrain();
        await drain.drain(1000);
        await expect(drain.drain(1000)).rejects.toMatchObject({ code: 'drain-in-progress' });
    });

    it('shouldIgnoreADuplicateCompletionInsteadOfReleasingTheDrainEarly', async () => {
        const drain = createCheckpointDrain();
        const first = drain.beginWrite();
        drain.beginWrite();
        first();
        first();
        expect(drain.inFlight()).toBe(1);
    });

    it('shouldCountEveryAdmittedWriteWithoutEverGoingBack', async () => {
        const drain = createCheckpointDrain();
        expect(drain.writes()).toBe(0);
        const first = drain.beginWrite();
        const second = drain.beginWrite();
        expect(drain.writes()).toBe(2);
        first();
        second();
        // Completing a write does not un-write it: this is what a checkpoint
        // compares against to know whether anything happened since.
        expect(drain.writes()).toBe(2);
    });

    it('shouldCaptureTheWriteCountAtTheMomentItBecameQuiet', async () => {
        const drain = createCheckpointDrain();
        const done = drain.beginWrite();
        const pending = drain.drain(1000);
        drain.beginWrite;
        done();
        const held = await pending;
        // Captured inside the drained window — the archive was taken at this
        // count, not at whatever it becomes after the gate opens.
        expect(drain.lastQuiescedWrites()).toBe(1);
        held.release();
        drain.beginWrite();
        expect(drain.writes()).toBe(2);
        expect(drain.lastQuiescedWrites()).toBe(1);
    });
});
