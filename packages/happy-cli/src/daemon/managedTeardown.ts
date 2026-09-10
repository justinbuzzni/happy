/**
 * The order a managed runtime shuts down in.
 *
 * This lives outside `run.ts` so the daemon and its tests call the same
 * function: the ordering *is* the contract, and a test that re-implemented it
 * would agree with itself rather than with the daemon.
 *
 * Two things were previously conflated and are separated here:
 *
 *   - **closing new entries** — no further RPC may enter the runtime.
 *   - **closing store writes** — the receipt store stops accepting mutations.
 *
 * Doing both at once fails the bookkeeping of work that had already started: a
 * spawn waiting on the launcher comes back to a store that refuses its write,
 * so a launch that actually succeeded is left recorded as `spawning` and turns
 * a clean shutdown into a reconciliation. Writes therefore stay open until
 * everything that entered has finished, and only then does the lock go.
 *
 * **The drain is unbounded by contract.** If the privileged backend never
 * answers a stop, a graceful shutdown waits. That is deliberate: the
 * alternatives are pretending the stop succeeded or releasing the writer lock
 * while another process may still be writing, and both hand the receipts to a
 * second daemon while the first one is still using them. An operator who needs
 * the process gone can signal it; this path will not invent a completion.
 */

export type ManagedTeardownDeps = {
    /** False on a BYOS daemon — nothing below runs. */
    active: boolean;
    /** Stops the lease watchdog so it cannot queue more work. */
    stopWatchdog: () => void;
    /** Refuses new managed RPC entries; already-entered work continues. */
    closeEntries: () => void;
    /** Resolves when every entered operation has settled. Unbounded. */
    drain: () => Promise<void>;
    /** Revokes store write permission. Only safe once the drain is done. */
    closeWrites: () => void;
    releaseLock: () => Promise<void>;
    /** True once a privileged launch backend is actually wired (T09). */
    backendWired: boolean;
    logDebug: (message: string) => void;
};

export async function teardownManagedRuntime(deps: ManagedTeardownDeps): Promise<void> {
    if (!deps.active) return;

    deps.stopWatchdog();
    // New work is refused from here on, so the drain below has a fixed set of
    // operations to wait for rather than a moving target.
    deps.closeEntries();

    // The drain establishes the premise for everything below: that nothing is
    // still running. If it fails, that premise is gone — so writes stay open,
    // the lock stays held, and the failure propagates. Continuing here would
    // hand the receipts to another daemon while this one may still be writing.
    //
    // Individual operation rejections do not reach this point: `drain` settles
    // them. Only a failure of the drain mechanism itself does.
    try {
        await deps.drain();
    } catch (error) {
        deps.logDebug('[managed] teardown aborted: drain failed, keeping writer lock');
        throw new ManagedTeardownError('drain-failed', error);
    }

    deps.closeWrites();

    if (!deps.backendWired) {
        deps.logDebug('[managed] shutting down with no launch backend; running children are not fenced');
    }

    try {
        await deps.releaseLock();
    } catch (error) {
        // Writes are already closed, so this process can no longer corrupt the
        // store — but a lock that did not come off must not read as a clean
        // shutdown to whatever is watching this daemon exit.
        deps.logDebug('[managed] teardown incomplete: writer lock release failed');
        throw new ManagedTeardownError('lock-release-failed', error);
    }
}

/**
 * Carries a stable reason code and keeps the original off the message: a
 * teardown failure can originate anywhere, including code paths whose errors
 * quote paths, tokens or request content.
 */
export class ManagedTeardownError extends Error {
    constructor(readonly code: 'drain-failed' | 'lock-release-failed', readonly cause?: unknown) {
        super(`managed teardown failed: ${code}`);
        this.name = 'ManagedTeardownError';
    }
}
