#!/usr/bin/env bash
#
# 一条命令跑完整冒烟测试：起服务 → 等就绪 → 跑用例 → 收摊。
#
#   bash scripts/run-smoke.sh              # 使用已有构建产物
#   BUILD=1 bash scripts/run-smoke.sh      # 先重新构建
#   SMOKE_EXTERNAL=1 bash scripts/run-smoke.sh   # 额外跑外网用例
#
# 关键环境变量：
#   ALLOWED_INTERNAL_HOSTS=127.0.0.1
#     基准页跑在本机的 127.0.0.1 上，而内网拦截默认是开着的。
#     这里只精确放行 127.0.0.1 这一个主机 —— 其它内网地址仍然会被拦，
#     安全用例才有意义。用 ALLOW_PRIVATE_NETWORK=true 会把整个内网放开，
#     那种做法下安全用例必然失败。
#   ENABLE_TEST_ENDPOINTS=1
#     开启 /api/test-redirect，用来验证「重定向型 SSRF」是否真的被拦住。
#     该接口默认返回 404，且即使开启也只允许跳到固定的内网探针地址或站内路径。
#
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3100}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${LOG_FILE:-/tmp/linksnapper-smoke-server.log}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    pkill -P "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${BUILD:-0}" == "1" ]]; then
  echo "==> 构建"
  # NODE_OPTIONS 必须清空：某些运行环境会注入 fs 代理层，导致 next build 误报 EEXIST
  NODE_OPTIONS= npm run build
fi

if [[ ! -d .next ]]; then
  echo "缺少 .next 构建产物，请先执行：BUILD=1 bash scripts/run-smoke.sh" >&2
  exit 1
fi

echo "==> 启动服务 (端口 ${PORT})"
NODE_OPTIONS= \
PORT="$PORT" \
ALLOWED_INTERNAL_HOSTS="127.0.0.1" \
ENABLE_TEST_ENDPOINTS=1 \
RATE_LIMIT_CAPACITY="${RATE_LIMIT_CAPACITY:-100}" \
RATE_LIMIT_REFILL_PER_SEC="${RATE_LIMIT_REFILL_PER_SEC:-0.2}" \
npm run start >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

echo "==> 等待服务就绪"
ready=0
for _ in $(seq 1 40); do
  if curl -sf "${BASE_URL}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "服务进程已退出，日志尾部：" >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  echo "服务在 40 秒内未就绪，日志尾部：" >&2
  tail -30 "$LOG_FILE" >&2
  exit 1
fi

echo "==> 执行冒烟测试"
set +e
BASE_URL="$BASE_URL" SMOKE_EXTERNAL="${SMOKE_EXTERNAL:-0}" node scripts/smoke-test.mjs
RESULT=$?
set -e

if [[ "$RESULT" != "0" ]]; then
  echo "==> 失败，服务端日志尾部：" >&2
  tail -40 "$LOG_FILE" >&2
fi

exit "$RESULT"
