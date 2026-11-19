#!/usr/bin/env bash
# 启动规则管理网页（后台常驻）。重复执行是安全的。
set -uo pipefail
cd "$(dirname "$0")" || exit 1

# 载入本地环境配置（不入库；参考 rules-ui.env.example）
if [ -f rules-ui.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./rules-ui.env
  set +a
fi

PORT="${PORT:-3085}"
export PORT

mkdir -p logs data

if [ -f data/server.pid ]; then
  OLD="$(cat data/server.pid 2>/dev/null || true)"
  if [ -n "${OLD}" ] && kill -0 "${OLD}" 2>/dev/null; then
    echo "已在运行：PID ${OLD}"
    curl -sf -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null && echo "健康检查通过 http://127.0.0.1:${PORT}"
    exit 0
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js (>=18)" >&2
  exit 1
fi

nohup node server.js >> logs/rules-ui.log 2>&1 &
PID=$!
echo "${PID}" > data/server.pid

for i in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "启动成功：PID ${PID}，监听 ${PORT}"
    echo "打开 http://127.0.0.1:${PORT} （局域网用 http://<服务器IP>:${PORT}）"
    echo "主配置：${MIHOMO_CONFIG_PATH:-（默认）}"
    exit 0
  fi
  sleep 0.3
done

echo "启动失败，最近日志：" >&2
tail -n 30 logs/rules-ui.log >&2
exit 1
