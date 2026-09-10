#!/bin/sh
# 제품 executor 가 격리 안에서 execve 하는 도구. 호출 JSON 은 stdin 으로 온다.
CALL=$(cat)
# 경로는 호출에서 꺼내되, 언제나 고정된 workspace 안에서만 연다.
FILE=$(printf '%s' "$CALL" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
case "$FILE" in
  */*|"") echo "refused"; exit 1;;
esac
printf 'FILE(%s)=%s uid=%s' "$FILE" "$(cat "./$FILE" 2>/dev/null)" "$(id -u)"
