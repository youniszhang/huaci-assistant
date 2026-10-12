/**
 * E2E：供应商配置独立于 Obsidian（纯文件，含边界）
 *
 * 背景：早期实现把供应商配置读写到 <vault>/.obsidian/plugins/ai-explainer/data.json，
 * 导致「没有 Obsidian vault 就无法新增/使用供应商」以及「两边配置互相影响」。
 * 现改为桌面端自己的 <userData>/providers.json，Obsidian 仅用于首次一次性导入。
 *
 * 覆盖：
 *  A 无 vault 完全可用（读/增/改/删、URL 规范化、模型解析、默认端口 9224）
 *  B 配置落在本机 userData（不在 vault）
 *  C 本机操作不改动 Obsidian 配置（关键）
 *  D 首次导入只发生一次，之后两边独立
 *  E 无 vault 时的空态与校验
 *
 * 用法：node scripts/e2e/e2e-provider-independence.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

// 单独打包被测模块（dist/main/main.js 依赖 electron，不能直接 node 运行）
const ROOT = path.resolve(__dirname, "..", "..");
const BUNDLE = path.join(os.tmpdir(), "huaci-providers-e2e-bundle.js");
execSync(
  `npx esbuild src/main/providers.ts --bundle --platform=node --format=cjs --external:electron --outfile=${JSON.stringify(BUNDLE)}`,
  { cwd: ROOT, stdio: "inherit" }
);

// 伪造 electron 的 app.getPath
const FAKE_USERDATA = path.join(os.tmpdir(), "huaci-indep-ud");
fs.rmSync(FAKE_USERDATA, { recursive: true, force: true });
fs.mkdirSync(FAKE_USERDATA, { recursive: true });
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "electron") return "electron-stub";
  return origResolve.call(this, request, ...args);
};
require.cache["electron-stub"] = {
  id: "electron-stub", filename: "electron-stub", loaded: true,
  exports: { app: { getPath: (k) => (k === "userData" ? FAKE_USERDATA : os.tmpdir()) } },
};

const P = require(BUNDLE);
let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "   " + e); } };

console.log("=== A. 无 Obsidian vault 时完全可用 ===");
check("A1 初始为空（无 vault 也能读）", P.loadStore().providers.length === 0);
const r1 = P.addProvider({ name: "自建中转", baseURL: "api.test.com/v1/", apiKey: "sk-x", models: "m1, m2", ptype: "api", activate: true });
check("A2 无 vault 也能新增 API 供应商", r1.ok && r1.created === true, JSON.stringify(r1));
const r2 = P.addProvider({ ptype: "dsweb", activate: false });
check("A3 无 vault 也能新增网页版", r2.ok === true, JSON.stringify(r2));
const store = P.loadStore();
check("A4 两条都在本机配置里", store.providers.length === 2, String(store.providers.length));
check("A5 URL 规范化生效", store.providers[0].baseURL === "https://api.test.com/v1", store.providers[0].baseURL);
check("A6 模型解析生效", store.providers[0].models.length === 2);
check("A7 网页版端口为 9224（独立于插件 9223）", store.providers[1].dswebPort === 9224, String(store.providers[1].dswebPort));
check("A8 active 正确", P.activeOf(store).id === store.providers[0].id);

console.log("\n=== B. 配置存在本机 userData，不在 vault ===");
const storeFile = P.storePath();
check("B1 路径在 userData 下", storeFile.startsWith(FAKE_USERDATA), storeFile);
check("B2 文件名 providers.json", storeFile.endsWith("providers.json"));
check("B3 文件已落盘", fs.existsSync(storeFile));

console.log("\n=== C. 与 Obsidian 配置互不影响（关键） ===");
// 造一个假的 Obsidian vault，写入供应商，然后确认本机操作不改它
const VAULT = path.join(os.tmpdir(), "huaci-indep-vault");
fs.rmSync(VAULT, { recursive: true, force: true });
fs.mkdirSync(path.join(VAULT, ".obsidian/plugins/ai-explainer"), { recursive: true });
const obsCfg = { insertMode: "callout", activeProviderId: "obs1", activeModel: "obs-model",
  providers: [
    { id: "obs1", name: "Obsidian里的供应商", baseURL: "https://obs/v1", apiKey: "sk-obs", models: ["obs-model"], enabled: true, ptype: "api" },
    { id: "obs2", name: "插件的网页版", baseURL: "https://chat.deepseek.com", apiKey: "", models: ["DeepSeek-V4-Pro（专家模式）"], enabled: true, ptype: "dsweb", dswebPort: 9223, expertMode: true },
  ] };
const obsFile = path.join(VAULT, ".obsidian/plugins/ai-explainer/data.json");
fs.writeFileSync(obsFile, JSON.stringify(obsCfg, null, 2));
const obsBefore = fs.readFileSync(obsFile, "utf8");

// 本机增删改
P.addProvider({ name: "新增的", baseURL: "https://new/v1", apiKey: "k", models: "m", ptype: "api" });
P.updateProvider(store.providers[0].id, { apiKey: "sk-changed" });
P.deleteProvider(store.providers[1].id);
const obsAfter = fs.readFileSync(obsFile, "utf8");
check("C1 Obsidian 配置完全未被改动", obsBefore === obsAfter, "文件内容变了！");
const obsNow = JSON.parse(obsAfter);
check("C2 Obsidian 供应商仍是原来的", obsNow.providers.length === 2 && obsNow.providers[0].apiKey === "sk-obs");

console.log("\n=== D. 首次导入（从 Obsidian 复制一次作为起点） ===");
const UD2 = path.join(os.tmpdir(), "huaci-indep-ud2");
fs.rmSync(UD2, { recursive: true, force: true });
require.cache["electron-stub"].exports.app.getPath = (k) => (k === "userData" ? UD2 : os.tmpdir());
delete require.cache[require.resolve(BUNDLE)];
const P2 = require(BUNDLE);
const imp = P2.ensureImported(VAULT);
check("D1 首次导入成功", imp.imported === true && imp.count === 2, JSON.stringify(imp));
const s2 = P2.loadStore();
check("D2 导入后本机有 2 条", s2.providers.length === 2 && s2.providers[0].name === "Obsidian里的供应商", JSON.stringify(s2.providers.map(p=>p.name)));
check("D3 记录了导入来源", s2.importedFromVault === VAULT);
// 导入时 dsweb 端口应改写为桌面端默认（9224），避免与插件抢同一实例
const dsImported = s2.providers.find((p) => p.ptype === "dsweb");
check("D3b 导入的网页版端口改写为 9224", !dsImported || dsImported.dswebPort === 9224, dsImported ? String(dsImported.dswebPort) : "无 dsweb 条目");
const imp2 = P2.ensureImported(VAULT);
check("D4 第二次调用不重复导入", imp2.imported === false);
// 导入后修改本机，Obsidian 不受影响
P2.updateProvider(s2.providers[0].id, { apiKey: "sk-local-only" });
check("D5 导入后两边独立（Obsidian 未被改）", fs.readFileSync(obsFile, "utf8") === obsBefore);
check("D6 本机已是新值", P2.loadStore().providers[0].apiKey === "sk-local-only");

console.log("\n=== E. 无 vault 时的空态与错误处理 ===");
const UD3 = path.join(os.tmpdir(), "huaci-indep-ud3");
fs.rmSync(UD3, { recursive: true, force: true });
require.cache["electron-stub"].exports.app.getPath = (k) => (k === "userData" ? UD3 : os.tmpdir());
delete require.cache[require.resolve(BUNDLE)];
const P3 = require(BUNDLE);
const imp3 = P3.ensureImported(undefined);
check("E1 无 vault 导入不报错、返回未导入", imp3.imported === false && imp3.count === 0);
check("E2 空配置下 activeOf 返回 null", P3.activeOf(P3.loadStore()) === null);
const bad = P3.addProvider({ ptype: "api", name: "x", baseURL: "", models: "m" });
check("E3 校验仍然生效（缺 URL 拒绝）", bad.ok === false);

// 清理
for (const d of [FAKE_USERDATA, UD2, UD3, VAULT]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
