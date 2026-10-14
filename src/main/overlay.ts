/**
 * 悬浮窗管理：豆包式划词工具条 + 结果卡片。
 *
 * 关键点：
 *  - frame:false + transparent + alwaysOnTop('screen-saver') + 默认 focusable:false
 *    → 弹出时不抢焦点，用户仍可继续在原 app 里操作（豆包的体验核心）
 *  - 追问时临时 setFocusable(true) 让输入框可打字，隐藏前恢复
 *  - showInactive() 显示而不激活
 */

import { BrowserWindow, screen, shell } from "electron";
import * as path from "path";

export type OverlayMode = "toolbar" | "card";

export interface OverlayPosition {
	/** 左上原点 x（锚点水平中心） */
	x: number;
	/** 左上原点 y（工具条摆在这一行的下方；放不下则上方） */
	y: number;
	/** 兼容字段：helper 现在直接给出"下缘 y"，此值恒为 0 */
	h?: number;
}

const TOOLBAR_W = 320;
const TOOLBAR_H = 56;
/** 工具条宽度按内容自适应（动作项数量随用户配置变化），以下为收敛边界 */
const TOOLBAR_MIN_W = 220;
const TOOLBAR_MAX_W = 620;
const CARD_W = 460;
const CARD_H = 420;
/** 划词位置与卡片左上角的偏移（避开选区，避免遮挡） */
const GAP = 14;

export class OverlayWindow {
	private win: BrowserWindow | null = null;
	private mode: OverlayMode = "toolbar";
	private focusedForInput = false;
	/** 工具条当前宽度（随动作项内容自适应，见 resizeToolbar） */
	private toolbarWidth = TOOLBAR_W;
	/** 页面是否加载完成（未完成时的 send 会丢失，需排队） */
	private ready = false;
	private pending: { channel: string; payload: unknown }[] = [];
	/** 应用是否正在退出：退出流程中必须放行 close，否则会阻断 app.quit() */
	private quitting = false;
	/** 用户是否手动拖动过悬浮窗（拖动后 resize/重定位不再拽回锚点） */
	private userMoved = false;
	/** 鼠标是否悬停在悬浮窗内（悬停时临时可聚焦，见 setInteractive） */
	private interactive = false;
	/** 拖动跟随定时器（JS 拖动，见 drag()） */
	private dragTimer: NodeJS.Timeout | null = null;
	private dragOffset = { x: 0, y: 0 };
	/** 拖动结束时间（用于抑制拖动引发的 selection 重发，见 isDragging） */
	private dragEndedAt = 0;

	/** 由 main 在 before-quit 时调用，解除 close 拦截，保证能正常退出 */
	allowClose(): void {
		this.quitting = true;
	}

	// ------------------------------------------------------------ 拖动
	//
	// 不用 -webkit-app-region：透明 + focusable:false 的窗口上该机制行为不稳定，
	// 且 drag 区域会吞掉子元素点击（曾直接导致卡片 ✕ 按钮失灵）。
	// 改为 JS 拖动：渲染层 mousedown/mouseup 通知起止，主进程以 16ms 跟随光标移动窗口。

	/** 渲染层调用：phase = start | end */
	drag(phase: string): void {
		const win = this.window;
		if (!win) return;
		if (phase === "start") {
			const cursor = screen.getCursorScreenPoint();
			const b = win.getBounds();
			this.dragOffset = { x: cursor.x - b.x, y: cursor.y - b.y };
			if (this.dragTimer) clearInterval(this.dragTimer);
			this.dragTimer = setInterval(() => {
				const w = this.window;
				if (!w || !w.isVisible()) {
					this.stopDragTimer();
					return;
				}
				const c = screen.getCursorScreenPoint();
				w.setPosition(Math.round(c.x - this.dragOffset.x), Math.round(c.y - this.dragOffset.y));
			}, 16);
			// 兜底：mouseup 丢失（极端情况）时最多拖动 30s 自动停
			setTimeout(() => {
				if (this.dragTimer) this.stopDragTimer();
			}, 30_000);
		} else {
			this.stopDragTimer();
			this.userMoved = true;
			this.dragEndedAt = Date.now();
		}
	}

	private stopDragTimer(): void {
		if (this.dragTimer) {
			clearInterval(this.dragTimer);
			this.dragTimer = null;
		}
	}

	/**
	 * 是否正在拖动（含结束后的 600ms 冷却）。
	 * 拖动窗口时 helper 会把鼠标拖拽当作「重新划词」，80ms 后重发上一次的
	 * selection，导致工具条被拽回选区锚点 —— main 用此方法抑制这些重发。
	 */
	isDragging(): boolean {
		return !!this.dragTimer || Date.now() - this.dragEndedAt < 600;
	}

	/** 新选区/新会话到来时调用：恢复「跟随锚点」模式 */
	resetUserPosition(): void {
		this.userMoved = false;
	}

	create(): BrowserWindow {
		if (this.win && !this.win.isDestroyed()) return this.win;
		this.ready = false;
		this.win = new BrowserWindow({
			width: TOOLBAR_W,
			height: TOOLBAR_H,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			// movable:true —— JS 拖动依赖 setPosition；macOS 下 movable:false 会直接忽略 setPosition
			movable: true,
			fullscreenable: false,
			skipTaskbar: true,
			hasShadow: false,
			acceptFirstMouse: true,
			alwaysOnTop: true,
			focusable: false,
			webPreferences: {
				preload: path.join(__dirname, "..", "preload", "preload.js"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
				backgroundThrottling: false,
			},
		});
		this.win.setAlwaysOnTop(true, "screen-saver");
		this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		this.win.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
		// 页面就绪后再冲刷排队的消息，避免渲染层还没注册监听就 send 导致丢失
		this.win.webContents.on("did-finish-load", () => {
			this.ready = true;
			const queued = this.pending.splice(0);
			for (const q of queued) {
				this.win?.webContents.send(q.channel, q.payload);
			}
		});
		this.win.on("closed", () => {
			this.win = null;
			this.ready = false;
		});
		// 防止用户意外关闭（但退出流程必须放行，否则 app.quit() 被永久阻断，
		// 会造成「点退出没反应、旧进程残留 → 看起来重启后失效」）
		this.win.on("close", (e) => {
			if (this.quitting) return;
			if (!this.win?.isDestroyed()) {
				e.preventDefault();
				this.win?.hide();
			}
		});
		return this.win;
	}

	private get window(): BrowserWindow | null {
		if (!this.win || this.win.isDestroyed()) return null;
		return this.win;
	}

	/**
	 * 把窗口摆到锚点附近，并做屏幕边界收敛。
	 * pos 为**左上原点**坐标，语义：工具条应出现在 (x, y) 这一点的下方。
	 * 下方空间不足则放到上方。
	 *
	 * 用户手动拖动过（userMoved）时忽略锚点：只调整尺寸、保持用户放的位置。
	 * 否则每次宽度/高度自适应都会把窗口拽回选区旁，拖了等于白拖。
	 */
	private placeAt(pos: OverlayPosition, w: number, h: number): void {
		const win = this.window;
		if (!win) return;
		if (this.userMoved) {
			const b = win.getBounds();
			// 保持用户位置；仍做屏幕边界收敛（防止拖到边缘后 resize 导致部分不可见）
			const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
			const wa = display.workArea;
			const x = Math.min(Math.max(b.x, wa.x + 4), wa.x + wa.width - w - 4);
			const y = Math.min(Math.max(b.y, wa.y + 4), wa.y + wa.height - h - 4);
			if (b.x !== x || b.y !== y || b.width !== w || b.height !== h) {
				win.setBounds({ x, y, width: w, height: h });
			}
			return;
		}
		const display = screen.getDisplayNearestPoint({ x: Math.round(pos.x), y: Math.round(pos.y) });
		const wa = display.workArea;

		let x = Math.round(pos.x - w / 2);
		const yBelow = Math.round(pos.y + GAP);
		const yAbove = Math.round(pos.y - h - GAP);

		let y: number;
		if (yBelow + h <= wa.y + wa.height - 4) {
			y = yBelow; // 下方放得下
		} else if (yAbove >= wa.y + 4) {
			y = yAbove; // 下方出界 → 放上方
		} else {
			y = Math.min(Math.max(yBelow, wa.y + 4), wa.y + wa.height - h - 4);
		}
		x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - w - 4);
		y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 4);
		win.setBounds({ x, y, width: w, height: h });
	}

	showToolbar(pos: OverlayPosition): void {
		const win = this.create();
		this.mode = "toolbar";
		this.setFocusable(false);
		this.interactive = false;
		this.placeAt(pos, this.toolbarWidth, TOOLBAR_H);
		win.webContents.send("overlay:state", { mode: "toolbar" });
		if (!win.isVisible()) win.showInactive();
		else win.showInactive();
	}

	/**
	 * 工具条宽度自适应（渲染层量出内容宽度后调用）。
	 * 动作项数量由用户配置决定，固定宽度会裁掉靠右的动作。
	 */
	resizeToolbar(width: number, anchor?: OverlayPosition): void {
		const win = this.window;
		if (!win || this.mode !== "toolbar") return;
		const w = Math.max(TOOLBAR_MIN_W, Math.min(Math.round(width), TOOLBAR_MAX_W));
		if (w === this.toolbarWidth && win.getBounds().width === w) return;
		this.toolbarWidth = w;
		const b = win.getBounds();
		const pos: OverlayPosition = anchor ?? { x: b.x + b.width / 2, y: b.y };
		this.placeAt(pos, w, TOOLBAR_H);
	}

	showCard(pos: OverlayPosition, height = CARD_H): void {
		const win = this.create();
		this.mode = "card";
		this.placeAt(pos, CARD_W, Math.min(height, 620));
		if (!win.isVisible()) win.showInactive();
		win.webContents.send("overlay:state", { mode: "card" });
	}

	/** 卡片内容变高/变矮（流式渲染时） */
	resize(height: number, anchor?: OverlayPosition): void {
		const win = this.window;
		if (!win || this.mode !== "card") return;
		const b = win.getBounds();
		const h = Math.max(160, Math.min(Math.round(height), 640));
		if (b.height === h) return;
		const pos: OverlayPosition = anchor ?? { x: b.x + b.width / 2, y: b.y };
		this.placeAt(pos, CARD_W, h);
	}

	/** 追问输入时临时获取焦点 */
	setFocusable(focusable: boolean): void {
		const win = this.window;
		if (!win) return;
		if (focusable === this.focusedForInput) return;
		this.focusedForInput = focusable;
		try {
			win.setFocusable(focusable);
			if (focusable) {
				win.focus();
			}
		} catch {
			// 某些平台/版本不支持，忽略
		}
	}

	/** 当前是否已为「追问输入」临时获取焦点（右键菜单关闭时据此决定是否收回） */
	isInputFocused(): boolean {
		return this.focusedForInput;
	}

	/**
	 * 交互态焦点：鼠标在悬浮窗内时临时可聚焦，移开后释放。
	 *
	 * 为什么需要：窗口默认 focusable:false（为了不抢前台应用焦点）。
	 * 但不可聚焦的窗口**收不到键盘事件** —— 卡片里选中文字后按 ⌘C 毫无反应，
	 * 自绘菜单的点击在部分场景也不稳。这两点都是用户实际反馈的问题。
	 *
	 * 设计取舍：只在鼠标悬停于悬浮窗时获取焦点（用户此时正与它交互，
	 * 抢焦点符合预期）；移开即释放，恢复到「不打扰前台应用」的默认状态。
	 * 追问输入框另有 setFocusable(true) 的显式保持（见其调用点）。
	 */
	setInteractive(focused: boolean): void {
		const win = this.window;
		if (!win) return;
		// 追问输入期间不动（它已持有焦点，且不能因为鼠标移开就失去焦点）
		if (this.focusedForInput) return;
		if (focused === this.interactive) return;
		this.interactive = focused;
		try {
			win.setFocusable(focused);
			// 只设置可聚焦，不主动 focus()：鼠标悬停不等于用户点了它，
			// 主动抢焦点会让「轻轻划过卡片」也打断前台应用输入
		} catch {
			// 某些平台/版本不支持，忽略
		}
	}

	/** 是否处于「鼠标悬停交互」态（用于判断焦点归属） */
	isInteractive(): boolean {
		return this.interactive;
	}

	/** 悬浮窗对应的 BrowserWindow（供右键菜单判断事件来源窗口） */
	getBrowserWindow(): BrowserWindow | null {
		return this.window;
	}

	hide(): void {
		this.setFocusable(false);
		// 隐藏时重置交互态：鼠标悬停标志会残留，导致下次显示时焦点状态不对
		this.interactive = false;
		this.window?.hide();
	}

	isVisible(): boolean {
		return !!this.window?.isVisible();
	}

	getMode(): OverlayMode {
		return this.mode;
	}

	getBounds() {
		return this.window?.getBounds() ?? null;
	}

	send(channel: string, payload: unknown): void {
		const win = this.window;
		if (!win) return;
		// 注意：不在此处 showInactive —— 悬浮窗收起后不得被任何广播
		// （状态同步、错误提示等）重新拉起。需要显示时必须显式调用
		// showToolbar()/showCard()。
		// 页面尚未加载完 → 排队，等 did-finish-load 后冲刷
		if (!this.ready) {
			this.pending.push({ channel, payload });
			// 只保留最近 20 条，防止异常情况堆积
			if (this.pending.length > 20) this.pending.shift();
			return;
		}
		win.webContents.send(channel, payload);
	}

	openExternal(url: string): void {
		void shell.openExternal(url);
	}
}

/**
 * 框选遮罩窗口：覆盖整个屏幕，显示选区矩形与尺寸提示。
 * 点击穿透（不拦截鼠标），真实拖拽由 Swift helper 捕获后回传坐标。
 */
export class RegionOverlay {
	private win: BrowserWindow | null = null;

	constructor(private onCancel?: () => void) {}

	show(): void {
		if (!this.win || this.win.isDestroyed()) {
			const display = screen.getPrimaryDisplay();
			const b = display.bounds;
			this.win = new BrowserWindow({
				x: b.x,
				y: b.y,
				width: b.width,
				height: b.height,
				frame: false,
				transparent: true,
				hasShadow: false,
				resizable: false,
				movable: false,
				skipTaskbar: true,
				fullscreenable: false,
				alwaysOnTop: true,
				focusable: false,
				enableLargerThanScreen: true,
				webPreferences: {
					// 这个窗口是我们自己的纯展示层，直接用 node 集成接收选区坐标
					contextIsolation: false,
					nodeIntegration: true,
					sandbox: false,
				},
			});
			this.win.setAlwaysOnTop(true, "screen-saver");
			this.win.setIgnoreMouseEvents(true, { forward: true });
			this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
			this.win.loadFile(path.join(__dirname, "..", "renderer", "region.html"));
			// Esc 取消（helper 也会上报 cancel，两条路都通）
			this.win.webContents.on("before-input-event", (_e, input) => {
				if (input.key === "Escape") this.onCancel?.();
			});
			// 页面就绪前收到的 update 会被丢弃，这里重发最后一次
			this.win.webContents.on("did-finish-load", () => {
				if (this.lastRect !== undefined) this.update(this.lastRect);
			});
		}
		this.win.showInactive();
	}

	/** 记录最后一次选区，供页面加载完成后重放 */
	private lastRect: { x: number; y: number; w: number; h: number } | null | undefined = undefined;

	/** 更新选区显示（坐标是屏幕绝对坐标，需减去窗口原点） */
	update(rect: { x: number; y: number; w: number; h: number } | null): void {
		this.lastRect = rect;
		const win = this.win;
		if (!win || win.isDestroyed()) return;
		const b = win.getBounds();
		const local = rect
			? { x: rect.x - b.x, y: rect.y - b.y, w: rect.w, h: rect.h }
			: null;
		win.webContents.send("region:update", local);
	}

	hide(): void {
		if (this.win && !this.win.isDestroyed()) this.win.hide();
	}

	destroy(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.destroy();
		}
		this.win = null;
	}
}
