/**
 * Local observation of whether a managed child's process group is still there.
 *
 * This module reports evidence and never a verdict. A child can call `setsid`
 * and leave the group, so an empty group says only "nothing of it is visible
 * from here" — not that nothing survived. Proving that requires cgroup
 * emptiness or a provider stop, and T09 owns both. `onChildExited` and a dead
 * leader pid are equally weak: the leader can exit while its children keep
 * writing to the workspace.
 *
 * Signal failures are classified, never swallowed. `EPERM` in particular means
 * the target is alive but owned by another uid — which is the normal case once
 * agents run under their own uid — and reading it as "gone" would let a new
 * writable generation open on top of a live writer.
 *
 * Nothing here terminates anything. A persisted pid is a number the kernel may
 * have reused, so it can support an observation but never authority to kill;
 * stopping a managed child belongs to the privileged launch backend.
 */

export type ProcessGroupEvidence =
    /** Nothing from this group is visible here. Not proof that nothing runs. */
    | { kind: 'no-local-trace' }
    | { kind: 'alive' }
    /** Alive, but this daemon may not signal it (different uid). */
    | { kind: 'alive-foreign' }
    /** The signal failed for a reason we cannot interpret. Never "gone". */
    | { kind: 'indeterminate'; detail: string };

export type SignalOutcome =
    | { kind: 'delivered' }
    | { kind: 'no-local-trace' }
    | { kind: 'not-permitted' }
    | { kind: 'indeterminate'; detail: string };

export type ProcessGroupDeps = {
    /** Negative pid targets the whole group; that is the point of this module. */
    kill: (target: number, signal: NodeJS.Signals | 0) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
};

export const defaultProcessGroupDeps: ProcessGroupDeps = {
    kill: (target, signal) => process.kill(target, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
};

function classify(error: unknown): SignalOutcome {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { kind: 'no-local-trace' };
    if (code === 'EPERM') return { kind: 'not-permitted' };
    return { kind: 'indeterminate', detail: code ?? 'signal failed' };
}

export function signalProcessGroup(
    pgid: number,
    signal: NodeJS.Signals | 0,
    deps: ProcessGroupDeps = defaultProcessGroupDeps,
): SignalOutcome {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) {
        // pgid 1 would signal init, and a non-integer means a corrupt receipt.
        return { kind: 'indeterminate', detail: 'invalid pgid' };
    }
    try {
        deps.kill(-pgid, signal);
        return { kind: 'delivered' };
    } catch (error) {
        return classify(error);
    }
}

export function probeProcessGroup(
    pgid: number,
    deps: ProcessGroupDeps = defaultProcessGroupDeps,
): ProcessGroupEvidence {
    const outcome = signalProcessGroup(pgid, 0, deps);
    switch (outcome.kind) {
        case 'delivered':
            return { kind: 'alive' };
        case 'no-local-trace':
            return { kind: 'no-local-trace' };
        case 'not-permitted':
            return { kind: 'alive-foreign' };
        case 'indeterminate':
            return { kind: 'indeterminate', detail: outcome.detail };
    }
}
