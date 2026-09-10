import { describe, expect, it, vi } from 'vitest';

import {
    MANAGED_RELAY_EVENT,
    deliverManagedLocally,
    deliverManagedSession,
    chooseManagedRpcTarget,
    executeManagedRpcLocally,
    locateManagedRpcTargets,
    MANAGED_RPC_DEADLINE_MS,
    dispatchManagedRpc,
    installManagedRelayReceiver,
} from '@/app/api/socket/managed/managedDelivery';
import { ManagedSocketRegistry } from '@/app/api/socket/managed/managedSocketRegistry';
import { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';

/** Pure: no database, no sockets. */

function registryWith(sockets: Array<{
    socketId: string; sessionId: string; accountId: string;
    grant?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}>) {
    const registry = new ManagedSocketRegistry();
    const emitted: Record<string, Array<{ event: string; args: unknown[] }>> = {};
    for (const socket of sockets) {
        emitted[socket.socketId] = [];
        registry.add({
            socketId: socket.socketId,
            accountId: socket.accountId,
            sessionId: socket.sessionId,
            grantId: `grant-${socket.socketId}`,
            runId: 'run-1',
            attemptId: 'attempt-1',
            rpcNames: new Set<string>(),
            connectedAt: 0,
            channel: new ManagedOutboundChannel(
                {
                    emit: (event, ...args) => { emitted[socket.socketId].push({ event, args }); return true; },
                    disconnect: () => undefined,
                },
                socket.grant ?? (async () => ({ ok: true })),
            ),
        });
    }
    return { registry, emitted };
}

async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

const delivery = { sessionId: 'session-1', accountId: 'account-1', event: 'update', args: [{ seq: 1 }] };

describe('local delivery', () => {
    it('queues for every managed socket of the session', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-1' },
            { socketId: 'b', sessionId: 'session-1', accountId: 'account-1' },
        ]);
        expect(deliverManagedLocally(delivery, registry)).toEqual({ queued: 2 });
        await settle();
        expect(emitted.a).toEqual([{ event: 'update', args: [{ seq: 1 }] }]);
        expect(emitted.b).toEqual([{ event: 'update', args: [{ seq: 1 }] }]);
    });

    it('delivers nothing for another session', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-2', accountId: 'account-1' },
        ]);
        expect(deliverManagedLocally(delivery, registry)).toEqual({ queued: 0 });
        await settle();
        expect(emitted.a).toEqual([]);
    });

    it('refuses a payload naming one session but another account', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-2' },
        ]);
        // The entry's account came from a handshake this replica verified; the
        // payload's is a claim from another process.
        expect(deliverManagedLocally(delivery, registry)).toEqual({ queued: 0 });
        await settle();
        expect(emitted.a).toEqual([]);
    });

    it('still consults the grant on the receiving side', async () => {
        const { registry, emitted } = registryWith([
            {
                socketId: 'a', sessionId: 'session-1', accountId: 'account-1',
                grant: async () => ({ ok: false, reason: 'revoked' }),
            },
        ]);
        // Queued is not delivered: the sender's routing does not authorise.
        expect(deliverManagedLocally(delivery, registry)).toEqual({ queued: 1 });
        await settle();
        expect(emitted.a).toEqual([]);
    });
});

describe('cluster relay', () => {
    it('delivers locally and asks peers to do the same', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-1' },
        ]);
        const serverSideEmit = vi.fn();
        expect(deliverManagedSession({ serverSideEmit } as never, delivery, registry)).toEqual({ queued: 1 });
        await settle();
        expect(emitted.a).toHaveLength(1);
        expect(serverSideEmit).toHaveBeenCalledWith(MANAGED_RELAY_EVENT, delivery);
    });

    it('does not fail the local delivery when the bus is down', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-1' },
        ]);
        const serverSideEmit = vi.fn(() => { throw new Error('bus down'); });
        expect(() => deliverManagedSession({ serverSideEmit } as never, delivery, registry)).not.toThrow();
        await settle();
        expect(emitted.a).toHaveLength(1);
    });

    it('runs the receiving replica*s own delivery, grant check included', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-1' },
            {
                socketId: 'b', sessionId: 'session-1', accountId: 'account-1',
                grant: async () => ({ ok: false, reason: 'revoked' }),
            },
        ]);
        let handler: ((payload: unknown) => void) | null = null;
        installManagedRelayReceiver({ on: (_e: string, fn: never) => { handler = fn; } } as never, registry);
        handler!(delivery);
        await settle();
        expect(emitted.a).toHaveLength(1);
        // The relay did not carry permission with it.
        expect(emitted.b).toEqual([]);
    });

    it('ignores a malformed relay payload', async () => {
        const { registry, emitted } = registryWith([
            { socketId: 'a', sessionId: 'session-1', accountId: 'account-1' },
        ]);
        let handler: ((payload: unknown) => void) | null = null;
        installManagedRelayReceiver({ on: (_e: string, fn: never) => { handler = fn; } } as never, registry);
        for (const bad of [null, 'x', 42, {}, { sessionId: 'session-1' },
            { sessionId: 'session-1', accountId: 'account-1', event: 'update' },
            { sessionId: '', accountId: 'account-1', event: 'update', args: [] }]) {
            handler!(bad);
        }
        await settle();
        expect(emitted.a).toEqual([]);
    });
});

describe('RPC targets exactly one connection', () => {
    function rpcRegistry(sockets: Array<{
        socketId: string; connectedAt: number; rpcNames: string[]; accountId?: string;
    }>) {
        const registry = new ManagedSocketRegistry();
        const emitted: Record<string, Array<{ event: string; args: unknown[] }>> = {};
        for (const socket of sockets) {
            emitted[socket.socketId] = [];
            registry.add({
                socketId: socket.socketId,
                accountId: socket.accountId ?? 'account-1',
                sessionId: 'session-1',
                grantId: `grant-${socket.socketId}`,
                runId: 'run-1',
                attemptId: 'attempt-1',
                rpcNames: new Set(socket.rpcNames),
                connectedAt: socket.connectedAt,
                channel: new ManagedOutboundChannel(
                    {
                        emit: (event, ...args) => { emitted[socket.socketId].push({ event, args }); return true; },
                        disconnect: () => undefined,
                    },
                    async () => ({ ok: true }),
                ),
            });
        }
        return { registry, emitted };
    }

    const request = {
        sessionId: 'session-1', accountId: 'account-1',
        rpcName: 'permission', requestId: 'req-1', params: { id: 7 },
    };

    it('locates only connections that registered the name for this account', () => {
        const { registry } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['permission'] },
            { socketId: 'b', connectedAt: 2, rpcNames: ['bash'] },
            { socketId: 'c', connectedAt: 3, rpcNames: ['permission'], accountId: 'account-2' },
        ]);
        expect(locateManagedRpcTargets(request, registry).map((t) => t.socketId)).toEqual(['a']);
    });

    it('chooses the newest connection, and breaks a tie the same way everywhere', () => {
        expect(chooseManagedRpcTarget([
            { socketId: 'old', connectedAt: 100 },
            { socketId: 'new', connectedAt: 200 },
        ])?.socketId).toBe('new');
        // Every replica sorting the same candidates must pick the same one.
        expect(chooseManagedRpcTarget([
            { socketId: 'bbb', connectedAt: 100 },
            { socketId: 'aaa', connectedAt: 100 },
        ])?.socketId).toBe('aaa');
        expect(chooseManagedRpcTarget([])).toBeNull();
    });

    it('runs on the addressed socket and on no other', async () => {
        const { registry, emitted } = rpcRegistry([
            { socketId: 'old', connectedAt: 100, rpcNames: ['permission'] },
            { socketId: 'new', connectedAt: 200, rpcNames: ['permission'] },
        ]);
        expect(executeManagedRpcLocally(request, 'new', () => {}, registry)).toEqual({ ok: true });
        await settle();
        expect(emitted.new).toHaveLength(1);
        expect(emitted.old).toEqual([]);
    });

    it('refuses to run on a socket that is not the one addressed', () => {
        const { registry } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['permission'] },
        ]);
        // Wrong id, wrong account, wrong method: each is "not this connection".
        expect(executeManagedRpcLocally(request, 'nobody', () => {}, registry))
            .toEqual({ ok: false, reason: 'no-target' });
        expect(executeManagedRpcLocally(
            { ...request, accountId: 'account-2' }, 'a', () => {}, registry,
        )).toEqual({ ok: false, reason: 'no-target' });
        expect(executeManagedRpcLocally(
            { ...request, rpcName: 'bash' }, 'a', () => {}, registry,
        )).toEqual({ ok: false, reason: 'no-target' });
    });

    it('answers the caller when the grant went away instead of leaving it waiting', async () => {
        const registry = new ManagedSocketRegistry();
        registry.add({
            socketId: 'a', accountId: 'account-1', sessionId: 'session-1',
            grantId: 'grant-a', runId: 'run-1', attemptId: 'attempt-1',
            rpcNames: new Set(['permission']), connectedAt: 1,
            channel: new ManagedOutboundChannel(
                { emit: () => true, disconnect: () => undefined },
                async () => ({ ok: false, reason: 'revoked' }),
            ),
        });
        const responses: unknown[] = [];
        expect(executeManagedRpcLocally(request, 'a', (r) => { responses.push(r); }, registry))
            .toEqual({ ok: true });
        await settle();
        expect(responses).toEqual([{
            ok: false, reason: 'unavailable',
            error: 'Managed session grant is no longer valid',
        }]);
    });

    it('carries the correlation id and the prefixed method', async () => {
        const { registry, emitted } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['permission'] },
        ]);
        executeManagedRpcLocally(request, 'a', () => {}, registry);
        await settle();
        expect(emitted.a[0].args[0]).toMatchObject({
            method: 'session-1:permission', requestId: 'req-1', params: { id: 7 },
        });
    });

    it('settles once, on a deadline, when the child never answers', async () => {
        const { registry } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['permission'] },
        ]);
        // The channel released the request; the child simply never replies.
        const result = await dispatchManagedRpc(null, request, registry, { deadlineMs: 60 });
        expect(result).toEqual({ ok: false, reason: 'timeout', error: 'RPC call timed out' });
    });

    it('applies a bounded deadline even when the caller names none', async () => {
        const { registry } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['permission'] },
        ]);
        vi.useFakeTimers();
        try {
            // Taking the managed branch must not mean waiting forever; the
            // legacy path has always had a bound.
            const pending = dispatchManagedRpc(null, request, registry);
            await vi.advanceTimersByTimeAsync(MANAGED_RPC_DEADLINE_MS + 10);
            expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
        } finally {
            vi.useRealTimers();
        }
        expect(MANAGED_RPC_DEADLINE_MS).toBeLessThanOrEqual(60_000);
    });

    it('reports no target rather than trying a different connection', async () => {
        const { registry } = rpcRegistry([
            { socketId: 'a', connectedAt: 1, rpcNames: ['bash'] },
        ]);
        expect(await dispatchManagedRpc(null, request, registry, { deadlineMs: 200 }))
            .toEqual({ ok: false, reason: 'no-target' });
    });

    it('discards an answer that arrives after the deadline', async () => {
        const registry = new ManagedSocketRegistry();
        let release: ((r: unknown) => void) | null = null;
        registry.add({
            socketId: 'a', accountId: 'account-1', sessionId: 'session-1',
            grantId: 'grant-a', runId: 'run-1', attemptId: 'attempt-1',
            rpcNames: new Set(['permission']), connectedAt: 1,
            channel: new ManagedOutboundChannel(
                {
                    emit: (_event, ...args) => { release = args[1] as (r: unknown) => void; return true; },
                    disconnect: () => undefined,
                },
                async () => ({ ok: true }),
            ),
        });
        const result = await dispatchManagedRpc(null, request, registry, { deadlineMs: 60 });
        expect(result).toMatchObject({ ok: false, reason: 'timeout' });
        // A late answer must not resolve anything a second time.
        expect(() => release?.('too late')).not.toThrow();
        await settle();
    });
});
