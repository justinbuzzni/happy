import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultToolWorkloadDeps, runToolWorkloadCall } from './toolWorkloadEntry';

function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'p4-workload-'));
    writeFileSync(join(dir, 'report.md'), 'report body\n');
    return dir;
}

describe('the workload entry does real work', () => {
    it('reads, writes and lists real files', () => {
        const dir = workspace();
        const deps = defaultToolWorkloadDeps(dir);
        expect(runToolWorkloadCall(JSON.stringify({ name: 'read_file', arguments: { path: 'report.md' } }), deps))
            .toEqual({ ok: true, content: 'report body\n' });
        expect(runToolWorkloadCall(JSON.stringify({
            name: 'write_file', arguments: { path: 'src/added.ts', contents: 'export const x = 2;\n' },
        }), deps)).toMatchObject({ ok: true });
        // 하위 디렉터리는 쓰기가 만든다 — 모델이 mkdir 도구를 따로 부르지 않아도 된다.
        expect(readFileSync(join(dir, 'src/added.ts'), 'utf8')).toBe('export const x = 2;\n');
        expect(runToolWorkloadCall(JSON.stringify({ name: 'list_files', arguments: {} }), deps))
            .toEqual({ ok: true, content: 'report.md\nsrc' });
        rmSync(dir, { recursive: true, force: true });
    });

    it('runs a real command in the workspace', () => {
        const dir = workspace();
        const deps = defaultToolWorkloadDeps(dir);
        const outcome = runToolWorkloadCall(JSON.stringify({
            name: 'run_command', arguments: { command: 'ls', args: [] },
        }), deps) as { ok: true; content: string };
        expect(outcome.ok).toBe(true);
        expect(outcome.content).toContain('exit=0');
        expect(outcome.content).toContain('report.md');
        rmSync(dir, { recursive: true, force: true });
    });

    it('brings a failing command back as output', () => {
        const dir = workspace();
        const deps = defaultToolWorkloadDeps(dir);
        const outcome = runToolWorkloadCall(JSON.stringify({
            name: 'run_command', arguments: { command: 'ls', args: ['no-such-file'] },
        }), deps) as { ok: true; content: string };
        expect(outcome.content).not.toContain('exit=0');
        rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a call it cannot parse', () => {
        const deps = defaultToolWorkloadDeps(workspace());
        expect(runToolWorkloadCall('not json', deps)).toEqual({ ok: false, code: 'execution-failed' });
        expect(runToolWorkloadCall('{"arguments":{}}', deps)).toEqual({ ok: false, code: 'tool-unavailable' });
    });

    it('keeps a command from outliving its limit', () => {
        const dir = workspace();
        const deps = defaultToolWorkloadDeps(dir);
        const started = Date.now();
        const outcome = runToolWorkloadCall(JSON.stringify({
            name: 'run_command', arguments: { command: 'sleep', args: ['30'], timeoutMs: 300 },
        }), deps) as { ok: true; content: string };
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(outcome.content).toContain('killed');
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('reading is bounded at the read itself', () => {
    it('never pulls a huge file into memory', () => {
        const dir = workspace();
        // 희소 파일: 디스크는 0, 읽으면 2GiB.
        writeFileSync(join(dir, 'sparse.bin'), '');
        truncateSync(join(dir, 'sparse.bin'), 2 * 1024 * 1024 * 1024);
        const deps = defaultToolWorkloadDeps(dir);
        const before = process.memoryUsage().rss;
        const outcome = runToolWorkloadCall(
            JSON.stringify({ name: 'read_file', arguments: { path: 'sparse.bin' } }), deps,
        ) as { ok: true; content: string };
        const grew = (process.memoryUsage().rss - before) / (1024 * 1024);
        expect(outcome.ok).toBe(true);
        expect(outcome.content).toContain('truncated');
        // 전체를 읽으면 여기서 수백 MB 가 잡힌다(256MB 컨테이너에서는 OOM 이었다).
        expect(grew).toBeLessThan(64);
        rmSync(dir, { recursive: true, force: true });
    });

    it('refuses what is not a regular file instead of blocking on it', () => {
        const dir = workspace();
        // 쓰는 쪽이 없는 FIFO 는 열기부터 막힌다.
        execFileSync('mkfifo', [join(dir, 'pipe')]);
        const deps = defaultToolWorkloadDeps(dir);
        const started = Date.now();
        expect(runToolWorkloadCall(JSON.stringify({ name: 'read_file', arguments: { path: 'pipe' } }), deps))
            .toEqual({ ok: false, code: 'execution-failed' });
        expect(Date.now() - started).toBeLessThan(3_000);
        rmSync(dir, { recursive: true, force: true });
    });
});
