/**
 * Obsidian 配置桥：发现 vault、读取 ai-explainer 插件的 data.json、
 * 解析出与插件完全一致的供应商配置（含迁移逻辑，对齐插件 loadSettings）。
 *
 * 设计要点：每次调用都重读磁盘（文件仅几 KB），
 * 因此在 Obsidian 里改了供应商/Key，桌面助手无需重启即可生效。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AiExplainerSettings, ProviderConfig, ResolvedProvider } from "./llm/types";

/** Obsidian 全局配置：记录所有已打开的 vault */
function obsidianConfigPath(): string {
	return path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
}

export interface VaultInfo {
	path: string;
	name: string;
	/** 该 vault 是否装了 ai-explainer 插件 */
	hasExplainer: boolean;
	/** data.json 是否存在 */
	hasConfig: boolean;
	open?: boolean;
}

/** 列出本机所有已注册的 Obsidian vault（obsidian.json 的 vaults 字段） */
export function listVaults(): VaultInfo[] {
	const cfgPath = obsidianConfigPath();
	if (!fs.existsSync(cfgPath)) return [];
	let raw: { vaults?: Record<string, { path: string; ts?: number; open?: boolean }> };
	try {
		raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	} catch {
		return [];
	}
	const vaults: VaultInfo[] = [];
	for (const v of Object.values(raw.vaults ?? {})) {
		if (!v?.path) continue;
		const dataJson = path.join(v.path, ".obsidian", "plugins", "ai-explainer", "data.json");
		vaults.push({
			path: v.path,
			name: path.basename(v.path),
			hasExplainer: fs.existsSync(path.join(v.path, ".obsidian", "plugins", "ai-explainer")),
			hasConfig: fs.existsSync(dataJson),
			open: v.open,
		});
	}
	// 优先：装了插件且有配置 > 装了插件 > 其他；同档按最近打开时间
	return vaults.sort((a, b) => Number(b.hasConfig) - Number(a.hasConfig) || Number(b.hasExplainer) - Number(a.hasExplainer));
}

export function explainerDataPath(vaultPath: string): string {
	return path.join(vaultPath, ".obsidian", "plugins", "ai-explainer", "data.json");
}

/**
 * 读取插件 data.json 并做迁移（对齐插件 loadSettings / DEFAULT_SETTINGS）：
 *  - providers 为空时，用顶层 baseURL/model/apiKey 造一个供应商
 *  - 按 URL 子串猜测供应商名
 */
export function loadExplainerSettings(vaultPath: string): AiExplainerSettings | null {
	const p = explainerDataPath(vaultPath);
	if (!fs.existsSync(p)) return null;
	let data: Partial<AiExplainerSettings>;
	try {
		data = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
	const settings = { ...data } as AiExplainerSettings;
	if (!Array.isArray(settings.providers)) settings.providers = [];

	// 迁移：providers 为空但顶层有 legacy 三件套
	if (settings.providers.length === 0 && settings.baseURL) {
		const url = String(settings.baseURL);
		const guess =
			url.includes("deepseek") ? "DeepSeek"
			: url.includes("bigmodel") ? "智谱 GLM"
			: url.includes("aitry") ? "aitry"
			: url.includes("moonshot") ? "Kimi"
			: url.includes("openai") ? "OpenAI"
			: "默认供应商";
		settings.providers = [
			{
				id: "p" + Math.random().toString(36).slice(2, 9),
				name: guess,
				baseURL: url,
				apiKey: settings.apiKey ?? "",
				models: settings.model ? [settings.model] : [],
				enabled: true,
				ptype: "api",
			},
		];
	}
	return settings;
}

/** 解析当前生效的供应商（对齐插件 activeProvider 逻辑） */
export function resolveActiveProvider(
	settings: AiExplainerSettings,
	vaultPath?: string
): ResolvedProvider | null {
	const list = (settings.providers ?? []).filter(Boolean);
	if (list.length === 0) return null;
	const byId = settings.activeProviderId
		? list.find((p) => p.id === settings.activeProviderId && p.enabled)
		: undefined;
	const firstEnabled = list.find((p) => p.enabled);
	const chosen = byId ?? firstEnabled ?? list[0];
	return { ...chosen, sourceVault: vaultPath };
}

export interface ProviderBundle {
	vaultPath: string;
	settings: AiExplainerSettings;
	providers: ResolvedProvider[];
	active: ResolvedProvider | null;
}

/** 一次性取出某 vault 的全部供应商 + 当前生效项 */
export function loadProviders(vaultPath: string): ProviderBundle | null {
	const settings = loadExplainerSettings(vaultPath);
	if (!settings) return null;
	const providers = (settings.providers ?? []).map((p) => ({ ...p, sourceVault: vaultPath }));
	return {
		vaultPath,
		settings,
		providers,
		active: resolveActiveProvider(settings, vaultPath),
	};
}

/**
 * 自动挑选 vault：优先用户指定 → 第一个有配置的 vault → null
 */
export function pickVault(preferred?: string): VaultInfo | null {
	const vaults = listVaults();
	if (preferred) {
		const hit = vaults.find((v) => v.path === preferred);
		if (hit) return hit;
	}
	return vaults.find((v) => v.hasConfig) ?? vaults[0] ?? null;
}

/** 判断供应商是否可直接使用（dsweb 不需要 Key） */
export function isProviderUsable(p: ProviderConfig): { ok: boolean; reason?: string } {
	if (!p.enabled) return { ok: false, reason: "已禁用" };
	if (p.ptype === "dsweb") return { ok: true };
	if (!p.baseURL?.trim()) return { ok: false, reason: "缺少 Base URL" };
	if (!p.apiKey?.trim()) return { ok: false, reason: "缺少 API Key" };
	if (!(p.models?.length > 0)) return { ok: false, reason: "未配置模型" };
	return { ok: true };
}
