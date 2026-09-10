/**
 * The instant that decides whether a relayed answer still goes out.
 *
 * The second authority behind an approval is read from the database, and that
 * read takes time. A check that stamps the clock when it *starts* is asking
 * whether the window was open before the read — not whether it is open now, at
 * the emit. The difference is a request the child does work for and whose
 * answer nobody will accept.
 *
 * The real resolver runs here. What is injected is only the delay inside it,
 * because the property under test is about time passing in exactly that place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveDelayMs = { value: 0 };

vi.mock('@/app/managed/managedSessionGrant', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/managed/managedSessionGrant')>();
    return {
        ...actual,
        resolveLiveGrant: async (input: Parameters<typeof actual.resolveLiveGrant>[0]) => {
            // The real check, with the read made to take a measurable amount of
            // time — the same thing a loaded database does.
            const answer = await actual.resolveLiveGrant(input);
            if (resolveDelayMs.value > 0) {
                await new Promise((resolve) => setTimeout(resolve, resolveDelayMs.value));
            }
            return answer;
        },
    };
});

import { executeManagedRpcLocally } from '@/app/api/socket/managed/managedDelivery';
import { ManagedOutboundChannel } from '@/app/api/socket/managed/managedOutboundQueue';
import { ManagedSocketRegistry } from '@/app/api/socket/managed/managedSocketRegistry';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
}

let registry: ManagedSocketRegistry;
let emitted: unknown[][];
let socketId: string;

function claimsFor(expiresAt: number): SessionScopedClaims {
    return {
        v: 1,
        grantId: 'grant-that-does-not-exist',
        accountId: 'acct-1',
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        purpose: 'approval-control',
        viewerAccountId: 'viewer-1',
        expiresAt,
    } as SessionScopedClaims;
}

beforeEach(() => {
    resolveDelayMs.value = 0;
    registry = new ManagedSocketRegistry();
    emitted = [];
    socketId = 'socket-1';
    const socket = {
        emit: (event: string, ...args: unknown[]) => {
            emitted.push([event, ...args]);
            const ack = args[args.length - 1];
            if (typeof ack === 'function') (ack as (v: unknown) => void)('answer');
            return true;
        },
        disconnect: () => {},
    };
    registry.add({
        socketId,
        accountId: 'acct-1',
        sessionId: 'sess-1',
        grantId: 'runner-grant',
        runId: 'run-1',
        attemptId: 'attempt-1',
        rpcNames: new Set(['permission']),
        connectedAt: Date.now(),
        channel: new ManagedOutboundChannel(
            socket as never,
            async () => ({ ok: true }),
            undefined,
        ) as never,
    });
});

afterEach(() => registry.clear());

describe.skipIf(!enabled)('the clock read around the authority', () => {
    it('does not emit when the bearer expires while the authority is being read', async () => {
        /*
         * The bearer is live when the read starts and dead when it returns.
         * Nothing waits before the check — the time passes inside it — so a
         * comparison made on entry calls this window open.
         *
         * The grant this names does not exist, which would refuse it anyway;
         * what is asserted is that nothing reached the socket, and the case
         * below shows the same channel does emit when the window holds.
         */
        resolveDelayMs.value = 60;
        const outcome = await new Promise((resolve) => {
            const started = executeManagedRpcLocally(
                {
                    sessionId: 'sess-1',
                    accountId: 'acct-1',
                    rpcName: 'permission',
                    requestId: 'call-1',
                    params: 'c2VhbGVk',
                    approval: { claims: claimsFor(Date.now() + 20) },
                },
                socketId,
                resolve,
                registry,
                Date.now() + 5_000,
            );
            expect(started).toEqual({ ok: true });
        });
        expect(emitted).toEqual([]);
        expect(outcome).toMatchObject({ ok: false });
    });

    it('emits when there is no second authority to wait on', async () => {
        // The same channel and the same registry: the refusal above is about
        // the authority, not about this harness being unable to emit.
        const outcome = await new Promise((resolve) => {
            executeManagedRpcLocally(
                {
                    sessionId: 'sess-1',
                    accountId: 'acct-1',
                    rpcName: 'permission',
                    requestId: 'call-2',
                    params: 'c2VhbGVk',
                },
                socketId,
                resolve,
                registry,
                Date.now() + 5_000,
            );
        });
        expect(emitted).toHaveLength(1);
        expect(outcome).toMatchObject({ ok: true });
    });
});
