/**
 * DeepSeek 网页版自动化（参考 Kunpeng 的嵌入思路，改用 CDP 驱动专用浏览器）。
 *
 * 使用前提（一次性）：
 *   1. 插件会启动一个专用 Chrome/Edge 窗口（独立 profile，不影响日常浏览器）
 *   2. 在该窗口里登录 chat.deepseek.com 一次，登录态会持久保存
 *
 * 能力：
 *   - 提问（自动注入提示词并发送）
 *   - 专家模式（深度思考）开关 —— 默认开
 *   - 联网搜索开关
 *   - 图片上传（通过 DataTransfer 注入，走网页版视觉通道）
 *   - 等待并抓取回复（Markdown）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (mod: string) => any;

import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CDPClient, listTargets, newTab, CDPTarget } from "./cdp";
export { newTab, listTargets, CDPClient };

export interface DSWebOptions {
	port: number;
	expertMode: boolean;
	webSearch: boolean;
}

export interface DSWebResult {
	answer: string;
	thinking?: string;
}

let browserProc: any = null;

/** 找到本机的 Chrome / Edge 可执行文件 */
export function findBrowserBinary(): string | null {
	const platform = process.platform;
	const candidates: string[] =
		platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					path.join(process.env.HOME || "", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
			  ]
			: platform === "win32"
			? [
					"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
			  ]
			: [
					"/usr/bin/google-chrome",
					"/usr/bin/chromium-browser",
					"/usr/bin/chromium",
					"/usr/bin/microsoft-edge",
			  ];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) return c;
		} catch {}
	}
	return null;
}

/** 专用浏览器 profile 目录（与 Obsidian 插件共用，故两边登录态互通） */
function profileDir(): string {
	// 环境变量仅用于测试隔离（避免测试污染真实登录态）；正常情况走默认路径
	return process.env.HUACI_DSWEB_PROFILE || path.join(os.tmpdir(), "aie-dsweb-profile");
}

/** 启动专用浏览器（独立 profile，登录态持久）。已启动则复用。headless=后台不可见 */
export async function ensureBrowser(port: number, headless = false): Promise<void> {
	// 探测端口是否已有浏览器在听
	try {
		await listTargets(port);
		return; // 已在运行
	} catch {
		// 未运行 → 启动
	}
	const bin = findBrowserBinary();
	if (!bin) {
		throw new Error("未找到 Chrome/Edge，请安装后重试");
	}
	const dir = profileDir();
	// 显式带系统代理（macOS 读 scutil；Windows/Linux 交给 Chromium 系统设置）
	let proxyFlag = "";
	try {
		if (process.platform === "darwin") {
			const { execSync } = require("child_process");
			const out = execSync("scutil --proxy", { encoding: "utf8" });
			const m = out.match(/HTTPSEnable\s*:\s*1[\s\S]*?HTTPSProxy\s*:\s*([^\s]+)[\s\S]*?HTTPSPort\s*:\s*(\d+)/);
			if (m) proxyFlag = `--proxy-server=${m[1].trim()}:${m[2]}`;
		}
	} catch {}
	const flags = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${dir}`,
		"--no-first-run",
		"--no-default-browser-check",
	];
	if (headless) flags.push("--headless=new", "--window-size=1400,900");
	if (proxyFlag) flags.push(proxyFlag);
	flags.push("https://chat.deepseek.com/");
	// 双重 detach：经 nohup sh -c 启动，彻底脱离 Obsidian 进程树（否则 Obsidian eval 上下文结束后浏览器被回收）
	const cmdStr = JSON.stringify(bin) + " " + flags.map((f) => JSON.stringify(f)).join(" ");
	require("child_process").spawn("/bin/sh", ["-c", `nohup ${cmdStr} > /dev/null 2>&1 &`], {
		detached: true,
		stdio: "ignore",
	}).unref();
	// 等待调试端口就绪
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			await listTargets(port);
			return;
		} catch {}
	}
	throw new Error("浏览器启动超时（调试端口未就绪）");
}

/** 连接到 DeepSeek 页面（不存在则新开）。headless=后台运行不可见 */
export async function connectDeepSeek(port: number, headless = false): Promise<CDPClient> {
	await ensureBrowser(port, headless);
	let targets: CDPTarget[] = await listTargets(port);
	let target: CDPTarget | undefined = targets.find(
		(t) => t.url.includes("chat.deepseek.com") && t.webSocketDebuggerUrl && t.type === "page"
	);
	if (!target) {
		target = await newTab(port, "https://chat.deepseek.com/");
	}
	const client = await CDPClient.connect(target.webSocketDebuggerUrl!);
	await client.send("Runtime.enable");
	await client.send("Page.enable");
	// 若 tab 被导航到别处（如 Google 登录流程），拉回 DeepSeek
	if (!target.url.includes("chat.deepseek.com")) {
		await client.send("Page.navigate", { url: "https://chat.deepseek.com/" });
		await new Promise((r) => setTimeout(r, 2500));
	}
	// 每次都开全新会话：网页端同一会话保留历史上下文，会污染新问题
	await client.send("Page.navigate", { url: "https://chat.deepseek.com/" });
	await new Promise((r) => setTimeout(r, 4000));
	// 确保页面加载完成
	await client.evaluate("document.readyState");
	return client;
}

/** 页面内探针：登录态 / 输入框 / 切换器 */
const PROBE = `(function(){
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  const loginHint = document.body.innerText.includes('登录') && !document.body.innerText.includes('退出');
  const toggleBtns = [...document.querySelectorAll('div[role="button"], button')].map(b=>b.innerText.trim()).filter(Boolean);
  return {
    hasEditor: !!editor,
    editorKind: editor ? (editor.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable') : null,
    maybeNotLoggedIn: loginHint && toggleBtns.some(t=>t.includes('登录')),
    toggles: toggleBtns.filter(t=>t.includes('深度思考')||t.includes('联网搜索')||t.includes('DeepSeek')),
    url: location.href
  };
})()`;

/** 检查登录态（返回诊断信息） */
export async function checkLogin(client: CDPClient): Promise<{ loggedIn: boolean; hasEditor: boolean; info: any }> {
	const info = await client.evaluate(PROBE);
	const loggedIn = info.hasEditor && !info.maybeNotLoggedIn;
	return { loggedIn, hasEditor: info.hasEditor, info };
}

/** 设置开关（专家模式=深度思考 / 联网搜索），容错：找不到按钮不算失败 */
export async function setToggle(client: CDPClient, keyword: string, on: boolean): Promise<boolean> {
	const js = `(function(){
  const kw = ${JSON.stringify(keyword)};
  const target = ${JSON.stringify(on)};
  // 1) 首页模式选择器：文本精确匹配（专家模式/快速模式/识图模式）
  const chip = [...document.querySelectorAll('div, span, p')]
    .filter(x => x.children.length === 0 && (x.textContent || '').trim() === kw.replace('深度思考', '专家模式').replace('联网搜索', '智能搜索'))
    .pop();
  if (chip) { chip.click(); return true; }
  // 2) 会话内开关：.ds-toggle-button（深度思考/智能搜索）
  const toggles = [...document.querySelectorAll('.ds-toggle-button')];
  for (const b of toggles) {
    const t = (b.innerText||'').trim();
    if (!t.includes(kw)) continue;
    const active = b.className.includes('active') || b.className.includes('selected') || b.className.includes('primary');
    if (active !== target) b.click();
    return true;
  }
  // 兜底：通用按钮
  const btns = [...document.querySelectorAll('div[role="button"], button')];
  for (const b of btns) {
    const t = (b.innerText||'').trim();
    if (!t.includes(kw)) continue;
    b.click();
    return true;
  }
  return false;
})()`;
	return (await client.evaluate(js)) === true;
}

/** 注入文本到输入框并触发 input 事件（textarea 与 contenteditable 兼容） */
const SET_TEXT = `(function(){
  const text = "__TEXT__";
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  if (!editor) return false;
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }
  return true;
})()`;

function buildSetTextJs(text: string): string {
	return SET_TEXT.replace('"__TEXT__"', JSON.stringify(text));
}

/**
 * CDP 文件上传（新版 UI）：把 base64 写入临时文件 → DOM.setFileInputFiles 注入
 * 比 DataTransfer 粘贴模拟可靠（新版 UI 有真实 input[type=file]）
 */
export async function uploadFilesViaInput(
	client: CDPClient,
	files: { base64: string; name: string }[]
): Promise<boolean> {
	try {
		const dir = path.join(os.tmpdir(), "aie-dsweb-uploads");
		fs.mkdirSync(dir, { recursive: true });
		const paths: string[] = [];
		for (const f of files) {
			const p = path.join(dir, f.name || `upload-${Date.now()}.png`);
			fs.writeFileSync(p, Buffer.from(f.base64, "base64"));
			paths.push(p);
		}
		await client.send("DOM.enable");
		const doc = await client.send("DOM.getDocument", { depth: 1 });
		const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
		if (!node?.nodeId) return false;
		await client.send("DOM.setFileInputFiles", { files: paths, nodeId: node.nodeId });
		await new Promise((r) => setTimeout(r, 1500));
		return true;
	} catch {
		return false;
	}
}

/**
 * 页面内拦截器：捕获 /chat/completion 的 SSE 原始流（新版协议为 JSON-Patch 流式）。
 * 装在 window 上，ask() 轮询读取；每次发送前重置。
 */
const INSTALL_CAPTURE = `(function(){
  window.__aieSSE = '';
  window.__aieDone = false;
  window.__aieUrl = '';
  if (window.__aiePatched) return 'reset';
  window.__aiePatched = true;
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
      if (String(url).includes('/chat/completion')) {
        window.__aieUrl = String(url);
        const clone = res.clone();
        (async () => {
          try {
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              window.__aieSSE += dec.decode(value, { stream: true });
            }
          } finally { window.__aieDone = true; }
        })();
      }
    } catch (e) { window.__aiePatchErr = String(e); }
    return res;
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      if (String(url).includes('/chat/completion')) {
        window.__aieUrl = String(url);
        xhr.addEventListener('progress', () => { window.__aieSSE = xhr.responseText || ''; });
        xhr.addEventListener('loadend', () => { window.__aieSSE = xhr.responseText || ''; window.__aieDone = true; });
      }
      return origOpen.call(xhr, method, url, ...rest);
    };
    return xhr;
  };
  return 'installed';
})()`;

/**
 * 解析 DeepSeek 新版 JSON-Patch SSE 流：
 *  fragments 分片（THINK=思考 / RESPONSE=回答）+ path patch（APPEND 追加）
 * 返回 { content, thinking, finished }
 */
function parseDSWebSSE(sse: string): { content: string; thinking: string; finished: boolean } {
	const fragments: { type: string; content: string }[] = [];
	let appendToContent = false;
	let finished = false;
	for (const rawLine of sse.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		let j: {
			p?: string;
			o?: string;
			v?: unknown;
			response?: { fragments?: { type?: string; content?: string }[]; status?: string; quasi_status?: string };
		};
		try {
			j = JSON.parse(payload);
		} catch {
			continue;
		}
		// 完整 response 对象（流开头）
		const resp = j?.v && typeof j.v === "object" ? (j.v as { response?: unknown }).response : undefined;
		if (resp && typeof resp === "object") {
			const r = resp as { fragments?: { type?: string; content?: string }[]; status?: string; quasi_status?: string };
			if (Array.isArray(r.fragments)) {
				for (const f of r.fragments) fragments.push({ type: f.type ?? "", content: f.content ?? "" });
			}
			if (r.quasi_status === "FINISHED" || r.status === "FINISHED") finished = true;
			continue;
		}
		// patch 操作
		if (j.p) {
			if (j.p === "response/fragments" && Array.isArray(j.v)) {
				for (const f of j.v as { type?: string; content?: string }[]) {
					fragments.push({ type: f.type ?? "", content: f.content ?? "" });
				}
				appendToContent = true;
			} else if (j.p === "response/fragments/-1/content" && j.o === "APPEND") {
				const last = fragments[fragments.length - 1];
				if (last) last.content += String(j.v ?? "");
				appendToContent = true;
			} else if (j.p === "response/status" && j.v === "FINISHED") {
				finished = true;
			} else if (j.p === "response" && j.o === "BATCH" && Array.isArray(j.v)) {
				for (const b of j.v as { p?: string; v?: unknown }[]) {
					if (b.p === "quasi_status" && b.v === "FINISHED") finished = true;
				}
			}
			continue;
		}
		// 简写追加：{"v":"..."} 延续上一个 patch 路径
		if (j.v !== undefined && appendToContent) {
			const last = fragments[fragments.length - 1];
			if (last && typeof j.v === "string") last.content += j.v;
		}
	}
	const content = fragments.filter((f) => f.type === "RESPONSE").map((f) => f.content).join("");
	const thinking = fragments.filter((f) => f.type === "THINK").map((f) => f.content).join("");
	return { content, thinking, finished };
}

/**
 * 点击发送按钮。实测两代 UI：
 *  - 新版：输入框右侧 .ds-button--primary（无 aria-label）
 *  - 旧版：[aria-label*="发送"]
 * 兜底：Enter 键
 */
const CLICK_SEND = `(function(){
  const editor = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
  const scope = editor ? (editor.closest('[class*="input"], [class*="Input"], form') || editor.parentElement?.parentElement?.parentElement || document) : document;
  const primaries = [...scope.querySelectorAll('.ds-button--primary')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (primaries.length) {
    const btn = primaries[primaries.length - 1];
    if (btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return 'primary'; }
  }
  const allPrimary = [...document.querySelectorAll('.ds-button--primary')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > innerHeight * 0.5;
  });
  if (allPrimary.length) {
    allPrimary.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    allPrimary[0].click();
    return 'primary-global';
  }
  const byAria = document.querySelector('[aria-label*="发送"], button[aria-label*="send" i]');
  if (byAria && byAria.getAttribute('aria-disabled') !== 'true') { byAria.click(); return 'aria'; }
  if (editor) {
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return 'enter';
  }
  return false;
})()`;

/**
 * 抓取最后一条 AI 回复。
 * 关键：用 innerHTML 而非 innerText —— DeepSeek 的数学公式经 KaTeX 渲染，
 * innerText 会把行内公式拆成竖排单字符且丢失 LaTeX 定界符；
 * KaTeX 的 <annotation encoding="application/x-tex"> 保留了完整 LaTeX 源码，可无损还原。
 */
const READ_LAST = `(function(){
  // KaTeX 公式就地还原为 LaTeX 占位（浏览器 DOM 解析闭合最可靠）
  document.querySelectorAll('.ds-markdown .katex, .ds-markdown .katex-display').forEach(k => {
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    const tex = ann ? ann.textContent : '';
    const pre = document.createElement('pre');
    pre.className = 'aie-tex';
    pre.setAttribute('data-tex', tex);
    pre.textContent = tex;
    k.replaceWith(pre);
  });
  const blocks = [...document.querySelectorAll('.ds-markdown, .ds-assistant-message-main-content')].filter((el, i, arr) => arr.indexOf(el) === i);
  const stopBtn = document.querySelector('div[role="button"][aria-label*="停止"], [class*="stop"]');
  const editor = document.querySelector('textarea#chat-input, div[contenteditable="true"]');
  const editorEmpty = !editor || (!editor.value && (!editor.innerText || editor.innerText.trim()===''));
  const html = blocks.length ? blocks[blocks.length-1].innerHTML : '';
  return {
    html,
    last: blocks.length ? blocks[blocks.length-1].innerText : '',
    count: blocks.length,
    generating: !!stopBtn || !editorEmpty
  };
})()`;



/**
 * HTML → Markdown（DeepSeek 网页版特化）：
 * - KaTeX 公式还原为 $...$ / $$...$$ LaTeX
 * - 代码块、加粗、标题、列表、链接保留
 */
function htmlToMarkdown(html: string): string {
	let out = html;
	// 公式：.aie-tex[data-tex]（浏览器内已就地把 KaTeX 还原为 LaTeX）
	out = out.replace(/<pre class="aie-tex" data-tex="([\s\S]*?)">[\s\S]*?<\/pre>/g, (_, tex) => {
		const texDec = decodeHtmlEntities(tex);
		return texDec.includes("\n") ? "\n\n$$" + texDec + "$$\n\n" : "$" + texDec + "$";
	});
	// 代码块
	out = out.replace(/<pre[\s\S]*?<code(?:\s[^>]*)?>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/g,
		(_, code) => String.fromCharCode(10) + String.fromCharCode(96).repeat(3) + decodeHtmlEntities(code) + String.fromCharCode(96).repeat(3) + String.fromCharCode(10));
	out = out.replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/g, (_, c) => '\u0060' + decodeHtmlEntities(c) + '\u0060');
	for (let i = 6; i >= 1; i--) {
		const hTag = '<h' + i + ' ';
		out = out.replace(new RegExp(hTag + '([\\s\\S]*?)' + '</h' + i + '>', 'g'), (_, c) => '\n\n' + '#'.repeat(i) + ' ' + c.replace(/<[^>]*>/g, '') + '\n\n');
	}
	out = out.replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/(strong|b)>/g, "**$2**");
	out = out.replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/(em|i)>/g, "*$2*");
	out = out.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)");
	out = out.replace(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g, "- $1");
	out = out.replace(/<\/?[uo]l(?:\s[^>]*)?>/g, "\n");
	out = out.replace(/<p(?:\s[^>]*)?>/g, "\n\n").replace(/<\/p>/g, "");
	out = out.replace(/<br\s*\/?>/g, "\n");
	out = out.replace(/<[^>]+>/g, "");
	out = decodeHtmlEntities(out);
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out;
}

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
}

/** 图片/文件上传：DataTransfer 注入到输入区（走网页版通道，专家模式可视觉识别） */
const INJECT_FILES = `(function(){
  return new Promise((resolve) => {
    const files = __FILES__ARR__.map(f => {
      const arr = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
      return new File([arr], f.name, { type: f.mime });
    });
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const target = document.querySelector('textarea#chat-input, textarea[placeholder], div[contenteditable="true"]');
    if (!target) { resolve(false); return; }
    target.focus();
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    setTimeout(() => resolve(!!document.querySelector('img[class*="preview"], [class*="file-preview"], [class*="upload"]')), 600);
  });
})()`;

function buildInjectFilesJs(files: { base64: string; name: string; mime: string }[]): string {
	return INJECT_FILES.replace("__FILES__ARR__", JSON.stringify(files));
}

/** 关闭专用浏览器（登录完成后切回 headless 用） */
export function killBrowser(): void {
	try {
		const { execSync } = require("child_process");
		// 按实际 profile 路径匹配：测试用 HUACI_DSWEB_PROFILE 隔离时，
		// 硬编码 "aie-dsweb-profile" 会误杀真实实例
		const marker = path.basename(profileDir());
		execSync(`pkill -f ${JSON.stringify(marker)}`, { stdio: "ignore" });
	} catch {}
	browserProc = null;
}

/**
 * 打开登录页：在专用浏览器（CDP profile）内导航到登录页并置前。
 *
 * 关键 1：绝不能用 shell.openExternal —— 那会打开系统默认浏览器，
 *   登录态写进日常浏览器的 profile，与专用 profile（aie-dsweb-profile）无关，
 *   表现为「明明登录了，助手仍提示未登录」。
 *
 * 关键 2：必须先 killBrowser() 再以可见模式重启。
 *   ensureBrowser 发现端口已被占用时会直接复用现有实例——若后台正跑着
 *   headless（不可见）实例（例如用户先点了「解释」触发过一次生成），
 *   登录页就会在不可见窗口里打开，用户什么都看不到、无法登录。
 *   这是「新电脑首次登录不了」的根因（新机器第一步通常是先生成 → headless 常驻）。
 */
export async function openLoginPage(port: number): Promise<CDPClient> {
	// 从 headless 切可见：杀掉现有实例（无论 headless 还是可见），确保下面重启的是可见窗口
	killBrowser();
	await new Promise((r) => setTimeout(r, 1200));
	// 可见窗口（headless 下用户无法操作登录页）
	await ensureBrowser(port, false);
	const client = await connectDeepSeekForLogin(port);
	// 导航到登录页（connectDeepSeekForLogin 已停在 deepseek 域，这里直达 sign_in）
	await client.send("Page.navigate", { url: "https://chat.deepseek.com/sign_in" });
	await new Promise((r) => setTimeout(r, 2500));
	await client.send("Page.bringToFront", {}).catch(() => {});
	return client;
}

/** 为登录流程连接 DeepSeek 页面：与 connectDeepSeek 相同，但不强制跳回首页（避免打断用户手动导航） */
async function connectDeepSeekForLogin(port: number): Promise<CDPClient> {
	await ensureBrowser(port, false);
	const targets: CDPTarget[] = await listTargets(port);
	let target: CDPTarget | undefined = targets.find(
		(t) => t.url.includes("chat.deepseek.com") && t.webSocketDebuggerUrl && t.type === "page"
	);
	if (!target) {
		target = await newTab(port, "https://chat.deepseek.com/");
	}
	const client = await CDPClient.connect(target.webSocketDebuggerUrl!);
	await client.send("Runtime.enable");
	await client.send("Page.enable");
	return client;
}

/**
 * 登录态探测：连上当前 DeepSeek 页面跑 PROBE，读完即断开。
 *
 * 注意：绝不能走 connectDeepSeek —— 它内部有两次 Page.navigate，
 * 而本函数被设置页以 4s 间隔轮询（等用户完成登录）。若探测时导航，
 * 用户正在填写的登录页会被反复拽回首页，登录永远完不成。
 * 因此这里只连当前已打开的页面做只读探测，不做任何导航。
 *
 * 返回 null 表示探测本身失败（浏览器起不来等）。
 */
export async function probeLoginStatus(port: number): Promise<{ loggedIn: boolean } | null> {
	let client: CDPClient | null = null;
	try {
		await ensureBrowser(port, true); // 未运行则以 headless 拉起（不打断已有实例）
		const targets = await listTargets(port);
		const target = targets.find(
			(t) => t.url.includes("chat.deepseek.com") && t.webSocketDebuggerUrl && t.type === "page"
		);
		if (!target) return { loggedIn: false };
		client = await CDPClient.connect(target.webSocketDebuggerUrl!);
		await client.send("Runtime.enable");
		const login = await checkLogin(client);
		return { loggedIn: login.loggedIn };
	} catch {
		return null;
	} finally {
		try {
			client?.close();
		} catch {}
	}
}

export interface AskOptions {
	prompt: string;
	expertMode: boolean;
	webSearch: boolean;
	images?: { base64: string; name: string; mime: string }[];
	textFiles?: { name: string; content: string }[];
	timeoutMs?: number;
	/** 流式增量回调（桌面助手用：边生成边渲染） */
	onDelta?: (content: string, thinking: string) => void;
}

/**
 * 完整提问流程（适配 DeepSeek 新版 UI）：
 *  1. 导航到新对话页
 *  2. 安装网络拦截器（捕获 SSE 原始流，不受虚拟列表渲染影响）
 *  3. 深度思考 / 智能搜索开关
 *  4. 文件/图片注入 → 输入 → 发送
 *  5. 轮询拦截到的 SSE，按新协议解析出 answer 与 thinking
 *  6. SSE 无数据时回退 DOM 抓取（兼容旧 UI）
 */
export async function ask(client: CDPClient, opts: AskOptions): Promise<DSWebResult> {
	// 1) 先导航到新对话页（后续所有操作在干净页面进行；导航会清空附件，必须最先做）
	await client.send("Page.navigate", { url: "https://chat.deepseek.com/" });
	await new Promise((r) => setTimeout(r, 4000));
	// 2) 安装 SSE 拦截器（导航后 JS 上下文重置，需重新安装）
	await client.evaluate(INSTALL_CAPTURE);
	// 3) 模式开关（导航后设置，专家模式=深度思考）
	if (opts.expertMode) {
		await setToggle(client, "专家模式", true);
		await setToggle(client, "深度思考", true);
	}
	await setToggle(client, "智能搜索", !!opts.webSearch);
	await setToggle(client, "联网搜索", !!opts.webSearch);
	// 4) 文本文件内容拼入提示词
	if (opts.textFiles?.length) {
		const fileText = opts.textFiles.map((f) => "【文件：" + f.name + "】\n" + f.content).join("\n\n");
		opts.prompt = opts.prompt + "\n\n" + fileText;
	}
	// 5) 图片上传（新版 UI：CDP 文件注入；旧版：DataTransfer 粘贴兜底）
	if (opts.images?.length) {
		let ok = await uploadFilesViaInput(client, opts.images);
		if (!ok) {
			ok = await client.evaluate(buildInjectFilesJs(opts.images));
		}
		if (!ok) throw new Error("图片注入失败（网页可能不支持，或选择器变化）");
		await new Promise((r) => setTimeout(r, 1500));
	}
	// 6) 输入并发送
	await client.evaluate(buildSetTextJs(""));
	const okSetText = await client.evaluate(buildSetTextJs(opts.prompt));
	if (!okSetText) throw new Error("未能定位输入框（网页结构可能已变化）");
	const sent = await client.evaluate(CLICK_SEND);
	if (!sent) throw new Error("点击发送失败");

	// 轮询拦截到的 SSE
	const deadline = Date.now() + (opts.timeoutMs ?? 180000);
	let sse = "";
	let stableCount = 0;
	let finished = false;
	let lastResponseLen = -1;
	// 流式增量：只在内容变化时回调（避免重复渲染同一份快照）
	let lastEmittedContent = "";
	let lastEmittedThinking = "";
	await new Promise((r) => setTimeout(r, 1500));
	while (Date.now() < deadline) {
		const st = await client.evaluate(
			"JSON.stringify({ sse: window.__aieSSE || '', done: !!window.__aieDone, url: (window.__aieUrl || '').slice(-30) })"
		);
		let parsed: { sse?: string; done?: boolean } = {};
		try {
			parsed = JSON.parse(st || "{}");
		} catch {
			// 忽略解析失败
		}
		const cur = parsed.sse ?? "";
		if (cur.length > 0) {
			sse = cur;
			const result = parseDSWebSSE(sse);
			finished = result.finished;
			// 增量回调（content 或 thinking 有变化就推）
			if (opts.onDelta && (result.content !== lastEmittedContent || result.thinking !== lastEmittedThinking)) {
				lastEmittedContent = result.content;
				lastEmittedThinking = result.thinking;
				try {
					opts.onDelta(result.content, result.thinking);
				} catch {
					// 渲染回调失败不影响主流程
				}
			}
			if (finished && result.content) {
				return { answer: result.content, thinking: result.thinking || undefined };
			}
			if (cur.length === lastResponseLen) {
				stableCount++;
				// 内容稳定且流已关闭 → 完成
				if (stableCount >= 2 && parsed.done && result.content) {
					return { answer: result.content, thinking: result.thinking || undefined };
				}
			} else {
				stableCount = 0;
				lastResponseLen = cur.length;
			}
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	// 超时：有部分内容则返回，否则回退 DOM 抓取
	if (sse) {
		const result = parseDSWebSSE(sse);
		if (result.content) return { answer: result.content, thinking: result.thinking || undefined };
	}
	try {
		const st = await client.evaluate(READ_LAST);
		if (st?.html) {
			const fallback = htmlToMarkdown(st.html);
			if (fallback) return { answer: fallback };
		}
	} catch {
		// 回退失败则抛原始错误
	}
	throw new Error(
		"等待回复超时。常见原因：专用浏览器网络不通（页面显示‘请检查网络后重试’时，需要给浏览器配代理）或 DeepSeek 风控；可关闭专用浏览器后重开重试"
	);
}
