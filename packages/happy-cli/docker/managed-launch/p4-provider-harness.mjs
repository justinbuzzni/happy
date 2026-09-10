/*
 * specs/managed-cloud-byos P4 — 제품 배선 전체를 소비하는 하네스.
 *
 * 세션을 직접 조립하지 않는다. `startManagedProviderRun` 이 supervisor 계약
 * (prepare → 등록 → release)으로 provider 를 띄우고, 그 provider 가 제품이 만든
 * 계획대로 broker 에 붙어 executor 를 통해 도구를 돌리는 것까지 본다.
 *
 * 호스트 저장소를 mount 하지 않는다 — 필요한 것은 전부 이미지 안에 있다.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/opt/');
const product = require('/opt/toolRuntime.cjs');

const mode = process.env.MODE || 'positive';
const cgroupPath = process.env.P4_CGROUP;
const events = [];
const unproven = [];

const session = await product.startManagedToolSession({
    agent: 'claude',
    /*
     * **SDK 기본값과 다른 모델**을 고른다. 기본값과 같으면 제품이 모델을 싣지
     * 않아도 모든 요청이 그 값으로 나가 검사가 공허하게 통과한다.
     */
    model: process.env.P4_MODEL || 'claude-opus-5',
    effort: process.env.P4_EFFORT || 'low',
    providerEnv: {
        PATH: process.env.PATH,
        HOME: '/run/provider-home',
        ANTHROPIC_BASE_URL: process.env.FAKE_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: 'run-scoped-capability-stand-in',
        P4_HARNESS_MODE: mode,
    },
    tools: [{
        name: 'read_file',
        description: 'Read a file from the managed workspace',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
    scope: ['read_file'],
    ttlMs: 300_000,
    identity: { executor: { uid: 10602, gid: 10600 }, provider: { uid: 10601, gid: 10601 } },
    cgroupPath,
    helperPath: '/usr/local/lib/saycode/executor-helper',
    workloadPath: '/usr/local/lib/saycode/tool-runner',
    toolTimeoutMs: 60_000,
    onUnprovenTermination: (info) => { unproven.push(info); },
});

// provider 는 SDK 를 부르는 작은 프로그램이다. 계획의 sdkOptions 를 **그대로**
// 소비하고, 결과를 파일로 남긴다. 이 파일이 곧 "provider 가 실제로 돌았다" 는
// 증거다 — 하네스가 대신 SDK 를 부르지 않는다.
mkdirSync('/run/provider-home', { recursive: true });
writeFileSync('/usr/local/lib/saycode/provider-main.mjs', `
/*
 * provider 프로세스(fixture 범위).
 *
 * 제품에는 실행 루프가 없다 — production 에서는 기존 runner(loop → claudeRemote)가
 * 소유한다. 여기서는 그 runner 자리에 최소 드라이버를 두고, **제품 함수로 옵션을
 * 결속**한 뒤 SDK 를 부른다: 계획 검증과 경계 결속은 제품(resolveManagedClaudeOptions),
 * 대화 루프는 fixture.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { query } from '/usr/local/lib/saycode/sdk/sdk.mjs';
const product = createRequire('/usr/local/lib/saycode/')('/usr/local/lib/saycode/toolRuntime.cjs');

// BYOS 실행이 쓰던 옵션 모양에서 시작한다. 관리 실행이면 제품이 경계를 덮어쓴다.
// 관리 실행에서 runner 가 들고 오는 모델은 봉투의 모델(= 계획과 같다).
// mismatch 모드에서는 일부러 다른 모델을 들려 보내 fail-closed 를 확인한다.
const byosShaped = {
    model: process.env.P4_HARNESS_MODE === 'model-mismatch' ? 'claude-sonnet-5' : 'claude-opus-5',
    permissionMode: 'acceptEdits',
    allowedTools: ['mcp__happy__read'],
    mcpServers: { happy: { type: 'http', url: 'https://happy.example' } },
};
let options;
let bindingError = null;
try {
    options = product.resolveManagedClaudeOptions({
        managed: true, env: process.env, options: byosShaped,
    });
} catch (error) {
    bindingError = String(error && error.message ? error.message : error);
}

const messages = [];
let error = bindingError;
if (!bindingError) {
    try {
        for await (const message of query({
            prompt: '보고서.md 를 읽어줘.',
            options: {
                ...options,
                cwd: process.cwd(),
                maxTurns: 3,
                pathToClaudeCodeExecutable: '/usr/local/lib/saycode/sdk/claude',
            },
        })) messages.push(message);
    } catch (failure) {
        error = product.sanitizeProviderFailure(failure);
    }
}
writeFileSync('/run/provider-result.json', JSON.stringify(
    [{ type: 'provider-cwd', cwd: process.cwd() },
     { type: 'provider-bound', options: options ?? null, byosShaped,
       envMatchesPlan: (() => {
           const raw = process.env.SAYCODE_PLAN_ENV_DIGEST;
           if (!raw) return false;
           const expected = JSON.parse(raw);
           if (!Array.isArray(expected) || expected.length === 0) return false;
           return expected.every(([k, v]) => process.env[k] === v);
       })(),
       envExpectedCount: process.env.SAYCODE_PLAN_ENV_DIGEST
           ? JSON.parse(process.env.SAYCODE_PLAN_ENV_DIGEST).length : 0,
       envMismatch: JSON.parse(process.env.SAYCODE_PLAN_ENV_DIGEST || '[]')
           .filter(([k, v]) => process.env[k] !== v).map(([k]) => k),
       envKeys: Object.keys(process.env).sort() },
     ...(error ? [{ type: 'provider-error', detail: error }] : []),
     ...messages.slice(-20)], null, 1));
`);
chmodSync('/usr/local/lib/saycode/provider-main.mjs', 0o444);

/*
 * 음성 대조에서 하네스가 바꾸는 것은 **자격 하나뿐**이다. 계획의 sdkOptions 와
 * 그것을 싣는 env 자리를 함께 바꿔, 실행 경계에서 둘이 갈라지지 않게 한다
 * (제품이 그 일치를 강제한다).
 */
let sdkOptions = session.providerPlan.sdkOptions;
if (mode === 'wrong-bearer') {
    const name = Object.keys(sdkOptions.mcpServers)[0];
    sdkOptions = {
        ...sdkOptions,
        mcpServers: {
            [name]: { ...sdkOptions.mcpServers[name], headers: { authorization: 'Bearer not-this-runs-grant' } },
        },
    };
    session.providerPlan.sdkOptions = sdkOptions;
    session.providerPlan.env.SAYCODE_PROVIDER_SDK_OPTIONS = JSON.stringify(sdkOptions);
}


// 하네스는 실행 파일 위치만 고른다. 신뢰 여부 판정은 제품이 한다.
const execPath = process.env.P4_EXEC_PATH || '/usr/local/lib/saycode/provider-entry.sh';
/*
 * provider 안에서 값까지 대조할 기대 목록. 이것이 없으면 대조 자체가 공허하다.
 * env-tamper 모드에서는 **일부러 틀린 값**을 실어 음성 대조를 만든다.
 */
const digest = Object.entries(session.providerPlan.env)
    .filter(([key]) => key !== 'SAYCODE_PLAN_ENV_DIGEST')
    .map(([key, value]) => (mode === 'env-tamper' && key === 'PATH' ? [key, `${value}:/tampered`] : [key, value]));
session.providerPlan.env.SAYCODE_PLAN_ENV_DIGEST = JSON.stringify(digest);

let launchRefusal = null;
let run = null;
try {
run = await product.startManagedProviderRun({
    // supervisor 설정은 **제품이** 만든다. 하네스는 그 설정으로 만들어 주기만 한다.
    createSupervisor: (config) => product.createSupervisor({
        ...config,
        /*
         * 음성 케이스: factory 가 제품 설정을 **무시하고** 다른 env 로 supervisor 를
         * 만든다. 주장으로는 잡히지 않고, 실제 프로세스의 environ 만이 드러낸다.
         */
        ...(mode === 'env-divergence'
            ? { envAllowlist: { ...config.envAllowlist, SNEAKED_IN: 'not-in-the-plan' } }
            : {}),
    }, {
        ...product.defaultSupervisorDeps,
        manifest: product.createGenerationManifest('/var/lib/saycode/manifest'),
    }),
    session,
    // 세대는 재사용되지 않는다(원장이 금지한다). case 마다 새 세대다.
    key: { runId: `run-${mode}`, attemptId: 'a1', epoch: 0 },
    statusFd: 9,
    releaseFd: 8,
    leaseExpiresMonotonic: product.systemMonotonicNow() + 300_000,
    writeFile: (file) => {
        writeFileSync(file.path, file.contents, { mode: file.mode });
        chmodSync(file.path, file.mode);
        events.push(`write:${file.path}`);
    },
    register: async (pid) => { events.push(`register:${pid}`); },
    // provider 세대가 정지되지 않으면 여기로 온다(도구 쪽은 세션이 보고한다).
    onUnprovenTermination: (info) => { unproven.push(info); },
    // supervisor 가 실제로 들고 있는 환경. 제품이 계획과 같은지 검사한다.
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    identity: { provider: { uid: 10601, gid: 10601 } },
    // 실제로 도는 프로세스의 환경. 제품이 계획과 대조한다.
    readProcEnviron: (pid) => Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
            .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])),
    workloadPath: '/usr/local/lib/saycode/provider-run',
    // **lstat 이다.** stat 은 심볼릭 링크를 따라가 링크 자체를 못 본다.
    lstatPath: (path) => {
        const found = lstatSync(path);
        return {
            uid: found.uid,
            mode: found.mode,
            isDirectory: found.isDirectory(),
            isSymbolicLink: found.isSymbolicLink(),
            isFile: found.isFile(),
        };
    },
    execPath,
});
} catch (error) {
    launchRefusal = String(error && error.message ? error.message : error);
}
if (launchRefusal !== null) {
    console.log(JSON.stringify({ mode, launchRefusal, events }));
    process.exit(0);
}

/*
 * provider 가 스스로 결과를 남길 때까지 기다린다. 기다림에는 끝이 있어야 하고,
 * 끝나면 **반드시** 세대를 정지시키고 broker 를 닫는다 — 그러지 않으면 이
 * 프로세스가 남아 바깥 timeout 에 기대게 된다.
 */
let providerResult = null;
let stopOutcome = null;
try {
    const deadline = Date.now() + Number(process.env.P4_WAIT_MS || 90_000);
    while (Date.now() < deadline) {
        try {
            const text = readFileSync('/run/provider-result.json', 'utf8');
            if (text.trim().length > 0) { providerResult = JSON.parse(text); break; }
        } catch { /* 아직 없다 */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
} finally {
    stopOutcome = await run.stop();
    events.push(`stop:${JSON.stringify(stopOutcome)}`);
}

const init = Array.isArray(providerResult)
    ? providerResult.find((m) => m && m.type === 'system' && m.subtype === 'init')
    : null;
const result = Array.isArray(providerResult)
    ? providerResult.find((m) => m && m.type === 'result')
    : null;
console.log(JSON.stringify({
    mode,
    outcome: run.outcome,
    stopOutcome,
    events,
    unproven,
    providerRan: providerResult !== null,
    providerTools: init ? init.tools : null,
    providerMcp: init ? init.mcp_servers : null,
    providerText: result ? result.result : null,
    // provider 가 받은 것과 계획이 만든 것을 그대로 대조할 수 있게 둘 다 싣는다.
    plannedSdkOptions: sdkOptions,
    plannedEnvKeys: Object.keys(session.providerPlan.env).sort(),
    plannedEnvCount: Object.keys(session.providerPlan.env).length - 1,
    providerBound: Array.isArray(providerResult)
        ? (providerResult.find((m) => m && m.type === 'provider-bound') ?? null)
        : null,
    providerCwd: Array.isArray(providerResult)
        ? (providerResult.find((m) => m && m.type === 'provider-cwd')?.cwd ?? null)
        : null,
    providerError: Array.isArray(providerResult)
        ? (providerResult.find((m) => m && m.type === 'provider-error')?.detail ?? null)
        : null,
}));
