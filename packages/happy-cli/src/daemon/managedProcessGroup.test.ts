import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
    probeProcessGroup,
    signalProcessGroup,
    type ProcessGroupDeps,
} from './managedProcessGroup';

function deps(overrides: Partial<ProcessGroupDeps> = {}): ProcessGroupDeps {
    let clock = 0;
    return {
        kill: () => {},
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        ...overrides,
    };
}

function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
}

describe('signalProcessGroup', () => {
    it('targets the whole group, not the leader', () => {
        const calls: Array<[number, string | number]> = [];
        signalProcessGroup(4242, 'SIGTERM', deps({ kill: (t, s) => { calls.push([t, s]); } }));
        // A positive pid would leave the agent's own children writing.
        expect(calls).toEqual([[-4242, 'SIGTERM']]);
    });

    it('refuses a pgid that could hit init or come from a corrupt receipt', () => {
        for (const pgid of [0, 1, -5, 1.5, Number.NaN]) {
            expect(signalProcessGroup(pgid, 'SIGTERM', deps()))
                .toEqual({ kind: 'indeterminate', detail: 'invalid pgid' });
        }
    });

    it('reads EPERM as alive-but-foreign, never as gone', () => {
        expect(signalProcessGroup(10, 0, deps({ kill: () => { throw errno('EPERM'); } })))
            .toEqual({ kind: 'not-permitted' });
    });

    it('keeps an uninterpretable errno as indeterminate', () => {
        expect(signalProcessGroup(10, 0, deps({ kill: () => { throw errno('EINVAL'); } })))
            .toEqual({ kind: 'indeterminate', detail: 'EINVAL' });
    });
});

describe('probeProcessGroup', () => {
    it('maps ESRCH to no-local-trace rather than "stopped"', () => {
        expect(probeProcessGroup(10, deps({ kill: () => { throw errno('ESRCH'); } })))
            .toEqual({ kind: 'no-local-trace' });
    });

    it('maps EPERM to alive-foreign', () => {
        expect(probeProcessGroup(10, deps({ kill: () => { throw errno('EPERM'); } })))
            .toEqual({ kind: 'alive-foreign' });
    });
});

describe('real detached child (fixture only)', () => {
    it('observes a detached child group and its disappearance', async () => {
        // A fixture process of our own — never an existing CLI session or any
        // other process on this machine.
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
            detached: true,
            stdio: 'ignore',
        });
        try {
            expect(child.pid).toBeGreaterThan(0);
            expect(probeProcessGroup(child.pid!).kind).toBe('alive');
        } finally {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(probeProcessGroup(child.pid!).kind).toBe('no-local-trace');
    });
});
