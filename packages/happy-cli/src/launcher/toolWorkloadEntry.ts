/**
 * specs/managed-cloud-byos P4 — 도구 workload 의 실제 실행 deps 와 진입점.
 *
 * 격리된 executor 가 이 프로세스를 execve 하고, broker 가 넘긴 호출 하나를
 * stdin 으로 준다. 여기서 하는 일은 그 JSON 을 읽어 `handleToolCall` 에 넘기고
 * 결과를 stdout 으로 돌려주는 것뿐이다 — 경계는 위(커널)와 안(`toolWorkload`)에 있다.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BrokerToolCall, BrokerToolResult } from './toolBroker';
import { type ToolWorkloadDeps, handleToolCall } from './toolWorkload';

export function defaultToolWorkloadDeps(workspace: string): ToolWorkloadDeps {
    return {
        workspace,
        readFile: (path, limit) => {
            /*
             * 읽기 자체를 묶는다.
             *
             * 전부 읽고 뒤에서 자르면 파일 크기만큼 메모리를 쓴다 — 2GiB 희소 파일을
             * 256MB 컨테이너에서 읽으면 OOM 으로 죽었다(실측). 그리고 `O_NONBLOCK`
             * 없이 열면 쓰는 쪽 없는 FIFO 에서 **열기부터** 멈춘다(실측). 그래서
             * non-blocking 으로 열고, 일반 파일이 아니면 거기서 끝낸다.
             */
            const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
            try {
                if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
                // 한 바이트 더 읽어 "더 있다" 를 판정한다.
                const buffer = Buffer.allocUnsafe(limit + 1);
                const read = readSync(fd, buffer, 0, limit + 1, 0);
                const clipped = read > limit;
                return {
                    text: buffer.subarray(0, clipped ? limit : read).toString('utf8'),
                    clipped,
                };
            } finally {
                closeSync(fd);
            }
        },
        writeFile: (path, contents) => {
            // 모델이 디렉터리 만들기 도구를 따로 부르지 않아도 되게 한다.
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, contents, 'utf8');
        },
        listDirectory: (path) => readdirSync(path).sort(),
        runCommand: ({ command, args, cwd, timeoutMs }) => {
            /*
             * 쉘을 거치지 않는다. 프로그램 이름과 인자를 그대로 넘기므로 인용이나
             * 치환이 끼어들 자리가 없다. 환경은 이 프로세스의 것 — 계획이 정한
             * 그대로이고 provider 의 자격은 애초에 여기에 없다.
             */
            const outcome = spawnSync(command, args, {
                cwd,
                timeout: timeoutMs,
                killSignal: 'SIGKILL',
                encoding: 'utf8',
                maxBuffer: 8 * 1024 * 1024,
            });
            return {
                code: outcome.status,
                stdout: outcome.stdout ?? '',
                stderr: outcome.stderr ?? '',
            };
        },
    };
}

export function runToolWorkloadCall(raw: string, deps: ToolWorkloadDeps): BrokerToolResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, code: 'execution-failed' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, code: 'execution-failed' };
    }
    const call = parsed as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== 'string') return { ok: false, code: 'tool-unavailable' };
    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : {};
    return handleToolCall({ name: call.name, arguments: args } as BrokerToolCall, deps);
}
