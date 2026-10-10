/**
 * 测试：读真实 Obsidian 配置 + 笔记写入格式
 * 用法：node scripts/test-note.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// 用 esbuild 打包后的方法做快速验证：这里直接 require 编译后的 dist（main.js 依赖 electron，不可用）
// 因此改为独立验证核心算法（与 src/main/note.ts 保持同源逻辑）
const DIST = path.join(__dirname, "..", "dist", "main", "main.js");

function annotationId(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return "ai" + h.toString(36);
}
function annotationTitle(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 26);
}

// ---- 1. 读真实配置 ----
const obsidianJson = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
console.log("=== 1. Obsidian vault 发现 ===");
if (!fs.existsSync(obsidianJson)) {
  console.log("  ⚠ obsidian.json 不存在");
} else {
  const raw = JSON.parse(fs.readFileSync(obsidianJson, "utf8"));
  for (const v of Object.values(raw.vaults || {})) {
    const dataJson = path.join(v.path, ".obsidian", "plugins", "ai-explainer", "data.json");
    const has = fs.existsSync(dataJson);
    console.log(`  ${has ? "✓" : "·"} ${path.basename(v.path)}  ${v.path}`);
    if (!has) continue;
    const data = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    console.log(`    activeProviderId=${data.activeProviderId} activeModel=${data.activeModel}`);
    for (const p of data.providers || []) {
      const key = p.ptype === "dsweb" ? "（网页版，无 Key）" : (p.apiKey || "").slice(0, 12) + "…";
      console.log(`      - [${p.ptype || "api"}] ${p.name} | ${p.baseURL} | ${key} | models=${(p.models || []).join(",")}`);
    }
  }
}

// ---- 2. 记录目录与格式 ----
console.log("\n=== 2. 笔记写入格式（隔离测试，不碰真实 vault）===");
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "huaci-vault-"));
const dir = path.join(tmpVault, "04-日常记录", "AI划词解释");
fs.mkdirSync(dir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const file = path.join(dir, day + ".md");

// 模拟 note.ts 的 buildCallout
function buildCallout(entry) {
  const id = annotationId(entry.selection);
  const title = annotationTitle(entry.selection);
  const header = `> [!note]- ✨ ${entry.action}：${title}`;
  const bodyLines = entry.body.split("\n").map((l) => (l.trim() === "" ? ">" : `> ${l}`));
  const meta = `> <sub>来源：${entry.sourceApp} · ${entry.model}</sub>`;
  return [`<!-- ${id} -->`, header, ...bodyLines, meta].join("\n");
}

const sel = "RoPE 通过旋转矩阵把位置信息注入注意力计算";
const entry = {
  selection: sel,
  body: "结合上下文，这句话在讲位置编码的实现方式。\n\n**术语**\n- **RoPE**：旋转位置编码",
  action: "解释",
  sourceApp: "Safari",
  model: "aitry-ds deepseek-v4-flash",
};
fs.writeFileSync(file, `---\ntype: ai-capture\ncreated: ${day}\n---\n\n# AI 划词记录 ${day}\n\n${buildCallout(entry)}\n`);
console.log(fs.readFileSync(file, "utf8"));

// ---- 3. 覆盖测试 ----
console.log("=== 3. 重复解释 → 覆盖同条目（不追加重复）===");
let content = fs.readFileSync(file, "utf8");
const id = annotationId(sel);
const marker = `<!-- ${id} -->`;
const start = content.indexOf(marker);
const lines = content.split("\n");
let acc = 0, markerLine = -1;
for (let i = 0; i < lines.length; i++) { if (acc >= start) { markerLine = i; break; } acc += lines[i].length + 1; }
let endLine = markerLine + 1, sawQuote = false;
for (let i = markerLine + 1; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t.startsWith("<!-- ai")) break;
  if (t.startsWith(">")) { sawQuote = true; endLine = i + 1; continue; }
  if (t === "") { if (sawQuote) break; endLine = i + 1; continue; }
  break;
}
const toOffset = (n) => lines.slice(0, n).reduce((s, l) => s + l.length + 1, 0);
const s = toOffset(markerLine), e = Math.min(toOffset(endLine), content.length);
console.log(`  定位到旧条目字符区间 [${s}, ${e})，长度 ${e - s}`);
const newBlock = buildCallout({ ...entry, body: "【更新后的解释】这是第二次生成的版本。" });
const updated = content.slice(0, s) + newBlock + content.slice(e);
fs.writeFileSync(file, updated.replace(/\n{3,}/g, "\n\n"));
const after = fs.readFileSync(file, "utf8");
const occurrences = (after.match(/<!-- ai/g) || []).length;
console.log(`  覆盖后文件里条目数 = ${occurrences}（应为 1）`);
console.log("  覆盖后内容：");
console.log(after.split("\n").slice(6).join("\n"));
console.log(`\n  ${occurrences === 1 ? "✅ 覆盖正确" : "❌ 覆盖失败"}`);

// 清理
fs.rmSync(tmpVault, { recursive: true, force: true });
console.log("\n（临时 vault 已清理）");
