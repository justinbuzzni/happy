/**
 * specs/managed-cloud-byos §5.36 — daemon 측 launcher client.
 *
 * `managedRpcHandlers` 의 `fencingBackend` 를 채운다. daemon 은 **권한 주체가
 * 아니다** — 세대를 지목해 물어볼 뿐이고, 죽이는 것도 증명하는 것도 supervisor 다.
 *
 * 두 가지를 절대 하지 않는다:
 *  - 응답을 받지 못했다고 해서 정지했다고 말하지 않는다. `requested:false` 를
 *    지우면 lease 가 유지되는 한 자식이 영원히 남는다(§5.6).
 *  - 증명이 없다고 해서 "돌지 않았다" 로 읽지 않는다. 근거 부재는 `unknown` 이다.
 */
import { connect } from 'node:net';

// lease deadline 은 프로세스 경계를 넘어 비교된다. daemon 과 supervisor 가
// **같은 함수**를 써야 두 값의 원점이 같다. 여기서 다시 구현하지 않는다.
export { systemMonotonicNow } from '@/launcher/supervisor';

export type LauncherClientDeps = {
    /** 한 요청을 보내고 한 줄 응답을 받는다. */
    request: (payload: string) => Promise<string>;
};

export type BackendStopResult = { requested: boolean; detail: string };

function parseResponse(raw: string): { ok: true; result: unknown } | { ok: false; reason: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'malformed-response' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed-response' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.ok === true) return { ok: true, result: record.result };
    const reason = typeof record.reason === 'string' ? record.reason : 'refused';
    return { ok: false, reason };
}

export function createLauncherClient(input: { token: string; deps: LauncherClientDeps }) {
    async function ask(payload: Record<string, unknown>): Promise<
        { ok: true; result: unknown } | { ok: false; reason: string }
    > {
        let raw: string;
        try {
            raw = await input.deps.request(`${JSON.stringify({ ...payload, token: input.token })}\n`);
        } catch {
            // 원문은 옮기지 않는다.
            return { ok: false, reason: 'transport' };
        }
        return parseResponse(raw);
    }

    return {
        /**
         * `managedRpcHandlers` 의 계약 그대로 **`belowEpoch` 하나만** 받는다.
         * run/attempt 로 좁히지 않는다 — teardown 은 `MAX_SAFE_INTEGER` 로 불러
         * 이 runtime 이 띄운 **모든** 세대를 묻는다.
         *
         * supervisor 가 답하지 못하면 증명되지 않은 것이다.
         */
        async proveGenerationStopped(request: { belowEpoch: number }): Promise<{ proven: boolean; detail: string }> {
            const answer = await ask({ op: 'prove-below', belowEpoch: request.belowEpoch });
            if (!answer.ok) return { proven: false, detail: answer.reason };
            const result = answer.result;
            if (!result || typeof result !== 'object') return { proven: false, detail: 'malformed-response' };
            const record = result as Record<string, unknown>;
            // `proven` 이 명시적으로 true 일 때만 증명이다.
            if (record.proven !== true) {
                return {
                    proven: false,
                    detail: typeof record.detail === 'string' ? record.detail : 'not-proven',
                };
            }
            return { proven: true, detail: typeof record.detail === 'string' ? record.detail : 'proven' };
        },

        /**
         * 1단계. bootstrap 은 바이트로 보낸다 — FD 도 경로도 넘기지 않는다.
         * 돌려받는 PID 는 helper 가 스스로 보고한 값이고, handle 은 일회용이다.
         */
        async prepareLaunch(request: {
            key: { runId: string; attemptId: string; epoch: number };
            leaseExpiresMonotonic: number;
            bootstrap: Buffer;
        }): Promise<{ prepared: true; pid: number | null; handle: string }
            | { prepared: false; detail: string }> {
            const answer = await ask({
                op: 'prepare-launch',
                key: request.key,
                leaseExpiresMonotonic: request.leaseExpiresMonotonic,
                bootstrapBase64: request.bootstrap.toString('base64'),
            });
            if (!answer.ok) return { prepared: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { prepared: false, detail: 'malformed-response' };
            }
            if (result.prepared !== true || typeof result.handle !== 'string') {
                return {
                    prepared: false,
                    detail: typeof result.detail === 'string' ? result.detail : 'not-prepared',
                };
            }
            const pid = result.pid;
            return {
                prepared: true,
                pid: typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : null,
                handle: result.handle,
            };
        },

        /** 2단계. 등록을 마친 뒤에만 부른다. */
        async releaseLaunch(handle: string): Promise<{ released: boolean; detail: string }> {
            const answer = await ask({ op: 'release-launch', handle });
            if (!answer.ok) return { released: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { released: false, detail: 'malformed-response' };
            }
            return {
                released: result.released === true,
                detail: typeof result.detail === 'string' ? result.detail : 'unknown',
            };
        },

        async renew(request: {
            key: { runId: string; attemptId: string; epoch: number };
            renewalSeq: number;
            leaseExpiresMonotonic: number;
        }): Promise<{ renewed: boolean; detail: string }> {
            const answer = await ask({ op: 'renew', ...request });
            if (!answer.ok) return { renewed: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { renewed: false, detail: 'malformed-response' };
            }
            return {
                renewed: result.renewed === true,
                detail: typeof result.detail === 'string' ? result.detail : 'unknown',
            };
        },

        /** 정지 요청. 수락 여부를 **그대로** 돌려준다. */
        async requestStop(request: {
            runId: string; attemptId: string; epoch: number;
        }): Promise<BackendStopResult> {
            const answer = await ask({ op: 'request-stop', key: request });
            if (!answer.ok) return { requested: false, detail: answer.reason };
            const result = answer.result;
            if (!result || typeof result !== 'object') return { requested: false, detail: 'malformed-response' };
            const record = result as Record<string, unknown>;
            return {
                requested: record.requested === true,
                detail: typeof record.detail === 'string' ? record.detail : 'unknown',
            };
        },
    };
}

/** 운영 transport. 소켓 경로는 설정에서만 온다. */
export function createUnixSocketRequest(socketPath: string, timeoutMs = 5_000): LauncherClientDeps {
    return {
        request: (payload) => new Promise((resolve, reject) => {
            const socket = connect(socketPath);
            let buffer = '';
            const finish = (error: Error | null, value?: string) => {
                socket.destroy();
                if (error) reject(error);
                else resolve(value ?? '');
            };
            socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
            socket.setEncoding('utf8');
            socket.on('connect', () => { socket.write(payload); });
            socket.on('data', (chunk: string) => {
                buffer += chunk;
                const newline = buffer.indexOf('\n');
                if (newline >= 0) finish(null, buffer.slice(0, newline));
            });
            socket.on('error', (error) => finish(error));
            socket.on('close', () => { if (buffer.indexOf('\n') < 0) finish(new Error('closed')); });
        }),
    };
}
