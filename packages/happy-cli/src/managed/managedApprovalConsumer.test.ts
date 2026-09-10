/**
 * What the child actually does with an answer relayed from a browser.
 *
 * The managed approval route on the server hands a packet to the run's socket
 * and reports what it did. Whether that packet is *usable* is decided here, on
 * the consumer side, by two real objects: `RpcHandlerManager`, which decodes
 * and decrypts, and `PermissionHandler`, which owns the pending request and
 * resolves it.
 *
 * This is a contract test between two packages. It is written from the wire
 * shape rather than by importing the server: what it asserts is that a packet
 * of exactly the shape the route emits is consumed, and that the shape the
 * route emitted *before* — an object where the ciphertext belongs — is not.
 * The delivery layer could not tell the difference, because the child answers
 * an encrypted error just as readily as an encrypted result.
 */
import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { decrypt, encrypt, decodeBase64, encodeBase64 } from '@/api/encryption';
import { PermissionHandler } from '@/claude/utils/permissionHandler';

const KEY = new Uint8Array(32).fill(7);
const VARIANT = 'dataKey' as const;
const SESSION = 'session-under-test';

/** The session surface `PermissionHandler` actually touches. */
function fakeSession() {
    let agentState: Record<string, unknown> = {};
    return {
        client: {
            sessionId: SESSION,
            getMetadata: () => ({}),
            updateAgentState: (update: (state: Record<string, unknown>) => Record<string, unknown>) => {
                agentState = update(agentState);
            },
        },
        api: { push: () => ({ sendSessionNotification: () => {} }) },
        state: () => agentState,
    };
}

function harness() {
    const session = fakeSession();
    const manager = new RpcHandlerManager({
        scopePrefix: SESSION,
        encryptionKey: KEY,
        encryptionVariant: VARIANT,
        logger: () => {},
    });
    // The real consumer registers itself on construction.
    const permissions = new PermissionHandler({
        ...session,
        client: { ...session.client, rpcHandlerManager: manager },
    } as never);
    return { manager, permissions, session };
}

/** Exactly what the managed route sends: the sealed payload, base64, as `params`. */
function sealed(response: unknown): string {
    return encodeBase64(encrypt(KEY, VARIANT, response));
}

function open(result: unknown): unknown {
    return decrypt(KEY, VARIANT, decodeBase64(result as string));
}

describe('an answer relayed from a browser, as the child receives it', () => {
    it('resolves the pending request it names', async () => {
        const { manager, permissions } = harness();
        const controller = new AbortController();
        const decision = permissions.handleToolCall(
            'Bash',
            { command: 'ls' },
            { mode: 'default' } as never,
            { signal: controller.signal, toolUseID: 'toolu_1' },
        );
        // Let the handler register its pending request before answering it.
        await new Promise((resolve) => setImmediate(resolve));

        const answered = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_1', approved: true }),
            requestId: 'call-1',
        } as never);

        // The tool call actually proceeds — the answer was consumed, not merely
        // acknowledged.
        await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
        // And what comes back is an encrypted response, which is what the route
        // hands to the browser untouched.
        expect(typeof answered).toBe('string');
        expect(open(answered)).not.toMatchObject({ error: expect.anything() });
    });

    it('rejects the tool call when the answer denies it', async () => {
        const { manager, permissions } = harness();
        const controller = new AbortController();
        const decision = permissions.handleToolCall(
            'Bash',
            { command: 'rm -rf /' },
            { mode: 'default' } as never,
            { signal: controller.signal, toolUseID: 'toolu_2' },
        );
        await new Promise((resolve) => setImmediate(resolve));

        await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_2', approved: false, reason: 'no' }),
            requestId: 'call-2',
        } as never);

        await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('answers an error — not a refusal the caller can see — when params is an object', async () => {
        /*
         * The shape the route used to send: `{ id, response }` assembled by the
         * server. `handleRequest` calls `decodeBase64` on it, which throws, and
         * the manager turns that into an **encrypted error response**.
         *
         * That response is a perfectly good acknowledgement. The delivery layer
         * saw a defined answer and reported success, so the person was told
         * their approval went through while the child had consumed nothing.
         */
        const { manager, permissions } = harness();
        const controller = new AbortController();
        const decision = permissions.handleToolCall(
            'Bash',
            { command: 'ls' },
            { mode: 'default' } as never,
            { signal: controller.signal, toolUseID: 'toolu_3' },
        );
        await new Promise((resolve) => setImmediate(resolve));

        const answered = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: { id: 'toolu_3', response: 'sealed-answer' },
            requestId: 'call-3',
        } as never);

        // It acknowledged, and it acknowledged an error.
        expect(typeof answered).toBe('string');
        expect(open(answered)).toMatchObject({ error: expect.any(String) });

        // The tool call is still waiting: nothing was applied.
        const settled = await Promise.race([
            decision.then(() => 'settled'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
        ]);
        expect(settled).toBe('pending');
        controller.abort();
        await decision.catch(() => undefined);
    });

    it('says whether it applied the answer, and why not when it did not', async () => {
        /*
         * The fact only the child knows.
         *
         * Everything between here and the browser is a relay: the server holds
         * no key to this session and cannot look inside the answer, so
         * "delivered" is the strongest thing it can say. Whether the run acted
         * on it has to travel inside the sealed response, or the person is told
         * their approval went through while the tool call sits waiting.
         */
        const { manager, permissions } = harness();
        const controller = new AbortController();
        const decision = permissions.handleToolCall(
            'Bash',
            { command: 'ls' },
            { mode: 'default' } as never,
            { signal: controller.signal, toolUseID: 'toolu_5' },
        );
        await new Promise((resolve) => setImmediate(resolve));

        const applied = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_5', approved: true }),
            requestId: 'call-5',
        } as never);
        expect(open(applied)).toEqual({ applied: true });
        await expect(decision).resolves.toMatchObject({ behavior: 'allow' });

        // The same id again: already answered, and said so.
        const again = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_5', approved: true }),
            requestId: 'call-6',
        } as never);
        expect(open(again)).toEqual({ applied: false, reason: 'already-answered' });

        // An id nobody ever asked about.
        const unknown = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_never', approved: true }),
            requestId: 'call-7',
        } as never);
        expect(open(unknown)).toEqual({ applied: false, reason: 'unknown-request' });
    });

    it('acknowledges an id nobody is waiting on exactly as it acknowledges a real one', async () => {
        /*
         * The reason the route may not report "answered". An answer for a
         * request that was already resolved, or never open, is dropped inside
         * the handler and still produces a normal encrypted response. Delivery
         * and application are different questions, and only the child can
         * answer the second one.
         */
        const { manager } = harness();
        const answered = await manager.handleRequest({
            method: `${SESSION}:permission`,
            params: sealed({ id: 'toolu_never_asked', approved: true }),
            requestId: 'call-4',
        } as never);
        // Same shape, same status, no error: the transport cannot tell these
        // apart, which is why the child states it in the body instead.
        expect(typeof answered).toBe('string');
        expect(open(answered)).not.toMatchObject({ error: expect.anything() });
    });
});
