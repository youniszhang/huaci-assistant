#!/usr/bin/env bash
# 生成应用图标：build/icon.icns + src/renderer/trayTemplate*.png
#
# 应用图标用 Electron 无头渲染（Chromium 的抗锯齿/渐变质量远好于手工绘图），
# 图形定义在 scripts/icon-variants.html。
# 托盘图标是单色模板图，继续用 Python 精确控制像素（模板图必须纯黑+alpha）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VARIANT="${1:-A}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> [1/3] 渲染应用图标（变体 ${VARIANT}, 1024x1024）"
npx electron scripts/render-icon.js "$VARIANT" "$TMP/app.png" 2>&1 | grep -E "rendered|Error" || {
  echo "❌ 图标渲染失败"; exit 1;
}

echo "==> [2/3] 生成 icns"
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for pair in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" "64 icon_32x32@2x.png" \
            "128 icon_128x128.png" "256 icon_128x128@2x.png" "256 icon_256x256.png" \
            "512 icon_256x256@2x.png" "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  size="${pair%% *}"
  name="${pair##* }"
  sips -z "$size" "$size" "$TMP/app.png" --out "$ICONSET/$name" >/dev/null 2>&1
done
mkdir -p build
iconutil -c icns "$ICONSET" -o build/icon.icns
echo "    build/icon.icns"

echo "==> [3/3] 生成托盘图标（单色模板图）"
python3 - "$TMP" <<'PY'
import struct, zlib, sys, os
tmp = sys.argv[1]

def write_png(path, size):
    W = H = size
    px = [[(0, 0, 0, 0) for _ in range(W)] for _ in range(H)]
    s = size / 16.0

    def setp(x, y, a=255):
        xi, yi = int(x), int(y)
        if 0 <= xi < W and 0 <= yi < H:
            px[yi][xi] = (0, 0, 0, a)

    def disc(cx, cy, r, a=255):
        for y in range(max(0, int(cy - r)), min(H, int(cy + r) + 1)):
            for x in range(max(0, int(cx - r)), min(W, int(cx + r) + 1)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    setp(x, y, a)

    def line(x0, y0, x1, y1, w, a=255):
        n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for i in range(n):
            t = i / max(1, n - 1)
            disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w, a)

    # 三行文字（与 A 方案同构，缩略后仍可辨）
    line(3.0 * s, 4.5 * s, 10.0 * s, 4.5 * s, 0.75 * s, 210)
    line(3.0 * s, 8.0 * s, 13.0 * s, 8.0 * s, 0.95 * s, 255)
    line(3.0 * s, 11.5 * s, 8.5 * s, 11.5 * s, 0.75 * s, 210)

    raw = b""
    for row in px:
        raw += b"\x00" + b"".join(bytes(p) for p in row)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)

write_png(os.path.join(tmp, "tray.png"), 16)
write_png(os.path.join(tmp, "tray@2x.png"), 32)
print("    tray 16/32")
PY
cp "$TMP/tray.png" src/renderer/trayTemplate.png
cp "$TMP/tray@2x.png" src/renderer/trayTemplate@2x.png

# 同步到 dist（开发运行时用）
if [ -d dist/renderer ]; then
  cp src/renderer/trayTemplate.png dist/renderer/ 2>/dev/null || true
  cp src/renderer/trayTemplate@2x.png dist/renderer/ 2>/dev/null || true
fi

# 开发模式用的 app 图标（app.dock.setIcon 需要 png，不能是 icns）
mkdir -p build
cp "$TMP/app.png" build/icon-dev.png
echo "    build/icon-dev.png（开发模式 Dock 图标）"

echo "✅ 图标生成完成"
ls -la build/icon.icns build/icon-dev.png src/renderer/trayTemplate.png
