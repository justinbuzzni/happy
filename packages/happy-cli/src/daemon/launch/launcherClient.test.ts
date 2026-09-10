import { describe, expect, it, vi } from 'vitest';

import { createLauncherClient } from './launcherClient';

const TOKEN = 'token-1';
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

function client(request: (payload: string) => Promise<string>) {
    return createLauncherClient({ token: TOKEN, deps: { request } });
}

describe('launcher client (daemon side)', () => {
    it('carries the boot token and never invents privileged fields', async () => {
        const sentPayloads: string[] = [];
        const request = vi.fn(async (payload: string) => {
            sentPayloads.push(payload);
            return JSON.stringify({ ok: true, result: { requested: true, detail: 'accepted' } });
        });
        await client(request).requestStop(KEY);
        const sent = JSON.parse(sentPayloads[0]!.trim());
        expect(sent).toEqual({ op: 'request-stop', key: KEY, token: TOKEN });
    });

    it('passes a refusal through instead of discarding it', async () => {
        const result = await client(async () => JSON.stringify({
            ok: true, result: { requested: false, detail: 'generation-absent' },
        })).requestStop(KEY);
        // `requested:false` 를 지우면 자식이 영원히 남는다.
        expect(result).toEqual({ requested: false, detail: 'generation-absent' });
    });

    it('a transport failure is not a stop', async () => {
        const result = await client(async () => { throw new Error('postgres://secret@host'); })
            .requestStop(KEY);
        expect(result).toEqual({ requested: false, detail: 'transport' });
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it('an unauthorized answer is not a stop', async () => {
        expect(await client(async () => JSON.stringify({ ok: false, reason: 'unauthorized' }))
            .requestStop(KEY)).toEqual({ requested: false, detail: 'unauthorized' });
    });

    it('asks the runtime-wide question the fencing contract defines', async () => {
        const sent: string[] = [];
        await client(async (payload) => {
            sent.push(payload);
            return JSON.stringify({ ok: true, result: { proven: true, detail: 'ok' } });
        }).proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER });
        // run/attempt 로 좁히지 않는다 — teardown 은 전체를 묻는다.
        expect(JSON.parse(sent[0]!.trim()))
            .toEqual({ op: 'prove-below', belowEpoch: Number.MAX_SAFE_INTEGER, token: TOKEN });
    });

    it('proves only when the supervisor says proven', async () => {
        expect(await client(async () => JSON.stringify({
            ok: true, result: { proven: true, detail: 'all-generations-observed-empty' },
        })).proveGenerationStopped({ belowEpoch: 2 }))
            .toEqual({ proven: true, detail: 'all-generations-observed-empty' });
    });

    it('absence of evidence is not proof of stopping', async () => {
        expect(await client(async () => JSON.stringify({
            ok: true, result: { proven: false, detail: 'generation-unknown' },
        })).proveGenerationStopped({ belowEpoch: 2 }))
            .toEqual({ proven: false, detail: 'generation-unknown' });
    });

    it('a truthy-but-not-true proven field does not prove anything', async () => {
        for (const proven of ['true', 1, {}, null]) {
            expect(await client(async () => JSON.stringify({ ok: true, result: { proven } }))
                .proveGenerationStopped({ belowEpoch: 2 }))
                .toMatchObject({ proven: false });
        }
    });

    it('a malformed answer is not a proof and not a stop', async () => {
        for (const raw of ['', 'not json', '[]', '"x"']) {
            expect(await client(async () => raw).proveGenerationStopped({ belowEpoch: 2 }))
                .toEqual({ proven: false, detail: 'malformed-response' });
            expect(await client(async () => raw).requestStop(KEY))
                .toEqual({ requested: false, detail: 'malformed-response' });
        }
    });
});
