import { describe, expect, it } from 'vitest';

import { ManagedSocketRegistry, type ManagedSocketEntry } from '@/app/api/socket/managed/managedSocketRegistry';
import { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';

function entry(over: Partial<ManagedSocketEntry> = {}): ManagedSocketEntry {
    return {
        socketId: `socket-${Math.random()}`,
        accountId: 'account-1',
        sessionId: 'session-1',
        grantId: 'grant-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        channel: new ManagedOutboundChannel(
            { emit: () => true, disconnect: () => undefined },
            async () => ({ ok: true }),
        ),
        rpcNames: new Set<string>(),
        connectedAt: 0,
        ...over,
    };
}

describe('managed socket registry', () => {
    it('finds sockets by session and forgets them on removal', () => {
        const registry = new ManagedSocketRegistry();
        const a = entry({ socketId: 'a' });
        registry.add(a);
        expect(registry.forSession('session-1')).toEqual([a]);
        registry.remove('a');
        expect(registry.forSession('session-1')).toEqual([]);
        expect(registry.size).toBe(0);
    });

    it('holds more than one socket for a session', () => {
        const registry = new ManagedSocketRegistry();
        registry.add(entry({ socketId: 'a' }));
        registry.add(entry({ socketId: 'b' }));
        // A reconnect leaves the previous socket present until engine.io gives
        // up on it, so both must be addressable.
        expect(registry.forSession('session-1')).toHaveLength(2);
        registry.remove('a');
        expect(registry.forSession('session-1').map((e) => e.socketId)).toEqual(['b']);
    });

    it('keeps sessions apart', () => {
        const registry = new ManagedSocketRegistry();
        registry.add(entry({ socketId: 'a', sessionId: 'session-1' }));
        registry.add(entry({ socketId: 'b', sessionId: 'session-2' }));
        expect(registry.forSession('session-1').map((e) => e.socketId)).toEqual(['a']);
        expect(registry.forSession('session-2').map((e) => e.socketId)).toEqual(['b']);
    });

    it('answers nothing for a session it does not hold', () => {
        const registry = new ManagedSocketRegistry();
        // Absence is the answer the caller needs to choose between relaying
        // and refusing; it must not be confused with a delivery.
        expect(registry.forSession('elsewhere')).toEqual([]);
        expect(registry.forRpc('elsewhere', 'permission')).toEqual([]);
    });

    it('addresses RPC targets by exact registered name', () => {
        const registry = new ManagedSocketRegistry();
        registry.add(entry({ socketId: 'a', rpcNames: new Set(['permission', 'bash']) }));
        registry.add(entry({ socketId: 'b', rpcNames: new Set(['bash']) }));
        expect(registry.forRpc('session-1', 'permission').map((e) => e.socketId)).toEqual(['a']);
        expect(registry.forRpc('session-1', 'bash')).toHaveLength(2);
        expect(registry.forRpc('session-1', 'steer')).toEqual([]);
    });

    it('removing an unknown socket is not an error', () => {
        const registry = new ManagedSocketRegistry();
        registry.add(entry({ socketId: 'a' }));
        registry.remove('never-added');
        expect(registry.size).toBe(1);
    });
});
