/**
 * E2E：右键菜单（复制 / 全选）
 *
 * 背景：Electron 默认没有右键菜单 —— 卡片里生成的内容能选中，但右键没反应。
 * 现为所有窗口挂了标准编辑菜单。
 *
 * 实现要点（本用例断言的重点）：
 *  - 主进程 context-menu 处理器按优先级判定「是否有选中文字」：
 *    现查渲染层选区 > params.selectionText > 渲染层上报的缓存
 *  - 有选中 → 菜单含「复制」；无选中 → 仅「全选」
 *
 * 测试手法：直接 emit webContents 的 context-menu 事件（Electron 内部即如此分发），
 * 避免 sendInputEvent 在窗口未聚焦时不生效的问题；打桩 Menu.buildFromTemplate
 * 捕获菜单项（不真的弹出，避免阻塞）。
 *
 * 用法：bash scripts/e2e/run-e2e.sh context-menu
 */
const http = require("http");
const WS = require(process.env.WS_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(2800);
  await evM(`require("electron").app.emit("activate")`);
  await sleep(2500);

  // 打桩：捕获菜单项 + 让 popup 不阻塞
  await evM(`(() => {
    const { Menu } = require("electron");
    global.__lastMenuItems = null;
    const origBuild = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (tpl) => {
      global.__lastMenuItems = tpl.map(i => i.label || i.role || i.type);
      const m = origBuild(tpl);
      m.popup = () => {};
      return m;
    };
    return "stubbed";
  })()`);

  const mw = await waitTarget(9334, (t) => (t.url || "").includes("main.html"), 15000, "主窗口");
  const ws = await connect(mw.webSocketDebuggerUrl);
  const ev = makeEval(ws);
  await sleep(800);

  /** 清空上次捕获，emit 一次 context-menu，返回菜单项 */
  async function emitContextMenu(withSelection) {
    // 模拟真实右键时序：渲染层 contextmenu 先触发并上报，主进程 context-menu 后处理。
    // 合成事件下渲染层的 getSelection 在 CDP 上下文里不同步，故显式上报目标值。
    await ev(`(() => { window.huaci.reportContextMenu(${withSelection ? "true" : "false"}); return "reported"; })()`);
    await sleep(200);
    await evM(`(() => { global.__lastMenuItems = null; return "cleared"; })()`);
    await evM(`(() => {
      const { BrowserWindow } = require("electron");
      const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes("main.html"));
      // 直接 emit（Electron 内部即以该事件分发右键），绕开 sendInputEvent 的聚焦限制
      w.webContents.emit("context-menu", {}, { editFlags: {}, isEditable: false, selectionText: "", mediaType: "none", x: 300, y: 300 });
      return "emitted";
    })()`);
    await sleep(900);
    return JSON.parse(await evM(`JSON.stringify(global.__lastMenuItems)`));
  }

  console.log("=== A. 有选中文字 → 菜单含「复制」 ===");
  await ev(`(() => {
    const body = document.getElementById("hdBody");
    body.classList.remove("empty");
    body.innerHTML = window.HuaciMd.render("**测试内容**，用于右键验证。");
    const p = body.querySelector("p");
    const range = document.createRange(); range.selectNodeContents(p);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    return "selected:" + s.toString().slice(0, 10);
  })()`);
  await sleep(300);
  const itemsA = await emitContextMenu(true);
  check("A1 含「复制」", Array.isArray(itemsA) && itemsA.includes("复制"), JSON.stringify(itemsA));
  check("A2 含「全选」", Array.isArray(itemsA) && itemsA.includes("全选"), JSON.stringify(itemsA));

  console.log("\n=== B. 无选中 → 仅「全选」 ===");
  await ev(`(() => { window.getSelection().removeAllRanges(); return "cleared"; })()`);
  await sleep(300);
  const itemsB = await emitContextMenu(false);
  check("B1 仅「全选」", Array.isArray(itemsB) && itemsB.length === 1 && itemsB[0] === "全选", JSON.stringify(itemsB));

  console.log("\n=== C. 生成记录正文可选中 ===");
  const cs = JSON.parse(await ev(`(() => {
    const body = document.getElementById("hdBody");
    const s = getComputedStyle(body);
    return JSON.stringify({ userSelect: s.userSelect || s.webkitUserSelect });
  })()`));
  check("C1 user-select 为 text", cs.userSelect === "text", JSON.stringify(cs));

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
