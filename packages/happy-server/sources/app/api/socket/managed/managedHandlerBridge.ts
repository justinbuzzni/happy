/**
 * Runs the server's real session handlers behind the managed gate.
 *
 * The effects a managed child needs — session activity, streams, metadata and
 * state updates, usage — already exist in `sessionUpdateHandler`,
 * `usageHandler` and `pingHandler`, and they are what other clients see. A
 * managed-only reimplementation would be a second set of rules to keep in step
 * with the first, and the one that fell behind would be the one a child used.
 *
 * So those handlers are registered against a facade rather than the socket.
 * The facade captures what they subscribe to; nothing they registered is
 * reachable from the wire. The managed server authorises an inbound event
 * first and only then hands it to the captured handler, so the gate cannot be
 * bypassed by a handler that happens to listen for something.
 *
 * The facade's own `emit` goes through the outbound channel, so anything a
 * handler sends back — including an acknowledgement — crosses the same
 * boundary as any other packet.
 */

import type { Socket } from 'socket.io';

import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { usageHandler } from '@/app/api/socket/usageHandler';
import { pingHandler } from '@/app/api/socket/pingHandler';
import type { ClientConnection } from '@/app/events/eventRouter';
import type { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';

export type ManagedHandlerBridge = {
    /** Whether any real handler subscribed to this event. */
    handles: (event: string) => boolean;
    /** Runs the real handler, if there is one. */
    dispatch: (event: string, payload: unknown, callback?: (response: unknown) => void) => void;
};

export function createManagedHandlerBridge(input: {
    userId: string;
    sessionId: string;
    socketId: string;
    channel: ManagedOutboundChannel;
}): ManagedHandlerBridge {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();

    const facade = {
        id: input.socketId,
        data: {} as Record<string, unknown>,
        handshake: { auth: {}, headers: {} },
        rooms: new Set<string>(),
        on(event: string, handler: (...args: unknown[]) => unknown) {
            handlers.set(event, handler);
            return facade;
        },
        // Anything a handler sends is a packet like any other.
        emit(event: string, ...args: unknown[]) {
            input.channel.enqueue({ event, args });
            return true;
        },
        join() { /* managed sockets are in no rooms; see managedSocketRegistry */ },
        leave() { /* as above */ },
        disconnect() {
            input.channel.close({ kind: 'disconnected' });
        },
    } as unknown as Socket;

    const connection: ClientConnection = {
        connectionType: 'session-scoped',
        socket: facade,
        userId: input.userId,
        sessionId: input.sessionId,
    };

    sessionUpdateHandler(input.userId, facade, connection);
    usageHandler(input.userId, facade);
    pingHandler(facade);

    return {
        handles: (event) => handlers.has(event),
        dispatch: (event, payload, callback) => {
            const handler = handlers.get(event);
            if (!handler) return;
            // Socket.IO calls a handler with the arguments the client sent,
            // acknowledgement last. `ping` is sent with only a callback, and
            // `pingHandler` is written to receive exactly that — inserting an
            // undefined payload in front would leave it answering nobody.
            if (payload === undefined) {
                if (callback) handler(callback);
                else handler();
                return;
            }
            // A payload-bearing handler is written against Socket.IO, where an
            // acknowledgement is optional on the wire but present as an
            // argument. `sessionUpdateHandler` calls it unguarded on its
            // success and version-mismatch paths, so a child that sends
            // `update-metadata` without one makes the handler throw *after* the
            // write — swallowed by its own catch, leaving a state change that
            // reports as a failure to nobody.
            //
            // The stand-in is local and does nothing. The real callback, when
            // there is one, is passed through untouched: it is already the
            // channel-gated reply, and replacing it would take the answer off
            // the boundary that checks the grant.
            handler(payload, callback ?? (() => { /* the child asked for no answer */ }));
        },
    };
}
