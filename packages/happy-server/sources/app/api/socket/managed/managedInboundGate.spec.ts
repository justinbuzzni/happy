import { describe, expect, it } from 'vitest';

import { authorizeManagedInbound } from '@/app/api/socket/managed/managedInboundGate';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

/** Pure: no database, no sockets. */

const SID = 'session-under-grant';
const OTHER = 'someone-elses-session';

// Real claims always carry a purpose — `parseSessionScopedClaims` normalises a
// token minted before that axis existed to `runner`. A fixture without one
// would be testing a shape the verifier cannot produce.
const claims = { sessionId: SID, purpose: 'runner' } as SessionScopedClaims;
import type { ManagedGrantProbe } from '@/app/api/socket/managed/managedInboundGate';

const live: ManagedGrantProbe = async () => ({ ok: true });

function inbound(event: string, payload: unknown, checkGrant: ManagedGrantProbe = live) {
    return authorizeManagedInbound({ event, payload, claims, checkGrant });
}

describe('rpc-call is refused outright', () => {
    it('refuses it even for the child*s own session', async () => {
        // A child provides handlers; it does not invoke them. The dispatcher
        // resolves a method across the cluster, so reaching it at all is the
        // problem — the session id in the string is an argument, not a bound.
        expect(await inbound('rpc-call', { method: `${SID}:permission` }))
            .toEqual({ ok: false, reason: 'rpc-call-not-permitted' });
        expect(await inbound('rpc-call', { method: `${OTHER}:bash` }))
            .toEqual({ ok: false, reason: 'rpc-call-not-permitted' });
    });

    it('refuses it before any grant is read', async () => {
        let consulted = false;
        await inbound('rpc-call', { method: `${SID}:permission` }, async () => {
            consulted = true;
            return { ok: true } as const;
        });
        expect(consulted).toBe(false);
    });
});

describe('registration is by exact session and listed name', () => {
    it('accepts a listed name under the granted session', async () => {
        for (const name of ['permission', 'abort', 'bash', 'readFile']) {
            expect(await inbound('rpc-register', { method: `${SID}:${name}` }), name)
                .toEqual({ ok: true });
        }
        expect(await inbound('rpc-unregister', { method: `${SID}:permission` })).toEqual({ ok: true });
    });

    it('refuses steering, which no admission covers', async () => {
        // Steering injects free text into the turn already running. Unlike
        // `goal-action`, the name carries no sub-mode that could be allowed on
        // its own, so it is off the list entirely.
        expect(await inbound('rpc-register', { method: `${SID}:steer` }))
            .not.toEqual({ ok: true });
    });

    it('refuses another session and a prefix that merely starts the same', async () => {
        expect(await inbound('rpc-register', { method: `${OTHER}:permission` }))
            .toEqual({ ok: false, reason: 'session-mismatch' });
        expect(await inbound('rpc-register', { method: `${SID}-extra:permission` }))
            .toEqual({ ok: false, reason: 'session-mismatch' });
    });

    it('refuses an unlisted name under the right session', async () => {
        expect(await inbound('rpc-register', { method: `${SID}:spawn-happy-session` }))
            .toEqual({ ok: false, reason: 'rpc-name-not-allowed' });
        expect(await inbound('rpc-register', { method: `${SID}:switch` }))
            .toEqual({ ok: false, reason: 'capability-not-supported' });
    });

    it('refuses a malformed registration', async () => {
        expect(await inbound('rpc-register', {})).toEqual({ ok: false, reason: 'rpc-name-malformed' });
        expect(await inbound('rpc-register', { method: 42 })).toEqual({ ok: false, reason: 'rpc-name-malformed' });
    });
});

describe('session events', () => {
    it('accepts the volatile events a running agent emits', async () => {
        expect(await inbound('session-stream', { sid: SID, time: 1, data: 'x' })).toEqual({ ok: true });
        expect(await inbound('session-alive', { sid: SID, time: 1 })).toEqual({ ok: true });
        expect(await inbound('usage-report', { sessionId: SID })).toEqual({ ok: true });
    });

    it('refuses an event naming another session', async () => {
        expect(await inbound('session-stream', { sid: OTHER, time: 1, data: 'x' }))
            .toEqual({ ok: false, reason: 'session-mismatch' });
    });

    it('refuses machine and artifact events', async () => {
        for (const event of ['machine-alive', 'artifact-create', 'terminal-open', 'access-key-get']) {
            expect(await inbound(event, { sid: SID }), event)
                .toEqual({ ok: false, reason: 'event-not-allowed' });
        }
    });
});

describe('the grant is read for every accepted shape', () => {
    it('refuses a revoked grant', async () => {
        expect(await inbound('session-stream', { sid: SID, time: 1, data: 'x' },
            async () => ({ ok: false, reason: 'revoked' })))
            .toEqual({ ok: false, reason: 'grant-invalid' });
    });

    it('refuses when the authority store cannot be reached', async () => {
        expect(await inbound('session-alive', { sid: SID, time: 1 },
            async () => { throw new Error('down'); }))
            .toEqual({ ok: false, reason: 'authority-unavailable' });
    });

    it('never lets a live grant make an unlisted event acceptable', async () => {
        expect(await inbound('machine-alive', { sid: SID })).toEqual({ ok: false, reason: 'event-not-allowed' });
    });
});
