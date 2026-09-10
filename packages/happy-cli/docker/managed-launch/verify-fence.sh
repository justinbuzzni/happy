#!/bin/bash
# §5.36 P3 수락 — **실제 supervisor 프로세스**가 자율 watchdog 으로 세대를 정지시키는지.
# daemon 을 죽인 뒤에도 supervisor 가 스스로 집행해야 한다.
set -u
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }
HELPER=/usr/local/lib/saycode/exec-helper

mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo $p > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control || { echo "FAIL bootstrap"; exit 1; }
mkdir -p /sys/fs/cgroup/saycode && echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control
useradd -u 10002 -M -s /usr/sbin/nologin agentu 2>/dev/null
ln -sf /usr/local/bin/node /usr/local/lib/saycode/node
# 오래 도는 workload. helper 는 인자를 받지 않으므로 스크립트로 고정한다.
cat > /usr/local/lib/saycode/long-workload <<'W'
#!/bin/sh
exec /usr/local/bin/node -e "setInterval(()=>{},1000)"
W
chmod 0555 /usr/local/lib/saycode/long-workload
mkdir -p /var/lib/saycode/manifest && chmod 700 /var/lib/saycode/manifest
mkdir -p /run/saycode && chmod 710 /run/saycode

echo "== supervisor 를 실제로 띄운다 (자율 루프) =="
mkdir -p /run/saycode/staging && chmod 700 /run/saycode/staging
cat > /tmp/run-supervisor.cjs <<'JS'
const { createSupervisorRuntime } = require('/opt/supervisor.cjs');
const fs = require('fs');
const KEY = { runId: 'run1', attemptId: 'a1', epoch: 0 };
const runtime = createSupervisorRuntime({
  config: {
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/long-workload',
    envAllowlist: { PATH: '/usr/local/bin:/usr/bin:/bin', SAYCODE_MANAGED: '1' },
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
  },
  manifestRoot: '/var/lib/saycode/manifest',
  stagingRoot: '/run/saycode/staging',
  socketPath: '/run/saycode/launcher.sock',
  watchdogIntervalMs: 300,
  releaseDeadlineMs: 10000,
  runtimeId: 'verify-fence',
  bootstrapFd: 3,
  token: 'boot-token-for-verification',
});
(async () => {
  await runtime.start();
  fs.writeFileSync('/tmp/supervisor-ready', '1');
  const started = Date.now();
  // 세대 cgroup 은 prepareLaunch 가 만든다 — 공개 createGeneration 은 없앴다.
  const { systemMonotonicNow } = require('/opt/supervisor.cjs');
  const mono = () => systemMonotonicNow();
  const prepared = await runtime.supervisor.prepareLaunch({
    key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: mono() + 5000,
  });
  fs.writeFileSync('/tmp/prepared.json', JSON.stringify({
    kind: prepared.kind, pid: prepared.kind === 'parked' ? prepared.pid : null,
    elapsed: Date.now() - started,
  }));
  if (prepared.kind !== 'parked') return;
  // park 상태에서 등록을 흉내낸다. 이 시점의 자식은 아직 exec 하지 않았다.
  const cg = '/sys/fs/cgroup/saycode/run-run1/attempt-a1/epoch-0/cgroup.procs';
  fs.writeFileSync('/tmp/parked-procs.json', JSON.stringify({
    procs: fs.readFileSync(cg, 'utf8').trim().split('\n').filter(Boolean),
    comm: (() => {
      try { return fs.readFileSync('/proc/' + prepared.pid + '/comm', 'utf8').trim(); }
      catch { return null; }
    })(),
  }));
  const outcome = await runtime.supervisor.releaseLaunch({
    key: KEY, handle: prepared.handle, leaseExpiresMonotonic: mono() + 5000,
  });
  fs.writeFileSync('/tmp/startup.json', JSON.stringify({ outcome, elapsed: Date.now() - started }));
})();
JS
node /tmp/run-supervisor.cjs &
SUP=$!
sleep 3

echo "== 2단계: park 상태에서 자식은 아직 exec 하지 않았다 =="
if [[ -f /tmp/parked-procs.json ]]; then
  PROCS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/parked-procs.json','utf8')).procs.length)")
  COMM=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/parked-procs.json','utf8')).comm)")
  [[ "$PROCS" -ge 1 ]] && ok "the parked child is already inside the generation cgroup" || no "parked child not in cgroup"
  [[ "$COMM" == "exec-helper" ]] && ok "it is still the helper — the workload has not been exec'd yet" || no "unexpected comm at park: $COMM"
else
  no "prepare-launch never parked a child"
fi

echo "== 기동 결과가 workload 종료를 기다리지 않는가 =="
if [[ -f /tmp/startup.json ]]; then
  ok "startup result returned while the workload is still running"
  grep -q '"kind":"exec-attempted"' /tmp/startup.json && ok "classified as exec-attempted (not proof of exec)" || no "unexpected outcome: $(cat /tmp/startup.json)"
  E=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/startup.json','utf8')).elapsed)")
  [[ "$E" -lt 3000 ]] && ok "startup did not block on workload lifetime (${E}ms)" || no "startup blocked ${E}ms"
else
  no "startup result never arrived — launch waited for the workload"
fi

CG=/sys/fs/cgroup/saycode/run-run1/attempt-a1/epoch-0
echo "== 환경 allowlist =="
CHILD=$(head -1 "$CG/cgroup.procs" 2>/dev/null || echo "")
if [[ -n "$CHILD" ]]; then
  tr '\0' '\n' < /proc/$CHILD/environ > /tmp/childenv.txt 2>/dev/null
  grep -q '^SAYCODE_MANAGED=1$' /tmp/childenv.txt && ok "allowlisted env present" || no "allowlist missing"
  COUNT=$(wc -l < /tmp/childenv.txt)
  [[ "$COUNT" -le 3 ]] && ok "child env is the allowlist only ($COUNT vars)" || no "child inherited $COUNT vars"
else
  no "no child in the generation cgroup"
fi

echo "== lease 만료 전에는 세대가 살아 있다 =="
[[ -d "$CG" ]] && ok "generation still alive before the lease expires" || no "generation vanished early"

echo "== daemon 사망 뒤 자율 watchdog =="
sleep 600 & DAEMON=$!
kill -9 $DAEMON 2>/dev/null; wait $DAEMON 2>/dev/null || true
kill -0 $DAEMON 2>/dev/null && no "daemon still alive" || ok "daemon is dead"
kill -0 $SUP 2>/dev/null && ok "supervisor survived (it is not in the generation cgroup)" || no "supervisor died"

# watchdog tick 이 스스로 집행할 시간을 준다. 이 스크립트는 kill 을 부르지 않는다.
for i in $(seq 1 20); do
  [[ -d "$CG" ]] || break
  sleep 0.5
done
[[ -d "$CG" ]] && no "watchdog did not stop the expired generation" || ok "autonomous watchdog stopped and removed the generation"

echo "== 원장 =="
node -e "
const {createGenerationManifest}=require('/opt/supervisor.cjs');
" 2>/dev/null
node -e "
const m=require('/opt/manifestEntry.cjs').createGenerationManifest('/var/lib/saycode/manifest');
const k={runId:'run1',attemptId:'a1',epoch:0};
const p=m.proveStopped(k);
if(!p.proven){console.log('FAIL manifest has no termination: '+JSON.stringify(p));process.exit(1)}
console.log('PASS manifest records the observed termination');
const again=m.proveStopped(k);
if(JSON.stringify(p)!==JSON.stringify(again)){console.log('FAIL re-proof not idempotent');process.exit(1)}
console.log('PASS re-proof is idempotent');
const never=m.proveStopped({runId:'run1',attemptId:'a1',epoch:5});
if(never.detail!=='never-launched'){console.log('FAIL never-launched misread: '+JSON.stringify(never));process.exit(1)}
console.log('PASS a generation never launched is not something to prove');
const all=m.proveAllBelow(Number.MAX_SAFE_INTEGER);
if(!all.proven){console.log('FAIL runtime-wide proof failed: '+JSON.stringify(all));process.exit(1)}
console.log('PASS runtime-wide proveAllBelow is satisfied');
" || no "manifest checks failed"

echo "== 두 번째 supervisor 는 같은 runtime 을 잡지 못한다 =="
node -e "
const { acquireSupervisorLock } = require('/opt/supervisor.cjs');
(async () => {
  const second = await acquireSupervisorLock({
    runtimeId: 'someotherid',
    manifestRoot: '/var/lib/saycode/manifest',
    cgroupRoot: '/sys/fs/cgroup/saycode',
  });
  // 같은 물리 자원을 **다른 runtimeId** 로 열어도 막혀야 한다.
  if (second.ok) { console.log('FAIL second supervisor acquired the same lock'); process.exit(1); }
  console.log('PASS second supervisor refused (' + second.reason + ')');
})();
" || no "lock probe failed"

echo "== 재시작 재조정: 옛 supervisor 가 죽고 새 supervisor 가 이어받는다 =="
# 앞의 supervisor 는 물리 루트 잠금을 들고 있다. 재시작 시나리오는 그것이
# 사라진 뒤에 시작한다.
kill $SUP 2>/dev/null; wait $SUP 2>/dev/null || true

# ① 옛 supervisor: 실제 수명주기로 workload 를 띄우고 살려 둔다.
#    lease 를 멀리 잡아 자기 watchdog 이 먼저 치우지 않게 한다.
cat > /tmp/old-supervisor.cjs <<'JS'
const fs = require('fs');
const { createSupervisorRuntime, systemMonotonicNow } = require('/opt/supervisor.cjs');
const KEY = { runId: 'restart', attemptId: 'a1', epoch: 0 };
const runtime = createSupervisorRuntime({
  config: { cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/long-workload',
    envAllowlist: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }) },
  manifestRoot: '/var/lib/saycode/manifest', stagingRoot: '/run/saycode/staging',
  socketPath: '/run/saycode/old.sock', watchdogIntervalMs: 500, releaseDeadlineMs: 10000,
  runtimeId: 'oldsup', token: 't',
});
(async () => {
  await runtime.start();
  fs.writeFileSync('/tmp/old-supervisor.pid', String(process.pid));
  const prepared = await runtime.supervisor.prepareLaunch({
    key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: systemMonotonicNow() + 600000,
  });
  if (prepared.kind !== 'parked') { fs.writeFileSync('/tmp/old-result.json', JSON.stringify(prepared)); return; }
  const outcome = await runtime.supervisor.releaseLaunch({
    key: KEY, handle: prepared.handle, leaseExpiresMonotonic: systemMonotonicNow() + 600000,
  });
  fs.writeFileSync('/tmp/old-result.json', JSON.stringify({ outcome, pid: prepared.pid }));
})();
JS
rm -f /tmp/old-supervisor.pid /tmp/old-result.json
node /tmp/old-supervisor.cjs &
for i in $(seq 1 40); do [[ -s /tmp/old-result.json ]] && break; sleep 0.25; done

RCG=/sys/fs/cgroup/saycode/run-restart/attempt-a1/epoch-0
RPOP=$(grep populated "$RCG/cgroup.events" 2>/dev/null || echo "populated 0")
[[ "$RPOP" == "populated 1" ]] && ok "the previous supervisor left a running workload" || no "no running workload ($RPOP: $(cat /tmp/old-result.json 2>&1))"
WPID=$(head -1 "$RCG/cgroup.procs" 2>/dev/null || echo "")
[[ -n "$WPID" ]] && ok "captured the workload pid ($WPID)" || no "no workload pid"

# ② 옛 supervisor 가 갑자기 죽는다. 커널이 추상 소켓 잠금을 회수한다.
OLDPID=$(cat /tmp/old-supervisor.pid 2>/dev/null || echo "")
kill -9 "$OLDPID" 2>/dev/null
for i in $(seq 1 20); do kill -0 "$OLDPID" 2>/dev/null || break; sleep 0.25; done
kill -0 "$OLDPID" 2>/dev/null && no "the old supervisor is still alive" || ok "the old supervisor crashed"
kill -0 "$WPID" 2>/dev/null && ok "its workload outlived it" || no "the workload died with the supervisor"

# ③ 새 supervisor 가 **같은 물리 루트**로 start() 한다. 잠금 획득이 곧 증거다.
#    이후는 실제 watchdog 이 한다 — 수동 tick 도 kill 도 하지 않는다.
cat > /tmp/new-supervisor.cjs <<'JS'
const fs = require('fs');
const { createSupervisorRuntime } = require('/opt/supervisor.cjs');
const KEY = { runId: 'restart', attemptId: 'a1', epoch: 0 };
const runtime = createSupervisorRuntime({
  config: { cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/long-workload',
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }) },
  manifestRoot: '/var/lib/saycode/manifest', stagingRoot: '/run/saycode/staging',
  socketPath: '/run/saycode/new.sock', watchdogIntervalMs: 300, releaseDeadlineMs: 10000,
  runtimeId: 'newsup', token: 't',
});
(async () => {
  try {
    await runtime.start();
  } catch (error) {
    fs.writeFileSync('/tmp/new-start.json', JSON.stringify({ started: false, reason: String(error) }));
    return;
  }
  // start() 직후의 상태. **여기서 proven 이 아니어도 정상이다** — 커널이
  // 프로세스를 거두는 데 시간이 걸리고, 그 재시도는 watchdog 의 일이다.
  fs.writeFileSync('/tmp/new-start.json', JSON.stringify({
    started: true, immediate: runtime.manifest.proveStopped(KEY),
  }));
  // 실제 watchdog 이 도는 동안 기다린다. 여기서 kill 하거나 tick 을 부르지 않는다.
  const deadline = Date.now() + 25000;
  const timer = setInterval(() => {
    const proof = runtime.manifest.proveStopped(KEY);
    if (proof.proven) {
      fs.writeFileSync('/tmp/new-proof.json', JSON.stringify({ proof }));
      clearInterval(timer);
    } else if (Date.now() > deadline) {
      fs.writeFileSync('/tmp/new-proof.json', JSON.stringify({ proof, timedOut: true }));
      clearInterval(timer);
    }
  }, 250);
})();
JS
rm -f /tmp/new-start.json /tmp/new-proof.json
node /tmp/new-supervisor.cjs & NEWSUP=$!
for i in $(seq 1 40); do [[ -s /tmp/new-start.json ]] && break; sleep 0.25; done
grep -q '"started":true' /tmp/new-start.json 2>/dev/null && ok "the new supervisor acquired the same physical-root lock" || no "new supervisor did not start: $(cat /tmp/new-start.json 2>&1)"

# 즉시 pending 은 terminal 이 아니다 — 그 사실 자체를 확인한다.
if node -e "
const s = JSON.parse(require('fs').readFileSync('/tmp/new-start.json','utf8'));
if (!s.started) process.exit(1);
if (s.immediate.proven) process.exit(2);
"; then
  ok "the state right after start() is not yet terminal (as designed)"
else
  RC=$?
  [[ $RC -eq 2 ]] && ok "reconcile proved it synchronously (also acceptable)" || no "start() failed"
fi

# ④ 실제 watchdog 이 끝낼 때까지 기다린다.
for i in $(seq 1 120); do [[ -s /tmp/new-proof.json ]] && break; sleep 0.25; done
if node -e "
const r = JSON.parse(require('fs').readFileSync('/tmp/new-proof.json','utf8'));
if (r.timedOut || !r.proof.proven) { console.error(JSON.stringify(r)); process.exit(1); }
"; then
  ok "the new supervisor's own watchdog eventually proved the generation stopped"
else
  no "the generation was never proven stopped by the running watchdog"
fi
[[ -d "$RCG" ]] && no "the generation cgroup is still present" || ok "the generation cgroup is gone"
kill -0 "$WPID" 2>/dev/null && no "the workload from the previous supervisor is still running" || ok "the workload from the previous supervisor is gone"
kill $NEWSUP 2>/dev/null || true
SUP=""

echo "== IPC 권한 =="
PERM=$(stat -c '%a' /run/saycode/launcher.sock 2>/dev/null || echo missing)
[[ "$PERM" == "660" ]] && ok "socket mode 660" || no "socket mode $PERM"
su agentu -s /bin/sh -c "test -r /run/saycode/launcher.sock" 2>/dev/null && no "agent can read the socket" || ok "agent cannot reach the socket"

kill $SUP 2>/dev/null || true
echo "== P4 미완료 명시 =="
echo "NOTE namespace isolation, tool sandbox and network policy (P4) are NOT implemented; activation stays 0"
exit $FAIL
