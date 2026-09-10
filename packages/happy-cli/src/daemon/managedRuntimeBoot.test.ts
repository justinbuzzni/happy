import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { startDaemonControlServer } from './controlServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { applyManagedRpcRestrictions, MANAGED_ALLOWED_RPCS } from './managedRpcHandlers';
import type { PortRegistry } from './portRegistry';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/**
 * These boot the real components and exercise them over their real transports:
 * an HTTP control server on loopback, and an `RpcHandlerManager` driven through
 * its encrypted `handleRequest` path. Assertions are about observed behaviour —
 * a refused request, a handler that did or did not run — not about the shape of
 * the source that produces it.
 */

type Started = Awaited<ReturnType<typeof startDaemonControlServer>>;

let servers: Started[] = [];
let spawnCalls: number;

const portRegistry = {
    allocate: async () => null,
    release: async () => {},
    list: async () => [],
} as unknown as PortRegistry;

async function boot(overrides: Partial<Parameters<typeof startDaemonControlServer>[0]> = {}): Promise<Started> {
    const started = await startDaemonControlServer({
        getChildren: () => [],
        stopSession: () => ({ stopped: true }),
        spawnSession: async (): Promise<SpawnSessionResult> => {
            spawnCalls += 1;
            return { type: 'success', sessionId: 'sess-boot' };
        },
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        portRegistry,
        ...overrides,
    });
    servers.push(started);
    return started;
}

function post(server: Started, path: string, body: unknown) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.controlSecret}`,
        },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    spawnCalls = 0;
});

afterEach(async () => {
    for (const server of servers) await server.stop().catch(() => undefined);
    servers = [];
});

describe('BYOS control server keeps its existing surface', () => {
    it('spawns a session over the loopback endpoint', async () => {
        const server = await boot();
        const response = await post(server, '/spawn-session', { directory: '/tmp/x' });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, sessionId: 'sess-boot' });
        expect(spawnCalls).toBe(1);
    });

    it('accepts a session-started report without any launch verifier', async () => {
        const seen: string[] = [];
        const server = await boot({ onHappySessionWebhook: (sessionId) => { seen.push(sessionId); } });
        const response = await post(server, '/session-started', { sessionId: 's-1', metadata: {} });
        expect(response.status).toBe(200);
        expect(seen).toEqual(['s-1']);
    });
});

describe('managed control server refuses the ways in', () => {
    it('refuses to spawn even with a valid bearer', async () => {
        const server = await boot({ managedRuntime: true });
        const response = await post(server, '/spawn-session', { directory: '/tmp/x' });
        expect(response.status).toBe(403);
        // The refusal must happen before any work is done, not after.
        expect(spawnCalls).toBe(0);
    });

    it('refuses shell execution and the proxies', async () => {
        const server = await boot({ managedRuntime: true });
        for (const path of ['/start-server', '/stop-session', '/proxy-http', '/stop', '/list']) {
            const response = await post(server, path, {});
            expect(response.status, path).toBe(403);
        }
    });

    it('refuses a lifecycle report when no launch verifier is wired', async () => {
        const seen: string[] = [];
        const server = await boot({
            managedRuntime: true,
            onHappySessionWebhook: (sessionId) => { seen.push(sessionId); },
        });
        const response = await post(server, '/session-started', { sessionId: 's-1', metadata: {} });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'MANAGED_LAUNCH_SCOPE_REQUIRED' });
        expect(seen).toEqual([]);
    });
});

describe('managed report verification is bound to the reported session', () => {
    /** Stands in for the launch registry: header names the launch, body the session. */
    function verifierFor(allowed: Record<string, string>) {
        const seen: Array<{ kind: string; sessionId: string }> = [];
        return {
            seen,
            verify: async (claim: { kind: string; sessionId: string; headers: Record<string, unknown> }) => {
                seen.push({ kind: claim.kind, sessionId: claim.sessionId });
                const launch = claim.headers['x-managed-launch'];
                if (typeof launch !== 'string') return { ok: false as const, reason: 'no-launch-header' };
                return allowed[launch] === claim.sessionId
                    ? { ok: true as const }
                    : { ok: false as const, reason: 'session-not-in-launch-scope' };
            },
        };
    }

    it('accepts a report whose body matches the launch that sent it', async () => {
        const seen: string[] = [];
        const verifier = verifierFor({ 'launch-a': 'session-a' });
        const server = await boot({
            managedRuntime: true,
            verifyManagedReport: verifier.verify,
            onHappySessionWebhook: (sessionId) => { seen.push(sessionId); },
        });
        const response = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${server.controlSecret}`,
                'x-managed-launch': 'launch-a',
            },
            body: JSON.stringify({ sessionId: 'session-a', metadata: {} }),
        });
        expect(response.status).toBe(200);
        expect(seen).toEqual(['session-a']);
    });

    it("refuses launch A's header carrying launch B's session", async () => {
        const seen: string[] = [];
        const verifier = verifierFor({ 'launch-a': 'session-a', 'launch-b': 'session-b' });
        const server = await boot({
            managedRuntime: true,
            verifyManagedReport: verifier.verify,
            onHappySessionWebhook: (sessionId) => { seen.push(sessionId); },
        });
        const response = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${server.controlSecret}`,
                'x-managed-launch': 'launch-a',
            },
            body: JSON.stringify({ sessionId: 'session-b', metadata: {} }),
        });
        expect(response.status).toBe(403);
        // The callback must never see a session the launch did not own.
        expect(seen).toEqual([]);
        expect(verifier.seen).toEqual([{ kind: 'session-started', sessionId: 'session-b' }]);
    });

    it('validates each report type on its own terms', async () => {
        const runtimeReports: string[] = [];
        const verifier = verifierFor({ 'launch-a': 'session-a' });
        const server = await boot({
            managedRuntime: true,
            verifyManagedReport: verifier.verify,
            onHappySessionRuntime: (sessionId) => { runtimeReports.push(sessionId); },
        });
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.controlSecret}`,
            'x-managed-launch': 'launch-a',
        };
        const bad = await fetch(`http://127.0.0.1:${server.port}/session-runtime`, {
            method: 'POST', headers, body: JSON.stringify({ sessionId: 'session-b' }),
        });
        expect(bad.status).toBe(403);
        const good = await fetch(`http://127.0.0.1:${server.port}/session-runtime`, {
            method: 'POST', headers, body: JSON.stringify({ sessionId: 'session-a' }),
        });
        expect(good.status).toBe(200);
        expect(runtimeReports).toEqual(['session-a']);
        expect(verifier.seen.map((claim) => claim.kind)).toEqual(['session-runtime', 'session-runtime']);
    });
});

describe('RPC dispatch allowlist over the real encrypted path', () => {
    const key = new Uint8Array(randomBytes(32));

    function manager() {
        return new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: key,
            encryptionVariant: 'legacy',
            logger: () => {},
        });
    }

    async function callRpc(target: RpcHandlerManager, method: string, params: unknown) {
        const response = await target.handleRequest({
            method: `machine-1:${method}`,
            params: encodeBase64(encrypt(key, 'legacy', params)),
        } as Parameters<RpcHandlerManager['handleRequest']>[0]);
        return decrypt(key, 'legacy', decodeBase64(response as string));
    }

    it('runs a legacy handler on a BYOS manager', async () => {
        const target = manager();
        let ran = 0;
        target.registerHandler('spawn-happy-session', () => { ran += 1; return { type: 'success' }; });
        expect(await callRpc(target, 'spawn-happy-session', {})).toMatchObject({ type: 'success' });
        expect(ran).toBe(1);
    });

    it('refuses the same handler once the allowlist is applied', async () => {
        const target = manager();
        let ran = 0;
        target.registerHandler('spawn-happy-session', () => { ran += 1; return { type: 'success' }; });
        applyManagedRpcRestrictions(target);
        expect(await callRpc(target, 'spawn-happy-session', {}))
            .toMatchObject({ code: 'MANAGED_CAPABILITY_REQUIRED' });
        // Refused at dispatch: the handler is never reached.
        expect(ran).toBe(0);
    });

    it('refuses a handler registered after the allowlist was applied', async () => {
        const target = manager();
        applyManagedRpcRestrictions(target);
        let ran = 0;
        target.registerHandler('some-future-rpc', () => { ran += 1; return { ok: true }; });
        expect(await callRpc(target, 'some-future-rpc', {}))
            .toMatchObject({ code: 'MANAGED_CAPABILITY_REQUIRED' });
        expect(ran).toBe(0);
    });

    it('still dispatches the managed methods', async () => {
        const target = manager();
        applyManagedRpcRestrictions(target);
        let ran = 0;
        for (const method of MANAGED_ALLOWED_RPCS) {
            target.registerHandler(method, () => { ran += 1; return { ok: true, method }; });
        }
        expect(await callRpc(target, 'managed:spawn', {})).toMatchObject({ ok: true });
        expect(ran).toBe(1);
    });
});

describe('report verification can see everything the daemon will act on', () => {
    it('refuses an allowed session whose reported host pid was swapped', async () => {
        const adopted: Array<{ sessionId: string; hostPid?: number }> = [];
        const server = await boot({
            managedRuntime: true,
            // A registry that pins the launch to one process: the session id is
            // right, the process is not.
            verifyManagedReport: async (claim) => {
                const metadata = claim.kind === 'session-started'
                    ? (claim.report.metadata as { hostPid?: number } | undefined)
                    : undefined;
                const pid = claim.kind === 'session-started'
                    ? metadata?.hostPid
                    : (claim.report.hostPid as number | undefined);
                if (claim.sessionId !== 'session-a') return { ok: false, reason: 'wrong-session' };
                return pid === 4242 ? { ok: true } : { ok: false, reason: 'host-pid-not-in-launch' };
            },
            onHappySessionWebhook: (sessionId, metadata) => {
                adopted.push({ sessionId, hostPid: (metadata as { hostPid?: number })?.hostPid });
            },
        });
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.controlSecret}`,
        };

        const tampered = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
            method: 'POST', headers,
            body: JSON.stringify({ sessionId: 'session-a', metadata: { hostPid: 9999 } }),
        });
        expect(tampered.status).toBe(403);
        expect(adopted).toEqual([]);

        const honest = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
            method: 'POST', headers,
            body: JSON.stringify({ sessionId: 'session-a', metadata: { hostPid: 4242 } }),
        });
        expect(honest.status).toBe(200);
        expect(adopted).toEqual([{ sessionId: 'session-a', hostPid: 4242 }]);
    });

    it('refuses a runtime report whose host pid was swapped', async () => {
        const reports: number[] = [];
        const server = await boot({
            managedRuntime: true,
            verifyManagedReport: async (claim) => (
                claim.kind === 'session-runtime' && claim.report.hostPid === 4242
                    ? { ok: true }
                    : { ok: false, reason: 'host-pid-not-in-launch' }
            ),
            onHappySessionRuntime: (_sessionId, _runtime, reporter) => {
                reports.push(reporter?.hostPid ?? -1);
            },
        });
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.controlSecret}`,
        };
        const tampered = await fetch(`http://127.0.0.1:${server.port}/session-runtime`, {
            method: 'POST', headers,
            body: JSON.stringify({ sessionId: 'session-a', hostPid: 9999 }),
        });
        expect(tampered.status).toBe(403);
        expect(reports).toEqual([]);

        const honest = await fetch(`http://127.0.0.1:${server.port}/session-runtime`, {
            method: 'POST', headers,
            body: JSON.stringify({ sessionId: 'session-a', hostPid: 4242 }),
        });
        expect(honest.status).toBe(200);
        expect(reports).toEqual([4242]);
    });

    it('passes the encryption scope so a registry can check it', async () => {
        const seen: unknown[] = [];
        const server = await boot({
            managedRuntime: true,
            verifyManagedReport: async (claim) => {
                if (claim.kind === 'session-started') seen.push(claim.report.encryption);
                return { ok: true };
            },
        });
        await post(server, '/session-started', {
            sessionId: 'session-a',
            metadata: {},
            encryption: {
                encryptionKey: Buffer.alloc(32).toString('base64'),
                encryptionVariant: 'dataKey',
                seq: 1,
                metadataVersion: 1,
                agentStateVersion: 1,
            },
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ encryptionVariant: 'dataKey' });
    });
});

describe('the confirmed-delivery switch is the daemon\'s, not the caller\'s', () => {
    it('strips a caller-supplied managed key before it can reach the child', async () => {
        const { injectMcpCallerGrant } = await import('./mcpCallerGrantEnvelope');
        // The caller tries to turn the switch off through spawn params.
        const sanitized = injectMcpCallerGrant({
            HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '0',
            SOMETHING_ELSE: 'kept',
        }, undefined);
        expect(sanitized.HAPPY_MANAGED_REQUIRE_PROMPT_ACK).toBeUndefined();
        expect(sanitized.SOMETHING_ELSE).toBe('kept');
    });

    it('reads the switch only from the exact daemon-set value', async () => {
        const { consumeConfirmedInitialPromptDelivery } = await import('@/utils/initialPrompt');
        expect(consumeConfirmedInitialPromptDelivery({ HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' })).toBe(true);
        expect(consumeConfirmedInitialPromptDelivery({ HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '0' })).toBe(false);
    });

    it('removes an inherited switch from the final child environment', async () => {
        const { applyConfirmedPromptDeliveryFlag } = await import('./sessionEnv');
        // The daemon's own environment is inherited wholesale on the default
        // spawn path, so deleting the key from the caller's extras is not
        // enough — a stale value would survive the merge.
        const inherited = { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1', KEEP: 'yes' };
        expect(applyConfirmedPromptDeliveryFlag(inherited, false))
            .toEqual({ KEEP: 'yes' });
        expect(applyConfirmedPromptDeliveryFlag({ KEEP: 'yes' }, true))
            .toEqual({ KEEP: 'yes', HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' });
    });
});
