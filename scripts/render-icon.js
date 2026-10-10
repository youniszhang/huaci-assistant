/**
 * 用 Electron 无头渲染图标（Chromium 的圆角/渐变/SVG 抗锯齿远好于手工 PIL 绘制）
 * 用法：node scripts/render-icon.js <变体名> <输出png路径>
 * 变体定义在 scripts/icon-variants.html
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const variant = process.argv[2] || "A";
const out = process.argv[3] || "/tmp/icon.png";
const SIZE = 1024;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = path.join(__dirname, "icon-variants.html");
  await win.loadFile(html, { query: { v: variant } });

  // 等一帧确保渐变/字体绘制完成
  await new Promise((r) => setTimeout(r, 700));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  console.log(`rendered variant ${variant} → ${out} (${image.getSize().width}×${image.getSize().height})`);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
