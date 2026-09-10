#!/bin/bash
# specs/managed-cloud-byos P4 — **제품 executor** 의 격리를 실기로 판정한다.
#
# 이 스크립트는 `unshare`/`iptables`/`su` 를 직접 부르지 않는다. 부르면 검증되는
# 것은 제품이 아니라 이 스크립트다. 격리는 전부
# `createToolExecutor(...).run(...)` 이 `executorHelper` 를 통해 집행하고, 여기서
# 소유하는 것은 **대조군**뿐이다: 통제된 사설 listener, 규칙을 끈 양성 실행,
# 실제 `socket(AF_INET, SOCK_RAW)` 호출, root 양성 대조.
#
# 실행 준비(Dockerfile 에서):
#   gcc -O2 -Wall -Wextra -Werror -o /usr/local/lib/saycode/executor-helper src/launcher/executorHelper.c
#   esbuild --bundle --platform=node --format=cjs 로 toolExecutor/managedToolRuntime → /opt/toolRuntime.cjs
set -u
FAIL=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; FAIL=1; }

HELPER=/usr/local/lib/saycode/executor-helper
LIB=/usr/local/lib/saycode
CG=/sys/fs/cgroup/saycode/run-p4/attempt-a/epoch-0

apt-get -qq update >/dev/null 2>&1
apt-get -qq install -y iproute2 iptables curl python3 >/dev/null 2>&1

# cgroup v2 위임. 세대 fence 와 실행 취소가 여기로 간다.
mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo "+pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
mkdir -p /sys/fs/cgroup/saycode && echo "+pids" > /sys/fs/cgroup/saycode/cgroup.subtree_control 2>/dev/null
mkdir -p "$CG" || { echo "FAIL cgroup bootstrap"; exit 1; }

groupadd -g 10600 saycodetool 2>/dev/null
useradd -u 10601 -M -s /bin/sh provideru 2>/dev/null
useradd -u 10602 -M -g 10600 -s /bin/sh toolu 2>/dev/null
mkdir -p /workspace/project/scratch && chmod 755 /workspace/project && chmod 1777 /workspace/project/scratch
sysctl -qw net.ipv4.ip_forward=1 >/dev/null 2>&1

# provider 의 자격. executor 가 여기에 닿지 못하는 것이 P4 의 목적이다.
mkdir -p /run/saycode/provider && chmod 700 /run/saycode/provider
# 소켓은 **일부러 개방 권한**으로 둔다. 0700 디렉터리에 두면 차단의 원인이
# mount 경계인지 DAC 인지 구분되지 않는다 (shield_mounts 뮤턴트가 그대로
# 통과했다).
mkdir -p /run/saycode/shared && chmod 777 /run/saycode/shared
echo "session-key-material" > /run/saycode/provider/session.key
chmod 600 /run/saycode/provider/session.key
chown -R provideru /run/saycode/provider

# ── 대조군: 통제된 사설/링크로컬/CGNAT/IPv6 listener ─────────────────────
# 원래 도달 불가한 주소로 "차단"을 판정하면 규칙이 없어도 통과한다. 그래서
# 실제로 응답하는 listener 를 이 호스트에 올린다.
ip link add p4dummy type dummy 2>/dev/null
ip addr add 10.0.0.5/32 dev p4dummy 2>/dev/null
ip addr add 169.254.169.254/32 dev p4dummy 2>/dev/null
ip addr add 100.64.0.5/32 dev p4dummy 2>/dev/null
ip -6 addr add fd00::5/128 dev p4dummy 2>/dev/null
ip link set p4dummy up
cat > /tmp/listener.py <<'PY'
import socket, sys, threading
def serve(family, addr):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(addr); s.listen(16)
    while True:
        c, _ = s.accept()
        c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 7\r\n\r\nREACHED"); c.close()
for a in [("10.0.0.5", 8080), ("169.254.169.254", 80), ("100.64.0.5", 8080)]:
    threading.Thread(target=serve, args=(socket.AF_INET, a), daemon=True).start()
threading.Thread(target=serve, args=(socket.AF_INET6, ("fd00::5", 8080)), daemon=True).start()
threading.Event().wait()
PY
python3 /tmp/listener.py & LISTENER=$!
sleep 1
# 대조군이 실제로 응답하는지 먼저 확인한다. 응답하지 않으면 아래 "차단" 은
# 아무것도 증명하지 못한다.
CTRL=$(timeout 5 curl -s -o /dev/null -w '%{http_code}' http://10.0.0.5:8080/ || echo 000)
[[ "$CTRL" == "200" ]] && ok "controlled private listener answers from the host ($CTRL)" \
  || no "controlled private listener is not answering ($CTRL) — blocking proves nothing"
# DNS 로 사설 주소를 가리키게 한다. 판정이 문자열이 아니라 **연결된 주소**인지 본다.
grep -q 'rebind.p4.test' /etc/hosts || echo "10.0.0.5 rebind.p4.test" >> /etc/hosts

# ── 제품이 실행할 도구들. 전부 executor 안에서 돈다 ──────────────────────
install_tool() { cat > "$LIB/$1"; chmod 0555 "$LIB/$1"; }
install_tool probe-identity <<'T'
#!/bin/sh
echo "uid=$(id -u) gid=$(id -g) cwd=$(pwd)"
# execve 시점의 환경 그대로. 쉘이 더한 PWD 등은 여기 없다.
# `$$` 는 execve 된 프로세스 자신이다. 자식의 environ 에는 쉘이 더한 PWD 가 섞인다.
echo "env=$(tr '\000' ';' < /proc/$$/environ)"
# FD 열거는 `/usr/local/lib/saycode/fdprobe.py` 가 한다 — 고정 범위로 세면 70000 같은 고번호를
# 놓친다(§5.36 에서 실제로 걸린 함정). dirfd 는 fstat 으로 걸러진다.
FDOUT=$(/usr/bin/python3 /usr/local/lib/saycode/fdprobe.py 2>&1); echo "${FDOUT} rc=$?"
CTLOUT=$(/usr/bin/python3 /usr/local/lib/saycode/fdprobe.py control 2>&1); echo "${CTLOUT} rc=$?"
# 호스트 파일시스템이 그대로 보이면 mount namespace 는 사본일 뿐 경계가 아니다.
echo "run-entries=$(ls -A /run 2>/dev/null | wc -l) home-entries=$(ls -A /home 2>/dev/null | wc -l)"
# 차폐가 곧 고장이 되면 안 된다. 강등된 도구가 자기 임시 파일을 만들 수 있어야 한다.
TMPF=$(mktemp 2>/dev/null) && echo "hello" > "$TMPF" 2>/dev/null \
  && echo "tmp-write=ok:$(cat "$TMPF")" || echo "tmp-write=failed"
echo "pids=$(ls /proc | grep -cE '^[0-9]+$')"
echo "provider-visible=$(ls /proc | grep -c "^$(cat /workspace/project/scratch/provider.pid)$")"
echo "environ-read=$(cat /proc/$(cat /workspace/project/scratch/provider.pid)/environ 2>/dev/null | wc -c)"
echo "key-read=$(cat /run/saycode/provider/session.key 2>/dev/null | wc -c)"
T
install_tool probe-connect <<'T'
#!/bin/sh
# 목적지는 파일로 받는다 — 도구가 인자를 고르지 못한다.
for target in $(cat /usr/local/lib/saycode/p4-targets); do
  # curl 은 실패해도 `%{http_code}` 로 000 을 낸다. `|| echo 000` 을 덧붙이면
  # 두 값이 이어져 `000000` 이 된다.
  code=$(timeout 5 curl -g -s -o /dev/null -w '%{http_code}' "$target" 2>/dev/null)
  echo "$target=$code"
done
T
install_tool probe-rawsocket <<'T'
#!/bin/sh
exec /usr/bin/python3 -c 'import socket,sys
try:
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    print("raw=created")
except PermissionError as e:
    print("raw=EPERM")
except OSError as e:
    print("raw=errno-%d" % e.errno)'
T
install_tool probe-unixsocket <<'T'
#!/bin/sh
exec /usr/bin/python3 -c 'import socket
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect("\0saycode-p4-abstract"); print("abstract=connected")
except OSError as e: print("abstract=errno-%d" % e.errno)
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect("/run/saycode/shared/ipc.sock"); print("file=connected")
except OSError as e: print("file=errno-%d" % e.errno)'
T
install_tool probe-sleep <<'T'
#!/bin/sh
echo started
sleep 120
T

# ── 제품 API 를 부르는 드라이버. 격리는 여기서 하지 않는다 ───────────────
cat > /tmp/p4-driver.cjs <<'JS'
const {
  createToolExecutor, defaultToolExecutorDeps, planToolExecutorIsolation,
} = require('/opt/toolRuntime.cjs');
const job = JSON.parse(process.argv[2]);
const plan = planToolExecutorIsolation({
  identity: { uid: 10602, gid: 10600 },
  providerIdentity: { uid: 10601, gid: 10601 },
});
// 양성 대조에서만 차단 규칙을 뺀다. 나머지는 제품이 만든 계획 그대로다.
if (job.denyOff) { plan.network.denyCidrs = []; plan.network.denyCidrs6 = []; }
const executor = createToolExecutor(defaultToolExecutorDeps({
  helperPath: '/usr/local/lib/saycode/executor-helper',
  workloadPath: '/usr/local/lib/saycode/' + job.tool,
  cgroupPath: process.env.P4_CGROUP,
}));
let checks = 0;
executor.run({
  plan,
  call: { name: 'probe', arguments: {} },
  timeoutMs: job.timeoutMs || 30000,
  // park 뒤 취소를 흉내내는 경우에만 두 번째 검증에서 거부한다.
  recheckGrant: () => ({ ok: job.revokeAfterPark ? ++checks < 2 : true }),
}).then((outcome) => {
  console.log(JSON.stringify(outcome));
  process.exit(0);
}, (error) => { console.log(JSON.stringify({ ok: false, code: 'driver-error', detail: String(error && error.message) })); process.exit(1); });
JS
run_product() { P4_CGROUP="$CG" timeout 90 node /tmp/p4-driver.cjs "$1" 2>/dev/null; }

# provider 를 띄워 둔다 (자격 보유 프로세스).
cat > /tmp/provider.sh <<'P'
#!/bin/sh
echo "$$" > /workspace/project/scratch/provider.pid
exec 7</run/saycode/provider/session.key
sleep 600
P
chmod 755 /tmp/provider.sh
rm -f /workspace/project/scratch/provider.pid
# 자격은 execve 시점의 환경에 실어야 한다. 쉘 안의 `export` 는
# `/proc/<pid>/environ` 을 바꾸지 않는다 — 그러면 대조군이 비어 버린다.
env ANTHROPIC_AUTH_TOKEN=capability-for-this-run \
  setpriv --reuid=10601 --regid=10601 --clear-groups /tmp/provider.sh &
for i in $(seq 1 40); do [[ -s /workspace/project/scratch/provider.pid ]] && break; sleep 0.25; done
PROVIDER_PID=$(cat /workspace/project/scratch/provider.pid 2>/dev/null || echo "")
[[ -n "$PROVIDER_PID" ]] && ok "provider is running (pid $PROVIDER_PID)" || no "provider did not start"
# 양성 대조: 자격은 실제로 존재한다. 없으면 아래 "못 읽는다" 는 공허하다.
# procfs 는 크기를 0 으로 보고한다. 실제로 읽어서 확인한다.
[[ "$(tr '\000' '\n' < /proc/$PROVIDER_PID/environ 2>/dev/null | grep -c ANTHROPIC_AUTH_TOKEN)" == "1" ]] \
  && ok "the provider really holds a credential (control)" \
  || no "provider credential control failed"

echo "== 제품 실행: 신원·env·fd·PID namespace =="
OUT=$(run_product '{"tool":"probe-identity"}')
CONTENT=$(node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(o.content||"")' "$OUT" 2>/dev/null)
[[ "$(node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(o.ok===true?"ok":"bad")' "$OUT")" == "ok" ]] \
  || no "identity run did not succeed: $OUT"
[[ -n "$CONTENT" ]] && ok "the product executor ran the tool" || no "product run produced no output: $OUT"
echo "$CONTENT" | grep -q 'uid=10602 gid=10600' \
  && ok "the tool runs as the executor uid, not the provider" || no "wrong identity: $CONTENT"
echo "$CONTENT" | grep -q 'cwd=/workspace/project' \
  && ok "the tool starts in the fixed workspace root" || no "wrong cwd: $CONTENT"
# env 는 계획과 **정확히** 같아야 한다. "자격이 없다" 가 아니라 "그것뿐이다".
echo "$CONTENT" | grep -q 'env=PATH=/usr/local/bin:/usr/bin:/bin;$' \
  && ok "the tool environment is exactly the planned one" || no "unexpected env: $(echo "$CONTENT" | grep '^env=')"
# 정확 일치. `0,1,2,70000` 같은 것이 통과하면 안 된다.
[[ "$(echo "$CONTENT" | grep '^fds=')" == "fds=0,1,2 rc=0" ]] \
  && ok "the tool inherited exactly stdio and nothing else" \
  || no "unexpected fds: $(echo "$CONTENT" | grep '^fds=')"
# 자기 대조: 같은 측정이 일부러 연 FD 9 를 실제로 본다.
# 자기 대조: 같은 측정이 dup2 로 만든 **고번호** FD 70000 을 실제로 본다.
echo "$CONTENT" | grep -qF ',70000' \
  && ok "the FD measurement really sees a high-numbered descriptor (control)" \
  || no "FD measurement control: $(echo "$CONTENT" | grep '^control=')"
echo "$CONTENT" | grep -q 'provider-visible=0' \
  && ok "the provider pid is invisible in the tool PID namespace" || no "provider pid visible: $CONTENT"
echo "$CONTENT" | grep -q 'environ-read=0' \
  && ok "the tool cannot read the provider environment" || no "provider environ readable: $CONTENT"
echo "$CONTENT" | grep -q 'key-read=0' \
  && ok "the tool cannot read the session key file" || no "session key readable: $CONTENT"
echo "$CONTENT" | grep -qF 'tmp-write=ok:hello' \
  && ok "the tool can still create and write its own temp file" \
  || no "temp file write broken by the mount shield: $(echo "$CONTENT" | grep '^tmp-write=')"
echo "$CONTENT" | grep -q 'run-entries=0 home-entries=0' \
  && ok "the mount boundary hides /run and /home from the tool" || no "host filesystem visible: $CONTENT"
# 양성 대조: 같은 경로들이 호스트에는 실제로 채워져 있다.
[[ "$(ls -A /run | wc -l)" -gt 0 ]] && ok "/run really has entries on the host (control)" \
  || no "/run control failed — the empty view proves nothing"

echo "== 네트워크: 같은 listener 를 대상별로 규칙 off/on 대조 =="
cat > /usr/local/lib/saycode/p4-targets <<'T'
http://10.0.0.5:8080/
http://169.254.169.254/
http://100.64.0.5:8080/
http://[fd00::5]:8080/
http://rebind.p4.test:8080/
T
# 실행 자체가 성공했는지 먼저 본다. executor 가 실패했거나 출력이 비어도
# "연결 안 됨" 으로 보이므로, ok/code 를 관찰하기 전에는 차단이라 부르지 않는다.
run_ok() { node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(o.ok===true?"ok":("bad:"+(o.code||"no-output")))' "$1"; }
run_content() { node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(o.content||"")' "$1"; }

POS_RAW=$(run_product '{"tool":"probe-connect","denyOff":true}')
BLK_RAW=$(run_product '{"tool":"probe-connect"}')
[[ "$(run_ok "$POS_RAW")" == "ok" ]] && ok "the rule-off control run itself succeeded" \
  || no "rule-off run failed: $(run_ok "$POS_RAW")"
[[ "$(run_ok "$BLK_RAW")" == "ok" ]] && ok "the rule-on run itself succeeded" \
  || no "rule-on run failed: $(run_ok "$BLK_RAW")"
POSITIVE=$(run_content "$POS_RAW")
BLOCKED=$(run_content "$BLK_RAW")
# 대상 5개가 전부 결과를 냈는지. 줄이 없으면 판정할 것이 없다.
[[ "$(echo "$BLOCKED" | grep -c '=')" == "5" ]] && ok "every target reported a result under the rules" \
  || no "missing target results: $BLOCKED"

# IPv4 세 대상 + DNS: 대상마다 양성(규칙 off 에서 200) 과 음성(규칙 on 에서 차단) 을 짝지어 본다.
# 비교는 고정 문자열이다 — `[fd00::5]` 같은 값이 정규식 문자 클래스로 읽히면
# 어떤 결과든 불일치가 되어 항상 통과한다.
for t in 'http://10.0.0.5:8080/' 'http://169.254.169.254/' 'http://100.64.0.5:8080/' 'http://rebind.p4.test:8080/'; do
  echo "$POSITIVE" | grep -qF "$t=200" \
    && ok "rule-off positive: $t IS reachable" \
    || no "rule-off positive failed for $t — blocking proves nothing ($(echo "$POSITIVE" | grep -F "$t="))"
  echo "$BLOCKED" | grep -qF "$t=200" \
    && no "rule-on: $t is still reachable" \
    || ok "rule-on: $t is blocked ($(echo "$BLOCKED" | grep -F "$t="))"
done

# IPv6 는 **규칙으로 막은 것이 아니다.** veth 에 v6 주소도 경로도 주지 않으므로
# 애초에 나갈 길이 없다. 규칙 집행이라고 부르지 않고, 그 사실을 그대로 증명한다.
install_tool probe-v6 <<'T'
#!/bin/sh
echo "v6-global=$(/sbin/ip -6 addr show scope global | grep -c inet6)"
echo "v6-default=$(/sbin/ip -6 route show default | wc -l)"
T
V6=$(run_content "$(run_product '{"tool":"probe-v6"}')")
echo "$V6" | grep -qF 'v6-global=0' && echo "$V6" | grep -qF 'v6-default=0' \
  && ok "the executor has no IPv6 egress at all (no global address, no default route)" \
  || no "unexpected IPv6 configuration: $V6"
echo "$POSITIVE" | grep -qF 'http://[fd00::5]:8080/=200' \
  && no "IPv6 reached the listener — then the deny rules are what must block it" \
  || ok "IPv6 is unreachable even with the deny rules off (no egress, not a rule)"
# 양성 대조: 그 IPv6 listener 자체는 호스트에서 살아 있다.
V6CTRL=$(timeout 5 curl -g -s -o /dev/null -w '%{http_code}' 'http://[fd00::5]:8080/' || echo 000)
[[ "$V6CTRL" == "200" ]] && ok "the IPv6 listener answers on the host (control)" \
  || no "IPv6 listener control failed ($V6CTRL)"

echo "== 게이트웨이 주소는 다음 홉일 뿐 목적지가 아니다 =="
python3 -c 'import socket,threading
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR,1); s.bind(("0.0.0.0",9099)); s.listen(8)
while True:
    c,_=s.accept(); c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 7\r\n\r\nREACHED"); c.close()' &
GWSERVICE=$!
sleep 1
HOSTCODE=$(timeout 5 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9099/ || echo 000)
[[ "$HOSTCODE" == "200" ]] && ok "the host service on 0.0.0.0:9099 is live (control)" \
  || no "host service control failed ($HOSTCODE)"
install_tool probe-gateway <<'T'
#!/bin/sh
GW=$(/sbin/ip route | awk '/^default/{print $3}')
echo "gateway=$GW"
echo "gateway-code=$(timeout 5 curl -s -o /dev/null -w '%{http_code}' "http://$GW:9099/" 2>/dev/null)"
T
# **차단 규칙을 끈 채로** 본다. 그러지 않으면 `10.0.0.0/8` 필터가 게이트웨이
# (10.255.x.1)까지 덮어서, 게이트웨이 전용 규칙을 지워도 이 검사가 통과한다 —
# 실제로 그 뮤턴트가 통과하는 것을 확인하고 이렇게 바꿨다. denyOff 에서는
# 게이트웨이 규칙만이 유일한 차단 요인이다.
GW_RAW=$(run_product '{"tool":"probe-gateway","denyOff":true}')
[[ "$(run_ok "$GW_RAW")" == "ok" ]] || no "gateway run failed: $(run_ok "$GW_RAW")"
GWOUT=$(run_content "$GW_RAW")
echo "$GWOUT" | grep -qE 'gateway=10\.255\.' && ok "the executor routes through the product-assigned gateway" \
  || no "no gateway seen: $GWOUT"
echo "$GWOUT" | grep -q 'gateway-code=200' \
  && no "the host service is reachable at the gateway address" \
  || ok "the gateway address is refused as a destination"

echo "== 공개 인터넷은 살아 있다 =="
echo 'https://registry.npmjs.org/' > /usr/local/lib/saycode/p4-targets
PUB_RAW=$(run_product '{"tool":"probe-connect"}')
[[ "$(run_ok "$PUB_RAW")" == "ok" ]] || no "public-internet run failed: $(run_ok "$PUB_RAW")"
PUBLIC=$(run_content "$PUB_RAW")
echo "$PUBLIC" | grep -qF 'https://registry.npmjs.org/=200' \
  && ok "the public internet is still reachable through the product path" || no "public internet broken: $PUBLIC"

echo "== raw socket: 실제 syscall 로 판정하고 root 양성 대조를 둔다 =="
RAW_RAW=$(run_product '{"tool":"probe-rawsocket"}')
[[ "$(run_ok "$RAW_RAW")" == "ok" ]] || no "raw-socket run failed: $(run_ok "$RAW_RAW")"
RAW=$(run_content "$RAW_RAW")
echo "$RAW" | grep -qF 'raw=EPERM' \
  && ok "socket(AF_INET, SOCK_RAW) fails with EPERM inside the executor" || no "raw socket result: $RAW"
ROOTRAW=$(/usr/local/lib/saycode/probe-rawsocket)
[[ "$ROOTRAW" == "raw=created" ]] \
  && ok "root can create the same raw socket (control)" || no "raw socket control failed: $ROOTRAW"

echo "== unix socket: 추상/파일 둘 다 =="
python3 -c 'import socket;s=socket.socket(socket.AF_UNIX);s.bind("\0saycode-p4-abstract");s.listen(4);import time;time.sleep(600)' &
ABSTRACT=$!
python3 -c 'import socket,os;p="/run/saycode/shared/ipc.sock";os.path.exists(p) and os.unlink(p);s=socket.socket(socket.AF_UNIX);s.bind(p);os.chmod(p,0o777);s.listen(4);import time;time.sleep(600)' &
UNIXSOCK=$!
sleep 1
US_RAW=$(run_product '{"tool":"probe-unixsocket"}')
[[ "$(run_ok "$US_RAW")" == "ok" ]] || no "unix-socket run failed: $(run_ok "$US_RAW")"
US=$(run_content "$US_RAW")
echo "$US" | grep -q 'abstract=errno-' \
  && ok "the abstract unix socket is unreachable from the executor netns" || no "abstract unix socket: $US"
echo "$US" | grep -q 'file=errno-' \
  && ok "a world-accessible unix socket is unreachable through the mount boundary" \
  || no "unix socket reachable: $US"
# 양성 대조: 같은 두 소켓은 실제로 살아 있다.
CTRLUS=$(python3 -c 'import socket
for name,addr in (("abstract","\0saycode-p4-abstract"),("file","/run/saycode/shared/ipc.sock")):
    s=socket.socket(socket.AF_UNIX)
    try:
        s.connect(addr); print(name+"=connected")
    except OSError as e: print(name+"=errno-%d"%e.errno)')
[[ "$CTRLUS" == *"abstract=connected"* && "$CTRLUS" == *"file=connected"* ]] \
  && ok "both unix sockets are live for a host process (control)" || no "unix socket control: $CTRLUS"

echo "== 취소: 제품이 세대 cgroup 으로 끝낸다 =="
BEFORE=$(date +%s)
SLOW=$(P4_CGROUP="$CG" timeout 90 node /tmp/p4-driver.cjs '{"tool":"probe-sleep","timeoutMs":4000}' 2>/tmp/slow.err)
[[ -n "$SLOW" ]] || echo "NOTE slow-run stderr: $(tail -3 /tmp/slow.err)"
AFTER=$(date +%s)
echo "$SLOW" | grep -q 'execution-timeout' \
  && ok "a long call ends as execution-timeout" || no "timeout outcome: $SLOW"
(( AFTER - BEFORE < 60 )) && ok "the call was actually cut short ($((AFTER-BEFORE))s)" \
  || no "the call was not cut short ($((AFTER-BEFORE))s)"
sleep 1
PROCS=$(cat "$CG/cgroup.procs" 2>/dev/null | wc -l)
[[ "$PROCS" == "0" ]] && ok "the generation cgroup is empty after cancellation" \
  || no "processes survived cancellation in the cgroup ($PROCS)"

echo "== 세대 fence: supervisor 의 cgroup.kill 이 도구까지 닿는다 =="
P4_CGROUP="$CG" timeout 60 node /tmp/p4-driver.cjs '{"tool":"probe-sleep","timeoutMs":50000}' >/tmp/fence.out 2>/dev/null &
FENCE=$!
for i in $(seq 1 40); do [[ "$(cat "$CG/cgroup.procs" 2>/dev/null | wc -l)" -gt 0 ]] && break; sleep 0.25; done
INSIDE=$(cat "$CG/cgroup.procs" 2>/dev/null | wc -l)
(( INSIDE > 0 )) && ok "the running tool is inside the generation cgroup ($INSIDE)" \
  || no "the tool never joined the generation cgroup"
echo 1 > "$CG/cgroup.kill" 2>/dev/null
wait $FENCE 2>/dev/null
grep -q 'execution' /tmp/fence.out && ok "the generation fence terminated the tool run: $(cat /tmp/fence.out)" \
  || no "fence outcome: $(cat /tmp/fence.out)"

echo "== 취소된 실행은 execve 되지 않는다 =="
rm -f /workspace/project/scratch/p4-cancelled
install_tool probe-mark <<'T'
#!/bin/sh
echo ran > /workspace/project/scratch/p4-cancelled
T
CANCELLED=$(run_product '{"tool":"probe-mark","revokeAfterPark":true}')
echo "$CANCELLED" | grep -q 'tool-unavailable' \
  && ok "a grant revoked while parked yields tool-unavailable" || no "cancel outcome: $CANCELLED"
[[ -f /workspace/project/scratch/p4-cancelled ]] && no "the cancelled tool executed anyway" \
  || ok "the cancelled tool never executed"

echo "== 취소가 실제로 증명됐는지 =="
echo "$SLOW" | grep -q '"cancelProven":true' \
  && ok "the executor proved the cancellation, it did not assume it" || no "cancellation unproven: $SLOW"

kill "$PROVIDER_PID" "$LISTENER" "$ABSTRACT" "$UNIXSOCK" "$GWSERVICE" 2>/dev/null || true
# 실행마다 남는 것이 없어야 한다 — veth 와 NAT 규칙이 쌓이면 결국 주소가 겹친다.
LEFT=$(ip -o link show | grep -c 'veth-h')
NATLEFT=$(iptables -t nat -S POSTROUTING | grep -c '10.255.')
[[ "$LEFT" == "0" && "$NATLEFT" == "0" ]] \
  && ok "no veth link or NAT rule was left behind" || no "host state left behind (links=$LEFT nat=$NATLEFT)"
echo "NOTE P4 is NOT complete: the Codex provider boundary is unsettled and activation stays 0"
exit $FAIL
