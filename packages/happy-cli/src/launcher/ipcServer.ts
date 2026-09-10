/**
 * specs/managed-cloud-byos §5.36 — supervisor 의 IPC 경계.
 *
 * daemon 은 **client 일 뿐 권한 주체가 아니다.** 여기로 들어오는 요청은 세대를
 * 지목할 수 있을 뿐, 무엇을 어떤 uid 로 어디서 실행할지 고르지 못한다 — 그 값들은
 * supervisor 설정에서만 온다.
 *
 * Unix STREAM 소켓을 쓴다. Node 에는 `SO_PEERCRED` 가 없으므로 상대를 두 가지로
 * 가린다: 소켓이 놓인 디렉터리의 권한(운영이 `0710 root:saycode-daemon` 로 만든다.
 * `0700` 은 daemon 의 traversal 까지 막아 쓸 수 없다), 그리고 부팅마다 새로 만드는
 * 토큰. 토큰은 `timingSafeEqual` 로 비교한다.
 *
 * 요청 본문은 상한을 두고 줄 단위로 읽는다. 상한 없이 모으면 소켓 하나가 임의
 * 크기 입력이 된다.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { MANAGED_BOOTSTRAP_MAX_BYTES } from '@/managed/managedSpawnBootstrap';

import type { GenerationKey } from './generationManifest';

/** bootstrap 을 싣지 않는 명령의 상한. */
export const MAX_REQUEST_BYTES = 8192;

export type IpcRequest =
    | { op: 'prove-stopped'; token: string; key: GenerationKey }
    /** runtime 전체 질문이다. run/attempt 로 좁히지 않는다. */
    | { op: 'prove-below'; token: string; belowEpoch: number }
    | { op: 'request-stop'; token: string; key: GenerationKey }
    /**
     * 1단계. bootstrap 은 **바이트로** 온다 — Node 에 `SCM_RIGHTS` 가 없어
     * FD 번호를 프로세스 사이로 넘길 수 없고, 경로를 받으면 caller 가 무엇을
     * 읽힐지 고르게 된다. supervisor 가 자기 소유 디렉터리에 놓고 **자기가 연
     * FD** 를 helper 에 상속시킨다.
     */
    | {
        op: 'prepare-launch';
        token: string;
        key: GenerationKey;
        leaseExpiresMonotonic: number;
        bootstrapBase64: string;
    }
    /** 2단계. 등록이 끝났으니 놓아준다. handle 은 일회용이다. */
    | { op: 'release-launch'; token: string; handle: string }
    | { op: 'renew'; token: string; key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number };

export type IpcResponse =
    | { ok: true; result: unknown }
    | { ok: false; reason: string };

export type IpcHandlers = {
    proveStopped: (key: GenerationKey) => { proven: boolean; detail?: string };
    proveBelow: (input: { belowEpoch: number }) => { proven: boolean; detail: string };
    requestStop: (key: GenerationKey) => { requested: boolean; detail: string };
    prepareLaunch: (input: {
        key: GenerationKey;
        leaseExpiresMonotonic: number;
        bootstrap: Buffer;
    }) => Promise<{ prepared: true; pid: number | null; handle: string }
        | { prepared: false; detail: string }>;
    releaseLaunch: (handle: string) => Promise<{ released: boolean; detail: string }>;
    renew: (input: { key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number }) =>
        { renewed: boolean; detail?: string };
};

/**
 * bootstrap 봉투의 상한(2MiB)은 B2 계약값이다. base64 는 4/3 배로 늘고 JSON
 * 따옴표·필드가 더 붙으므로, 인코딩된 요청은 그만큼 더 허용해야 한다 —
 * 상한을 봉투 크기로 잡으면 규격 안의 봉투가 거부된다.
 */
export const MAX_BOOTSTRAP_BYTES = MANAGED_BOOTSTRAP_MAX_BYTES;
export const MAX_ENCODED_REQUEST_BYTES = Math.ceil(MANAGED_BOOTSTRAP_MAX_BYTES * 4 / 3) + 8192;

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function isEpoch(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readKey(value: unknown): GenerationKey | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!isSafeId(record.runId) || !isSafeId(record.attemptId) || !isEpoch(record.epoch)) return null;
    return { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
}

/** 토큰 비교는 길이 차이도 시간으로 새지 않게 다룬다. */
export function tokensMatch(expected: string, received: unknown): boolean {
    if (typeof received !== 'string') return false;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(received, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export async function handleIpcRequest(input: {
    raw: string;
    token: string;
    handlers: IpcHandlers;
}): Promise<IpcResponse> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(input.raw);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed' };
    }
    const request = parsed as Record<string, unknown>;
    // 토큰을 먼저 본다. 인증 전에 op 별 분기를 타면 그 자체가 정보가 된다.
    if (!tokensMatch(input.token, request.token)) return { ok: false, reason: 'unauthorized' };

    switch (request.op) {
        case 'prove-stopped': {
            const key = readKey(request.key);
            if (!key) return { ok: false, reason: 'malformed' };
            return { ok: true, result: input.handlers.proveStopped(key) };
        }
        case 'prove-below': {
            if (!isEpoch(request.belowEpoch)) return { ok: false, reason: 'malformed' };
            return { ok: true, result: input.handlers.proveBelow({ belowEpoch: request.belowEpoch }) };
        }
        case 'request-stop': {
            const key = readKey(request.key);
            if (!key) return { ok: false, reason: 'malformed' };
            return { ok: true, result: input.handlers.requestStop(key) };
        }
        case 'prepare-launch': {
            const key = readKey(request.key);
            if (!key || !isEpoch(request.leaseExpiresMonotonic)
                || typeof request.bootstrapBase64 !== 'string') {
                return { ok: false, reason: 'malformed' };
            }
            // 디코드 전에 크기를 본다. 임의 크기 입력을 먼저 만들지 않는다.
            if (request.bootstrapBase64.length > MAX_ENCODED_REQUEST_BYTES) {
                return { ok: false, reason: 'too-large' };
            }
            const bootstrap = Buffer.from(request.bootstrapBase64, 'base64');
            if (bootstrap.length === 0 || bootstrap.length > MAX_BOOTSTRAP_BYTES) {
                return { ok: false, reason: 'malformed' };
            }
            return {
                ok: true,
                result: await input.handlers.prepareLaunch({
                    key, leaseExpiresMonotonic: request.leaseExpiresMonotonic, bootstrap,
                }),
            };
        }
        case 'release-launch': {
            if (typeof request.handle !== 'string' || !/^[0-9a-f]{32}$/.test(request.handle)) {
                return { ok: false, reason: 'malformed' };
            }
            return { ok: true, result: await input.handlers.releaseLaunch(request.handle) };
        }
        case 'renew': {
            const key = readKey(request.key);
            if (!key || !isEpoch(request.renewalSeq) || !isEpoch(request.leaseExpiresMonotonic)) {
                return { ok: false, reason: 'malformed' };
            }
            return {
                ok: true,
                result: input.handlers.renew({
                    key, renewalSeq: request.renewalSeq,
                    leaseExpiresMonotonic: request.leaseExpiresMonotonic,
                }),
            };
        }
        default:
            return { ok: false, reason: 'unsupported-op' };
    }
}

/**
 * 소켓 파일 권한. 디렉터리는 운영이 `0710 root:saycode-daemon` 으로 만든다
 * (`0700` 은 daemon 의 traversal 까지 막아 쓸 수 없다). 소켓 자체는 소유자와
 * 그룹만 열 수 있어야 하며, 다른 로컬 사용자에게 열려 있으면 안 된다.
 */
export const SOCKET_MODE = 0o660;

/** 한 요청의 시한. 열어만 두고 말하지 않는 client 가 소켓을 붙잡지 못하게 한다. */
export const REQUEST_TIMEOUT_MS = 10_000;

export function createIpcServer(input: {
    socketPath: string;
    handlers: IpcHandlers;
    /**
     * daemon 이 속한 신뢰 그룹의 gid.
     *
     * 디렉터리를 `root:daemon 0710` 으로 만들어도 **그 안에 생긴 소켓은
     * `root:root`** 다. mode 만 `0660` 으로 바꾸면 group 은 여전히 root 이라
     * 비root daemon 은 EACCES 를 받는다. 그래서 소켓 자체의 group 을 옮긴다.
     *
     * 주지 않으면 소켓은 소유자만 열 수 있는 상태로 남는다 — 열어 두는 것보다
     * 낫고, 그 경우 비root daemon 은 연결하지 못한다.
     */
    daemonGid?: number;
    token?: string;
}): {
    server: Server;
    token: string;
    listen: () => Promise<void>;
    /**
     * 입구를 닫고 **진행 중 요청이 끝날 때까지** 기다린다.
     *
     * `server.close()` 는 새 연결만 막고 이미 실행 중인 handler 는 기다리지
     * 않는다. 소켓이 시한으로 끊겨도 handler 는 계속 돌기 때문에, 그것만 믿으면
     * 종료가 끝난 뒤에 늦은 `prepare-launch` 가 세대를 만들어 park 시킨다.
     */
    close: () => Promise<void>;
} {
    const token = input.token ?? randomBytes(32).toString('base64url');
    let closing = false;
    let inFlight = 0;
    let drained: (() => void) | null = null;
    const settleDrain = () => {
        if (closing && inFlight === 0 && drained) {
            const done = drained;
            drained = null;
            done();
        }
    };
    const server = createServer((socket: Socket) => {
        let buffer = '';
        // **소켓 하나에 요청 하나.** 첫 줄 뒤의 데이터는 읽지 않는다 — 같은
        // 소켓에서 두 요청이 겹치면 두 번째가 첫 번째의 응답을 받는다.
        let taken = false;
        socket.setEncoding('utf8');
        // 말이 없거나 줄을 끝내지 않는 client 를 무한정 기다리지 않는다.
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
            if (!taken) socket.end(`${JSON.stringify({ ok: false, reason: 'timeout' })}\n`);
            socket.destroy();
        });
        socket.on('data', (chunk: string) => {
            if (taken) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_ENCODED_REQUEST_BYTES) {
                taken = true;
                socket.end(`${JSON.stringify({ ok: false, reason: 'too-large' })}\n`);
                return;
            }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            taken = true;
            const raw = buffer.slice(0, newline);
            buffer = '';
            // 종료가 시작된 뒤 도착한 요청은 받지 않는다. 늦은 prepare 가
            // 종료 뒤에 세대를 만드는 것을 막는다.
            if (closing) {
                socket.end(`${JSON.stringify({ ok: false, reason: 'shutting-down' })}\n`);
                return;
            }
            inFlight += 1;
            void handleIpcRequest({ raw, token, handlers: input.handlers }).then(
                (response) => { socket.end(`${JSON.stringify(response)}\n`); },
                // 원문은 옮기지 않는다.
                () => { socket.end(`${JSON.stringify({ ok: false, reason: 'internal' })}\n`); },
            ).finally(() => {
                inFlight -= 1;
                settleDrain();
            });
        });
        socket.on('error', () => { socket.destroy(); });
    });
    return {
        server,
        token,
        listen: () => new Promise<void>((resolve, reject) => {
            // 남은 소켓 파일이 있으면 bind 가 EADDRINUSE 로 막힌다. 지우고 연다.
            try { unlinkSync(input.socketPath); } catch { /* 없으면 그만이다 */ }
            server.once('error', reject);
            server.listen(input.socketPath, () => {
                try {
                    if (input.daemonGid !== undefined) {
                        if (!Number.isSafeInteger(input.daemonGid) || input.daemonGid < 0) {
                            throw new Error('daemonGid must be a non-negative safe integer');
                        }
                        // 소유자는 그대로 두고 group 만 신뢰 그룹으로 옮긴다.
                        chownSync(input.socketPath, statSync(input.socketPath).uid, input.daemonGid);
                    }
                    chmodSync(input.socketPath, SOCKET_MODE);
                } catch (error) {
                    // 권한을 못 걸면 열어 두지 않는다.
                    server.close();
                    reject(error as Error);
                    return;
                }
                resolve();
            });
        }),
        close: async () => {
            closing = true;
            await new Promise<void>((resolve) => { server.close(() => resolve()); });
            // 소켓이 닫혔다고 handler 가 끝난 것은 아니다.
            if (inFlight > 0) {
                await new Promise<void>((resolve) => { drained = resolve; });
            }
        },
    };
}
