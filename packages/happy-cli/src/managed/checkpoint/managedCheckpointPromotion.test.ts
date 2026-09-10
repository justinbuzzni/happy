import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { rename as realRename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    findManagedPromotionJournals,
    managedPromotionJournalPath,
    type ManagedPromotionDeps,
    promoteCheckpointTrees,
    readManagedPromotionJournal,
    reconcileManagedPromotion,
} from './managedCheckpointPromotion';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-promote-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function tree(path: string, marker: string): Promise<string> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'marker.txt'), marker);
    return path;
}

async function marker(path: string): Promise<string> {
    return readFile(join(path, 'marker.txt'), 'utf8');
}

async function twoAreaPlan(home: string) {
    const staging = join(home, 'staging');
    await mkdir(staging, { recursive: true });
    await tree(join(staging, 'project'), 'new-project');
    await tree(join(staging, 'provider-state'), 'new-provider');
    return [
        {
            area: 'project',
            staged: join(staging, 'project'),
            destination: join(home, 'project'),
            displaced: join(home, 'project.displaced'),
        },
        {
            area: 'provider-state',
            staged: join(staging, 'provider-state'),
            destination: join(home, 'provider-state'),
            displaced: join(home, 'provider-state.displaced'),
        },
    ];
}

describe('promoteCheckpointTrees', () => {
    it('shouldPromoteEveryAreaAndLeaveNoJournalOrDisplacedTree', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        await tree(join(home, 'provider-state'), 'old-provider');
        const journalPath = managedPromotionJournalPath(home, 'cp1');

        await promoteCheckpointTrees({ journalPath, checkpointId: 'cp1', entries: await twoAreaPlan(home) });

        expect(await marker(join(home, 'project'))).toBe('new-project');
        expect(await marker(join(home, 'provider-state'))).toBe('new-provider');
        expect(await readManagedPromotionJournal(journalPath)).toBeNull();
        expect((await readdir(home)).filter((name) => name.includes('displaced'))).toEqual([]);
    });

    it('shouldRollBackBothAreasWhenTheSecondFailsSoTheyNeverMix', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        await tree(join(home, 'provider-state'), 'old-provider');
        const journalPath = managedPromotionJournalPath(home, 'cp1');

        let calls = 0;
        await expect(promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries: await twoAreaPlan(home),
            // Fails while promoting the *second* area, after the first is live.
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    if (calls === 4) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        expect(await marker(join(home, 'project'))).toBe('old-project');
        expect(await marker(join(home, 'provider-state'))).toBe('old-provider');
        expect(await readManagedPromotionJournal(journalPath)).toBeNull();
    });

    it('shouldKeepTheDisplacedTreeAndTheJournalWhenRollbackItselfFails', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'mine');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);

        let calls = 0;
        const error = await promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries,
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    // 1: destination → displaced (succeeds)
                    // 2: staged → destination (fails)
                    // 3: displaced → destination, the rollback (also fails)
                    if (calls >= 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    await realRename(from, to);
                },
            },
        }).catch((caught: unknown) => caught);

        expect(calls).toBe(3);
        expect(error).toMatchObject({ code: 'promotion-unreconciled' });
        // The user's only copy is at the displaced path, and the journal says so.
        expect(await marker(entries[0]!.displaced)).toBe('mine');
        const journal = await readManagedPromotionJournal(journalPath);
        expect(journal?.entries[0]).toMatchObject({
            destination: entries[0]!.destination,
            displaced: entries[0]!.displaced,
            hadDestination: true,
        });
    });

    it('shouldCreateADestinationThatDidNotExistAndRemoveItOnRollback', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);

        let calls = 0;
        await expect(promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries,
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    if (calls === 1) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        await expect(stat(entries[0]!.destination)).rejects.toThrow();
    });
});

describe('promoteCheckpointTrees durability', () => {
    it('shouldFlushEveryStagedTreeBeforeTheFirstRename', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        await tree(join(home, 'provider-state'), 'old-provider');
        const entries = await twoAreaPlan(home);
        const log: string[] = [];
        const deps: Partial<ManagedPromotionDeps> = {
            syncPath: async (path) => { log.push(`sync:${path}`); },
            rename: async (from, to) => { log.push(`rename:${from}`); await realRename(from, to); },
        };

        await promoteCheckpointTrees({
            journalPath: managedPromotionJournalPath(home, 'cp1'),
            checkpointId: 'cp1',
            entries,
            deps,
        });

        const firstRename = log.findIndex((line) => line.startsWith('rename:'));
        for (const entry of entries) {
            // The tree itself and the file in it are on disk before anything
            // starts moving.
            expect(log.indexOf(`sync:${entry.staged}`)).toBeGreaterThanOrEqual(0);
            expect(log.indexOf(`sync:${entry.staged}`)).toBeLessThan(firstRename);
            expect(log.indexOf(`sync:${join(entry.staged, 'marker.txt')}`)).toBeLessThan(firstRename);
        }
    });

    it('shouldFlushTheDirectoryEntryAfterEveryRename', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        const entries = (await twoAreaPlan(home)).slice(0, 1);
        const log: string[] = [];

        await promoteCheckpointTrees({
            journalPath: managedPromotionJournalPath(home, 'cp1'),
            checkpointId: 'cp1',
            entries,
            deps: {
                syncPath: async (path) => { log.push(`sync:${path}`); },
                rename: async (from, to) => { log.push(`rename:${from}->${to}`); await realRename(from, to); },
            },
        });

        // A rename is only durable once the directory that now names the tree
        // has been flushed.
        for (const [index, line] of log.entries()) {
            if (!line.startsWith('rename:')) continue;
            const [from, to] = line.slice('rename:'.length).split('->');
            const after = log.slice(index + 1);
            expect(after).toContain(`sync:${join(from!, '..')}`);
            expect(after).toContain(`sync:${join(to!, '..')}`);
        }
    });

    it('shouldFlushTheDirectoryEntryAfterTheJournalIsRemoved', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const log: string[] = [];

        await promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries: (await twoAreaPlan(home)).slice(0, 1),
            deps: {
                syncPath: async (path) => { log.push(`sync:${path}`); },
                remove: async (path) => { log.push(`remove:${path}`); await rm(path, { recursive: true, force: true }); },
            },
        });

        // An unlink that has not reached the directory entry can come back
        // after a power cut, and a resurrected journal drives a reconcile.
        const removal = log.lastIndexOf(`remove:${journalPath}`);
        expect(removal).toBeGreaterThanOrEqual(0);
        expect(log.slice(removal)).toContain(`sync:${home}`);
    });

    it('shouldFlushTheDeletionWhenRollingBackAnAreaThatDidNotExistBefore', async () => {
        const home = await scratch();
        // First area is new (no destination yet); the second one fails, so the
        // first has to be rolled back by deleting it.
        await tree(join(home, 'provider-state'), 'old-provider');
        const entries = await twoAreaPlan(home);
        const log: string[] = [];
        let calls = 0;

        await expect(promoteCheckpointTrees({
            journalPath: managedPromotionJournalPath(home, 'cp1'),
            checkpointId: 'cp1',
            entries,
            deps: {
                syncPath: async (path) => { log.push(`sync:${path}`); },
                remove: async (path) => { log.push(`remove:${path}`); await rm(path, { recursive: true, force: true }); },
                rename: async (from, to) => {
                    calls += 1;
                    // 1: staged project → destination (new area, no displace)
                    // 2: provider-state → displaced
                    // 3: staged provider-state → destination — fails here
                    if (calls === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        await expect(stat(entries[0]!.destination)).rejects.toThrow();
        expect(await marker(join(home, 'provider-state'))).toBe('old-provider');
        const removal = log.lastIndexOf(`remove:${entries[0]!.destination}`);
        expect(removal).toBeGreaterThanOrEqual(0);
        // The deletion is on the disk before the journal that could undo it goes.
        expect(log.slice(removal)).toContain(`sync:${home}`);
        const journalRemoval = log.lastIndexOf(`remove:${managedPromotionJournalPath(home, 'cp1')}`);
        expect(removal).toBeLessThan(journalRemoval);
    });

    it('shouldStayUnreconciledWhenTheRollbackDeletionCannotBeFlushed', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);
        let calls = 0;

        await expect(promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries,
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    if (calls === 1) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
                syncPath: async (path) => {
                    if (path === home) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-unreconciled' });

        // An undo that is not durable is not an undo, so the journal stays.
        expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
    });

    it('shouldRecordCompletionDurablyBeforeItReclaimsAnyDisplacedTree', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'old-project');
        await tree(join(home, 'provider-state'), 'old-provider');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const seenAtFirstRemoval: (boolean | null)[] = [];

        await promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries: await twoAreaPlan(home),
            deps: {
                remove: async (path) => {
                    if (path.includes('displaced')) {
                        const journal = await readManagedPromotionJournal(journalPath);
                        seenAtFirstRemoval.push(journal?.completed ?? null);
                    }
                    await rm(path, { recursive: true, force: true });
                },
            },
        });

        // The old copies are only released once the record says the promotion
        // finished — otherwise a journal that survives a crash sends a
        // reconcile down the rollback path with nothing left to roll back to.
        expect(seenAtFirstRemoval.length).toBeGreaterThan(0);
        expect(seenAtFirstRemoval.every((completed) => completed === true)).toBe(true);
    });
});

describe('reconcileManagedPromotion', () => {
    it('shouldReportNothingToDoWithoutAJournal', async () => {
        const home = await scratch();
        expect(await reconcileManagedPromotion(managedPromotionJournalPath(home, 'cp1'))).toBe('none');
    });

    it('shouldReturnTheVolumeToItsPreRestoreStateAfterACrashBetweenAreas', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = await twoAreaPlan(home);

        // The exact on-disk shape a crash between the two areas leaves: the
        // project is already the new tree, its old one is displaced, and the
        // provider state is still the previous run's.
        await realRename(entries[0]!.staged, entries[0]!.destination);
        await tree(entries[0]!.displaced, 'old-project');
        await tree(join(home, 'provider-state'), 'old-provider');
        await writeFile(journalPath, JSON.stringify({
            schemaVersion: 1, checkpointId: 'cp1', promoted: 1, completed: false,
            entries: entries.map((entry) => ({ ...entry, hadDestination: true })),
        }));
        expect(await marker(join(home, 'project'))).toBe('new-project');
        expect(await marker(join(home, 'provider-state'))).toBe('old-provider');

        expect(await reconcileManagedPromotion(journalPath)).toBe('rolled-back');

        // Both areas are the previous run's again — never one of each.
        expect(await marker(join(home, 'project'))).toBe('old-project');
        expect(await marker(join(home, 'provider-state'))).toBe('old-provider');
        expect(await readManagedPromotionJournal(journalPath)).toBeNull();
        await expect(stat(entries[1]!.staged)).rejects.toThrow();
    });

    it('shouldFinishACompletedPromotionInsteadOfRollingItBack', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = await twoAreaPlan(home);

        // A crash after the durable completion record and part way through
        // releasing the old copies: one displaced tree is already gone.
        await realRename(entries[0]!.staged, entries[0]!.destination);
        await realRename(entries[1]!.staged, entries[1]!.destination);
        await tree(entries[1]!.displaced, 'old-provider');
        await writeFile(journalPath, JSON.stringify({
            schemaVersion: 1, checkpointId: 'cp1', promoted: 2, completed: true,
            entries: entries.map((entry) => ({ ...entry, hadDestination: true })),
        }));

        expect(await reconcileManagedPromotion(journalPath)).toBe('completed');

        // Both areas stay on the new trees. Rolling back here would restore one
        // area's old copy and leave the other new — the mixed state the whole
        // journal exists to prevent.
        expect(await marker(join(home, 'project'))).toBe('new-project');
        expect(await marker(join(home, 'provider-state'))).toBe('new-provider');
        await expect(stat(entries[1]!.displaced)).rejects.toThrow();
        expect(await readManagedPromotionJournal(journalPath)).toBeNull();
    });

    it('shouldRefuseToDeclareSuccessWhenItCannotPutTheVolumeBack', async () => {
        const home = await scratch();
        await tree(join(home, 'project.displaced'), 'mine');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        await writeFile(journalPath, JSON.stringify({
            schemaVersion: 1, checkpointId: 'cp1', promoted: 0, completed: false,
            entries: [{
                area: 'project',
                staged: join(home, 'staging/project'),
                destination: join(home, 'project'),
                displaced: join(home, 'project.displaced'),
                hadDestination: true,
            }],
        }));

        expect(await reconcileManagedPromotion(journalPath, {
            rename: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
        })).toBe('unreconciled');
        expect(await marker(join(home, 'project.displaced'))).toBe('mine');
        expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
    });

    it('shouldRejectACorruptJournalRatherThanIgnoringIt', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        await writeFile(journalPath, '{"schemaVersion":1}');
        await expect(reconcileManagedPromotion(journalPath)).rejects.toThrow('promotion journal is corrupt');
    });
});

describe('reconcileManagedPromotion durability of the undo', () => {
    it('shouldNotClaimRolledBackWhenTheJournalCouldNotBeRemoved', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);
        await tree(entries[0]!.destination, 'the-new-tree');
        await writeFile(journalPath, JSON.stringify({
            schemaVersion: 1, checkpointId: 'cp1', promoted: 1, completed: false,
            // No destination before this promotion, so the undo is a deletion.
            entries: entries.map((entry) => ({ ...entry, hadDestination: false })),
        }));

        const outcome = await reconcileManagedPromotion(journalPath, {
            remove: async (path) => {
                if (path === journalPath) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                await rm(path, { recursive: true, force: true });
            },
        });

        // A journal that survives a "successful" rollback is read again on the
        // next boot — and this one says to delete the destination, which by
        // then holds a *newly restored* tree.
        expect(outcome).toBe('unreconciled');
        expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
    });

    it('shouldNotClaimRolledBackWhenTheJournalRemovalCouldNotBeFlushed', async () => {
        const home = await scratch();
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);
        await tree(entries[0]!.destination, 'the-new-tree');
        await writeFile(journalPath, JSON.stringify({
            schemaVersion: 1, checkpointId: 'cp1', promoted: 1, completed: false,
            entries: entries.map((entry) => ({ ...entry, hadDestination: false })),
        }));

        expect(await reconcileManagedPromotion(journalPath, {
            syncPath: async (path) => {
                if (path === home) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            },
        })).toBe('unreconciled');
    });

    it('shouldNotClaimPromotionFailedWhenTheJournalOutlivesTheRollback', async () => {
        const home = await scratch();
        await tree(join(home, 'provider-state'), 'old-provider');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        let calls = 0;

        await expect(promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries: await twoAreaPlan(home),
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    if (calls === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
                remove: async (path) => {
                    if (path === journalPath) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    await rm(path, { recursive: true, force: true });
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-unreconciled' });
        expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
    });
});

describe('promoteCheckpointTrees when the filesystem cannot answer', () => {
    it('shouldNotTreatAnUnreadableDestinationAsAbsentAndDeleteIt', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'the-original');
        const entries = (await twoAreaPlan(home)).slice(0, 1);

        // `stat` fails with something that is not "not there". Reading that as
        // "there was nothing here" makes the promotion skip displacing the
        // original — and then the rollback deletes it as if this run had
        // created it.
        await expect(promoteCheckpointTrees({
            journalPath: managedPromotionJournalPath(home, 'cp1'),
            checkpointId: 'cp1',
            entries,
            deps: {
                statPath: async (path) => {
                    if (path === entries[0]!.destination) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    return null;
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        expect(await marker(join(home, 'project'))).toBe('the-original');
        // Nothing had moved yet, so there is nothing to reconcile either.
        expect(await readManagedPromotionJournal(managedPromotionJournalPath(home, 'cp1'))).toBeNull();
    });

    it('shouldTreatOnlyANotFoundAsAbsentInItsOwnStatImplementation', async () => {
        // No injected deps: this exercises the real `statPath`, which is where
        // the catch-all lived.
        const base = await scratch();
        const home = join(base, 'locked');
        await mkdir(home, { recursive: true });
        const entries = [{
            area: 'project',
            staged: join(base, 'staged'),
            destination: join(home, 'project'),
            displaced: join(home, 'project.displaced'),
        }];
        await tree(entries[0]!.staged, 'new');
        await chmod(home, 0o000);
        try {
            await expect(promoteCheckpointTrees({
                journalPath: join(base, 'managed-checkpoint-promotion-cp1.json'),
                checkpointId: 'cp1',
                entries,
            })).rejects.toMatchObject({ code: 'promotion-failed' });
        } finally {
            await chmod(home, 0o700);
        }
    });

    it('shouldNotCallARollbackDoneWhenItCannotSeeTheDisplacedTree', async () => {
        const home = await scratch();
        await tree(join(home, 'project'), 'the-original');
        const journalPath = managedPromotionJournalPath(home, 'cp1');
        const entries = (await twoAreaPlan(home)).slice(0, 1);
        let calls = 0;

        await expect(promoteCheckpointTrees({
            journalPath,
            checkpointId: 'cp1',
            entries,
            deps: {
                rename: async (from, to) => {
                    calls += 1;
                    if (calls === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await realRename(from, to);
                },
                statPath: async (path) => {
                    // The survey succeeds; the rollback's look at the displaced
                    // tree does not.
                    if (calls > 0 && path === entries[0]!.displaced) {
                        throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    }
                    return stat(path).then((entry) => entry, () => null);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-unreconciled' });

        // The original is still at the displaced path and the journal says so.
        expect(await marker(entries[0]!.displaced)).toBe('the-original');
        expect(await readManagedPromotionJournal(journalPath)).not.toBeNull();
    });
});

describe('findManagedPromotionJournals', () => {
    it('shouldListInterruptedPromotionsWithoutTheCallerKnowingACheckpointId', async () => {
        const home = await scratch();
        await writeFile(managedPromotionJournalPath(home, 'cp2'), '{}');
        await writeFile(managedPromotionJournalPath(home, 'cp1'), '{}');
        await writeFile(join(home, 'managed-checkpoint-promotion-cp1.json.tmp'), '{}');
        await writeFile(join(home, 'unrelated.json'), '{}');
        await mkdir(join(home, '.managed-checkpoint-staging'), { recursive: true });

        expect(await findManagedPromotionJournals(home)).toEqual([
            managedPromotionJournalPath(home, 'cp1'),
            managedPromotionJournalPath(home, 'cp2'),
        ]);
    });

    it('shouldReturnNothingWhenTheStagingRootHasNeverBeenUsed', async () => {
        expect(await findManagedPromotionJournals(join(await scratch(), 'never'))).toEqual([]);
    });

    it('shouldNotReportAnUnreadableStagingRootAsEmpty', async () => {
        const home = await scratch();
        await writeFile(managedPromotionJournalPath(home, 'cp1'), '{}');
        // "Nothing to reconcile" and "could not look" are different answers,
        // and a boot that treats the second as the first starts on a volume
        // with an interrupted promotion on it.
        await chmod(home, 0o000);
        try {
            await expect(findManagedPromotionJournals(home)).rejects.toThrow('staging root');
        } finally {
            await chmod(home, 0o700);
        }
    });
});
