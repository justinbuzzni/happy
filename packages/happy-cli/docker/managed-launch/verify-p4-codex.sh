#!/bin/bash
# specs/managed-cloud-byos P4 — codex provider 를 **제품 배선 그대로** 띄운다.
set -u
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }
field() { node -e 'const o=JSON.parse(process.argv[1]||"{}");const v=process.argv[2].split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v===undefined||v===null?"":(typeof v==="string"?v:JSON.stringify(v)))' "$1" "$2"; }

apt-get -qq update >/dev/null 2>&1
apt-get -qq install -y iproute2 iptables >/dev/null 2>&1
mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
mkdir -p /sys/fs/cgroup/saycode && echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control 2>/dev/null
export P4_CGROUP=/sys/fs/cgroup/saycode/codex-tools
mkdir -p "$P4_CGROUP" || { echo "FAIL cgroup bootstrap"; exit 1; }
mkdir -p /var/lib/saycode/manifest && chmod 700 /var/lib/saycode/manifest
groupadd -g 10600 saycodetool 2>/dev/null
useradd -u 10601 -M -s /bin/sh provideru 2>/dev/null
useradd -u 10602 -M -g 10600 -s /bin/sh toolu 2>/dev/null
mkdir -p /workspace/project && chmod 755 /workspace/project
# 코딩 묶음은 executor 가 workspace 에 **쓴다**. production 에서도 workspace 는
# executor uid 소유여야 한다(CODEX_HOME 과 같은 종류의 배포 계약).
if [[ "${P4_TOOLSET:-}" == "coding" ]]; then chown 10602:10600 /workspace/project; fi
echo "보고서 본문" > /workspace/project/보고서.md && chmod 644 /workspace/project/보고서.md
mkdir -p /run/provider-home && chmod 777 /run/provider-home
touch /run/provider-result.json /run/provider-stderr.log && chmod 666 /run/provider-result.json /run/provider-stderr.log
cp /opt/p4-tool-runner.sh /usr/local/lib/saycode/tool-runner
chown root:root /usr/local/lib/saycode/tool-runner && chmod 0555 /usr/local/lib/saycode/tool-runner
sysctl -qw net.ipv4.ip_forward=1 >/dev/null 2>&1

rm -f /harness-fake.port /tmp/p4-codex-requests.jsonl
FAKE_PORT_FILE=/harness-fake.port node /opt/p4-fake-responses.mjs &
FAKE=$!
for i in $(seq 1 40); do [[ -s /harness-fake.port ]] && break; sleep 0.25; done
export FAKE_BASE_URL="http://127.0.0.1:$(cat /harness-fake.port)"
[[ -n "$(cat /harness-fake.port 2>/dev/null)" ]] && ok "the local model stand-in is listening" || no "model stand-in did not start"

OUT=$(timeout 300 node /opt/p4-codex-harness.mjs)
[[ "$(field "$OUT" outcome.kind)" == "exec-attempted" ]] \
  && ok "the supervisor launched the codex provider" || no "launch outcome: $(field "$OUT" outcome)"
[[ "$(field "$OUT" providerRan)" == "true" ]] \
  && ok "the codex provider adapter ran" \
  || no "codex provider produced nothing (stderr: $(tail -c 300 /run/provider-stderr.log))"
[[ "$(field "$OUT" providerCwd)" == "/workspace/project" ]] \
  && ok "the codex provider started in the planned directory" || no "cwd: $(field "$OUT" providerCwd)"
# 제품이 합친 결과 = B2 자리 인자 + 계획 인자. 계획 인자는 그대로 남아야 한다.
SAME_ARGS=$(node -e '
const o=JSON.parse(process.argv[1]);
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("/run/provider-result.json","utf8"));
const actual=r.args||[];
const planned=o.plannedArgs||[];
const tail=actual.slice(actual.length-planned.length);
process.stdout.write(JSON.stringify(planned)===JSON.stringify(tail)?"same":"different")' "$OUT")
[[ "$SAME_ARGS" == "same" ]] \
  && ok "the codex provider consumed exactly the plan’s arguments" \
  || no "args differed: planned=$(field "$OUT" plannedArgs) actual=$(field "$OUT" providerArgs)"
# production 승인 경로와 같은 판정: 이 run 의 broker 만 프롬프트 없이 통과한다.
APPROVALS=$(node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("/run/provider-result.json","utf8"));
process.stdout.write(JSON.stringify(r.approvals||[]));' 2>/dev/null)
[[ "$APPROVALS" == *'"ours":true'* ]] \
  && ok "the product recognised this run’s own broker ($APPROVALS)" || no "approvals: $APPROVALS"

# 모델이 실제로 본 것: 도구 이름과 broker 결과. 원문에서 읽는다.
ADVERTISED=$(node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/p4-codex-requests.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const out=[];
for (const row of rows) { const m=/MCP_TOOL_NAMES:(\[[^\]]*\])/.exec(row.body); if (m) out.push(m[1]); }
process.stdout.write(out.join("|"));' 2>/dev/null)
NESTED=$(node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/p4-codex-requests.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
for (const row of rows) { const m=/NESTED_TOOL_NAMES:(\[[^\]]*\])/.exec(row.body); if (m) { process.stdout.write(m[1]); break; } }' 2>/dev/null)
RESULT=$(node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/p4-codex-requests.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
// 도구 **출력**이 실린 요청에서만 읽는다. 우리가 보낸 JS 소스와 섞이지 않게.
for (const row of rows) {
  if (!row.body.includes("custom_tool_call_output")) continue;
  const m = /BROKER-EXECUTED|FILE\([^)]*\)=[^"\\]*/.exec(row.body);
  if (m) { process.stdout.write(m[0]); break; }
}' 2>/dev/null)
[[ "$ADVERTISED" == *"mcp__saycode__read_file"* ]] \
  && ok "the broker tool was advertised to the model ($ADVERTISED)" || no "advertised: $ADVERTISED"
[[ "$RESULT" == *"FILE("* || "$RESULT" == *"BROKER-EXECUTED"* ]] \
  && ok "the broker executed the call and the result reached the model" || no "broker result: $RESULT"
# 비어 있으면 아래 두 판정은 공허하다. 먼저 관측이 있었는지 본다.
[[ -n "$NESTED" ]] && ok "the model actually saw a nested tool list ($NESTED)" \
  || no "no nested tool list observed — the two checks below would be vacuous"
[[ "$NESTED" == *"apply_patch"* ]] \
  && no "apply_patch is still registered under the product policy" \
  || ok "apply_patch is not registered under the product policy"
[[ "$NESTED" == *"exec_command"* ]] \
  && no "exec_command is still registered under the product policy" \
  || ok "exec_command is not registered under the product policy"
# 승인은 서버 이름으로만 통과한다 — **도구 범위는 broker 가 따로 강제**한다.
# 그래서 광고된 도구 중 grant scope 밖의 것을 부르면 거부돼야 한다.
SCOPE=$(node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/p4-codex-requests.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const grab=(body,label)=>{const i=body.indexOf(label+":");return i<0?null:body.slice(i,i+400);};
let out={inScope:null,outOfScope:null};
for (const row of rows) {
  if (!row.body.includes("custom_tool_call_output")) continue;
  out.inScope = out.inScope || grab(row.body,"IN_SCOPE");
  out.outOfScope = out.outOfScope || grab(row.body,"OUT_OF_SCOPE");
}
process.stdout.write(JSON.stringify({
  // 실제 executor 를 지난 출력이어야 한다(도구 runner 가 uid 를 찍는다).
  inScopeExecuted: /IN_SCOPE:[^]{0,300}uid=10602/.test(out.inScope||""),
  outOfScopeExecuted: /OUT_OF_SCOPE:[^]{0,300}uid=10602/.test(out.outOfScope||""),
  outOfScopeSeen: out.outOfScope!==null,
  sample:(out.outOfScope||"").slice(0,90),inSample:(out.inScope||"").slice(0,90)}));' 2>/dev/null)
[[ "$(node -e 'const s=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(s.inScopeExecuted===true))' "$SCOPE")" == "true" ]] \
  && ok "an in-scope tool ran through the broker" || no "in-scope call: $SCOPE"
[[ "$(node -e 'const s=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(s.outOfScopeSeen===true && s.outOfScopeExecuted===false))' "$SCOPE")" == "true" ]] \
  && ok "a tool outside the grant scope was refused even though the server was approved ($SCOPE)" \
  || no "scope check inconclusive: $SCOPE"

[[ "$(field "$OUT" stopOutcome.stopped)" == "true" ]] \
  && ok "the codex run stopped with proof on both sides" || no "stop: $(field "$OUT" stopOutcome)"
[[ "$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String((o.unproven||[]).length))' "$OUT")" == "0" ]] \
  && ok "nothing was left unproven" || no "unproven: $(field "$OUT" unproven)"

kill "$FAKE" 2>/dev/null || true
echo "NOTE nested-tool observations come from the model requests this run actually sent"
exit $FAIL
