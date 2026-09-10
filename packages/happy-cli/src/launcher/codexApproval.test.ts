import { describe, expect, it } from 'vitest';

import { CODEX_APPROVAL_ACCEPT, classifyCodexApproval, isManagedBrokerServer } from './codexApproval';

/** 설치본 0.153.4 가 실제로 보낸 요청. 필드 이름을 지어내지 않았다. */
const REAL_REQUEST = {
    threadId: '01a086f5-1ac4-7683-b5dd-d691c0085c50',
    turnId: '01a086f5-1acb-71b0-8809-6e0dd43cb6d5',
    serverName: 'saycode',
    mode: 'form',
    _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_description: 'Read a file from the managed workspace',
        tool_params: { path: '문서/보고서.md' },
        tool_params_display: [{ name: 'path', value: '문서/보고서.md', display_name: 'path' }],
    },
    message: 'Allow the saycode MCP server to run tool "read_file"?',
    requestedSchema: { type: 'object', properties: {} },
};

const SESSION = { serverName: 'saycode', grantValid: true };

describe('codex approval classification', () => {
    it('auto-approves the connection consent for this run’s own broker', () => {
        expect(classifyCodexApproval({ params: REAL_REQUEST, session: SESSION }))
            .toEqual({ kind: 'auto-approve', scopeEnforcedBy: 'broker-grant' });
    });

    it('never persists an approval beyond this run', () => {
        // 요청은 `always` 를 허용하지만 우리는 그 자리를 쓰지 않는다.
        expect(REAL_REQUEST._meta.persist).toContain('always');
        expect(JSON.stringify(CODEX_APPROVAL_ACCEPT)).not.toContain('always');
        expect(CODEX_APPROVAL_ACCEPT).toEqual({ action: 'accept', content: {} });
    });

    it('leaves a real user-input elicitation to the user', () => {
        // 스키마에 항목이 있으면 사람에게 묻는 질문이다.
        expect(classifyCodexApproval({
            params: {
                ...REAL_REQUEST,
                requestedSchema: { type: 'object', properties: { apiKey: { type: 'string' } } },
            },
            session: SESSION,
        })).toEqual({ kind: 'await-user', reason: 'requests-user-input' });
    });

    it('treats any schema that could ask for input as a user question', () => {
        for (const requestedSchema of [
            { type: 'object', properties: {}, required: ['token'] },
            { type: 'object', properties: {}, oneOf: [{ type: 'object' }] },
            { type: 'object', properties: {}, anyOf: [] },
            { type: 'object', properties: {}, allOf: [] },
            { type: 'object', properties: {}, enum: ['a'] },
            { type: 'object', properties: [] },
            { type: 'string' },
            [{ type: 'object', properties: {} }],
            null,
            undefined,
        ]) {
            expect(classifyCodexApproval({
                params: { ...REAL_REQUEST, requestedSchema }, session: SESSION,
            })).toEqual({ kind: 'await-user', reason: 'requests-user-input' });
        }
    });

    it('leaves other approval kinds to the user', () => {
        for (const kind of ['elicitation', 'codex_sensitive_action', undefined]) {
            expect(classifyCodexApproval({
                params: { ...REAL_REQUEST, _meta: { ...REAL_REQUEST._meta, codex_approval_kind: kind } },
                session: SESSION,
            })).toMatchObject({ kind: 'await-user' });
        }
    });

    it('does not consent on behalf of a server this run did not register', () => {
        expect(classifyCodexApproval({
            params: { ...REAL_REQUEST, serverName: 'someone-elses-server' },
            session: SESSION,
        })).toEqual({ kind: 'await-user', reason: 'unknown-server' });
    });

    it('denies once the run’s grant is gone', () => {
        expect(classifyCodexApproval({
            params: REAL_REQUEST, session: { ...SESSION, grantValid: false },
        })).toEqual({ kind: 'deny', reason: 'grant-revoked' });
    });

    it('does not read the tool name out of the human-readable message', () => {
        // 문장을 바꿔도 판정은 같다. 이름에 권위 있는 필드가 없으므로 이 분류는
        // 도구를 고르지 않고, scope 강제는 broker 가 한다.
        const renamed = { ...REAL_REQUEST, message: 'Allow "rm_rf" to run?' };
        expect(classifyCodexApproval({ params: renamed, session: SESSION }))
            .toEqual({ kind: 'auto-approve', scopeEnforcedBy: 'broker-grant' });
    });
});

describe('managed broker approvals in the existing runner', () => {
    const PLAN_ENV = {
        SAYCODE_PROVIDER_CODEX_ARGS: JSON.stringify([
            '-c', 'mcp_servers.saycode.url="http://127.0.0.1:8731/"',
            '-c', 'mcp_servers.saycode.bearer_token_env_var="SAYCODE_BROKER_TOKEN"',
        ]),
    };

    it('recognises this run’s own broker by the name the plan registered', () => {
        expect(isManagedBrokerServer({ managed: true, env: PLAN_ENV, serverName: 'saycode' })).toBe(true);
        expect(isManagedBrokerServer({ managed: true, env: PLAN_ENV, serverName: 'someone-else' })).toBe(false);
        // 서버 이름이 없는 승인(exec/patch 같은 것)은 broker 가 아니다.
        expect(isManagedBrokerServer({ managed: true, env: PLAN_ENV, serverName: undefined })).toBe(false);
    });

    it('claims nothing in a BYOS run or without a plan', () => {
        expect(isManagedBrokerServer({ managed: false, env: PLAN_ENV, serverName: 'saycode' })).toBe(false);
        expect(isManagedBrokerServer({ managed: true, env: {}, serverName: 'saycode' })).toBe(false);
    });
});
