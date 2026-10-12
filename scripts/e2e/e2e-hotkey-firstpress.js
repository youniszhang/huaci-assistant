/**
 * E2E：手动取词「一次即弹」（修复「按两下」）
 *
 * 问题背景：autoPopup 关闭后，划词动作本身会先产生一次 selection 事件
 * （被忽略但记录了 lastSelection/lastSelectionAt）。用户紧接着按快捷键取词时，
 * 同一段文本仍在 1.2s 去抖窗口内 → 被当作重复事件丢弃 → 表现为「第一下没反应，
 * 要按第二下」。修复：手动取词（2s 内）跳过这层去抖。
 *
 * 覆盖：
 *  0  先用 autoPopup=true 造出 overlay 窗口，再收起（窗口按需创建，否则测不到可见性）
 *  1  关闭 autoPopup 后划词不弹
 *  2  紧接着手动取词（capture:request + helper 回同一文本）→ 应立刻弹出
 *
 * 用法：bash scripts/e2e/run-e2e.sh hotkey-firstpress
 * （需要 mock helper；由 runner 负责替换与还原）
 */
const http = require("http");
const fs = require("fs");
const WS = require(process.env.WS_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTRL = "/tmp/huaci-mock-ctrl";
const cmd = (c) => fs.appendFileSync(CTRL, c + "\n");

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}
function connect(url) { return new Promise((res, rej) => { const ws = new WS(url); ws.on("open", () => res(ws)); ws.on("error", rej); }); }
function makeEval(ws) {
  let seq = 1;
  return (expr) => new Promise((res, rej) => {
    const id = seq++;
    const to = setTimeout(() => rej(new Error("eval timeout")), 10000);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; clearTimeout(to); ws.removeListener("message", h); res(m.result?.result?.value); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }));
  });
}
async function waitTarget(port, pred, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
      const hit = list.find(pred);
      if (hit) return hit;
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error(`${what} 未出现`);
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + "   " + extra); } }

(async () => {
  const mt = await waitTarget(9335, (t) => t.webSocketDebuggerUrl, 15000, "主进程 inspector");
  const mws = await connect(mt.webSocketDebuggerUrl);
  const evM = makeEval(mws);
  const vis = async () => {
    const arr = JSON.parse(await evM(`JSON.stringify(require("electron").BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL().split("/").pop(), visible: w.isVisible() })))`));
    const o = arr.find((x) => (x.url || "").includes("overlay"));
    return o ? o.visible : false;
  };

  console.log("=== 0. 先造出 overlay 窗口（autoPopup=true） ===");
  cmd("selection 建窗口用");
  await sleep(1000);
  check("0a 窗口已创建并可见", (await vis()) === true);
  cmd("cleared");
  await sleep(700);
  check("0b 已收起", (await vis()) === false);

  console.log("\n=== 1. 关闭 autoPopup ===");
  const ow = await waitTarget(9334, (t) => (t.url || "").includes("overlay"), 10000, "overlay 渲染目标");
  const rws = await connect(ow.webSocketDebuggerUrl);
  const ev = makeEval(rws);
  await ev(`(async () => { const s = await window.huaci.getSettings(); s.autoPopup = false; await window.huaci.saveSettings(s); return "saved"; })()`);
  await sleep(400);

  console.log("\n=== 2. 复现「划词 → 立刻按快捷键」 ===");
  cmd("selection 同一段文字");
  await sleep(300);
  check("2a 划词未弹（autoPopup=false）", (await vis()) === false);
  // 手动取词：capture:request 打时间戳 → helper 回同一文本（修复前会被去抖丢弃）
  await ev(`window.huaci.requestCapture().then(() => "ok")`);
  await sleep(150);
  cmd("selection 同一段文字");
  await sleep(900);
  const v = await vis();
  check("2b 手动取词后同一文本即弹出（一次即弹）", v === true, "vis=" + v);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
