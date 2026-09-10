/*
 * P4 — codex provider 를 **제품 배선 그대로** 띄운다.
 *
 * Claude 쪽과 같은 진입점을 쓴다: 세션이 broker 를 열고 codex 계획(인자·env·
 * environments.toml)을 만들고, `startManagedProviderRun` 이 실제 supervisor 로
 * 그 계획을 실행 경계에 결속시킨다. 승인 판정은 provider 안에서 제품 함수가 한다.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/opt/');
const product = require('/opt/toolRuntime.cjs');

const cgroupPath = process.env.P4_CGROUP;
// run-private CODEX_HOME. codex 는 여기에 상태를 쓰므로 provider uid 소유여야
// 한다(0755 root 로 두면 `failed to initialize state runtime` 로 죽는다 — 실측).
const codexHome = '/run/codex-home';
mkdirSync(codexHome, { recursive: true });
chownSync(codexHome, 10601, 10601);
chmodSync(codexHome, 0o700);
const events = [];
const unproven = [];

const session = await product.startManagedToolSession({
    agent: 'codex',
    model: process.env.P4_MODEL || 'gpt-6-astra',
    providerEnv: {
        PATH: process.env.PATH,
        HOME: '/run/provider-home',
        OPENAI_BASE_URL: `${process.env.FAKE_BASE_URL}/v1`,
        OPENAI_API_KEY: 'run-scoped-capability-stand-in',
        SAYCODE_PROVIDER_MCP_SERVER: 'saycode',
    },
    codexHome,
    /*
     * 기본은 경계 확인용 두 도구(광고는 둘, scope 는 하나)다. `P4_TOOLSET=coding`
     * 이면 제품이 정의한 실제 코딩 도구 묶음을 광고한다.
     */
    tools: process.env.P4_TOOLSET === 'coding' ? product.MANAGED_CODING_TOOLS : [
        {
            name: 'read_file',
            description: 'Read a file from the managed workspace',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
            name: 'delete_file',
            description: 'Advertised but not in this run’s grant scope',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
    ],
    scope: process.env.P4_TOOLSET === 'coding'
        ? product.MANAGED_CODING_TOOLS.map((tool) => tool.name)
        : ['read_file'],
    ttlMs: 300_000,
    identity: { executor: { uid: 10602, gid: 10600 }, provider: { uid: 10601, gid: 10601 } },
    cgroupPath,
    helperPath: '/usr/local/lib/saycode/executor-helper',
    // 코딩 묶음은 제품 workload 가 처리한다. 그 밖에는 fixture 의 최소 runner.
    workloadPath: process.env.P4_TOOLSET === 'coding'
        ? '/usr/local/lib/saycode/tool-workload'
        : '/usr/local/lib/saycode/tool-runner',
    toolTimeoutMs: 60_000,
    onUnprovenTermination: (info) => { unproven.push(info); },
});

/*
 * 모델 provider 고정(base_url·env_key·wire_api)은 **B2 의 몫**이다
 * (`managedStartup.managedCodexProviderArguments`). 이 fixture 에는 B2 가 없으므로
 * 그 자리를 여기서 채우고, 그 뒤로는 계획이 단일 출처다 — 제품이 env 에서 읽어
 * 검증하고 app-server 에 넘긴다.
 */
// 계획 인자는 **계획이 만든 그대로**여야 한다 — 제품이 정확 일치로 검사한다.
session.providerPlan.env.SAYCODE_PROVIDER_CODEX_ARGS = JSON.stringify(session.providerPlan.args);
/*
 * 모델 provider 고정은 production 에서 B2 의 몫이다
 * (`managedStartup.managedCodexProviderArguments`). fixture 에는 B2 가 없으므로
 * 그 자리를 여기서 채우고, 제품이 `resolveManagedCodexArguments({base})` 로 합친다.
 */
session.providerPlan.env.SAYCODE_FIXTURE_B2_ARGS = JSON.stringify([
    '-c', 'model_providers.p.name="fake"',
    '-c', `model_providers.p.base_url="${process.env.FAKE_BASE_URL}/v1"`,
    '-c', 'model_providers.p.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.p.requires_openai_auth=false',
    '-c', 'model_providers.p.wire_api="responses"',
    '-c', 'model_provider="p"',
]);


let stopOutcome = null;
let providerResult = null;
const run = await product.startManagedProviderRun({
    // supervisor 설정은 **제품이** 만든다. 하네스는 그 설정으로 만들어 주기만 한다.
    createSupervisor: (config) => product.createSupervisor(config, {
        ...product.defaultSupervisorDeps,
        manifest: product.createGenerationManifest('/var/lib/saycode/manifest'),
    }),
    session,
    key: { runId: 'run-codex', attemptId: 'a1', epoch: 0 },
    statusFd: 9,
    releaseFd: 8,
    leaseExpiresMonotonic: product.systemMonotonicNow() + 300_000,
    writeFile: (file) => {
        writeFileSync(file.path, file.contents, { mode: file.mode });
        chmodSync(file.path, file.mode);
        // 계획 파일은 root 소유 읽기 전용이다. provider 는 읽기만 한다.
        events.push(`write:${file.path}`);
    },
    register: async (pid) => { events.push(`register:${pid}`); },
    // provider 세대가 정지되지 않으면 여기로 온다(도구 쪽은 세션이 보고한다).
    onUnprovenTermination: (info) => { unproven.push(info); },
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    identity: { provider: { uid: 10601, gid: 10601 } },
    // 실제로 도는 프로세스의 환경. 제품이 계획과 대조한다.
    readProcEnviron: (pid) => Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
            .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])),
    workloadPath: '/usr/local/lib/saycode/provider-run',
    execPath: '/usr/local/lib/saycode/codex-entry.sh',
    lstatPath: (path) => {
        const found = lstatSync(path);
        return {
            uid: found.uid, mode: found.mode, isDirectory: found.isDirectory(),
            isSymbolicLink: found.isSymbolicLink(), isFile: found.isFile(),
        };
    },
});

try {
    const deadline = Date.now() + Number(process.env.P4_WAIT_MS || 120_000);
    while (Date.now() < deadline) {
        try {
            const text = readFileSync('/run/provider-result.json', 'utf8');
            if (text.trim().length > 0) { providerResult = JSON.parse(text); break; }
        } catch { /* 아직 없다 */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
} finally {
    stopOutcome = await run.stop();
}

const output = (providerResult?.toolOutput ?? '');
console.log(JSON.stringify({
    outcome: run.outcome,
    stopOutcome,
    unproven,
    providerRan: providerResult !== null,
    providerCwd: providerResult?.cwd ?? null,
    approvals: providerResult?.approvals ?? null,
    plannedArgs: session.providerPlan.args,
    providerArgs: providerResult?.args ?? null,
    providerError: providerResult?.error ?? null,
    providerStderr: providerResult?.stderr ?? null,
    output,
}));
