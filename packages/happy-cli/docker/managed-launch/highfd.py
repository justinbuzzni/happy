#!/usr/bin/env python3
"""고번호 FD 를 상속시킨 채 helper 를 exec 한다.

고정 상한(예전 65536)까지만 훑는 구현은 이 FD 를 닫지 못한다. Node 로는 임의
번호의 FD 를 상속시키기 어려워 여기서만 python 을 쓴다 — **검증 도구**이며
런타임 코드가 아니다.
"""
import os, sys

helper, cgroup, uid, status_path, release_path, high_fd = sys.argv[1:7]
high = int(high_fd)

marker = os.open('/tmp/high-fd-marker', os.O_RDWR | os.O_CREAT, 0o600)
os.dup2(marker, high, inheritable=True)
os.set_inheritable(high, True)

status = os.open(status_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.dup2(status, 9, inheritable=True); os.set_inheritable(9, True)
release = os.open(release_path, os.O_RDONLY)
os.dup2(release, 8, inheritable=True); os.set_inheritable(8, True)

os.execve(helper, [helper, '9', '8', cgroup, uid, uid, '0',
                   '/usr/local/lib/saycode/list-fds'],
          {'PATH': '/usr/local/bin:/usr/bin:/bin'})
