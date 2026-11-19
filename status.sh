#!/usr/bin/env bash
# 查看运行状态
set -uo pipefail
cd "$(dirname "$0")" || exit 1

if [ -f rules-ui.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./rules-ui.env
  set +a
fi

PORT="${PORT:-3085}"
DATA_DIR="${RULES_DATA_DIR:-}"
CONF="${MIHOMO_CONFIG_PATH:-/etc/mihomo/config.yaml}"

PID="$(cat data/server.pid 2>/dev/null || true)"
if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
  echo "进程：运行中 PID ${PID}"
else
  echo "进程：未运行"
fi

if curl -sf -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "健康：OK  http://127.0.0.1:${PORT}"
  curl -s -m 5 "http://127.0.0.1:${PORT}/api/state" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const d=JSON.parse(s);const m=d.meta||{};
    console.log("主配置：" + (m.configPath||"-"));
    console.log("自定义规则：" + (d.stats&&d.stats.total||0) + " 条，未应用改动：" + (m.pending?"有":"无"));
    console.log("主配置规则：" + (m.mainRuleCount||0) + " 条，rule-providers：" + (m.installed?"已接入":"未接入"));
  }catch(e){}
});'
else
  echo "健康：无响应"
fi

if [ -n "${DATA_DIR}" ]; then
  echo "数据目录：${DATA_DIR}"
  if [ -d "${DATA_DIR}" ]; then
    ls -la "${DATA_DIR}"
  else
    echo "  ⚠ 目录不存在，请先创建：sudo install -d -o $(id -un) -g $(id -gn) -m 755 ${DATA_DIR}"
  fi
else
  echo "数据目录：（未设置 RULES_DATA_DIR，默认在主配置同级 rules/）"
fi

echo "主配置：${CONF}"
[ -f "${CONF}" ] && echo "  ✓ 存在" || echo "  ⚠ 不存在，请检查 MIHOMO_CONFIG_PATH"

echo "--- 最近日志 ---"
tail -n 15 logs/rules-ui.log 2>/dev/null || echo "(无日志)"
