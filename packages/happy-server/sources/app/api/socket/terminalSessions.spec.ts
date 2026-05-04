import { describe, it, expect, beforeEach } from 'vitest';
import { Socket } from 'socket.io';
import {
    addTerminalSession,
    getTerminalSession,
    removeTerminalSession,
    findTerminalSessionsBySocket,
    countActiveSessionsForUser,
    _resetTerminalSessionsForTest,
} from './terminalSessions';

function fakeSocket(): Socket {
    return {} as unknown as Socket;
}

describe('terminalSessions', () => {
    beforeEach(() => {
        _resetTerminalSessionsForTest();
    });

    it('add/get round-trips a session by id', () => {
        const client = fakeSocket();
        const daemon = fakeSocket();
        addTerminalSession({
            id: 's1',
            userId: 'u1',
            machineId: 'm1',
            clientSocket: client,
            daemonSocket: daemon,
            createdAt: 1000,
        });
        const got = getTerminalSession('s1');
        expect(got).not.toBeNull();
        expect(got!.userId).toBe('u1');
        expect(got!.machineId).toBe('m1');
        expect(got!.clientSocket).toBe(client);
        expect(got!.daemonSocket).toBe(daemon);
    });

    it('getTerminalSession returns null for unknown / missing id', () => {
        expect(getTerminalSession('nope')).toBeNull();
        expect(getTerminalSession(undefined)).toBeNull();
        expect(getTerminalSession(null)).toBeNull();
        expect(getTerminalSession('')).toBeNull();
    });

    it('removeTerminalSession reports whether the entry existed', () => {
        addTerminalSession({
            id: 's1', userId: 'u1', machineId: 'm1',
            clientSocket: fakeSocket(), daemonSocket: fakeSocket(), createdAt: 1,
        });
        expect(removeTerminalSession('s1')).toBe(true);
        expect(removeTerminalSession('s1')).toBe(false);
        expect(getTerminalSession('s1')).toBeNull();
    });

    it('findTerminalSessionsBySocket matches both client and daemon side', () => {
        const client = fakeSocket();
        const daemon = fakeSocket();
        const otherDaemon = fakeSocket();
        addTerminalSession({
            id: 's1', userId: 'u1', machineId: 'm1',
            clientSocket: client, daemonSocket: daemon, createdAt: 1,
        });
        addTerminalSession({
            id: 's2', userId: 'u1', machineId: 'm2',
            clientSocket: client, daemonSocket: otherDaemon, createdAt: 2,
        });
        addTerminalSession({
            id: 's3', userId: 'u2', machineId: 'm3',
            clientSocket: fakeSocket(), daemonSocket: fakeSocket(), createdAt: 3,
        });

        const fromClient = findTerminalSessionsBySocket(client);
        expect(fromClient.map(s => s.id).sort()).toEqual(['s1', 's2']);

        const fromDaemon = findTerminalSessionsBySocket(daemon);
        expect(fromDaemon.map(s => s.id)).toEqual(['s1']);

        const fromUnrelated = findTerminalSessionsBySocket(fakeSocket());
        expect(fromUnrelated).toEqual([]);
    });

    it('countActiveSessionsForUser counts only that user', () => {
        addTerminalSession({
            id: 's1', userId: 'u1', machineId: 'm1',
            clientSocket: fakeSocket(), daemonSocket: fakeSocket(), createdAt: 1,
        });
        addTerminalSession({
            id: 's2', userId: 'u1', machineId: 'm2',
            clientSocket: fakeSocket(), daemonSocket: fakeSocket(), createdAt: 2,
        });
        addTerminalSession({
            id: 's3', userId: 'u2', machineId: 'm3',
            clientSocket: fakeSocket(), daemonSocket: fakeSocket(), createdAt: 3,
        });

        expect(countActiveSessionsForUser('u1')).toBe(2);
        expect(countActiveSessionsForUser('u2')).toBe(1);
        expect(countActiveSessionsForUser('u3')).toBe(0);
    });
});
