/**
 * 应用设置（区别于 Obsidian 侧配置：这里只存桌面助手自己的偏好）
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface AppSettings {
	/** 使用的 vault 路径；空 = 自动挑选第一个装了 ai-explainer 的 vault */
	vaultPath: string;
	/** 优先使用的供应商 id；空 = 跟随 Obsidian 的 activeProviderId */
	preferredProviderId: string;
	/** 记录写入目录（相对 vault） */
	captureDir: string;
	/** callout 类型 */
	calloutType: string;
	/** 划词后是否自动弹出工具条 */
	autoPopup: boolean;
	/** 全局快捷键（Electron accelerator 语法），空 = 不注册 */
	hotkeyCapture: string;
	/** 框选屏幕区域分析的快捷键 */
	hotkeyScan: string;
	/** 结果卡片里显示的快捷动作 */
	actions: ActionDef[];
	/** dsweb 是否后台运行（headless） */
	dswebHeadless: boolean;
	/** 划词长度上限（超过则截断提示） */
	maxSelectionChars: number;
}

export interface ActionDef {
	id: string;
	/** 按钮文案 */
	label: string;
	/** 图标名（对应 renderer/icons.js 里的 SVG 图标） */
	icon: string;
	/** 提示词模板，支持 {{selection}} */
	prompt: string;
}

export const DEFAULT_ACTIONS: ActionDef[] = [
	{
		id: "explain",
		label: "解释",
		icon: "sparkles",
		prompt: `请解释我选中的这段话。

【选中内容】
{{selection}}

输出结构（严格遵守）：
1. 第一行：**用一句话说清这段话的核心含义**（加粗，不加任何前缀）
2. 空一行，然后展开细节：其中出现的专业术语逐个给出**通俗解释**（术语名加粗）
3. 关键词、数字用 **加粗** 标出，便于扫读
4. 需要时给一个例子或类比
5. 用简洁的 Markdown 输出，总长度控制在 250 字以内`,
	},
	{
		id: "translate",
		label: "翻译",
		icon: "languages",
		prompt: `把以下内容翻译成{{targetLang}}，保持原意与语气。

输出结构（严格遵守）：
1. 第一行：**译文**（整句加粗，不加任何前缀说明）
2. 空一行，然后列出 2-3 个**关键词对照**（格式：原文词汇 → 译文，词汇加粗）
3. 如有需要注意的语气/术语，用一句话说明

【待翻译内容】
{{selection}}`,
	},
	{
		id: "summarize",
		label: "总结",
		icon: "alignLeft",
		prompt: `请总结以下内容。

输出结构（严格遵守）：
1. 第一行：**一句话总览**（加粗，说清这段内容在讲什么）
2. 空一行，然后列出**要点**（Markdown 列表，不超过 5 条）
3. 每条要点里的**关键词加粗**
4. 最后如有明确结论或建议，单独一行用 **加粗** 给出；没有就不写

【内容】
{{selection}}`,
	},
	{
		id: "intent",
		label: "意图分析",
		icon: "target",
		// 聊天场景：拆解对方真实意图与决策依据
		prompt: `你在帮我分析一段聊天记录。请站在「我需要理解对方真实意图、并决定如何回应」的立场分析。

【聊天内容（OCR 提取，可能有识别误差，请结合上下文合理推断）】
{{selection}}

输出结构（严格遵守，Markdown）：
1. 第一行：**对方真实意图**（一句话加粗，不是字面意思而是背后诉求）
2. 空一行，然后按以下小节展开（每节标题加粗）：

**关键信息**
列出消息中承载决策依据的事实/数据/时间点，逐条说明对决策的影响。

**潜台词**
对方没有明说但可推断的态度、顾虑或期待；没有明显潜台词就写「无明显潜台词」。

**我的回应建议**
给出 2-3 个可选回应方向，每个方向一句话说明适用场景。

只输出以上内容，不要前言和结尾，总长控制在 400 字内。`,
	},
	{
		id: "reply",
		label: "拟回复",
		icon: "send",
		prompt: `基于以下聊天内容，帮我起草回复。

【聊天内容（OCR 提取，可能有识别误差）】
{{selection}}

输出结构（严格遵守，Markdown）：
1. 第一行：**对方核心诉求与情绪基调**（一句话加粗）
2. 空一行，然后给出 2 个不同风格的回复草稿（各 60 字内）：
   - **稳妥版**：周全、留有余地
   - **直接版**：简洁、给明确结论或时间点
3. 两个草稿都用第一人称，可以直接复制发送；草稿正文用 > 引用块呈现

不要额外解释。`,
	},
];

export const DEFAULT_SETTINGS: AppSettings = {
	vaultPath: "",
	preferredProviderId: "",
	captureDir: path.join("04-日常记录", "AI划词解释"),
	calloutType: "note",
	// 默认不自动弹：划词动作会被大量误触（拖拽选字、双击取词）打扰，
	// 默认改为「选中文字后按快捷键唤起」（hotkeyCapture），设置页可改回自动弹。
	autoPopup: false,
	// 取词快捷键默认 ⌘5（Electron accelerator 语法；显示为 ⌘5）
	hotkeyCapture: "CommandOrControl+5",
	hotkeyScan: "CommandOrControl+Shift+S",
	actions: DEFAULT_ACTIONS,
	dswebHeadless: true,
	maxSelectionChars: 3000,
};

function settingsFile(): string {
	return path.join(app.getPath("userData"), "settings.json");
}

/** 旧版 emoji 图标 → 新 SVG 图标名 的迁移映射 */
const ICON_MIGRATION: Record<string, string> = {
	"✨": "sparkles",
	"🌐": "languages",
	"📝": "alignLeft",
	"📥": "download",
	"📋": "copy",
	"🔁": "refresh",
	"⚡": "wand",
	"💬": "send",
	"📄": "notebook",
	"ℹ️": "info",
};

/** 把老配置里的 emoji 图标名换成新的 SVG 图标名 */
function migrateIcons(actions: ActionDef[]): ActionDef[] {
	return actions.map((a) => ({
		...a,
		icon: ICON_MIGRATION[a.icon] || a.icon,
	}));
}

/**
 * 补齐新增的预设动作。
 * 已存在的 id 不覆盖（用户可能改过提示词），缺失的追加到末尾。
 */
function mergeNewPresets(actions: ActionDef[]): ActionDef[] {
	const have = new Set(actions.map((a) => a.id));
	const missing = DEFAULT_ACTIONS.filter((d) => !have.has(d.id));
	return missing.length ? [...actions, ...missing] : actions;
}

export function loadSettings(): AppSettings {
	const file = settingsFile();
	let data: Partial<AppSettings> = {};
	try {
		if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		data = {};
	}
	const merged: AppSettings = { ...DEFAULT_SETTINGS, ...data };
	// actions 缺 id 时补齐（防御手工改坏）
	if (!Array.isArray(merged.actions) || merged.actions.length === 0) {
		merged.actions = DEFAULT_ACTIONS;
	} else {
		merged.actions = mergeNewPresets(migrateIcons(merged.actions));
	}
	return merged;
}

export function saveSettings(s: AppSettings): void {
	const file = settingsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(s, null, 2), "utf8");
}

/** 填充提示词模板 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}
