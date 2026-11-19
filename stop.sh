#!/usr/bin/env bash
# 停止规则管理网页
set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3085}"
STOPPED=0

if [ -f data/server.pid ]; then
  PID="$(cat data/server.pid 2>/dev/null || true)"
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null && STOPPED=1
    for i in $(seq 1 20); do
      kill -0 "${PID}" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "${PID}" 2>/dev/null && kill -9 "${PID}" 2>/dev/null
  fi
  rm -f data/server.pid
fi

# 兜底：pid 文件丢了也按命令行特征清掉
if pgrep -f "node .*rules-ui/server.js" >/dev/null 2>&1; then
  pkill -f "node .*rules-ui/server.js" 2>/dev/null && STOPPED=1
fi

if [ "${STOPPED}" = "1" ]; then
  echo "已停止（端口 ${PORT} 已释放）"
else
  echo "没有在运行"
fi
