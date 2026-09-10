import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_AUTONOMOUS_GATE_OUTPUT_BYTES,
    runAutonomousQualityGatePhase,
} from './autonomousQualityGateRunner';

const phase = (command: string, timeoutMs = 5_000) => ({
    name: 'test' as const,
    command,
    timeoutMs,
});

describe('runAutonomousQualityGatePhase', () => {
    it('reports pass and non-zero failure with separate output tails', async () => {
        await expect(runAutonomousQualityGatePhase(phase('printf passed'), { cwd: process.cwd() }))
            .resolves.toMatchObject({ status: 'passed', exitCode: 0, stdoutTail: 'passed' });

        await expect(runAutonomousQualityGatePhase(phase('printf partial; printf failed >&2; exit 7'), {
            cwd: process.cwd(),
        })).resolves.toMatchObject({
            status: 'failed',
            exitCode: 7,
            stdoutTail: 'partial',
            stderrTail: 'failed',
        });
    });

    it('bounds output while retaining the diagnostic tail', async () => {
        const result = await runAutonomousQualityGatePhase(
            phase(`printf 'x%.0s' {1..${MAX_AUTONOMOUS_GATE_OUTPUT_BYTES + 20}}`),
            { cwd: process.cwd() },
        );

        expect(Buffer.byteLength(result.stdoutTail)).toBe(MAX_AUTONOMOUS_GATE_OUTPUT_BYTES);
        expect(result.stdoutTail).toMatch(/^x+$/);
        expect(result.outputTruncated).toBe(true);
    });

    it('kills the whole process group on timeout', async () => {
        const cwd = await mkdtemp(join(process.cwd(), '.happy-gate-runner-'));
        let childPid: number | undefined;
        try {
            const result = await runAutonomousQualityGatePhase(
                // A second, not 100ms: the shell has to spawn and reach its
                // `printf` before the phase is killed. The phase still times out
                // — it waits on a 30s sleep — so what is under test is
                // unchanged. A larger budget narrows the race against spawn
                // latency; it does not remove it, which is why an unprinted pid
                // now fails as itself rather than as a surviving child.
                phase("trap '' TERM; sleep 30 & child=$!; printf \"$child\"; wait", 1_000),
                { cwd, killGraceMs: 50 },
            );

            expect(result).toMatchObject({ status: 'timed-out', timedOut: true, exitCode: null });

            // Checked before any signal, as a positive safe integer. `Number('')`
            // is 0, `Number.isInteger(0)` is true, and `process.kill(0, 0)`
            // probes *this* process group and succeeds — so the previous
            // assertion reported "the child is still alive" for a fixture that
            // had simply not printed yet. Both failures are reachable: a tight
            // budget leaves the tail empty, and under load the descendant
            // outlives the call. Which one the CI run hit is not established.
            const printed = result.stdoutTail.trim();
            expect(printed).toMatch(/^[0-9]+$/);
            const parsed = Number(printed);
            expect(Number.isSafeInteger(parsed) && parsed > 0).toBe(true);
            childPid = parsed;

            // A SIGKILL request does not synchronously guarantee that
            // kill(pid, 0) reports absence; measured here, the descendant took
            // several milliseconds to disappear under load. Wait boundedly —
            // a group that was never killed still fails.
            await vi.waitFor(() => {
                expect(() => process.kill(childPid!, 0)).toThrow();
            }, { timeout: 2_000, interval: 10 });
        } finally {
            // Only the pid this test created, and never 0 or a group.
            if (childPid !== undefined && Number.isSafeInteger(childPid) && childPid > 0) {
                try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
            }
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it('honors an already-aborted signal without spawning work', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(runAutonomousQualityGatePhase(phase('printf should-not-run'), {
            cwd: process.cwd(),
            signal: controller.signal,
        })).resolves.toMatchObject({ status: 'aborted', timedOut: false, exitCode: null });
    });

    it('passes a start phase after readiness and tears down its process tree', async () => {
        const port = await availablePort();
        const command = `node -e 'require("http").createServer((_q,r)=>r.end("ok")).listen(${port})'`;
        const result = await runAutonomousQualityGatePhase({
            name: 'start',
            command,
            timeoutMs: 5_000,
            readinessUrl: `http://127.0.0.1:${port}/`,
        }, { cwd: process.cwd(), killGraceMs: 50 });

        expect(result).toMatchObject({ status: 'passed', exitCode: 0, timedOut: false });
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    });

    it('does not turn readiness success into a timeout while teardown waits for kill grace', async () => {
        const port = await availablePort();
        const command = `node -e 'process.on("SIGTERM",()=>{}); require("http").createServer((_q,r)=>r.end("ok")).listen(${port})'`;
        const result = await runAutonomousQualityGatePhase({
            name: 'start',
            command,
            timeoutMs: 1_000,
            readinessUrl: `http://127.0.0.1:${port}/`,
        }, { cwd: process.cwd(), killGraceMs: 1_200 });

        expect(result).toMatchObject({ status: 'passed', exitCode: 0, timedOut: false });
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    });

    it('force-kills a detached-stdio descendant after the group leader exits on teardown', async () => {
        const port = await availablePort();
        const childScript = `process.on('SIGTERM',()=>{}); require('http').createServer((_q,r)=>r.end('ok')).listen(${port})`;
        const parentScript = [
            `const {spawn}=require('child_process')`,
            `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'})`,
            'console.log(child.pid)',
            `process.on('SIGTERM',()=>process.exit(0))`,
            'setInterval(()=>{},1000)',
        ].join(';');
        const encoded = Buffer.from(parentScript).toString('base64');
        let childPid: number | undefined;
        try {
            const result = await runAutonomousQualityGatePhase({
                name: 'start',
                command: `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`,
                timeoutMs: 5_000,
                readinessUrl: `http://127.0.0.1:${port}/`,
            }, { cwd: process.cwd(), killGraceMs: 50 });
            expect(result).toMatchObject({ status: 'passed', exitCode: 0, timedOut: false });
            // A positive safe integer, not merely "an integer": `Number('')` is
            // 0, which would pass the weaker check and then make the cleanup
            // below signal this process group.
            const printed = result.stdoutTail.trim();
            expect(printed).toMatch(/^[0-9]+$/);
            const parsed = Number(printed);
            expect(Number.isSafeInteger(parsed) && parsed > 0).toBe(true);
            childPid = parsed;
            // The port, not the pid. A killed descendant can sit in Z until
            // its parent is reaped, and `kill(pid, 0)` still succeeds for a
            // zombie — so absence of the process is not observable on a
            // schedule this test can rely on. A closed listener is: it is the
            // effect that matters here, and a survivor of the group kill keeps
            // answering.
            await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
        } finally {
            // Only the pid this test created, and never 0 or a group.
            if (childPid !== undefined && Number.isSafeInteger(childPid) && childPid > 0) {
                try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
            }
        }
    });

    it('schedules only one forced teardown when abort races readiness cleanup', async () => {
        const port = await availablePort();
        const controller = new AbortController();
        const kill = vi.spyOn(process, 'kill');
        try {
            const completion = runAutonomousQualityGatePhase({
                name: 'start',
                command: `node -e 'process.on("SIGTERM",()=>{}); require("http").createServer((_q,r)=>r.end("ok")).listen(${port})'`,
                timeoutMs: 5_000,
                readinessUrl: `http://127.0.0.1:${port}/`,
            }, { cwd: process.cwd(), signal: controller.signal, killGraceMs: 100 });
            await vi.waitFor(() => expect(kill.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(true));
            controller.abort();

            await expect(completion).resolves.toMatchObject({ status: 'aborted' });
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
        } finally {
            kill.mockRestore();
        }
    });
});

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate port');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
}
