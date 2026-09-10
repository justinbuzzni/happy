#!/bin/sh
# provider 프로세스의 진입점. 계획의 sdkOptions 를 env 로 받아 SDK 를 소비한다.
# 실행 디렉터리는 생성된 workload 가 이미 계획의 cwd 로 옮겨 두었다.
# stdio 는 신뢰 helper 가 버리므로(검증 전용) 진단을 파일로 남긴다.
exec /usr/local/bin/node /usr/local/lib/saycode/provider-main.mjs >>/run/provider-stderr.log 2>&1
