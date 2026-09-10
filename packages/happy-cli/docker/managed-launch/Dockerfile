# specs/managed-cloud-byos §5.36 — helper 빌드와 Linux 수락 검증 전용 이미지.
#
# build context 는 packages/happy-cli 루트다. helper 소스는 `src/launcher/execHelper.c`
# **하나뿐**이며 여기로 복사본을 두지 않는다 — 두 벌이 되면 한쪽만 고쳐진다.
# `libcap-dev` 는 쓰지 않는다: CAP_LAST_CAP 상수는 `linux/capability.h` 에 있다.
FROM node:22
RUN apt-get -qq update && apt-get -qq install -y gcc >/dev/null && rm -rf /var/lib/apt/lists/*
COPY src/launcher/execHelper.c /build/execHelper.c
RUN mkdir -p /usr/local/lib/saycode \
 && gcc -O2 -Wall -Wextra -Werror -o /usr/local/lib/saycode/exec-helper /build/execHelper.c \
 && chown root:root /usr/local/lib/saycode/exec-helper \
 && chmod 0500 /usr/local/lib/saycode/exec-helper
COPY docker/managed-launch/highfd.py /opt/highfd.py
COPY docker/managed-launch/verify-exec.sh /verify-exec.sh
COPY docker/managed-launch/verify-fence.sh /verify-fence.sh
COPY docker/managed-launch/verify-ipc.sh /verify-ipc.sh
# 검증 전용 번들. **소스 트리에 두지 않고** /tmp 스테이징에서 온다.
COPY stage/supervisor.cjs /opt/supervisor.cjs
COPY stage/manifestEntry.cjs /opt/manifestEntry.cjs
COPY stage/envelope.cjs /opt/envelope.cjs
RUN chmod +x /verify-exec.sh /verify-fence.sh /verify-ipc.sh
