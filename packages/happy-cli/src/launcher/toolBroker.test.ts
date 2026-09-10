import { request as httpRequest } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
    BROKER_FAILURE_CODES,
    MAX_BROKER_REQUEST_BYTES,
    authorizeBrokerCall,
    createToolBroker,
    handleBrokerMessage,
    mintBrokerGrant,
    readBearer,
    type ToolBrokerDeps,
} from './toolBroker';

const TOOLS = [{
    name: 'workspace_read',
    description: 'read a file in the workspace',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}];

const GRANT = mintBrokerGrant({ scope: ['workspace_read'], expiresMonotonic: 60_000 });
const AUTH = `Bearer ${GRANT.token}`;

function deps(over: Partial<ToolBrokerDeps> = {}): ToolBrokerDeps {
    return {
        tools: TOOLS,
        execute: vi.fn(async () => ({ ok: true as const, content: 'file contents' })),
        grant: () => GRANT,
        monotonicNow: () => 1_000,
        ...over,
    };
}

describe('tool broker', () => {
    it('advertises only the tools it was given', async () => {
        const outcome = await handleBrokerMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps(), AUTH);
        expect(outcome).toEqual({ result: { tools: TOOLS } });
    });

    it('hands an advertised call to the executor and returns its content', async () => {
        const d = deps();
        const outcome = await handleBrokerMessage({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'workspace_read', arguments: { path: 'a.txt' } },
        }, d, AUTH);
        expect(d.execute).toHaveBeenCalledWith({ name: 'workspace_read', arguments: { path: 'a.txt' } });
        expect(outcome).toEqual({ result: { content: [{ type: 'text', text: 'file contents' }] } });
    });

    it('never runs a tool it did not advertise', async () => {
        const d = deps();
        const outcome = await handleBrokerMessage({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'exec_command', arguments: { cmd: 'rm -rf /' } },
        }, d, AUTH);
        // 이름을 지어내 executor 를 부르는 경로가 있으면 broker 는 경계가 아니다.
        // 자격 검사(scope)와 등록 검사 어느 쪽에서 걸리든 **실행되지 않는 것**이 계약이다.
        expect(d.execute).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ error: expect.anything() });
    });

    it('reports a failure as a fixed code, never the underlying text', async () => {
        const outcome = await handleBrokerMessage({
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'workspace_read', arguments: {} },
        }, deps({
            execute: async () => ({ ok: false, code: 'workspace-denied' }),
        }), AUTH);
        expect(JSON.stringify(outcome)).toContain('workspace-denied');
        expect(JSON.stringify(outcome)).not.toMatch(/at .*\.ts:\d+/);
    });

    it('answers initialize and stays quiet on notifications', async () => {
        expect(await handleBrokerMessage({ jsonrpc: '2.0', id: 5, method: 'initialize' }, deps(), AUTH))
            .toMatchObject({ result: { capabilities: { tools: {} } } });
        expect(await handleBrokerMessage(
            { jsonrpc: '2.0', method: 'notifications/initialized' }, deps(), AUTH,
        )).toBeNull();
    });

    it('refuses malformed messages without throwing', async () => {
        for (const message of [null, 'string', [], { jsonrpc: '2.0', id: 1, method: 'nope' }]) {
            const outcome = await handleBrokerMessage(message, deps(), AUTH);
            expect(outcome).toMatchObject({ error: expect.anything() });
        }
        expect(await handleBrokerMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } }, deps(), AUTH,
        )).toMatchObject({ error: { code: -32602 } });
    });

    it('bounds the request body', () => {
        expect(MAX_BROKER_REQUEST_BYTES).toBe(1024 * 1024);
    });
});

describe('broker authorization', () => {
    const base = { grant: () => GRANT, monotonicNow: () => 1_000 };

    it('refuses a call with no bearer — loopback is not authorization', async () => {
        // 같은 호스트의 다른 프로세스도 loopback 에 붙는다. tool executor 도 그중 하나다.
        const d = deps();
        expect(await handleBrokerMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, d))
            .toMatchObject({ error: { code: -32001, message: 'missing-token' } });
        expect(d.execute).not.toHaveBeenCalled();
    });

    it('refuses a wrong bearer and does not leak length through a throw', () => {
        expect(authorizeBrokerCall({ header: 'Bearer nope', toolName: null, deps: base }))
            .toEqual({ ok: false, reason: 'bad-token' });
        expect(authorizeBrokerCall({ header: 42, toolName: null, deps: base }))
            .toEqual({ ok: false, reason: 'missing-token' });
        expect(readBearer(['Bearer a', 'Bearer b'])).toBeNull();
    });

    it('refuses an expired grant', () => {
        expect(authorizeBrokerCall({
            header: AUTH, toolName: null,
            deps: { grant: () => GRANT, monotonicNow: () => 60_000 },
        })).toEqual({ ok: false, reason: 'grant-expired' });
    });

    it('refuses a revoked grant immediately', () => {
        expect(authorizeBrokerCall({
            header: AUTH, toolName: null, deps: { grant: () => null, monotonicNow: () => 1_000 },
        })).toEqual({ ok: false, reason: 'grant-revoked' });
    });

    it('refuses a tool that is registered but outside this run\'s scope', async () => {
        const narrow = mintBrokerGrant({ scope: [], expiresMonotonic: 60_000 });
        const d = deps({ grant: () => narrow });
        const outcome = await handleBrokerMessage({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'workspace_read', arguments: {} },
        }, d, `Bearer ${narrow.token}`);
        expect(outcome).toMatchObject({ error: { code: -32001, message: 'out-of-scope' } });
        expect(d.execute).not.toHaveBeenCalled();
    });

    it('even tools/list needs the grant — the registry itself is information', async () => {
        expect(await handleBrokerMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps(), 'Bearer x'))
            .toMatchObject({ error: { code: -32001 } });
    });

    it('a failure code outside the fixed list becomes a fixed one', async () => {
        const outcome = await handleBrokerMessage({
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'workspace_read', arguments: {} },
        }, deps({
            // executor 가 오류 원문을 code 에 넣어도 그대로 나가지 않는다.
            execute: async () => ({ ok: false, code: 'ENOENT: /run/saycode/session.key at fs.js:123' }),
        }), AUTH);
        expect(JSON.stringify(outcome)).not.toContain('session.key');
        expect(JSON.stringify(outcome)).toContain('execution-failed');
        expect([...BROKER_FAILURE_CODES]).toContain('execution-failed');
    });

    it('each run gets a different token', () => {
        const a = mintBrokerGrant({ scope: ['t'], expiresMonotonic: 1 });
        const b = mintBrokerGrant({ scope: ['t'], expiresMonotonic: 1 });
        expect(a.token).not.toBe(b.token);
        expect(a.token.length).toBeGreaterThanOrEqual(43);
    });
});

describe('broker request framing', () => {
    it('reassembles a multibyte body split across chunk boundaries', async () => {
        const executed: string[] = [];
        const grant = mintBrokerGrant({ scope: ['read_file'], expiresMonotonic: 1000 });
        const broker = createToolBroker({
            tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
            execute: async (call) => {
                executed.push(String((call.arguments as { path?: unknown }).path));
                return { ok: true, content: 'ok' };
            },
            grant: () => grant,
            monotonicNow: () => 0,
        });
        const port = await broker.listen(0);
        // 한글 경로. UTF-8 로 3 바이트라 chunk 경계가 글자 가운데를 가른다.
        const payload = Buffer.from(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'read_file', arguments: { path: '문서/보고서.md' } },
        }), 'utf8');
        await new Promise<void>((resolve, reject) => {
            const request = httpRequest(
                { host: '127.0.0.1', port, method: 'POST', path: '/', headers: { authorization: `Bearer ${grant.token}` } },
                (response) => { response.resume(); response.on('end', () => resolve()); },
            );
            request.on('error', reject);
            // 글자 가운데에서 자른다.
            const split = payload.indexOf(Buffer.from('문서', 'utf8')) + 1;
            request.write(payload.subarray(0, split));
            setTimeout(() => request.end(payload.subarray(split)), 10);
        });
        await broker.close();
        expect(executed).toEqual(['문서/보고서.md']);
    });
});
