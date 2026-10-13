#!/usr/bin/env bash
#
# 编译 Windows 划词助手（C# / .NET）
#
# 产物：bin/SelectionHelper.exe（自包含单文件，用户机器无需装 .NET）
#
# 前置：需要 .NET 8 SDK（https://dotnet.microsoft.com/download）
#   macOS 上也能交叉编译出 Windows exe（dotnet publish -r win-x64 支持跨平台发布），
#   但**无法在 macOS 上运行验证** —— 功能验证需在 Windows 机器上做。
#
# 用法：
#   bash scripts/build-helper-win.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "❌ 未找到 dotnet SDK。请安装 .NET 8 SDK 后重试："
  echo "   https://dotnet.microsoft.com/download"
  exit 1
fi

echo "==> 编译 Windows SelectionHelper (C#/.NET 8)"
dotnet publish win/SelectionHelper/SelectionHelper.csproj \
  -c Release \
  -r win-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -o win/publish

# 产物可能叫 SelectionHelper.exe（单文件自包含）
SRC="win/publish/SelectionHelper.exe"
if [ ! -f "$SRC" ]; then
  echo "❌ 未找到产物 $SRC，请检查 dotnet publish 输出"
  exit 1
fi

mkdir -p bin
cp "$SRC" bin/SelectionHelper.exe
SIZE=$(du -h bin/SelectionHelper.exe | awk '{print $1}')
echo ""
echo "✅ 已生成 bin/SelectionHelper.exe ($SIZE)"
echo "   注意：该文件只能在 Windows 上运行验证（macOS 无法执行）"
