import { describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coordinateManagedRestore } from './managedRestoreCoordinator';
import {
    findManagedPromotionJournals,
    managedPromotionJournalPath,
    readManagedPromotionJournal,
    reconcileManagedPromotion,
} from './managedCheckpointPromotion';

const tenant = { companyId: 'co_1', projectId: 'pr_1' };
const targetVolume = { volumeId: 'vol_new', deviceUuid: 'dev-new' };
const key = { runId: 'r', attemptId: 'a', epoch: 3 };

function deps(overrides: Record<string, unknown> = {}) {
    return {
        key,
        tenant,
        targetVolume,
        stagingRoot: '/workspace/.saycode-restore',
        destinations: new Map([['project' as const, '/workspace/project']]),
        findJournals: async () => [] as string[],
        reconcile: async () => 'none' as const,
        proveAllBelow: () => ({ proven: true, detail: 'all stopped' }),
        resolveLatest: async () => null,
        restore: async () => ({
            promoted: true as const,
            checkpointId: 'a'.repeat(64),
            manifestDigest: 'b'.repeat(64),
            sourceVolume: { volumeId: 'vol_old', deviceUuid: 'dev-old' },
            targetVolume,
        }),
        ...overrides,
    };
}

describe('coordinateManagedRestore', () => {
    it('shouldNotCallAVolumeEmptyOnTheAbsenceOfACheckpointAlone', async () => {
        // plan §5.47: `currentCheckpointId === null` is not evidence of an
        // empty workspace. This reports what it knows — the pointer names
        // nothing — and leaves initialising to the caller that holds
        // `createdByThisOperation`.
        expect(await coordinateManagedRestore(deps() as never))
            .toEqual({ outcome: 'no-checkpoint' });
    });

    it('shouldNeverAnswerEmptyInitializedItself', async () => {
        // The word belongs to `recordManagedRestoreCompletion`, which refuses
        // without the protected bootstrap's authority. Producing it here would
        // route around that refusal.
        const answers = await Promise.all([
            coordinateManagedRestore(deps() as never),
            coordinateManagedRestore(deps({ resolveLatest: async () => null }) as never),
        ]);
        expect(JSON.stringify(answers)).not.toContain('empty-initialized');
    });

    it('shouldRestoreAndReportWhatTheRestoreItselfProved', async () => {
        const resolved = {
            manifest: {} as never,
            objects: new Map([['project' as const, '/workspace/.saycode-restore/project.enc']]),
            key: Buffer.alloc(32),
        };
        const result = await coordinateManagedRestore(deps({ resolveLatest: async () => resolved }) as never);
        expect(result).toEqual({
            outcome: 'restored',
            checkpointId: 'a'.repeat(64),
            manifestDigest: 'b'.repeat(64),
            sourceVolume: { volumeId: 'vol_old', deviceUuid: 'dev-old' },
        });
    });

    it('shouldFenceBeforeItChangesAnythingOnTheVolume', async () => {
        const order: string[] = [];
        await coordinateManagedRestore(deps({
            findJournals: async () => { order.push('find'); return ['/workspace/.saycode-restore/j.json']; },
            reconcile: async () => { order.push('reconcile'); return 'rolled-back' as const; },
            proveAllBelow: () => { order.push('fence'); return { proven: true, detail: 'ok' }; },
            resolveLatest: async () => { order.push('resolve'); return null; },
        }) as never);
        // Reconciling renames and removes the destinations — it writes. Doing
        // that while an older generation might still be running is the
        // corruption the fence exists to prevent, so looking is allowed first
        // but changing is not.
        expect(order).toEqual(['find', 'fence', 'reconcile', 'resolve']);
    });

    it('shouldNotReconcileAtAllWhenTheFenceIsNotProven', async () => {
        const order: string[] = [];
        const result = await coordinateManagedRestore(deps({
            findJournals: async () => { order.push('find'); return ['/workspace/.saycode-restore/j.json']; },
            reconcile: async () => { order.push('reconcile'); return 'rolled-back' as const; },
            proveAllBelow: () => ({ proven: false, detail: 'epoch 2 termination-unknown' }),
        }) as never);
        expect(result).toMatchObject({ outcome: 'refused', reason: 'generations-not-fenced' });
        expect(order).toEqual(['find']);
    });

    it('shouldRefuseWhenAnInterruptedPromotionCannotBeResolved', async () => {
        const resolveLatest = vi.fn(async () => null);
        expect(await coordinateManagedRestore(deps({
            findJournals: async () => ['/workspace/.saycode-restore/j.json'],
            reconcile: async () => 'unreconciled' as const,
            resolveLatest,
        }) as never)).toEqual({ outcome: 'refused', reason: 'promotion-unreconciled' });
        // Nothing downstream ran: the volume is between states.
        expect(resolveLatest).not.toHaveBeenCalled();
    });

    it('shouldRefuseToRestoreWhileAnOlderGenerationCouldStillBeWriting', async () => {
        const restore = vi.fn();
        const result = await coordinateManagedRestore(deps({
            proveAllBelow: () => ({ proven: false, detail: 'epoch 2 termination-unknown' }),
            resolveLatest: async () => ({ manifest: {}, objects: new Map(), key: Buffer.alloc(32) }),
            restore,
        }) as never);

        // A returning old runtime writing into the tree being laid down is
        // exactly the corruption the fence exists to prevent.
        expect(result).toEqual({
            outcome: 'refused',
            reason: 'generations-not-fenced',
            detail: 'epoch 2 termination-unknown',
        });
        expect(restore).not.toHaveBeenCalled();
    });

    it('shouldFenceAgainstEveryEpochBelowThisOne', async () => {
        const seen: number[] = [];
        await coordinateManagedRestore(deps({
            proveAllBelow: (below: number) => { seen.push(below); return { proven: true, detail: 'ok' }; },
        }) as never);
        expect(seen).toEqual([3]);
    });

    it('shouldReportARestoreRefusalWithoutInventingASuccess', async () => {
        const result = await coordinateManagedRestore(deps({
            resolveLatest: async () => ({ manifest: {}, objects: new Map(), key: Buffer.alloc(32) }),
            restore: async () => { throw Object.assign(new Error('x'), { code: 'archive-checksum-mismatch' }); },
        }) as never);
        expect(result).toEqual({
            outcome: 'refused',
            reason: 'restore-failed',
            detail: 'archive-checksum-mismatch',
        });
    });

    it('shouldNotTurnAResolveFailureIntoAnEmptyVolume', async () => {
        // `null` is "no checkpoint"; a throw is "could not find out". Reading
        // the second as the first initialises a volume that has real work on it.
        const result = await coordinateManagedRestore(deps({
            resolveLatest: async () => { throw Object.assign(new Error('x'), { code: 'pointer-unreadable' }); },
        }) as never);
        expect(result).toEqual({
            outcome: 'refused',
            reason: 'latest-unavailable',
            detail: 'pointer-unreadable',
        });
    });

    it('shouldNotCarryStoreOrProviderTextIntoTheReason', async () => {
        const result = await coordinateManagedRestore(deps({
            resolveLatest: async () => { throw new Error('AccessDenied: signature expired for key abc'); },
        }) as never);
        expect(JSON.stringify(result)).not.toContain('AccessDenied');
        expect(result).toMatchObject({ outcome: 'refused', reason: 'latest-unavailable' });
    });

});

describe('coordinateManagedRestore with the real reconcile', () => {
    it('shouldLeaveAnInterruptedPromotionUntouchedWhileTheFenceIsUnproven', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mc-restore-coord-'));
        try {
            const destination = join(home, 'project');
            const displaced = join(home, 'project.displaced');
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, 'marker.txt'), 'new-tree\n');
            await mkdir(displaced, { recursive: true });
            await writeFile(join(displaced, 'marker.txt'), 'the-original\n');
            const journalPath = managedPromotionJournalPath(home, 'cp1');
            await writeFile(journalPath, JSON.stringify({
                schemaVersion: 1, checkpointId: 'cp1', promoted: 1, completed: false,
                entries: [{
                    area: 'project',
                    staged: join(home, 'staging/project'),
                    destination,
                    displaced,
                    hadDestination: true,
                }],
            }));

            // The real reconcile, which renames the displaced tree back over
            // the destination. It must not run at all here.
            const result = await coordinateManagedRestore({
                ...deps({
                    findJournals: findManagedPromotionJournals,
                    reconcile: reconcileManagedPromotion,
                    proveAllBelow: () => ({ proven: false, detail: 'epoch 2 termination-unknown' }),
                }),
                stagingRoot: home,
                destinations: new Map([['project' as const, destination]]),
            } as never);

            expect(result).toMatchObject({ outcome: 'refused', reason: 'generations-not-fenced' });
            // Nothing moved: an old writer could still have this volume.
            expect(await readFile(join(destination, 'marker.txt'), 'utf8')).toBe('new-tree\n');
            expect(await readFile(join(displaced, 'marker.txt'), 'utf8')).toBe('the-original\n');
            expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('shouldRollTheInterruptedPromotionBackOnceTheFenceHolds', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mc-restore-coord-'));
        try {
            const destination = join(home, 'project');
            const displaced = join(home, 'project.displaced');
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, 'marker.txt'), 'new-tree\n');
            await mkdir(displaced, { recursive: true });
            await writeFile(join(displaced, 'marker.txt'), 'the-original\n');
            await writeFile(managedPromotionJournalPath(home, 'cp1'), JSON.stringify({
                schemaVersion: 1, checkpointId: 'cp1', promoted: 1, completed: false,
                entries: [{
                    area: 'project',
                    staged: join(home, 'staging/project'),
                    destination,
                    displaced,
                    hadDestination: true,
                }],
            }));

            const result = await coordinateManagedRestore({
                ...deps({
                    findJournals: findManagedPromotionJournals,
                    reconcile: reconcileManagedPromotion,
                }),
                stagingRoot: home,
                destinations: new Map([['project' as const, destination]]),
            } as never);

            expect(result).toEqual({ outcome: 'no-checkpoint' });
            expect(await readFile(join(destination, 'marker.txt'), 'utf8')).toBe('the-original\n');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});
