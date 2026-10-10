/**
 * 测试：DeepSeek 网页版通道（复用插件登录态，走 CDP）
 * 用法：node scripts/test-dsweb.js [port]
 *
 * 依赖：需要 bin/SelectionHelper 同级的 CDP 客户端（直接用项目编译产物，
 * 因此这里通过 dist 不可行——dist 依赖 electron。改为独立最小实现，
 * 与 src/main/llm/dsweb.ts 同源逻辑）
 */
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = Number(process.argv[2] || 9223);

// ---------- 最小 CDP 客户端（与 src/main/llm/cdp.ts 同逻辑） ----------

function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 5000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          reject(new Error("解析失败"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("超时"));
    });
    req.on("error", reject);
  });
}

class CDP {
  constructor(sock) {
    this.sock = sock;
    this.id = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    sock.on("data", (chunk) => this.onData(chunk));
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (res, sock) => resolve(new CDP(sock)));
      req.on("error", reject);
      req.end();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (op === 1) {
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch {}
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    const data = JSON.stringify({ id, method, params });
    const payload = Buffer.from(data);
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, masked]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }
  async evaluate(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.result?.value;
  }
  close() {
    try {
      this.sock.destroy();
    } catch {}
  }
}

// ---------- 主流程 ----------

(async () => {
  console.log(`=== DeepSeek 网页版通道测试（端口 ${PORT}）===`);
  let targets;
  try {
    targets = await listTargets(PORT);
    console.log(`✅ 找到专用浏览器，${targets.length} 个标签页`);
  } catch (e) {
    console.log(`❌ 端口 ${PORT} 无响应：${e.message}`);
    console.log("   提示：先在 Obsidian 插件里用一次网页版，或点本工具「登录 DeepSeek 网页版」");
    process.exit(1);
  }
  const page = targets.find((t) => t.url.includes("chat.deepseek.com") && t.type === "page");
  if (!page) {
    console.log("❌ 没有 chat.deepseek.com 标签页");
    console.log("   现有标签：", targets.map((t) => t.url.slice(0, 60)).join("\n   "));
    process.exit(1);
  }
  console.log(`   目标：${page.title}`);

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  // 登录态检查
  const probe = `(function(){
    const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
    const loginHint = document.body.innerText.includes('登录') && !document.body.innerText.includes('退出');
    return { hasEditor: !!editor, maybeNotLoggedIn: loginHint, url: location.href };
  })()`;
  const st = await cdp.evaluate(probe);
  console.log(`   输入框：${st.hasEditor ? "有" : "无"} · 登录提示：${st.maybeNotLoggedIn ? "疑似未登录" : "正常"}`);
  const loggedIn = st.hasEditor && !st.maybeNotLoggedIn;
  console.log(loggedIn ? "✅ 登录态正常" : "⚠️ 可能未登录（请在弹出的浏览器里登录一次）");

  if (loggedIn) {
    // 实测发一条
    console.log("\n--- 发一条测试消息 ---");
    await cdp.send("Page.navigate", { url: "https://chat.deepseek.com/" });
    await new Promise((r) => setTimeout(r, 4000));
    await cdp.evaluate(`(function(){
      window.__t = '';
      if (window.__patched) return;
      window.__patched = true;
      const of = window.fetch;
      window.fetch = async function(...a) {
        const res = await of.apply(this, a);
        try {
          const url = (typeof a[0]==='string')?a[0]:(a[0]?.url||'');
          if (String(url).includes('/chat/completion')) {
            const c = res.clone();
            (async()=>{ const rd=c.body.getReader(); const de=new TextDecoder();
              while(true){const {done,value}=await rd.read(); if(done)break; window.__t += de.decode(value,{stream:true});} })();
          }
        } catch(e){}
        return res;
      };
      const OX = window.XMLHttpRequest;
      window.XMLHttpRequest = function(){
        const x = new OX(); const oo = x.open;
        x.open = function(m,u,...r){ if(String(u).includes('/chat/completion')){ x.addEventListener('progress',()=>{window.__t=x.responseText||''}); } return oo.call(x,m,u,...r); };
        return x;
      };
      return 'ok';
    })()`);

    const setText = `(function(){
      const ed = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
      if (!ed) return false;
      ed.focus();
      const t = "用一句话解释 RoPE";
      if (ed.tagName === 'TEXTAREA') {
        const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        s.call(ed, t);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, t);
      }
      return true;
    })()`;
    const okSet = await cdp.evaluate(setText);
    console.log(`   注入文本：${okSet ? "成功" : "失败"}`);
    const sent = await cdp.evaluate(`(function(){
      const btns = [...document.querySelectorAll('.ds-button--primary, [role="button"]')];
      for (const b of btns) {
        if (b.offsetParent === null) continue;
        if (b.getAttribute('aria-disabled') === 'true') continue;
        b.click(); return true;
      }
      return false;
    })()`);
    console.log(`   点击发送：${sent ? "成功" : "失败"}`);

    // 轮询结果
    const deadline = Date.now() + 60000;
    let last = "";
    while (Date.now() < deadline) {
      const sse = await cdp.evaluate("window.__t || ''");
      if (sse && sse.length > last.length) {
        last = sse;
        const m = sse.match(/"content":"([^"]{5,80})/g);
        if (m) console.log(`   收到流数据（${sse.length} 字节）…`);
      }
      if (sse && sse.length > 300) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`\n${last.length > 300 ? "✅ 网页版通道正常（捕获到 SSE 流）" : "⚠️ 未捕获到流，可能网页结构变化"}`);
  }

  cdp.close();
})().catch((e) => {
  console.error("❌ 失败：", e.message);
  process.exit(1);
});
