/**
 * OpenAI 兼容 API 通道（从 obsidian-ai-explainer 的 src/api.ts 移植）。
 *
 * 差异（桌面端）：
 *  - 去掉 obsidian 依赖，兜底通道改用 Node https/http（Electron 主进程可用）
 *  - 保留 30s 超时、AbortSignal、SSE 解析、reasoning_content 处理
 */

import * as http from "http";
import * as https from "https";

export interface ApiConfig {
	baseURL: string;
	model: string;
	apiKey: string;
	temperature: number;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** 规范化 Base URL：去空白、补协议、去尾斜杠 */
export function normalizeBaseURL(url: string): string {
	let u = url.trim();
	if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
	return u.replace(/\/+$/, "");
}

export interface StreamCallbacks {
	/** 正文增量 */
	onContent: (chunk: string) => void;
	/** 思考/推理增量（推理型模型的 reasoning_content） */
	onReasoning?: (chunk: string) => void;
}

export interface FallbackResult {
	streamed: boolean;
	reasoning: string;
}

/**
 * 流式对话（Electron 主进程 fetch + SSE）。
 * 注意：Electron 主进程的 fetch 无 CORS 限制，可直连任意 API。
 */
export async function streamChat(
	cfg: ApiConfig,
	messages: ChatMessage[],
	cbs: StreamCallbacks,
	signal?: AbortSignal
): Promise<void> {
	const base = normalizeBaseURL(cfg.baseURL);
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${cfg.apiKey.trim()}`,
		},
		body: JSON.stringify({
			model: cfg.model.trim(),
			temperature: cfg.temperature,
			stream: true,
			messages,
		}),
		signal,
	});

	if (!res.ok) {
		let msg = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { error?: { message?: string } };
			msg = body?.error?.message || msg;
		} catch {
			// 保留 HTTP 状态码信息
		}
		throw new Error(msg);
	}

	const reader = res.body?.getReader();
	if (!reader) throw new Error("响应为空");
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return;
			try {
				const json = JSON.parse(payload);
				const delta = json.choices?.[0]?.delta;
				if (!delta) continue;
				if (delta.reasoning_content && cbs.onReasoning) cbs.onReasoning(delta.reasoning_content);
				if (delta.content) cbs.onContent(delta.content);
			} catch {
				// 跳过无法解析的心跳/注释行
			}
		}
	}
}

/**
 * Node https/http 流式通道：无 CORS 限制，天然支持任意 API 的真流式。
 */
export function nodeStream(
	cfg: ApiConfig,
	messages: ChatMessage[],
	cbs: StreamCallbacks,
	signal?: AbortSignal
): Promise<void> {
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
				if ((res.statusCode ?? 500) >= 400) {
					let body = "";
					res.on("data", (d: Buffer) => (body += d.toString()));
					res.on("end", () => reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`)));
					return;
				}
				let buffer = "";
				res.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					let idx: number;
					while ((idx = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 1);
						if (!line.startsWith("data:")) continue;
						const payload = line.slice(5).trim();
						if (payload === "[DONE]") {
							resolve();
							return;
						}
						try {
							const json = JSON.parse(payload);
							const delta = json.choices?.[0]?.delta;
							if (!delta) continue;
							if (delta.reasoning_content && cbs.onReasoning) cbs.onReasoning(delta.reasoning_content);
							if (delta.content) cbs.onContent(delta.content);
						} catch {
							// 跳过无法解析的行
						}
					}
				});
				res.on("end", () => resolve());
				res.on("error", reject);
			}
		);
		req.on("error", reject);
		req.setTimeout(30000, () => {
			const e = new Error("请求超时（30s 无响应）");
			e.name = "TimeoutError";
			req.destroy(e);
		});
		if (signal) {
			const onAbort = () => {
				const e = new Error("aborted");
				e.name = "AbortError";
				req.destroy(e);
			};
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		}
		req.write(JSON.stringify({ model: cfg.model.trim(), temperature: cfg.temperature, stream: true, messages }));
		req.end();
	});
}

/** 兜底通道：非流式一次性返回全文（Node https，无 CORS 限制） */
export async function completeChat(cfg: ApiConfig, messages: ChatMessage[]): Promise<string> {
	const base = normalizeBaseURL(cfg.baseURL);
	const url = new URL(`${base}/chat/completions`);
	const mod = url.protocol === "http:" ? http : https;
	return new Promise((resolve, reject) => {
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
				let body = "";
				res.on("data", (d: Buffer) => (body += d.toString()));
				res.on("end", () => {
					if ((res.statusCode ?? 500) >= 400) {
						let msg = `HTTP ${res.statusCode}`;
						try {
							msg = JSON.parse(body)?.error?.message || msg;
						} catch {
							// 保留状态码
						}
						reject(new Error(msg));
						return;
					}
					try {
						resolve(JSON.parse(body)?.choices?.[0]?.message?.content ?? "");
					} catch {
						reject(new Error("响应解析失败"));
					}
				});
				res.on("error", reject);
			}
		);
		req.on("error", reject);
		req.setTimeout(120000, () => {
			const e = new Error("请求超时（120s）");
			e.name = "TimeoutError";
			req.destroy(e);
		});
		req.write(
			JSON.stringify({ model: cfg.model.trim(), temperature: cfg.temperature, stream: false, messages })
		);
		req.end();
	});
}

/**
 * 三通道：Node 流 → fetch 流 → 非流式兜底。
 * 一旦已有输出则不再降级，避免重复。
 */
export async function chatWithFallback(
	cfg: ApiConfig,
	messages: ChatMessage[],
	onContent: (chunk: string) => void,
	onReasoning?: (chunk: string) => void,
	signal?: AbortSignal
): Promise<FallbackResult> {
	let streamed = false;
	const cbs: StreamCallbacks = {
		onContent: (chunk) => {
			streamed = true;
			onContent(chunk);
		},
		onReasoning: (chunk) => {
			streamed = true;
			if (onReasoning) onReasoning(chunk);
		},
	};

	const attempts: (() => Promise<void>)[] = [
		() => nodeStream(cfg, messages, cbs, signal),
		() => streamChat(cfg, messages, cbs, signal),
	];

	let lastErr: unknown;
	for (const attempt of attempts) {
		try {
			await attempt();
			return { streamed: true, reasoning: "" };
		} catch (err) {
			if ((err as Error).name === "AbortError") throw err;
			if (streamed) throw err; // 已输出部分内容，降级会重复
			lastErr = err;
		}
	}
	// 最终兜底：非流式
	const full = await completeChat(cfg, messages);
	if (!full.trim()) {
		const msg = lastErr instanceof Error ? lastErr.message : "AI 返回了空内容";
		throw new Error(msg);
	}
	onContent(full);
	return { streamed: false, reasoning: "" };
}

export const SYSTEM_PROMPT =
	"You are a helpful study assistant. 始终用简体中文回答。解释要结合给定的上下文，而不是孤立地解释名词。";
