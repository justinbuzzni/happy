/**
 * Drives the checkpoint runner from what the runtime is actually doing.
 *
 * The schedule decides whether it is time and the activity decides whether the
 * volume can be reasoned about; this is the part that puts those answers
 * together, calls the runner, and remembers what actually happened. Without
 * it the two would be advice nobody takes.
 *
 * Three things it is responsible for that neither half can be:
 *
 * **One attempt at a time.** The runner's drain refuses a second concurrent
 * checkpoint, but by then a tick has already asked for one and the refusal
 * looks like a failure. The in-flight flag is set before the call and cleared
 * by recording the outcome, so a tick during a checkpoint is a decision, not
 * an error.
 *
 * **A failure is a failure, and it invalidates the older success.** Anything
 * the runner throws — a full disk, a torn upload, a pointer another runtime
 * moved — leaves the saved point where it was, and `checkpointState()` stops
 * answering `saved: true`. The older checkpoint is still the newest *verified*
 * one, but a checkpoint became due and could not be taken, so the volume has
 * moved on from it: stopping on its strength discards whatever happened since.
 * Reporting the age of a checkpoint and authorising a stop are different
 * questions, and only the second one is answered here.
 *
 * **Writes since the last checkpoint invalidate it too.** The count comes from
 * the runner's own gate and nowhere else. There is no option to supply a
 * different one: the value a checkpoint is compared against is captured inside
 * that gate's drained window, so a second counter would be a different axis
 * measured against it — one that reads "always dirty" until the two numbers
 * happen to coincide, and then reads "clean" while writes are being missed.
 * When an external writer needs to be counted, it will need a contract that
 * feeds this gate rather than a number beside it.
 *
 * **A checkpoint in progress is not a saved volume.** One became due, it has
 * not landed, and it has not failed either — so neither the failure count nor
 * the write generation says anything yet.
 *
 * **A state this process did not verify proves nothing.** Resuming from a
 * persisted state says a checkpoint once succeeded; it says nothing about what
 * happened to the volume while this process was not running. It authorises a
 * stop only after this coordinator has taken one itself.
 *
 * **The targets come per attempt, and "none" is not "broken".** Signed URLs
 * expire and the key is live for one checkpoint, so they are fetched when a
 * checkpoint is actually going to happen rather than held. `null` means the
 * parent has issued none — an ordinary skip. A *throw* means the fetch failed,
 * which is a different fact: an expired signature or an unreachable control
 * plane would otherwise look exactly like an idle project, quietly, for as
 * long as it stayed broken.
 */
import type { RuntimeCheckpointState, RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import type { ManagedCheckpointRequest, ManagedCheckpointRunner } from './managedCheckpointRunner';
import {
    decideCheckpoint,
    recordCheckpointOutcome,
    type CheckpointDecision,
    type CheckpointSchedulePolicy,
    type CheckpointScheduleState,
    type CheckpointTrigger,
} from './managedCheckpointSchedule';

/** Where a checkpoint's per-attempt credentials come from. */
export type ManagedCheckpointTargetSource = {
    /** `null` when the parent has not issued targets for this runtime. */
    next: () => Promise<ManagedCheckpointRequest | null>;
};

export type CheckpointTickResult =
    | { attempted: false; decision: CheckpointDecision }
    | { attempted: false; decision: { take: false; reason: 'no-targets' } }
    | { attempted: false; decision: { take: false; reason: 'targets-unavailable'; detail: string } }
    | { attempted: true; saved: true; checkpointId: string }
    | { attempted: true; saved: false; detail: string };

export type ManagedCheckpointCoordinator = {
    tick(input: { trigger: CheckpointTrigger; idle: RuntimeIdleDecision; now: number }): Promise<CheckpointTickResult>;
    /** What `mayStopRuntime` needs: the last **verified** checkpoint, or none. */
    checkpointState(): RuntimeCheckpointState;
    scheduleState(): CheckpointScheduleState;
};

export function createManagedCheckpointCoordinator(config: {
    runner: ManagedCheckpointRunner;
    targets: ManagedCheckpointTargetSource;
    /** Configured, never defaulted; `null` takes no checkpoints. */
    policy: CheckpointSchedulePolicy | null;
    initialState?: CheckpointScheduleState;
}): ManagedCheckpointCoordinator {
    let state: CheckpointScheduleState = config.initialState ?? { consecutiveFailures: 0 };
    /** The write generation the last successful checkpoint was taken at. */
    let savedAtWriteGeneration: number | null = null;
    /**
     * The gate that admitted the writes, and the same one whose drained window
     * the saved value was captured in. Anything written by another route is
     * invisible here, which is why a failed or pending attempt invalidates the
     * saved state on its own.
     */
    const writeGeneration = (): number => config.runner.checkpointDrain.drain.writes();

    return {
        async tick(input) {
            const decision = decideCheckpoint({
                state,
                now: input.now,
                policy: config.policy,
                trigger: input.trigger,
                idle: input.idle,
            });
            if (!decision.take) return { attempted: false, decision };

            // Claimed before the first `await`. Fetching the targets yields,
            // and a tick landing in that window would find the flag unset and
            // start a second checkpoint — which the runner's drain then refuses
            // as an error rather than answering as a decision.
            state = { ...state, inFlight: true };

            let request: ManagedCheckpointRequest | null;
            try {
                request = await config.targets.next();
            } catch (error) {
                // Not a skip: no checkpoint happened and the reason is a
                // failure. Counted so the backoff engages instead of asking
                // again every tick, and the saved point stays where it was.
                const detail = (error as { code?: unknown })?.code === undefined
                    ? 'targets-failed'
                    : String((error as { code: unknown }).code);
                state = recordCheckpointOutcome({ state, outcome: { saved: false, detail }, now: input.now });
                return { attempted: false, decision: { take: false, reason: 'targets-unavailable', detail } };
            }
            if (!request) {
                // Nothing to upload to. Not a failure of the volume, and it
                // must not be recorded as one — but no checkpoint happened.
                state = { ...state, inFlight: false };
                return { attempted: false, decision: { take: false, reason: 'no-targets' } };
            }

            try {
                const published = await config.runner.takeCheckpoint(request);
                state = recordCheckpointOutcome({
                    state,
                    outcome: {
                        saved: true,
                        checkpointId: published.pointer.checkpointId,
                        manifestDigest: published.manifestDigest,
                    },
                    now: input.now,
                });
                // Captured inside the drained window by the gate itself, so it
                // is the count the archive was actually taken at.
                savedAtWriteGeneration = config.runner.checkpointDrain.drain.lastQuiescedWrites();
                return { attempted: true, saved: true, checkpointId: published.pointer.checkpointId };
            } catch (error) {
                // Only the code is kept: a store's error text is not this
                // runtime's to carry around.
                const detail = (error as { code?: unknown })?.code === undefined
                    ? 'checkpoint-failed'
                    : String((error as { code: unknown }).code);
                state = recordCheckpointOutcome({ state, outcome: { saved: false, detail }, now: input.now });
                return { attempted: true, saved: false, detail };
            }
        },
        checkpointState() {
            if (state.lastSuccessAtMs === undefined
                || state.lastSuccessCheckpointId === undefined
                || state.lastSuccessManifestDigest === undefined) {
                return {
                    saved: false,
                    ...(state.lastFailureDetail === undefined ? {} : { detail: state.lastFailureDetail }),
                };
            }
            if (state.inFlight === true) {
                // Due, running, and not yet landed.
                return { saved: false, detail: 'checkpoint-in-flight' };
            }
            if (savedAtWriteGeneration === null) {
                // The success came from a state handed to this coordinator, not
                // from a checkpoint it took. Nothing here saw the volume since.
                return { saved: false, detail: 'unverified-in-this-process' };
            }
            if (state.consecutiveFailures > 0) {
                // A checkpoint was due, was attempted, and did not happen. The
                // older one is still the newest verified checkpoint, but it is
                // no longer evidence that this volume is saved.
                return { saved: false, detail: state.lastFailureDetail ?? 'checkpoint-failed' };
            }
            if (writeGeneration() !== savedAtWriteGeneration) {
                return { saved: false, detail: 'writes-since-checkpoint' };
            }
            return {
                saved: true,
                checkpointId: state.lastSuccessCheckpointId,
                manifestDigest: state.lastSuccessManifestDigest,
            };
        },
        scheduleState: () => state,
    };
}
