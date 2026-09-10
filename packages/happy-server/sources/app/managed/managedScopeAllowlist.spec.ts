import { describe, expect, it } from 'vitest';

import {
    MANAGED_SCOPE_SURFACE,
    authorizeManagedHttpRequest,
    authorizeManagedRpcName,
    authorizeManagedSocketEvent,
} from '@/app/managed/managedScopeAllowlist';

/**
 * Pure: no database, no environment. The point of these cases is that a change
 * widening what a managed child can reach has to be written down here first.
 */

const SID = 'session-under-grant';
const OTHER = 'someone-elses-session';

const allow = { ok: true };
const denied = (reason: string) => ({ ok: false, reason });

function http(method: string, path: string, body?: unknown) {
    return authorizeManagedHttpRequest({ method, path, sessionId: SID, body,
            purpose: 'runner' as const,
        });
}

describe('HTTP surface', () => {
    it('allows exactly the routes a managed session consumes', () => {
        expect(http('GET', `/v3/sessions/${SID}/messages`)).toEqual(allow);
        expect(http('POST', `/v3/sessions/${SID}/messages`)).toEqual(allow);
        expect(http('GET', `/v3/sessions/${SID}/events`)).toEqual(allow);
        expect(http('POST', `/v1/sessions/${SID}/attachments/request-upload`)).toEqual(allow);
        expect(http('POST', `/v1/sessions/${SID}/attachments/request-download`)).toEqual(allow);
        expect(http('PUT', `/v1/sessions/${SID}/attachments/file-1`)).toEqual(allow);
        expect(http('GET', `/v1/sessions/${SID}/attachments/file-1`)).toEqual(allow);
    });

    it('keeps a query string out of the routing decision', () => {
        expect(http('GET', `/v3/sessions/${SID}/messages?after_seq=2&limit=50`)).toEqual(allow);
    });

    it('refuses to let a child create another session', () => {
        // The one route that would turn a scoped bearer into an account bearer
        // in effect: a session it creates is a session nothing has scoped.
        expect(http('POST', '/v1/sessions')).toEqual(denied('route-not-allowed'));
        expect(http('POST', '/v2/sessions')).toEqual(denied('route-not-allowed'));
    });

    it('refuses another session on an allowed route shape', () => {
        expect(http('GET', `/v3/sessions/${OTHER}/messages`)).toEqual(denied('session-mismatch'));
        expect(http('PUT', `/v1/sessions/${OTHER}/attachments/file-1`))
            .toEqual(denied('session-mismatch'));
    });

    it('refuses a method that is not listed for an allowed path', () => {
        // POST on the events path writes session events; no managed consumer
        // needs it, so sharing the path does not carry it in.
        expect(http('POST', `/v3/sessions/${SID}/events`)).toEqual(denied('method-not-allowed'));
        expect(http('DELETE', `/v3/sessions/${SID}/messages`)).toEqual(denied('method-not-allowed'));
    });

    it('accepts the method case-insensitively', () => {
        expect(http('get', `/v3/sessions/${SID}/messages`)).toEqual(allow);
    });

    it('does not extend an allowed prefix to paths under it', () => {
        // A prefix rule would accept every one of these.
        expect(http('GET', `/v3/sessions/${SID}/messages/extra`)).toEqual(denied('route-not-allowed'));
        expect(http('POST', `/v1/sessions/${SID}/attachments/request-upload/again`))
            .toEqual(denied('route-not-allowed'));
        expect(http('GET', `/v3/sessions/${SID}`)).toEqual(denied('route-not-allowed'));
    });

    it('refuses an encoded traversal instead of resolving it', () => {
        expect(http('GET', `/v3/sessions/${SID}/%2e%2e`)).toEqual(denied('malformed-path'));
        expect(http('GET', `/v3/sessions/${SID}/%zz`)).toEqual(denied('malformed-path'));
    });

    it('matches a percent-encoded session id by its decoded value', () => {
        expect(authorizeManagedHttpRequest({
            method: 'GET', path: '/v3/sessions/a%20b/messages', sessionId: 'a b',
            purpose: 'runner' as const,
        })).toEqual(allow);
    });
});

describe('session lookup', () => {
    it('allows a lookup for exactly the granted session', () => {
        expect(http('POST', '/v2/sessions/lookup', { ids: [SID] })).toEqual(allow);
    });

    it('refuses a lookup that reaches wider than the grant', () => {
        // This route takes its scope from the body, so a path check alone would
        // hand a child every session on the account.
        expect(http('POST', '/v2/sessions/lookup', { ids: [SID, OTHER] }))
            .toEqual(denied('lookup-scope-too-broad'));
        expect(http('POST', '/v2/sessions/lookup', { ids: [OTHER] }))
            .toEqual(denied('lookup-scope-too-broad'));
        expect(http('POST', '/v2/sessions/lookup', { ids: [] }))
            .toEqual(denied('lookup-scope-too-broad'));
        expect(http('POST', '/v2/sessions/lookup', {}))
            .toEqual(denied('lookup-scope-too-broad'));
        expect(http('POST', '/v2/sessions/lookup', undefined))
            .toEqual(denied('lookup-scope-too-broad'));
    });
});

describe('socket events', () => {
    function event(name: string, payload: unknown) {
        return authorizeManagedSocketEvent({ event: name, payload, sessionId: SID,
            purpose: 'runner' as const,
        });
    }

    it('allows the volatile session events a running agent emits', () => {
        // Without these a running child looks alive to nobody and streams
        // nothing, which is indistinguishable from a hung session.
        expect(event('session-stream', { sid: SID, time: 1, data: 'x' })).toEqual(allow);
        expect(event('session-alive', { sid: SID, time: 1 })).toEqual(allow);
        expect(event('session-end', { sid: SID, time: 1 })).toEqual(allow);
        expect(event('update-metadata', { sid: SID, metadata: 'x', expectedVersion: 1 })).toEqual(allow);
        expect(event('update-state', { sid: SID, agentState: 'x', expectedVersion: 1 })).toEqual(allow);
    });

    it('allows usage reporting, which carries its session under another name', () => {
        expect(event('usage-report', { sessionId: SID, key: 'k' })).toEqual(allow);
        expect(event('provider-usage-report', { sessionId: SID, source: 'happy-cli' })).toEqual(allow);
    });

    it('allows the events that carry no session', () => {
        expect(event('ping', undefined)).toEqual(allow);
        expect(event('rpc-register', { method: `${SID}:permission` })).toEqual(allow);
        expect(event('rpc-unregister', { method: `${SID}:permission` })).toEqual(allow);
    });

    it('refuses an event naming another session', () => {
        expect(event('session-stream', { sid: OTHER, time: 1, data: 'x' }))
            .toEqual(denied('session-mismatch'));
        expect(event('usage-report', { sessionId: OTHER })).toEqual(denied('session-mismatch'));
        expect(event('update-state', {})).toEqual(denied('session-mismatch'));
    });

    it('refuses machine and account events outright', () => {
        for (const name of [
            'machine-alive', 'machine-update-metadata', 'machine-update-state',
            'access-key-get', 'artifact-create', 'artifact-update', 'artifact-delete',
            'terminal-open', 'terminal-frame', 'app-state',
        ]) {
            expect(event(name, { sid: SID }), name).toEqual(denied('event-not-allowed'));
        }
    });
});

describe('RPC names', () => {
    function rpc(method: string) {
        return authorizeManagedRpcName({ method, sessionId: SID,
            purpose: 'runner' as const,
        });
    }

    it('allows the session lifecycle handlers Claude and Codex register', () => {
        for (const name of ['permission', 'abort', 'goal-action', 'killSession', 'mcp-reconnect']) {
            expect(rpc(`${SID}:${name}`), name).toEqual(allow);
        }
    });

    it('refuses steering, which is an instruction no admission covered', () => {
        // Steering injects free text into the turn already running. Unlike
        // `goal-action`, where clearing removes an instruction and only setting
        // one is refused by the child that can read the parameters, the name
        // carries no sub-mode that could be allowed on its own.
        expect(rpc(`${SID}:steer`)).not.toEqual(allow);
    });

    it('allows the common file and shell handlers a session registers', () => {
        for (const name of [
            'bash', 'readFile', 'readFileChunk', 'writeFile', 'copyFile', 'deleteFile',
            'renameFile', 'ensureDirectory', 'listDirectory', 'getDirectoryTree',
            'ripgrep', 'difftastic',
        ]) {
            expect(rpc(`${SID}:${name}`), name).toEqual(allow);
        }
    });

    it('refuses a name under the right prefix that is not on the list', () => {
        // The prefix alone is not authority: the server joins the room using
        // whatever string it is handed.
        expect(rpc(`${SID}:some-future-rpc`)).toEqual(denied('rpc-name-not-allowed'));
        expect(rpc(`${SID}:managed:spawn`)).toEqual(denied('rpc-name-malformed'));
        expect(rpc(`${SID}:stop-daemon`)).toEqual(denied('rpc-name-not-allowed'));
        expect(rpc(`${SID}:spawn-happy-session`)).toEqual(denied('rpc-name-not-allowed'));
    });

    it('refuses another session prefix, including one that merely starts the same', () => {
        expect(rpc(`${OTHER}:permission`)).toEqual(denied('session-mismatch'));
        expect(rpc(`${SID}-extra:permission`)).toEqual(denied('session-mismatch'));
        expect(rpc('permission')).toEqual(denied('session-mismatch'));
    });

    it('names switch as an undecided capability rather than an unknown method', () => {
        // A real consumer registers it. Refusing it as unknown would read at the
        // child as a bug; this says the managed contract has not been decided.
        expect(rpc(`${SID}:switch`)).toEqual(denied('capability-not-supported'));
    });

    it('refuses an empty name', () => {
        expect(rpc(`${SID}:`)).toEqual(denied('rpc-name-malformed'));
    });
});

describe('the surface is stated, not inferred', () => {
    it('lists no route that creates a session', () => {
        for (const route of MANAGED_SCOPE_SURFACE.routes) {
            expect(route.endsWith('/v1/sessions'), route).toBe(false);
            expect(route.endsWith('/v2/sessions'), route).toBe(false);
        }
    });

    it('keeps every allowed route pinned to the granted session or a fixed path', () => {
        for (const route of MANAGED_SCOPE_SURFACE.routes) {
            const scoped = route.includes('/:sessionId/');
            const fixed = route.endsWith('/v2/sessions/lookup');
            expect(scoped || fixed, route).toBe(true);
        }
    });
});

describe('what each purpose may reach', () => {
    const SESSION = 'session-1';

    it('lets a reader read the transcript, its events and its key envelope', () => {
        // Everything a browser needs to show what was said, and to decrypt it.
        for (const [method, path] of [
            ['GET', `/v3/sessions/${SESSION}/messages`],
            ['GET', `/v3/sessions/${SESSION}/events`],
            ['GET', `/v1/sessions/${SESSION}/attachments/file-1`],
        ] as const) {
            expect(authorizeManagedHttpRequest({
                method, path, sessionId: SESSION, purpose: 'transcript-read',
            })).toEqual({ ok: true });
        }
        expect(authorizeManagedHttpRequest({
            method: 'POST',
            path: '/v2/sessions/lookup',
            sessionId: SESSION,
            // The route takes its scope from the body, and the body names
            // exactly one session — the granted one.
            body: { ids: [SESSION] },
            purpose: 'transcript-read',
        })).toEqual({ ok: true });
    });

    it.each([
        ['posting into the session', 'POST', `/v3/sessions/${SESSION}/messages`],
        ['uploading into it', 'POST', `/v1/sessions/${SESSION}/attachments/request-upload`],
        ['writing an attachment', 'PUT', `/v1/sessions/${SESSION}/attachments/file-1`],
    ])('refuses a reader %s', (_name, method, path) => {
        /*
         * The point of the purpose axis: without it, handing somebody a
         * transcript hands them the ability to act as that session.
         */
        expect(authorizeManagedHttpRequest({
            method, path, sessionId: SESSION, purpose: 'transcript-read',
        })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
    });

    it('leaves a runner exactly as it was', () => {
        // Every bearer minted before this axis existed decodes as a runner, and
        // none of them may change behaviour.
        expect(authorizeManagedHttpRequest({
            method: 'POST', path: `/v3/sessions/${SESSION}/messages`, sessionId: SESSION,
            purpose: 'runner',
        })).toEqual({ ok: true });
    });

    it('lets an approver answer prompts and nothing else', () => {
        expect(authorizeManagedRpcName({
            method: `${SESSION}:permission`, sessionId: SESSION, purpose: 'approval-control',
        })).toEqual({ ok: true });
        for (const name of ['bash', 'writeFile', 'goal-action', 'killSession']) {
            expect(authorizeManagedRpcName({
                method: `${SESSION}:${name}`, sessionId: SESSION, purpose: 'approval-control',
            })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
        }
    });

    it('lets an approver answer over HTTP, and a reader not', () => {
        /*
         * The browser has no managed socket — that server is the run's own
         * connection — so the answer comes over HTTP. It is the approver's one
         * extra route, and a read bearer must not reach it: reading a
         * transcript is not deciding what the run may do.
         */
        const path = `/v1/managed/sessions/${SESSION}/permission`;
        expect(authorizeManagedHttpRequest({
            method: 'POST', path, sessionId: SESSION, purpose: 'approval-control',
        })).toEqual({ ok: true });
        expect(authorizeManagedHttpRequest({
            method: 'POST', path, sessionId: SESSION, purpose: 'transcript-read',
        })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
    });

    it('refuses the run its own permission prompt', () => {
        /*
         * The prompt exists because the run is not trusted to decide. Written
         * as an exception to "not a runner", this route never asked about a
         * runner at all and the run could answer itself over HTTP — with the
         * bearer it already holds, on the session it is already running.
         */
        expect(authorizeManagedHttpRequest({
            method: 'POST',
            path: `/v1/managed/sessions/${SESSION}/permission`,
            sessionId: SESSION,
            purpose: 'runner',
        })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
    });

    it('refuses an approver every write the run itself makes', () => {
        // Approving is not taking the run over.
        for (const [method, path] of [
            ['POST', `/v3/sessions/${SESSION}/messages`],
            ['POST', `/v1/sessions/${SESSION}/attachments/request-upload`],
        ] as const) {
            expect(authorizeManagedHttpRequest({
                method, path, sessionId: SESSION, purpose: 'approval-control',
            })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
        }
    });

    it('lets a reader register nothing', () => {
        expect(authorizeManagedRpcName({
            method: `${SESSION}:permission`, sessionId: SESSION, purpose: 'transcript-read',
        })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
        expect(authorizeManagedSocketEvent({
            event: 'rpc-register', payload: {}, sessionId: SESSION, purpose: 'transcript-read',
        })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
    });

    it('refuses every session event from a non-runner', () => {
        // These report or change what the run is doing. Reading a transcript
        // and approving a prompt are neither.
        for (const purpose of ['transcript-read', 'approval-control'] as const) {
            expect(authorizeManagedSocketEvent({
                event: 'session-stream', payload: { sid: SESSION }, sessionId: SESSION, purpose,
            })).toEqual({ ok: false, reason: 'purpose-not-allowed' });
        }
    });
});
