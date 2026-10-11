#!/usr/bin/env bash
#
# E2E 回归：mock SelectionHelper + 渲染层 CDP + 主进程 inspector
#
# 用法：
#   bash scripts/e2e/run-e2e.sh                    # 全部（v0.1.0 状态机 + v0.1.1）
#   bash scripts/e2e/run-e2e.sh lifecycle          # 只跑工具条状态机
#   bash scripts/e2e/run-e2e.sh v011               # 只跑 v0.1.1（拖动/历史/autoPopup）
#
# 关键点：
#  - helper 字节级备份/还原 → CDHash 不变 → TCC 权限无损
#  - 退出时必须清理 mock helper：它由 electron spawn，kill electron 会变孤儿，
#    遗留进程会抢读控制文件导致下一轮出现莫名其妙的断言失败（实测 2026-10-10）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DIR=/tmp/huaci-e2e
mkdir -p "$DIR"
rm -rf "$DIR/userdata" "$DIR/app.log"
: > /tmp/huaci-mock-ctrl

CASES=("$@")
[ ${#CASES[@]} -eq 0 ] && CASES=(lifecycle v011)

# 备份真实 helper（字节级还原 → CDHash 不变 → TCC 权限无损）
BEFORE=$(shasum -a 256 bin/SelectionHelper | awk '{print $1}')
cp bin/SelectionHelper "$DIR/SelectionHelper.bak"
cp scripts/e2e/mock-helper.js bin/SelectionHelper
chmod +x bin/SelectionHelper

# 清理：还原 helper + 杀掉一切残留 mock helper（孤儿 helper 是上一版的教训）
restore() {
  cp "$DIR/SelectionHelper.bak" bin/SelectionHelper
  chmod +x bin/SelectionHelper
  AFTER=$(shasum -a 256 bin/SelectionHelper | awk '{print $1}')
  echo "helper 还原: before=$BEFORE after=$AFTER $([ "$BEFORE" = "$AFTER" ] && echo OK || echo MISMATCH)"
  # 杀 mock helper（按本仓库路径特征；不影响安装版 helper）
  pkill -f "划词助手/bin/SelectionHelper" 2>/dev/null
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  sleep 1
  pkill -f "user-data-dir=$DIR/userdata" 2>/dev/null
  return 0
}
trap restore EXIT

# 启动 dev 实例（渲染 CDP 9334 + 主进程 inspector 9335，隔离 userData）
ELECTRON_ENABLE_LOGGING=1 ./node_modules/.bin/electron . \
  --remote-debugging-port=9334 \
  --inspect=9335 \
  --user-data-dir="$DIR/userdata" > "$DIR/app.log" 2>&1 &
APP_PID=$!
echo "electron pid=$APP_PID"

# 等两个端口就绪
for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:9334/json/version" >/dev/null 2>&1 && curl -s "http://127.0.0.1:9335/json/list" >/dev/null 2>&1 && break
  sleep 0.5
done
echo "CDP ready"

RC=0
for CASE in "${CASES[@]}"; do
  echo ""
  echo "======== 用例: $CASE ========"
  # 每个用例前清控制文件，避免上一用例残留事件串味
  : > /tmp/huaci-mock-ctrl
  case "$CASE" in
    lifecycle)
      WS_PATH="$ROOT/node_modules/ws" node scripts/e2e/e2e-toolbar-lifecycle.js || RC=1
      ;;
    v011)
      WS_PATH="$ROOT/node_modules/ws" node scripts/e2e/e2e-v011.js || RC=1
      ;;
    *)
      echo "未知用例: $CASE（可用: lifecycle v011）"; RC=1
      ;;
  esac
done

echo ""
echo "=== 主进程收起日志（末 10 条） ==="
grep "工具条收起" "$DIR/app.log" | tail -10

echo ""
echo "=== exit=$RC ==="
exit $RC
