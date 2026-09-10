import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManagedReceiptStore, managedOperationKey } from './managedReceiptStore';
import { teardownManagedRuntime, type ManagedTeardownDeps } from './managedTeardown';

/**
 * Drives the same function `run.ts` calls, against the real receipt store and
 * its real `assertHeld` guard. A teardown that closed writes too early shows up
 * here as a failed bookkeeping write, exactly as it would in the daemon.
 */
describe('teardownManagedRuntime', () => {
    function harness() {
        const root = mkdtempSync(join(tmpdir(), 'managed-teardown-'));
        let writesAllowed = true;
        const store = createManagedReceiptStore(root, {
            assertHeld: (action) => {
                if (!writesAllowed) throw new Error(`managed writer lock not held; refusing ${action}`);
            },
        });
        const events: string[] = [];
        return {
            root,
            store,
            events,
            closeWrites: () => { writesAllowed = false; },
            cleanup: () => rmSync(root, { recursive: true, force: true }),
        };
    }

    function deps(over: Partial<ManagedTeardownDeps> & Pick<ManagedTeardownDeps, 'closeEntries' | 'drain' | 'closeWrites' | 'releaseLock'>): ManagedTeardownDeps {
        return {
            active: true,
            stopWatchdog: () => {},
            backendWired: true,
            logDebug: () => {},
            ...over,
        };
    }

    it('keeps store writes working until every entered operation has finished', async () => {
        const h = harness();
        try {
            const key = managedOperationKey({ runId: 'run-1', attemptId: 'a-1' });
            h.store.claim({ requestKey: key, runId: 'run-1', attemptId: 'a-1', epoch: 0, now: 1 });

            let bookkeepingError: Error | null = null;
            // Stands in for a spawn whose launcher replied during teardown: it
            // must still be able to record the result it just obtained.
            const inFlight = (async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                try {
                    h.store.update(key, { state: 'running', pid: 4242, pgid: 4242 }, 2);
                } catch (error) {
                    bookkeepingError = error as Error;
                }
            })();

            await teardownManagedRuntime(deps({
                closeEntries: () => h.events.push('entries-closed'),
                drain: async () => { h.events.push('drain-start'); await inFlight; h.events.push('drain-end'); },
                closeWrites: () => { h.events.push('writes-closed'); h.closeWrites(); },
                releaseLock: async () => { h.events.push('lock-released'); },
            }));

            expect(bookkeepingError).toBeNull();
            const stored = h.store.read(key);
            expect(stored.kind).toBe('ok');
            if (stored.kind === 'ok') expect(stored.receipt.state).toBe('running');
        } finally {
            h.cleanup();
        }
    });

    it('closes new entries before draining, and the lock last', async () => {
        const h = harness();
        try {
            await teardownManagedRuntime(deps({
                closeEntries: () => h.events.push('entries-closed'),
                drain: async () => { h.events.push('drain'); },
                closeWrites: () => h.events.push('writes-closed'),
                releaseLock: async () => { h.events.push('lock-released'); },
            }));
            expect(h.events).toEqual(['entries-closed', 'drain', 'writes-closed', 'lock-released']);
        } finally {
            h.cleanup();
        }
    });

    it('stops the watchdog before anything else', async () => {
        const h = harness();
        try {
            await teardownManagedRuntime(deps({
                stopWatchdog: () => h.events.push('watchdog-stopped'),
                closeEntries: () => h.events.push('entries-closed'),
                drain: async () => { h.events.push('drain'); },
                closeWrites: () => h.events.push('writes-closed'),
                releaseLock: async () => { h.events.push('lock-released'); },
            }));
            expect(h.events[0]).toBe('watchdog-stopped');
        } finally {
            h.cleanup();
        }
    });

    it('does nothing on a BYOS daemon', async () => {
        const h = harness();
        try {
            await teardownManagedRuntime(deps({
                active: false,
                stopWatchdog: () => h.events.push('watchdog-stopped'),
                closeEntries: () => h.events.push('entries-closed'),
                drain: async () => { h.events.push('drain'); },
                closeWrites: () => h.events.push('writes-closed'),
                releaseLock: async () => { h.events.push('lock-released'); },
            }));
            expect(h.events).toEqual([]);
        } finally {
            h.cleanup();
        }
    });

    it('keeps the lock and store ownership when the drain itself fails', async () => {
        const h = harness();
        try {
            // The drain failing is not evidence that nothing is still running.
            // Releasing on that premise hands the receipts to another daemon
            // while this process may still be writing them.
            await expect(teardownManagedRuntime(deps({
                closeEntries: () => h.events.push('entries-closed'),
                drain: async () => { throw new Error('drain broke'); },
                closeWrites: () => h.events.push('writes-closed'),
                releaseLock: async () => { h.events.push('lock-released'); },
            }))).rejects.toThrow();
            expect(h.events).toEqual(['entries-closed']);
        } finally {
            h.cleanup();
        }
    });

    it('surfaces a failed lock release instead of reporting a clean shutdown', async () => {
        const h = harness();
        try {
            await expect(teardownManagedRuntime(deps({
                closeEntries: () => {},
                drain: async () => {},
                closeWrites: () => h.events.push('writes-closed'),
                releaseLock: async () => { throw new Error('release broke'); },
            }))).rejects.toThrow();
            // Writes are closed first, so a failed release still leaves this
            // process unable to write — but it must not look like success.
            expect(h.events).toEqual(['writes-closed']);
        } finally {
            h.cleanup();
        }
    });

    it('logs only generic identifiers, never the underlying message', async () => {
        const logs: string[] = [];
        const h = harness();
        try {
            await expect(teardownManagedRuntime(deps({
                logDebug: (message) => logs.push(message),
                closeEntries: () => {},
                drain: async () => { throw new Error('token=abc123 at /home/u/.happy/access.key'); },
                closeWrites: () => {},
                releaseLock: async () => {},
            }))).rejects.toThrow();
            const joined = logs.join(' ');
            expect(joined).not.toContain('abc123');
            expect(joined).not.toContain('access.key');
        } finally {
            h.cleanup();
        }
    });

    it('records that running children were not fenced when no backend is wired', async () => {
        const h = harness();
        const logs: string[] = [];
        try {
            await teardownManagedRuntime(deps({
                backendWired: false,
                logDebug: (message) => logs.push(message),
                closeEntries: () => {},
                drain: async () => {},
                closeWrites: () => {},
                releaseLock: async () => {},
            }));
            expect(logs.join(' ')).toMatch(/not fenced/);
        } finally {
            h.cleanup();
        }
    });
});
