/**
 * The two things the restore pipeline does not provide, implemented.
 *
 * An audit of `checkpointRestore.ts`, `checkpointStore.ts` and
 * `checkpointTurnApply.ts` found no `fsync` anywhere, and a restore
 * serialization that is an in-process `Map` keyed by project path. A boot
 * producer needs both to be real: the record it publishes is a claim that the
 * files are on the disk, and two daemons on one volume are two processes.
 *
 * Exercised against a real disk and a real second process, not fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, openSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    deviceIdFromMajorMinor,
    syncTreeToDisk,
    verifyOpenPathDevice,
    withManagedProducerLock,
} from '@/managed/managedRuntimeDurability';

let base: string;

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-durability-'));
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('flushing a restored tree', () => {
    it('flushes every file and every directory it walked', async () => {
        // A directory fsync makes the *entry* durable; it says nothing about
        // the bytes in the file. Both are needed before a record claims the
        // restore landed.
        const nested = join(base, 'a', 'b');
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(base, 'top.txt'), 'one');
        writeFileSync(join(nested, 'deep.txt'), 'two');

        // Observed at the descriptor, not in the returned list: a list can be
        // built without ever flushing anything.
        const { promises: fsPromises } = await import('node:fs');
        const realOpen = fsPromises.open;
        const flushed: string[] = [];
        (fsPromises as { open: typeof realOpen }).open = (async (...args: Parameters<typeof realOpen>) => {
            const handle = await realOpen(...args);
            const realSync = handle.sync.bind(handle);
            handle.sync = async () => {
                flushed.push(String(args[0]));
                return realSync();
            };
            return handle;
        }) as typeof realOpen;

        let synced: Awaited<ReturnType<typeof syncTreeToDisk>>;
        try {
            synced = await syncTreeToDisk(base);
        } finally {
            (fsPromises as { open: typeof realOpen }).open = realOpen;
        }

        expect(flushed).toContain(join(base, 'top.txt'));
        expect(flushed).toContain(join(nested, 'deep.txt'));
        expect(flushed).toContain(nested);
        expect(flushed).toContain(base);
        // Each file before the directory that names it.
        expect(flushed.indexOf(join(nested, 'deep.txt'))).toBeLessThan(flushed.indexOf(nested));
        expect(synced.files).toHaveLength(2);
    });

    it('does not follow a symlink out of the tree', async () => {
        // Following one would open — and so touch — a path outside the volume
        // this producer is preparing.
        const outside = join(tmpdir(), `managed-outside-${process.pid}`);
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, 'secret.txt'), 'x');
        try {
            const { symlinkSync } = await import('node:fs');
            symlinkSync(outside, join(base, 'link'));
            const synced = await syncTreeToDisk(base);
            expect(synced.files.some((path) => path.includes('secret.txt'))).toBe(false);
            expect(synced.directories).not.toContain(outside);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });
});

describe('excluding another producer on the same volume', () => {
    it('keeps a second process out while the first holds it', async () => {
        // A real second process: the in-process queue the restore executor
        // uses would not see it at all.
        const checkpointRoot = join(base, 'checkpoints');
        mkdirSync(join(checkpointRoot, 'store'), { recursive: true });
        execFileSync('git', ['init', '--bare', '--quiet', join(checkpointRoot, 'store')]);

        const marker = join(base, 'entered.txt');
        const script = join(base, 'contender.mjs');
        writeFileSync(script, `
            import { writeFileSync } from 'node:fs';
            const { withManagedProducerLock } = await import(${JSON.stringify(join(process.cwd(), 'src/managed/managedRuntimeDurability.ts'))});
            await withManagedProducerLock(${JSON.stringify(checkpointRoot)}, async () => {
                writeFileSync(${JSON.stringify(marker)}, 'second');
            });
        `);

        let contenderRan = false;
        await withManagedProducerLock(checkpointRoot, async () => {
            try {
                execFileSync(process.execPath, ['--import', 'tsx', script], { timeout: 4_000, stdio: 'pipe' });
                contenderRan = true;
            } catch {
                // Expected: it cannot take the lock while this one holds it.
            }
            expect(existsSync(marker)).toBe(false);
        });
        expect(contenderRan).toBe(false);
    }, 60_000);

    it('lets the next producer in once the first is done', async () => {
        const checkpointRoot = join(base, 'checkpoints');
        mkdirSync(join(checkpointRoot, 'store'), { recursive: true });
        execFileSync('git', ['init', '--bare', '--quiet', join(checkpointRoot, 'store')]);

        const order: string[] = [];
        await withManagedProducerLock(checkpointRoot, async () => { order.push('first'); });
        await withManagedProducerLock(checkpointRoot, async () => { order.push('second'); });
        expect(order).toEqual(['first', 'second']);
    }, 60_000);
});

describe('checking the device a path is really on', () => {
    it('reads the device from the opened directory, not from the path', async () => {
        // A lexical check compares strings. The device of the descriptor that
        // was actually opened is the thing a symlink cannot redirect.
        const fd = openSync(base, 'r');
        try {
            const actual = statSync(base).dev;
            expect(verifyOpenPathDevice(base, actual)).toEqual({ ok: true });
            expect(verifyOpenPathDevice(base, actual + 1)).toEqual({
                ok: false, reason: 'root-on-other-device',
            });
        } finally {
            closeSync(fd);
        }
    });

    it('refuses a path that is a symlink rather than following it', async () => {
        const { symlinkSync } = await import('node:fs');
        const real = join(base, 'real');
        mkdirSync(real);
        const link = join(base, 'link');
        symlinkSync(real, link);
        expect(verifyOpenPathDevice(link, statSync(real).dev))
            .toEqual({ ok: false, reason: 'root-not-mounted' });
    });

    it('encodes a mountinfo device the way Linux does', () => {
        // `mountinfo` reports `major:minor`; `stat` reports one number. They
        // have to be compared in one space, and the encoding is the kernel's.
        expect(deviceIdFromMajorMinor('259:1')).toBe((259 & 0xfff) * 256 + 1);
        expect(deviceIdFromMajorMinor('8:0')).toBe(8 * 256);
        expect(deviceIdFromMajorMinor('not-a-device')).toBeNull();
    });
});
