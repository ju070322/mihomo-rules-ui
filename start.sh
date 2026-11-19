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

# 已在运行则直接返回；pid 文件陈旧则清掉
if [ -f data/server.pid ]; then
  OLD="$(cat data/server.pid 2>/dev/null || true)"
  if [ -n "${OLD}" ] && kill -0 "${OLD}" 2>/dev/null; then
    echo "已在运行：PID ${OLD}"
    curl -sf -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null && echo "健康检查通过 http://127.0.0.1:${PORT}"
    exit 0
  fi
  rm -f data/server.pid
fi

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js (>=18)" >&2
  exit 1
fi

# setsid 让进程脱离调用者的会话/进程组：父终端或会话被清理时不会被连带 SIGKILL。
# PID 由 server.js 自己写入 data/server.pid（setsid 可能 fork，$! 不一定准）。
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node server.js >> logs/rules-ui.log 2>&1 < /dev/null &
else
  nohup node server.js >> logs/rules-ui.log 2>&1 < /dev/null &
fi

for i in $(seq 1 40); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    PID="$(cat data/server.pid 2>/dev/null || echo '?')"
    echo "启动成功：PID ${PID}，监听 ${PORT}"
    echo "打开 http://127.0.0.1:${PORT} （局域网用 http://<服务器IP>:${PORT}）"
    echo "主配置：${MIHOMO_CONFIG_PATH:-（默认 /etc/mihomo/config.yaml）}"
    exit 0
  fi
  sleep 0.3
done

echo "启动失败，最近日志：" >&2
tail -n 30 logs/rules-ui.log >&2
exit 1
