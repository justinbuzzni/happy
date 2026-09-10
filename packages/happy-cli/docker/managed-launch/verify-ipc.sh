#!/bin/bash
# §5.36 — **별도 daemon 프로세스**가 IPC 로 도는 양성 생명주기.
# supervisor 안에서 직접 부르지 않는다. B2 봉투 → prepare → 등록 → release →
# workload 가 상속된 FD 에서 그 봉투를 그대로 읽는지 확인하고, 그 daemon 을
# 죽인 뒤 watchdog 이 스스로 집행하는지 본다.
set -u
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }

mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo $p > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control || { echo "FAIL bootstrap"; exit 1; }
mkdir -p /sys/fs/cgroup/saycode && echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control
useradd -u 10002 -M -s /usr/sbin/nologin agentu 2>/dev/null
# daemon 은 root 가 아니다. 신뢰 그룹에만 속한다.
groupadd -g 10500 saycodedaemon 2>/dev/null
useradd -u 10001 -M -g 10500 -s /bin/sh daemonu 2>/dev/null
DAEMON_GID=10500
# 검증 번들은 비root daemon 도 읽어야 한다 (운영 배포와 무관한 fixture 사정).
chmod 755 /opt /opt/supervisor.cjs /opt/envelope.cjs 2>/dev/null || true
chmod 1777 /tmp
mkdir -p /var/lib/saycode/manifest && chmod 700 /var/lib/saycode/manifest
mkdir -p /run/saycode/staging && chmod 700 /run/saycode/staging
# 디렉터리는 root:daemon 0710 — daemon 은 통과만 하고 목록은 못 본다.
mkdir -p /run/saycode && chown root:saycodedaemon /run/saycode && chmod 710 /run/saycode

# workload: 상속된 fd 3 에서 봉투를 읽어 파일로 남긴다. stdout 으로 흘리지 않는다.
cat > /usr/local/lib/saycode/envelope-reader <<'W'
#!/bin/sh
# stdout/stderr 를 파일로 받아 실제로 무엇이 나갔는지 확인할 수 있게 한다.
exec /usr/local/bin/node -e "
const fs=require('fs');
let out;
try { out = { ok: true, envelope: fs.readFileSync(3, 'utf8') }; }
catch (error) { out = { ok: false, code: error.code || String(error) }; }
fs.writeFileSync('/tmp/workload-read.json', JSON.stringify(out));
setInterval(()=>{},1000);
" > /tmp/workload-stdout.txt 2> /tmp/workload-stderr.txt
W
chmod 0555 /usr/local/lib/saycode/envelope-reader

# supervisor 프로세스 (IPC 만 연다. 생명주기는 daemon 이 IPC 로 돌린다)
cat > /tmp/supervisor.cjs <<'JS'
const { createSupervisorRuntime } = require('/opt/supervisor.cjs');
const runtime = createSupervisorRuntime({
  config: {
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/envelope-reader',
    envAllowlist: { PATH: '/usr/local/bin:/usr/bin:/bin', SAYCODE_MANAGED: '1' },
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
  },
  manifestRoot: '/var/lib/saycode/manifest',
  stagingRoot: '/run/saycode/staging',
  socketPath: '/run/saycode/launcher.sock',
  watchdogIntervalMs: 300,
  releaseDeadlineMs: 15000,
  runtimeId: 'verifyipc',
  bootstrapFd: 3,
  daemonGid: 10500,
  token: 'boot-token',
});
runtime.start().then(() => require('fs').writeFileSync('/tmp/supervisor-ready', '1'));
JS
node /tmp/supervisor.cjs & SUP=$!
for i in $(seq 1 40); do [[ -f /tmp/supervisor-ready ]] && break; sleep 0.25; done
[[ -f /tmp/supervisor-ready ]] && ok "supervisor process is listening" || { no "supervisor did not start"; exit 1; }

# daemon 프로세스: launcherClient 로만 대화한다.
cat > /tmp/daemon.cjs <<'JS'
const fs = require('fs');
const { createLauncherClient, createUnixSocketRequest, systemMonotonicNow } = require('/opt/supervisor.cjs');
const { buildEnvelope } = require('/opt/envelope.cjs');
const client = createLauncherClient({
  token: 'boot-token',
  deps: createUnixSocketRequest('/run/saycode/launcher.sock', 10000),
});
const KEY = { runId: 'run1', attemptId: 'a1', epoch: 0 };
// supervisor 와 **같은 헬퍼**를 쓴다. 각자 계산하면 원점이 갈린다.
const mono = () => systemMonotonicNow();
(async () => {
  // 자기 PID 를 남긴다. `su ... &` 의 `$!` 는 su 의 PID 라 이 프로세스가 아니다.
  fs.writeFileSync('/tmp/daemon.pid', String(process.pid));
  const envelope = Buffer.from(JSON.stringify(buildEnvelope()));
  fs.writeFileSync('/tmp/expected-envelope.json', envelope);
  const prepared = await client.prepareLaunch({
    key: KEY, leaseExpiresMonotonic: mono() + 6000, bootstrap: envelope,
  });
  fs.writeFileSync('/tmp/prepared.json', JSON.stringify(prepared));
  if (!prepared.prepared) return;
  // **report registry 자체가 아니다.** 여기서는 신뢰된 PID 를 받아 등록 단계가
  // release 보다 먼저 끝난다는 순서만 확인한다. 실제 registry 배선은 별개다.
  fs.writeFileSync('/tmp/registered.json', JSON.stringify({ pid: prepared.pid, at: Date.now() }));
  const released = await client.releaseLaunch(prepared.handle);
  fs.writeFileSync('/tmp/released.json', JSON.stringify(released));
  // 같은 handle 을 두 번 쓰지 못한다.
  const again = await client.releaseLaunch(prepared.handle);
  fs.writeFileSync('/tmp/released-twice.json', JSON.stringify(again));
  const renewed = await client.renew({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: mono() + 6000 });
  fs.writeFileSync('/tmp/renewed.json', JSON.stringify(renewed));
  fs.writeFileSync('/tmp/daemon-done', '1');
  setInterval(() => {}, 1000);
})();
JS
# **비root** daemon 이 소켓으로 대화한다.
chmod 755 /tmp/daemon.cjs /tmp/cancel.cjs 2>/dev/null || true
rm -f /tmp/daemon.pid
su daemonu -s /bin/sh -c "node /tmp/daemon.cjs" & SU_PARENT=$!
for i in $(seq 1 60); do [[ -f /tmp/daemon-done ]] && break; sleep 0.25; done

echo "== 소켓 소유권과 접근 =="
OWNER=$(stat -c '%U:%G %a' /run/saycode/launcher.sock 2>/dev/null || echo missing)
[[ "$OWNER" == "root:saycodedaemon 660" ]] && ok "socket is root:saycodedaemon 660" || no "socket ownership: $OWNER"
su daemonu -s /bin/sh -c "test -w /run/saycode/launcher.sock" && ok "the non-root daemon can open the socket" || no "daemon cannot open the socket"
su agentu -s /bin/sh -c "test -r /run/saycode/launcher.sock" 2>/dev/null && no "the agent uid can reach the socket" || ok "the agent uid cannot reach the socket"

echo "== 별도 daemon 이 IPC 로 돌린 양성 생명주기 =="
grep -q '"prepared":true' /tmp/prepared.json 2>/dev/null && ok "prepare-launch returned a trusted pid and handle" || no "prepare failed: $(cat /tmp/prepared.json 2>&1)"
PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/prepared.json','utf8')).pid)}catch(e){console.log('')}")
RPID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/registered.json','utf8')).pid)}catch(e){console.log('')}")
[[ -n "$PID" && "$PID" == "$RPID" ]] && ok "the registration step ran with the supervisor-reported pid before release (mock registry)" || no "pid mismatch ($PID vs $RPID)"
grep -q '"released":true' /tmp/released.json 2>/dev/null && ok "release-launch exec'd the workload" || no "release failed: $(cat /tmp/released.json 2>&1)"
grep -q '"released":false' /tmp/released-twice.json 2>/dev/null && ok "a handle is single-use" || no "handle reused: $(cat /tmp/released-twice.json 2>&1)"
grep -q '"renewed":true' /tmp/renewed.json 2>/dev/null && ok "lease renewal accepted over IPC" || no "renew failed: $(cat /tmp/renewed.json 2>&1)"

echo "== workload 가 상속된 FD 에서 그 봉투를 그대로 읽는가 =="
for i in $(seq 1 20); do [[ -f /tmp/workload-read.json ]] && break; sleep 0.25; done
if [[ -f /tmp/workload-read.json ]]; then
  grep -q '"ok":true' /tmp/workload-read.json && ok "the workload read fd 3" || no "workload could not read fd 3: $(cat /tmp/workload-read.json)"
  # node 가 FAIL 을 찍고 0 으로 끝나면 `|| no` 가 걸리지 않는다. 종료 코드로 판정한다.
  if node -e "
    const fs=require('fs');
    const got=JSON.parse(fs.readFileSync('/tmp/workload-read.json','utf8')).envelope;
    const want=fs.readFileSync('/tmp/expected-envelope.json','utf8');
    if (got !== want) process.exit(1);
  "; then
    ok "the inherited fd carried exactly the envelope the daemon sent"
  else
    no "envelope mismatch"
  fi
else
  no "the workload never ran"
fi
# workload 의 **실제 stdout/stderr** 를 본다. 파일을 grep 하는 것은 stdout 검사가 아니다.
if [[ -s /tmp/workload-stdout.txt || -s /tmp/workload-stderr.txt ]]; then
  if grep -qE 'rawKeyBase64|scopedToken|capability' /tmp/workload-stdout.txt /tmp/workload-stderr.txt 2>/dev/null; then
    no "envelope material appeared on the workload's stdout/stderr"
  else
    ok "the workload wrote no envelope material to stdout/stderr"
  fi
else
  ok "the workload wrote nothing to stdout/stderr"
fi

CG=/sys/fs/cgroup/saycode/run-run1/attempt-a1/epoch-0
echo "== 그 daemon 을 죽인 뒤 watchdog 이 스스로 집행한다 =="
# `su` 의 PID 가 아니라 node 자신이 남긴 PID 를 죽인다. root fixture 가 비root
# 프로세스에 신호를 보내는 것은 정상이다.
for i in $(seq 1 40); do [[ -s /tmp/daemon.pid ]] && break; sleep 0.25; done
DAEMON=$(cat /tmp/daemon.pid 2>/dev/null || echo "")
if [[ -n "$DAEMON" ]] && kill -0 "$DAEMON" 2>/dev/null; then
  ok "the node daemon pid was captured ($DAEMON)"
else
  no "could not capture the node daemon pid"
fi
kill -9 "$DAEMON" 2>/dev/null
for i in $(seq 1 20); do kill -0 "$DAEMON" 2>/dev/null || break; sleep 0.25; done
kill -0 "$DAEMON" 2>/dev/null && no "the node daemon is still alive" || ok "the node daemon that drove the lifecycle exited"
# su 부모는 별도로 정리한다.
kill "$SU_PARENT" 2>/dev/null; wait "$SU_PARENT" 2>/dev/null || true
kill -0 $SUP 2>/dev/null && ok "supervisor survived" || no "supervisor died"
for i in $(seq 1 40); do [[ -d "$CG" ]] || break; sleep 0.5; done
[[ -d "$CG" ]] && no "watchdog did not stop the generation after the daemon died" || ok "autonomous watchdog stopped the generation"

echo "== 취소된 세대는 놓아주지 않는다 =="
cat > /tmp/cancel.cjs <<'JS'
const fs = require('fs');
const { createLauncherClient, createUnixSocketRequest, systemMonotonicNow } = require('/opt/supervisor.cjs');
const client = createLauncherClient({
  token: 'boot-token',
  deps: createUnixSocketRequest('/run/saycode/launcher.sock', 10000),
});
const KEY = { runId: 'run2', attemptId: 'a1', epoch: 0 };
const { buildEnvelope } = require('/opt/envelope.cjs');
(async () => {
  const prepared = await client.prepareLaunch({
    key: KEY, leaseExpiresMonotonic: systemMonotonicNow() + 8000,
    bootstrap: Buffer.from(JSON.stringify(buildEnvelope())),
  });
  if (!prepared.prepared) { fs.writeFileSync('/tmp/cancel.json', JSON.stringify({ step: 'prepare', prepared })); return; }
  // park 된 사이에 취소가 들어온다.
  const stop = await client.requestStop(KEY);
  const released = await client.releaseLaunch(prepared.handle);
  fs.writeFileSync('/tmp/cancel.json', JSON.stringify({ stop, released }));
})();
JS
rm -f /tmp/workload-read.json
su daemonu -s /bin/sh -c "node /tmp/cancel.cjs"
sleep 1
grep -q '"released":false' /tmp/cancel.json 2>/dev/null && ok "a cancelled generation is refused at release" || no "cancel: $(cat /tmp/cancel.json 2>&1)"
[[ -f /tmp/workload-read.json ]] && no "the cancelled workload ran anyway" || ok "the cancelled workload never ran"

echo "== 스테이징 파일이 남지 않는다 =="
COUNT=$(ls /run/saycode/staging | wc -l)
[[ "$COUNT" -eq 0 ]] && ok "no staged envelope left behind" || no "$COUNT staged files remain"

kill $SUP 2>/dev/null || true
echo "NOTE namespace isolation, tool sandbox and network policy (P4) are NOT implemented; activation stays 0"
exit $FAIL
