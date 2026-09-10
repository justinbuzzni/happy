#!/bin/bash
# specs/managed-cloud-byos P4 — **실제 코딩 작업**이 격리 안에서 돌아 provider 로 돌아오는가.
#
# 제품 workload(`toolWorkload`/`toolWorkloadEntry`)가 격리된 executor 안에서
# 파일을 쓰고 읽고 명령을 돌린다. 경계(workspace 밖 접근·쉘 주입)는 그대로 막혀야 한다.
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
export P4_CGROUP=/sys/fs/cgroup/saycode/coding-tools
mkdir -p "$P4_CGROUP" || { echo "FAIL cgroup bootstrap"; exit 1; }
mkdir -p /var/lib/saycode/manifest && chmod 700 /var/lib/saycode/manifest
groupadd -g 10600 saycodetool 2>/dev/null
useradd -u 10601 -M -s /bin/sh provideru 2>/dev/null
useradd -u 10602 -M -g 10600 -s /bin/sh toolu 2>/dev/null
# 코딩 도구는 workspace 에 **쓴다** — executor uid 소유여야 한다(배포 계약).
mkdir -p /workspace/project && chown 10602:10600 /workspace/project && chmod 755 /workspace/project
mkdir -p /run/provider-home && chmod 777 /run/provider-home
touch /run/provider-result.json /run/provider-stderr.log && chmod 666 /run/provider-result.json /run/provider-stderr.log
sysctl -qw net.ipv4.ip_forward=1 >/dev/null 2>&1

rm -f /harness-fake.port /tmp/p4-codex-requests.jsonl
FAKE_PORT_FILE=/harness-fake.port FAKE_FORCE_JS="$(cat /opt/p4-coding-probe.js)" node /opt/p4-fake-responses.mjs &
FAKE=$!
for i in $(seq 1 40); do [[ -s /harness-fake.port ]] && break; sleep 0.25; done
export FAKE_BASE_URL="http://127.0.0.1:$(cat /harness-fake.port)"
export P4_TOOLSET=coding
LAUNCH=$(timeout 300 node /opt/p4-codex-harness.mjs)
kill "$FAKE" 2>/dev/null || true
[[ "$(node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(o.outcome&&o.outcome.kind==="exec-attempted"))' "$LAUNCH")" == "true" ]] \
  && ok "the supervisor launched the provider for this coding run" || no "launch: $LAUNCH"

# 모델이 실제로 받은 도구 출력만 읽는다.
OUT=$(node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/p4-codex-requests.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const parts=[];
for (const row of rows) {
  if (!row.body.includes("custom_tool_call_output")) continue;
  const b=JSON.parse(row.body);
  for (const item of b.input||[]) {
    if (item.type!=="custom_tool_call_output") continue;
    for (const part of item.output||[]) if (part.text) parts.push(part.text);
  }
}
process.stdout.write(parts.join("\n"));' 2>/dev/null)

has() { [[ "$OUT" == *"$1"* ]]; }

has 'TOOLS:' && ok "the model saw the coding tools ($(echo "$OUT" | grep -o 'TOOLS:.*' | head -c 200))" \
  || no "no tool list observed"
has 'wrote 34 bytes to src/add.js' && ok "the model wrote a source file through the broker" \
  || no "write: $(echo "$OUT" | grep -o 'WRITE_SRC=.*' | head -c 200)"
has 'wrote ' && has 'src/add.test.js' && ok "the model wrote a test file" \
  || no "write test: $(echo "$OUT" | grep -o 'WRITE_TEST=.*' | head -c 200)"
has 'src/add.js' && ok "the listing shows what the run created" || no "list: $(echo "$OUT" | grep -o 'LIST=.*' | head -c 160)"
has 'module.exports' && ok "reading back returns what was written" || no "read back: $(echo "$OUT" | grep -o 'READ_BACK=.*' | head -c 160)"
has 'SUM-OK 5' && ok "a command ran in the workspace and its output reached the model" \
  || no "run: $(echo "$OUT" | grep -o 'RUN_TEST=.*' | head -c 200)"
has 'exit=0' && ok "the exit code came back with the output" || no "no exit code observed"
has 'exit=3' && ok "a failing command is reported as output, not as a broken tool" \
  || no "failing command: $(echo "$OUT" | grep -o 'RUN_FAILING=.*' | head -c 160)"
has 'ESCAPE=' && { echo "$OUT" | grep -o 'ESCAPE=.*' | head -1 | grep -q 'root:' \
  && no "a workspace escape succeeded" || ok "a path outside the workspace is refused"; } || no "escape probe missing"
has 'SHELL_INJECTION=' && { echo "$OUT" | grep -o 'SHELL_INJECTION=.*' | head -1 | grep -q 'uid=' \
  && no "shell syntax was executed" || ok "shell syntax in a command name is refused"; } || no "injection probe missing"

# 파일이 실제로 workspace 에 남았는가(격리 안에서 쓴 것이 밖에서 보인다).
[[ -f /workspace/project/src/add.js ]] && ok "the file the run wrote is really on disk" || no "no file on disk"
OWNER=$(stat -c '%u' /workspace/project/src/add.js 2>/dev/null || echo none)
[[ "$OWNER" == "10602" ]] && ok "it was written by the executor uid, not the provider ($OWNER)" \
  || no "unexpected owner: $OWNER"

echo "== 느린 reader 에게도 출력이 온전히 간다 =="
# production 에서는 helper 가 workspace 로 옮긴 뒤 execve 한다. 여기서는 직접 옮긴다.
cd /workspace/project
# 파이프 버퍼(64KB)보다 큰 결과를 천천히 읽는다. 쓰자마자 종료하면 뒷부분이 사라진다.
head -c 200000 /dev/urandom | base64 -w0 > slow.txt
SLOW_EXPECTED_HASH=$(node -e '
const fs = require("node:fs");
const hash = require("node:crypto").createHash("sha256");
const fd = fs.openSync("slow.txt", "r");
const prefix = Buffer.alloc(65536);
fs.readSync(fd, prefix, 0, prefix.length, 0); fs.closeSync(fd);
process.stdout.write(hash.update(prefix).update("\n…(truncated at 65536 bytes)").digest("hex"));')
SLOW=$(printf '%s' '{"name":"read_file","arguments":{"path":"slow.txt"}}' \
  | node /usr/local/lib/saycode/tool-workload.mjs 2>/dev/null \
  | node -e '
let total = 0; const tail = [];
const hash = require("node:crypto").createHash("sha256");
process.stdin.on("data", (chunk) => {
  hash.update(chunk);
  total += chunk.length; tail.push(chunk); if (tail.length > 4) tail.shift();
  const until = Date.now() + 15; while (Date.now() < until) {}
});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  total, hash: hash.digest("hex"), tail: Buffer.concat(tail).toString("utf8").slice(-24) })));')
[[ "$(node -e 'const s=JSON.parse(process.argv[1]||"{}");process.stdout.write(String(s.total===65566))' "$SLOW")" == "true" ]] \
  && ok "a slow reader still receives the whole result ($SLOW)" || no "output was lost under backpressure: $SLOW"
[[ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).hash)' "$SLOW")" == "$SLOW_EXPECTED_HASH" ]] \
  && ok "every output byte matches the source prefix and truncation notice" || no "output content changed: $SLOW"
[[ "$SLOW" == *"runcated at 65536 bytes"* ]] \
  && ok "the tail of the result arrives, not just the first pipe buffer" || no "tail missing: $SLOW"

echo "== 읽기는 읽는 순간에 묶인다 =="
truncate -s 2G sparse.bin
BIG=$(printf '%s' '{"name":"read_file","arguments":{"path":"sparse.bin"}}' \
  | node /usr/local/lib/saycode/tool-workload.mjs 2>/dev/null | wc -c)
[[ "$BIG" -gt 65536 && "$BIG" -lt 70000 ]] \
  && ok "a 2GiB sparse file comes back clipped, not whole ($BIG bytes)" || no "unexpected size: $BIG"
mkfifo pipe 2>/dev/null
FIFO_START=$(date +%s)
FIFO=$(printf '%s' '{"name":"read_file","arguments":{"path":"pipe"}}' \
  | timeout 10 node /usr/local/lib/saycode/tool-workload.mjs 2>/dev/null)
(( $(date +%s) - FIFO_START < 8 )) && [[ "$FIFO" == "execution-failed" ]] \
  && ok "a FIFO is refused at once instead of blocking the run" || no "fifo: '$FIFO' after $(( $(date +%s) - FIFO_START ))s"

echo "NOTE this checks the coding workload; isolation itself is judged by verify-p4-isolation.sh"
exit $FAIL
