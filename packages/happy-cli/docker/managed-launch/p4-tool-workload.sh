#!/bin/sh
# 신뢰 helper 가 execve 하는 진입점. 실행 디렉터리는 helper 가 이미 workspace 로 옮겼다.
exec /usr/local/bin/node /usr/local/lib/saycode/tool-workload.mjs
