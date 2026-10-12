/**
 * 划词助手 — 主进程入口
 *
 * 职责：
 *  - 单实例锁、托盘、主窗口（设置页）
 *  - 悬浮窗（划词工具条 / 结果卡片）
 *  - Swift helper 划词捕获
 *  - LLM 调用编排（API / DeepSeek 网页版）
 *  - 写入 Obsidian 笔记
 */

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import * as fs from "fs";
import * as path from "path";
import { SelectionCapture, SelectionEvent, ClickEvent, helperPath, ScreenRect, OcrResult } from "./capture";
import { OverlayWindow, OverlayPosition, RegionOverlay } from "./overlay";
import { listVaults, loadProviders, pickVault, loadExplainerSettings } from "./obsidian";
import {
	loadStore,
	saveStore,
	ensureImported,
	activeOf,
	isUsable,
	storePath,
	addProvider,
	updateProvider,
	deleteProvider,
	ensureDswebProvider,
	setActive as setActiveProvider,
	ProviderStore,
	NewProviderInput,
	ProviderPatch,
} from "./providers";
import { AppSettings, fillTemplate, loadSettings, saveSettings, DEFAULT_ACTIONS } from "./settings";
import { listCaptures, readCapture, writeCapture, sanitizeBody, annotationTitle } from "./note";
import { runLlm, SYSTEM_PROMPT, ChatMessage, ensureBrowser, killBrowser, connectDeepSeek, checkLogin, openLoginPage, probeLoginStatus } from "./llm";
import { ResolvedProvider, DEFAULT_DSWEB_PORT } from "./llm/types";
import { chatWithFallback, normalizeBaseURL } from "./llm/api";
import { appendHistory, getHistory, listHistory, updateHistory, deleteHistory, clearHistory } from "./history";
import { API } from "../shared/api.js";

// shared/api.js 是 CommonJS 模块
const IPC = API as Record<string, string>;
function ch(key: string): string {
	return IPC[key] ?? key;
}

const isDev = !app.isPackaged;
if (isDev) {
	app.setPath("userData", path.join(app.getPath("userData"), "huaci-dev"));
}

/** 日志目录（打包后 = ~/Library/Application Support/划词助手/logs） */
const LOG_DIR = path.join(app.getPath("userData"), "logs");
process.env.HUACI_LOG_DIR = LOG_DIR;

/**
 * 落盘日志：把主进程（含 capture/overlay 模块）的所有 console 输出
 * 追加写入 logs/main.log。排查「重启后失效」这类问题必须依赖它 ——
 * 打包后 stdout 进了 launchd 黑洞，事后无法取证。
 */
function installFileLogging(): void {
	const file = path.join(LOG_DIR, "main.log");
	const write = (level: string, args: unknown[]) => {
		const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
		const text = args
			.map((a) => {
				if (typeof a === "string") return a;
				if (a instanceof Error) return a.stack ?? a.message;
				try {
					return JSON.stringify(a);
				} catch {
					return String(a);
				}
			})
			.join(" ");
		try {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			// 简单轮转：超过 5MB 时截断，避免无限增长
			try {
				if (fs.statSync(file).size > 5 * 1024 * 1024) fs.writeFileSync(file, "");
			} catch {
				// 文件还不存在
			}
			fs.appendFileSync(file, `[${ts}] [${level}] ${text}\n`);
		} catch {
			// 日志失败不影响主流程
		}
	};
	const origLog = console.log.bind(console);
	const origErr = console.error.bind(console);
	console.log = (...args: unknown[]) => {
		write("info", args);
		origLog(...(args as []));
	};
	console.error = (...args: unknown[]) => {
		write("error", args);
		origErr(...(args as []));
	};
}
installFileLogging();

// 应用身份：开发模式下 Dock / 菜单栏默认显示 "Electron" + 原子图标，这里改成本应用
app.setName("划词助手");

/**
 * 开发模式下让 Dock 显示正式图标而非 Electron 默认图标。
 * 打包后由 Info.plist + icon.icns 接管，无需此步。
 */
function applyDevDockIcon(): void {
	if (!isDev || process.platform !== "darwin") return;
	const candidates = [
		path.join(app.getAppPath(), "build", "icon-dev.png"),
		path.join(__dirname, "..", "..", "build", "icon-dev.png"),
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) {
				const img = nativeImage.createFromPath(c);
				if (!img.isEmpty()) {
					app.dock?.setIcon(img);
					return;
				}
			}
		} catch {
			// 忽略，退回默认图标
		}
	}
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const overlay = new OverlayWindow();
const regionOverlay = new RegionOverlay(() => abortRegionSelect());
const capture = new SelectionCapture();
let settings: AppSettings = loadSettings();
/** 正在框选（用于取消） */
let regionSelecting = false;

/** 当前会话状态 */
interface Session {
	selection: string;
	pos: OverlayPosition;
	app: string;
	action: string;
	actionLabel: string;
	messages: ChatMessage[];
	content: string;
	thinking: string;
	provider?: ResolvedProvider;
	model?: string;
	running: boolean;
	abort?: AbortController;
	error?: string;
	/** 最近一次生成对应的历史记录 id（用于「录入笔记」时回标 saved） */
	historyId?: string;
}
let session: Session | null = null;
let captureEnabled = true;
let lastSelection = "";
let lastSelectionAt = 0;
/** 最近一次「手动取词」（快捷键/托盘/设置页触发）时间，autoPopup 关闭时用它放行手动划词 */
let lastManualCaptureAt = 0;

// ---------------------------------------------------------------- 配置
//
// 供应商配置已独立于 Obsidian：存在本机 <userData>/providers.json（见 providers.ts）。
// Obsidian 只用于「笔记写入」与「首次运行一次性导入」，两边配置互不影响。

/** 读取本机供应商配置（必要时做首次导入） */
function providerStore(): ProviderStore {
	return loadStore();
}

function activeProvider(): ResolvedProvider | null {
	const store = providerStore();
	// 桌面端手动指定的优先供应商（settings.preferredProviderId）优先于 activeProviderId
	if (settings.preferredProviderId) {
		const hit = store.providers.find((p) => p.id === settings.preferredProviderId && p.enabled);
		if (hit) return { ...hit };
	}
	return activeOf(store);
}

function currentModel(p: ResolvedProvider | undefined): string | undefined {
	if (!p) return undefined;
	if (p.ptype === "dsweb") {
		return p.models?.find((m) => m.includes("专家")) ?? p.models?.[0];
	}
	// api：用本机配置里记录的 activeModel（若属于该供应商），否则第一个模型
	const store = providerStore();
	if (store.activeProviderId === p.id && store.activeModel && p.models?.includes(store.activeModel)) {
		return store.activeModel;
	}
	return p.models?.[0];
}

// ---------------------------------------------------------------- 主窗口

function createMainWindow(opts: { focus?: boolean } = {}): BrowserWindow {
	const wantFocus = opts.focus !== false;
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (wantFocus) {
			mainWindow.show();
			mainWindow.focus();
		} else if (!mainWindow.isVisible()) {
			mainWindow.showInactive();
		}
		return mainWindow;
	}
	mainWindow = new BrowserWindow({
		width: 980,
		height: 720,
		minWidth: 820,
		minHeight: 560,
		show: false,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 18, y: 22 },
		backgroundColor: "#f5f5f7",
		webPreferences: {
			preload: path.join(__dirname, "..", "preload", "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	mainWindow.loadFile(path.join(__dirname, "..", "renderer", "main.html"));
	mainWindow.once("ready-to-show", () => {
		// 静默场景（首次授权引导）不抢焦点；用户主动打开才 show+focus
		if (wantFocus) {
			mainWindow?.show();
			mainWindow?.focus();
		} else {
			mainWindow?.showInactive();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	return mainWindow;
}

// ---------------------------------------------------------------- 托盘

function createTray(): void {
	const iconPath = path.join(__dirname, "..", "renderer", "trayTemplate.png");
	let image = nativeImage.createFromPath(iconPath);
	if (image.isEmpty()) {
		// 兜底：用内置 emoji 生成一个 1x1 空图，避免托盘创建失败
		image = nativeImage.createEmpty();
	} else {
		image.setTemplateImage(true);
	}
	try {
		tray = new Tray(image);
	} catch {
		return;
	}
	rebuildTrayMenu();
	tray.on("click", () => {
		createMainWindow();
		mainWindow?.show();
	});
}

function rebuildTrayMenu(): void {
	if (!tray) return;
	const p = activeProvider();
	const modelNote = p
		? `${p.name}${p.ptype === "dsweb" ? "（网页版）" : ""}`
		: "未找到供应商";
	const menu = Menu.buildFromTemplate([
		{ label: `当前供应商：${modelNote}`, enabled: false },
		{ type: "separator" },
		{
			label: "开启划词监听",
			type: "checkbox",
			checked: captureEnabled,
			click: (item) => setCaptureEnabled(item.checked),
		},
	{
		label: "立即取词",
		accelerator: settings.hotkeyCapture || undefined,
		click: () => {
			lastManualCaptureAt = Date.now();
			capture.requestCapture();
		},
	},
		{
			label: "框选屏幕区域分析…",
			accelerator: settings.hotkeyScan || undefined,
			click: () => void scanRegionAndAnalyze(),
		},
		{ type: "separator" },
		{ label: "打开主窗口…", click: () => createMainWindow() },
		{
			label: "打开收集目录",
			click: () => {
				const v = pickVault(settings.vaultPath || undefined);
				if (!v) return;
				const dir = path.join(v.path, settings.captureDir);
				fs.mkdirSync(dir, { recursive: true });
				void shell.openPath(dir);
			},
		},
		{ type: "separator" },
		{ label: "退出划词助手", click: () => app.quit() },
	]);
	tray.setToolTip("划词助手");
	tray.setContextMenu(menu);
}

function setCaptureEnabled(enabled: boolean): void {
	captureEnabled = enabled;
	if (enabled) {
		capture.reset();
		capture.start();
	} else {
		cancelPendingToolbarHide();
		capture.stop();
		overlay.hide();
	}
	rebuildTrayMenu();
	overlay.send(ch("overlay:state"), { mode: overlay.getMode(), captureEnabled });
}

// ---------------------------------------------------------------- 划词流程

function selectionAnchor(x: number, y: number, h: number): OverlayPosition {
	// helper 已给左上原点坐标（x=元素中心，y=元素顶边，h=元素高度）
	return { x, y, h };
}

capture.on("selection", (ev: SelectionEvent) => {
	if (!captureEnabled) return;
	// 拖动悬浮窗时 helper 会把鼠标拖拽当作「重新划词」并重发上一次的 selection，
	// 会把刚拖走的窗口拽回选区锚点 —— 拖动期间（含结束后 600ms 冷却）直接忽略
	if (overlay.isDragging()) return;
	const text = ev.text.trim();
	if (!text) return;
	console.log(`[selection] app=${ev.app} len=${text.length} pos=(${Math.round(ev.x)},${Math.round(ev.y)}) text="${text.slice(0, 40)}"`);
	// 去抖：同一段文本 1.2s 内只处理一次；且过短视为误触
	const now = Date.now();
	if (text === lastSelection && now - lastSelectionAt < 1200) return;
	if (text.length < 2) return;
	// autoPopup=false（「划词后自动弹出工具条」关闭）：划词不再自动弹，
	// 仅快捷键 / 托盘 / 设置页的手动「立即取词」触发（2s 内的 selection）才弹
	if (!settings.autoPopup && now - lastManualCaptureAt > 2000) {
		lastSelection = text;
		lastSelectionAt = now;
		console.log("[selection] autoPopup 已关闭，忽略非手动取词");
		return;
	}
	lastSelection = text;
	lastSelectionAt = now;

	// 新选区到来 → 恢复「跟随锚点」模式（用户上一次的拖动位置只对上一轮会话生效）
	overlay.resetUserPosition();

	if (text.length > settings.maxSelectionChars) {
		// 过长：截断并提示（仍可解释，只是内容不完整）
		beginToolbar(text.slice(0, settings.maxSelectionChars), selectionAnchor(ev.x, ev.y, ev.h), ev.app);
		overlay.send(ch("overlay:error"), {
			message: `⚠️ 选区超过 ${settings.maxSelectionChars} 字，已截断为前 ${settings.maxSelectionChars} 字`,
		});
		return;
	}
	beginToolbar(text, selectionAnchor(ev.x, ev.y, ev.h), ev.app);
});

// 设计决策（2026-10-10）：工具条跟随选区生命周期——没有选中时悬浮框关闭。
// 工具条浮出的前提是存在选中文本，选区一旦消失（点击别处、切换应用等）工具条即收起。
// 结果卡片不在此列：它是用户主动点开的工作面板（阅读 / 追问 / 录入中），
// 中途点别处不应打断、也不应丢掉已生成的内容；卡片仍只在点 ✕ 或关闭划词监听时消失。
//
// 收起信号（helper 无改动 → CDHash 不变 → TCC 权限无损）：
//  - cleared：轮询通道发现选区被清空（约 0.4s 粒度，覆盖点击别处/切换应用）
//  - click：无拖拽的短点击落点（毫秒级，补偿 cleared 的轮询延迟；
//    落在悬浮窗外 = 用户点了别处）
//  - noselection：手动取词时系统里没有选中
// 三个信号都经 300ms 延迟合并：双击/三击选词、点别处后立刻重新划词等连续操作
// 会在窗口期内触发新的 selection 事件，从而取消收起（避免工具条闪烁）。

/** 工具条收起延迟器（合并窗口，见上方「设计决策」） */
let toolbarHideTimer: NodeJS.Timeout | null = null;
/** 上一次「窗外点击」的位置与时间（双击检测，见 capture.on("click")） */
let lastOutsideClick: { x: number; y: number; t: number } | null = null;

function cancelPendingToolbarHide(): void {
	if (toolbarHideTimer) {
		clearTimeout(toolbarHideTimer);
		toolbarHideTimer = null;
	}
}

function scheduleToolbarHide(reason: string, delayMs = 300): void {
	// 卡片是主动打开的工作面板，不参与「无选中即关闭」
	if (overlay.getMode() !== "toolbar") return;
	cancelPendingToolbarHide();
	toolbarHideTimer = setTimeout(() => {
		toolbarHideTimer = null;
		if (!overlay.isVisible() || overlay.getMode() !== "toolbar") return;
		overlay.hide();
		console.log(`[overlay] 工具条收起（${reason}）`);
	}, delayMs);
}

capture.on("cleared", () => {
	// 选区被清空 → 工具条跟随关闭
	scheduleToolbarHide("选区已清空");
});

capture.on("click", (ev: ClickEvent) => {
	if (!overlay.isVisible()) return;
	const b = overlay.getBounds();
	if (!b) return;
	// 点击落在悬浮窗内 → 是工具条自身的交互（点按钮等），保持显示并撤销待收起
	const inside = ev.x >= b.x && ev.x <= b.x + b.width && ev.y >= b.y && ev.y <= b.y + b.height;
	if (inside) {
		cancelPendingToolbarHide();
		lastOutsideClick = null;
		return;
	}
	// 双击检测：与上一次窗外点击在时间（系统双击间隔 500ms）与位置（8px）上接近，
	// 说明用户是「双击/三击选词」——选中的文本要等轮询通道约 0.8s 后才上报，
	// 若按第一击就排入收起，工具条会先消失再出现地闪一下。因此把收起推迟到
	// 1.5s 后再核实：若确实选中了，selection 事件（beginToolbar）会撤销这次收起；
	// 若在空白处双击（没有产生选中），届时工具条照常关闭。
	const now = Date.now();
	if (
		lastOutsideClick &&
		now - lastOutsideClick.t < 500 &&
		Math.abs(ev.x - lastOutsideClick.x) < 8 &&
		Math.abs(ev.y - lastOutsideClick.y) < 8
	) {
		lastOutsideClick = { x: ev.x, y: ev.y, t: now };
		scheduleToolbarHide("双击后仍无选中", 1500);
		return;
	}
	lastOutsideClick = { x: ev.x, y: ev.y, t: now };
	// 点击别处 → 收起工具条（若紧接着重新划词，selection 事件会取消这次收起）
	scheduleToolbarHide("点击别处");
});

capture.on("noselection", () => {
	// 手动取词（快捷键）没取到文本 → 当前没有选中，收起工具条
	scheduleToolbarHide("取词无选中");
});

// ---------------------------------------------------------------- 区域框选 + OCR

/** 框选过程中的视觉反馈 */
capture.on("region-begin", () => {
	regionOverlay.show();
	regionOverlay.update(null);
});

capture.on("region-update", (r: ScreenRect) => {
	regionOverlay.update(r);
});

capture.on("region-cancel", () => {
	// helper 主动取消（Esc / 兜底超时 / region-abort 回执）→ 收起遮罩、复位状态。
	// 不发错误提示：用户主动取消有 abortRegionSelect 负责提示，这里只做状态收敛。
	regionSelecting = false;
	regionOverlay.hide();
});

capture.on("log", (msg: string) => {
	console.log(`[helper] ${msg}`);
});

function abortRegionSelect(): void {
	if (!regionSelecting) return;
	regionSelecting = false;
	regionOverlay.hide();
	capture.abortRegion();
	overlay.send(ch("overlay:error"), { message: "已取消框选" });
}

/**
 * 框选屏幕区域 → OCR → 作为「selection」喂给分析动作。
 * 这是聊天记录（微信等不暴露 AX 的应用）的分析入口。
 */
async function scanRegionAndAnalyze(actionId?: string): Promise<void> {
	if (regionSelecting) return;
	regionSelecting = true;

	try {
		const rect = await capture.selectRegion();
		regionOverlay.hide();
		regionSelecting = false;

		if (!rect) return; // 用户取消

		// 在选区附近显示"识别中"
		const anchor: OverlayPosition = { x: rect.x + rect.w / 2, y: rect.y + rect.h, h: 0 };
		// 先建立临时会话：OCR 期间渲染层可能发 overlay:resize，
		// 若此时 session 还是上一轮的，sessionAnchor() 会把卡片摆到旧位置
		session = {
			selection: "",
			pos: anchor,
			app: "屏幕区域",
			action: "",
			actionLabel: "",
			messages: [],
			content: "",
			thinking: "",
			running: false,
		};
		overlay.showCard(anchor, 160);
		overlay.send(ch("overlay:state"), {
			mode: "card",
			action: "识别中",
			icon: "scan",
			selection: "正在识别选中区域的文字…",
			provider: "",
			running: true,
			content: "",
			thinking: "",
		});

		const ocr = await capture.ocr(rect);
		if (!ocr.ok) {
			overlay.send(ch("overlay:error"), {
				message: ocr.error || "识别失败（截图需要「屏幕录制」权限）",
			});
			return;
		}
		const text = (ocr.text || "").trim();
		if (!text) {
			overlay.send(ch("overlay:error"), { message: "选中区域没有识别到文字" });
			return;
		}

		// 建立会话：选区内容 = OCR 文本
		session = {
			selection: text,
			pos: anchor,
			app: "屏幕区域",
			action: "",
			actionLabel: "",
			messages: [],
			content: "",
			thinking: "",
			running: false,
		};

		// 切回工具条必须走 showToolbar：只发 state 不会同步主进程侧的 mode，
		// 会导致「点击别处收起」与宽度自适应被当作 card 处理而失效
		overlay.showToolbar(anchor);
		overlay.send(ch("overlay:state"), {
			mode: "toolbar",
			selection: text.slice(0, 200),
			app: "屏幕区域",
			actions: settings.actions.map((a) => ({ id: a.id, label: a.label, icon: a.icon })),
			ocrLineCount: ocr.count,
			ocrMs: ocr.durationMs,
		});

		// 指定动作则直接执行，否则等用户点按钮
		if (actionId) {
			void runAction(actionId);
		}
	} catch (err) {
		regionSelecting = false;
		regionOverlay.hide();
		overlay.send(ch("overlay:error"), { message: (err as Error).message });
	}
}

// click 事件现由 capture.on("click")（划词流程一节）消费：点击工具条外 → 收起工具条；
// 结果卡片不受影响。

/** 权限引导只弹一次（本轮运行内），避免 helper 反复重启时重复打扰 */
let permissionHintShown = false;
/** Dock 点击激活闸：启动 2.5s 内的 activate 不弹窗（见 whenReady） */
let dockActivationAllowed = false;

capture.on("ready", (info: { accessibilityTrusted: boolean; inputMonitoring: boolean; screenRecording: boolean }) => {
	rebuildTrayMenu();
	// 广播给所有窗口：主窗口可能在 helper 就绪前就加载完了，需要补一次状态
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed()) {
			w.webContents.send(ch("overlay:state"), {
				mode: overlay.getMode(),
				captureEnabled,
				accessibilityTrusted: info.accessibilityTrusted,
				inputMonitoring: info.inputMonitoring,
				screenRecording: info.screenRecording,
				helperPath: helperPath(),
			});
		}
	}
	// 启动不主动开主窗口，但划词必需的「辅助功能」缺失时静默弹一次引导页，
	// 否则用户桌面无任何入口提示（托盘图标不够显眼）
	if (!info.accessibilityTrusted && !permissionHintShown && !(mainWindow && mainWindow.isVisible())) {
		permissionHintShown = true;
		createMainWindow({ focus: false });
	}
});

capture.on("unavailable", (msg: string) => {
	overlay.send(ch("overlay:error"), { message: msg });
});

function beginToolbar(text: string, pos: OverlayPosition, appName: string): void {
	// 新的选中回来了 → 撤销「无选中」的待收起（快速 点别处→重划 时不闪烁）
	cancelPendingToolbarHide();
	session = {
		selection: text,
		pos,
		app: appName,
		action: "",
		actionLabel: "",
		messages: [],
		content: "",
		thinking: "",
		running: false,
	};
	overlay.showToolbar(pos);
	overlay.send(ch("overlay:state"), {
		mode: "toolbar",
		selection: text,
		app: appName,
		actions: settings.actions.map((a) => ({ id: a.id, label: a.label, icon: a.icon })),
	});
}

/** 执行动作（解释/翻译/总结） */
async function runAction(actionId: string, customText?: string): Promise<void> {
	const act = settings.actions.find((a) => a.id === actionId) ?? settings.actions[0];
	if (!session) return;
	if (customText !== undefined) session.selection = customText;

	const provider = activeProvider();
	if (!provider) {
		overlay.send(ch("overlay:error"), {
			message: "未找到可用供应商。请确认 Obsidian 里已安装并配置 ai-explainer 插件。",
		});
		return;
	}
	const model = currentModel(provider);

	session.action = act.id;
	session.actionLabel = act.label;
	session.content = "";
	session.thinking = "";
	session.error = undefined;
	session.running = true;
	session.provider = provider;
	session.model = model;
	session.abort = new AbortController();

	const userPrompt = fillTemplate(act.prompt, {
		selection: session.selection,
		targetLang: "简体中文",
		context: "",
		app: session.app,
	});
	session.messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userPrompt },
	];

	overlay.showCard(sessionAnchor(), 300);
	overlay.send(ch("overlay:state"), {
		mode: "card",
		action: act.label,
		icon: act.icon,
		selection: session.selection,
		app: session.app,
		provider: provider.name,
		model,
		running: true,
		content: "",
		thinking: "",
	});

	try {
		await runLlm({
			provider,
			model,
			messages: session.messages,
			onContent: (delta) => {
				if (!session) return;
				session.content += delta;
				overlay.send(ch("overlay:chunk"), { kind: "content", delta });
			},
			onReasoning: (delta) => {
				if (!session) return;
				session.thinking += delta;
				overlay.send(ch("overlay:chunk"), { kind: "thinking", delta });
			},
			signal: session.abort.signal,
		});
		if (!session) return;
		session.running = false;
		session.messages.push({ role: "assistant", content: session.content });
		overlay.send(ch("overlay:done"), {
			content: session.content,
			thinking: session.thinking,
			provider: provider.name,
			model,
		});
		// 生成记录：无论是否录入笔记，输入/输出都留档（主窗口可回看）
		const rec = appendHistory({
			action: act.label,
			actionId: act.id,
			app: session.app || undefined,
			provider: provider.name,
			model,
			selection: session.selection,
			content: session.content,
			thinking: session.thinking || undefined,
		});
		session.historyId = rec.id;
	} catch (err) {
		if (!session) return;
		session.running = false;
		const message = (err as Error).name === "AbortError" ? "已停止" : (err as Error).message;
		session.error = message;
		overlay.send(ch("overlay:error"), { message });
		// 失败也留档（含已生成的部分内容），便于排查
		if (session.content || message !== "已停止") {
			const rec = appendHistory({
				action: act.label,
				actionId: act.id,
				app: session.app || undefined,
				provider: provider.name,
				model,
				selection: session.selection,
				content: session.content,
				thinking: session.thinking || undefined,
				error: message,
			});
			session.historyId = rec.id;
		}
	}
}

/** 追问：基于已有内容继续对话 */
async function runFollowup(question: string): Promise<void> {
	if (!session) return;
	if (session.running) {
		overlay.send(ch("overlay:error"), { message: "正在生成中，请稍候或先停止" });
		return;
	}
	const provider = session.provider ?? activeProvider();
	if (!provider) {
		overlay.send(ch("overlay:error"), { message: "未找到可用供应商" });
		return;
	}
	const model = session.model ?? currentModel(provider);
	session.provider = provider;
	session.model = model;
	session.running = true;
	session.error = undefined;
	session.abort = new AbortController();
	session.messages.push({ role: "user", content: question });

	overlay.send(ch("overlay:state"), { mode: "card", running: true, question });
	// 新一轮回答需要区分渲染：先发一个分隔标记
	overlay.send(ch("overlay:chunk"), { kind: "reset", delta: "" });
	session.content = "";
	session.thinking = "";

	try {
		await runLlm({
			provider,
			model,
			messages: session.messages,
			onContent: (delta) => {
				if (!session) return;
				session.content += delta;
				overlay.send(ch("overlay:chunk"), { kind: "content", delta });
			},
			onReasoning: (delta) => {
				if (!session) return;
				session.thinking += delta;
				overlay.send(ch("overlay:chunk"), { kind: "thinking", delta });
			},
			signal: session.abort.signal,
		});
		if (!session) return;
		session.running = false;
		session.messages.push({ role: "assistant", content: session.content });
		overlay.send(ch("overlay:done"), {
			content: session.content,
			thinking: session.thinking,
			provider: provider.name,
			model,
			question,
		});
		// 生成记录：追问轮次单独一条（question 为输入，content 为输出）
		const rec = appendHistory({
			action: "追问",
			app: session.app || undefined,
			provider: provider.name,
			model,
			selection: session.selection,
			question,
			content: session.content,
			thinking: session.thinking || undefined,
		});
		session.historyId = rec.id;
	} catch (err) {
		if (!session) return;
		session.running = false;
		const message = (err as Error).name === "AbortError" ? "已停止" : (err as Error).message;
		session.error = message;
		overlay.send(ch("overlay:error"), { message });
		if (session.content || message !== "已停止") {
			const rec = appendHistory({
				action: "追问",
				app: session.app || undefined,
				provider: provider.name,
				model,
				selection: session.selection,
				question,
				content: session.content,
				thinking: session.thinking || undefined,
				error: message,
			});
			session.historyId = rec.id;
		}
	}
}

function sessionAnchor(): OverlayPosition {
	return session?.pos ?? { x: 400, y: 300 };
}

/** 录入笔记 */
function saveSession(): { ok: boolean; file?: string; replaced?: boolean; message?: string } {
	if (!session) return { ok: false, message: "没有内容可保存" };
	const content = sanitizeBody(session.content);
	if (!content) return { ok: false, message: "内容为空，无法保存" };
	const v = pickVault(settings.vaultPath || undefined);
	if (!v) return { ok: false, message: "未找到 Obsidian vault，请先在设置里选择" };
	const pluginSettings = loadExplainerSettings(v.path);
	try {
		const res = writeCapture(
			v.path,
			{
				selection: session.selection,
				body: content,
				action: session.actionLabel || "解释",
				sourceApp: session.app || undefined,
				model: session.model ? `${session.provider?.name ?? ""} ${session.model}`.trim() : session.provider?.name,
			},
			{ calloutType: settings.calloutType ?? pluginSettings?.calloutType ?? "note", dir: settings.captureDir }
		);
		// 关联的历史记录回标「已录入」
		if (session.historyId) updateHistory(session.historyId, { saved: true });
		return { ok: true, file: res.file, replaced: res.replaced };
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
	// 划词状态
	ipcMain.handle(ch("capture:status"), () => ({
		enabled: captureEnabled,
		available: capture.available,
		accessibilityTrusted: capture.accessibilityTrusted,
		inputMonitoring: capture.inputMonitoring,
		screenRecording: capture.screenRecording,
		helperPath: helperPath(),
	}));

	ipcMain.handle(ch("capture:toggle"), (_e, payload: { enabled: boolean }) => {
		setCaptureEnabled(!!payload?.enabled);
		return { enabled: captureEnabled };
	});

	ipcMain.handle(ch("capture:request"), () => {
		// 手动取词（设置页按钮）：autoPopup 关闭时也放行本次划词
		lastManualCaptureAt = Date.now();
		capture.requestCapture();
		return true;
	});

	ipcMain.handle(ch("capture:open-permission"), () => {
		void shell.openExternal(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
		);
		return true;
	});

	ipcMain.handle(ch("capture:open-input-monitoring"), () => {
		void shell.openExternal(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
		);
		return true;
	});

	ipcMain.handle(ch("capture:open-screen-recording"), () => {
		void shell.openExternal(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
		);
		return true;
	});

	// 框选屏幕区域 → OCR → 分析
	ipcMain.handle(ch("capture:scan-region"), (_e, payload: { actionId?: string } = {}) => {
		void scanRegionAndAnalyze(payload?.actionId);
		return true;
	});

	// 悬浮窗
	ipcMain.handle(ch("overlay:action"), (_e, payload: { actionId: string; text?: string }) => {
		void runAction(payload.actionId, payload.text);
		return true;
	});

	ipcMain.handle(ch("overlay:followup"), (_e, payload: { question: string }) => {
		void runFollowup(String(payload?.question ?? "").trim());
		return true;
	});

	ipcMain.handle(ch("overlay:abort"), () => {
		session?.abort?.abort();
		return true;
	});

	ipcMain.handle(ch("overlay:save"), () => saveSession());

	ipcMain.handle(ch("overlay:hide"), () => {
		cancelPendingToolbarHide();
		overlay.setFocusable(false);
		overlay.hide();
		return true;
	});

	// JS 拖动：渲染层上报起止（phase = start | end），跟随在 overlay.drag() 内部
	ipcMain.handle(ch("overlay:drag"), (_e, payload: { phase: string }) => {
		overlay.drag(String(payload?.phase ?? ""));
		return true;
	});

	ipcMain.handle(ch("overlay:resize"), (_e, payload: { height?: number; width?: number }) => {
		// 工具条按内容宽度自适应；卡片按内容高度自适应（两者互斥，由 overlay 内部按 mode 分流）
		if (overlay.getMode() === "toolbar" && payload?.width) {
			overlay.resizeToolbar(Number(payload.width), sessionAnchor());
		} else {
			overlay.resize(Number(payload?.height) || 300, sessionAnchor());
		}
		return true;
	});

	// 追问输入框获得焦点时，临时让悬浮窗可聚焦
	ipcMain.handle(ch("overlay:focus"), (_e, payload: { focusable: boolean }) => {
		overlay.setFocusable(!!payload?.focusable);
		return true;
	});

	ipcMain.handle(ch("overlay:open-main"), () => {
		createMainWindow();
		return true;
	});

	// 配置
	ipcMain.handle(ch("config:vaults"), () => {
		const vaults = listVaults();
		return { vaults, active: pickVault(settings.vaultPath || undefined) };
	});

	ipcMain.handle(ch("config:providers"), () => {
		// 供应商来自本机独立配置（不再依赖 Obsidian vault）
		const store = providerStore();
		const vault = pickVault(settings.vaultPath || undefined);
		return {
			providers: store.providers.map((p) => ({
				...p,
				usable: isUsable(p).ok,
			})),
			activeId: store.activeProviderId,
			activeModel: store.activeModel,
			/** 本机配置路径（UI 展示「配置来源」） */
			storePath: storePath(),
			/** 首次导入来源（仅展示，便于理解数据从哪来） */
			importedFromVault: store.importedFromVault,
			// 以下为笔记写入相关（仍来自 Obsidian，用于「划词记录」等）
			vaultPath: vault?.path ?? null,
			pluginInsertMode: vault ? loadExplainerSettings(vault.path)?.insertMode : undefined,
			pluginCalloutType: vault ? loadExplainerSettings(vault.path)?.calloutType : undefined,
		};
	});

	ipcMain.handle(ch("config:set-provider"), (_e, payload: { id: string }) => {
		// 切换使用中的供应商（写本机配置；preferredProviderId 留作兼容，同步清空避免歧义）
		settings.preferredProviderId = "";
		saveSettings(settings);
		const res = setActiveProvider(String(payload?.id ?? ""));
		rebuildTrayMenu();
		return res;
	});

	ipcMain.handle(ch("config:test-provider"), async (_e, payload: { id: string }) => {
		const store = providerStore();
		const p = store.providers.find((x) => x.id === payload?.id);
		if (!p) return { ok: false, message: "供应商不存在" };
		const started = Date.now();
		try {
			if (p.ptype === "dsweb") {
				const port = p.dswebPort || DEFAULT_DSWEB_PORT;
				const client = await connectDeepSeek(port, settings.dswebHeadless);
				try {
					const login = await checkLogin(client);
					if (!login.loggedIn) return { ok: false, message: "未登录（请点「登录 DeepSeek 网页版」）" };
					return { ok: true, message: `已登录 · ${Date.now() - started}ms` };
				} finally {
					try {
						client.close();
					} catch {
						// 忽略
					}
				}
			}
			let text = "";
			await chatWithFallback(
				{
					baseURL: p.baseURL,
					model: p.models[0],
					apiKey: p.apiKey,
					temperature: 0,
				},
				[{ role: "user", content: "ping" }],
				(chunk) => {
					text += chunk;
				}
			);
			return { ok: true, message: `连通 · ${Date.now() - started}ms` };
		} catch (err) {
			return { ok: false, message: (err as Error).message };
		}
	});

	ipcMain.handle(ch("config:dsweb-login"), async () => {
		const p = activeProvider();
		const port = p?.ptype === "dsweb" ? p.dswebPort || DEFAULT_DSWEB_PORT : DEFAULT_DSWEB_PORT;
		try {
			// 关键：必须在专用浏览器（aie-dsweb-profile）内打开登录页。
			// 旧实现走 shell.openExternal 打开的是系统默认浏览器，登录态写进日常
			// 浏览器 profile，CDP 专用 profile 读不到 → 「登录了但助手仍说未登录」。
			await openLoginPage(port);
			void notifyDswebStatus({ state: "waiting", message: "已在专用浏览器打开登录页，请完成登录" });
			// 补齐供应商条目：本机配置里若没有 ptype=dsweb 的条目，登录成功后
			// 列表里也没有它可选（登录态有效却无处可用）——这里自动补建并切为使用中。
			// 写入本机 providers.json，不碰 Obsidian 插件配置。
			let created = false;
			const res = ensureDswebProvider({ port, activate: true });
			if (res.ok && res.created) {
				created = true;
				rebuildTrayMenu();
				console.log("[dsweb-login] 已自动补建 DeepSeek 网页版供应商并切为使用中");
			} else if (!res.ok) {
				console.error(`[dsweb-login] 补建供应商失败：${res.message}`);
			}
			return {
				ok: true,
				created,
				message: created
					? "已在专用浏览器打开登录页；已自动添加「DeepSeek 网页版」供应商并切为使用中，请在该窗口完成登录"
					: "已在专用浏览器打开登录页，请在该窗口完成登录",
			};
		} catch (err) {
			return { ok: false, message: (err as Error).message };
		}
	});

	// 手动补建 DeepSeek 网页版供应商条目（供应商页在缺条目时提供入口）
	ipcMain.handle(ch("config:add-dsweb-provider"), () => {
		const res = ensureDswebProvider({ port: DEFAULT_DSWEB_PORT, activate: true });
		if (res.ok) {
			rebuildTrayMenu();
			return {
				ok: true,
				created: res.created,
				message: res.created
					? "已添加「DeepSeek 网页版」供应商并切为使用中"
					: "已存在「DeepSeek 网页版」供应商，已切为使用中",
			};
		}
		return res;
	});

	// 供应商增删改（写本机 providers.json，与 Obsidian 配置互不影响）
	ipcMain.handle(ch("config:add-provider"), (_e, payload: NewProviderInput) => {
		const res = addProvider(payload ?? {});
		if (res.ok) {
			rebuildTrayMenu();
			console.log(`[config:add-provider] 已新增供应商 id=${res.id}`);
		}
		return res;
	});

	ipcMain.handle(ch("config:update-provider"), (_e, payload: { id: string } & ProviderPatch) => {
		const { id, ...patch } = payload ?? { id: "" };
		const res = updateProvider(String(id ?? ""), patch);
		if (res.ok) rebuildTrayMenu();
		return res;
	});

	ipcMain.handle(ch("config:delete-provider"), (_e, payload: { id: string }) => {
		const id = String(payload?.id ?? "");
		// 删的是当前指定的优先供应商 → 清掉这个偏好，否则会指向不存在的 id
		if (settings.preferredProviderId === id) {
			settings.preferredProviderId = "";
			saveSettings(settings);
		}
		const res = deleteProvider(id);
		if (res.ok) {
			rebuildTrayMenu();
			console.log(`[config:delete-provider] 已删除供应商 id=${id}`);
		}
		return res;
	});

	ipcMain.handle(ch("config:dsweb-logout"), () => {
		killBrowser();
		void notifyDswebStatus({ state: "logged-out", message: "已关闭专用浏览器" });
		return { ok: true };
	});

	// 登录态探测：后台（headless）连专用浏览器读登录状态并广播。
	// 供设置页「登录网页版」后轮询确认（登录完成 → 提示成功）。
	ipcMain.handle(ch("config:dsweb-status"), async () => {
		const p = activeProvider();
		const port = p?.ptype === "dsweb" ? p.dswebPort || DEFAULT_DSWEB_PORT : DEFAULT_DSWEB_PORT;
		const res = await probeLoginStatus(port);
		const status = res
			? { state: res.loggedIn ? "logged-in" : "logged-out", ok: true }
			: { state: "unknown", ok: false, message: "探测失败（专用浏览器未启动或网络不通）" };
		void notifyDswebStatus(status);
		return status;
	});

	/** 广播 DeepSeek 网页版登录状态到所有窗口 */
	function notifyDswebStatus(status: { state: string; message?: string }): void {
		for (const w of BrowserWindow.getAllWindows()) {
			if (!w.isDestroyed()) {
				w.webContents.send(ch("config:dsweb-status"), status);
			}
		}
	}

	// 应用设置
	ipcMain.handle(ch("settings:get"), () => settings);
	ipcMain.handle(ch("settings:save"), (_e, payload: Partial<AppSettings>) => {
		settings = { ...settings, ...payload };
		saveSettings(settings);
		registerHotkey();
		rebuildTrayMenu();
		// 把注册结果回传：设置页据此提示「被其它应用占用」等（不再静默失败）
		return { ok: true, settings, hotkeys: hotkeyState };
	});

	// 快捷键当前状态（设置页初始化时显示是否注册成功）
	ipcMain.handle(ch("settings:hotkey-state"), () => hotkeyState);

	// 预设动作的默认提示词（供设置页「恢复默认提示词」使用）
	ipcMain.handle(ch("settings:default-actions"), () => DEFAULT_ACTIONS);

	ipcMain.handle(ch("system:pick-vault"), async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openDirectory", "createDirectory"],
			title: "选择 Obsidian vault 目录",
		});
		if (res.canceled || !res.filePaths[0]) return { ok: false };
		settings.vaultPath = res.filePaths[0];
		saveSettings(settings);
		rebuildTrayMenu();
		return { ok: true, path: res.filePaths[0] };
	});

	ipcMain.handle(ch("system:open-external"), (_e, payload: { url: string }) => {
		if (payload?.url) void shell.openExternal(payload.url);
		return true;
	});

	ipcMain.on(ch("system:diag"), (_e, msg) => {
		console.log("[renderer]", msg);
	});

	// 笔记
	ipcMain.handle(ch("notes:list"), () => {
		const v = pickVault(settings.vaultPath || undefined);
		if (!v) return { notes: [] };
		return { notes: listCaptures(v.path, settings.captureDir), vaultPath: v.path };
	});

	ipcMain.handle(ch("notes:read"), (_e, payload: { date: string }) => {
		const v = pickVault(settings.vaultPath || undefined);
		if (!v) return { content: "" };
		return { content: readCapture(v.path, payload.date, settings.captureDir) };
	});

	ipcMain.handle(ch("notes:open"), async (_e, payload: { file?: string; date?: string }) => {
		const v = pickVault(settings.vaultPath || undefined);
		if (!v) return { ok: false };
		let file = payload?.file;
		if (!file && payload?.date) {
			file = path.join(v.path, settings.captureDir, `${payload.date}.md`);
		}
		if (!file || !fs.existsSync(file)) return { ok: false, message: "文件不存在" };
		await shell.openPath(file);
		return { ok: true };
	});

	// 生成记录（本机历史：每次生成的输入/输出都留档，主窗口可回看）
	ipcMain.handle(ch("history:list"), (_e, payload: { limit?: number } = {}) => {
		return { records: listHistory(Number(payload?.limit) || 300) };
	});

	ipcMain.handle(ch("history:get"), (_e, payload: { id: string }) => {
		const rec = getHistory(String(payload?.id ?? ""));
		return rec ?? null;
	});

	ipcMain.handle(ch("history:delete"), (_e, payload: { id: string }) => {
		return { ok: deleteHistory(String(payload?.id ?? "")) };
	});

	ipcMain.handle(ch("history:clear"), () => {
		return { ok: true, deleted: clearHistory() };
	});
}

// ---------------------------------------------------------------- 快捷键

export interface HotkeyState {
	/** 取词快捷键当前值（空 = 未设置） */
	capture: string;
	/** 框选快捷键当前值 */
	scan: string;
	/** 取词快捷键是否注册成功（未设置时为 true，表示「无需注册」） */
	captureOk: boolean;
	scanOk: boolean;
	/** 注册失败原因（如被占用 / 格式非法） */
	captureError?: string;
	scanError?: string;
}

/** 最近一次快捷键注册结果（设置页据此提示「被占用」等） */
let hotkeyState: HotkeyState = { capture: "", scan: "", captureOk: true, scanOk: true };

function registerHotkey(): void {
	globalShortcut.unregisterAll();
	hotkeyState = {
		capture: settings.hotkeyCapture || "",
		scan: settings.hotkeyScan || "",
		captureOk: true,
		scanOk: true,
	};
	/** 注册单个快捷键；返回是否成功。失败原因（被占用/格式错误）必须可见 —— 之前静默吞掉导致「重启后不能用」无从排查 */
	const registerOne = (accelerator: string, action: () => void, label: string): { ok: boolean; error?: string } => {
		if (!accelerator) return { ok: true };
		try {
			// globalShortcut.register 返回 false 表示被其它 app 占用或格式非法，不抛异常
			const ok = globalShortcut.register(accelerator, action);
			if (!ok) {
				const error = "已被其它应用占用（或格式不支持），请换一个组合";
				console.error(`[hotkey] 注册失败：${accelerator}（${label}）—— ${error}`);
				overlay.send(ch("overlay:error"), {
					message: `⚠️ 快捷键 ${accelerator} 注册失败（${error}）`,
				});
				return { ok: false, error };
			}
			console.log(`[hotkey] 已注册：${accelerator}（${label}）`);
			return { ok: true };
		} catch (err) {
			const error = (err as Error).message;
			console.error(`[hotkey] 注册异常：${accelerator}（${label}）：${error}`);
			return { ok: false, error };
		}
	};
	const cap = registerOne(
		settings.hotkeyCapture,
		() => {
			// 手动取词：autoPopup 关闭时也放行本次划词（见 capture.on("selection")）
			lastManualCaptureAt = Date.now();
			capture.requestCapture();
		},
		"立即取词"
	);
	hotkeyState.captureOk = cap.ok;
	hotkeyState.captureError = cap.error;
	const scan = registerOne(settings.hotkeyScan, () => void scanRegionAndAnalyze(), "框选分析");
	hotkeyState.scanOk = scan.ok;
	hotkeyState.scanError = scan.error;
}

// ---------------------------------------------------------------- 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		console.log("[lifecycle] 检测到第二个实例启动 → 唤起已有实例主窗口");
		createMainWindow();
	});

	// 退出流程必须放行 overlay 的 close 拦截，否则 app.quit() 会被整体取消：
	// 用户点「退出」后进程残留（幽灵状态），再次启动会命中单实例锁、
	// 实际仍由旧进程响应 —— 表现为「重启/重装后还是不能用」。
	app.on("before-quit", () => {
		overlay.allowClose();
	});

	app.whenReady().then(() => {
		console.log(`[lifecycle] app 就绪，版本=${app.getVersion()}，userData=${app.getPath("userData")}`);
		applyDevDockIcon();
		// 首次运行：把 Obsidian 插件里已有的供应商导入一份作为起点（只读插件配置，不写）
		// 之后两边完全独立；没有 vault 或没有供应商时跳过，用户可直接在供应商页新增。
		try {
			const v = pickVault(settings.vaultPath || undefined);
			const r = ensureImported(v?.path);
			if (r.imported) console.log(`[lifecycle] 已从 Obsidian 导入 ${r.count} 个供应商（本机独立配置）`);
		} catch (err) {
			console.error(`[lifecycle] 首次导入失败（不影响使用）：${(err as Error).message}`);
		}
		registerIpc();
		createTray();
		capture.start();
		registerHotkey();
		// 启动不再自动弹出主窗口：后台常驻 + 托盘交互。
		// 仅当「辅助功能」未授权（划词必需）时，等 helper 上报后在 capture.on("ready")
		// 里静默弹一次引导，其余情况用户主动从托盘 / Dock 打开。
		setTimeout(() => {
			dockActivationAllowed = true;
		}, 2500);
	});

	// Dock 图标点击（应用已运行时）→ 打开主窗口。
	// 注意：启动瞬间 macOS 也会触发一次 activate，不能弹窗（后台常驻原则），
	// 用时间闸区分「启动时的激活」与「用户主动点击」。
	app.on("activate", () => {
		if (!dockActivationAllowed) return;
		createMainWindow();
	});

	app.on("will-quit", () => {
		console.log("[lifecycle] will-quit：注销快捷键、停止 helper");
		globalShortcut.unregisterAll();
		capture.stop();
	});

	app.on("window-all-closed", () => {
		// 托盘常驻：不退出
	});
}
