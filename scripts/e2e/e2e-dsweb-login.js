/**
 * E2E：DeepSeek 网页版登录链路（真机，隔离 profile）
 *
 * 覆盖三个缺陷：
 *   1. headless 实例存在时点「登录网页版」→ 必须切换为可见窗口
 *      （修复前 ensureBrowser 复用 headless 实例，登录页在不可见窗口打开，
 *       用户看不到 → 「新电脑首次登录不了」）
 *   2. 登录轮询探测不得导航（修复前 probeLoginStatus 走 connectDeepSeek，
 *       内含 Page.navigate，会把用户正在填的登录页反复拽回首页）
 *   3. 配置里缺 ptype=dsweb 条目时，登录后列表里没有它可选 —— 需自动补建
 *      （见 ensureDswebProvider 单测）
 *
 * 隔离措施：
 *   - 独立端口（默认 9225）与独立 profile（HUACI_DSWEB_PROFILE）
 *   - 结束时清理测试 profile 与进程，不触碰真实登录态（9223 / aie-dsweb-profile）
 *
 * 前置：需要本机装 Chrome；需要能访问 chat.deepseek.com（判断 headless 切换
 *       与导航行为不依赖登录，未登录也能跑）。
 *
 * 用法：
 *   node scripts/e2e/e2e-dsweb-login.js
 *   DS_WEB_PORT=9225 node scripts/e2e/e2e-dsweb-login.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const PORT = Number(process.env.DS_WEB_PORT || 9225);
const PROFILE = path.join(os.tmpdir(), "huaci-e2e-login-profile");
const REAL_PORT = 9223; // 真实专用浏览器端口（只读探测，验证未被误杀）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path: p, timeout: 4000 }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej).on("timeout", function () { this.destroy(); rej(new Error("timeout")); });
  });
}
const portAlive = async (port) => { try { await getJson(port, "/json/version"); return true; } catch { return false; } };
async function isHeadless(port) {
  try { const v = await getJson(port, "/json/version"); return /HeadlessChrome/i.test(v["User-Agent"]); } catch { return null; }
}
async function pageUrl(port) {
  try {
    const list = await getJson(port, "/json/list");
    const p = list.find((t) => (t.url || "").includes("deepseek") && t.type === "page");
    return p ? p.url : null;
  } catch { return null; }
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "   " + extra); }
}

const killTest = () => { try { execSync(`pkill -f ${JSON.stringify(path.basename(PROFILE))}`, { stdio: "ignore" }); } catch {} };

(async () => {
  // 被测模块：单独 esbuild 打包（dist/main/main.js 依赖 electron，不能直接 node 运行）
  const ROOT = path.resolve(__dirname, "..", "..");
  const BUNDLE = path.join(os.tmpdir(), "huaci-dsweb-e2e-bundle.js");
  execSync(
    `npx esbuild src/main/llm/dsweb.ts --bundle --platform=node --format=cjs --external:electron --outfile=${JSON.stringify(BUNDLE)}`,
    { cwd: ROOT, stdio: "inherit" }
  );

  killTest();
  await sleep(800);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.env.HUACI_DSWEB_PROFILE = PROFILE;

  const d = require(BUNDLE);
  const realAliveBefore = await portAlive(REAL_PORT);

  try {
    console.log(`=== 1. 模拟新电脑（端口 ${PORT} 未监听、profile 不存在） ===`);
    check("1a 测试端口未监听", !(await portAlive(PORT)));

    console.log("\n=== 2. 先触发生成 → headless 实例常驻（新电脑第一步） ===");
    await d.ensureBrowser(PORT, true);
    await sleep(1200);
    check("2a headless 实例已拉起", await portAlive(PORT));
    check("2b 实例确为 headless（不可见）", (await isHeadless(PORT)) === true);

    console.log("\n=== 3. 登录网页版 → 必须切成可见窗口 ===");
    let threw = null;
    try { await d.openLoginPage(PORT); } catch (e) { threw = e; }
    await sleep(1500);
    check("3a openLoginPage 未抛错", !threw, threw && threw.message);
    check("3b 已切换为可见窗口（非 headless）", (await isHeadless(PORT)) === false, "headless=" + (await isHeadless(PORT)));
    check("3c 已导航到登录页", ((await pageUrl(PORT)) || "").includes("sign_in"), "url=" + (await pageUrl(PORT)));

    console.log("\n=== 4. 轮询探测不得导航（修复前会拽回首页） ===");
    const urlBefore = await pageUrl(PORT);
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await d.probeLoginStatus(PORT));
      await sleep(1200);
    }
    check("4a 探测返回结构化结果", results.every((r) => r === null || typeof r.loggedIn === "boolean"), JSON.stringify(results));
    check("4b 探测后页面仍在登录页", (await pageUrl(PORT)) === urlBefore, `before=${urlBefore} after=${await pageUrl(PORT)}`);

    console.log("\n=== 5. killBrowser 精确匹配 profile（不误杀真实实例） ===");
    d.killBrowser();
    await sleep(1200);
    check("5a 测试实例已被杀", !(await portAlive(PORT)));
    check("5b 真实实例（9223）未受影响", (await portAlive(REAL_PORT)) === realAliveBefore,
      `before=${realAliveBefore} after=${await portAlive(REAL_PORT)}`);
  } finally {
    killTest();
    await sleep(500);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); killTest(); process.exit(2); });
