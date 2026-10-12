/**
 * E2E：供应商增删改的 UI 端到端（真实操作 DOM，验证配置真实落盘）
 *
 * 前置：需要先注册一个临时 vault 并把应用指向它（避免动到真实配置）：
 *   1. 造 vault：mkdir -p /tmp/huaci-crud-vault/.obsidian/plugins/ai-explainer
 *      写入含 1 个 API 供应商的 data.json
 *   2. 在 ~/Library/Application Support/obsidian/obsidian.json 的 vaults 里
 *      注册该路径（id 任意，如 huacitest），用完删掉
 *   3. 启动 dev 实例（--remote-debugging-port=9222 --inspect=9338）
 *   4. 通过渲染层 IPC 把 settings.vaultPath 设为该临时 vault
 *   5. WS_PATH=<repo>/node_modules/ws node scripts/e2e/e2e-provider-ui.js
 *
 * 覆盖：弹窗打开/类型切换/新增 API/新增网页版/编辑回填/删除/删空/空态新增
 */
const http = require("http");
const fs = require("fs");
const WS = require(process.env.WS_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = "/tmp/huaci-crud-vault/.obsidian/plugins/ai-explainer/data.json";

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
    const to = setTimeout(() => rej(new Error("eval timeout: " + expr.slice(0, 50))), 10000);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; clearTimeout(to); ws.removeListener("message", h); res(m.result?.result?.value); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}
function screenshot(ws, file) {
  return new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; ws.removeListener("message", h); fs.writeFileSync(file, Buffer.from(m.result.data, "base64")); res(); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method: "Page.captureScreenshot", params: { format: "png" } }));
  });
}
const readCfg = () => JSON.parse(fs.readFileSync(CFG, "utf8"));
let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + "   " + extra); } }

(async () => {
  const list = await httpGet("http://127.0.0.1:9222/json/list");
  const mw = list.find((t) => (t.url || "").includes("main.html"));
  const ws = await connect(mw.webSocketDebuggerUrl);
  const ev = makeEval(ws);

  // 回到供应商页
  await ev(`(() => { document.querySelector("[data-page=status]").click(); return "ok"; })()`);
  await sleep(300);
  await ev(`(() => { document.querySelector("[data-page=providers]").click(); return "ok"; })()`);
  await sleep(1200);

  console.log("=== A. 打开新增弹窗 ===");
  await ev(`(() => { document.getElementById("btnAddProvider").click(); return "ok"; })()`);
  await sleep(400);
  let st = JSON.parse(await ev(`JSON.stringify({
    open: !document.getElementById("providerModal").classList.contains("hidden"),
    title: document.getElementById("pmTitle").textContent,
    typeActive: document.querySelector("#pmType .seg-item.active").dataset.ptype,
    urlVisible: !document.getElementById("pmUrlField").classList.contains("hidden"),
    keyVisible: !document.getElementById("pmKeyField").classList.contains("hidden"),
    portVisible: !document.getElementById("pmPortField").classList.contains("hidden"),
    activateVisible: !document.getElementById("pmActivateRow").classList.contains("hidden"),
  })`));
  check("A1 弹窗已打开", st.open === true);
  check("A2 标题为「新增供应商」", st.title === "新增供应商", st.title);
  check("A3 默认类型为 API", st.typeActive === "api", st.typeActive);
  check("A4 API 模式显示 URL/Key、隐藏端口", st.urlVisible && st.keyVisible && !st.portVisible);
  check("A5 显示「添加后立即使用」", st.activateVisible === true);
  await screenshot(ws, "/tmp/pm-api.png");

  console.log("\n=== B. 切到网页版类型 ===");
  await ev(`(() => { document.querySelector('#pmType [data-ptype=dsweb]').click(); return "ok"; })()`);
  await sleep(300);
  st = JSON.parse(await ev(`JSON.stringify({
    typeActive: document.querySelector("#pmType .seg-item.active").dataset.ptype,
    urlVisible: !document.getElementById("pmUrlField").classList.contains("hidden"),
    keyVisible: !document.getElementById("pmKeyField").classList.contains("hidden"),
    portVisible: !document.getElementById("pmPortField").classList.contains("hidden"),
    optsVisible: !document.getElementById("pmDswebOpts").classList.contains("hidden"),
    note: document.getElementById("pmTypeNote").textContent.slice(0, 30),
  })`));
  check("B1 类型已切为 dsweb", st.typeActive === "dsweb");
  check("B2 隐藏 URL/Key、显示端口与开关", !st.urlVisible && !st.keyVisible && st.portVisible && st.optsVisible);
  check("B3 说明文案已切换", st.note.includes("免 API Key"), st.note);
  await screenshot(ws, "/tmp/pm-dsweb.png");

  console.log("\n=== C. 新增 API 中转站（真实落盘） ===");
  await ev(`(() => { document.querySelector('#pmType [data-ptype=api]').click(); return "ok"; })()`);
  await sleep(200);
  const beforeC = readCfg().providers.length;
  await ev(`(() => {
    document.getElementById("pmName").value = "UI测试中转";
    document.getElementById("pmURL").value = "api.uitest.com/v1/";
    document.getElementById("pmKey").value = "sk-ui-test";
    document.getElementById("pmModels").value = "model-a\\nmodel-b";
    document.getElementById("pmActivate").checked = true;
    document.getElementById("pmSave").click();
    return "clicked";
  })()`);
  await sleep(1800);
  const cfgC = readCfg();
  const addedC = cfgC.providers.find((p) => p.name === "UI测试中转");
  check("C1 配置里新增了 1 条", cfgC.providers.length === beforeC + 1, `${beforeC} → ${cfgC.providers.length}`);
  check("C2 字段正确（URL 规范化）", addedC && addedC.baseURL === "https://api.uitest.com/v1", addedC && addedC.baseURL);
  check("C3 模型解析为 2 个", addedC && addedC.models.length === 2, JSON.stringify(addedC && addedC.models));
  check("C4 已切为使用中", cfgC.activeProviderId === addedC.id, `active=${cfgC.activeProviderId} new=${addedC.id}`);
  check("C5 弹窗已关闭", (await ev(`document.getElementById("providerModal").classList.contains("hidden")`)) === true);
  const nC = await ev(`document.querySelectorAll("#providerList .item").length`);
  check("C6 列表已刷新（2 条）", nC === 2, "count=" + nC);

  console.log("\n=== D. 新增 DeepSeek 网页版（留空地址/模型用默认） ===");
  await ev(`(() => { document.getElementById("btnAddProvider").click(); return "ok"; })()`);
  await sleep(400);
  await ev(`(() => {
    document.querySelector('#pmType [data-ptype=dsweb]').click();
    return "ok";
  })()`);
  await sleep(250);
  await ev(`(() => {
    document.getElementById("pmName").value = "我的网页版";
    document.getElementById("pmSave").click();
    return "clicked";
  })()`);
  await sleep(1800);
  const cfgD = readCfg();
  const addedD = cfgD.providers.find((p) => p.name === "我的网页版");
  check("D1 新增了网页版条目", !!addedD, JSON.stringify(cfgD.providers.map((p) => p.name)));
  check("D2 ptype=dsweb 且默认地址", addedD && addedD.ptype === "dsweb" && addedD.baseURL === "https://chat.deepseek.com", JSON.stringify(addedD));
  check("D3 默认模型已填", addedD && addedD.models.length === 2 && addedD.models[0].includes("专家模式"), JSON.stringify(addedD && addedD.models));
  check("D4 端口与专家模式默认值", addedD && addedD.dswebPort === 9223 && addedD.expertMode === true);
  check("D5 已切为使用中", cfgD.activeProviderId === addedD.id);
  const nD = await ev(`document.querySelectorAll("#providerList .item").length`);
  const txtD = await ev(`document.getElementById("providerList").textContent`);
  check("D6 列表 3 条且含网页版", nD === 3 && txtD.includes("我的网页版"), `count=${nD}`);
  await screenshot(ws, "/tmp/pm-list.png");

  console.log("\n=== E. 编辑已有条目 ===");
  await ev(`(() => { document.querySelector('[data-edit="${addedC.id}"]').click(); return "ok"; })()`);
  await sleep(500);
  st = JSON.parse(await ev(`JSON.stringify({
    open: !document.getElementById("providerModal").classList.contains("hidden"),
    title: document.getElementById("pmTitle").textContent,
    name: document.getElementById("pmName").value,
    url: document.getElementById("pmURL").value,
    models: document.getElementById("pmModels").value,
    typeDisabled: [...document.querySelectorAll("#pmType .seg-item")].every(b => b.disabled),
    activateVisible: !document.getElementById("pmActivateRow").classList.contains("hidden"),
  })`));
  check("E1 弹窗标题为「编辑供应商」", st.title === "编辑供应商", st.title);
  check("E2 已回填现有值", st.name === "UI测试中转" && st.url === "https://api.uitest.com/v1", JSON.stringify(st));
  check("E3 模型回填为多行", st.models.split("\n").length === 2, JSON.stringify(st.models));
  check("E4 编辑时类型不可改（防止 API↔网页版错乱）", st.typeDisabled === true);
  check("E5 编辑时隐藏「立即使用」", st.activateVisible === false);
  await screenshot(ws, "/tmp/pm-edit.png");
  // 改名 + 改 Key 保存
  await ev(`(() => {
    document.getElementById("pmName").value = "改名后的中转";
    document.getElementById("pmKey").value = "sk-changed";
    document.getElementById("pmSave").click();
    return "clicked";
  })()`);
  await sleep(1800);
  const cfgE = readCfg();
  const editedE = cfgE.providers.find((p) => p.id === addedC.id);
  check("E6 名称已更新", editedE && editedE.name === "改名后的中转", editedE && editedE.name);
  check("E7 Key 已更新", editedE && editedE.apiKey === "sk-changed");
  check("E8 未改字段保留（models 仍是 2 个）", editedE && editedE.models.length === 2);

  console.log("\n=== F. 删除供应商 ===");
  // 先切回第一个（避免删的是使用中的，单独测）
  const targetDel = editedE.id;
  await ev(`(() => { window.confirm = () => true; document.querySelector('[data-del="${targetDel}"]').click(); return "ok"; })()`);
  await sleep(1800);
  const cfgF = readCfg();
  check("F1 条目已删除", !cfgF.providers.some((p) => p.id === targetDel), JSON.stringify(cfgF.providers.map((p) => p.name)));
  check("F2 使用中条目被删 → active 自动切换", cfgF.activeProviderId !== targetDel && !!cfgF.activeProviderId, `active=${cfgF.activeProviderId}`);
  const nF = await ev(`document.querySelectorAll("#providerList .item").length`);
  check("F3 列表已刷新（2 条）", nF === 2, "count=" + nF);

  console.log("\n=== G. 删除全部 → 空态 + 提示条 ===");
  await ev(`(() => { window.confirm = () => true; const ids = [...document.querySelectorAll("[data-del]")].map(b => b.dataset.del); ids.forEach(id => document.querySelector('[data-del="' + id + '"]').click()); return ids.length; })()`);
  await sleep(1000);
  for (let i = 0; i < 5; i++) {
    const n = await ev(`document.querySelectorAll("[data-del]").length`);
    if (n === 0) break;
    await ev(`(() => { const b = document.querySelector("[data-del]"); if (b) b.click(); return "ok"; })()`);
    await sleep(1200);
  }
  const cfgG = readCfg();
  check("G1 全部删除后 providers 为空", cfgG.providers.length === 0, String(cfgG.providers.length));
  check("G2 activeProviderId 已清空", cfgG.activeProviderId === "", cfgG.activeProviderId);
  const emptyUi = await ev(`JSON.stringify({
    hintHidden: document.getElementById("dswebMissingHint").classList.contains("hidden"),
    listText: document.getElementById("providerList").textContent.slice(0, 40),
  })`);
  check("G3 列表显示空态", JSON.parse(emptyUi).listText.includes("未找到供应商"), emptyUi);

  console.log("\n=== H. 空态下新增网页版（回到可用状态） ===");
  await ev(`(() => { document.getElementById("btnAddProvider").click(); return "ok"; })()`);
  await sleep(400);
  await ev(`(() => { document.querySelector('#pmType [data-ptype=dsweb]').click(); return "ok"; })()`);
  await sleep(250);
  await ev(`(() => { document.getElementById("pmSave").click(); return "ok"; })()`);
  await sleep(1800);
  const cfgH = readCfg();
  check("H1 新增成功", cfgH.providers.length === 1 && cfgH.providers[0].ptype === "dsweb", JSON.stringify(cfgH.providers));
  check("H2 已切为使用中", cfgH.activeProviderId === cfgH.providers[0].id);
  check("H3 应用能读回（usable）", JSON.parse(await ev(`window.huaci.getProviders().then(r => JSON.stringify({ active: r.activeId, n: r.providers.length, usable: r.providers[0].usable }))`)).usable === true);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
