# 열린 FD 를 **고정 범위 없이** 센다. `range(4096)` 은 §5.36 에서 확인한
# 고번호 FD(70000)를 놓친다 — 정확히 그 함정이다.
# `os.listdir` 자신의 dirfd 는 결과에 섞이므로, 열거 뒤 닫힌 것을 제외한다.
import os, sys
def open_fds():
    listed = os.listdir('/proc/self/fd')
    found = []
    for name in listed:
        fd = int(name)
        try:
            os.fstat(fd)          # 아직 열려 있는가 — listdir 의 dirfd 는 여기서 걸러진다
        except OSError:
            continue
        found.append(fd)
    return sorted(found)
if len(sys.argv) > 1 and sys.argv[1] == 'control':
    # 측정이 실제로 고번호 FD 를 보는지. 없으면 위의 "0,1,2 뿐" 은 공허하다.
    marker = os.open('/etc/hostname', os.O_RDONLY)
    os.dup2(marker, 70000)
    print('control=' + ','.join(str(f) for f in open_fds()))
else:
    print('fds=' + ','.join(str(f) for f in open_fds()))
