/**
 * specs/managed-cloud-byos P4 — 신뢰된 도구 broker.
 *
 * provider 는 내장 도구가 없고 이 broker 하나만 본다(MCP over http, loopback).
 * broker 는 **provider 의 자격을 갖지 않는다** — 다른 UID 로 돌고, gateway
 * capability 도 세션 키도 받지 않는다. 도구 코드가 broker 를 통째로 장악해도
 * 그 자격에 닿지 못한다는 것이 이 분리의 전부다.
 *
 * 여기서 하는 일은 세 가지뿐이다: 도구 목록을 알리고, 호출을 검증하고,
 * 실행을 executor 에게 넘긴다. 실행 자체는 하지 않는다 — broker 프로세스가
 * 곧 실행 주체가 되면 UID 를 가른 의미가 없다.
 *
 * **loopback 이라는 이유로 인증을 생략하지 않는다.** 같은 호스트의 다른
 * 프로세스도 loopback 에 붙을 수 있고, tool executor 자신도 그중 하나다. 그래서
 * run 마다 새 bearer 를 요구하고, 그 토큰에 scope 와 만료를 달고, 필요하면
 * 즉시 폐기한다. SDK 는 `McpHttpServerConfig.headers` 로 이 헤더를 보낸다
 * (설치본 `sdk.d.ts` 에서 확인).
 */
import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const BROKER_PROTOCOL_VERSION = '2024-11-05';

export type BrokerToolCall = {
    name: string;
    arguments: Record<string, unknown>;
};

export type BrokerToolResult =
    | { ok: true; content: string }
    /** 고정 목록 밖의 값은 `execution-failed` 로 접힌다. */
    | { ok: false; code: string };

export type BrokerTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

/** 이 run 에만 유효한 자격. 발급자는 supervisor 다. */
export type BrokerGrant = {
    token: string;
    /** 호출을 허락하는 도구 이름들. 여기 없는 이름은 등록돼 있어도 거부한다. */
    scope: ReadonlySet<string>;
    /** 단조 시계 기준 만료. */
    expiresMonotonic: number;
};

export type ToolBrokerDeps = {
    /** 이 broker 가 알리는 도구들. 목록에 없는 이름은 실행으로 가지 않는다. */
    tools: BrokerTool[];
    /** 다른 UID 의 executor 로 넘긴다. broker 는 스스로 실행하지 않는다. */
    execute: (call: BrokerToolCall) => Promise<BrokerToolResult>;
    /** 현재 유효한 자격. 폐기되면 `null`. */
    grant: () => BrokerGrant | null;
    monotonicNow: () => number;
};

export const BROKER_AUTH_HEADER = 'authorization';

/** 실패 코드는 **고정 목록**이다. 호출부가 임의 문자열을 싣지 못한다. */
export const BROKER_FAILURE_CODES = [
    'workspace-denied',
    'tool-unavailable',
    'execution-failed',
    'execution-timeout',
    /**
     * A checkpoint is being taken and writes are held. Distinct from
     * `execution-failed` on purpose: this one is worth retrying in a moment
     * and nothing went wrong, and folding it into the generic failure would
     * tell the model its edit broke.
     */
    'checkpoint-paused',
] as const;
export type BrokerFailureCode = (typeof BROKER_FAILURE_CODES)[number];

export type BrokerAuthFailure =
    | 'missing-token' | 'bad-token' | 'grant-revoked' | 'grant-expired' | 'out-of-scope';

function tokensMatch(expected: string, received: string): boolean {
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(received, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/** 헤더에서 bearer 를 꺼낸다. 중복 헤더는 고르지 않고 거부한다. */
export function readBearer(header: unknown): string | null {
    if (typeof header !== 'string') return null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    return token || null;
}

export function authorizeBrokerCall(input: {
    header: unknown;
    toolName: string | null;
    deps: Pick<ToolBrokerDeps, 'grant' | 'monotonicNow'>;
}): { ok: true } | { ok: false; reason: BrokerAuthFailure } {
    const token = readBearer(input.header);
    if (!token) return { ok: false, reason: 'missing-token' };
    const grant = input.deps.grant();
    // 폐기된 run 은 그 자리에서 끝난다.
    if (!grant) return { ok: false, reason: 'grant-revoked' };
    if (!tokensMatch(grant.token, token)) return { ok: false, reason: 'bad-token' };
    if (input.deps.monotonicNow() >= grant.expiresMonotonic) {
        return { ok: false, reason: 'grant-expired' };
    }
    // scope 는 등록 목록과 별개다. 등록돼 있어도 이 run 이 못 쓰는 도구가 있다.
    if (input.toolName !== null && !grant.scope.has(input.toolName)) {
        return { ok: false, reason: 'out-of-scope' };
    }
    return { ok: true };
}

export function mintBrokerGrant(input: {
    scope: Iterable<string>;
    expiresMonotonic: number;
}): BrokerGrant {
    return {
        token: randomBytes(32).toString('base64url'),
        scope: new Set(input.scope),
        expiresMonotonic: input.expiresMonotonic,
    };
}

/** 요청 본문 상한. 하나가 임의 크기 입력이 되지 않게 한다. */
export const MAX_BROKER_REQUEST_BYTES = 1024 * 1024;

type JsonRpcRequest = { jsonrpc: '2.0'; id?: unknown; method?: unknown; params?: unknown };

export async function handleBrokerMessage(
    message: unknown,
    deps: ToolBrokerDeps,
    authHeader?: unknown,
): Promise<{ result: unknown } | { error: { code: number; message: string } } | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return { error: { code: -32600, message: 'invalid request' } };
    }
    const request = message as JsonRpcRequest;
    // 알림 말고는 전부 자격을 요구한다. 목록 조회도 마찬가지다 — 무엇이
    // 등록돼 있는지 자체가 정보다.
    if (request.method !== 'notifications/initialized') {
        const toolName = request.method === 'tools/call'
            && request.params && typeof request.params === 'object'
            && typeof (request.params as { name?: unknown }).name === 'string'
            ? (request.params as { name: string }).name
            : null;
        const authorized = authorizeBrokerCall({ header: authHeader, toolName, deps });
        if (!authorized.ok) {
            return { error: { code: -32001, message: authorized.reason } };
        }
    }
    switch (request.method) {
        case 'initialize':
            return {
                result: {
                    protocolVersion: BROKER_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'saycode-tool-broker', version: '1' },
                },
            };
        case 'notifications/initialized':
            // 알림에는 응답하지 않는다.
            return null;
        case 'tools/list':
            return { result: { tools: deps.tools } };
        case 'tools/call': {
            const params = request.params;
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                return { error: { code: -32602, message: 'invalid params' } };
            }
            const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
            if (typeof name !== 'string') {
                return { error: { code: -32602, message: 'invalid params' } };
            }
            // 알리지 않은 도구는 실행으로 넘기지 않는다. 이름을 지어내
            // executor 를 부르는 경로가 생기면 broker 가 경계가 아니게 된다.
            if (!deps.tools.some((tool) => tool.name === name)) {
                return { error: { code: -32601, message: 'unknown tool' } };
            }
            const outcome = await deps.execute({
                name,
                arguments: (args && typeof args === 'object' && !Array.isArray(args))
                    ? args as Record<string, unknown>
                    : {},
            });
            if (outcome.ok) {
                return { result: { content: [{ type: 'text', text: outcome.content }] } };
            }
            /*
             * 실패는 **고정 목록의 코드로만** 나간다. `code` 가 string 이라는
             * 이유로 원문이 안전하다고 가정하지 않는다 — executor 가 오류
             * 메시지를 그 자리에 넣으면 그대로 provider 에게 흘러간다.
             */
            const code: BrokerFailureCode =
                (BROKER_FAILURE_CODES as readonly string[]).includes(outcome.code)
                    ? outcome.code as BrokerFailureCode
                    : 'execution-failed';
            return { result: { isError: true, content: [{ type: 'text', text: code }] } };
        }
        default:
            return { error: { code: -32601, message: 'unknown method' } };
    }
}

export function createToolBroker(deps: ToolBrokerDeps): {
    server: Server;
    listen: (port: number) => Promise<number>;
    close: () => Promise<void>;
} {
    const server = createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        /*
         * chunk 를 문자열로 이어 붙이지 않는다. UTF-8 은 글자가 여러 바이트라
         * chunk 경계가 글자 가운데를 가르고, 그때 문자열 변환은 그 자리를
         * U+FFFD 로 바꿔 버린다 — 한글 경로가 **다른 경로로** 실행된다.
         * 바이트로 모아 상한을 재고, 마지막에 한 번만 디코딩한다.
         */
        const chunks: Buffer[] = [];
        let received = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            chunks.push(chunk);
            received += chunk.length;
            if (received > MAX_BROKER_REQUEST_BYTES) {
                tooLarge = true;
                res.writeHead(413).end();
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge) return;
            const body = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(body || 'null');
            } catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
                return;
            }
            const id = (parsed as JsonRpcRequest | null)?.id ?? null;
            void handleBrokerMessage(parsed, deps, req.headers[BROKER_AUTH_HEADER]).then(
                (outcome) => {
                    if (outcome === null) {
                        res.writeHead(202).end();
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', id, ...outcome }));
                },
                () => {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' },
                    }));
                },
            );
        });
    });

    return {
        server,
        // **loopback 에만 연다.** 밖으로 열면 도구 호출이 네트워크에 실린다.
        listen: (port) => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('broker did not bind a port'));
                    return;
                }
                resolve(address.port);
            });
        }),
        close: () => new Promise((resolve) => { server.close(() => resolve()); }),
    };
}
