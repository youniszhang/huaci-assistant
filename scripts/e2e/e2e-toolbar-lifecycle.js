/**
 * E2E：工具条跟随选区生命周期（没有选中 → 工具条关闭）
 *
 * 断言策略：悬浮窗开了 backgroundThrottling:false，渲染层 document.visibilityState
 * 恒为 visible（不可用）。真值断言走主进程 Node inspector（--inspect=9335）
 * 读 BrowserWindow.isVisible()；渲染层 CDP（9334）只用于驱动交互与读 mode。
 */
const http = require("http");
const fs = require("fs");
const WS = require(process.env.WS_PATH);

const RPORT = 9334; // renderer CDP
const MPORT = 9335; // main process inspector
const CTRL = "/tmp/huaci-mock-ctrl";
const LOG = "/tmp/huaci-e2e/app.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

async function waitTarget(port, pred, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ts = await httpGet(`http://127.0.0.1:${port}/json/list`);
      const hit = ts.find(pred);
      if (hit) return hit;
    } catch { /* 端口未就绪 */ }
    await sleep(300);
  }
  throw new Error(`${what} 未出现（port ${port}）`);
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WS(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}

function makeEval(ws) {
  let seq = 1;
  return (expr) =>
    new Promise((res, rej) => {
      const id = seq++;
      const to = setTimeout(() => rej(new Error("eval timeout: " + expr.slice(0, 60))), 8000);
      const h = (d) => {
        let m;
        try { m = JSON.parse(d); } catch { return; }
        if (m.id !== id) return;
        clearTimeout(to);
        ws.removeListener("message", h);
        if (m.result?.result?.value !== undefined) res(m.result.result.value);
        else if (m.result?.exceptionDetails) rej(new Error("eval exception: " + JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
        else rej(new Error("no value: " + JSON.stringify(m).slice(0, 200)));
      };
      ws.on("message", h);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }));
    });
}

// 主进程：读悬浮窗真实可见性
const MAIN_EXPR = `(() => {
  try {
    const req = (typeof require === 'function' && require) || undefined;
    if (!req) return JSON.stringify({ error: 'require 不可用' });
    const { BrowserWindow } = req('electron');
    return JSON.stringify(BrowserWindow.getAllWindows().map(w => ({
      url: (() => { try { return w.webContents.getURL().split('/').pop(); } catch { return ''; } })(),
      visible: w.isVisible(),
    })));
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

const R_EXPR = `JSON.stringify({
  root: document.getElementById('root').className,
  tbQuote: document.getElementById('tbQuote').textContent,
  sx: window.screenX, sy: window.screenY, w: window.outerWidth, h: window.outerHeight
})`;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "   " + extra); }
}
function logCount(pat) {
  try { return (fs.readFileSync(LOG, "utf8").match(new RegExp(pat, "g")) || []).length; }
  catch { return 0; }
}

(async () => {
  fs.writeFileSync(CTRL, "selection Hello 世界\n");
  const rt = await waitTarget(RPORT, (t) => t.url.includes("overlay"), 25000, "overlay 渲染目标");
  const mt = await waitTarget(MPORT, (t) => t.webSocketDebuggerUrl, 15000, "主进程 inspector");
  const rws = await connect(rt.webSocketDebuggerUrl);
  const mws = await connect(mt.webSocketDebuggerUrl);
  const evalR = makeEval(rws), evalM = makeEval(mws);
  await sleep(900);

  const st = async () => JSON.parse(await evalR(R_EXPR));
  async function overlayVis() {
    const raw = await evalM(MAIN_EXPR);
    const arr = JSON.parse(raw);
    if (arr.error) throw new Error("main eval: " + arr.error);
    const o = arr.find((x) => (x.url || "").includes("overlay"));
    return o ? o.visible : null;
  }
  const cmd = (c) => fs.appendFileSync(CTRL, c + "\n");
  const clickOut = (s) => `click ${Math.max(20, Math.round(s.sx - 300))} ${Math.max(20, Math.round(s.sy - 300))}`;

  // 0. 主进程探针自检
  const probe = await evalM("typeof process.versions.electron + '|' + (process.versions.electron || '')");
  console.log("main probe:", probe);

  // 1. 选中 → 工具条浮出（主进程真值）
  let s = await st();
  check("1 选中→工具条浮出", s.root === "mode-toolbar" && (await overlayVis()) === true, JSON.stringify(s));

  // 2. 点击窗内（工具条自身）→ 保持
  let b = await st();
  cmd(`click ${Math.round(b.sx + b.w / 2)} ${Math.round(b.sy + b.h / 2)}`);
  await sleep(500);
  check("2 点窗内→保持", (await overlayVis()) === true);

  // 3. 点击窗外 → 收起
  cmd(clickOut(b));
  await sleep(700);
  check("3 点窗外→收起", (await overlayVis()) === false, "log:" + logCount("工具条收起（点击别处）"));
  check("3b 日志记录正确原因", logCount("工具条收起（点击别处）") === 1, "count=" + logCount("工具条收起（点击别处）"));

  // 4. 重新选中 → 恢复
  cmd("selection 第二次选中");
  await sleep(800);
  s = await st();
  check("4 重新选中→恢复", (await overlayVis()) === true && s.tbQuote.includes("第二次"), JSON.stringify(s));

  // 5. ✕ 手动关闭
  await evalR(`(() => { document.getElementById('btnTbClose').click(); return 'ok'; })()`);
  await sleep(500);
  check("5 ✕→收起", (await overlayVis()) === false);

  // 6. 选区清空（cleared）→ 收起
  cmd("selection 第三次选中");
  await sleep(800);
  check("6a 选中→浮出", (await overlayVis()) === true);
  cmd("cleared");
  await sleep(700);
  check("6b cleared→收起", (await overlayVis()) === false, "log:" + logCount("工具条收起（选区已清空）"));

  // 7. 取词无选中（noselection）→ 收起
  cmd("selection 第四次选中");
  await sleep(800);
  check("7a 选中→浮出", (await overlayVis()) === true);
  cmd("noselection");
  await sleep(700);
  check("7b noselection→收起", (await overlayVis()) === false, "log:" + logCount("工具条收起（取词无选中）"));

  // 8. 卡片态：cleared / 点别处均不收起
  const clearedBefore = logCount("工具条收起（选区已清空）");
  await evalR(`(() => { window.huaci.scanRegion(); return 'sent'; })()`);
  await sleep(1300);
  s = await st();
  check("8a OCR 识别中→卡片浮出", s.root === "mode-card" && (await overlayVis()) === true, JSON.stringify(s));
  cmd("cleared");
  await sleep(500);
  check("8b 卡片态 cleared→不收起", (await overlayVis()) === true);
  b = await st();
  cmd(clickOut(b));
  await sleep(500);
  check("8c 卡片态点别处→不收起", (await overlayVis()) === true);
  check("8d 卡片态无收起日志", logCount("工具条收起（选区已清空）") === clearedBefore, "count=" + logCount("工具条收起（选区已清空）"));

  // 等 OCR 回包（mock 延迟 2.5s）→ 切回工具条
  let switched = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    s = await st();
    if (s.root === "mode-toolbar") { switched = true; break; }
  }
  check("8e OCR 完成→切回工具条", switched && (await overlayVis()) === true, JSON.stringify(s));

  // 9. OCR 后的工具条同样跟随选区：cleared → 收起
  const clearedBefore2 = logCount("工具条收起（选区已清空）");
  cmd("cleared");
  await sleep(700);
  check("9 OCR 工具条 cleared→收起", (await overlayVis()) === false, "log:" + logCount("工具条收起（选区已清空）"));
  check("9b 新增一条收起日志", logCount("工具条收起（选区已清空）") === clearedBefore2 + 1);

  // 10. 双击选词：连击不触发收起；随后到达的选中使工具条保持
  cmd("selection 双击选词");
  await sleep(800);
  check("10a 选中→浮出", (await overlayVis()) === true);
  s = await st();
  const px = Math.max(20, Math.round(s.sx - 300)), py = Math.max(20, Math.round(s.sy - 300));
  cmd(`click ${px} ${py}\nclick ${px} ${py}`); // 同批注入 = 双击（间隔 0ms）
  await sleep(500);
  check("10b 双击后 500ms 工具条仍可见（收起已推迟）", (await overlayVis()) === true, "log:" + logCount("工具条收起（双击后仍无选中）"));
  cmd("selection 双击后的选中");
  await sleep(1300); // 越过 1500ms 推迟点，selection 应已撤销收起
  check("10c 双击选词→选中到达后保持", (await overlayVis()) === true, JSON.stringify(await st()));
  check("10d 无「双击后仍无选中」收起日志", logCount("工具条收起（双击后仍无选中）") === 0);

  // 11. 空白处双击（无后续选中）→ 1.5s 后照常收起（兜底不失效）
  s = await st();
  const qx = Math.max(20, Math.round(s.sx - 200)), qy = Math.max(20, Math.round(s.sy - 200));
  cmd(`click ${qx} ${qy}\nclick ${qx} ${qy}`); // 远离上组坐标，重新计双击
  await sleep(500);
  check("11a 双击后 500ms 仍可见", (await overlayVis()) === true);
  await sleep(1300); // 越过 1500ms
  check("11b 无选中双击→最终收起", (await overlayVis()) === false, "log:" + logCount("工具条收起（双击后仍无选中）"));
  check("11c 日志记录正确原因", logCount("工具条收起（双击后仍无选中）") === 1);

  // 12. 卡片 ✕：识别中关闭卡片 → 收起；OCR 完成后结果仍送达（重新浮出工具条）
  cmd("selection 卡片关闭测试");
  await sleep(800);
  check("12a 选中→浮出", (await overlayVis()) === true);
  await evalR(`(() => { window.huaci.scanRegion(); return 'sent'; })()`);
  await sleep(1300);
  s = await st();
  check("12b OCR 识别中→卡片浮出", s.root === "mode-card" && (await overlayVis()) === true, JSON.stringify(s));
  await evalR(`(() => { document.getElementById('btnClose').click(); return 'ok'; })()`);
  await sleep(500);
  check("12c 卡片 ✕→收起", (await overlayVis()) === false);
  let redelivered = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    s = await st();
    if (s.root === "mode-toolbar" && (await overlayVis()) === true) { redelivered = true; break; }
  }
  check("12d OCR 结果仍送达（工具条重新浮出）", redelivered && s.tbQuote.includes("OCR"), JSON.stringify(s));
  cmd("cleared");
  await sleep(700);
  check("12e 结束清理→收起", (await overlayVis()) === false);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  rws.close(); mws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
