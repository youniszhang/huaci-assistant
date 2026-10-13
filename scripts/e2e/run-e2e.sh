#!/usr/bin/env bash
#
# E2E 回归：mock SelectionHelper + 渲染层 CDP + 主进程 inspector
#
# 用法：
#   bash scripts/e2e/run-e2e.sh                    # 全部（v0.1.0 状态机 + v0.1.1 + 登录链路）
#   bash scripts/e2e/run-e2e.sh lifecycle          # 只跑工具条状态机
#   bash scripts/e2e/run-e2e.sh v011               # 只跑 v0.1.1（拖动/历史/autoPopup）
#   bash scripts/e2e/run-e2e.sh dsweb-login        # 只跑网页版登录链路（真机，隔离 profile）
#   bash scripts/e2e/run-e2e.sh dsweb-provider     # 只跑供应商条目补建（纯文件）
#   bash scripts/e2e/run-e2e.sh provider-crud      # 只跑供应商增删改（纯文件）
#   bash scripts/e2e/run-e2e.sh hotkey-lead        # 快捷键录制 + 结论置顶渲染
#   bash scripts/e2e/run-e2e.sh hotkey-firstpress  # 手动取词一次即弹（按两下问题）
#   bash scripts/e2e/run-e2e.sh context-menu       # 右键菜单（主窗口，原生）
#   bash scripts/e2e/run-e2e.sh overlay-ctxmenu    # 悬浮卡片右键菜单（自绘）
#   （provider-ui 需要手动准备临时 vault，见脚本头部说明）
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

# 登录链路用例不需要 mock helper（它不启动 electron），单独提前处理
if [ "${CASES[*]}" = "dsweb-login" ]; then
  echo "======== 用例: dsweb-login（真机，隔离 profile） ========"
  node "$ROOT/scripts/e2e/e2e-dsweb-login.js"
  exit $?
fi
if [ "${CASES[*]}" = "dsweb-provider" ]; then
  echo "======== 用例: dsweb-provider（供应商条目补建，纯文件） ========"
  node "$ROOT/scripts/e2e/e2e-dsweb-provider.js"
  exit $?
fi
if [ "${CASES[*]}" = "provider-crud" ]; then
  echo "======== 用例: provider-crud（供应商增删改，纯文件） ========"
  node "$ROOT/scripts/e2e/e2e-provider-crud.js"
  exit $?
fi
if [ "${CASES[*]}" = "provider-independence" ]; then
  echo "======== 用例: provider-independence（供应商配置独立，纯文件） ========"
  node "$ROOT/scripts/e2e/e2e-provider-independence.js"
  exit $?
fi
if [ "${CASES[*]}" = "hotkey-lead" ]; then
  # 快捷键录制 + 结论置顶：需要独立实例（会改隔离 userData 的快捷键设置）
  DIR2=/tmp/huaci-v015
  rm -rf "$DIR2"
  ./node_modules/.bin/electron . --remote-debugging-port=9222 --inspect=9339 --user-data-dir="$DIR2" > "$DIR2.log" 2>&1 &
  HPID=$!
  for i in $(seq 1 40); do
    curl -s "http://127.0.0.1:9222/json/version" >/dev/null 2>&1 && curl -s "http://127.0.0.1:9339/json/list" >/dev/null 2>&1 && break
    sleep 0.5
  done
  sleep 2
  WS_PATH="$ROOT/node_modules/ws" node "$ROOT/scripts/e2e/e2e-hotkey-lead.js"
  RC2=$?
  kill $HPID 2>/dev/null; sleep 1; pkill -f "user-data-dir=$DIR2" 2>/dev/null
  exit $RC2
fi

# 备份真实 helper（字节级还原 → CDHash 不变 → TCC 权限无损）
#
# 注意：备份必须来自「可信源」。曾出现 bin/SelectionHelper 被历史测试污染后，
# 备份跟着污染、还原也还原成错版本的情况 —— 而 helper 的 CDHash 决定了 TCC
# 授权是否有效，变了就要重新授权。因此优先用安装版的 helper 作为权威副本，
# 没有安装版时才回退到工作区副本（并打印警告）。
BEFORE=$(shasum -a 256 bin/SelectionHelper | awk '{print $1}')
INSTALLED_HELPER="/Applications/划词助手.app/Contents/Resources/bin/SelectionHelper"
if [ -f "$INSTALLED_HELPER" ]; then
  cp "$INSTALLED_HELPER" "$DIR/SelectionHelper.bak"
  # 工作区副本与安装版不一致 → 用安装版纠正（说明工作区被污染过）
  if ! cmp -s bin/SelectionHelper "$INSTALLED_HELPER"; then
    echo "⚠️  bin/SelectionHelper 与安装版不一致，已用安装版纠正（避免权限失效）"
    cp "$INSTALLED_HELPER" bin/SelectionHelper
    chmod +x bin/SelectionHelper
    BEFORE=$(shasum -a 256 bin/SelectionHelper | awk '{print $1}')
  fi
else
  echo "⚠️  未找到安装版 helper，改用工作区副本作备份（若它已被污染，CDHash 会变）"
  cp bin/SelectionHelper "$DIR/SelectionHelper.bak"
fi
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

# 预置 settings.json：
#  - autoPopup: true —— lifecycle/v011 用例验证的是「划词即弹」的状态机；
#    v0.1.5 起产品默认改为 false（快捷键触发），若不预置这些旧用例会全部超时。
#  - hotkeyCapture 留空 —— 避免与真机/其它测试实例抢全局快捷键。
mkdir -p "$DIR/userdata/huaci-dev"
cat > "$DIR/userdata/huaci-dev/settings.json" <<'JSON'
{
  "autoPopup": true,
  "hotkeyCapture": "",
  "hotkeyScan": "",
  "dswebHeadless": true
}
JSON

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
    hotkey-firstpress)
      # 前置：autoPopup 需为 true 以创建 overlay 窗口（用例内会自行切 false）
      WS_PATH="$ROOT/node_modules/ws" node scripts/e2e/e2e-hotkey-firstpress.js || RC=1
      ;;
    context-menu)
      WS_PATH="$ROOT/node_modules/ws" node scripts/e2e/e2e-context-menu.js || RC=1
      ;;
    overlay-ctxmenu)
      WS_PATH="$ROOT/node_modules/ws" node scripts/e2e/e2e-overlay-ctxmenu.js || RC=1
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
