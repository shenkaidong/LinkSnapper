#!/usr/bin/env bash
#
# 一键体验：起服务 → 真截三张图 → 把图片落盘 → 打印 MCP 配置片段。
#
#   bash scripts/demo.sh                 # 有 docker 就用容器
#   DEMO_LOCAL=1 bash scripts/demo.sh    # 跳过容器，用已经起在 3000 的服务
#   DEMO_KEEP=1 bash scripts/demo.sh     # 结束后保留容器，不自动清理
#
# 演示用的是服务自带的基准页 /test-fixture.html（3000px 高、50 条纯色横条），
# 因此**整个流程不需要联网**。代价是要把 127.0.0.1 加进内网放行名单 ——
# 这是 demo 专用的一步，正式部署时不要照抄这个环境变量。
#
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
IMAGE="${IMAGE:-ghcr.io/shenkaidong/linksnapper:latest}"
OUT_DIR="${OUT_DIR:-/tmp/linksnapper-demo}"
CONTAINER="linksnapper-demo"
STARTED_CONTAINER=0

mkdir -p "$OUT_DIR"

cleanup() {
  if [[ "$STARTED_CONTAINER" == "1" && "${DEMO_KEEP:-0}" != "1" ]]; then
    echo
    echo "==> 清理容器"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. 起服务
# ---------------------------------------------------------------------------
if [[ "${DEMO_LOCAL:-0}" == "1" ]]; then
  echo "==> 使用已有服务 ${BASE_URL}"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "==> 启动容器 ${IMAGE}"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -p "${PORT}:3000" --shm-size=1g \
    -e ALLOWED_INTERNAL_HOSTS=127.0.0.1 \
    "$IMAGE" >/dev/null
  STARTED_CONTAINER=1
else
  echo "==> 未找到可用的 docker，改用已有服务 ${BASE_URL}"
fi

# ---------------------------------------------------------------------------
# 2. 等就绪
# ---------------------------------------------------------------------------
echo "==> 等待服务就绪"
ready=0
for _ in $(seq 1 60); do
  if curl -sf "${BASE_URL}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [[ "$STARTED_CONTAINER" == "1" ]] && ! docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "容器已退出，日志：" >&2
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "服务在 60 秒内未就绪：${BASE_URL}/api/health" >&2
  [[ "$STARTED_CONTAINER" == "1" ]] && docker logs "$CONTAINER" >&2 || true
  exit 1
fi
echo "   就绪：$(curl -s "${BASE_URL}/api/health" | head -c 200)"

# ---------------------------------------------------------------------------
# 3. 真截图
# ---------------------------------------------------------------------------
FIXTURE="${BASE_URL}/test-fixture.html"

decode_png() {
  node -e '
    const fs = require("fs")
    const out = process.argv[1]
    const json = JSON.parse(fs.readFileSync(0, "utf8"))
    if (!json.success) {
      process.stderr.write("接口返回失败：" + (json.error || "未知原因") + "\n")
      process.exit(1)
    }
    const buf = Buffer.from(json.screenshot, "base64")
    fs.writeFileSync(out, buf)
    process.stdout.write(String(buf.length))
  ' "$1"
}

shot() {
  local label="$1" outfile="$2" body="$3"
  local size
  if ! size=$(curl -sf -X POST "${BASE_URL}/api/screenshot" \
      -H 'content-type: application/json' -d "$body" | decode_png "$outfile"); then
    echo "  ✗ ${label} —— 截图失败"
    return 1
  fi
  printf '  ✓ %-22s %s (%s KB)\n' "$label" "$outfile" "$(( size / 1024 ))"
}

echo
echo "==> 截三张图"
shot "视口截图" "${OUT_DIR}/1-viewport.png" \
  "{\"url\":\"${FIXTURE}\",\"singleShot\":true,\"width\":1200,\"height\":800}"

shot "手机设备模拟" "${OUT_DIR}/2-mobile.png" \
  "{\"url\":\"${FIXTURE}\",\"singleShot\":true,\"device\":\"mobile\"}"

shot "按选择器截元素" "${OUT_DIR}/3-element.png" \
  "{\"url\":\"${FIXTURE}\",\"selector\":\".band[data-index=\\\"3\\\"]\"}"

# ---------------------------------------------------------------------------
# 4. 怎么用
# ---------------------------------------------------------------------------
cat <<EOF

==> 图片已保存到 ${OUT_DIR}

把它接到 Claude / Cursor 上（写入各自的 MCP 配置文件后重启客户端）：

  {
    "mcpServers": {
      "linksnapper": {
        "command": "npx",
        "args": ["-y", "linksnapper-mcp"],
        "env": { "LINKSNAPPER_BASE_URL": "${BASE_URL}" }
      }
    }
  }

也可以直接用 HTTP：

  curl -X POST ${BASE_URL}/api/screenshot \\
    -H 'content-type: application/json' \\
    -d '{"url":"https://example.com","fullPage":true}' | jq -r .screenshot | base64 -d > page.png

EOF

if [[ "${DEMO_KEEP:-0}" == "1" && "$STARTED_CONTAINER" == "1" ]]; then
  echo "==> 容器保留中：docker rm -f ${CONTAINER} 可清理"
fi
