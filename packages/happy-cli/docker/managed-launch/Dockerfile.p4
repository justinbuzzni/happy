# specs/managed-cloud-byos P4 — tool executor 격리 실증 전용 이미지.
#
# §5.36 의 `Dockerfile` 은 동결이라 건드리지 않는다. helper 소스는
# `src/launcher/executorHelper.c` 하나뿐이고 여기로 복사본을 두지 않는다.
# 제품 API 번들(`stage/toolRuntime.cjs`)은 /tmp 스테이징에서 온다.
FROM node:22
RUN apt-get -qq update && apt-get -qq install -y gcc >/dev/null && rm -rf /var/lib/apt/lists/*
COPY src/launcher/executorHelper.c /build/executorHelper.c
RUN mkdir -p /usr/local/lib/saycode \
 && gcc -O2 -Wall -Wextra -Werror -o /usr/local/lib/saycode/executor-helper /build/executorHelper.c \
 && chown root:root /usr/local/lib/saycode/executor-helper \
 && chmod 0500 /usr/local/lib/saycode/executor-helper
COPY stage/toolRuntime.cjs /opt/toolRuntime.cjs
COPY src/launcher/execHelper.c /build/execHelper.c
RUN gcc -O2 -Wall -Wextra -Werror -o /usr/local/lib/saycode/exec-helper /build/execHelper.c \
 && chown root:root /usr/local/lib/saycode/exec-helper \
 && chmod 0500 /usr/local/lib/saycode/exec-helper
COPY docker/managed-launch/fdprobe.py /usr/local/lib/saycode/fdprobe.py
RUN chmod 0555 /usr/local/lib/saycode/fdprobe.py
COPY docker/managed-launch/verify-p4-isolation.sh /verify-p4-isolation.sh
COPY docker/managed-launch/verify-p4-provider.sh /verify-p4-provider.sh
COPY docker/managed-launch/p4-provider-harness.mjs /opt/p4-provider-harness.mjs
COPY docker/managed-launch/p4-fake-anthropic.mjs /opt/p4-fake-anthropic.mjs
COPY docker/managed-launch/p4-provider-entry.sh /usr/local/lib/saycode/provider-entry.sh
COPY docker/managed-launch/p4-tool-runner.sh /opt/p4-tool-runner.sh
COPY docker/managed-launch/p4-tool-workload.mjs /usr/local/lib/saycode/tool-workload.mjs
COPY docker/managed-launch/p4-tool-workload.sh /usr/local/lib/saycode/tool-workload
# 검증 전용 SDK 번들과 그 CLI. **호스트를 mount 하지 않는다** — 빌드 컨텍스트의
# `stage/` 에서 온다(소스 트리에 두지 않는 산출물, §5.36 과 같은 방식).
# `/opt` 은 이 이미지에서 root 전용이라 강등된 provider(uid 10601)가 못 읽는다.
# 신뢰 디렉터리에 두고 0555 로 연다(실측으로 확인한 실패였다).
COPY stage/sdk /usr/local/lib/saycode/sdk
COPY stage/codex /usr/local/lib/saycode/codex
COPY stage/toolRuntime.cjs /usr/local/lib/saycode/toolRuntime.cjs
COPY docker/managed-launch/p4-codex-entry.sh /usr/local/lib/saycode/codex-entry.sh
COPY docker/managed-launch/p4-codex-provider-main.mjs /usr/local/lib/saycode/codex-provider-main.mjs
COPY docker/managed-launch/p4-codex-harness.mjs /opt/p4-codex-harness.mjs
COPY docker/managed-launch/p4-fake-responses.mjs /opt/p4-fake-responses.mjs
COPY docker/managed-launch/verify-p4-codex.sh /verify-p4-codex.sh
COPY docker/managed-launch/verify-p4-coding.sh /verify-p4-coding.sh
COPY docker/managed-launch/p4-coding-probe.js /opt/p4-coding-probe.js
RUN chmod 0555 /usr/local/lib/saycode/provider-entry.sh /usr/local/lib/saycode/sdk/claude \
 && chmod 0444 /usr/local/lib/saycode/sdk/sdk.mjs \
 && chmod 0555 /usr/local/lib/saycode/sdk \
 && chmod 0555 /usr/local/lib/saycode/codex-entry.sh /usr/local/lib/saycode/tool-workload \
 && chmod 0444 /usr/local/lib/saycode/tool-workload.mjs \
 && chmod 0444 /usr/local/lib/saycode/codex-provider-main.mjs /usr/local/lib/saycode/toolRuntime.cjs \
 && chmod -R a+rX /usr/local/lib/saycode/codex \
 && chmod +x /usr/local/lib/saycode/codex/bin/codex \
 && chmod +x /verify-p4-isolation.sh /verify-p4-provider.sh /verify-p4-codex.sh /verify-p4-coding.sh
