import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalManagedPayloadDigest, parseManagedVerifierKey, type ManagedOp } from './managedDispatchToken';
import { GATEWAY_ROUTES } from '@/managed/managedSpawnBootstrap';
import { MANAGED_PROJECT_ROOT } from './managedRuntimeIdentity';
import { createManagedReceiptStore, managedOperationKey } from './managedReceiptStore';
import {
    applyManagedRpcRestrictions,
    createManagedRpcHandlers,
    MANAGED_ALLOWED_RPCS,
    ManagedRpcError,
    type ManagedRuntime,
    type ManagedSpawnOutcome,
} from './managedRpcHandlers';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';

const keys = generateKeyPairSync('ed25519');
const verifier = parseManagedVerifierKey(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer);

const NOW = 1_800_000_000_000;
/**
 * A bootstrap envelope of the shape the parent actually sends.
 *
 * Built from the product's own route table rather than a copy of it: a literal
 * here would keep passing after the real one moved, and the gateway row is
 * matched whole by the parser precisely because a plausible-looking field is
 * the mistake worth catching.
 */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
    const route = GATEWAY_ROUTES.find((candidate) => candidate.agent === 'claude')!;
    return {
        directory: MANAGED_PROJECT_ROOT,
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'hello',
        initialPromptLocalId: 'local-1',
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 8).toString('base64'),
            scopedToken: 'scoped.bearer.for.this.run',
            // The runtime's clock, not the wall clock: the parser compares
            // against the time the handler passes it.
            tokenExpiresAt: NOW + 3_600_000,
        },
        gateway: {
            baseUrl: `https://happy.example.test${route.path}`,
            capability: 'anthropic-messages',
            provider: route.provider,
            endpoint: route.endpoint,
            model: 'claude-opus-5',
        },
        ...over,
    };
}

const RUN = 'run-1';
const ATTEMPT = 'attempt-1';
const OP_KEY = managedOperationKey({ runId: RUN, attemptId: ATTEMPT });

let root: string;
let wallClock: number;
let monotonic: number;
let spawnCalls: number;
let spawnResult: () => Promise<ManagedSpawnOutcome>;
let runtime: ManagedRuntime;
let handlers: ReturnType<typeof createManagedRpcHandlers>;
let livePgids: Set<number>;
let killed: Array<[number, string | number]>;

const identity: ManagedRuntimeIdentity = {
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    happyMachineId: 'machine-1',
    provisioningOperationId: 'op-1',
    configDigest: 'digest-1',
    providerMachineId: 'provider-machine-1',
    providerInstanceId: 'provider-instance-1',
    providerVolumeId: 'vol_fixture_1',
    verifier,
    stateDir: '/unused',
    isolation: { backend: 'privileged-launch-supervisor', provider: { uid: 901, gid: 901 }, executor: { uid: 902, gid: 901 }, cgroupRoot: '/c' },
};

function mint(op: ManagedOp, payload: unknown, overrides: Record<string, unknown> = {}): string {
    const body = {
        v: 1,
        kid: 'kid-1',
        aud: 'runtime-1',
        op,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        runId: RUN,
        attemptId: ATTEMPT,
        requestKey: 'client-request-key',
        epoch: 0,
        payloadDigest: canonicalManagedPayloadDigest(payload),
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
}

function call(op: ManagedOp, payload: unknown = {}, overrides: Record<string, unknown> = {}) {
    return { token: mint(op, payload, overrides), params: payload };
}

async function grantLease(overrides: Record<string, unknown> = {}) {
    return handlers.lease(call('lease', {}, {
        renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000, ...overrides,
    }));
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-rpc-'));
    wallClock = NOW + 1_000;
    monotonic = 10_000;
    spawnCalls = 0;
    livePgids = new Set();
    killed = [];
    spawnResult = async () => ({ type: 'success', sessionId: 'sess-1', pid: 4242 });
    const store = createManagedReceiptStore(root, { assertHeld: () => {} });
    runtime = {
        identity,
        store,
        spawn: async () => { spawnCalls += 1; return spawnResult(); },
        isPidAlive: (pid) => livePgids.has(pid),
        now: () => wallClock,
        monotonicNow: () => monotonic,
        processGroupDeps: {
            kill: (target, signal) => {
                killed.push([target, signal]);
                const pgid = Math.abs(target);
                if (signal === 0 && !livePgids.has(pgid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
                if (signal === 'SIGTERM' || signal === 'SIGKILL') livePgids.delete(pgid);
            },
            sleep: async (ms) => { wallClock += ms; },
            now: () => wallClock,
        },
    };
    handlers = createManagedRpcHandlers(runtime);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('token scope is checked against the trusted identity', () => {
    it('refuses a token whose projectId is not this runtime\'s project', async () => {
        await grantLease();
        await expect(handlers.spawn(call('spawn', envelope(), { projectId: 'proj-2' })))
            .rejects.toThrowError(/token-wrong-project|wrong-project/);
        expect(spawnCalls).toBe(0);
    });

    it('refuses a token signed under a different key id', async () => {
        await grantLease();
        await expect(handlers.spawn(call('spawn', envelope(), { kid: 'kid-2' })))
            .rejects.toThrowError(/key/);
        expect(spawnCalls).toBe(0);
    });
});

describe('lease', () => {
    it('starts expired so a restart cannot execute on an old deadline', async () => {
        expect(handlers.isLeaseValid()).toBe(false);
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/lease-expired/);
        expect(spawnCalls).toBe(0);
    });

    it('grants a monotonic deadline clamped by the signed absolute expiry', async () => {
        // The token itself stays fresh; only the absolute expiry is close, so
        // the clamp — not the token check — is what this exercises.
        wallClock = NOW + 590_000;
        const result = await handlers.lease(call('lease', {}, {
            renewalSeq: 1,
            leaseMs: 60_000,
            absoluteExpiry: NOW + 600_000,
            iat: wallClock,
            exp: wallClock + 60_000,
        }));
        expect(result.grantedMs).toBe(10_000);
    });

    it('does not extend the deadline when a wall clock jumps backwards', async () => {
        await grantLease();
        expect(handlers.isLeaseValid()).toBe(true);
        monotonic += 120_000;
        wallClock -= 3_600_000;
        expect(handlers.isLeaseValid()).toBe(false);
    });

    it('refuses a replayed renewal sequence', async () => {
        await grantLease({ renewalSeq: 5 });
        await expect(grantLease({ renewalSeq: 5 })).rejects.toThrowError(/stale-renewal/);
        await expect(grantLease({ renewalSeq: 4 })).rejects.toThrowError(/stale-renewal/);
    });

    it('refuses to raise the epoch while no trusted fencing backend can prove it', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        // Raising the epoch is what opens a new writable generation. Local
        // quiet cannot prove the previous one is gone, so without a backend
        // proof the promotion must not happen at all.
        await expect(grantLease({ renewalSeq: 2, epoch: 1 }))
            .rejects.toThrowError(/fence-proof-unavailable/);
    });

    it('leaves the stored epoch and deadline untouched after a refused promotion', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        await expect(grantLease({ renewalSeq: 2, epoch: 1 })).rejects.toThrow();
        const lease = runtime.store.readLease();
        expect(lease.kind).toBe('ok');
        if (lease.kind === 'ok') {
            expect(lease.record.epoch).toBe(0);
            expect(lease.record.renewalSeq).toBe(1);
        }
    });

    it('refuses when the lease record cannot be read', async () => {
        await grantLease();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(root, 'lease.json'), '{broken');
        await expect(grantLease({ renewalSeq: 2 })).rejects.toThrowError(/lease-state-unreadable/);
    });
});

describe('spawn', () => {
    it('runs a request exactly once and returns the same receipt on retry', async () => {
        await grantLease();
        const first = await handlers.spawn(call('spawn', envelope()));
        const second = await handlers.spawn(call('spawn', envelope()));
        expect(spawnCalls).toBe(1);
        expect(second.receipt.operationKey).toBe(first.receipt.operationKey);
    });

    it('refuses a second spawn that carries different params under the same operation', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', envelope()));
        // Same run+attempt, different signed payload: this is a conflict, not a
        // retry, and answering it with the first result would hide the bug.
        await expect(handlers.spawn(call('spawn', envelope({ initialPrompt: 'a different prompt' }))))
            .rejects.toThrowError(/operation-payload-conflict/);
        expect(spawnCalls).toBe(1);
    });

    it('records the payload digest without storing the payload', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', envelope({ initialPrompt: 'secret text' })));
        const { readFileSync, readdirSync } = await import('node:fs');
        const dir = join(root, 'receipts');
        const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
        expect(raw).not.toContain('secret text');
        expect(raw).not.toContain('/secret-path');
    });

    it('refuses a dispatch that a stop already tombstoned', async () => {
        await grantLease();
        await handlers.stop(call('stop', {}));
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/stopped-before-dispatch/);
        expect(spawnCalls).toBe(0);
    });

    it('keeps an unexplained spawn failure recoverable instead of calling it failed', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('socket closed at /tmp/x with token abc'); };
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(ManagedRpcError);
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        // A child may already exist; recording `failed` would end the story for
        // a run that could still be writing.
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('spawning');
    });

    it('does not leak the underlying error text to the caller', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('token=abc123 at /home/u/.happy/access.key'); };
        await handlers.spawn(call('spawn', envelope())).catch((error: Error) => {
            expect(error.message).not.toContain('abc123');
            expect(error.message).not.toContain('access.key');
        });
    });

    it('marks a run failed only on typed evidence that nothing started', async () => {
        await grantLease();
        spawnResult = async () => ({ type: 'error', errorMessage: 'bad directory', started: false });
        await expect(handlers.spawn(call('spawn', envelope()))).rejects.toThrow();
        const stored = runtime.store.read(OP_KEY);
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('failed');
    });

    it('honours a stop that landed while the spawn was in flight', async () => {
        await grantLease();
        const stopCalls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { stopCalls.push(input); return { requested: true, detail: 'ok' }; },
        };
        let release: () => void = () => {};
        spawnResult = () => new Promise((resolve) => {
            release = () => resolve({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        await handlers.stop(call('stop', {}));
        livePgids.add(4242);
        release();
        const result = await inFlight;
        expect(result.receipt.state).toBe('stopping');
        // The stop is carried out by the trusted backend, not by signalling a
        // pid this process happens to remember. Two requests are expected and
        // safe: the first while the pid is still unknown, the second once it is
        // — the backend is keyed by run/attempt/epoch and is idempotent.
        expect(stopCalls.length).toBeGreaterThanOrEqual(1);
        expect(stopCalls.every((c) => c.attemptId === ATTEMPT && c.runId === RUN)).toBe(true);
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
    });

    it('refuses new work once the lease has expired', async () => {
        await grantLease({ leaseMs: 1_000 });
        monotonic += 2_000;
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/lease-expired/);
    });
});

describe('lease expiry does not silently leave a child running', () => {
    it('reports an action-required handoff when no trusted backend can fence', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 120_000;

        const outcome = await handlers.runLeaseMaintenance();
        // Nothing here can stop a child that outlived the lease, so this must
        // say so rather than report a clean stop.
        expect(outcome.expired).toBe(true);
        expect(outcome.actionRequired).toBe(true);
        expect(outcome.live.length).toBeGreaterThan(0);
    });
});

describe('receipt query', () => {
    it('returns only the signed run and attempt scope', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', envelope()));
        runtime.store.claim({
            requestKey: managedOperationKey({ runId: 'run-2', attemptId: 'attempt-9' }),
            runId: 'run-2', attemptId: 'attempt-9', epoch: 0, now: wallClock,
        });
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts).toHaveLength(1);
        expect(result.receipts[0]!.runId).toBe(RUN);
    });

    it('reports an absent receipt without inventing one', async () => {
        await grantLease();
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts).toEqual([]);
    });

    it('does not call a spawning receipt determinate', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('unclear'); };
        await handlers.spawn(call('spawn', envelope())).catch(() => {});
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts[0]!.certainty).toBe('uncertain');
    });
});

describe('managed runtime RPC allowlist', () => {
    it('refuses at the dispatch boundary, not by rewriting registrations', () => {
        const allowlisted: string[][] = [];
        applyManagedRpcRestrictions({
            setManagedAllowlist: (methods) => { allowlisted.push([...methods]); },
        });
        expect(allowlisted).toHaveLength(1);
        expect(allowlisted[0]).toEqual([...MANAGED_ALLOWED_RPCS]);
    });

    it('refuses to run against a manager that cannot gate dispatch', () => {
        // Silently doing nothing here would leave the whole legacy surface open
        // on a runtime that believes it is restricted.
        expect(() => applyManagedRpcRestrictions({}))
            .toThrowError(/dispatch-level allowlist/);
    });

    it('allows only the managed dispatch methods', () => {
        expect([...MANAGED_ALLOWED_RPCS].sort())
            .toEqual([
                'managed:lease', 'managed:receipt', 'managed:runtime-lease',
                'managed:spawn', 'managed:status', 'managed:stop',
            ]);
        for (const bypass of ['spawn-happy-session', 'stop-session', 'bash', 'ai-credential:apply']) {
            expect(MANAGED_ALLOWED_RPCS).not.toContain(bypass);
        }
    });
});

describe('lease serialization barrier', () => {
    it('refuses an epoch downgrade that queued behind a higher epoch', async () => {
        // A request minted while the runtime was at epoch 3 can arrive after a
        // promotion to 4 committed. Writing epoch 3 back would silently reopen
        // the generation that was just fenced.
        runtime.store.writeLease({ epoch: 4, renewalSeq: 10, updatedAt: wallClock });
        await expect(handlers.lease(call('lease', {}, {
            epoch: 3, renewalSeq: 11, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
        }))).rejects.toThrowError(/stale-epoch/);

        const lease = runtime.store.readLease();
        if (lease.kind === 'ok') expect(lease.record.epoch).toBe(4);
    });

    it('re-checks token expiry after an awaited fence', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => {
                // The fence took long enough that the token is no longer fresh.
                wallClock += 300_000;
                return { proven: true, detail: 'ok' };
            },
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        await grantLease({ renewalSeq: 1, epoch: 0 });
        await expect(handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }))).rejects.toThrowError(/token-expired|stale/);
    });
});

describe('lease expiry hands off by stable identity', () => {
    beforeEach(async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 120_000;
    });

    it('asks the backend to stop by run and attempt, not by pgid', async () => {
        const calls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return { requested: true, detail: 'ok' }; },
        };
        await handlers.runLeaseMaintenance();
        expect(calls).toHaveLength(1);
        // A pgid is meaningless to a backend that outlives this process.
        expect(calls[0]).toMatchObject({ runId: RUN, attemptId: ATTEMPT });
    });

    it('does not skip a receipt that never recorded a pgid', async () => {
        const calls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return { requested: true, detail: 'ok' }; },
        };
        runtime.store.update(OP_KEY, { state: 'spawning', pid: null, pgid: null }, wallClock);
        await handlers.runLeaseMaintenance();
        // `spawning` means a child may exist whose pid was never recorded.
        expect(calls).toHaveLength(1);
    });

    it('keeps action required when the backend cannot prove the stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        livePgids.delete(4242);
        const outcome = await handlers.runLeaseMaintenance();
        // No local trace only means nothing is visible from here.
        expect(outcome.actionRequired).toBe(true);
    });

    it('clears action required only on a proven stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'provider stopped' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        const outcome = await handlers.runLeaseMaintenance();
        expect(outcome.actionRequired).toBe(false);
    });
});

describe('epoch promotion barrier against an in-flight spawn', () => {
    it('refuses to fence while a spawn admitted before it is still launching', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };

        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        await Promise.resolve();

        // The promotion must not complete while a child is still being started
        // under the old epoch — that is the writer the fence exists to exclude.
        await expect(handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }))).rejects.toThrowError(/fence-incomplete/);

        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        await inFlight;
    });

    it('passes the launcher a context taken from the verified token', async () => {
        await grantLease();
        let seen: unknown;
        runtime.spawn = async (_request, context) => {
            seen = context;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        // The caller-supplied params claim a different run; the launcher must
        // be told the signed one.
        await handlers.spawn({
            token: mint('spawn', envelope({ runId: 'attacker-run' })),
            params: envelope({ runId: 'attacker-run' }),
        });
        expect(seen).toMatchObject({ runId: RUN, attemptId: ATTEMPT, epoch: 0, projectId: 'proj-1' });
    });
});

describe('the bootstrap envelope the launcher is handed', () => {
    /*
     * The launcher does not trust this process and parses the envelope again on
     * its own side. What this runtime owes it is that the bytes it parses are
     * bytes this runtime validated — and that a document which fails validation
     * never reaches it at all.
     */
    beforeEach(async () => {
        await grantLease();
    });

    it('hands over exactly what parsed, and nothing that rode along', async () => {
        let seen: { bootstrapEnvelope: Buffer; envelope: unknown } | undefined;
        runtime.spawn = async (_request, context) => {
            seen = context as never;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const payload = { ...envelope(), smuggled: 'a field nobody validated' };
        await handlers.spawn({ token: mint('spawn', payload), params: payload });

        const parsed = JSON.parse(seen!.bootstrapEnvelope.toString('utf8'));
        // The field is gone from the bytes that cross the boundary: only what
        // the parser produced is re-serialized.
        expect(parsed.smuggled).toBeUndefined();
        expect(parsed.bootstrap.scopedToken).toBe('scoped.bearer.for.this.run');
        expect(seen!.envelope).toEqual(parsed);
    });

    it.each([
        ['nothing but a directory', undefined],
        ['a directory that is not a path this runtime runs in', 'not-a-root'],
        ['a directory that is not the managed project root', { directory: '/somewhere/else' }],
        ['an agent this runtime does not support', { agent: 'not-an-agent' }],
        ['a gateway route belonging to another agent', { gateway: { baseUrl: 'https://happy.example.test/api/cloud/gateway/openai/v1/responses', capability: 'openai-responses', provider: 'openai', endpoint: 'openai-responses', model: 'claude-opus-5' } }],
        ['a model that disagrees with the gateway', { model: 'claude-sonnet-5' }],
        ['a raw key that is not 32 bytes', { bootstrap: { rawKeyBase64: Buffer.alloc(16).toString('base64') } }],
    ])('refuses %s without reaching the launcher', async (_name, over) => {
        let launched = false;
        runtime.spawn = async () => {
            launched = true;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const payload = over === undefined
            ? { directory: MANAGED_PROJECT_ROOT }
            : typeof over === 'string'
                ? { directory: over }
                : {
                    ...envelope(),
                    ...over,
                    ...(('bootstrap' in over)
                        ? { bootstrap: { ...(envelope().bootstrap as object), ...(over as { bootstrap: object }).bootstrap } }
                        : {}),
                };
        await expect(handlers.spawn({ token: mint('spawn', payload), params: payload }))
            .rejects.toThrowError(/spawn-rejected/);
        expect(launched).toBe(false);
    });

    it('names the field it refused and never the value', async () => {
        /*
         * The document holds a scoped bearer and the session's raw key. A
         * message that echoed the offending value would put one of them in a
         * log line, which is the one place a secret is copied without anybody
         * deciding to copy it.
         */
        const payload = {
            ...envelope(),
            bootstrap: { ...(envelope().bootstrap as object), scopedToken: '' },
        };
        const error = await handlers.spawn({ token: mint('spawn', payload), params: payload })
            .then(() => null, (caught: Error) => caught);
        expect(error).toBeTruthy();
        expect(error!.message).toContain('bootstrap.scopedToken');
        // Nothing from the document itself.
        expect(error!.message).not.toContain('scoped.bearer.for.this.run');
        expect(error!.message).not.toContain(Buffer.alloc(32, 9).toString('base64'));
    });
});

describe('the wire shape the parent sends', () => {
    /*
     * The defect this exists for: this handler looked for the envelope under a
     * field of its own, while the parent's builder returns those keys **flat**
     * and the dispatcher signs and forwards that shape unchanged. Every real
     * spawn was refused, and every test that built its own nested request still
     * passed.
     *
     * The cross-package half — that the parent's *actual* builder produces
     * exactly these keys — lives in the parent's own suite, because this
     * package has to build and test on a checkout where the parent does not
     * exist.
     */
    it('takes the envelope from the request itself, with nothing nested', async () => {
        await grantLease();
        let seen: { envelope: { bootstrap: { scopedToken: string } } } | undefined;
        runtime.spawn = async (_request, context) => {
            seen = context as never;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const flat = envelope();
        await expect(handlers.spawn(call('spawn', flat)))
            .resolves.toMatchObject({ accepted: true, receipt: { state: 'running' } });
        expect(seen!.envelope.bootstrap.scopedToken).toBe('scoped.bearer.for.this.run');
    });

    it('refuses the same content nested under a field of its own', async () => {
        // The shape this handler briefly required. It is not the wire.
        await grantLease();
        const nested = { directory: MANAGED_PROJECT_ROOT, envelope: envelope() };
        await expect(handlers.spawn(call('spawn', nested)))
            .rejects.toThrowError(/spawn-rejected/);
    });
});

describe('stop always reaches the trusted backend', () => {
    function withBackend() {
        const calls: Array<Record<string, unknown>> = [];
        let result: { requested: boolean; detail: string } = { requested: true, detail: 'ok' };
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return result; },
        };
        return { calls, setResult: (r: typeof result) => { result = r; } };
    }

    it('delegates a stop for a receipt that never recorded a pgid', async () => {
        await grantLease();
        const backend = withBackend();
        // A persisted `spawning` receipt may have a live child whose pid was
        // never written down. Returning "no local trace" here leaves it running.
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'spawning', pid: null, pgid: null }, wallClock);

        await handlers.stop(call('stop', {}));
        expect(backend.calls).toHaveLength(1);
        expect(backend.calls[0]).toMatchObject({ runId: RUN, attemptId: ATTEMPT, epoch: 0 });
    });

    it('delegates a stop even when the local probe reports EPERM', async () => {
        await grantLease();
        const backend = withBackend();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        runtime.processGroupDeps!.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

        await handlers.stop(call('stop', {}));
        expect(backend.calls).toHaveLength(1);
    });

    it('reports a backend refusal instead of dropping it', async () => {
        await grantLease();
        const backend = withBackend();
        backend.setResult({ requested: false, detail: 'launcher-unavailable' });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));

        const outcome = await handlers.stop(call('stop', {}));
        // The intent is durable, the delivery failed, and nothing ended —
        // three facts that must not collapse into one flag.
        expect(outcome.stopIntentRecorded).toBe(true);
        expect(outcome.backendStop).toEqual({ requested: false, detail: 'launcher-unavailable' });
        expect(outcome.terminationProven).toBe(false);
    });

    it('reports that no backend exists rather than implying a stop', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        const outcome = await handlers.stop(call('stop', {}));
        expect(outcome.stopIntentRecorded).toBe(true);
        expect(outcome.backendStop).toEqual({ requested: false, detail: 'no-launch-backend' });
        expect(outcome.terminationProven).toBe(false);
    });

    it('never signals a process group itself', async () => {
        await grantLease();
        withBackend();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        killed.length = 0;

        await handlers.stop(call('stop', {}));
        // A numeric pid is not authority: the kernel may have reused it.
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
    });
});

describe('lease renewal, promotion and expiry share one serial section', () => {
    function backend(overrides: Partial<{ proven: boolean }> = {}) {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: overrides.proven ?? true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        return stops;
    }

    it('does not let a stale expiry stop a child after a renewal committed', async () => {
        const stops = backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        // The expiry sees an expired lease, but a renewal is queued behind it.
        // If the two are not serialized the expiry stops a child that the
        // renewal has just made legitimate again.
        const expiry = handlers.runLeaseMaintenance();
        const renewal = handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        const [expiryOutcome] = await Promise.all([expiry, renewal]);

        expect(handlers.isLeaseValid()).toBe(true);
        const obligation = runtime.store.read(OP_KEY);
        expect(obligation.kind).toBe('ok');

        const before = stops.length;
        await handlers.runLeaseMaintenance();
        if (expiryOutcome.expired && obligation.kind === 'ok'
            && obligation.receipt.stopRequestedAt !== null) {
            // The expiry got there first and recorded the obligation, so the
            // retry continues — a renewal restores the right to run new work,
            // not the right to forget a stop (see the obligation suite below).
            expect(stops.length).toBeGreaterThan(before);
        } else {
            // The renewal got there first: the lease was valid when the expiry
            // looked, so it must not have invented an obligation at all.
            expect(stops.length).toBe(before);
        }
    });

    it('blocks a new spawn until expiry handling has finished', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        let releaseStop: () => void = () => {};
        runtime.fencingBackend!.requestStop = () => new Promise((resolve) => {
            releaseStop = () => resolve({ requested: true, detail: 'ok' });
        });
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        const expiry = handlers.runLeaseMaintenance();
        await Promise.resolve();
        const other = managedOperationKey({ runId: 'run-2', attemptId: 'a-2' });
        expect(other).not.toBe(OP_KEY);
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/lease-expired|epoch-transition-in-progress/);
        releaseStop();
        await expiry;
    });

    it('re-checks token expiry inside the serial section, not only before it', async () => {
        backend();
        await grantLease({ renewalSeq: 1, epoch: 0 });
        // A promotion is queued first and takes long enough that the renewal
        // waiting behind it has aged out by the time it runs.
        let releaseProof: () => void = () => {};
        runtime.fencingBackend!.proveGenerationStopped = () => new Promise((resolve) => {
            releaseProof = () => { wallClock += 300_000; resolve({ proven: true, detail: 'ok' }); };
        });
        const promotion = handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }));
        await Promise.resolve();
        const stale = handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 3, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: NOW, exp: NOW + 60_000,
        }));
        releaseProof();
        await promotion.catch(() => undefined);
        await expect(stale).rejects.toThrowError(/token-expired/);
    });

    it('runs one watchdog tick at a time', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        let inFlight = 0;
        let maxConcurrent = 0;
        runtime.fencingBackend!.requestStop = async () => {
            inFlight += 1;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return { requested: true, detail: 'ok' };
        };
        await Promise.all([
            handlers.runLeaseMaintenance(),
            handlers.runLeaseMaintenance(),
            handlers.runLeaseMaintenance(),
        ]);
        expect(maxConcurrent).toBe(1);
    });

    it('exposes a barrier that waits for every in-flight lease operation', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        let finished = false;
        runtime.fencingBackend!.requestStop = async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
            return { requested: true, detail: 'ok' };
        };
        void handlers.runLeaseMaintenance();
        // Teardown must wait for whatever is running, not just the last tick.
        await handlers.drainLeaseWork();
        expect(finished).toBe(true);
    });
});

describe('spawn acceptance is not the stop delivery result', () => {
    it('still reports the run as accepted when the backend cannot take the stop', async () => {
        await grantLease();
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => ({ requested: false, detail: 'launcher-unavailable' }),
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        await handlers.stop(call('stop', {}));
        livePgids.add(4242);
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });

        const result = await inFlight;
        // A child exists. Reporting this as not-accepted would let the caller
        // treat the run as never started and dispatch it a second time.
        expect(result.accepted).toBe(true);
        expect(result.receipt.sessionId).toBe('sess-1');
        expect(result.backendStop).toEqual({ requested: false, detail: 'launcher-unavailable' });
        expect(result.terminationProven).toBe(false);
    });
});

describe('expiry versus a spawn that is still in flight', () => {
    beforeEach(async () => {
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
    });

    it('records a durable stop intent on every live receipt it hands over', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        await handlers.runLeaseMaintenance();
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        // Without this the intent lives only in the backend call, so a process
        // that restarts mid-handover has no record that the run must stop.
        if (stored.kind === 'ok') expect(stored.receipt.stopRequestedAt).not.toBeNull();
    });

    it('stops a spawn that completes after the expiry ran', async () => {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();

        monotonic += 5_000;
        await handlers.runLeaseMaintenance();

        livePgids.add(4242);
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        const result = await inFlight;

        // The child arrived after its lease was gone; leaving it `running`
        // would keep a writer alive that the expiry believed it had handed over.
        expect(result.receipt.state).toBe('stopping');
        expect(stops.length).toBeGreaterThanOrEqual(1);
    });

    it('does not report a clean handover while a spawn is still launching', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        monotonic += 5_000;

        const outcome = await handlers.runLeaseMaintenance();
        // A proof taken now cannot cover a child that has not started yet.
        expect(outcome.actionRequired).toBe(true);

        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        await inFlight;
    });

    it('drains a launching spawn and its post-launch stop before teardown', async () => {
        let stopFinished = false;
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                stopFinished = true;
                return { requested: true, detail: 'ok' };
            },
        };
        let launched = false;
        spawnResult = async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            launched = true;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        monotonic += 5_000;
        await handlers.runLeaseMaintenance();
        stopFinished = false;

        await handlers.drainLeaseWork();
        // The launcher window closes before the stop that follows it. Waiting
        // only for the launch would release the writer lock while that stop is
        // still writing to the receipt store.
        expect(launched).toBe(true);
        expect(stopFinished).toBe(true);
        await inFlight;
    });
});

describe('shutdown entry gate is separate from store ownership', () => {
    it('refuses a new spawn once entries are closed', async () => {
        await grantLease();
        handlers.closeEntries();
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/shutting-down/);
        expect(spawnCalls).toBe(0);
    });

    it('refuses a new stop and a new lease once entries are closed', async () => {
        await grantLease();
        handlers.closeEntries();
        await expect(handlers.stop(call('stop', {}))).rejects.toThrowError(/shutting-down/);
        await expect(grantLease({ renewalSeq: 9 })).rejects.toThrowError(/shutting-down/);
    });

    it('lets an already-entered spawn finish its bookkeeping', async () => {
        await grantLease();
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();

        handlers.closeEntries();
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        const result = await inFlight;

        // Closing the door must not undo work that is already inside.
        expect(result.accepted).toBe(true);
        const stored = runtime.store.read(OP_KEY);
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('running');
    });
});

describe('explicit stop is drained too', () => {
    it('waits for a stop that is still handing over to the backend', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));

        let handoverFinished = false;
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                handoverFinished = true;
                return { requested: true, detail: 'ok' };
            },
        };
        void handlers.stop(call('stop', {}));
        await Promise.resolve();

        await handlers.drainLeaseWork();
        // Without tracking the stop RPC the drain finds nothing outstanding and
        // the writer lock goes while the handover is still in progress.
        expect(handoverFinished).toBe(true);
    });
});

describe('a stop obligation survives a lease renewal', () => {
    async function refusedExpiryStop() {
        let accept = false;
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: accept, detail: 'x' }),
            requestStop: async (input) => {
                stops.push(input);
                return accept ? { requested: true, detail: 'ok' } : { requested: false, detail: 'down' };
            },
        };
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;
        const expiry = await handlers.runLeaseMaintenance();
        expect(expiry.actionRequired).toBe(true);
        return { stops, acceptFrom: () => { accept = true; } };
    }

    it('keeps retrying after a same-epoch renewal extends the deadline', async () => {
        const ctx = await refusedExpiryStop();
        const beforeRenewal = ctx.stops.length;

        await handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        expect(handlers.isLeaseValid()).toBe(true);

        // The obligation was already recorded; a renewal restores the right to
        // run new work, not the right to forget a stop that was refused.
        ctx.acceptFrom();
        const tick = await handlers.runLeaseMaintenance();
        expect(ctx.stops.length).toBeGreaterThan(beforeRenewal);
        expect(tick.pendingStopsRetried).toBe(1);
    });

    it('stops retrying once the receipt reaches a trusted terminal state', async () => {
        const ctx = await refusedExpiryStop();
        runtime.store.update(OP_KEY, { state: 'stopped' }, wallClock);
        const before = ctx.stops.length;
        const tick = await handlers.runLeaseMaintenance();
        expect(ctx.stops.length).toBe(before);
        expect(tick.pendingStopsRetried).toBe(0);
    });

    it('does not treat a recorded stop request as a termination', async () => {
        const ctx = await refusedExpiryStop();
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        if (stored.kind === 'ok') {
            expect(stored.receipt.stopRequestedAt).not.toBeNull();
            // Requested is not terminated: the receipt must not have moved to a
            // terminal state on the strength of an unaccepted handover.
            expect(stored.receipt.state).not.toBe('stopped');
        }
        expect(ctx.stops.length).toBeGreaterThan(0);
    });

    it('reports the outstanding obligation while the lease is valid', async () => {
        await refusedExpiryStop();
        await handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        const tick = await handlers.runLeaseMaintenance();
        expect(tick.expired).toBe(false);
        expect(tick.actionRequired).toBe(true);
    });
});

describe('maintenance reports what it could not read', () => {
    it('requires action when the receipt store is unreadable under a valid lease', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        await grantLease();
        const { writeFileSync } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const { managedReceiptFileName } = await import('./managedReceiptStore');
        writeFileSync(joinPath(root, 'receipts', managedReceiptFileName(OP_KEY)), '{broken');

        const tick = await handlers.runLeaseMaintenance();
        // A store we cannot read may hold a pending stop; reporting all-clear
        // would drop that obligation silently.
        expect(tick.expired).toBe(false);
        expect(tick.actionRequired).toBe(true);
        expect(tick.storeUnreadable).toBe(true);
    });

    it('asks the backend once per attempt in a tick, not twice', async () => {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        await handlers.runLeaseMaintenance();
        const first = stops.length;
        await handlers.runLeaseMaintenance();
        // The pending pass and the expiry pass must not both hand over the
        // same attempt within one tick.
        expect(first).toBe(1);
        expect(stops.length - first).toBe(1);
    });
});

describe('epoch promotion rests on the backend proof, not on local pid guesses', () => {
    /**
     * A stale receipt keeps a numeric pgid. The kernel may have handed that
     * number to something unrelated, so what the local probe sees about it says
     * nothing about the generation being fenced.
     */
    async function staleReceiptFrom(observation: 'alive' | 'eperm', proven: boolean) {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven, detail: proven ? 'provider stopped' : 'unproven' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        await grantLease({ renewalSeq: 1, epoch: 0 });
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        if (observation === 'alive') livePgids.add(4242);
        else {
            runtime.processGroupDeps!.kill = () => {
                throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            };
        }
        killed.length = 0;
        return { stops };
    }

    function promote(overrides: Record<string, unknown> = {}) {
        return handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000, ...overrides,
        }));
    }

    it('promotes when the backend proved the generation stopped, though a reused pgid still looks alive', async () => {
        await staleReceiptFrom('alive', true);
        const result = await promote();
        expect(result).toMatchObject({ ok: true, epoch: 1, fenced: true });
        // Unconditional: a lease that came back `unknown` would otherwise slip
        // through as a pass.
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 1 } });
    });

    it('promotes when the local probe cannot even see the group (EPERM)', async () => {
        await staleReceiptFrom('eperm', true);
        const result = await promote();
        expect(result).toMatchObject({ ok: true, epoch: 1 });
    });

    it('still refuses when the backend cannot prove it', async () => {
        await staleReceiptFrom('alive', false);
        await expect(promote()).rejects.toThrowError(/fence-proof-unavailable/);
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 0 } });
    });

    it('still refuses while a spawn is reaching the launcher', async () => {
        await staleReceiptFrom('alive', true);
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        // Resolves once the launcher has actually been entered, so the
        // promotion below races a real in-flight spawn rather than a guess
        // about how many microtasks that takes.
        let launcherEntered!: () => void;
        const inLauncher = new Promise<void>((resolve) => { launcherEntered = resolve; });
        spawnResult = () => new Promise((resolve) => {
            release = resolve;
            launcherEntered();
        });
        const other = handlers.spawn({
            token: mint('spawn', envelope(), { runId: 'run-2', attemptId: 'a-2' }),
            params: envelope(),
        });
        await inLauncher;

        try {
            await expect(promote()).rejects.toThrowError(/fence-incomplete/);
        } finally {
            release({ type: 'success', sessionId: 's', pid: 5555 });
            await Promise.allSettled([other]);
        }
    });

    it('still refuses a token that aged out during the proof', async () => {
        await staleReceiptFrom('alive', true);
        runtime.fencingBackend!.proveGenerationStopped = async () => {
            wallClock += 300_000;
            return { proven: true, detail: 'ok' };
        };
        await expect(promote()).rejects.toThrowError(/token-expired/);
    });

    it('still refuses a renewal sequence that did not advance', async () => {
        await staleReceiptFrom('alive', true);
        await expect(promote({ renewalSeq: 1 })).rejects.toThrowError(/stale-renewal/);
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 0 } });
    });

    it('still refuses when the receipt store cannot be read in full', async () => {
        await staleReceiptFrom('alive', true);
        const { writeFileSync } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const { managedReceiptFileName } = await import('./managedReceiptStore');
        writeFileSync(joinPath(root, 'receipts', managedReceiptFileName(OP_KEY)), '{broken');
        await expect(promote()).rejects.toThrowError(/fence-incomplete/);
    });

    it('reports the local observation as diagnostics without acting on it', async () => {
        const ctx = await staleReceiptFrom('alive', true);
        const result = await promote();
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 1 } });
        // Useful for an operator; never a veto, and never a reason to signal a
        // pid this process does not own.
        expect(result.localEvidence.length).toBeGreaterThan(0);
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
        expect(ctx.stops.length).toBeGreaterThan(0);
    });
});

/**
 * Reading a runtime's status, and granting it a lease before it has a run.
 *
 * The parent asks both before it will dispatch anything, and both happen
 * before an attempt exists — so neither can name one. Reading changes nothing;
 * granting goes through the same fencing path the run-scoped lease uses.
 */
describe('managed status and runtime lease', () => {
    /** Provisioning-scoped tokens carry no run or attempt at all. */
    function provisioningToken(over: Record<string, unknown>): string {
        const body = {
            v: 1, kid: 'kid-1', aud: 'runtime-1',
            workspaceId: 'ws-1', projectId: 'proj-1',
            requestKey: 'client-request-key',
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW, exp: NOW + 60_000,
            ...over,
        };
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
    }

    function statusToken(over: Record<string, unknown> = {}) {
        return provisioningToken({
            op: 'status', provisioningOperationId: 'op-1', epoch: 0, ...over,
        });
    }

    it('answers with the runtime facts, without touching the lease', async () => {
        const before = runtime.store.readLease();
        const response = await handlers.status({ token: statusToken(), params: {} });

        expect(response).toMatchObject({
            version: 1,
            identity: expect.objectContaining({
                runtimeId: 'runtime-1',
                happyMachineId: 'machine-1',
                provisioningOperationId: 'op-1',
            }),
        });
        // Asking is not a renewal: the stored lease is untouched.
        expect(runtime.store.readLease()).toEqual(before);
    });

    it('answers for a runtime that has never held an epoch', async () => {
        const response = await handlers.status({ token: statusToken(), params: {} });
        expect(response.epoch).toBe(0);
        expect(response.leaseRemainingMs).toBe(0);
    });

    it('refuses a status token minted for another provisioning operation', async () => {
        // Refused, and named: the operation is what ties a status token to
        // this runtime's generation now that it carries no epoch gate.
        await expect(handlers.status({
            token: statusToken({ provisioningOperationId: 'op-other' }),
            params: {},
        })).rejects.toThrow(/wrong-operation/);
    });

    it.each([
        ['another project', { projectId: 'proj-other' }, /wrong-project/],
        ['a key this runtime does not know', { kid: 'kid-other' }, /unknown-key/],
    ])('refuses a status token minted for %s', async (_name, over, expected) => {
        // The verifier binds audience and workspace, not project or key id.
        // Those are this runtime's trusted identity, and the run-scoped path
        // has always checked them — the provisioning-scoped path did not, so
        // the same signer could have a token for a sibling project accepted
        // here.
        await expect(handlers.status({ token: statusToken(over), params: {} }))
            .rejects.toThrow(expected);
    });

    it.each([
        ['another project', { projectId: 'proj-other' }, /wrong-project/],
        ['a key this runtime does not know', { kid: 'kid-other' }, /unknown-key/],
    ])('refuses a runtime-lease token minted for %s, changing nothing', async (
        _name, over, expected,
    ) => {
        // A lease is a write. Refused before anything is written, so the
        // stored lease is exactly what it was.
        const before = runtime.store.readLease();
        await expect(handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                epoch: 1,
                renewalSeq: 1,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 3_600_000,
                ...over,
            }),
            params: {},
        })).rejects.toThrow(expected);
        expect(runtime.store.readLease()).toEqual(before);
    });

    it('returns the absolute expiry it actually applied', async () => {
        /*
         * The parent bounds the deadline it publishes by this value. Without
         * it the parent knows only what it asked for, and a deadline taken
         * from the request rather than from the grant is a lease that outlives
         * what this runtime agreed to.
         *
         * The cross-repo half of this check — that the parent's reader accepts
         * exactly this reply — lives outside this repository. A test here that
         * imported the parent's parser would break every standalone clone.
         */
        await grantLease();
        const reply = await handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                // Same epoch the stored lease already holds: no promotion, so
                // the ordinary grant path runs without a fencing backend.
                epoch: 0,
                renewalSeq: 9,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 120_000,
            }),
            params: {},
        });

        expect(reply).toMatchObject({
            ok: true,
            epoch: 0,
            renewalSeq: 9,
            fenced: false,
            absoluteExpiry: NOW + 120_000,
        });
        // Every field the wire contract names is present — a missing one is
        // read as a malformed reply by whoever consumes it.
        for (const field of [
            'ok', 'epoch', 'renewalSeq', 'grantedMs', 'fenced', 'localEvidence', 'absoluteExpiry',
        ]) {
            expect(reply).toHaveProperty(field);
        }
    });

    it('grants a lease to a runtime with no run, and fences when it promotes', async () => {
        await expect(handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                epoch: 1,
                renewalSeq: 1,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 3_600_000,
            }),
            params: {},
        // No fencing backend is wired, so a promotion cannot be proven and the
        // grant is refused rather than taken on trust — the same refusal the
        // run-scoped lease gives, because it is the same code.
        })).rejects.toThrow(/fence-proof-unavailable/);
    });
});
