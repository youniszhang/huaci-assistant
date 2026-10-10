#!/usr/bin/env bash
#
# 划词助手 —— 一键构建 + 打包 DMG
#
# 用法：
#   bash scripts/build-macos.sh              # 完整构建（helper + esbuild + DMG）
#   bash scripts/build-macos.sh --no-dmg     # 只构建，不打 DMG（开发用）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_DMG=0
for arg in "$@"; do
  case "$arg" in
    --no-dmg) SKIP_DMG=1 ;;
  esac
done

echo "==> [1/5] 编译 Swift 划词助手"
bash swift/build.sh

echo "==> [2/5] 生成图标（应用 + 托盘）"
bash scripts/make-icons.sh "${ICON_VARIANT:-A}"

echo "==> [3/5] 类型检查"
npx tsc --noEmit --skipLibCheck

echo "==> [4/5] 打包渲染层与主进程 (esbuild)"
npm run build

if [ "$SKIP_DMG" = "1" ]; then
  echo "==> 跳过 DMG（--no-dmg）"
  echo "    开发运行：npm start"
  exit 0
fi

echo "==> [5/5] 生成 DMG (electron-builder)"
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --mac --publish never

VERSION=$(node -p "require('./package.json').version")
DMG="dist/HuaCiAssistant-${VERSION}-arm64.dmg"
if [ -f "$DMG" ]; then
  SIZE=$(du -h "$DMG" | awk '{print $1}')
  echo ""
  echo "✅ 打包完成：$DMG  ($SIZE)"
  echo ""
  echo "安装：双击 DMG → 把「划词助手」拖进「应用程序」"
  echo "首次打开若被 Gatekeeper 拦截：右键 .app → 打开，或到"
  echo "  系统设置 › 隐私与安全性 点「仍要打开」"
  echo ""
  echo "首次运行请在「状态」页授予「辅助功能」权限（划词必需）。"
else
  echo "⚠️ 未找到产物 $DMG，请检查 electron-builder 输出"
  exit 1
fi
