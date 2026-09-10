import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectCheckpointDatabases, flushCheckpointDatabases } from './managedCheckpointFlush';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-flush-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const sqliteHeader = Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(64, 0)]);

describe('detectCheckpointDatabases', () => {
    it('shouldIdentifySqliteByItsMagicRatherThanItsName', async () => {
        const root = await scratch();
        await writeFile(join(root, 'app.db'), sqliteHeader);
        await writeFile(join(root, 'notes.db'), 'this is not a database\n');
        await writeFile(join(root, 'readme.md'), 'ignored');
        expect(await detectCheckpointDatabases(root)).toEqual([
            { path: 'app.db', engine: 'sqlite' },
            { path: 'notes.db', engine: 'unknown' },
        ]);
    });

    it('shouldNotDescendIntoTreesTheArchiveDoesNotCarry', async () => {
        const root = await scratch();
        await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
        await writeFile(join(root, 'node_modules/pkg/bundled.db'), sqliteHeader);
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/index.db'), sqliteHeader);
        expect(await detectCheckpointDatabases(root)).toEqual([]);
    });
});

describe('flushCheckpointDatabases', () => {
    it('shouldFlushEverySqliteDatabaseItFinds', async () => {
        const root = await scratch();
        await mkdir(join(root, 'data'), { recursive: true });
        await writeFile(join(root, 'data/app.sqlite'), sqliteHeader);
        const commands: { program: string; args: string[] }[] = [];

        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async (program, args) => { commands.push({ program, args }); return { code: 0, stdout: '0|0|0\n' }; } },
        });

        expect(result).toEqual({ flushed: ['data/app.sqlite'], unsupported: [] });
        expect(commands).toEqual([{
            program: 'sqlite3',
            args: [join(root, 'data/app.sqlite'), 'PRAGMA wal_checkpoint(TRUNCATE);'],
        }]);
    });

    it('shouldReportAMissingAdapterInsteadOfClaimingItFlushed', async () => {
        const root = await scratch();
        await writeFile(join(root, 'app.db'), sqliteHeader);
        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
        });
        expect(result).toEqual({ flushed: [], unsupported: [{ path: 'app.db', reason: 'no-adapter' }] });
    });

    it('shouldReportANonZeroFlushAsUnsupportedRatherThanSuccess', async () => {
        const root = await scratch();
        await writeFile(join(root, 'app.db'), sqliteHeader);
        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async () => ({ code: 1, stdout: '' }) },
        });
        expect(result).toEqual({ flushed: [], unsupported: [{ path: 'app.db', reason: 'flush-failed' }] });
    });

    it('shouldNameAnUnknownEngineWithoutRunningAnAdapterAgainstIt', async () => {
        const root = await scratch();
        await writeFile(join(root, 'store.db'), 'proprietary format');
        let ran = false;
        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async () => { ran = true; return { code: 0, stdout: '0|0|0' }; } },
        });
        expect(ran).toBe(false);
        expect(result).toEqual({ flushed: [], unsupported: [{ path: 'store.db', reason: 'unknown-engine' }] });
    });

    it('shouldNotCallABusyCheckpointFlushedEvenThoughSqliteExitsZero', async () => {
        const root = await scratch();
        await writeFile(join(root, 'app.db'), sqliteHeader);
        // busy|log|checkpointed — a leading 1 means the WAL was not folded in.
        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async () => ({ code: 0, stdout: '1|4|3\n' }) },
        });
        expect(result).toEqual({ flushed: [], unsupported: [{ path: 'app.db', reason: 'flush-failed' }] });
    });

    it('shouldNotCallAnEmptyOrUnreadableResultRowFlushed', async () => {
        const root = await scratch();
        await writeFile(join(root, 'app.db'), sqliteHeader);
        for (const stdout of ['', '\n', 'Error: database is locked\n']) {
            expect(await flushCheckpointDatabases({ root, deps: { run: async () => ({ code: 0, stdout }) } }))
                .toEqual({ flushed: [], unsupported: [{ path: 'app.db', reason: 'flush-failed' }] });
        }
    });

    it('shouldNotRunACheckpointAgainstADatabaseReachedThroughASymlink', async () => {
        const base = await scratch();
        const root = join(base, 'project');
        await mkdir(root, { recursive: true });
        await writeFile(join(base, 'outside.db'), sqliteHeader);
        await symlink('../outside.db', join(root, 'external.db'));
        await mkdir(join(base, 'elsewhere'), { recursive: true });
        await writeFile(join(base, 'elsewhere/deep.db'), sqliteHeader);
        await symlink('../elsewhere', join(root, 'linked-dir'));

        const calls: string[][] = [];
        const result = await flushCheckpointDatabases({
            root,
            deps: { run: async (_program, args) => { calls.push(args); return { code: 0, stdout: '0|0|0' }; } },
        });

        expect(calls).toEqual([]);
        expect(result).toEqual({ flushed: [], unsupported: [] });
        expect(await detectCheckpointDatabases(root)).toEqual([]);
    });
});
