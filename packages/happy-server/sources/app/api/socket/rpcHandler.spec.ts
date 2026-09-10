import { describe, expect, it, vi } from 'vitest';
import { register } from 'prom-client';
import { rpcHandler } from './rpcHandler';

// These cases are about the legacy relay, so the session is not a managed one.
// The handler now asks the database that question before choosing a path, and
// answering it here keeps these cases on the path they are written for.
vi.mock('@/storage/db', () => ({
    db: { managedSessionGrant: { findFirst: async () => null } },
}));

class FakeSocket {
    connected = true;
    timeoutCalls: number[] = [];
    emitted: Array<{ event: string; payload: unknown }> = [];
    handlers = new Map<string, (...args: any[]) => unknown>();

    constructor(readonly id: string) {}

    on(event: string, handler: (...args: any[]) => unknown) {
        this.handlers.set(event, handler);
    }

    emit(event: string, payload: unknown) {
        this.emitted.push({ event, payload });
    }

    timeout(ms: number) {
        this.timeoutCalls.push(ms);
        return {
            emitWithAck: vi.fn(async (_event: string, payload: unknown) => payload),
        };
    }

    async trigger(event: string, ...args: unknown[]) {
        const handler = this.handlers.get(event);
        if (!handler) throw new Error(`missing handler: ${event}`);
        return handler(...args);
    }
}

function fakeIo(targets: FakeSocket[]) {
    return {
        in: vi.fn(() => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => targets),
            })),
        })),
    };
}

function fakeScopedIo(targetsByRoom: Map<string, FakeSocket[]>) {
    return {
        in: vi.fn((room: string) => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => targetsByRoom.get(room) ?? []),
            })),
        })),
    };
}

describe('rpcHandler relay timeout', () => {
    it('uses caller-provided timeoutMs when forwarding rpc-request to the target socket', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        const callback = vi.fn();
        await caller.trigger('rpc-call', {
            method: 'machine-1:bash',
            params: 'encrypted',
            timeoutMs: 330000,
        }, callback);

        expect(target.timeoutCalls).toEqual([330000]);
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { method: 'machine-1:bash', params: 'encrypted' },
        });
    });

    it('keeps the legacy 30s relay timeout when timeoutMs is not provided', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        await caller.trigger('rpc-call', { method: 'machine-1:bash', params: 'encrypted' }, vi.fn());

        expect(target.timeoutCalls).toEqual([30000]);
    });
});

describe('rpcHandler user isolation', () => {
    it('does not relay a reconnect request to another user\'s target', async () => {
        vi.useFakeTimers();
        try {
            const caller = new FakeSocket('caller-user-2');
            const user1Target = new FakeSocket('target-user-1');
            const io = fakeScopedIo(new Map([
                ['rpc:user-1:session-1:mcp-reconnect', [user1Target]],
            ]));
            rpcHandler('user-2', caller as any, io as any);

            const callback = vi.fn();
            const call = caller.trigger('rpc-call', {
                method: 'session-1:mcp-reconnect',
                params: { serverName: 'argos' },
            }, callback);
            await vi.runAllTimersAsync();
            await call;

            expect(user1Target.timeoutCalls).toEqual([]);
            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: 'RPC method not available',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('rpcHandler result metrics', () => {
    it('records an immediate target rejection as failed instead of timeout', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        target.timeout = vi.fn(() => ({
            emitWithAck: vi.fn(async () => { throw new Error('MCP reconnect failed'); }),
        })) as any;
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        const callback = vi.fn();
        await caller.trigger('rpc-call', {
            method: 'session-1:mcp-reconnect',
            params: 'encrypted',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'MCP reconnect failed' });
        expect(await register.metrics()).toContain('rpc_calls_total{method="mcp-reconnect",result="failed"}');
    });
});
