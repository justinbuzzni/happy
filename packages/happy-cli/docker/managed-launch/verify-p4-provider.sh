#!/bin/bash
# specs/managed-cloud-byos P4 — **제품 배선 전체**의 실기 검증.
#
# 하네스가 세션을 직접 조립하지 않는다: `startManagedProviderRun` 이 실제
# supervisor 로 provider 를 띄우고(prepare → 등록 → release), 그 provider 가 제품
# 계획대로 broker 에 붙어 executor 를 통해 도구를 돌리는 것까지 본다.
# 호스트를 mount 하지 않는다 — 필요한 것은 전부 이미지 안에 있다.
set -u
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }

apt-get -qq update >/dev/null 2>&1
apt-get -qq install -y iproute2 iptables >/dev/null 2>&1

mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
mkdir -p /sys/fs/cgroup/saycode && echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control 2>/dev/null
export P4_CGROUP=/sys/fs/cgroup/saycode/tools-run1
mkdir -p "$P4_CGROUP" || { echo "FAIL cgroup bootstrap"; exit 1; }
mkdir -p /var/lib/saycode/manifest && chmod 700 /var/lib/saycode/manifest

groupadd -g 10600 saycodetool 2>/dev/null
useradd -u 10601 -M -s /bin/sh provideru 2>/dev/null
useradd -u 10602 -M -g 10600 -s /bin/sh toolu 2>/dev/null
mkdir -p /workspace/project && chmod 755 /workspace/project
echo "보고서 본문" > /workspace/project/보고서.md
chmod 644 /workspace/project/보고서.md
mkdir -p /run/provider-home && chmod 777 /run/provider-home
touch /run/provider-result.json /run/provider-stderr.log && chmod 666 /run/provider-result.json /run/provider-stderr.log
cp /opt/p4-tool-runner.sh /usr/local/lib/saycode/tool-runner
chown root:root /usr/local/lib/saycode/tool-runner && chmod 0555 /usr/local/lib/saycode/tool-runner
sysctl -qw net.ipv4.ip_forward=1 >/dev/null 2>&1

rm -f /harness-fake.port
RAW_LOG=/tmp/p4-model-requests.jsonl FAKE_PORT_FILE=/harness-fake.port node /opt/p4-fake-anthropic.mjs &
FAKE=$!
for i in $(seq 1 40); do [[ -s /harness-fake.port ]] && break; sleep 0.25; done
export FAKE_BASE_URL="http://127.0.0.1:$(cat /harness-fake.port)"
[[ -n "$(cat /harness-fake.port 2>/dev/null)" ]] && ok "the local model stand-in is listening" || no "model stand-in did not start"

# P4_EXEC_PATH 를 함께 넘길 수 있게 env 를 그대로 물려준다.
run_case() {
  rm -f /run/provider-result.json /run/provider-stderr.log
  touch /run/provider-result.json /run/provider-stderr.log
  chmod 666 /run/provider-result.json /run/provider-stderr.log
  # 하네스가 스스로 끝난다. timeout 은 안전망이지 종료 수단이 아니다.
  MODE="$1" P4_WAIT_MS=90000 timeout 200 node /opt/p4-provider-harness.mjs
}
# 판정은 JSON 파싱으로 한다. pretty JSON 에 grep 하면 공백 때문에 오판한다.
field() { node -e 'const o=JSON.parse(process.argv[1]||"{}");const v=process.argv[2].split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v===undefined||v===null?"":(typeof v==="string"?v:JSON.stringify(v)))' "$1" "$2"; }

echo "== 제품 배선: 계획 → supervisor → provider → broker → executor =="
OUT=$(run_case positive)
[[ "$(field "$OUT" outcome.kind)" == "exec-attempted" ]] \
  && ok "the supervisor actually launched the provider (exec-attempted)" \
  || no "launch outcome: $(field "$OUT" outcome)"
[[ "$(field "$OUT" events)" == *"register:"* ]] \
  && ok "registration happened between prepare and release" || no "no registration recorded: $OUT"
[[ "$(field "$OUT" providerRan)" == "true" ]] \
  && ok "the provider process itself ran and wrote its result" \
  || no "the provider produced no result — it did not run (stderr: $(tail -c 400 /run/provider-stderr.log))"
# **정확히 그 집합**인지 본다. 포함 검사로는 다른 도구가 함께 있어도 통과한다.
EXACT=$(node -e 'const o=JSON.parse(process.argv[1]);const t=o.providerTools;process.stdout.write(Array.isArray(t)&&t.length===1&&t[0]==="mcp__saycode-broker__read_file"?"exact":"other")' "$OUT")
[[ "$EXACT" == "exact" ]] \
  && ok "the provider saw exactly the broker tool the plan registered, and nothing else" \
  || no "tool list: $(field "$OUT" providerTools) error: $(field "$OUT" providerError)"
TEXT=$(field "$OUT" providerText)
[[ "$TEXT" == *"TOOL_OK:FILE(보고서.md)"* ]] \
  && ok "the tool ran through the product executor and its output reached the model" \
  || no "tool output: $TEXT"
[[ "$TEXT" == *"uid=10602"* ]] \
  && ok "the tool ran as the executor uid, not the provider" || no "tool identity not observed: $TEXT"
[[ "$(field "$OUT" providerCwd)" == "/workspace/project" ]] \
  && ok "the provider started in the directory the plan fixed" \
  || no "provider cwd: $(field "$OUT" providerCwd)"
# provider 가 **계획의 sdkOptions 를 그대로** 받았는가. 하네스 주장이 아니라
# provider 자신이 기록한 값과 계획을 객체로 비교한다.
# 제품이 결속한 옵션이 계획과 같은가(경계 항목 기준).
SAME=$(node -e '
const o=JSON.parse(process.argv[1]);
const p=o.plannedSdkOptions||{};
const b=(o.providerBound||{}).options||{};
const keys=["model","effort","tools","mcpServers","permissionMode","allowedTools","settingSources"];
const same=keys.every(k=>JSON.stringify(p[k])===JSON.stringify(b[k]));
process.stdout.write(same?"same":JSON.stringify({planned:p,bound:b}));' "$OUT")
[[ "$SAME" == "same" ]] \
  && ok "the provider ran with exactly the plan’s boundary options" \
  || no "options differed: $SAME"
# 계획의 env 키가 실제로 provider 프로세스에 있었는가.
# 값까지 같은지 provider 안에서 비교하고 **boolean 하나**만 내보낸다.
# 기대 목록이 실제로 주입됐는지 먼저 본다. 비어 있으면 아래 비교는 공허하다.
EXPECTED=$(field "$OUT" providerBound.envExpectedCount)
PLANNED=$(field "$OUT" plannedEnvCount)
[[ -n "$EXPECTED" && "$EXPECTED" == "$PLANNED" && "$EXPECTED" != "0" ]] \
  && ok "the provider was given the full expected environment list ($EXPECTED entries)" \
  || no "expected env list missing or short: provider=$EXPECTED plan=$PLANNED"
[[ "$(field "$OUT" providerBound.envMatchesPlan)" == "true" ]] \
  && ok "every environment variable the plan set reached the provider with the same value" \
  || no "env mismatch inside the provider: $(field "$OUT" providerBound.envMismatch)"
# 그리고 계획에 없는 자격이 새어 들어오지 않았는가.
LEAK=$(node -e 'const o=JSON.parse(process.argv[1]);const keys=(o.providerBound&&o.providerBound.envKeys)||[];process.stdout.write(keys.filter(k=>/HAPPY_|CLAUDE_CODE_OAUTH|ANTHROPIC_API_KEY/.test(k)).join(","))' "$OUT")
[[ -z "$LEAK" ]] \
  && ok "no credential outside the plan reached the provider" || no "unexpected env: $LEAK"

# production seam 과 **같은 제품 함수**가 BYOS 모양 옵션을 덮어썼는가.
BOUND=$(node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("/run/provider-result.json","utf8"));
const b=r.find(m=>m&&m.type==="provider-bound")||{};
const o=b.options||{};
process.stdout.write(JSON.stringify({tools:o.tools,model:o.model,effort:o.effort,
  permissionMode:o.permissionMode,settingSources:o.settingSources,
  mcp:Object.keys(o.mcpServers||{}),allowed:o.allowedTools,
  byosModel:(b.byosShaped||{}).model,byosMcp:Object.keys((b.byosShaped||{}).mcpServers||{})}));' 2>/dev/null)
[[ "$(node -e 'const b=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(
  JSON.stringify(b.tools)==="[]" && b.permissionMode==="default" && JSON.stringify(b.settingSources)==="[]"
  && JSON.stringify(b.mcp)===JSON.stringify(["saycode-broker"])
  && b.model==="claude-opus-5" && b.effort==="low"
  && JSON.stringify(b.byosMcp)===JSON.stringify(["happy"])))' "$BOUND")" == "true" ]] \
  && ok "the product bound the plan over the BYOS-shaped options ($BOUND)" \
  || no "binding did not replace the boundary options: $BOUND"

echo "== 음성: 이 run 의 자격이 아니면 도구가 없다 =="
OUT2=$(run_case wrong-bearer)
# **양성 대조 먼저**: provider 가 실제로 돌았는가. 안 돌았으면 아래 "도구 없음" 은
# 아무것도 증명하지 못한다.
[[ "$(field "$OUT2" providerRan)" == "true" ]] \
  && ok "the negative case actually ran the provider (control)" \
  || no "negative case did not run — its emptiness proves nothing (stderr: $(tail -c 300 /run/provider-stderr.log))"
[[ "$(field "$OUT2" providerMcp)" == *'"status":"failed"'* ]] \
  && ok "the broker refused the wrong credential" || no "mcp status: $(field "$OUT2" providerMcp)"
[[ "$(field "$OUT2" providerTools)" == "[]" ]] \
  && ok "no tool was offered without this run’s credential" || no "tools offered: $(field "$OUT2" providerTools)"
[[ "$(field "$OUT2" providerText)" == *"TOOL_OK:"* ]] \
  && no "a tool ran without this run’s credential" || ok "no tool ran without this run’s credential"

echo "== env 대조가 공허하지 않다: 값을 하나 바꾸면 실패해야 한다 =="
OUT6=$(run_case env-tamper)
[[ "$(field "$OUT6" providerRan)" == "true" ]] \
  && ok "the tamper control actually ran the provider" || no "tamper control did not run"
[[ "$(field "$OUT6" providerBound.envMatchesPlan)" == "false" ]] \
  && ok "a single altered value is caught by the comparison ($(field "$OUT6" providerBound.envMismatch))" \
  || no "the comparison did not notice an altered value"

echo "== 봉투와 계획의 모델이 갈라지면 실행하지 않는다 =="
OUT7=$(run_case model-mismatch)
MISMATCH=$(node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("/run/provider-result.json","utf8"));
const e=(r||[]).find(m=>m&&m.type==="provider-error");
process.stdout.write(e?e.detail:"");' 2>/dev/null)
[[ "$MISMATCH" == *"different model"* ]] \
  && ok "a runner carrying another model is refused before the SDK call ($MISMATCH)" \
  || no "model mismatch was not refused: $MISMATCH"

echo "== 실행 환경: 계획과 실제 프로세스가 같아야 한다 =="
OUT5=$(run_case env-divergence)
[[ "$(field "$OUT5" launchRefusal)" == *"launched process environment"* ]] \
  && ok "a supervisor built with an environment other than the plan’s is caught in the running process" \
  || no "env divergence was not caught: $(field "$OUT5" launchRefusal)"

echo "== 신뢰 경로: 잎만이 아니라 조상까지 =="
# 양성: 신뢰 디렉터리 안의 root 소유 실행 파일은 통과한다(위 케이스가 그 증거).
# 음성 ①: 조상이 쓰기 가능하면 잎이 root 소유여도 거부한다.
mkdir -p /var/unsafe-parent/bin && chmod 0777 /var/unsafe-parent
cp /usr/local/lib/saycode/provider-entry.sh /var/unsafe-parent/bin/entry.sh
chown root:root /var/unsafe-parent/bin/entry.sh && chmod 0555 /var/unsafe-parent/bin/entry.sh
OUT3=$(P4_EXEC_PATH=/var/unsafe-parent/bin/entry.sh run_case positive)
REFUSAL=$(field "$OUT3" launchRefusal)
[[ "$REFUSAL" == *"not trusted"* ]] \
  && ok "a root-owned file under a writable ancestor is refused ($REFUSAL)" \
  || no "writable ancestor was accepted: $REFUSAL"
# 그 조상이 실제로 rename 치환을 허용한다는 것을 보인다 — 규칙의 이유다.
su nobody -s /bin/sh -c 'mv /var/unsafe-parent/bin /var/unsafe-parent/bin-moved' 2>/dev/null \
  && ok "the writable ancestor really allows replacing the trusted directory (control)" \
  || no "could not demonstrate the rename risk"
# 음성 ②: 심볼릭 링크는 따라가지 않는다.
ln -sf /usr/local/lib/saycode/provider-entry.sh /usr/local/lib/saycode/entry-link.sh
OUT4=$(P4_EXEC_PATH=/usr/local/lib/saycode/entry-link.sh run_case positive)
[[ "$(field "$OUT4" launchRefusal)" == *"symlink"* ]] \
  && ok "a symlinked executable is refused (lstat, not stat)" \
  || no "symlink was accepted: $(field "$OUT4" launchRefusal)"

echo "== 정지: provider 세대와 도구가 **둘 다** 증명돼야 한다 =="
for CASE_OUT in "$OUT" "$OUT2"; do
  CASE_MODE=$(field "$CASE_OUT" mode)
  [[ "$(field "$CASE_OUT" stopOutcome.stopped)" == "true" ]] \
    && ok "$CASE_MODE: the run stopped with proof on both sides" \
    || no "$CASE_MODE: stop outcome $(field "$CASE_OUT" stopOutcome)"
  [[ "$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String((o.unproven||[]).length))' "$CASE_OUT")" == "0" ]] \
    && ok "$CASE_MODE: nothing was left unproven" || no "$CASE_MODE: unproven $(field "$CASE_OUT" unproven)"
done

kill "$FAKE" 2>/dev/null || true
echo "NOTE this checks the product wiring end to end; isolation itself is judged by verify-p4-isolation.sh"
exit $FAIL
