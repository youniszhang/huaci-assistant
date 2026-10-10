/**
 * 划词捕获：管理 Swift SelectionHelper 子进程，消费其 JSON-lines 输出。
 *
 * helper 路径解析顺序：
 *   1. 打包后：process.resourcesPath/bin/SelectionHelper
 *   2. 开发时：<项目根>/bin/SelectionHelper
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface SelectionEvent {
	text: string;
	/** 左上原点坐标（与 Electron setBounds 一致） */
	x: number;
	y: number;
	/** 选区元素高度（用于决定工具条放在上方还是下方） */
	h: number;
	app: string;
}

export interface ClickEvent {
	x: number;
	y: number;
}

interface HelperMessage {
	type:
		| "ready"
		| "perms"
		| "selection"
		| "click"
		| "error"
		| "log"
		| "pong"
		| "cleared"
		| "ocr"
		| "region-begin"
		| "region-update"
		| "region"
		| "region-cancel";
	ok?: boolean;
	reason?: string;
	text?: string;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	app?: string;
	message?: string;
	accessibilityTrusted?: boolean;
	inputMonitoring?: boolean;
	screenRecording?: boolean;
	pid?: number;
	/** OCR 结果（JSON 字符串） */
	payload?: string;
}

/** 框选区域（屏幕绝对坐标，左上原点） */
export interface ScreenRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrLine {
	text: string;
	confidence: number;
	/** 屏幕绝对坐标（左上原点） */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrResult {
	ok: boolean;
	text: string;
	count: number;
	durationMs: number;
	lines: OcrLine[];
	error?: string;
}

export function helperPath(): string | null {
	const tried: string[] = [];
	const candidates = [
		path.join(process.resourcesPath ?? "", "bin", "SelectionHelper"),
		path.join(app.getAppPath(), "bin", "SelectionHelper"),
		path.join(app.getAppPath(), "..", "bin", "SelectionHelper"),
		path.join(__dirname, "..", "..", "bin", "SelectionHelper"),
		// 开发态：app.getAppPath() 是项目根，bin/ 在其下
		path.join(app.getAppPath(), "..", "..", "bin", "SelectionHelper"),
	];
	for (const c of candidates) {
		try {
			if (c && fs.existsSync(c)) return c;
			tried.push(c);
		} catch {
			tried.push(`${c}（探测异常）`);
		}
	}
	console.log(`[capture] helper 未找到，已尝试:\n  ${tried.join("\n  ")}`);
	return null;
}

/** 与 helperPath 相同的解析逻辑，但不打日志（探测轮询复用，避免刷屏） */
function resolveHelperPath(): string | null {
	const candidates = [
		path.join(process.resourcesPath ?? "", "bin", "SelectionHelper"),
		path.join(app.getAppPath(), "bin", "SelectionHelper"),
		path.join(app.getAppPath(), "..", "bin", "SelectionHelper"),
		path.join(__dirname, "..", "..", "bin", "SelectionHelper"),
		path.join(app.getAppPath(), "..", "..", "bin", "SelectionHelper"),
	];
	for (const c of candidates) {
		try {
			if (c && fs.existsSync(c)) return c;
		} catch {
			// 探测异常，尝试下一个
		}
	}
	return null;
}

export interface PermissionSnapshot {
	accessibilityTrusted: boolean;
	inputMonitoring: boolean;
	screenRecording: boolean;
}

/**
 * 用一次性子进程探测三项权限的实时状态。
 *
 * 为什么不能用长驻 helper 的轮询：CGPreflightListenEventAccess /
 * CGPreflightScreenCaptureAccess 的结果在进程内被缓存（实测 2026-10-09：
 * 用户在设置里授权「输入监控」后，已运行的 helper 直到被杀掉重建前
 * 永远读到 false）。因此必须 spawn 新进程探测，宿主发现授权后重启
 * helper，新进程即可读到 true 并重建 CGEventTap。
 */
export function probePermissions(timeoutMs = 5000): Promise<PermissionSnapshot | null> {
	const bin = resolveHelperPath();
	if (!bin) return Promise.resolve(null);
	return new Promise((resolve) => {
		let done = false;
		const finish = (v: PermissionSnapshot | null) => {
			if (done) return;
			done = true;
			try {
				proc.kill();
			} catch {
				// 已退出
			}
			clearTimeout(timer);
			resolve(v);
		};
		const proc = spawn(bin, ["--check-permissions"], { stdio: ["ignore", "pipe", "ignore"] });
		const timer = setTimeout(() => finish(null), timeoutMs);
		let buf = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			buf += chunk;
			const idx = buf.indexOf("\n");
			if (idx === -1) return;
			try {
				const msg = JSON.parse(buf.slice(0, idx)) as HelperMessage;
				if (msg.type === "perms") {
					finish({
						accessibilityTrusted: !!msg.accessibilityTrusted,
						inputMonitoring: !!msg.inputMonitoring,
						screenRecording: !!msg.screenRecording,
					});
				}
			} catch {
				finish(null);
			}
		});
		proc.on("error", () => finish(null));
		proc.on("exit", () => finish(null));
	});
}

/** 权限自愈轮询间隔（用户去设置里授权后，最长这么久自动生效） */
const PERMISSION_POLL_MS = 3000;
/** 连续探测无果 N 次后降频（避免某项权限长期缺失时每 3s 无限 spawn 探测进程） */
const PERMISSION_POLL_SLOW_MS = 30_000;
const PERMISSION_POLL_FAST_TRIES = 20;

export class SelectionCapture extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private restartTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private restartCount = 0;
	private static readonly MAX_RESTART = 5;
	/** 权限自愈轮询定时器（见 startPermissionWatcher） */
	private permTimer: NodeJS.Timeout | null = null;
	private permProbing = false;
	/** 连续探测无果计数：达到阈值后降频（见 PERMISSION_POLL_SLOW_MS） */
	private permEmptyProbes = 0;
	/** 主动重启节流：两次权限触发的重启至少间隔 10s，避免异常态下循环重启 */
	private lastPermRestartAt = 0;

	public accessibilityTrusted = false;
	public inputMonitoring = false;
	public screenRecording = false;
	public available = false;

	start(): void {
		if (this.proc || this.stopped) return;
		const bin = helperPath();
		if (!bin) {
			this.available = false;
			this.emit("unavailable", "找不到 SelectionHelper 可执行文件（请先运行 swift/build.sh）");
			return;
		}
		try {
			// --ignore-pid：让 helper 忽略宿主 Electron 自身窗口里的选区
			// --request-permissions：启动时主动请求缺失权限（弹对话框 + 注册到设置列表），
			//   否则 adhoc 签名下重装/重签后授权静默失效、用户在设置里也找不到条目
			this.proc = spawn(bin, ["--ignore-pid", String(process.pid), "--request-permissions"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			console.log(`[capture] 已启动 helper (pid=${this.proc.pid})`);
		} catch (err) {
			this.available = false;
			this.emit("unavailable", `启动 SelectionHelper 失败：${(err as Error).message}`);
			return;
		}
		this.available = true;

		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk: string) => {
			this.emit("log", chunk.trim());
		});
		this.proc.on("exit", (code) => {
			this.proc = null;
			if (this.stopped) return;
			// helper 崩溃时，进行中的框选请求不可能再有结果 → 立即失败返回，
			// 避免 UI 阻塞到 60s 超时；重启后的新 helper 不在 region 模式
			if (this.pendingRegion) {
				const { resolve } = this.pendingRegion;
				this.pendingRegion = null;
				resolve(null);
			}
			this.emit("log", `SelectionHelper 退出（code=${code}）`);
			// 崩溃自动重启（限次，避免死循环）
			if (this.restartCount < SelectionCapture.MAX_RESTART) {
				this.restartCount += 1;
				this.restartTimer = setTimeout(() => this.start(), 1000 * this.restartCount);
			} else {
				this.available = false;
				this.emit("unavailable", "SelectionHelper 反复退出，已停止重启");
			}
		});
		this.proc.on("error", (err) => {
			this.emit("log", `SelectionHelper 错误：${err.message}`);
		});

		this.startPermissionWatcher();
	}

	// ------------------------------------------------------------ 权限自愈
	//
	// 背景（实测 2026-10-09）：用户在系统设置里勾选「输入监控」/「屏幕录制」后，
	// 已运行 helper 进程内的 CGPreflight* 结果不会刷新（进程级缓存），导致
	// 「设置里开关是 ON，app 里状态仍显示未授权、划词不弹」。旧的方案依赖
	// helper 自身 5s 定时器检测变化，但 preflight 缓存使其永远检测不到。
	// 现在由宿主用「一次性新进程」探测真实状态，发现新授权立即重启 helper。

	private startPermissionWatcher(): void {
		if (this.permTimer) return;
		this.schedulePermTick(PERMISSION_POLL_MS);
	}

	/** 递归 setTimeout（而非 setInterval）：便于按探测结果动态调整间隔 */
	private schedulePermTick(delay: number): void {
		if (this.permTimer) clearTimeout(this.permTimer);
		this.permTimer = setTimeout(async () => {
			this.permTimer = null;
			if (this.stopped) return;
			const gained = await this.checkPermissionsOnce();
			// 探测无变化累计到阈值 → 降频（长期未授权时避免持续 spawn）
			const delay = gained || this.permEmptyProbes < PERMISSION_POLL_FAST_TRIES
				? PERMISSION_POLL_MS
				: PERMISSION_POLL_SLOW_MS;
			this.schedulePermTick(delay);
		}, delay);
	}

	private stopPermissionWatcher(): void {
		if (this.permTimer) {
			clearTimeout(this.permTimer);
			this.permTimer = null;
		}
	}

	/** @returns 是否探测到新授权（并已触发重启） */
	private async checkPermissionsOnce(): Promise<boolean> {
		if (this.permProbing || this.stopped || !this.proc) return false;
		// 三项都已在 helper 内生效 → 无需探测（避免无谓的进程 spawn）
		if (this.accessibilityTrusted && this.inputMonitoring && this.screenRecording) return false;
		this.permProbing = true;
		try {
			const snap = await probePermissions();
			if (!snap || this.stopped || !this.proc) return false;
			const gained =
				(snap.accessibilityTrusted && !this.accessibilityTrusted) ||
				(snap.inputMonitoring && !this.inputMonitoring) ||
				(snap.screenRecording && !this.screenRecording);
			if (gained) {
				this.permEmptyProbes = 0;
				this.restartForPermissions();
				return true;
			}
			this.permEmptyProbes += 1;
			return false;
		} finally {
			this.permProbing = false;
		}
	}

	/** 检测到新授权 → 主动重启 helper（新进程读到新权限并重建 CGEventTap） */
	private restartForPermissions(): void {
		const now = Date.now();
		if (now - this.lastPermRestartAt < 10_000) return; // 节流，防异常循环
		this.lastPermRestartAt = now;
		this.restartCount = 0; // 主动重启不计入崩溃重启计数
		this.emit("log", "检测到新授权 → 重启 helper 使权限生效");
		try {
			this.send({ type: "quit" });
			this.proc?.kill();
		} catch {
			// 进程可能已退出
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: HelperMessage;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: HelperMessage): void {
		switch (msg.type) {
			case "ready":
				this.restartCount = 0; // 成功启动 → 重置计数
				this.accessibilityTrusted = !!msg.accessibilityTrusted;
				this.inputMonitoring = !!msg.inputMonitoring;
				this.screenRecording = !!msg.screenRecording;
				this.emit("ready", {
					accessibilityTrusted: this.accessibilityTrusted,
					inputMonitoring: this.inputMonitoring,
					screenRecording: this.screenRecording,
				});
				break;
			case "selection":
				if (msg.ok && msg.text) {
					this.emit("selection", {
						text: msg.text,
						x: msg.x ?? 0,
						y: msg.y ?? 0,
						h: msg.h ?? 18,
						app: msg.app ?? "",
					} as SelectionEvent);
				} else {
					this.emit("noselection", msg.reason ?? "unknown");
				}
				break;
			case "click":
				this.emit("click", { x: msg.x ?? 0, y: msg.y ?? 0 } as ClickEvent);
				break;
			case "cleared":
				// 选区被清空（用户点击了别处）——通知上层隐藏悬浮窗
				this.emit("cleared");
				break;
			case "ocr": {
				// OCR 结果：解析后交给等待中的 promise
				let parsed: OcrResult | null = null;
				try {
					parsed = msg.payload ? (JSON.parse(msg.payload) as OcrResult) : null;
				} catch {
					parsed = null;
				}
				if (this.pendingOcr) {
					const { resolve } = this.pendingOcr;
					this.pendingOcr = null;
					if (this.pendingOcrTimer) clearTimeout(this.pendingOcrTimer);
					this.pendingOcrTimer = null;
					resolve(parsed ?? { ok: false, text: "", count: 0, durationMs: 0, lines: [], error: "OCR 结果解析失败" });
				}
				break;
			}
			case "region-begin":
				this.emit("region-begin");
				break;
			case "region-update":
				this.emit("region-update", {
					x: msg.x ?? 0,
					y: msg.y ?? 0,
					w: msg.w ?? 0,
					h: msg.h ?? 0,
				} as ScreenRect);
				break;
			case "region": {
				const rect = { x: msg.x ?? 0, y: msg.y ?? 0, w: msg.w ?? 0, h: msg.h ?? 0 } as ScreenRect;
				if (this.pendingRegion) {
					const { resolve } = this.pendingRegion;
					this.pendingRegion = null;
					resolve(rect);
				}
				this.emit("region", rect);
				break;
			}
			case "region-cancel":
				if (this.pendingRegion) {
					const { resolve } = this.pendingRegion;
					this.pendingRegion = null;
					resolve(null);
				}
				this.emit("region-cancel");
				break;
			case "error":
				this.emit("log", `helper error: ${msg.message}`);
				break;
			case "log":
				this.emit("log", `helper: ${msg.message}`);
				break;
			default:
				break;
		}
	}

	/** 主动触发一次取词（配合全局快捷键） */
	requestCapture(): void {
		this.send({ type: "capture" });
	}

	/** 待返回的 OCR 请求 */
	private pendingOcr: { resolve: (r: OcrResult) => void } | null = null;
	private pendingOcrTimer: NodeJS.Timeout | null = null;
	/** 待返回的框选请求 */
	private pendingRegion: { resolve: (r: ScreenRect | null) => void } | null = null;

	/** 进入框选模式，等待用户拖拽出矩形；返回 null 表示取消 */
	selectRegion(timeoutMs = 60000): Promise<ScreenRect | null> {
		if (!this.proc) return Promise.resolve(null);
		return new Promise((resolve) => {
			const req = { resolve };
			this.pendingRegion = req;
			setTimeout(() => {
				// 身份比对：只有仍是本次请求时才超时处理，
				// 否则会误杀 60s 内新发起的框选请求
				if (this.pendingRegion === req) {
					this.pendingRegion = null;
					// 关键：必须通知 helper 退出 region 模式。
					// 否则 helper 会一直吞掉鼠标拖拽（当作框选），表现为「划词整体失效」。
					this.send({ type: "region-abort" });
					resolve(null);
				}
			}, timeoutMs);
			this.send({ type: "region-select" });
		});
	}

	/**
	 * 主动中止框选（如渲染层 Esc、主进程取消）。
	 * 幂等：没有进行中的框选时也安全，helper 侧会忽略。
	 */
	abortRegion(): void {
		if (this.pendingRegion) {
			const { resolve } = this.pendingRegion;
			this.pendingRegion = null;
			resolve(null);
		}
		this.send({ type: "region-abort" });
	}

	/**
	 * 区域截屏 + OCR（异步）。
	 * @param rect 屏幕区域（左上原点）；传 null 则全屏
	 * @param timeoutMs 超时（默认 15s）
	 */
	ocr(rect: { x: number; y: number; w: number; h: number } | null, timeoutMs = 15000): Promise<OcrResult> {
		if (!this.proc) {
			return Promise.resolve({ ok: false, text: "", count: 0, durationMs: 0, lines: [], error: "划词助手未运行" });
		}
		// 已有请求在跑 → 直接返回错误，避免串味
		if (this.pendingOcr) {
			return Promise.resolve({ ok: false, text: "", count: 0, durationMs: 0, lines: [], error: "上一个 OCR 请求未完成" });
		}
		return new Promise((resolve) => {
			this.pendingOcr = { resolve };
			this.pendingOcrTimer = setTimeout(() => {
				if (this.pendingOcr) {
					const { resolve: r } = this.pendingOcr;
					this.pendingOcr = null;
					r({ ok: false, text: "", count: 0, durationMs: 0, lines: [], error: "OCR 超时" });
				}
			}, timeoutMs);

			const msg: Record<string, unknown> = { type: "ocr", langs: ["zh-Hans", "en-US"] };
			if (rect) {
				msg.x = rect.x;
				msg.y = rect.y;
				msg.w = rect.w;
				msg.h = rect.h;
			}
			this.send(msg);
		});
	}

	private send(obj: Record<string, unknown>): void {
		if (!this.proc?.stdin.writable) return;
		try {
			this.proc.stdin.write(JSON.stringify(obj) + "\n");
		} catch {
			// 写入失败忽略（进程可能刚退出）
		}
	}

	stop(): void {
		this.stopped = true;
		this.stopPermissionWatcher();
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.send({ type: "quit" });
		try {
			this.proc?.kill();
		} catch {
			// 忽略
		}
		this.proc = null;
	}

	/** 允许重启（托盘里重新开启划词时用） */
	reset(): void {
		this.stopped = false;
		this.restartCount = 0;
	}
}
