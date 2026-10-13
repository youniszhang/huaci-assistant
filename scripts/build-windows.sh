#!/usr/bin/env bash
#
# 划词助手 —— Windows 一键构建 + 打包
#
# 用法：
#   bash scripts/build-windows.sh              # 完整构建（helper + esbuild + NSIS 安装包）
#   bash scripts/build-windows.sh --no-pack    # 只构建，不打包
#
# 产物：dist/HuaCiAssistant-Setup-<版本>.exe
#
# 前置：
#   1. .NET 8 SDK（编译 C# helper）
#   2. Windows 上打包最稳（electron-builder 的 NSIS 目标在 macOS 上也可交叉构建，
#      但需要 wine 等依赖；推荐直接在 Windows 机器上执行本脚本）
#
# 说明：本脚本在 macOS 上可完成「C# helper 交叉编译 + esbuild + 类型检查」，
# 最后一步 electron-builder --win 若因缺少 wine 失败，请到 Windows 上执行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_PACK=0
for arg in "$@"; do
  case "$arg" in
    --no-pack) SKIP_PACK=1 ;;
  esac
done

echo "==> [1/5] 编译 Windows 划词助手（C# / .NET）"
bash scripts/build-helper-win.sh

echo "==> [2/5] 生成 Windows 图标（ico）"
if [ -f scripts/make-icons-win.sh ]; then
  bash scripts/make-icons-win.sh
elif [ -f build/icon.ico ]; then
  echo "    已存在 build/icon.ico，跳过"
else
  echo "    ⚠️  缺少 build/icon.ico —— electron-builder 会用默认 Electron 图标"
  echo "       （可用 ImageMagick 转换：magick build/icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico）"
fi

echo "==> [3/5] 类型检查"
npx tsc --noEmit --skipLibCheck

echo "==> [4/5] 打包渲染层与主进程 (esbuild)"
npm run build

if [ "$SKIP_PACK" = "1" ]; then
  echo "==> 跳过打包（--no-pack）"
  exit 0
fi

echo "==> [5/5] 生成 Windows 安装包 (electron-builder)"
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win --publish never

VERSION=$(node -p "require('./package.json').version")
EXE="dist/HuaCiAssistant-Setup-${VERSION}.exe"
if [ -f "$EXE" ]; then
  SIZE=$(du -h "$EXE" | awk '{print $1}')
  echo ""
  echo "✅ 打包完成：$EXE  ($SIZE)"
  echo ""
  echo "安装：双击 exe 按向导安装（可选安装目录、自动建桌面/开始菜单快捷方式）"
  echo ""
  echo "首次使用："
  echo "  1. 默认按 ⌘/Ctrl+5 唤起工具条（设置页可改）"
  echo "  2. 供应商在「供应商」页配置（本机独立，与 Obsidian 插件互不影响）"
  echo "  3. 网页版需点「登录网页版」在专用浏览器里登录一次"
else
  echo "⚠️ 未找到产物 $EXE，请检查 electron-builder 输出"
  echo "   若在 macOS 上打包失败（缺 wine），请在 Windows 机器上执行本脚本"
  exit 1
fi
