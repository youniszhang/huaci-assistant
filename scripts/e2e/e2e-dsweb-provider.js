/**
 * E2E：DeepSeek 网页版供应商条目补建（ensureDswebProvider，纯文件操作）
 *
 * 背景：供应商列表完全来自 Obsidian 插件配置（插件无任何预置条目）。
 * 新机器上用户点「登录网页版」登录成功后，若配置里没有 ptype=dsweb 的条目，
 * 列表里就没有它可选 —— 登录态有效却无处可用。ensureDswebProvider 补齐它。
 *
 * 安全断言（写的是用户的 Obsidian 配置，必须保守）：
 *  - 只增不改：其它供应商、插件的其它设置字段都不能被动
 *  - 幂等：已有 dsweb 条目时不动配置
 *  - 失败不破坏：配置不存在/损坏时拒绝并保留原文件
 *  - 原子写 + 备份
 *
 * 用法：node scripts/e2e/e2e-dsweb-provider.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "   " + extra); }
}

const ROOT = path.resolve(__dirname, "..", "..");
const BUNDLE = path.join(os.tmpdir(), "huaci-obsidian-e2e-bundle.js");

function makeVault(name, dataJson) {
  const dir = path.join(os.tmpdir(), `huaci-e2e-vault-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const cfgDir = path.join(dir, ".obsidian", "plugins", "ai-explainer");
  fs.mkdirSync(cfgDir, { recursive: true });
  if (dataJson !== null) fs.writeFileSync(path.join(cfgDir, "data.json"), dataJson);
  return dir;
}
const readCfg = (vault) => JSON.parse(fs.readFileSync(path.join(vault, ".obsidian/plugins/ai-explainer/data.json"), "utf8"));

(async () => {
  execSync(
    `npx esbuild src/main/obsidian.ts --bundle --platform=node --format=cjs --external:electron --outfile=${JSON.stringify(BUNDLE)}`,
    { cwd: ROOT, stdio: "inherit" }
  );
  const o = require(BUNDLE);

  console.log("=== 1. 新建（模拟新电脑：只有 API 供应商） ===");
  const v1 = makeVault("new", JSON.stringify({
    insertMode: "callout",
    activeProviderId: "p1",
    activeModel: "deepseek-v4-flash",
    providers: [{ id: "p1", name: "aitry-ds", baseURL: "https://aitrybest.com/v1", apiKey: "sk-test", models: ["deepseek-v4-flash"], enabled: true, ptype: "api" }],
  }));
  const r1 = o.ensureDswebProvider(v1, { port: 9223, activate: true });
  check("1a 返回 ok 且 created", r1.ok && r1.created === true, JSON.stringify(r1));
  const c1 = readCfg(v1);
  check("1b 新增了 dsweb 条目", c1.providers.some((p) => p.ptype === "dsweb"));
  check("1c 已切为使用中", c1.activeProviderId === r1.id && c1.activeModel === "DeepSeek-V4-Pro（专家模式）", `activeId=${c1.activeProviderId}`);
  const ds = c1.providers.find((p) => p.ptype === "dsweb");
  check("1d dsweb 字段完整（port/expertMode/vision）", ds.dswebPort === 9223 && ds.expertMode === true && ds.vision === true, JSON.stringify(ds));
  check("1e 原有 API 供应商未被改动",
    c1.providers[0].apiKey === "sk-test" && c1.providers[0].models[0] === "deepseek-v4-flash",
    JSON.stringify(c1.providers[0]));
  check("1f 插件其它设置字段保留", c1.insertMode === "callout");
  check("1g 生成了备份", fs.existsSync(path.join(v1, ".obsidian/plugins/ai-explainer/data.json.bak")));
  check("1h 应用能读回并正确解析", (() => {
    const b = o.loadProviders(v1);
    return b && b.active && b.active.ptype === "dsweb";
  })());

  console.log("\n=== 2. 幂等（已有 dsweb 条目） ===");
  const r2 = o.ensureDswebProvider(v1, { port: 9223, activate: true });
  check("2a 返回 created:false", r2.ok && r2.created === false, JSON.stringify(r2));
  check("2b 未重复创建", readCfg(v1).providers.filter((p) => p.ptype === "dsweb").length === 1);

  console.log("\n=== 3. 失败不破坏：配置不存在 ===");
  const v3 = makeVault("nodata", null);
  const r3 = o.ensureDswebProvider(v3);
  check("3a 正确拒绝", r3.ok === false, JSON.stringify(r3));

  console.log("\n=== 4. 失败不破坏：配置损坏 ===");
  const brokenContent = "{ this is not json";
  const v4 = makeVault("broken", brokenContent);
  const r4 = o.ensureDswebProvider(v4);
  const after4 = fs.readFileSync(path.join(v4, ".obsidian/plugins/ai-explainer/data.json"), "utf8");
  check("4a 正确拒绝", r4.ok === false, JSON.stringify(r4));
  check("4b 原文件未被破坏", after4 === brokenContent);

  console.log("\n=== 5. providers 字段缺失 ===");
  const v5 = makeVault("noprovs", JSON.stringify({ insertMode: "inline", activeProviderId: "" }));
  const r5 = o.ensureDswebProvider(v5);
  const c5 = readCfg(v5);
  check("5a 补建成功", r5.ok && r5.created === true);
  check("5b providers 数组已建", Array.isArray(c5.providers) && c5.providers.length === 1);
  check("5c 其它字段保留", c5.insertMode === "inline");

  console.log("\n=== 6. activate:false（只建不激活） ===");
  const v6 = makeVault("noact", JSON.stringify({
    activeProviderId: "a1",
    providers: [{ id: "a1", name: "API", baseURL: "x", apiKey: "k", models: ["m"], enabled: true, ptype: "api" }],
  }));
  o.ensureDswebProvider(v6, { activate: false });
  check("6a activeProviderId 未被改动", readCfg(v6).activeProviderId === "a1");

  console.log("\n=== 7. 已有 dsweb 但被禁用（尊重用户选择） ===");
  const v7 = makeVault("disabled", JSON.stringify({
    activeProviderId: "",
    providers: [{ id: "d1", name: "DeepSeek 网页版", ptype: "dsweb", enabled: false, baseURL: "", apiKey: "", models: [] }],
  }));
  const r7 = o.ensureDswebProvider(v7);
  check("7a 识别为已存在（不重复建）", r7.ok && r7.created === false && r7.id === "d1", JSON.stringify(r7));
  check("7b 未擅自启用", readCfg(v7).providers[0].enabled === false);

  // 清理
  for (const n of ["new", "nodata", "broken", "noprovs", "noact", "disabled"]) {
    fs.rmSync(path.join(os.tmpdir(), `huaci-e2e-vault-${n}`), { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message); process.exit(2); });
