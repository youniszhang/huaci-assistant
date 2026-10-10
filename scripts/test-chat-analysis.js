/**
 * 验证：OCR 文本 → 意图分析动作（走真实 LLM）
 * 用法：node scripts/test-chat-analysis.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

function normalizeBaseURL(u) {
  let s = (u || "").trim();
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

function findApiProvider() {
  const cfg = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  const raw = JSON.parse(fs.readFileSync(cfg, "utf8"));
  for (const v of Object.values(raw.vaults || {})) {
    const dj = path.join(v.path, ".obsidian", "plugins", "ai-explainer", "data.json");
    if (!fs.existsSync(dj)) continue;
    const data = JSON.parse(fs.readFileSync(dj, "utf8"));
    for (const p of data.providers || []) {
      if ((p.ptype || "api") !== "api") continue;
      if (p.apiKey && p.baseURL && p.models?.length) return p;
    }
  }
  return null;
}

/** 与 settings.ts 里的 intent 预设一致 */
const INTENT_PROMPT = `你在帮我分析一段聊天记录。请站在「我需要理解对方真实意图、并决定如何回应」的立场分析。

【聊天内容（OCR 提取，可能有识别误差，请结合上下文合理推断）】
{{selection}}

请按以下结构输出（Markdown，总长控制在 400 字内）：

**对方意图**
用一两句话概括对方这条消息真正想要达成什么（不是字面意思，而是背后的诉求）。

**关键信息**
列出消息中承载决策依据的事实/数据/时间点，逐条说明它对决策的影响。

**潜台词**
指出对方没有明说但可推断的态度、顾虑或期待。若没有明显潜台词就写「无明显潜台词」。

**我的回应建议**
给出 2-3 个可选回应方向，每个方向一句话说明适用场景（例如：先确认再承诺 / 直接给结论 / 反问澄清）。

只输出以上内容，不要前言和结尾。`;

function streamChat(cfg, messages, onDelta) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${normalizeBaseURL(cfg.baseURL)}/chat/completions`);
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey.trim()}`,
        },
      },
      (res) => {
        if (res.statusCode >= 400) {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode} ${b.slice(0, 200)}`)));
          return;
        }
        let buf = "";
        res.on("data", (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const pl = line.slice(5).trim();
            if (pl === "[DONE]") return resolve();
            try {
              const j = JSON.parse(pl);
              const d = j.choices?.[0]?.delta;
              if (d?.content) onDelta(d.content);
            } catch {}
          }
        });
        res.on("end", resolve);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(90000, () => {
      req.destroy(new Error("超时"));
    });
    req.write(
      JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        stream: true,
        messages,
      })
    );
    req.end();
  });
}

(async () => {
  const p = findApiProvider();
  if (!p) {
    console.log("未找到可用 API 供应商");
    process.exit(1);
  }
  const ocrText = `客户：这个方案的价格能再优惠一点吗？我们预算比较紧，如果能降到 8 万以内，我下周就可以把合同走完流程。`;

  console.log("=== 输入（模拟 OCR 结果）===");
  console.log(ocrText);
  console.log("\n=== 意图分析（真实 LLM 调用）===");

  const prompt = INTENT_PROMPT.replace("{{selection}}", ocrText);
  const t0 = Date.now();
  let out = "";
  await streamChat(
    { baseURL: p.baseURL, apiKey: p.apiKey, model: p.models[0] },
    [
      { role: "system", content: "你是专业的中文商业沟通分析师，输出精炼、可执行。" },
      { role: "user", content: prompt },
    ],
    (d) => {
      out += d;
      process.stdout.write(d);
    }
  );
  console.log(`\n\n--- 完成，${Date.now() - t0}ms，${out.length} 字 ---`);
  console.log(out.includes("意图") && out.includes("回应") ? "✅ 分析链路可用" : "⚠️ 输出结构可能不完整");
})().catch((e) => {
  console.error("❌ 失败:", e.message);
  process.exit(1);
});
