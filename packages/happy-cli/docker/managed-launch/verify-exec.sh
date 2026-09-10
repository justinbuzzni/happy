#!/bin/bash
# §5.36 P2 수락 — 실제 exec 로만 판정한다. 준비 실패 케이스를 먼저 본다.
set -u
HELPER=/usr/local/lib/saycode/exec-helper
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }

# --- 부트스트랩: root cgroup 을 비우고 위임 준비 ---
mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo $p > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control || { echo "FAIL bootstrap subtree_control"; exit 1; }
mkdir -p /sys/fs/cgroup/saycode
echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control
useradd -u 10002 -M -s /usr/sbin/nologin agentu 2>/dev/null
mkdir -p /usr/local/lib/saycode
cp /usr/local/bin/node /usr/local/lib/saycode/node 2>/dev/null || ln -sf /usr/local/bin/node /usr/local/lib/saycode/node

# helper 는 이제 release 를 기다린 뒤에야 exec 한다. 검증도 그 계약을 따른다.
run_helper() { # $1=cgroup $2=uid $3=exe ...rest
  local cg="$1" uid="$2"; shift 2
  local out fifo; out=$(mktemp); fifo=$(mktemp -u); mkfifo "$fifo"
  ( sleep 0.4; printf 1 > "$fifo" ) &
  ( exec 9>"$out"; exec 8<"$fifo"; "$HELPER" 9 8 "$cg" "$uid" "$uid" 0 "$@" ) </dev/null
  local rc=$?
  STATUS=$(cat "$out"); rm -f "$out" "$fifo"; return $rc
}
# release 를 **보내지 않는** 실행. 등록 실패 시 exec 이 없어야 한다.
run_helper_no_release() {
  local cg="$1" uid="$2"; shift 2
  local out fifo; out=$(mktemp); fifo=$(mktemp -u); mkfifo "$fifo"
  ( sleep 0.6; exec 7>"$fifo"; exec 7>&- ) &
  ( exec 9>"$out"; exec 8<"$fifo"; "$HELPER" 9 8 "$cg" "$uid" "$uid" 0 "$@" ) </dev/null
  STATUS=$(cat "$out"); rm -f "$out" "$fifo"
}

echo "== 준비 실패가 exec 으로 이어지지 않는가 =="
# (1) cgroup 경로가 신뢰 접두사 밖
run_helper "/sys/fs/cgroup/evil" 10002 /usr/local/lib/saycode/node -e "console.log('RAN')"
[[ "$STATUS" == *"stage=args"* ]] && ok "untrusted cgroup prefix refused" || no "untrusted cgroup prefix: $STATUS"

# (2) 실행 파일이 신뢰 접두사 밖
mkdir -p /sys/fs/cgroup/saycode/gen-a
run_helper "/sys/fs/cgroup/saycode/gen-a" 10002 /bin/echo RAN
[[ "$STATUS" == *"stage=args"* ]] && ok "untrusted exe prefix refused" || no "untrusted exe prefix: $STATUS"

# (3) cgroup 배치가 실패하는 진짜 경우 → exec 0, 누출 0.
#     helper 는 root 로 돈다. 디렉터리 mode 를 낮추는 것은 root 를 막지 못하므로
#     주입이 되지 않는다 — 실제로 열 수 없는 상태를 만들어야 한다.
rm -f /tmp/LEAK
run_helper "/sys/fs/cgroup/saycode/gen-missing" 10002 /usr/local/lib/saycode/node -e "require('fs').writeFileSync('/tmp/LEAK','x')"
[[ "$STATUS" == *"stage=cgroup"* ]] && ok "missing generation cgroup refused before exec" || no "missing cgroup: $STATUS"
[[ -f /tmp/LEAK ]] && no "process leaked despite refusal" || ok "no leaked process on refusal"

# (3b) 접두사 안이지만 디렉터리가 아닌 경우
mkdir -p /sys/fs/cgroup/saycode/gen-file 2>/dev/null
rm -f /tmp/LEAK2
run_helper "/sys/fs/cgroup/saycode/gen-file/cgroup.procs" 10002 /usr/local/lib/saycode/node -e "require('fs').writeFileSync('/tmp/LEAK2','x')"
[[ "$STATUS" == *"stage=cgroup"* ]] && ok "non-directory cgroup path refused" || no "non-directory: $STATUS"
[[ -f /tmp/LEAK2 ]] && no "process leaked on non-directory path" || ok "no leaked process on non-directory path"

# (4) uid 0 요청은 거부 (강등 없는 실행 금지)
run_helper "/sys/fs/cgroup/saycode/gen-a" 0 /usr/local/lib/saycode/node -e "console.log('RAN')"
[[ "$STATUS" == *"stage=args"* ]] && ok "uid 0 refused" || no "uid 0: $STATUS"

echo "== 실제 exec 양성 =="
mkdir -p /sys/fs/cgroup/saycode/gen-ok
OUT=$(mktemp); ST=$(mktemp); F0=$(mktemp -u); mkfifo $F0; ( sleep 0.4; printf 1 > $F0 ) &
( exec 9>"$ST"; exec 8<"$F0"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-ok 10002 10002 0 \
    /usr/local/lib/saycode/node -e "const fs=require('fs');fs.writeFileSync('/tmp/ran.json',JSON.stringify({uid:process.getuid(),cg:fs.readFileSync('/proc/self/cgroup','utf8').trim()}))" ) </dev/null
RC=$?
S=$(cat "$ST")
[[ "$S" == *"ack=setup-complete"* ]] && ok "ACK emitted (setup complete)" || no "no ACK: $S"
[[ "$S" == *"stage=exec"* ]] && no "exec failed after ACK: $S" || ok "no exec-stage error after ACK"
[[ $RC -eq 0 ]] && ok "helper exit 0 (execed program's status)" || no "helper exit $RC"
if [[ -f /tmp/ran.json ]]; then
  ok "execed program actually ran"
  grep -q '"uid":10002' /tmp/ran.json && ok "ran as agent uid" || no "wrong uid: $(cat /tmp/ran.json)"
  # helper 가 아니라 **exec 된 사용자 실행 파일**이 그 cgroup 안에 있다는 증거다.
  grep -q 'saycode/gen-ok' /tmp/ran.json && ok "user executable is inside the generation cgroup at exec time" || no "wrong cgroup: $(cat /tmp/ran.json)"
else
  no "execed program did not run"
fi

echo "== release 를 받지 못하면 exec 하지 않는다 =="
mkdir -p /sys/fs/cgroup/saycode/gen-norelease
rm -f /tmp/NORELEASE
run_helper_no_release "/sys/fs/cgroup/saycode/gen-norelease" 10002 \
    /usr/local/lib/saycode/node -e "require('fs').writeFileSync('/tmp/NORELEASE','x')"
[[ "$STATUS" == *"stage=release"* ]] && ok "no release means no exec" || no "release gate: $STATUS"
[[ -f /tmp/NORELEASE ]] && no "workload ran without registration" || ok "unregistered workload never ran"

echo "== spawn 성공과 exec 성공을 구분하는가 =="
# helper 를 띄우는 데는 성공하지만 exec 대상이 없는 경우
rm -f /tmp/ran2.json
ST2=$(mktemp); F2=$(mktemp -u); mkfifo $F2; ( sleep 0.4; printf 1 > $F2 ) &
( exec 9>"$ST2"; exec 8<"$F2"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-ok 10002 10002 0 \
    /usr/local/lib/saycode/missing-binary ) </dev/null
RC2=$?
S2=$(cat "$ST2")
[[ "$S2" == *"ack=setup-complete"* ]] && ok "ACK before a failing exec" || no "no ACK on failing exec"
[[ "$S2" == *"stage=exec"* ]] && ok "exec failure reported, not silent EOF" || no "exec failure not reported: $S2"
[[ $RC2 -ne 0 ]] && ok "nonzero exit on failed exec" || no "exit 0 on failed exec"

echo "== 자식 상속과 탈출 차단 =="
mkdir -p /sys/fs/cgroup/saycode/gen-kids
ST3=$(mktemp); F3=$(mktemp -u); mkfifo $F3; ( sleep 0.4; printf 1 > $F3 ) &
( exec 9>"$ST3"; exec 8<"$F3"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-kids 10002 10002 0 \
    /usr/local/lib/saycode/node -e "const{spawn}=require('child_process');spawn('/usr/local/lib/saycode/node',['-e','setTimeout(()=>{},60000)'],{detached:false,stdio:'ignore'});setTimeout(()=>{},3000)" ) </dev/null &
sleep 2
COUNT=$(wc -l < /sys/fs/cgroup/saycode/gen-kids/cgroup.procs)
[[ $COUNT -ge 2 ]] && ok "children inherit the generation cgroup ($COUNT procs)" || no "no inheritance ($COUNT procs)"
su agentu -s /bin/sh -c "echo \$\$ > /sys/fs/cgroup/cgroup.procs" 2>/dev/null && no "agent escaped to root cgroup" || ok "agent cannot write root cgroup.procs"
su agentu -s /bin/sh -c "echo \$\$ > /sys/fs/cgroup/saycode/gen-kids/cgroup.procs" 2>/dev/null && no "agent joined generation cgroup" || ok "agent cannot write generation cgroup.procs"

echo "== fd allowlist: 65536 을 넘는 fd 회귀 =="
# 예전 구현은 고정 상한까지만 훑어 이 fd 를 놓쳤다. 상한을 올려 실제로 만든다.
ulimit -n 100000 2>/dev/null || echo 100000 > /proc/sys/fs/nr_open 2>/dev/null
cat > /usr/local/lib/saycode/list-fds <<'W'
#!/bin/sh
ls /proc/self/fd > /tmp/highfds.txt 2>&1
W
chmod 0555 /usr/local/lib/saycode/list-fds
HIGHCG=/sys/fs/cgroup/saycode/gen-highfd
mkdir -p $HIGHCG
RL=/tmp/release.fifo; rm -f $RL; mkfifo $RL
run_highfd() { # $1=helper binary $2=out file
  rm -f /tmp/highfds.txt /tmp/hfstatus.txt
  ( sleep 1; printf 1 > "$RL" ) &
  ( ulimit -n 100000; python3 /opt/highfd.py "$1" "$HIGHCG" 10002 /tmp/hfstatus.txt "$RL" 70000 ) >/dev/null 2>&1
  sleep 2
  cp /tmp/highfds.txt "$2" 2>/dev/null || : > "$2"
  echo 1 > $HIGHCG/cgroup.kill 2>/dev/null; sleep 0.3
}
run_highfd /usr/local/lib/saycode/exec-helper /tmp/fds-current.txt
if [[ -s /tmp/fds-current.txt ]]; then
  grep -qx '70000' /tmp/fds-current.txt && no "fd 70000 leaked into the child" || ok "fd above 65536 is closed"
else
  no "high-fd case did not run"
fi

# 뮤턴트: 예전 고정 상한 구현이 같은 케이스에서 실패하는지 확인한다.
python3 - <<'MUT'
src = open('/build/execHelper.c').read()
start = src.index('    {\n        DIR *fds = opendir("/proc/self/fd");')
end = src.index('    /* \u2463 bounding set')
legacy = '''    {
        /* 예전 구현: 고정 상한까지만 훑는다. 그보다 높은 fd 는 상속된다. */
        long max_fd = 65536;
        for (long fd = 3; fd < max_fd; fd++) {
            if ((int)fd == status_fd || (int)fd == release_fd) continue;
            int keeper = 0;
            for (long i = 0; i < nkeep; i++) if (keep[i] == (int)fd) keeper = 1;
            if (!keeper) (void)close((int)fd);
        }
    }
'''
open('/tmp/mutant.c','w').write(src[:start] + legacy + src[end:])
MUT
if gcc -O2 -w -o /usr/local/lib/saycode/mutant-helper /tmp/mutant.c 2>/tmp/mutant.log; then
  chmod 0500 /usr/local/lib/saycode/mutant-helper
  run_highfd /usr/local/lib/saycode/mutant-helper /tmp/fds-mutant.txt
  if grep -qx '70000' /tmp/fds-mutant.txt; then
    ok "the fixed-cap mutant leaks fd 70000 — the regression actually discriminates"
  else
    no "mutant did not leak; the test does not prove the cap mattered ($(head -c 120 /tmp/fds-mutant.txt | tr '\n' ' '))"
  fi
else
  no "mutant did not compile: $(tail -2 /tmp/mutant.log)"
fi

echo "== status fd 를 keep 에 넣는 요청은 거부 =="
mkdir -p /sys/fs/cgroup/saycode/gen-dup
ST6=$(mktemp); F6=$(mktemp -u); mkfifo $F6; ( sleep 0.4; printf 1 > $F6 ) &
( exec 9>"$ST6"; exec 8<"$F6"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-dup 10002 10002 1 9 \
    /usr/local/lib/saycode/node -e "console.log('RAN')" ) </dev/null
S6=$(cat "$ST6")
[[ "$S6" == *"stage=args"* ]] && ok "status fd in keep list refused" || no "status fd in keep: $S6"
ST7=$(mktemp); F7=$(mktemp -u); mkfifo $F7; ( sleep 0.4; printf 1 > $F7 ) &
( exec 9>"$ST7"; exec 8<"$F7"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-dup 10002 10002 2 5 5 \
    /usr/local/lib/saycode/node -e "console.log('RAN')" ) </dev/null
S7=$(cat "$ST7")
[[ "$S7" == *"stage=args"* ]] && ok "duplicate keep fd refused" || no "duplicate keep fd: $S7"

echo "== uid 범위 초과 요청 거부 =="
ST8=$(mktemp); F8=$(mktemp -u); mkfifo $F8; ( sleep 0.4; printf 1 > $F8 ) &
( exec 9>"$ST8"; exec 8<"$F8"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-dup 99999999999999999999 10002 0 \
    /usr/local/lib/saycode/node -e "console.log('RAN')" ) </dev/null
S8=$(cat "$ST8")
[[ "$S8" == *"stage=args"* ]] && ok "out-of-range uid refused" || no "out-of-range uid: $S8"

echo "== capability 강등 실측 =="
mkdir -p /sys/fs/cgroup/saycode/gen-caps
ST4=$(mktemp); F4=$(mktemp -u); mkfifo $F4; ( sleep 0.4; printf 1 > $F4 ) &
( exec 9>"$ST4"; exec 8<"$F4"; "$HELPER" 9 8 /sys/fs/cgroup/saycode/gen-caps 10002 10002 0 \
    /usr/local/lib/saycode/node -e "const fs=require('fs');const s=fs.readFileSync('/proc/self/status','utf8');fs.writeFileSync('/tmp/caps.txt',s.split('\n').filter(l=>/^Cap|^NoNewPrivs/.test(l)).join('\n'))" ) </dev/null
grep -q "NoNewPrivs:	1" /tmp/caps.txt && ok "no_new_privs set" || no "no_new_privs missing: $(grep NoNewPrivs /tmp/caps.txt)"
grep -q "CapBnd:	0000000000000000" /tmp/caps.txt && ok "bounding set emptied" || no "bounding set: $(grep CapBnd /tmp/caps.txt)"
grep -q "CapEff:	0000000000000000" /tmp/caps.txt && ok "effective caps dropped" || no "effective caps: $(grep CapEff /tmp/caps.txt)"

echo "== P4 미완료 명시 =="
echo "NOTE namespace isolation and tool sandbox (P4) are NOT implemented; activation stays 0"
exit $FAIL
