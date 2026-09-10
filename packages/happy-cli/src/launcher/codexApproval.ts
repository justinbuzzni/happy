/**
 * specs/managed-cloud-byos P4 — codex 승인 요청 분류.
 *
 * codex 는 MCP 도구 호출 전에 `mcpServer/elicitation/request` 를 올린다. 그중
 * **이 run 이 스스로 등록한 loopback broker 에 대한 연결 동의**는 사람에게 물을
 * 것이 없다 — 그 서버를 등록한 것이 우리이고, 무엇을 쓸 수 있는지는 grant 가
 * 이미 정했다. 반대로 진짜 사용자 입력 요청이나 다른 종류의 승인은 자동으로
 * 답하면 안 된다.
 *
 * **사람용 문장을 파싱하지 않는다.** 설치본 0.153.4 의 타입 있는 필드만 본다:
 * `serverName`, `mode`, `requestedSchema`, `_meta.codex_approval_kind`
 * (`mcp_tool_call` | `elicitation` | `codex_sensitive_action` | tool suggestion),
 * `_meta.persist`.
 *
 * **도구 이름에 권위 있는 필드가 없다.** `mcp_tool_call` 의 `_meta` 는
 * `tool_description`·`tool_params`·`tool_params_display` 만 싣고, 이름은
 * `message` 문장 안에만 있다(`tool_suggestion` 쪽에만 `tool_name` 이 있다).
 * 그래서 이 분류는 **어떤 도구인지로 결정하지 않는다** — 승인의 범위는 "이 run 의
 * 이 서버에 붙는다" 까지이고, **어떤 도구를 실행할 수 있는지는 broker 가 grant
 * scope 로 최종 강제한다**. 승인이 통과해도 scope 밖 이름은 broker 가 거부한다.
 */

export type CodexApprovalDecision =
    /** 자동 동의. 실제 도구 범위는 broker 의 grant 가 강제한다. */
    | { kind: 'auto-approve'; scopeEnforcedBy: 'broker-grant' }
    /** 사람에게 올린다. 대기 상태로 전달해야 하며 임의로 답하지 않는다. */
    | { kind: 'await-user'; reason: string }
    /** 이 run 의 것이 아니거나 이미 폐기됐다. */
    | { kind: 'deny'; reason: string };

/** 응답에 실을 값. `always` 로 영속화하지 않는다 — 이 run 을 넘어서면 안 된다. */
export const CODEX_APPROVAL_ACCEPT = { action: 'accept', content: {} } as const;

function metaOf(params: Record<string, unknown>): Record<string, unknown> {
    const meta = params._meta;
    return meta && typeof meta === 'object' && !Array.isArray(meta)
        ? meta as Record<string, unknown>
        : {};
}

/** 입력을 하나도 요구하지 않는 스키마인가. 조금이라도 벗어나면 거짓이다. */
function isEmptyFormSchema(schema: unknown): boolean {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
    const record = schema as Record<string, unknown>;
    if (record.type !== 'object') return false;
    const properties = record.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
    if (Object.keys(properties as Record<string, unknown>).length > 0) return false;
    // 아는 두 키 말고는 아무것도 허용하지 않는다 — 모르는 키는 곧 모르는 요구다.
    return Object.keys(record).every((key) => key === 'type' || key === 'properties');
}

export function classifyCodexApproval(input: {
    /** `mcpServer/elicitation/request` 의 params 원문. */
    params: unknown;
    session: {
        /** 이 run 이 등록한 MCP 서버 이름. */
        serverName: string;
        /** 지금 이 순간 grant 가 살아 있는가. */
        grantValid: boolean;
    };
}): CodexApprovalDecision {
    const { params, session } = input;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return { kind: 'await-user', reason: 'unrecognised-request' };
    }
    const record = params as Record<string, unknown>;
    const meta = metaOf(record);

    // 우리가 등록하지 않은 서버의 동의를 대신 해 주지 않는다.
    if (record.serverName !== session.serverName) {
        return { kind: 'await-user', reason: 'unknown-server' };
    }
    if (meta.codex_approval_kind !== 'mcp_tool_call') {
        // `elicitation`(사용자 입력)·`codex_sensitive_action` 등은 사람 몫이다.
        return { kind: 'await-user', reason: `approval-kind:${String(meta.codex_approval_kind ?? 'absent')}` };
    }
    if (record.mode !== 'form') {
        return { kind: 'await-user', reason: `mode:${String(record.mode ?? 'absent')}` };
    }
    /*
     * 스키마가 **정확히** "묻는 것이 없다" 는 모양일 때만 통과시킨다:
     * `type:'object'` 이고 `properties` 가 빈 평범한 객체이며, 그 밖의 어떤
     * 입력 요구(`required`, `oneOf`, `anyOf`, `allOf`, `enum`, 배열 형태 …)도
     * 없어야 한다. 애매하면 사람에게 올린다.
     */
    if (!isEmptyFormSchema(record.requestedSchema)) {
        return { kind: 'await-user', reason: 'requests-user-input' };
    }

    // 폐기된 run 의 동의는 없다.
    if (!session.grantValid) return { kind: 'deny', reason: 'grant-revoked' };

    return { kind: 'auto-approve', scopeEnforcedBy: 'broker-grant' };
}


/**
 * 이 승인 요청이 **이 run 이 스스로 등록한 broker** 의 것인가.
 *
 * codex 실행의 승인·프롬프트는 기존 runner(`CodexPermissionHandler`)가 소유한다.
 * 여기서는 정책 하나만 답한다: 우리가 등록한 loopback broker 로의 도구 호출은
 * 사람에게 물을 것이 없다 — 그 서버를 등록한 것이 우리이고, 무엇을 쓸 수 있는지는
 * grant scope 가 broker 에서 최종 강제한다.
 *
 * 계획이 없거나 BYOS 실행이면 아무것도 주장하지 않는다(기존 동작 유지).
 */
export function isManagedBrokerServer(input: {
    managed: boolean;
    env: Record<string, string | undefined>;
    serverName: string | undefined;
}): boolean {
    if (!input.managed || !input.serverName) return false;
    const raw = input.env.SAYCODE_PROVIDER_CODEX_ARGS;
    if (!raw) return false;
    let args: unknown;
    try {
        args = JSON.parse(raw);
    } catch {
        return false;
    }
    if (!Array.isArray(args)) return false;
    // 계획이 등록한 이름만 인정한다. 문자열을 지어내지 않고 실제 인자에서 읽는다.
    const registered = new Set<string>();
    for (const entry of args) {
        if (typeof entry !== 'string') continue;
        const found = /^mcp_servers\.([A-Za-z0-9_-]+)\.url=/.exec(entry);
        if (found) registered.add(found[1]!);
    }
    return registered.has(input.serverName);
}