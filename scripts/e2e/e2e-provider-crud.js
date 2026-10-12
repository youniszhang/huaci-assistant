/**
 * E2E：供应商增删改（addProvider / updateProvider / deleteProvider，纯文件操作）
 *
 * 背景：桌面端现在可以直接管理供应商（不再必须回 Obsidian 插件里操作），
 * 写入的是用户的 <vault>/.obsidian/plugins/ai-explainer/data.json，必须保守。
 *
 * 安全断言：
 *  - 只增不改：其它供应商、插件其它设置字段都不能被动
 *  - 失败不破坏：配置不存在/损坏/校验不过时拒绝，原文件保持原样
 *  - 原子写 + 备份
 *  - 删除使用中的条目 → active 自动切到其它可用项（不留悬空 id）
 *
 * 用法：node scripts/e2e/e2e-provider-crud.js
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
const BUNDLE = path.join(os.tmpdir(), "huaci-obsidian-crud-bundle.js");

function makeVault(name, dataJson) {
  const dir = path.join(os.tmpdir(), `huaci-crud-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const cfgDir = path.join(dir, ".obsidian", "plugins", "ai-explainer");
  fs.mkdirSync(cfgDir, { recursive: true });
  if (dataJson !== null) fs.writeFileSync(path.join(cfgDir, "data.json"), dataJson);
  return dir;
}
const cfgPath = (v) => path.join(v, ".obsidian/plugins/ai-explainer/data.json");
const readCfg = (v) => JSON.parse(fs.readFileSync(cfgPath(v), "utf8"));

const BASE = JSON.stringify({
  insertMode: "callout",
  contextChars: 800,
  activeProviderId: "p1",
  activeModel: "deepseek-v4-flash",
  providers: [
    { id: "p1", name: "aitry-ds", baseURL: "https://aitrybest.com/v1", apiKey: "sk-old", models: ["deepseek-v4-flash"], enabled: true, ptype: "api" },
  ],
});

(async () => {
  execSync(
    `npx esbuild src/main/obsidian.ts --bundle --platform=node --format=cjs --external:electron --outfile=${JSON.stringify(BUNDLE)}`,
    { cwd: ROOT, stdio: "inherit" }
  );
  const o = require(BUNDLE);

  console.log("=== 1. 新增 API 中转站 ===");
  const v1 = makeVault("add-api", BASE);
  const r1 = o.addProvider(v1, {
    name: "智谱中转",
    baseURL: "api.zhipu.com/v1/",  // 无协议 + 尾斜杠 → 应被规范化
    apiKey: " sk-new ",
    models: "glm-4-plus, glm-4-flash",
    ptype: "api",
    activate: true,
  });
  check("1a 新增成功", r1.ok && r1.created === true, JSON.stringify(r1));
  const c1 = readCfg(v1);
  const added = c1.providers.find((p) => p.id === r1.id);
  check("1b baseURL 已规范化（补 https、去尾斜杠）", added.baseURL === "https://api.zhipu.com/v1", added.baseURL);
  check("1c apiKey 已 trim", added.apiKey === "sk-new", JSON.stringify(added.apiKey));
  check("1d 逗号分隔的模型解析为 2 个", added.models.length === 2 && added.models[1] === "glm-4-flash", JSON.stringify(added.models));
  check("1e 已切为使用中", c1.activeProviderId === r1.id && c1.activeModel === "glm-4-plus");
  check("1f 原有供应商未被动", c1.providers[0].apiKey === "sk-old" && c1.providers[0].models[0] === "deepseek-v4-flash");
  check("1g 插件其它字段保留", c1.insertMode === "callout" && c1.contextChars === 800);
  check("1h 已生成备份", fs.existsSync(cfgPath(v1) + ".bak"));

  console.log("\n=== 2. 新增 DeepSeek 网页版（不填地址/模型，用默认） ===");
  const v2 = makeVault("add-dsweb", BASE);
  const r2 = o.addProvider(v2, { ptype: "dsweb", activate: true });
  const c2 = readCfg(v2);
  const ds2 = c2.providers.find((p) => p.id === r2.id);
  check("2a 新增成功", r2.ok && r2.created === true, JSON.stringify(r2));
  check("2b 默认名称与地址", ds2.name === "DeepSeek 网页版" && ds2.baseURL === "https://chat.deepseek.com", JSON.stringify({ n: ds2.name, u: ds2.baseURL }));
  check("2c 默认模型已填", ds2.models.length === 2 && ds2.models[0].includes("专家模式"), JSON.stringify(ds2.models));
  check("2d dsweb 字段完整", ds2.ptype === "dsweb" && ds2.dswebPort === 9223 && ds2.expertMode === true && ds2.vision === true);
  check("2e 已切为使用中", c2.activeProviderId === r2.id);

  console.log("\n=== 3. 新增校验（不合法输入必须拒绝且不写文件） ===");
  const v3 = makeVault("validate", BASE);
  const before3 = fs.readFileSync(cfgPath(v3), "utf8");
  const e3a = o.addProvider(v3, { ptype: "api", name: "x", baseURL: "", models: "m" });
  const e3b = o.addProvider(v3, { ptype: "api", name: "x", baseURL: "https://a/v1", models: "" });
  check("3a 缺 Base URL 被拒绝", e3a.ok === false, JSON.stringify(e3a));
  check("3b 缺模型被拒绝", e3b.ok === false, JSON.stringify(e3b));
  check("3c 文件未被写入", fs.readFileSync(cfgPath(v3), "utf8") === before3);

  console.log("\n=== 4. 更新供应商 ===");
  const v4 = makeVault("update", BASE);
  const r4 = o.updateProvider(v4, "p1", { apiKey: "sk-updated", models: "m1\nm2", name: "改名后" });
  const c4 = readCfg(v4);
  const p4 = c4.providers.find((p) => p.id === "p1");
  check("4a 更新成功", r4.ok === true, JSON.stringify(r4));
  check("4b 字段已更新", p4.apiKey === "sk-updated" && p4.name === "改名后", JSON.stringify(p4));
  check("4c 换行分隔模型解析正确", p4.models.length === 2 && p4.models[1] === "m2", JSON.stringify(p4.models));
  check("4d 未传的字段保持不变", p4.baseURL === "https://aitrybest.com/v1" && p4.enabled === true);
  check("4e activeModel 已同步到新模型列表首项", c4.activeModel === "m1", c4.activeModel);

  console.log("\n=== 5. 更新校验 / 不存在的 id ===");
  const v5 = makeVault("update-bad", BASE);
  const before5 = fs.readFileSync(cfgPath(v5), "utf8");
  const e5a = o.updateProvider(v5, "p1", { baseURL: "" });
  const e5b = o.updateProvider(v5, "nope", { name: "x" });
  check("5a 清空 Base URL 被拒绝", e5a.ok === false, JSON.stringify(e5a));
  check("5b 不存在的 id 被拒绝", e5b.ok === false, JSON.stringify(e5b));
  check("5c 文件未被写入", fs.readFileSync(cfgPath(v5), "utf8") === before5);

  console.log("\n=== 6. 删除供应商 ===");
  const v6 = makeVault("delete", JSON.stringify({
    activeProviderId: "p1",
    activeModel: "m1",
    providers: [
      { id: "p1", name: "A", baseURL: "https://a/v1", apiKey: "k", models: ["m1"], enabled: true, ptype: "api" },
      { id: "p2", name: "B", baseURL: "https://b/v1", apiKey: "k", models: ["m2"], enabled: true, ptype: "api" },
    ],
  }));
  const r6 = o.deleteProvider(v6, "p1");
  const c6 = readCfg(v6);
  check("6a 删除成功", r6.ok === true, JSON.stringify(r6));
  check("6b 条目已移除", c6.providers.length === 1 && c6.providers[0].id === "p2");
  check("6c 使用中条目被删 → active 自动切换", c6.activeProviderId === "p2" && c6.activeModel === "m2", JSON.stringify({ id: c6.activeProviderId, m: c6.activeModel }));

  console.log("\n=== 7. 删除非使用中条目（active 不应被动） ===");
  const v7 = makeVault("delete-other", JSON.stringify({
    activeProviderId: "p1",
    activeModel: "m1",
    providers: [
      { id: "p1", name: "A", baseURL: "https://a/v1", apiKey: "k", models: ["m1"], enabled: true, ptype: "api" },
      { id: "p2", name: "B", baseURL: "https://b/v1", apiKey: "k", models: ["m2"], enabled: true, ptype: "api" },
    ],
  }));
  o.deleteProvider(v7, "p2");
  const c7 = readCfg(v7);
  check("7a active 保持不变", c7.activeProviderId === "p1" && c7.activeModel === "m1");

  console.log("\n=== 8. 删除全部条目（active 应清空，不留悬空 id） ===");
  const v8 = makeVault("delete-all", JSON.stringify({
    activeProviderId: "p1",
    activeModel: "m1",
    providers: [{ id: "p1", name: "A", baseURL: "https://a/v1", apiKey: "k", models: ["m1"], enabled: true, ptype: "api" }],
  }));
  o.deleteProvider(v8, "p1");
  const c8 = readCfg(v8);
  check("8a providers 已空", c8.providers.length === 0);
  check("8b activeProviderId 已清空", c8.activeProviderId === "" && c8.activeModel === "");

  console.log("\n=== 9. 失败不破坏：配置不存在 / 损坏 ===");
  const v9a = makeVault("crud-nodata", null);
  const r9a = o.addProvider(v9a, { ptype: "api", name: "x", baseURL: "https://a/v1", models: "m" });
  check("9a 配置不存在 → 拒绝", r9a.ok === false, JSON.stringify(r9a));
  const broken = "{ not json";
  const v9b = makeVault("crud-broken", broken);
  const r9b = o.deleteProvider(v9b, "p1");
  check("9b 配置损坏 → 拒绝", r9b.ok === false, JSON.stringify(r9b));
  check("9c 损坏文件未被覆盖", fs.readFileSync(cfgPath(v9b), "utf8") === broken);

  console.log("\n=== 10. 新增后应用能读回并正确激活 ===");
  const v10 = makeVault("roundtrip", BASE);
  const r10 = o.addProvider(v10, { name: "回环测试", baseURL: "https://x/v1", apiKey: "k", models: ["m"], ptype: "api", activate: true });
  const b10 = o.loadProviders(v10);
  check("10a 读回数量正确", b10.providers.length === 2, String(b10.providers.length));
  check("10b active 指向新条目", b10.active && b10.active.id === r10.id, JSON.stringify(b10.active && b10.active.id));
  check("10c 新增条目 usable 判定通过", o.isProviderUsable(b10.active).ok === true);

  console.log("\n=== 11. parseModels 边界 ===");
  check("11a 空输入 → 空数组", o.parseModels(undefined).length === 0 && o.parseModels("").length === 0);
  check("11b 中文逗号/分号/换行混合", o.parseModels("a，b;c\nd").join("|") === "a|b|c|d", o.parseModels("a，b;c\nd").join("|"));
  check("11c 去空白与空项", o.parseModels(" a , , b ").join("|") === "a|b");

  // 清理
  for (const n of ["add-api", "add-dsweb", "validate", "update", "update-bad", "delete", "delete-other", "delete-all", "crud-nodata", "crud-broken", "roundtrip"]) {
    fs.rmSync(path.join(os.tmpdir(), `huaci-crud-${n}`), { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("驱动失败:", e.message, e.stack); process.exit(2); });
