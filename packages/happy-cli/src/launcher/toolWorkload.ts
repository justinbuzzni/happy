/**
 * specs/managed-cloud-byos P4 — 격리된 executor 안에서 도는 **도구 workload**.
 *
 * broker 가 넘긴 호출 하나를 처리하고 결과를 돌려준다. 이 코드가 도는 곳은
 * provider 와 다른 UID, 자기 PID/mount/net namespace, 그리고 계획이 정한 workspace
 * 안이다(§5.36 + P4 executor). 그래서 여기서 다시 세우는 경계는 **파일 경로와
 * 실행 대상**뿐이다 — 나머지는 커널이 이미 잡고 있다.
 *
 * 도구는 코딩에 실제로 필요한 최소 넷이다. 더 만들면 모델이 고를 것이 늘고,
 * 각각이 새 경계가 된다.
 */
import { resolve, sep } from 'node:path';

import type { BrokerTool, BrokerToolCall, BrokerToolResult } from './toolBroker';

/** 한 번에 모델에게 돌려주는 최대 바이트. 넘으면 잘라내고 그 사실을 말한다. */
export const MAX_TOOL_CONTENT_BYTES = 64 * 1024;
/** 한 번에 쓸 수 있는 최대 바이트. */
export const MAX_WRITE_BYTES = 1024 * 1024;
/** 명령 하나의 상한. executor 전체 시한과 별개로 여기서도 끊는다. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * The tools that can change the workspace.
 *
 * `run_command` is here because it *can* write, not because it always does.
 * A checkpoint's consistency argument is that no write is in flight while the
 * archive is taken, and "this command probably only reads" is not something
 * that can be known from the outside.
 */
export const MANAGED_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'run_command']);

export const MANAGED_CODING_TOOLS: BrokerTool[] = [
    {
        name: 'read_file',
        description: 'Read a UTF-8 file from the run workspace. Paths are relative to the workspace root.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative path' } },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Create or replace a UTF-8 file in the run workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative path' },
                contents: { type: 'string', description: 'Full file contents' },
            },
            required: ['path', 'contents'],
        },
    },
    {
        name: 'list_files',
        description: 'List the entries of a directory in the run workspace.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative directory, defaults to the root' } },
        },
    },
    {
        name: 'run_command',
        description: 'Run a program in the run workspace and return its exit code and output.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Program name, without a path or shell syntax' },
                args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed as-is' },
                timeoutMs: { type: 'number', description: 'Optional limit for this command' },
            },
            required: ['command'],
        },
    },
];

export type ToolWorkloadDeps = {
    /** 이 run 의 workspace. 모든 경로는 여기 안이어야 한다. */
    workspace: string;
    /**
     * 최대 `limit` 바이트까지만 읽는다. 더 있으면 `clipped` 로 말한다.
     *
     * 전체를 읽고 뒤에서 자르면 파일 크기만큼 메모리를 쓴다 — 2GB 희소 파일에
     * 256MB 컨테이너가 OOM 으로 죽는 것을 실측했다.
     */
    readFile: (path: string, limit: number) => { text: string; clipped: boolean };
    writeFile: (path: string, contents: string) => void;
    listDirectory: (path: string) => string[];
    runCommand: (input: {
        command: string; args: string[]; cwd: string; timeoutMs: number;
    }) => { code: number | null; stdout: string; stderr: string };
};

/**
 * workspace 안의 실제 경로로 바꾼다. 밖을 가리키면 `null`.
 *
 * 문자열 검사가 아니라 **정규화 후 포함 관계**로 본다 — `src/../../x` 같은 것은
 * 문자열로는 상대 경로처럼 보인다.
 */
function resolveInWorkspace(workspace: string, path: unknown): string | null {
    if (typeof path !== 'string' || path.trim() === '') return null;
    if (path.startsWith('/')) return null;
    const resolved = resolve(workspace, path);
    if (resolved === workspace) return null;
    if (!resolved.startsWith(`${workspace}${sep}`)) return null;
    return resolved;
}

/** 잘라내되, 잘렸다는 사실을 결과 안에 남긴다. */
function bounded(text: string): string {
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.byteLength <= MAX_TOOL_CONTENT_BYTES) return text;
    return `${encoded.subarray(0, MAX_TOOL_CONTENT_BYTES).toString('utf8')}\n…(truncated at ${MAX_TOOL_CONTENT_BYTES} bytes)`;
}

/** 프로그램 이름만 받는다. 경로나 쉘 문법이 들어오면 그것은 다른 도구다. */
function isPlainProgramName(command: unknown): command is string {
    return typeof command === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(command);
}

export function handleToolCall(call: BrokerToolCall, deps: ToolWorkloadDeps): BrokerToolResult {
    switch (call.name) {
        case 'read_file': {
            const path = resolveInWorkspace(deps.workspace, call.arguments.path);
            if (path === null) return { ok: false, code: 'workspace-denied' };
            try {
                const found = deps.readFile(path, MAX_TOOL_CONTENT_BYTES);
                return {
                    ok: true,
                    content: found.clipped
                        ? `${found.text}\n…(truncated at ${MAX_TOOL_CONTENT_BYTES} bytes)`
                        : found.text,
                };
            } catch {
                return { ok: false, code: 'execution-failed' };
            }
        }
        case 'write_file': {
            const path = resolveInWorkspace(deps.workspace, call.arguments.path);
            if (path === null) return { ok: false, code: 'workspace-denied' };
            const contents = call.arguments.contents;
            if (typeof contents !== 'string') return { ok: false, code: 'execution-failed' };
            const size = Buffer.byteLength(contents, 'utf8');
            if (size > MAX_WRITE_BYTES) return { ok: false, code: 'execution-failed' };
            try {
                deps.writeFile(path, contents);
            } catch {
                return { ok: false, code: 'execution-failed' };
            }
            return { ok: true, content: `wrote ${size} bytes to ${String(call.arguments.path)}` };
        }
        case 'list_files': {
            const raw = call.arguments.path;
            const path = raw === undefined || raw === ''
                ? deps.workspace
                : resolveInWorkspace(deps.workspace, raw);
            if (path === null) return { ok: false, code: 'workspace-denied' };
            try {
                return { ok: true, content: bounded(deps.listDirectory(path).join('\n')) };
            } catch {
                return { ok: false, code: 'execution-failed' };
            }
        }
        case 'run_command': {
            if (!isPlainProgramName(call.arguments.command)) return { ok: false, code: 'workspace-denied' };
            const args = call.arguments.args;
            if (args !== undefined && (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string'))) {
                return { ok: false, code: 'workspace-denied' };
            }
            const requested = call.arguments.timeoutMs;
            const timeoutMs = typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
                ? Math.min(requested, DEFAULT_COMMAND_TIMEOUT_MS)
                : DEFAULT_COMMAND_TIMEOUT_MS;
            let outcome: { code: number | null; stdout: string; stderr: string };
            try {
                outcome = deps.runCommand({
                    command: call.arguments.command,
                    args: (args ?? []) as string[],
                    cwd: deps.workspace,
                    timeoutMs,
                });
            } catch {
                return { ok: false, code: 'execution-failed' };
            }
            /*
             * 실패한 명령은 **도구의 실패가 아니다**. 종료 코드와 출력을 그대로
             * 돌려줘야 모델이 다음 수를 정할 수 있다.
             */
            const printed = [outcome.stdout, outcome.stderr].filter((part) => part !== '').join('\n');
            return { ok: true, content: bounded(`exit=${outcome.code ?? 'killed'}\n${printed}`) };
        }
        default:
            return { ok: false, code: 'tool-unavailable' };
    }
}
