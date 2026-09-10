import { describe, expect, it } from 'vitest';

import { MANAGED_CODING_TOOLS, handleToolCall } from './toolWorkload';

/** 실제 실행 대신 관측 가능한 대역. 경계 판정만 본다. */
function harness(overrides: Partial<Parameters<typeof handleToolCall>[1]> = {}) {
    const files = new Map<string, string>([['/workspace/project/보고서.md', '보고서 본문']]);
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    return {
        files,
        commands,
        deps: {
            workspace: '/workspace/project',
            readFile: (path: string, limit: number) => {
                const found = files.get(path);
                if (found === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                // 실제 deps 와 같은 계약: 상한까지만 돌려주고, 넘치면 잘렸다고 말한다.
                const encoded = Buffer.from(found, 'utf8');
                return {
                    text: encoded.subarray(0, limit).toString('utf8'),
                    clipped: encoded.byteLength > limit,
                };
            },
            writeFile: (path: string, contents: string) => { files.set(path, contents); },
            listDirectory: (path: string) => (path === '/workspace/project' ? ['보고서.md', 'src'] : []),
            runCommand: (input: { command: string; args: string[]; cwd: string; timeoutMs: number }) => {
                commands.push({ command: input.command, args: input.args, cwd: input.cwd });
                return { code: 0, stdout: 'ran', stderr: '' };
            },
            ...overrides,
        },
    };
}

describe('the coding tools this run offers', () => {
    it('is a small set, each with a schema the model can fill', () => {
        expect(MANAGED_CODING_TOOLS.map((tool) => tool.name))
            .toEqual(['read_file', 'write_file', 'list_files', 'run_command']);
        for (const tool of MANAGED_CODING_TOOLS) {
            expect(tool.description.length).toBeGreaterThan(10);
            expect(tool.inputSchema.type).toBe('object');
        }
    });
});

describe('reading and writing inside the workspace', () => {
    it('reads a file the run owns', () => {
        const { deps } = harness();
        expect(handleToolCall({ name: 'read_file', arguments: { path: '보고서.md' } }, deps))
            .toEqual({ ok: true, content: '보고서 본문' });
    });

    it('writes a file and reports what it wrote', () => {
        const { deps, files } = harness();
        const outcome = handleToolCall({
            name: 'write_file', arguments: { path: 'src/new.ts', contents: 'export const a = 1;\n' },
        }, deps);
        expect(outcome).toEqual({ ok: true, content: 'wrote 20 bytes to src/new.ts' });
        expect(files.get('/workspace/project/src/new.ts')).toBe('export const a = 1;\n');
    });

    it('lists what is there', () => {
        const { deps } = harness();
        expect(handleToolCall({ name: 'list_files', arguments: {} }, deps))
            .toEqual({ ok: true, content: '보고서.md\nsrc' });
    });

    it('says plainly when a file is not there', () => {
        const { deps } = harness();
        expect(handleToolCall({ name: 'read_file', arguments: { path: 'nope.md' } }, deps))
            .toEqual({ ok: false, code: 'execution-failed' });
    });
});

describe('the workspace is the only place these tools reach', () => {
    it('refuses to leave it, however the path is written', () => {
        const { deps, files } = harness();
        for (const path of [
            '../etc/passwd', '/etc/passwd', 'src/../../secret', './../x',
            '/workspace/project/../other/file', '', '.', '..',
        ]) {
            expect(handleToolCall({ name: 'read_file', arguments: { path } }, deps))
                .toEqual({ ok: false, code: 'workspace-denied' });
            expect(handleToolCall({ name: 'write_file', arguments: { path, contents: 'x' } }, deps))
                .toEqual({ ok: false, code: 'workspace-denied' });
        }
        // 거부된 쓰기는 아무것도 남기지 않는다.
        expect([...files.keys()]).toEqual(['/workspace/project/보고서.md']);
    });
});

describe('running a command', () => {
    it('runs it in the workspace and returns what it printed', () => {
        const { deps, commands } = harness();
        expect(handleToolCall({
            name: 'run_command', arguments: { command: 'node', args: ['-e', 'console.log(1)'] },
        }, deps)).toEqual({ ok: true, content: 'exit=0\nran' });
        expect(commands).toEqual([{ command: 'node', args: ['-e', 'console.log(1)'], cwd: '/workspace/project' }]);
    });

    it('reports a failing command as its output, not as a broken tool', () => {
        const { deps } = harness({
            runCommand: () => ({ code: 2, stdout: '', stderr: 'boom' }),
        });
        expect(handleToolCall({ name: 'run_command', arguments: { command: 'false', args: [] } }, deps))
            .toEqual({ ok: true, content: 'exit=2\nboom' });
    });

    it('refuses a command that is not a plain program name', () => {
        const { deps, commands } = harness();
        for (const command of ['', 'rm -rf /', 'sh; whoami', '/bin/sh', '../bin/sh']) {
            expect(handleToolCall({ name: 'run_command', arguments: { command, args: [] } }, deps))
                .toEqual({ ok: false, code: 'workspace-denied' });
        }
        expect(commands).toEqual([]);
    });
});

describe('nothing unbounded reaches the model', () => {
    it('asks the reader for a bounded amount and reports the truncation', () => {
        const limits: number[] = [];
        const { deps, files } = harness();
        const original = deps.readFile;
        deps.readFile = (path: string, limit: number) => { limits.push(limit); return original(path, limit); };
        files.set('/workspace/project/big.txt', 'x'.repeat(300_000));
        const outcome = handleToolCall({ name: 'read_file', arguments: { path: 'big.txt' } }, deps) as { content: string };
        // 상한을 넘겨 읽지 않는다 — 파일 전체를 메모리에 올리지 않기 위해서다.
        expect(limits).toEqual([64 * 1024]);
        expect(outcome.content.length).toBeLessThanOrEqual(64 * 1024 + 60);
        expect(outcome.content).toContain('truncated');
    });

    it('refuses to write more than a run should', () => {
        const { deps } = harness();
        expect(handleToolCall({
            name: 'write_file', arguments: { path: 'big.txt', contents: 'y'.repeat(2_000_000) },
        }, deps)).toEqual({ ok: false, code: 'execution-failed' });
    });
});

describe('unknown or malformed calls', () => {
    it('refuses a tool it does not have', () => {
        const { deps } = harness();
        expect(handleToolCall({ name: 'delete_everything', arguments: {} }, deps))
            .toEqual({ ok: false, code: 'tool-unavailable' });
    });

    it('refuses arguments of the wrong shape', () => {
        const { deps } = harness();
        expect(handleToolCall({ name: 'read_file', arguments: { path: 42 } as never }, deps))
            .toEqual({ ok: false, code: 'workspace-denied' });
        expect(handleToolCall({ name: 'write_file', arguments: { path: 'a.txt' } as never }, deps))
            .toEqual({ ok: false, code: 'execution-failed' });
    });
});
