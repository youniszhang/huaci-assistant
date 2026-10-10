/**
 * 最小 CDP（Chrome DevTools Protocol）客户端 — 纯 Node 实现，零依赖。
 * 用途：驱动一个带 --remote-debugging-port 的 Chrome/Edge 标签页，
 *      执行 DeepSeek 网页版自动化（专家模式/联网搜索/提问/图片上传）。
 * 仅桌面端可用（依赖 Node http / crypto / fs）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (mod: string) => any;

import * as http from "http";
import * as crypto from "crypto";

export interface CDPTarget {
	id: string;
	title: string;
	url: string;
	type?: string;
	webSocketDebuggerUrl?: string;
}

/** 拉取调试端口上的所有目标（标签页） */
export function listTargets(port: number): Promise<CDPTarget[]> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 5000 }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(data));
				} catch (e) {
					reject(new Error("targets 响应解析失败"));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error("连接调试端口超时（浏览器未启动或端口不对）")); });
		req.on("error", reject);
	});
}

/** 新开标签页：PUT → GET → 浏览器级 Target.createTarget 三级兜底 */
export async function newTab(port: number, url: string): Promise<CDPTarget> {
	const tryHttp = (method: string): Promise<CDPTarget> =>
		new Promise((resolve, reject) => {
			const req = http.request(
				{ host: "127.0.0.1", port, path: "/json/new?" + encodeURIComponent(url), method, timeout: 8000 },
				(res) => {
					let data = "";
					res.on("data", (c) => (data += c));
					res.on("end", () => {
						try {
							const parsed = JSON.parse(data);
							if (parsed && parsed.id) resolve(parsed);
							else reject(new Error("empty"));
						} catch (e) {
							reject(new Error("empty"));
						}
					});
				}
			);
			req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
			req.on("error", reject);
			req.end();
		});

	for (const method of ["PUT", "GET"]) {
		try {
			return await tryHttp(method);
		} catch {
			// 尝试下一种
		}
	}
	// 最终兜底：浏览器级 CDP Target.createTarget
	const version = await new Promise<any>((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 5000 }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve(JSON.parse(data)));
		});
		req.on("error", reject);
	});
	const client = await CDPClient.connect(version.webSocketDebuggerUrl);
	const res = await client.send("Target.createTarget", { url });
	client.close();
	const newId = res?.targetId;
	if (!newId) throw new Error("Target.createTarget 失败");
	await new Promise((r) => setTimeout(r, 500));
	const targets = await listTargets(port);
	const t = targets.find((x) => x.id === newId);
	if (!t) throw new Error("新建标签页后未找到 target");
	return t;
}

export class CDPClient {
	private ws: any = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private eventHandlers = new Map<string, ((params: any) => void)[]>();
	public wsUrl = "";

	static async connect(wsUrl: string, timeoutMs = 10000): Promise<CDPClient> {
		const client = new CDPClient();
		await client.open(wsUrl, timeoutMs);
		return client;
	}

	private open(wsUrl: string, timeoutMs: number): Promise<void> {
		this.wsUrl = wsUrl;
		const u = new URL(wsUrl);
		const key = crypto.randomBytes(16).toString("base64");
		return new Promise((resolve, reject) => {
			const req = http.request({
				hostname: u.hostname,
				port: Number(u.port || 80),
				path: u.pathname + u.search,
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Key": key,
					"Sec-WebSocket-Version": "13",
					Host: u.host,
				},
			});
			req.on("upgrade", (res, socket) => {
				const accept = crypto
					.createHash("sha1")
					.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
					.digest("base64");
				if (res.headers["sec-websocket-accept"] !== accept) {
					socket.destroy();
					reject(new Error("WebSocket 握手校验失败"));
					return;
				}
				this.ws = socket;
				socket.setNoDelay(true);
				let buf = Buffer.alloc(0);
				socket.on("data", (chunk: Buffer) => {
					buf = Buffer.concat([buf, chunk]);
					while (true) {
						const frame = this.parseFrame(buf);
						if (!frame) break;
						buf = buf.slice(frame.consumed);
						this.handleFrame(frame);
					}
				});
				socket.on("error", (e: Error) => this.failAll(e));
				socket.on("close", () => this.failAll(new Error("CDP 连接已关闭")));
				resolve();
			});
			req.on("response", (res) => {
				reject(new Error(`WebSocket 升级失败：HTTP ${res.statusCode}`));
			});
			req.on("error", reject);
			req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("CDP 连接超时")); });
			req.end();
		});
	}

	private failAll(e: Error): void {
		for (const [, p] of this.pending) p.reject(e);
		this.pending.clear();
	}

	private handleFrame(frame: { opcode: number; payload: Buffer; consumed: number; fin: boolean }): void {
		if (frame.opcode === 0x9) {
			// ping → pong
			this.sendRawFrame(0xa, frame.payload);
			return;
		}
		if (frame.opcode === 0x8) {
			this.failAll(new Error("CDP 连接被远端关闭"));
			try { this.ws?.destroy(); } catch {}
			return;
		}
		if (frame.opcode !== 0x1) return;
		try {
			const msg = JSON.parse(frame.payload.toString("utf8"));
			if (msg.id !== undefined && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message || "CDP 错误"));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const h of this.eventHandlers.get(msg.method) || []) h(msg.params);
			}
		} catch {
			// 忽略解析失败
		}
	}

	private parseFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number; fin: boolean } | null {
		if (buf.length < 2) return null;
		const fin = (buf[0] & 0x80) !== 0;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < 4) return null;
			len = buf.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (buf.length < 10) return null;
			len = Number(buf.readBigUInt64BE(2));
			offset = 10;
		}
		let maskKey: Buffer | null = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.slice(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return null;
		let payload = buf.slice(offset, offset + len);
		if (maskKey) {
			for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
		}
		return { opcode, payload, consumed: offset + len, fin };
	}

	private sendRawFrame(opcode: number, payload: Buffer): void {
		if (!this.ws) return;
		const mask = crypto.randomBytes(4);
		const len = payload.length;
		let header: Buffer;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, 0x80 | len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		const masked = Buffer.from(payload);
		for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
		this.ws.write(Buffer.concat([header, mask, masked]));
	}

	send(method: string, params: any = {}): Promise<any> {
		const id = this.nextId++;
		const msg = JSON.stringify({ id, method, params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.sendRawFrame(0x1, Buffer.from(msg, "utf8"));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP 调用超时：${method}`));
				}
			}, 30000);
		});
	}

	async evaluate(expression: string): Promise<any> {
		const res = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (res?.exceptionDetails) {
			const desc = res.exceptionDetails?.exception?.description || "页面脚本执行失败";
			throw new Error(desc);
		}
		return res?.result?.value;
	}

	close(): void {
		try { this.ws?.destroy(); } catch {}
		this.ws = null;
	}
}
