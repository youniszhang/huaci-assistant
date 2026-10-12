/**
 * LLM 路由：按供应商 ptype 分发到 API 通道或 DeepSeek 网页版通道。
 */

import { ApiConfig, ChatMessage, SYSTEM_PROMPT, chatWithFallback } from "./api";
import { ResolvedProvider, DEFAULT_DSWEB_PORT } from "./types";
import { connectDeepSeek, ask, checkLogin, killBrowser, ensureBrowser, newTab, openLoginPage, probeLoginStatus } from "./dsweb";

export interface RunLlmOptions {
	provider: ResolvedProvider;
	/** 实际使用的模型名（api 通道有效；dsweb 仅作标签） */
	model?: string;
	temperature?: number;
	messages: ChatMessage[];
	onContent: (chunk: string) => void;
	onReasoning?: (chunk: string) => void;
	signal?: AbortSignal;
	/** dsweb：是否后台运行浏览器（默认 true，避免弹窗打扰） */
	headless?: boolean;
}

export interface RunLlmResult {
	/** 完整正文 */
	content: string;
	/** 思考过程（若有） */
	thinking?: string;
	/** 实际通道 */
	channel: "api" | "dsweb";
}

/** dsweb 超时（与插件一致：180s） */
const DSWEB_TIMEOUT = 180000;

function buildApiConfig(opts: RunLlmOptions): ApiConfig {
	return {
		baseURL: opts.provider.baseURL,
		model: opts.model || opts.provider.models[0] || "",
		apiKey: opts.provider.apiKey,
		temperature: opts.temperature ?? 0.3,
	};
}

/** 把多轮 messages 折叠成单轮 prompt（网页版只有一个输入框） */
function flattenMessages(messages: ChatMessage[]): string {
	const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
	const rest = messages.filter((m) => m.role !== "system");
	if (rest.length <= 1 && sys) {
		return `${sys}\n\n---\n\n${rest[0]?.content ?? ""}`.trim();
	}
	const body = rest
		.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
		.join("\n\n");
	return [sys, body].filter(Boolean).join("\n\n---\n\n");
}

/** 通过 API 通道运行（流式 + 兜底） */
export async function runApi(opts: RunLlmOptions): Promise<RunLlmResult> {
	const cfg = buildApiConfig(opts);
	if (!cfg.baseURL) throw new Error("供应商未配置 Base URL");
	if (!cfg.model) throw new Error("供应商未配置模型");
	let content = "";
	let thinking = "";
	await chatWithFallback(
		cfg,
		opts.messages,
		(chunk) => {
			content += chunk;
			opts.onContent(chunk);
		},
		(chunk) => {
			thinking += chunk;
			opts.onReasoning?.(chunk);
		},
		opts.signal
	);
	return { content, thinking: thinking || undefined, channel: "api" };
}

/**
 * 通过 DeepSeek 网页版运行。
 * 复用与 Obsidian 插件同一个专用浏览器（端口 + profile 路径一致），
 * 插件已登录过则无需再登录。
 */
export async function runDsweb(opts: RunLlmOptions): Promise<RunLlmResult> {
	const port = opts.provider.dswebPort || DEFAULT_DSWEB_PORT;
	const headless = opts.headless !== false;
	const client = await connectDeepSeek(port, headless);
	// 快照状态放函数内，避免并发调用互相污染
	let emitted = { content: "", thinking: "" };
	try {
		const login = await checkLogin(client);
		if (!login.loggedIn) {
			throw new Error(
				"DeepSeek 网页版未登录。请打开划词助手主窗口 →「供应商」页 → 点「登录网页版」完成登录（登录态与 Obsidian 插件共用）。"
			);
		}
		const prompt = flattenMessages(opts.messages);
		const result = await ask(client, {
			prompt,
			expertMode: opts.provider.expertMode !== false,
			webSearch: !!opts.provider.webSearch,
			timeoutMs: DSWEB_TIMEOUT,
			onDelta: (content, thinking) => {
				// 网页版给的是整份快照，转成增量推给渲染层
				if (content.length > emitted.content.length && content.startsWith(emitted.content)) {
					opts.onContent(content.slice(emitted.content.length));
				} else if (content && content !== emitted.content) {
					// 非增量（重写）：整份替换语义，交给上层重绘
					opts.onContent(content);
				}
				if (thinking.length > emitted.thinking.length && thinking.startsWith(emitted.thinking)) {
					opts.onReasoning?.(thinking.slice(emitted.thinking.length));
				}
				emitted = { content, thinking };
			},
		});
		return { content: result.answer, thinking: result.thinking, channel: "dsweb" };
	} finally {
		try {
			client.close();
		} catch {
			// 忽略关闭异常
		}
	}
}

/** 统一入口 */
export async function runLlm(opts: RunLlmOptions): Promise<RunLlmResult> {
	if (opts.provider.ptype === "dsweb") {
		return runDsweb(opts);
	}
	return runApi(opts);
}

export { SYSTEM_PROMPT, checkLogin, killBrowser, ensureBrowser, newTab, connectDeepSeek, openLoginPage, probeLoginStatus };
export type { ChatMessage } from "./api";
