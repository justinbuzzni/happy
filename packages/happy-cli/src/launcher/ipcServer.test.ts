import { describe, expect, it, vi } from 'vitest';

import {
    MAX_BOOTSTRAP_BYTES,
    MAX_ENCODED_REQUEST_BYTES,
    MAX_REQUEST_BYTES,
    SOCKET_MODE,
    handleIpcRequest,
    tokensMatch,
} from './ipcServer';

const TOKEN = 'a'.repeat(43);
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

function handlers() {
    return {
        proveStopped: vi.fn(() => ({ proven: true })),
        proveBelow: vi.fn(() => ({ proven: true, detail: 'ok' })),
        requestStop: vi.fn(() => ({ requested: true, detail: 'accepted' })),
        prepareLaunch: vi.fn(async () => ({ prepared: true as const, pid: 4242, handle: 'a'.repeat(32) })),
        releaseLaunch: vi.fn(async () => ({ released: true, detail: 'released' })),
        renew: vi.fn(() => ({ renewed: true })),
    };
}

async function call(body: unknown, over: { token?: string } = {}) {
    const h = handlers();
    const response = await handleIpcRequest({
        raw: typeof body === 'string' ? body : JSON.stringify(body),
        token: over.token ?? TOKEN,
        handlers: h,
    });
    return { response, h };
}

describe('supervisor IPC', () => {
    it('serves a proof request from an authenticated client', async () => {
        const { response, h } = await call({ op: 'prove-stopped', token: TOKEN, key: KEY });
        expect(response).toEqual({ ok: true, result: { proven: true } });
        expect(h.proveStopped).toHaveBeenCalledWith(KEY);
    });

    it('refuses a request without the boot token and never reaches a handler', async () => {
        const { response, h } = await call({ op: 'prove-stopped', token: 'wrong', key: KEY });
        expect(response).toEqual({ ok: false, reason: 'unauthorized' });
        expect(h.proveStopped).not.toHaveBeenCalled();
        expect(h.requestStop).not.toHaveBeenCalled();
    });

    it('checks the token before the operation, so an unknown op still needs auth', async () => {
        expect((await call({ op: 'nope', token: 'wrong' })).response).toEqual({ ok: false, reason: 'unauthorized' });
        expect((await call({ op: 'nope', token: TOKEN })).response).toEqual({ ok: false, reason: 'unsupported-op' });
    });

    it('the caller cannot choose the executable, uid or cgroup path', async () => {
        // 그런 필드는 계약에 없다 — 실어도 무시되고 세대만 지목된다.
        const { response, h } = await call({
            op: 'request-stop', token: TOKEN, key: KEY,
            exe: '/bin/sh', uid: 0, cgroup: '/sys/fs/cgroup',
        });
        expect(response).toEqual({ ok: true, result: { requested: true, detail: 'accepted' } });
        expect(h.requestStop).toHaveBeenCalledWith(KEY);
    });

    it('refuses ids that would escape the delegated root', async () => {
        for (const runId of ['../escape', 'a/b', '']) {
            expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, runId } })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
        expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, epoch: -1 } })).response)
            .toEqual({ ok: false, reason: 'malformed' });
        expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, epoch: 1.5 } })).response)
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses malformed input without throwing', async () => {
        for (const raw of ['', 'not json', '[]', 'null', '"str"']) {
            expect((await call(raw)).response).toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('compares tokens without leaking length through a throw', async () => {
        expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
        expect(tokensMatch(TOKEN, 'short')).toBe(false);
        expect(tokensMatch(TOKEN, 42)).toBe(false);
        expect(tokensMatch(TOKEN, undefined)).toBe(false);
    });

    it('bounds the request before parsing it', async () => {
        expect(MAX_REQUEST_BYTES).toBe(8192);
    });

    it('prove-below is runtime-wide — it takes only an epoch', async () => {
        const { response, h } = await call({ op: 'prove-below', token: TOKEN, belowEpoch: 7 });
        expect(response).toEqual({ ok: true, result: { proven: true, detail: 'ok' } });
        expect(h.proveBelow).toHaveBeenCalledWith({ belowEpoch: 7 });
    });

    it('prove-below refuses a non-epoch', async () => {
        for (const belowEpoch of [-1, 1.5, '7', undefined]) {
            expect((await call({ op: 'prove-below', token: TOKEN, belowEpoch })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('the socket is not open to other local users', async () => {
        expect(SOCKET_MODE).toBe(0o660);
    });
});

describe('two-phase launch over IPC', () => {
    const KEY2 = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };
    const bootstrapBase64 = Buffer.from('{"v":1}').toString('base64');

    it('carries the bootstrap as bytes — never a path or an fd number', async () => {
        const { response, h } = await call({
            op: 'prepare-launch', token: TOKEN, key: KEY2,
            leaseExpiresMonotonic: 5_000, bootstrapBase64,
        });
        expect(response).toMatchObject({ ok: true, result: { prepared: true, pid: 4242 } });
        const seen: Array<{ bootstrap: Buffer }> = [];
        for (const args of h.prepareLaunch.mock.calls as unknown as Array<[{ bootstrap: Buffer }]>) {
            seen.push(args[0]);
        }
        expect(seen).toHaveLength(1);
        expect(Buffer.isBuffer(seen[0]!.bootstrap)).toBe(true);
        expect(seen[0]!.bootstrap.toString('utf8')).toBe('{"v":1}');
    });

    it('refuses an encoded body beyond the wire cap before decoding it', async () => {
        const { response, h } = await call({
            op: 'prepare-launch', token: TOKEN, key: KEY2, leaseExpiresMonotonic: 5_000,
            bootstrapBase64: 'A'.repeat(MAX_ENCODED_REQUEST_BYTES + 1),
        });
        expect(response).toEqual({ ok: false, reason: 'too-large' });
        expect(h.prepareLaunch).not.toHaveBeenCalled();
    });

    it('the wire cap leaves room for base64 overhead above the 2MiB envelope', () => {
        expect(MAX_BOOTSTRAP_BYTES).toBe(2 * 1024 * 1024);
        expect(MAX_ENCODED_REQUEST_BYTES).toBeGreaterThan(MAX_BOOTSTRAP_BYTES);
    });

    it('refuses an empty or oversize decoded envelope', async () => {
        expect((await call({
            op: 'prepare-launch', token: TOKEN, key: KEY2,
            leaseExpiresMonotonic: 5_000, bootstrapBase64: '',
        })).response).toEqual({ ok: false, reason: 'malformed' });
    });

    it('release takes an opaque handle, not a pid or a path', async () => {
        const handle = 'b'.repeat(32);
        const { response, h } = await call({ op: 'release-launch', token: TOKEN, handle });
        expect(response).toMatchObject({ ok: true, result: { released: true } });
        expect(h.releaseLaunch).toHaveBeenCalledWith(handle);
    });

    it('refuses a handle that is not one this supervisor could have issued', async () => {
        for (const handle of ['', '../escape', 'zz', 4242]) {
            expect((await call({ op: 'release-launch', token: TOKEN, handle })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('renew carries the generation, sequence and deadline', async () => {
        const { response, h } = await call({
            op: 'renew', token: TOKEN, key: KEY2, renewalSeq: 3, leaseExpiresMonotonic: 9_000,
        });
        expect(response).toMatchObject({ ok: true, result: { renewed: true } });
        expect(h.renew).toHaveBeenCalledWith({
            key: KEY2, renewalSeq: 3, leaseExpiresMonotonic: 9_000,
        });
    });

    it('every launch command still needs the boot token', async () => {
        for (const op of ['prepare-launch', 'release-launch', 'renew']) {
            expect((await call({ op, token: 'wrong' })).response)
                .toEqual({ ok: false, reason: 'unauthorized' });
        }
    });
});

describe('shutdown drains in-flight requests', () => {
    it('waits for a handler that is still running when the socket is already gone', async () => {
        const { createIpcServer } = await import('./ipcServer');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { connect } = await import('node:net');

        const dir = mkdtempSync(join(tmpdir(), 'ipc-drain-'));
        const socketPath = join(dir, 's.sock');
        let releaseHandler: (() => void) | null = null;
        let handlerFinished = false;
        const ipc = createIpcServer({
            socketPath,
            token: TOKEN,
            handlers: {
                ...handlers(),
                prepareLaunch: async () => {
                    await new Promise<void>((resolve) => { releaseHandler = resolve; });
                    handlerFinished = true;
                    return { prepared: false as const, detail: 'done' };
                },
            },
        });
        try {
            await ipc.listen();
            const socket = connect(socketPath);
            await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
            socket.write(`${JSON.stringify({
                op: 'prepare-launch', token: TOKEN,
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                leaseExpiresMonotonic: 5_000,
                bootstrapBase64: Buffer.from('{}').toString('base64'),
            })}\n`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            // 소켓이 사라져도 handler 는 계속 돈다.
            socket.destroy();

            let closed = false;
            const closing = ipc.close().then(() => { closed = true; });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(closed).toBe(false);
            expect(handlerFinished).toBe(false);

            releaseHandler!();
            await closing;
            expect(handlerFinished).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('refuses a request that arrives after shutdown started', async () => {
        const { createIpcServer } = await import('./ipcServer');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { connect } = await import('node:net');

        const dir = mkdtempSync(join(tmpdir(), 'ipc-late-'));
        const socketPath = join(dir, 's.sock');
        let releaseHandler: (() => void) | null = null;
        const prepareLaunch = vi.fn(async () => {
            await new Promise<void>((resolve) => { releaseHandler = resolve; });
            return { prepared: false as const, detail: 'done' };
        });
        const ipc = createIpcServer({
            socketPath, token: TOKEN, handlers: { ...handlers(), prepareLaunch },
        });
        try {
            await ipc.listen();
            const first = connect(socketPath);
            await new Promise<void>((resolve) => first.on('connect', () => resolve()));
            const late = connect(socketPath);
            await new Promise<void>((resolve) => late.on('connect', () => resolve()));
            const body = `${JSON.stringify({
                op: 'prepare-launch', token: TOKEN,
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                leaseExpiresMonotonic: 5_000,
                bootstrapBase64: Buffer.from('{}').toString('base64'),
            })}\n`;
            first.write(body);
            await new Promise((resolve) => setTimeout(resolve, 100));

            const closing = ipc.close();
            // 이미 연결된 소켓으로 들어온 늦은 요청도 받지 않는다.
            const answer = new Promise<string>((resolve) => {
                let buffer = '';
                late.setEncoding('utf8');
                late.on('data', (chunk: string) => {
                    buffer += chunk;
                    if (buffer.includes('\n')) resolve(buffer.trim());
                });
            });
            late.write(body);
            expect(JSON.parse(await answer)).toEqual({ ok: false, reason: 'shutting-down' });
            expect(prepareLaunch).toHaveBeenCalledTimes(1);

            releaseHandler!();
            await closing;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
