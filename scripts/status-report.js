/**
 * 通过 CDP 读取主窗口状态页（安装版实跑自检）
 * 用法：node scripts/status-report.js [port]
 */
const http = require("http");
const path = require("path");

let WS;
try {
  WS = require("ws");
} catch {
  WS = require(path.join(__dirname, "..", "node_modules", "ws"));
}

const port = Number(process.argv[2] || 9222);

const EXPR = `JSON.stringify({
  captureRunning: document.getElementById('stCapture').textContent,
  captureHint: (document.getElementById('stCaptureHint').textContent || '').split('/').slice(-2).join('/'),
  accessibility: document.getElementById('stPerm').textContent,
  inputMonitoring: document.getElementById('stInputMon').textContent,
  provider: document.getElementById('stProvider').textContent,
  providerDetail: document.getElementById('stProviderHint').textContent,
  vault: document.getElementById('stVault').textContent,
  vaultPath: document.getElementById('stVaultHint').textContent,
  hotkey: document.getElementById('inHotkey').value,
  captureEnabled: document.getElementById('toggleCapture').checked,
  providerCount: 0
})`;

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}

(async () => {
  const raw = await get(`http://127.0.0.1:${port}/json/list`);
  const targets = JSON.parse(raw);
  const main = targets.find((t) => t.url.includes("main.html"));
  if (!main) {
    console.log("❌ 未找到主窗口。现有目标：");
    for (const t of targets) console.log("   -", t.url.split("/").pop());
    process.exit(1);
  }
  const ws = new WS(main.webSocketDebuggerUrl);
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: EXPR, returnByValue: true },
      })
    );
  });
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id !== 1) return;
    const o = JSON.parse(msg.result.result.value);
    console.log("=== 划词助手 状态 ===");
    console.log(`  划词监听    : ${o.captureRunning}${o.captureEnabled ? "" : "（开关关闭）"}`);
    console.log(`  helper      : ${o.captureHint}`);
    console.log(`  辅助功能    : ${o.accessibility}`);
    console.log(`  输入监控    : ${o.inputMonitoring}`);
    console.log(`  当前供应商  : ${o.provider}`);
    console.log(`              : ${o.providerDetail}`);
    console.log(`  笔记库      : ${o.vault}`);
    console.log(`              : ${o.vaultPath}`);
    console.log(`  取词快捷键  : ${o.hotkey}`);
    process.exit(0);
  });
  ws.on("error", (e) => {
    console.error("WS 错误:", e.message);
    process.exit(1);
  });
  setTimeout(() => {
    console.log("超时");
    process.exit(1);
  }, 8000);
})();
