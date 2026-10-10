/**
 * 用 CDP 检查悬浮窗渲染状态（调试用）
 * 用法：node scripts/inspect-overlay.js [port]
 */
const http = require("http");
const path = require("path");
const WS = require("ws");

const port = Number(process.argv[2] || 9222);

function listTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const EXPR = `JSON.stringify({
  rootClass: document.getElementById('root').className,
  toolbarHidden: document.getElementById('toolbar').classList.contains('hidden'),
  cardHidden: document.getElementById('card').classList.contains('hidden'),
  quoteText: document.getElementById('tbQuote').textContent,
  actions: [...document.querySelectorAll('#tbActions .tb-btn')].map(b => b.textContent),
  bodyScrollH: document.body.scrollHeight,
  bodyClientH: document.body.clientHeight,
  toolbarBox: (() => { const t = document.getElementById('toolbar'); const r = t.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,display:getComputedStyle(t).display,bg:getComputedStyle(t).backgroundColor}; })(),
  hasBridge: !!(window.huaci && !window.huaci.isMock),
  bridgeIsMock: window.huaci ? window.huaci.isMock : null
})`;

(async () => {
  const targets = await listTargets();
  const overlay = targets.find((t) => t.url.includes("overlay"));
  if (!overlay) {
    console.log("❌ 没有 overlay 目标（悬浮窗未创建）");
    console.log("现有目标：", targets.map((t) => t.url.split("/").pop()).join(", "));
    process.exit(1);
  }
  const ws = new WS(overlay.webSocketDebuggerUrl);
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: EXPR, returnByValue: true },
      })
    );
  });
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id === 1) {
      if (m.result?.result?.value) {
        console.log(JSON.stringify(JSON.parse(m.result.result.value), null, 2));
      } else {
        console.log("原始返回:", JSON.stringify(m, null, 2).slice(0, 800));
      }
      process.exit(0);
    }
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
