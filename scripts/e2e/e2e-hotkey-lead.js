/**
 * E2E：快捷键录制 + 结论置顶渲染（v0.1.5）
 *
 * 覆盖：
 *  A 默认值（autoPopup=false、⌘5 / ⌘⇧S）
 *  B 录制：点按钮 → 按键 → 保存 accelerator → 显示为 ⌘⌥5
 *  C 主进程真实注册（日志核对）
 *  D saveSettings/getHotkeyState 回传注册状态（供 UI 提示冲突）
 *  E 改回可用组合
 *  F 防误触：纯字母被拒；Esc 取消并恢复原值
 *  G 清除快捷键（× 按钮）
 *  H lead 标记：结论段（首个块）加 class，后续块不加
 *  I lead 样式生效（左边条 + 背景 + 加粗）
 *  J autoPopup=false 落盘 + 状态页文案随触发方式
 *  K 恢复默认提示词（新结构）
 *
 * 前置：
 *   1. 启动 dev 实例（隔离 userData，避免动真实配置）：
 *      ./node_modules/.bin/electron . --remote-debugging-port=9222 --inspect=9339 --user-data-dir=/tmp/huaci-v015
 *   2. WS_PATH=<repo>/node_modules/ws node scripts/e2e/e2e-hotkey-lead.js
 *
 * 注：脚本会改该隔离实例的 settings.json（含快捷键），用完建议删除该 userData。
 */
const http = require("http");
const fs = require("fs");
const WS = require(process.env.WS_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = "/tmp/huaci-v015/huaci-dev/settings.json";

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
    const to = setTimeout(() => rej(new Error("eval timeout: " + expr.slice(0, 60))), 10000);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; clearTimeout(to); ws.removeListener("message", h); res(m.result?.result?.value); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}
function sendCmd(ws, method, params) {
  return new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; ws.removeListener("message", h); res(m.result); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + "   " + extra); } }

(async () => {
  // 打开主窗口（dev 不自动开；inspector 就绪需轮询等待）
  async function findInspector(port, timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
        const hit = list.find((t) => t.webSocketDebuggerUrl);
        if (hit) return hit;
      } catch {
        /* 端口未就绪 */
      }
      await sleep(400);
    }
    throw new Error(`inspector 未就绪（port ${port}）`);
  }
  const mt = await findInspector(9339);
  const mws = await connect(mt.webSocketDebuggerUrl);
  let mseq = 1;
  const evM = (expr) => new Promise((res) => {
    const id = mseq++;
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; mws.removeListener("message", h); res(m.result?.result?.value); };
    mws.on("message", h);
    mws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }));
  });
  // 闸门：启动 2.5s 内的 activate 不弹主窗口（dockActivationAllowed），先等过闸
  await sleep(2800);
  await evM(`require("electron").app.emit("activate")`);
  await sleep(2000);
  async function findMainWindow(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = await httpGet("http://127.0.0.1:9222/json/list");
        const hit = list.find((t) => (t.url || "").includes("main.html"));
        if (hit) return hit;
      } catch {
        /* 未就绪 */
      }
      await sleep(400);
    }
    throw new Error("主窗口未出现（activate 未生效？）");
  }
  const mw = await findMainWindow();
  const ws = await connect(mw.webSocketDebuggerUrl);
  const ev = makeEval(ws);
  await sleep(1000);

  console.log("=== A. 默认值：autoPopup=false，快捷键 ⌘⇧E / ⌘⇧S ===");
  let st = JSON.parse(await ev(`JSON.stringify({
    autoPopupChecked: document.getElementById("inAutoPopup").checked,
    captureText: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
    scanText: document.querySelector("#hotkeyScan .hotkey-text").textContent,
    captureHasBtn: !!document.getElementById("hotkeyCapture"),
    oldInputGone: !document.getElementById("inHotkey"),
  })`));
  check("A1 自动弹开关默认未勾选", st.autoPopupChecked === false, String(st.autoPopupChecked));
  check("A2 取词快捷键显示 ⌘5（新默认）", st.captureText === "⌘5", st.captureText);
  check("A3 框选快捷键显示 ⌘⇧S", st.scanText === "⌘⇧S", st.scanText);
  check("A4 是录制按钮（旧的文本输入框已移除）", st.captureHasBtn && st.oldInputGone);
  await sendCmd(ws, "Page.captureScreenshot", { format: "png" }).then((r) => fs.writeFileSync("/tmp/v15-prefs.png", Buffer.from(r.data, "base64")));

  console.log("\n=== B. 快捷键录制：⌘⌥5 ===");
  await ev(`(() => { document.getElementById("hotkeyCapture").click(); return "ok"; })()`);
  await sleep(300);
  st = JSON.parse(await ev(`JSON.stringify({
    recording: document.getElementById("hotkeyCapture").classList.contains("recording"),
    text: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
  })`));
  check("B1 进入录制态（按钮高亮）", st.recording === true);
  check("B2 显示「按下组合键…」", st.text.includes("按下组合键"), st.text);
  // 派发 keydown（meta+alt+5）。注意：渲染层监听 keydown，用 dispatchEvent 触发
  await ev(`(() => {
    const e = new KeyboardEvent("keydown", { key: "5", code: "Digit5", metaKey: true, altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return "sent";
  })()`);
  await sleep(1500);
  const saved1 = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  check("B3 已保存为 Command+Alt+5", saved1.hotkeyCapture === "Command+Alt+5", saved1.hotkeyCapture);
  st = JSON.parse(await ev(`JSON.stringify({
    recording: document.getElementById("hotkeyCapture").classList.contains("recording"),
    text: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
    conflict: document.getElementById("hotkeyCapture").classList.contains("conflict"),
  })`));
  check("B4 退出录制态", st.recording === false);
  check("B5 显示为 ⌘⌥5", st.text === "⌘⌥5", st.text);
  check("B6 无冲突标记（注册成功）", st.conflict === false);

  console.log("\n=== C. 主进程确认真实注册（日志无「注册失败」） ===");
  const log = fs.readFileSync("/tmp/huaci-v015.log", "utf8");
  check("C1 日志显示已注册 Command+Alt+5", log.includes("已注册：Command+Alt+5"), "未找到注册日志");
  check("C2 无注册失败记录", !log.includes("注册失败：Command+Alt+5"));

  console.log("\n=== D. 保存结果回传：渲染层拿到 hotkeys 状态 ===");
  // 注：Electron 的 globalShortcut 在自家 unregisterAll 后必然能注册（应用内无法构造"被别家占用"），
  // 因此这里验证「回传通道」本身：saveSettings 必须返回 hotkeys 字段且与当前值一致。
  const hr = JSON.parse(await ev(`(async () => {
    const s = await window.huaci.getSettings();
    const r = await window.huaci.saveSettings(s);
    return JSON.stringify({ hasHotkeys: !!r.hotkeys, capture: r.hotkeys && r.hotkeys.capture, ok: r.hotkeys && r.hotkeys.captureOk });
  })()`));
  check("D1 saveSettings 回传 hotkeys", hr.hasHotkeys === true, JSON.stringify(hr));
  check("D2 回传值与当前设置一致", hr.capture === "Command+Alt+5" && hr.ok === true, JSON.stringify(hr));
  const hs = JSON.parse(await ev(`window.huaci.getHotkeyState().then(s => JSON.stringify(s))`));
  check("D3 getHotkeyState 可用且一致", hs.capture === "Command+Alt+5" && hs.captureOk === true, JSON.stringify(hs));

  console.log("\n=== E. 冲突后改回可用组合 ===");
  await ev(`(() => { document.getElementById("hotkeyCapture").click(); return "ok"; })()`);
  await sleep(250);
  await ev(`(() => {
    const e = new KeyboardEvent("keydown", { key: "8", code: "Digit8", metaKey: true, altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return "sent";
  })()`);
  await sleep(1600);
  st = JSON.parse(await ev(`JSON.stringify({
    conflict: document.getElementById("hotkeyCapture").classList.contains("conflict"),
    text: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
  })`));
  check("E1 冲突标记已清除", st.conflict === false, JSON.stringify(st));
  check("E2 显示新组合 ⌘⌥8", st.text === "⌘⌥8", st.text);

  console.log("\n=== F. 防误触：纯字母（无修饰键）不应被接受 ===");
  await ev(`(() => { document.getElementById("hotkeyCapture").click(); return "ok"; })()`);
  await sleep(250);
  await ev(`(() => {
    const e = new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return "sent";
  })()`);
  await sleep(600);
  st = JSON.parse(await ev(`JSON.stringify({
    recording: document.getElementById("hotkeyCapture").classList.contains("recording"),
    text: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
  })`));
  check("F1 仍在录制态（拒绝纯字母）", st.recording === true, JSON.stringify(st));
  // Esc 取消
  await ev(`(() => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return "sent";
  })()`);
  await sleep(400);
  st = JSON.parse(await ev(`JSON.stringify({
    recording: document.getElementById("hotkeyCapture").classList.contains("recording"),
    text: document.querySelector("#hotkeyCapture .hotkey-text").textContent,
  })`));
  check("F2 Esc 取消录制且保留原值", st.recording === false && st.text === "⌘⌥8", JSON.stringify(st));  // 产品修复：取消后恢复原值显示

  console.log("\n=== G. 清除快捷键（× 按钮） ===");
  await ev(`(() => { document.querySelector('#hotkeyCapture .hotkey-clear').click(); return "ok"; })()`);
  await sleep(1400);
  let saved2 = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  check("G1 已清空 hotkeyCapture", saved2.hotkeyCapture === "", JSON.stringify(saved2.hotkeyCapture));
  const g2text = await ev(`document.querySelector("#hotkeyCapture .hotkey-text").textContent`);
  check("G2 显示「未设置」", g2text === "未设置", g2text);
  // 恢复
  await ev(`(() => { document.getElementById("hotkeyCapture").click(); return "ok"; })()`);
  await sleep(250);
  await ev(`(() => {
    const e = new KeyboardEvent("keydown", { key: "5", code: "Digit5", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return "sent";
  })()`);
  await sleep(1400);

  console.log("\n=== H. 结论置顶：lead 渲染 ===");
  // 直接在渲染层验证 md.js 对「结论 + 细节」结构的处理
  const md = "**RoPE 是旋转位置编码**，把位置信息注入注意力计算。\n\n**核心机制**\n- 对 Q/K 向量做旋转\n- 注意力携带相对距离";
  const htmlO = await ev(`window.HuaciMd.render(${JSON.stringify(md)})`);
  check("H1 首个段落带 lead 标记", htmlO.includes('class="lead"'), htmlO.slice(0, 120));
  check("H2 结论文字已加粗", htmlO.includes("<strong>RoPE 是旋转位置编码</strong>"), htmlO.slice(0, 200));
  check("H3 细节部分也保留加粗", (htmlO.match(/<strong>/g) || []).length >= 2, "strong 数=" + (htmlO.match(/<strong>/g) || []).length);
  check("H4 只有第一个块是 lead", (htmlO.match(/class="lead"/g) || []).length === 1, "lead 数=" + (htmlO.match(/class="lead"/g) || []).length);
  // 只有第一个块带 lead：第二段/后续列表都不应带
  const md2 = "**结论行**\n\n第二段内容\n\n- 列表项";
  const html2 = await ev(`window.HuaciMd.render(${JSON.stringify(md2)})`);
  const leadCount = (html2.match(/class="lead"/g) || []).length;
  check("H5 仅第一个块带 lead（后续段落不带）", leadCount === 1 && html2.indexOf('class="lead"') < html2.indexOf("第二段"), `lead=${leadCount} html=${html2.slice(0, 140)}`);

  console.log("\n=== I. lead 样式生效（卡片/记录页） ===");
  // 探针必须放进 .hd-body 作用域（样式选择器是 .hd-body p.lead 等，插入 body 下测不到）
  const styles = await ev(`(() => {
    const probe = document.createElement("div");
    probe.className = "hd-body";
    probe.innerHTML = '<p class="lead"><strong>测试</strong></p>';
    document.body.appendChild(probe);
    const p = probe.querySelector("p.lead");
    const cs = getComputedStyle(p);
    const res = { borderLeft: cs.borderLeftWidth, bg: cs.backgroundColor, strongWeight: getComputedStyle(probe.querySelector("strong")).fontWeight };
    probe.remove();
    return JSON.stringify(res);
  })()`);
  const s = JSON.parse(styles);
  check("I1 lead 有左侧色条", s.borderLeft !== "0px", s.borderLeft);
  check("I2 lead 有背景色", s.bg !== "rgba(0, 0, 0, 0)", s.bg);
  check("I3 加粗字重生效", parseInt(s.strongWeight) >= 590, s.strongWeight);

  console.log("\n=== J. 自动弹关闭后：selection 不弹，快捷键放行 ===");
  const cmd = (c) => fs.appendFileSync("/tmp/huaci-v015-ctrl", c + "\n");
  // 本用例需要 mock helper；此处只验证设置项已落盘 + 状态页文案
  await ev(`(() => { document.querySelector("[data-page=status]").click(); return "ok"; })()`);
  await sleep(800);
  st = JSON.parse(await ev(`JSON.stringify({
    heroSub: document.getElementById("heroSub").textContent,
    savedAutoPopup: ${JSON.stringify(saved2.autoPopup)},
  })`));
  check("J1 settings.autoPopup 为 false", st.savedAutoPopup === false, String(st.savedAutoPopup));
  check("J2 状态页文案提到快捷键", st.heroSub.includes("快捷键") || st.heroSub.includes("⌘"), st.heroSub);

  console.log("\n=== K. 恢复默认提示词（含新结构） ===");
  const da = await ev(`window.huaci.getDefaultActions().then(a => JSON.stringify({ n: a.length, hasConcl: a[0].prompt.includes("一句话结论") || a[0].prompt.includes("核心含义"), reply: a[4] && a[4].prompt.includes("加粗") }))`);
  const daj = JSON.parse(da);
  check("K1 返回 5 个预设动作", daj.n === 5, String(daj.n));
  check("K2 解释模板含「结论先行」要求", daj.hasConcl === true);
  check("K3 拟回复模板含加粗要求", daj.reply === true);
  await ev(`(() => { document.querySelector("[data-page=actions]").click(); return "ok"; })()`);
  await sleep(800);
  st = JSON.parse(await ev(`JSON.stringify({
    btn: !!document.getElementById("btnResetActions"),
    firstPrompt: (document.querySelector("#actionList textarea") || {}).value?.slice(0, 60) || "",
  })`));
  check("K4 动作页有「恢复默认提示词」按钮", st.btn === true);
  check("K5 当前模板已含新结构（默认值直读）", st.firstPrompt.includes("一句话") || st.firstPrompt.includes("加粗"), st.firstPrompt);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
