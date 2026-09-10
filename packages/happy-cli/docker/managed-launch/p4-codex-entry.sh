#!/bin/sh
# codex provider 프로세스의 진입점. 계획의 인자·env 는 이미 이 프로세스의 것이다.
exec /usr/local/bin/node /usr/local/lib/saycode/codex-provider-main.mjs >>/run/provider-stderr.log 2>&1
