/*
 * codex provider 프로세스(fixture 범위).
 *
 * 제품에는 app-server 루프가 없다 — production 에서는 `CodexAppServerClient` 가
 * 소유한다. 여기서는 그 자리에 최소 드라이버를 두고, **제품 함수만** 소비한다:
 *   resolveManagedCodexArguments  … 계획 인자 결속(관리 실행이면 fail-closed)
 *   isManagedBrokerServer         … 이 run 의 broker 호출만 프롬프트 없이 승인
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/usr/local/lib/saycode/');
const product = require('/usr/local/lib/saycode/toolRuntime.cjs');

const record = { cwd: process.cwd(), args: null, approvals: [], notifications: [], turnStatus: null, error: null };

let args;
try {
    // production 의 runCodex 와 같은 호출. B2 인자 자리는 이 fixture 가 채운다.
    args = product.resolveManagedCodexArguments({
        managed: true,
        env: process.env,
        base: JSON.parse(process.env.SAYCODE_FIXTURE_B2_ARGS || '[]'),
    });
    record.args = args;
} catch (error) {
    record.error = String(error && error.message ? error.message : error);
    writeFileSync('/run/provider-result.json', JSON.stringify(record, null, 1));
    process.exit(0);
}

const appServerArgs = args.reduce((acc, arg, index) => {
    if (arg === '--disable') return acc.concat(['-c', `features.${args[index + 1]}=false`]);
    if (args[index - 1] === '--disable') return acc;
    return acc.concat([arg]);
}, []);

const child = spawn('/usr/local/lib/saycode/codex/bin/codex',
    ['app-server', '--listen', 'stdio://', ...appServerArgs],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });

let buffer = '';
let stderr = '';
let nextId = 0;
const pending = new Map();
child.stderr.on('data', (chunk) => { stderr += String(chunk); });
child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.method === 'string') {
            record.notifications.push(message.method);
            if (message.method === 'turn/completed') {
                record.turnStatus = message.params?.turn?.status ?? 'unknown';
            }
            if (/elicitation|approval/i.test(message.method) && typeof message.id === 'number') {
                // production 승인 경로와 같은 판정: 이 run 의 broker 인가.
                const serverName = message.params?.serverName;
                const ours = product.isManagedBrokerServer({
                    managed: true, env: process.env, serverName,
                });
                record.approvals.push({ serverName, ours });
                if (ours) {
                    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: {} } })}\n`);
                }
                // 우리 것이 아니면 답하지 않는다 — production 에서는 사용자 경로로 간다.
            }
            continue;
        }
        if (typeof message.id === 'number' && pending.has(message.id) && ('result' in message || 'error' in message)) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            message.error ? waiter.reject(new Error('refused')) : waiter.resolve(message.result);
        }
    }
});
const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} was never answered`)); }, 60_000);
    pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

try {
    await call('initialize', {
        clientInfo: { name: 'p4-fixture', title: 'P4 fixture', version: '0.0.0' },
        capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const thread = await call('thread/start', {
        model: process.env.SAYCODE_PROVIDER_MODEL || null, modelProvider: null, profile: null,
        cwd: process.cwd(), approvalPolicy: 'on-request', sandbox: 'workspace-write', config: {},
        baseInstructions: null, developerInstructions: null, compactPrompt: null,
        includeApplyPatchTool: null, experimentalRawEvents: false, persistExtendedHistory: true,
    });
    const threadId = thread?.thread?.id;
    if (typeof threadId !== 'string' || threadId === '') throw new Error('thread/start gave no thread id');
    await call('turn/start', { threadId, input: [{ type: 'text', text: 'read the report' }] });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && record.turnStatus === null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
} catch (error) {
    record.error = product.sanitizeProviderFailure(error);
}
record.stderr = stderr.slice(-400);
writeFileSync('/run/provider-result.json', JSON.stringify(record, null, 1));
child.kill('SIGKILL');
process.exit(0);
