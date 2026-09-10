/**
 * The managed RPC surface, and the refusals that keep the legacy surface shut.
 *
 * Registration is the advertisement: these handlers exist only on a runtime
 * whose provisioning and isolation were verified, so a BYOS machine never
 * announces them and a server probing for them gets "RPC method not available".
 *
 * Two invariants run through every handler:
 *   - Nothing executes before the durable receipt for it exists.
 *   - No answer claims more than was observed. `managed:stop` returns that a
 *     stop was accepted and what was seen locally, never that a session ended.
 */

import { buildManagedRuntimeStatus } from '@/managed/managedRuntimeStatus';
import type { ManagedFilesystemFacts } from '@/managed/managedRuntimeFacts';
import type { ManagedRestoreState } from '@/managed/managedRestoreState';
import {
    canonicalManagedPayloadDigest,
    verifyManagedDispatchToken,
    type ManagedOp,
    type ManagedRunTokenClaims,
    type ManagedRuntimeLeaseTokenClaims,
    type ManagedStatusTokenClaims,
} from './managedDispatchToken';
import {
    classifyManagedReceipt,
    managedOperationKey,
    type ManagedReceipt,
    type ManagedReceiptStore,
} from './managedReceiptStore';
import {
    probeProcessGroup,
    type ProcessGroupDeps,
    type ProcessGroupEvidence,
} from './managedProcessGroup';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';
import { logger } from '@/ui/logger';
import {
    ManagedSpawnEnvelopeError,
    parseManagedSpawnEnvelope,
    type ManagedSpawnEnvelope,
} from '@/managed/managedSpawnBootstrap';

export const MANAGED_RPC_METHODS = [
    'managed:spawn', 'managed:stop', 'managed:receipt', 'managed:lease',
] as const;

export type ManagedSpawnRequest = {
    directory: string;
    agent?: string;
    environmentVariables?: Record<string, string>;
    initialPrompt?: string;
    initialPromptLocalId?: string;
    /**
     * The rest of the bootstrap envelope, which arrives **flat** in this same
     * object: `model`, `effort`, `bootstrap`, `gateway`.
     *
     * Not nested under a field of its own, because the parent already signs
     * this shape — `buildManagedSpawnParams` returns exactly these keys at the
     * top level and the dispatcher forwards them unchanged. Introducing a
     * wrapper here would have rejected every real spawn while every test that
     * built its own request still passed.
     *
     * Left off this type on purpose: the fields are untrusted input and are
     * only ever read through `parseManagedSpawnEnvelope`, which is what gives
     * them a type. They carry a scoped bearer and the session's raw key, so
     * they are never logged, never put in an environment, and never echoed in
     * a failure.
     */
};

export type ManagedSpawnOutcome =
    | { type: 'success'; sessionId: string; pid: number }
    /**
     * `started: false` is the only evidence that lets a run be recorded as
     * failed. Without it the child may already exist, so the receipt stays
     * uncertain and reconcilable rather than closed.
     */
    | { type: 'error'; errorMessage: string; started: false }
    | { type: 'error'; errorMessage: string; started?: undefined };

/**
 * What the launcher is told about the request, taken from the verified token
 * and never from the caller-supplied params. A privileged launcher (T09) needs
 * this to check the in-flight epoch and any stop tombstone atomically with the
 * exec it performs; `request` alone cannot be trusted for that.
 */
export type ManagedSpawnContext = {
    operationKey: string;
    runId: string;
    attemptId: string;
    epoch: number;
    workspaceId: string;
    projectId: string;
    /** Monotonic instant after which this runtime may no longer write. */
    leaseExpiresMonotonic: number;
    /**
     * The envelope, validated here and **re-serialized from what was parsed**.
     *
     * The launcher parses it again on its own side — it does not trust this
     * process — and re-serializing the parsed value is what makes the two
     * parses see the same document: a field this runtime did not validate
     * cannot ride along inside the bytes that cross that boundary.
     */
    bootstrapEnvelope: Buffer;
    /** The same content, parsed. For routing decisions here; never logged. */
    envelope: ManagedSpawnEnvelope;
};

export type ManagedRuntime = {
    identity: ManagedRuntimeIdentity;
    store: ManagedReceiptStore;
    /** Performs the actual spawn. Must return the child's pid on success. */
    spawn: (request: ManagedSpawnRequest, context: ManagedSpawnContext) => Promise<ManagedSpawnOutcome>;
    isPidAlive: (pid: number) => boolean;
    now: () => number;
    /** Monotonic clock. Wall-clock jumps must not extend a write lease. */
    monotonicNow: () => number;
    processGroupDeps?: ProcessGroupDeps;
    /**
     * What the runtime can say about itself, gathered from things it cannot
     * talk itself into: the kernel's mount view, the root-protected completion
     * record, and the isolation backend's own answer.
     *
     * Absent until the boot producer has run, and then a status read reports
     * what it found rather than guessing.
     */
    runtimeFacts?: () => {
        filesystem: ManagedFilesystemFacts;
        restore: ManagedRestoreState;
        isolation: { verified: boolean; backend: string };
    };
    /**
     * The privileged launch backend. It is the only thing that can prove a
     * previous generation is gone, and the only thing that can stop a child
     * running under the agent uid. T09 provides it; until then it is absent and
     * every path that needs it fails closed.
     */
    fencingBackend?: {
        proveGenerationStopped: (input: { belowEpoch: number }) => Promise<{ proven: boolean; detail: string }>;
        /**
         * Addressed by the identifiers that outlive this process. A pgid is a
         * number that the kernel may have reused, and means nothing to a
         * backend that survives a daemon restart.
         */
        requestStop: (input: {
            runId: string; attemptId: string; epoch: number; pgid: number | null;
        }) => Promise<BackendStopResult>;
    };
};

/** Whether the trusted backend accepted the stop. `false` is never discarded. */
export type BackendStopResult = { requested: boolean; detail: string };

type RpcRegistrar = { registerHandler: (method: string, handler: (params: unknown) => unknown) => void };

/** Refusals the caller can act on, distinct from a crash. */
export class ManagedRpcError extends Error {
    constructor(readonly code: string, detail?: string) {
        // The code leads so a caller can branch on it without parsing prose,
        // and the detail is only ever a short classifier — never provider text.
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'ManagedRpcError';
    }
}

function receiptView(receipt: ManagedReceipt, runtime: ManagedRuntime) {
    return {
        operationKey: receipt.requestKey,
        runId: receipt.runId,
        attemptId: receipt.attemptId,
        state: receipt.state,
        epoch: receipt.epoch,
        sessionId: receipt.sessionId,
        stopRequested: receipt.stopRequestedAt !== null,
        certainty: classifyManagedReceipt(receipt, runtime.isPidAlive),
        updatedAt: receipt.updatedAt,
    };
}

export function createManagedRpcHandlers(runtime: ManagedRuntime) {

    /**
     * The usable write deadline lives only in memory, on a monotonic clock. A
     * restart therefore starts expired and the runtime must obtain a freshly
     * signed lease before it may execute anything.
     */
    let leaseUntilMonotonic: number | null = null;

    const leaseValid = () => leaseUntilMonotonic !== null && runtime.monotonicNow() < leaseUntilMonotonic;

    const clampLease = (leaseMs: number, absoluteExpiry: number): number =>
        Math.max(0, Math.min(leaseMs, absoluteExpiry - runtime.now()));

    const storedLease = () => {
        const lease = runtime.store.readLease();
        if (lease.kind === 'unknown') {
            // Falling back to epoch 0 / seq 0 would re-accept a spent renewal.
            throw new ManagedRpcError('lease-state-unreadable', lease.detail);
        }
        return lease.kind === 'absent'
            ? { epoch: 0, renewalSeq: 0 }
            : { epoch: lease.record.epoch, renewalSeq: lease.record.renewalSeq };
    };

    /**
     * The two axes the verifier cannot check for us.
     *
     * Audience and workspace are bound inside the token; project and key id are
     * this runtime's trusted identity, read from the protected marker. A token
     * minted for a sibling project — or by a key this runtime does not know —
     * verifies perfectly and still belongs to something else.
     *
     * Shared by both entry points on purpose. The provisioning-scoped path
     * used to omit them, so the same signer could take a `runtime-lease` for
     * one project and have it accepted by another runtime in the same
     * workspace: two implementations of one check are two checks that can
     * disagree, and this pair already had.
     */
    const assertRuntimeIdentityClaims = (claims: { projectId: string; kid: string }): void => {
        if (claims.projectId !== runtime.identity.projectId) {
            throw new ManagedRpcError('token-wrong-project');
        }
        if (claims.kid !== runtime.identity.keyId) {
            throw new ManagedRpcError('token-unknown-key');
        }
    };

    /**
     * Verifies a token for an operation that acts on a run.
     *
     * The return type is the run-scoped half of the claim union, so a caller
     * reading `runId` cannot be handed a status token — the separation the
     * token format enforces on the wire is the same one the type enforces
     * here, rather than something each call site has to remember.
     */
    const verify = (op: ManagedRunTokenClaims['op'], params: unknown): ManagedRunTokenClaims => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw new ManagedRpcError('malformed-request');
        }
        const record = params as Record<string, unknown>;
        const token = record.token;
        if (typeof token !== 'string') throw new ManagedRpcError('malformed-request');
        const payload = record.params ?? {};
        const result = verifyManagedDispatchToken({
            token,
            verifier: runtime.identity.verifier,
            runtimeId: runtime.identity.runtimeId,
            workspaceId: runtime.identity.workspaceId,
            op,
            paramsDigest: canonicalManagedPayloadDigest(payload),
            currentEpoch: storedLease().epoch,
            provisioningOperationId: runtime.identity.provisioningOperationId,
            now: runtime.now(),
        });
        if (!result.ok) throw new ManagedRpcError(`token-${result.reason}`);
        if (result.claims.op === 'status' || result.claims.op === 'runtime-lease'
            || result.claims.op === 'checkpoint') {
            // Unreachable while `op` is run-scoped — the verifier already
            // refuses a mismatched op — and stated rather than cast away.
            throw new ManagedRpcError('token-wrong-op');
        }
        assertRuntimeIdentityClaims(result.claims);
        return result.claims;
    };


    /**
     * One serial section for renewal, epoch promotion and expiry handling.
     *
     * They all decide what this runtime may write, so interleaving them lets an
     * expiry that started before a renewal stop a child the renewal has just
     * made legitimate again. `pendingLeaseWork` is the count of operations that
     * have entered or are queued for the section, so teardown can wait for all
     * of them rather than only the most recent.
     */
    let leaseChain: Promise<unknown> = Promise.resolve();
    let transitioning = false;
    /** True while expired work is being handed to the backend. */
    let expiryHandling = false;
    let pendingLeaseWork = 0;
    /**
     * Spawns between admission and the launcher returning. This window is what
     * an epoch promotion must not cut across, so it is deliberately narrower
     * than the whole RPC.
     */
    let spawnsInFlight = 0;
    /**
     * Whole RPCs — spawn *and* explicit stop — including the bookkeeping and
     * backend handover that follows. Teardown waits on these: `spawnsInFlight`
     * alone would let the writer lock go while a handover was still running,
     * and a stop RPC has no launcher window to be counted by at all.
     */
    const activeRpcs = new Set<Promise<unknown>>();

    /**
     * Set when shutdown begins. Refusing new *entries* is a different thing
     * from revoking *store writes*: work that is already inside must still be
     * able to record what it did, or a launch that succeeded is left looking
     * like it never finished.
     */
    let entriesClosed = false;

    const assertEntryOpen = () => {
        if (entriesClosed) throw new ManagedRpcError('shutting-down');
    };

    /** Tracks an RPC end to end so teardown can wait for it. */
    const trackRpc = <T>(work: Promise<T>): Promise<T> => {
        activeRpcs.add(work);
        return work.finally(() => { activeRpcs.delete(work); });
    };

    const serializeLease = <T>(work: () => Promise<T>): Promise<T> => {
        pendingLeaseWork += 1;
        const next = leaseChain.then(work, work).finally(() => { pendingLeaseWork -= 1; });
        leaseChain = next.then(() => undefined, () => undefined);
        return next;
    };

    const NO_BACKEND: BackendStopResult = { requested: false, detail: 'no-launch-backend' };

    /**
     * States that carry evidence nothing is running any more.
     *
     * `stopping` is not one of them: a stop was requested, which is not the
     * same as a stop having happened, and treating it as terminal is how an
     * obligation quietly disappears.
     */
    const isTrustedTerminal = (receipt: ManagedReceipt): boolean => (
        receipt.state === 'stopped'
        || receipt.state === 'tombstone'
        || (receipt.state === 'failed' && receipt.failureReason === 'not-started')
    );

    /**
     * Asks the trusted backend to stop one attempt, and observes locally.
     *
     * The request is always made — a receipt with no pgid is a `spawning` row
     * that may have a live child nobody wrote down, and an `EPERM` probe means
     * the group is alive under another uid. Skipping either is how a child
     * outlives its Run.
     *
     * This process never signals the group itself. A persisted pid is a number
     * the kernel may have handed to something else since, so it is evidence
     * about what is visible, never authority to kill.
     */
    const stopAttempt = async (receipt: ManagedReceipt): Promise<{
        evidence: ProcessGroupEvidence;
        backendStop: BackendStopResult;
    }> => {
        const evidence = receipt.pgid === null
            ? { kind: 'no-local-trace' as const }
            : probeProcessGroup(receipt.pgid, runtime.processGroupDeps);
        if (!runtime.fencingBackend) return { evidence, backendStop: NO_BACKEND };
        const backendStop = await runtime.fencingBackend.requestStop({
            runId: receipt.runId,
            attemptId: receipt.attemptId,
            epoch: receipt.epoch,
            pgid: receipt.pgid,
        });
        return { evidence, backendStop };
    };

    /**
     * Accepts a request at most once. A retry of the same attempt returns the
     * existing receipt without starting anything; an intentional new attempt
     * arrives under a different operation key.
     */
    const spawnRpc = async (params: unknown) => {
            assertEntryOpen();
            const claims = verify('spawn', params);
            if (!leaseValid()) throw new ManagedRpcError('lease-expired');
            // An epoch transition is in progress; starting work now would race
            // the fence it is trying to establish.
            if (transitioning || expiryHandling) {
                throw new ManagedRpcError('epoch-transition-in-progress');
            }

            const payloadDigest = canonicalManagedPayloadDigest(
                (params as Record<string, unknown>).params ?? {},
            );
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });

            /** A duplicate is only a retry when its scope and payload match. */
            const asDuplicate = (receipt: ManagedReceipt) => {
                if (receipt.state === 'tombstone') {
                    // A stop reached the runtime before this dispatch did.
                    throw new ManagedRpcError('stopped-before-dispatch');
                }
                const sameScope = receipt.workspaceId === claims.workspaceId
                    && receipt.projectId === claims.projectId
                    && receipt.runId === claims.runId
                    && receipt.attemptId === claims.attemptId
                    && receipt.epoch === claims.epoch;
                // Answering a different payload with the first result would
                // merge two distinct requests into one outcome.
                if (!sameScope || (receipt.spawnPayloadDigest !== null && receipt.spawnPayloadDigest !== payloadDigest)) {
                    throw new ManagedRpcError('operation-payload-conflict');
                }
                return {
                    accepted: true,
                    receipt: receiptView(receipt, runtime),
                    stopIntentRecorded: receipt.stopRequestedAt !== null,
                    backendStop: null as BackendStopResult | null,
                    terminationProven: false,
                };
            };

            const existing = runtime.store.read(key);
            if (existing.kind === 'unknown') {
                throw new ManagedRpcError('reconciliation-required', existing.detail);
            }
            if (existing.kind === 'ok') return asDuplicate(existing.receipt);

            const claimed = runtime.store.claim({
                requestKey: key,
                runId: claims.runId,
                attemptId: claims.attemptId,
                epoch: claims.epoch,
                workspaceId: claims.workspaceId,
                projectId: claims.projectId,
                spawnPayloadDigest: payloadDigest,
                now: runtime.now(),
            });
            if (claimed.kind === 'corrupt') throw new ManagedRpcError('reconciliation-required', 'corrupt receipt');
            if (claimed.kind === 'exists') return asDuplicate(claimed.receipt);

            const request = ((params as Record<string, unknown>).params ?? {}) as ManagedSpawnRequest;
            // Recorded *before* the spawn: a crash after this point is
            // uncertain and must go to reconciliation rather than be retried.
            runtime.store.update(key, { state: 'spawning', spawnAt: runtime.now() }, runtime.now());

            // Re-checked here because a fence may have begun while this request
            // was between admission and the launcher.
            if (transitioning || expiryHandling || !leaseValid()) {
                throw new ManagedRpcError('epoch-transition-in-progress');
            }

            /*
             * The envelope is validated **before** anything is launched, and
             * the failure says which field was wrong and nothing about its
             * value: this document holds a bearer and a session key.
             *
             * A refusal here leaves the receipt in `spawning`, which is the
             * honest state — the request was accepted and no child was started,
             * so a reconciliation pass decides what happened rather than this
             * path guessing.
             */
            let envelope: ManagedSpawnEnvelope;
            try {
                // The request **is** the envelope: the parent's signed wire.
                envelope = parseManagedSpawnEnvelope(request, runtime.now());
            } catch (error) {
                const field = error instanceof ManagedSpawnEnvelopeError ? error.field : 'envelope';
                runtime.store.update(key, {
                    state: 'failed', failureReason: 'not-started',
                }, runtime.now());
                throw new ManagedRpcError('spawn-rejected', `envelope: ${field}`);
            }

            // Everything the launcher is told comes from the verified token.
            const context: ManagedSpawnContext = {
                operationKey: key,
                // Only what parsed: see the field's own note.
                bootstrapEnvelope: Buffer.from(JSON.stringify(envelope), 'utf8'),
                envelope,
                runId: claims.runId,
                attemptId: claims.attemptId,
                epoch: claims.epoch,
                workspaceId: claims.workspaceId,
                projectId: claims.projectId,
                leaseExpiresMonotonic: leaseUntilMonotonic ?? 0,
            };

            let outcome: ManagedSpawnOutcome;
            spawnsInFlight += 1;
            try {
                outcome = await runtime.spawn(request, context);
            } catch {
                // No typed evidence that nothing started: a child may exist and
                // still be writing. The receipt stays `spawning` so a query or a
                // backend stop can still reach it. The original message is not
                // propagated — it carries paths, tokens and request content.
                throw new ManagedRpcError('reconciliation-required', 'spawn outcome unknown');
            } finally {
                spawnsInFlight -= 1;
            }

            if (outcome.type === 'error') {
                if (outcome.started === false) {
                    runtime.store.update(key, {
                        state: 'failed', failureReason: 'not-started',
                    }, runtime.now());
                    throw new ManagedRpcError('spawn-rejected');
                }
                throw new ManagedRpcError('reconciliation-required', 'spawn outcome unknown');
            }

            // The child is detached, so it leads its own process group. The pid
            // is recorded for observation only; stopping it belongs to the
            // trusted backend.
            const after = runtime.store.update(key, {
                state: 'running',
                pid: outcome.pid,
                pgid: outcome.pid,
                sessionId: outcome.sessionId,
            }, runtime.now());

            // A stop that arrived while the spawn was in flight is honoured now
            // that there is something to signal.
            if (after.stopRequestedAt !== null) {
                const { evidence, backendStop } = await stopAttempt(after);
                const stopped = runtime.store.update(key, { state: 'stopping' }, runtime.now());
                // `accepted` describes this spawn: the request was admitted and
                // a child was started. A backend that could not take the stop
                // does not turn that into a rejection — the run exists and the
                // caller must not read it as never-started.
                return {
                    accepted: true,
                    receipt: receiptView(stopped, runtime),
                    stopIntentRecorded: true,
                    backendStop: backendStop as BackendStopResult | null,
                    terminationProven: false,
                    localEvidence: evidence,
                };
            }
            // Uniform shape: a caller must not have to branch on field presence
            // to learn whether a stop was involved.
            return {
                accepted: true,
                receipt: receiptView(after, runtime),
                stopIntentRecorded: false,
                backendStop: null as BackendStopResult | null,
                terminationProven: false,
            };
    };

    /**
     * Accepts a stop. The answer reports the durable intent, whether the
     * backend took the handover, and that termination is unproven — it never
     * asserts that the session ended, because a child that called `setsid` is
     * invisible to every check available here.
     */
    const stopRpc = async (params: unknown) => {
            assertEntryOpen();
            const claims = verify('stop', params);
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });
            const existing = runtime.store.read(key);

            if (existing.kind === 'unknown') {
                throw new ManagedRpcError('reconciliation-required', existing.detail);
            }
            if (existing.kind === 'absent') {
                // The stop overtook the dispatch. A durable tombstone makes the
                // later spawn refuse instead of starting work that was cancelled.
                const tomb = runtime.store.tombstone({
                    requestKey: key,
                    runId: claims.runId,
                    attemptId: claims.attemptId,
                    epoch: claims.epoch,
                    workspaceId: claims.workspaceId,
                    projectId: claims.projectId,
                    now: runtime.now(),
                });
                if (tomb.kind === 'corrupt') throw new ManagedRpcError('reconciliation-required', 'corrupt receipt');
                // Nothing was ever started, so there is nothing to terminate.
                return {
                    stopIntentRecorded: true,
                    backendStop: { requested: true, detail: 'never-dispatched' },
                    terminationProven: true,
                    receipt: receiptView(tomb.receipt, runtime),
                };
            }

            const receipt = existing.receipt;
            if (receipt.state === 'spawning') {
                // No pid yet. The spawn path consumes this flag once it has one,
                // but a persisted `spawning` row from a previous process may
                // already have a live child, so the backend is asked as well.
                const marked = runtime.store.update(key, { stopRequestedAt: runtime.now() }, runtime.now());
                const { evidence, backendStop } = await stopAttempt(marked);
                return {
                    stopIntentRecorded: true,
                    backendStop,
                    terminationProven: false,
                    receipt: receiptView(marked, runtime),
                    localEvidence: evidence,
                };
            }
            if (receipt.state === 'stopped' || receipt.state === 'tombstone'
                || (receipt.state === 'failed' && receipt.failureReason === 'not-started')) {
                // Terminal with evidence that nothing is running: there is
                // nothing for the backend to stop.
                return {
                    stopIntentRecorded: true,
                    backendStop: { requested: true, detail: 'already-terminal' },
                    terminationProven: true,
                    receipt: receiptView(receipt, runtime),
                };
            }

            const marked = runtime.store.update(key, {
                state: 'stopping', stopRequestedAt: runtime.now(),
            }, runtime.now());
            const { evidence, backendStop } = await stopAttempt(marked);
            // Three separate facts, never collapsed:
            //   stopIntentRecorded — the receipt durably says "stop this"
            //   backendStop        — whether the launcher took the request
            //   terminationProven  — whether anything actually ended
            // Only cgroup emptiness or a provider stop can set the last one, so
            // it is false here regardless of what the local probe saw.
            return {
                stopIntentRecorded: true,
                backendStop,
                terminationProven: false,
                receipt: receiptView(marked, runtime),
                localEvidence: evidence,
            };
    };


    /**
     * Verifies a token bound to the provisioning operation rather than to a
     * run. Returns the provisioning half of the claim union, so a caller
     * reading `provisioningOperationId` cannot be handed a work token.
     */
    const verifyProvisioning = (
        op: 'status' | 'runtime-lease',
        params: unknown,
    ): ManagedStatusTokenClaims | ManagedRuntimeLeaseTokenClaims => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw new ManagedRpcError('malformed-request');
        }
        const record = params as Record<string, unknown>;
        const token = record.token;
        if (typeof token !== 'string') throw new ManagedRpcError('malformed-request');
        const result = verifyManagedDispatchToken({
            token,
            verifier: runtime.identity.verifier,
            runtimeId: runtime.identity.runtimeId,
            workspaceId: runtime.identity.workspaceId,
            op,
            paramsDigest: canonicalManagedPayloadDigest(record.params ?? {}),
            currentEpoch: storedLease().epoch,
            provisioningOperationId: runtime.identity.provisioningOperationId,
            now: runtime.now(),
        });
        if (!result.ok) throw new ManagedRpcError(`token-${result.reason}`);
        if (result.claims.op !== op) throw new ManagedRpcError('token-wrong-op');
        assertRuntimeIdentityClaims(result.claims);
        return result.claims;
    };

    /**
     * The one place a write lease is granted.
     *
     * Both lease operations reach it: the run-scoped `lease`, and the
     * `runtime-lease` a runtime is given before it has any run. They differ
     * only in what their claim is bound to — the serialization, the sequence
     * check and the fence that a promotion has to pass are the same code,
     * because two implementations of a fence are two fences that can disagree.
     */
    const applyLeaseClaims = (claims: {
        epoch: number;
        renewalSeq: number;
        leaseMs: number;
        absoluteExpiry: number;
        exp: number;
    }) => {
            assertEntryOpen();
            // Renewal and epoch transition are serialized: two interleaved
            // renewals could otherwise commit out of order and walk the
            // sequence backwards, which is exactly what replay protection
            // depends on not happening.
            return serializeLease(async () => {
                // Re-checked inside the queue: an operation ahead of this one
                // may have taken long enough for this token to age out, and a
                // future `absoluteExpiry` is not a substitute for a live token.
                if (claims.exp <= runtime.now()) throw new ManagedRpcError('token-expired');
                const stored = storedLease();
                // Checked inside the queue: a request minted at an older epoch
                // can arrive after a promotion committed, and writing it back
                // would reopen the generation that was just fenced.
                if (claims.epoch < stored.epoch) throw new ManagedRpcError('stale-epoch');
                if (claims.renewalSeq! <= stored.renewalSeq) throw new ManagedRpcError('stale-renewal');

                if (claims.epoch > stored.epoch) {
                    transitioning = true;
                    try {
                        // Raising the epoch opens a new writable generation.
                        // Nothing observable from inside this process can prove
                        // the previous one is gone — a child that called setsid
                        // is invisible here — so the promotion requires the
                        // privileged backend to say so. Without that backend the
                        // epoch and the deadline both stay where they are.
                        if (!runtime.fencingBackend) {
                            throw new ManagedRpcError('fence-proof-unavailable', 'no privileged launch backend');
                        }
                        const listing = runtime.store.list();
                        if (listing.listError || listing.unknown.length > 0) {
                            throw new ManagedRpcError('fence-incomplete', 'receipt store not fully readable');
                        }
                        // A receipt without a pgid is not evidence of nothing
                        // running: `spawning` means a child may exist whose pid
                        // was never recorded.
                        const live = listing.receipts.filter((receipt) => (
                            receipt.epoch < claims.epoch
                            && receipt.state !== 'stopped'
                            && receipt.state !== 'tombstone'
                            && !(receipt.state === 'failed' && receipt.failureReason === 'not-started')
                        ));
                        // Hand every prior-generation attempt to the backend,
                        // then let the backend say whether the generation is
                        // gone. The local probe is recorded alongside it, but
                        // it does not decide anything:
                        //
                        // a receipt keeps a numeric pgid, and the kernel may
                        // have since given that number to an unrelated process.
                        // Reading `alive` (or `EPERM`, which is the normal
                        // answer once agents run under their own uid) off such
                        // a number and refusing the promotion blocks the
                        // runtime forever on a coincidence, even when the
                        // authoritative backend has proven the generation
                        // stopped. Ownership is what makes an observation
                        // actionable, and this process has none here.
                        const evidence: ProcessGroupEvidence[] = [];
                        for (const receipt of live) evidence.push((await stopAttempt(receipt)).evidence);

                        const proof = await runtime.fencingBackend.proveGenerationStopped({
                            belowEpoch: claims.epoch,
                        });
                        if (!proof.proven) {
                            throw new ManagedRpcError('fence-proof-unavailable', proof.detail);
                        }

                        // Re-validated after the awaits above: another renewal
                        // may have committed, the token may have aged out, and
                        // a spawn admitted before the fence may still be
                        // reaching the launcher.
                        if (claims.exp <= runtime.now()) throw new ManagedRpcError('token-expired');
                        if (spawnsInFlight > 0) {
                            throw new ManagedRpcError('fence-incomplete', 'spawn in flight');
                        }
                        const latest = storedLease();
                        if (claims.renewalSeq! <= latest.renewalSeq || claims.epoch < latest.epoch) {
                            throw new ManagedRpcError('stale-renewal');
                        }
                        runtime.store.writeLease({
                            epoch: claims.epoch,
                            renewalSeq: claims.renewalSeq!,
                            updatedAt: runtime.now(),
                        });
                        const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                        leaseUntilMonotonic = runtime.monotonicNow() + grantedMs;
                        return {
                            ok: true,
                            epoch: claims.epoch,
                            renewalSeq: claims.renewalSeq,
                            grantedMs,
                            fenced: true,
                            localEvidence: evidence,
                            // The ceiling this grant was actually clamped by.
                            // Without it the parent knows only what it asked
                            // for, and publishing a deadline from the request
                            // rather than from the grant is how a lease outlives
                            // what this runtime agreed to.
                            absoluteExpiry: claims.absoluteExpiry,
                        };
                    } finally {
                        transitioning = false;
                    }
                }

                runtime.store.writeLease({
                    epoch: claims.epoch,
                    renewalSeq: claims.renewalSeq!,
                    updatedAt: runtime.now(),
                });
                const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                leaseUntilMonotonic = runtime.monotonicNow() + grantedMs;
                return {
                    ok: true,
                    epoch: claims.epoch,
                    renewalSeq: claims.renewalSeq,
                    grantedMs,
                    fenced: false,
                    localEvidence: [] as ProcessGroupEvidence[],
                    // Same reason as the promotion path: the parent must read
                    // the ceiling that was applied, not the one it sent.
                    absoluteExpiry: claims.absoluteExpiry,
                };
            });
    };

    return {
        /**
         * Reports what this runtime is, and what it currently holds.
         *
         * A reading. It renews nothing and advances nothing — the parent polls
         * it, including while a runtime is expired, and a reading that renewed
         * would make asking the way to stay alive.
         */
        status: async (params: unknown) => {
            verifyProvisioning('status', params);
            const facts = runtime.runtimeFacts?.() ?? {
                // Before the boot producer has run there is nothing to report
                // but the absence of it, and absence is not readiness.
                filesystem: { ok: false as const, reason: 'root-not-mounted' as const },
                restore: { status: 'pending' as const, checkpointId: null, manifestDigest: null },
                isolation: { verified: false, backend: runtime.identity.isolation.backend },
            };
            const stored = storedLease();
            return buildManagedRuntimeStatus({
                identity: runtime.identity,
                lease: {
                    epoch: stored.epoch,
                    renewalSeq: stored.renewalSeq,
                    // Read, never extended.
                    remainingMs: leaseUntilMonotonic === null
                        ? 0
                        : leaseUntilMonotonic - runtime.monotonicNow(),
                },
                filesystem: facts.filesystem,
                restore: facts.restore,
                isolation: facts.isolation,
            });
        },

        /**
         * Grants this runtime a lease before it has any run.
         *
         * The same serialized fencing path the run-scoped lease takes — a
         * promotion still has to prove the previous generation is gone. Only
         * what the claim is bound to differs.
         */
        'runtime-lease': async (params: unknown) => {
            const claims = verifyProvisioning('runtime-lease', params);
            if (claims.op !== 'runtime-lease') throw new ManagedRpcError('token-wrong-op');
            return applyLeaseClaims({
                epoch: claims.epoch,
                renewalSeq: claims.renewalSeq,
                leaseMs: claims.leaseMs,
                absoluteExpiry: claims.absoluteExpiry,
                exp: claims.exp,
            });
        },

        /** Tracked end to end so teardown waits for post-launch work too. */
        spawn(params: unknown) {
            return trackRpc(spawnRpc(params));
        },

        /**
         * Refuses further RPC entries. Store writes stay open so that work
         * already inside can finish; teardown revokes those separately once
         * `drainLeaseWork` reports everything settled.
         */
        closeEntries(): void {
            entriesClosed = true;
        },

        stop(params: unknown) {
            return trackRpc(stopRpc(params));
        },

        /** Durable receipt lookup — the only way to resolve a lost ACK. */
        receipt(params: unknown) {
            const claims = verify('query', params);
            // Only the run and attempt the token was signed for. A listing of
            // everything would let one signed query enumerate the workspace.
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });
            const found = runtime.store.read(key);
            if (found.kind === 'unknown') {
                return { receipts: [], unknown: [{ file: 'requested', detail: found.detail }] };
            }
            return {
                receipts: found.kind === 'ok' ? [receiptView(found.receipt, runtime)] : [],
                unknown: [],
            };
        },

        /**
         * Renews the write lease and, when the server raises the epoch, performs
         * the local part of fencing.
         *
         * A higher epoch is only persisted when nothing of the previous
         * generation is visible here. That is a necessary condition, not a
         * sufficient one: the server must still hold provider-level proof
         * (T09) before it treats the new generation as writable.
         */
        async lease(params: unknown) {
            const claims = verify('lease', params);
            if (claims.renewalSeq === undefined || claims.leaseMs === undefined
                || claims.absoluteExpiry === undefined) {
                throw new ManagedRpcError('malformed-request');
            }
            return applyLeaseClaims({
                epoch: claims.epoch,
                renewalSeq: claims.renewalSeq,
                leaseMs: claims.leaseMs,
                absoluteExpiry: claims.absoluteExpiry,
                exp: claims.exp,
            });
        },

        /**
         * What to do when the write lease runs out while children are still
         * running. Refusing new work is not enough — an agent turn started
         * before the expiry keeps writing.
         *
         * This asks the privileged backend to stop them. With no backend the
         * honest answer is that nothing here can, so it reports
         * `actionRequired` instead of a clean stop.
         */
        async runLeaseMaintenance() {
            return serializeLease(async () => {
            // One listing for the whole tick. Reading it twice would let the
            // two passes disagree, and reading only `receipts` would hide an
            // entry we could not parse — which may be exactly the pending stop
            // this pass exists to retry.
            const listing = runtime.store.list();
            const storeUnreadable = listing.unknown.length > 0 || listing.listError !== undefined;

            // A stop that was already decided is an obligation of its own. It
            // must be retried whether or not the lease is currently valid —
            // tying the retry to expiry means a stream of renewals can keep a
            // refused handover pending forever.
            const pendingStops = listing.receipts.filter((receipt) => (
                receipt.stopRequestedAt !== null && !isTrustedTerminal(receipt)
            ));
            const stillPending: string[] = [];
            /** Attempts already handed over in this tick, so neither pass repeats one. */
            const handedOver = new Set<string>();
            for (const receipt of pendingStops) {
                const { backendStop } = await stopAttempt(receipt);
                handedOver.add(receipt.requestKey);
                if (!backendStop.requested) stillPending.push(receipt.requestKey);
            }
            const pendingStopsRetried = pendingStops.length;

            // Re-read inside the section: a renewal queued ahead of this call
            // may have made the lease valid again, and stopping a child now
            // would kill work the server has just re-authorised.
            if (leaseValid()) {
                return {
                    expired: false,
                    launching: false,
                    // An obligation nobody accepted is still outstanding even
                    // while the runtime is allowed to work, and a store we
                    // could not read may hold one we never saw.
                    actionRequired: stillPending.length > 0 || storeUnreadable,
                    storeUnreadable,
                    live: [] as string[],
                    unstoppable: stillPending,
                    pendingStopsRetried,
                };
            }
            expiryHandling = true;
            try {
            // A receipt without a pgid is included on purpose: `spawning` means
            // a child may exist whose pid was never recorded, and skipping it
            // would leave exactly the case nobody can see.
            const live = listing.receipts.filter((receipt) => (
                receipt.state === 'spawning' || receipt.state === 'spawned'
                || receipt.state === 'running' || receipt.state === 'stopping'
            ));

            const handled: string[] = [];
            const unstoppable: string[] = [...stillPending];
            for (const receipt of live) {
                if (handedOver.has(receipt.requestKey)) {
                    // Already handed over by the pending pass in this tick.
                    handled.push(receipt.requestKey);
                    continue;
                }
                // Written before the handover so the intent survives a restart
                // in the middle of it. It is also what a spawn that is still
                // launching reads when it finishes, so a child that arrives
                // after its lease expired stops itself.
                const marked = receipt.stopRequestedAt === null
                    ? runtime.store.update(
                        receipt.requestKey, { stopRequestedAt: runtime.now() }, runtime.now(),
                    )
                    : receipt;
                const { backendStop } = await stopAttempt(marked);
                if (!backendStop.requested) unstoppable.push(marked.requestKey);
                handled.push(marked.requestKey);
            }

            // `no-local-trace` says only that nothing is visible from here, so
            // it can never clear this on its own. Only the backend's proof can.
            let proven = false;
            if (runtime.fencingBackend && live.length > 0) {
                const proof = await runtime.fencingBackend.proveGenerationStopped({
                    belowEpoch: Number.MAX_SAFE_INTEGER,
                });
                proven = proof.proven;
            }
            // A proof taken now says nothing about a child that has not been
            // created yet, so an outstanding launch keeps this unresolved.
            const launching = spawnsInFlight > 0;
            return {
                expired: true,
                launching,
                pendingStopsRetried,
                actionRequired: launching || storeUnreadable || unstoppable.length > 0
                    || (live.length > 0 && !proven),
                storeUnreadable,
                live: handled,
                unstoppable,
            };
            } finally {
                expiryHandling = false;
            }
            });
        },

        /**
         * Resolves once every queued or running lease operation has finished.
         * Teardown uses this so a stop or fence in progress cannot outlive the
         * writer lock it is holding.
         */
        async drainLeaseWork(): Promise<void> {
            // Spawn RPCs are drained too, in full: anything still running when
            // the writer lock is released would write into a store another
            // daemon may already own.
            while (pendingLeaseWork > 0 || activeRpcs.size > 0) {
                await Promise.allSettled([leaseChain, ...activeRpcs]);
            }
        },

        /** Exposed for wiring tests: is the runtime currently allowed to work? */
        isLeaseValid: leaseValid,
        probeGroup: (pgid: number) => probeProcessGroup(pgid, runtime.processGroupDeps),
    };
}

export type ManagedRpcHandlers = ReturnType<typeof createManagedRpcHandlers>;

/**
 * Refusal codes a caller may branch on. An allowlist, not a passthrough: an
 * unrecognised code reaches the wire without a `code` field so a typo here can
 * never be mistaken for a contract the server can act on.
 *
 * `token-*` mirrors `ManagedTokenFailure`, which `verify` prefixes.
 */
const WIRE_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'epoch-transition-in-progress',
    'fence-incomplete',
    'fence-proof-unavailable',
    'lease-expired',
    'lease-state-unreadable',
    'malformed-request',
    'operation-payload-conflict',
    'reconciliation-required',
    'shutting-down',
    'spawn-rejected',
    'stale-epoch',
    'stale-renewal',
    'stopped-before-dispatch',
    'token-malformed',
    'token-bad-signature',
    'token-wrong-audience',
    'token-wrong-workspace',
    'token-wrong-op',
    'token-expired',
    'token-clock-skew',
    'token-ttl-too-long',
    'token-stale-epoch',
    'token-epoch-mismatch',
    'token-payload-mismatch',
    // Thrown directly at :178/:181, not via the `token-${reason}` prefix.
    'token-wrong-project',
    'token-unknown-key',
]);

/**
 * The single classifier put on the wire for every managed refusal.
 *
 * `ManagedRpcError.message` is `code: detail`, and the detail — however short —
 * is not part of the contract. Shipping the message verbatim would make every
 * future detail string a wire field nobody reviewed.
 */
const MANAGED_REFUSAL_ERROR = 'managed dispatch refused';

/**
 * Code reported when the managed boundary cannot classify a failure. It is
 * deliberately not one of `WIRE_REFUSAL_CODES`: a caller must be able to tell
 * "the daemon refused for reason X" from "something failed and nobody knows
 * what", and must never read the second as the first.
 */
const MANAGED_UNKNOWN_CODE = 'managed-unknown-failure';

/**
 * Normalises **every** failure that escapes a managed handler.
 *
 * `RpcHandlerManager` turns a thrown error into `{ error: message }` on the
 * wire *and* logs `{ error }`. Rethrowing here would therefore publish whatever
 * an unexpected exception carries — a provider URL, a token, prompt text — and
 * break the safe-error promise this boundary exists to make. So nothing is
 * rethrown: managed refusals become their code, anything else becomes the
 * unknown classifier.
 *
 * Teaching the generic class about managed types would couple every BYOS caller
 * to the daemon's managed surface, so the conversion lives here instead and
 * emits the same `{ error, code }` shape the manager's own managed allowlist
 * rejection already uses. **BYOS handlers keep the existing fail path.**
 */
async function normalizeManagedRefusal<T>(
    run: () => T | Promise<T>,
): Promise<T | { error: string; code: string }> {
    try {
        // `await` covers both shapes: `receipt` answers synchronously while the
        // others are async, and a synchronous throw must be normalised too.
        return await run();
    } catch (error: unknown) {
        if (error instanceof ManagedRpcError && WIRE_REFUSAL_CODES.has(error.code)) {
            return { error: MANAGED_REFUSAL_ERROR, code: error.code };
        }
        // No `error.message`, no stack, no cause — not on the wire and not in
        // the log. A fixed line keeps the failure visible without carrying its
        // payload; the daemon's own diagnostics keep the detail locally.
        logger.debug('[managed] handler failed with an unclassified error');
        return { error: MANAGED_REFUSAL_ERROR, code: MANAGED_UNKNOWN_CODE };
    }
}

export function registerManagedRpcHandlers(
    registrar: RpcRegistrar,
    handlers: ManagedRpcHandlers,
): void {
    registrar.registerHandler('managed:spawn', (params) => normalizeManagedRefusal(() => handlers.spawn(params)));
    registrar.registerHandler('managed:stop', (params) => normalizeManagedRefusal(() => handlers.stop(params)));
    registrar.registerHandler('managed:receipt', (params) => normalizeManagedRefusal(() => handlers.receipt(params)));
    registrar.registerHandler('managed:lease', (params) => normalizeManagedRefusal(() => handlers.lease(params)));
    registrar.registerHandler('managed:status', (params) => normalizeManagedRefusal(() => handlers.status(params)));
    registrar.registerHandler('managed:runtime-lease', (params) => normalizeManagedRefusal(() => handlers['runtime-lease'](params)));
}

/**
 * The only RPC methods a managed runtime serves.
 *
 * An allowlist, not a denylist: a denylist silently admits every method added
 * later, and the point of this gate is that a future RPC cannot become a bypass
 * simply by existing.
 */
export const MANAGED_ALLOWED_RPCS: readonly string[] = [
    'managed:spawn',
    'managed:stop',
    'managed:receipt',
    'managed:lease',
    'managed:status',
    'managed:runtime-lease',
];

export class ManagedCapabilityError extends Error {
    readonly code = 'MANAGED_CAPABILITY_REQUIRED';
    constructor(method: string) {
        super(`${method} is not available on a managed runtime; use the managed dispatch RPCs`);
        this.name = 'ManagedCapabilityError';
    }
}

type RestrictableRegistrar = {
    setManagedAllowlist?: (methods: readonly string[]) => void;
};

/**
 * Fixes the served surface at the dispatch boundary.
 *
 * Rewriting individual registrations was not enough: anything registered after
 * such a sweep, and any path reaching a handler without going through
 * registration, would still be reachable. The manager itself refuses instead.
 *
 * Transports outside this manager — the loopback control server and the
 * terminal WebSocket — are gated at their own entry points.
 */
export function applyManagedRpcRestrictions(
    registrar: RestrictableRegistrar,
    allowed: readonly string[] = MANAGED_ALLOWED_RPCS,
): void {
    if (!registrar.setManagedAllowlist) {
        throw new Error('managed restrictions require a dispatch-level allowlist');
    }
    registrar.setManagedAllowlist(allowed);
}
