/**
 * 测试：真实 API 通道（读 Obsidian 配置，走流式请求）
 * 用法：node scripts/test-api.js [providerName]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

function normalizeBaseURL(url) {
  let u = (url || "").trim();
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
}

/** 找到第一个有 apiKey 的 api 类供应商 */
function findApiProvider(wantName) {
  const obsidianJson = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  if (!fs.existsSync(obsidianJson)) throw new Error("obsidian.json 不存在");
  const raw = JSON.parse(fs.readFileSync(obsidianJson, "utf8"));
  for (const v of Object.values(raw.vaults || {})) {
    const dataJson = path.join(v.path, ".obsidian", "plugins", "ai-explainer", "data.json");
    if (!fs.existsSync(dataJson)) continue;
    const data = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    for (const p of data.providers || []) {
      if ((p.ptype || "api") !== "api") continue;
      if (!p.apiKey || !p.baseURL || !p.models?.length) continue;
      if (wantName && p.name !== wantName) continue;
      return { provider: p, vault: v.path, activeModel: data.activeModel };
    }
  }
  return null;
}

function streamChat(cfg, messages, onContent, onReasoning) {
  return new Promise((resolve, reject) => {
    const base = normalizeBaseURL(cfg.baseURL);
    const url = new URL(`${base}/chat/completions`);
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey.trim()}`,
        },
      },
      (res) => {
        if (res.statusCode >= 400) {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 300)}`)));
          return;
        }
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return resolve();
            try {
              const j = JSON.parse(payload);
              const d = j.choices?.[0]?.delta;
              if (!d) continue;
              if (d.reasoning_content && onReasoning) onReasoning(d.reasoning_content);
              if (d.content) onContent(d.content);
            } catch {}
          }
        });
        res.on("end", resolve);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(60000, () => {
      const e = new Error("超时 60s");
      req.destroy(e);
    });
    req.write(JSON.stringify({ model: cfg.model, temperature: 0.3, stream: true, messages }));
    req.end();
  });
}

(async () => {
  const found = findApiProvider(process.argv[2]);
  if (!found) {
    console.log("未找到可用的 API 供应商");
    process.exit(1);
  }
  const { provider, vault, activeModel } = found;
  const model = provider.models.includes(activeModel) ? activeModel : provider.models[0];
  console.log(`vault: ${vault}`);
  console.log(`provider: ${provider.name}`);
  console.log(`baseURL: ${provider.baseURL}`);
  console.log(`model: ${model}  (key ${provider.apiKey.slice(0, 10)}…)`);
  console.log("--- 发起流式请求 ---");

  const t0 = Date.now();
  let first = 0;
  let text = "";
  let think = "";
  await streamChat(
    { baseURL: provider.baseURL, apiKey: provider.apiKey, model },
    [
      { role: "system", content: "你是一个助手，用简体中文回答。" },
      { role: "user", content: "用一句话解释什么是 RoPE（旋转位置编码）。" },
    ],
    (c) => {
      if (!first) {
        first = Date.now() - t0;
        console.log(`\n[首字延迟 ${first}ms]`);
      }
      text += c;
      process.stdout.write(c);
    },
    (c) => {
      think += c;
    }
  );
  console.log(`\n--- 完成，总耗时 ${Date.now() - t0}ms ---`);
  console.log(`正文 ${text.length} 字${think ? `，思考 ${think.length} 字` : ""}`);
  console.log(text.trim() ? "✅ API 通道可用" : "❌ 返回空内容");
})().catch((e) => {
  console.error("❌ 失败：", e.message);
  process.exit(1);
});
