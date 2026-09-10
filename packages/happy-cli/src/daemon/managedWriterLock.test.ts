import { describe, expect, it } from 'vitest';

import {
    acquireManagedWriterLock,
    isAbstractSocketSupported,
    managedWriterLockAddress,
} from './managedWriterLock';

/**
 * The kernel behaviour this module depends on — EADDRINUSE while a holder
 * lives, immediate release on SIGKILL, no filesystem residue — is Linux-only
 * and is verified against this exact file in a disposable Linux container
 * (see the T07 checkpoint in specs/managed-cloud-byos/context.md). What is
 * asserted here is everything that does not need that kernel.
 */
describe('managedWriterLockAddress', () => {
    it('uses the abstract namespace so nothing is left on disk', () => {
        const address = managedWriterLockAddress('runtime-1');
        expect(address.startsWith('\0')).toBe(true);
        // No path component: there is no file to go stale, and therefore no
        // stale-detection heuristic to get wrong.
        expect(address).not.toContain('/');
    });

    it('separates runtimes so two of them cannot share one lock', () => {
        expect(managedWriterLockAddress('runtime-1'))
            .not.toBe(managedWriterLockAddress('runtime-2'));
    });
});

describe('isAbstractSocketSupported', () => {
    it('is true only on Linux', () => {
        expect(isAbstractSocketSupported('linux')).toBe(true);
        for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
            expect(isAbstractSocketSupported(platform)).toBe(false);
        }
    });
});

describe('acquireManagedWriterLock', () => {
    it('refuses on a platform without abstract sockets rather than pretending', () => {
        // A managed runtime is Linux. On anything else the honest answer is
        // that this ownership primitive is unavailable — never an optimistic
        // "acquired" that two processes could both receive.
        return expect(acquireManagedWriterLock({ runtimeId: 'runtime-1', platform: 'darwin' }))
            .resolves.toEqual({ ok: false, reason: 'unsupported-platform' });
    });

    it.runIf(process.platform === 'linux')('holds the name against a second acquire', async () => {
        const first = await acquireManagedWriterLock({ runtimeId: `t-${process.pid}` });
        expect(first.ok).toBe(true);
        try {
            const second = await acquireManagedWriterLock({ runtimeId: `t-${process.pid}` });
            expect(second).toEqual({ ok: false, reason: 'held' });
        } finally {
            if (first.ok) await first.release();
        }
    });

    it.runIf(process.platform === 'linux')('frees the name once released', async () => {
        const first = await acquireManagedWriterLock({ runtimeId: `r-${process.pid}` });
        expect(first.ok).toBe(true);
        if (first.ok) await first.release();
        const again = await acquireManagedWriterLock({ runtimeId: `r-${process.pid}` });
        expect(again.ok).toBe(true);
        if (again.ok) await again.release();
    });
});
