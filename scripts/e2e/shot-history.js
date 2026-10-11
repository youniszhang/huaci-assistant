/**
 * 截图「生成记录」页（README 用）：dev 实例 + inspector 写示例历史 + CDP 截图
 *
 * 用法：
 *   1. 启动 dev 实例（主窗口需已打开）：
 *      ./node_modules/.bin/electron . --remote-debugging-port=9222 --inspect=9335 --user-data-dir=/tmp/huaci-shot
 *   2. WS_PATH="$PWD/node_modules/ws" node scripts/e2e/shot-history.js
 *   3. 产物 /tmp/main-history.png → 复制到 docs/screenshots/main-history.png
 *
 * 主窗口打开方式（dev 不自动弹）：inspector 里 app.emit("activate")（需 includeCommandLineAPI）
 */
const http = require("http");
const fs = require("fs");
const WS = require(process.env.WS_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}
async function waitTarget(port, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const ts = await httpGet(`http://127.0.0.1:${port}/json/list`); const hit = ts.find(pred); if (hit) return hit; } catch {}
    await sleep(300);
  }
  throw new Error("target 未出现 port=" + port);
}
function connect(url) { return new Promise((res, rej) => { const ws = new WS(url); ws.on("open", () => res(ws)); ws.on("error", rej); }); }
function makeEval(ws) {
  let seq = 1;
  return (expr) => new Promise((res, rej) => {
    const id = seq++;
    const to = setTimeout(() => rej(new Error("eval timeout: " + expr.slice(0, 50))), 10000);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.id !== id) return; clearTimeout(to); ws.removeListener("message", h); res(m.result?.result?.value); };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }));
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

const HIST_JS = `(() => {
  const fs2 = require('fs'); const path2 = require('path'); const { app } = require('electron');
  const dir = path2.join(app.getPath('userData'), 'history');
  fs2.mkdirSync(dir, { recursive: true });
  // 示例 id 前缀 shot-：与真实记录混排显示；脚本结束会清理这三条
  const now = Date.now();
  const rows = [
    { id: 'shot-1', ts: now - 3600e3, action: '解释', app: 'Safari', provider: 'DeepSeek 网页版', model: 'DeepSeek-V4-Pro（专家模式）',
      selection: 'RoPE 旋转位置编码把位置信息通过旋转矩阵注入到注意力计算中，使模型能感知 token 的相对距离。',
      content: '## RoPE 的核心思路\\n\\n用**复数旋转**表示相对位置：\\n\\n- 把 query/key 向量按位置角度旋转\\n- 注意力分数自然携带相对距离信息\\n\\n\\\`\\\`\\\`python\\nq = rotate(q, pos * theta)\\n\\\`\\\`\\\`',
      saved: false },
    { id: 'shot-2', ts: now - 7200e3, action: '追问', provider: 'DeepSeek 网页版', model: 'DeepSeek-V4-Pro（专家模式）',
      selection: 'RoPE 旋转位置编码……', question: '为什么旋转能表达相对位置？',
      content: '因为两个旋转向量的点积只与**角度差**有关，所以位置差 m−n 直接进入了注意力分数。',
      saved: true },
    { id: 'shot-3', ts: now - 86400e3, action: '意图分析', app: '微信', provider: '示例 API 供应商', model: 'deepseek-v4-flash',
      selection: '客户：这个方案我们内部还要再讨论一下，下周给你答复。',
      content: '**对方意图**\\n拖时间，内部对价格或范围有分歧。',
      saved: false },
  ];
  for (const r of rows) fs2.writeFileSync(path2.join(dir, r.id + '.json'), JSON.stringify(r));
  return 'written';
})()`;

(async () => {
  const mw = await waitTarget(9222, (t) => (t.url || "").includes("main.html"), 25000);
  const mws = await connect(mw.webSocketDebuggerUrl);
  const evalMW = makeEval(mws);
  await sleep(1500);

  // inspector 写示例历史
  const mt = await waitTarget(9335, (t) => t.webSocketDebuggerUrl, 15000);
  const mws2 = await connect(mt.webSocketDebuggerUrl);
  const evalM = makeEval(mws2);
  console.log("hist:", await evalM(HIST_JS));

  await evalMW(`(() => { document.querySelector('[data-page="history"]').click(); return 'ok'; })()`);
  await sleep(1000);
  // 选中第一条（示例1）
  await evalMW(`(() => { const el = [...document.querySelectorAll('.history-item')].find(x => x.dataset.id === 'shot-1') || document.querySelectorAll('.history-item')[0]; if (el) el.click(); return 'ok'; })()`);
  await sleep(700);
  const shot = await sendCmd(mws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("/tmp/main-history.png", Buffer.from(shot.data, "base64"));
  console.log("saved /tmp/main-history.png", fs.statSync("/tmp/main-history.png").size, "bytes");
  // 清理示例数据
  await evalM(`(() => {
    const fs2 = require('fs'); const path2 = require('path'); const { app } = require('electron');
    const dir = path2.join(app.getPath('userData'), 'history');
    for (const id of ['shot-1','shot-2','shot-3']) { try { fs2.unlinkSync(path2.join(dir, id + '.json')); } catch {} }
    return 'cleaned';
  })()`);
  process.exit(0);
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
