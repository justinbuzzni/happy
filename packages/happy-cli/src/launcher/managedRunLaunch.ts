/**
 * Starts a managed run: the tool broker first, then the provider that consumes
 * its plan.
 *
 * The two halves already exist — `startManagedToolSession` mints the grant and
 * opens the broker, `startManagedProviderRun` parks the provider and hands it
 * the plan — and neither can be the entry point on its own. Composing them is
 * what this file is for, and it owns three things that only make sense here.
 *
 * **The two sides do not share paths, and they must not.** The tool session's
 * `workloadPath` is the image's fixed, read-only program the executor helper
 * execs; `startManagedProviderRun`'s `workloadPath` is a script it **writes**
 * for this generation. Handing the same path to both makes the provider launch
 * overwrite the tool program — or fail against a read-only image, which is the
 * better of the two outcomes. So the provider gets a per-run path of its own,
 * under the state directory that the marker says this runtime owns.
 *
 * **The two helpers are two programs.** `execHelper` runs a generation under
 * the provider uid; `executorHelper` puts a tool in its own pid, mount and net
 * namespaces. They are not interchangeable, and a single `helperPath` argument
 * invites exactly that substitution.
 *
 * **Where the rest comes from.** The tool workload and the cgroup root are
 * properties of the image and of the marker, not arguments a caller supplies.
 * A caller that could choose the workload could choose the program the agent
 * becomes.
 *
 * **The two uids are two.** `planToolExecutorIsolation` refuses a shared uid
 * once it gets that far, but by then the broker is open; refusing here keeps a
 * misprovisioned marker from getting a listening port at all.
 *
 * **A half-started run is closed.** If the provider cannot be started, the
 * session that was already opened for it holds a live grant and a listening
 * port for a provider that will never arrive. It is closed on the way out, and
 * if that close cannot prove the tools stopped, the caller hears about it —
 * the generation cleanup upstream is the only thing that can act on it.
 *
 * This is not where a run is *decided*. That is the parent's call arriving over
 * RPC, and registering that method belongs to the daemon side.
 */
import { join } from 'node:path';

import { MANAGED_TOOL_WORKLOAD_PATH } from '@/managed/managedImagePackaging';

import {
    startManagedToolSession,
    type ManagedToolSession,
    type ManagedToolSessionInput,
} from './managedToolSession';
import { generationScopeDigest } from './generationManifest';
import {
    startManagedProviderRun,
    TRUSTED_LAUNCH_ROOT,
    type ManagedProviderRun,
} from './managedProviderRun';
import type { BrokerTool } from './toolBroker';

export type ManagedRunRequest = {
    agent: ManagedToolSessionInput['agent'];
    model: string;
    effort?: string;
    providerEnv: Record<string, string>;
    codexHome?: string;
    tools: BrokerTool[];
    scope: string[];
    ttlMs: number;
    toolTimeoutMs: number;
    terminationWaitMs?: number;
};

export type ManagedRunLaunchDeps = {
    startToolSession: typeof startManagedToolSession;
    startProviderRun: typeof startManagedProviderRun;
};

export async function launchManagedRun(input: {
    /** The active marker. Its isolation axes are the run's, not the caller's. */
    identity: Parameters<typeof startManagedProviderRun>[0]['identity'] & {
        isolation: {
            provider: { uid: number; gid: number };
            executor: { uid: number; gid: number };
            cgroupRoot: string;
        };
    };
    request: ManagedRunRequest;
    /** The generation's cgroup for this attempt and epoch. */
    cgroupPath: string;
    /** `executorHelper` — isolates one tool call. */
    toolHelperPath: string;
    /** `execHelper` — runs the provider generation. A different program. */
    providerHelperPath: string;
    execPath: string;
    key: Parameters<typeof startManagedProviderRun>[0]['key'];
    statusFd: number;
    releaseFd: number;
    leaseExpiresMonotonic: number;
    createSupervisor: Parameters<typeof startManagedProviderRun>[0]['createSupervisor'];
    writeFile: Parameters<typeof startManagedProviderRun>[0]['writeFile'];
    readProcEnviron: Parameters<typeof startManagedProviderRun>[0]['readProcEnviron'];
    register: Parameters<typeof startManagedProviderRun>[0]['register'];
    lstatPath: Parameters<typeof startManagedProviderRun>[0]['lstatPath'];
    inherit?: Parameters<typeof startManagedProviderRun>[0]['inherit'];
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /** Shared with the checkpoint runner, so writes and archives use one gate. */
    checkpointDrain?: ManagedToolSessionInput['checkpointDrain'];
    executorDeps?: ManagedToolSessionInput['executorDeps'];
    monotonicNow?: () => number;
    deps?: Partial<ManagedRunLaunchDeps>;
}): Promise<{ session: ManagedToolSession; run: ManagedProviderRun }> {
    const deps: ManagedRunLaunchDeps = {
        startToolSession: input.deps?.startToolSession ?? startManagedToolSession,
        startProviderRun: input.deps?.startProviderRun ?? startManagedProviderRun,
    };
    const isolation = input.identity.isolation;
    if (isolation.provider.uid === isolation.executor.uid) {
        throw new Error('managed run requires separate provider and executor uids');
    }
    if (input.toolHelperPath === input.providerHelperPath) {
        throw new Error('managed run requires separate tool and provider helpers');
    }

    // One name per generation, in the trusted directory the helper will accept
    // — never the image's tool program.
    //
    // `generationScopeDigest` is the ledger's own name for a generation, and
    // reusing it is the point: a second scheme for the same thing is a second
    // place for two generations to end up sharing a name. It also refuses an
    // unsafe id — and it is called **here**, before the session opens and long
    // before a script is written, so a bad key costs nothing rather than
    // leaving a broker listening and a file on disk.
    const providerScriptPath = join(
        TRUSTED_LAUNCH_ROOT,
        `provider-exec-${generationScopeDigest(input.key).slice(0, 32)}`,
    );
    if (providerScriptPath === MANAGED_TOOL_WORKLOAD_PATH) {
        throw new Error('provider script path must not be the tool workload');
    }

    const session = await deps.startToolSession({
        agent: input.request.agent,
        model: input.request.model,
        effort: input.request.effort,
        providerEnv: input.request.providerEnv,
        codexHome: input.request.codexHome,
        tools: input.request.tools,
        scope: input.request.scope,
        ttlMs: input.request.ttlMs,
        toolTimeoutMs: input.request.toolTimeoutMs,
        terminationWaitMs: input.request.terminationWaitMs,
        identity: { provider: isolation.provider, executor: isolation.executor },
        cgroupPath: input.cgroupPath,
        helperPath: input.toolHelperPath,
        workloadPath: MANAGED_TOOL_WORKLOAD_PATH,
        onUnprovenTermination: input.onUnprovenTermination,
        checkpointDrain: input.checkpointDrain,
        executorDeps: input.executorDeps,
        monotonicNow: input.monotonicNow,
    });

    try {
        const run = await deps.startProviderRun({
            createSupervisor: input.createSupervisor,
            session,
            key: input.key,
            statusFd: input.statusFd,
            releaseFd: input.releaseFd,
            leaseExpiresMonotonic: input.leaseExpiresMonotonic,
            writeFile: input.writeFile,
            onUnprovenTermination: input.onUnprovenTermination,
            readProcEnviron: input.readProcEnviron,
            register: input.register,
            inherit: input.inherit,
            cgroupRoot: isolation.cgroupRoot,
            helperPath: input.providerHelperPath,
            identity: { provider: isolation.provider },
            workloadPath: providerScriptPath,
            execPath: input.execPath,
            lstatPath: input.lstatPath,
        });
        return { session, run };
    } catch (error) {
        // The session outlives this function only when a provider is holding
        // it. Nothing is holding it now.
        const proof = await session.close().catch(() => ({ proven: false, detail: 'close failed' }));
        if (!proof.proven) {
            input.onUnprovenTermination({ tool: 'session', detail: proof.detail });
        }
        throw error;
    }
}
