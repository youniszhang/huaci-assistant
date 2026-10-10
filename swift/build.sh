#!/usr/bin/env bash
# 编译 Swift 划词助手（不需要 Xcode，Command Line Tools 即可）
#
# 签名策略（重要）：
#   优先用稳定证书签名（本机钥匙串里的 codesigning 身份）。
#   adhoc 签名（-）的 designated requirement 是 cdhash —— 每次重新编译
#   cdhash 都变，macOS TCC 授权（辅助功能/输入监控/屏幕录制）随之静默失效，
#   表现为「更新/重装后划词不弹工具条」。用固定证书签名后，
#   DR 绑定证书与 bundle id，重建后授权仍有效。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
OUT="$ROOT/bin/SelectionHelper"

mkdir -p "$ROOT/bin"

echo "==> 编译 SelectionHelper（含截屏 OCR）"
swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Vision \
  -framework ScreenCaptureKit \
  -o "$OUT" \
  "$DIR/SelectionHelper.swift" \
  "$DIR/ScreenOCR.swift"

chmod +x "$OUT"

# 优先使用 HUACI_SIGN_IDENTITY，否则自动取钥匙串里第一个 codesigning 身份
SIGN_ID="${HUACI_SIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/\"/{print $2; exit}')
fi

if [ -n "$SIGN_ID" ]; then
  echo "==> 签名 SelectionHelper (identity: ${SIGN_ID})"
  codesign --force --sign "$SIGN_ID" --options runtime --timestamp=none "$OUT"
else
  echo "⚠️  未找到 codesigning 身份 → 使用 adhoc 签名。"
  echo "    注意：adhoc 签名下 TCC 授权与 cdhash 绑定，重建/重装后可能需要重新授权。"
  codesign --force --sign - "$OUT" 2>/dev/null || true
fi

echo "==> 完成: $OUT"
lipo -info "$OUT" 2>/dev/null || true
codesign -dv "$OUT" 2>&1 | grep -E "Identifier|Signature|Authority" || true
