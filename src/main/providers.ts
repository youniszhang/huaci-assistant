/**
 * 桌面端自己的供应商存储（不再依赖 Obsidian 插件配置）。
 *
 * 背景：早期实现把供应商配置读写到 `<vault>/.obsidian/plugins/ai-explainer/data.json`，
 * 带来两个问题：
 *   1. 没有 Obsidian vault 就完全无法新增/使用供应商（「未找到 Obsidian vault」）
 *   2. 与插件配置互相影响：桌面端改一个 Key，Obsidian 里也跟着变（反之亦然）
 * 现在改为：**桌面端自己一份 providers.json**，增删改只影响本机这份配置。
 *
 * 存储：`<userData>/providers.json`
 *   { providers: [...], activeProviderId, activeModel, importedFromVault?: string }
 *
 * 与 Obsidian 的关系：仅在**首次运行**时做一次性导入（把插件里已有的供应商
 * 复制一份作为起点，省得重填），之后两边完全独立。导入只读插件配置，不写。
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { ProviderConfig, ResolvedProvider, AiExplainerSettings } from "./llm/types";
import { explainerDataPath, loadExplainerSettings } from "./obsidian";

export interface ProviderStore {
	providers: ProviderConfig[];
	activeProviderId: string;
	activeModel: string;
	/** 首次导入来源（仅记录，便于排查；不影响行为） */
	importedFromVault?: string;
	/** 导入时间（epoch ms） */
	importedAt?: number;
}

/** DeepSeek 网页版默认模型名 */
const DSWEB_DEFAULT_MODELS = ["DeepSeek-V4-Pro（专家模式）", "DeepSeek-V4-Flash（快速模式）"];
export const DSWEB_BASE_URL = "https://chat.deepseek.com";
/** 桌面端独立端口（Obsidian 插件用 9223，两边互不影响） */
export const DSWEB_DEFAULT_PORT = 9224;

function storeFile(): string {
	return path.join(app.getPath("userData"), "providers.json");
}

const EMPTY: ProviderStore = { providers: [], activeProviderId: "", activeModel: "" };

/** 读取本机供应商配置（文件不存在时返回空，由 ensureImported 负责首次导入） */
export function loadStore(): ProviderStore {
	const file = storeFile();
	if (!fs.existsSync(file)) return { ...EMPTY, providers: [] };
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProviderStore>;
		return {
			providers: Array.isArray(raw.providers) ? raw.providers.filter(Boolean) : [],
			activeProviderId: String(raw.activeProviderId ?? ""),
			activeModel: String(raw.activeModel ?? ""),
			importedFromVault: raw.importedFromVault,
			importedAt: raw.importedAt,
		};
	} catch (err) {
		console.error(`[providers] providers.json 解析失败，按空配置处理：${(err as Error).message}`);
		return { ...EMPTY, providers: [] };
	}
}

/** 原子写回（临时文件 + rename），并备份上一次内容 */
export function saveStore(store: ProviderStore): { ok: boolean; message?: string } {
	const file = storeFile();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
		} catch {
			// 备份失败不阻断写入
		}
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
		fs.renameSync(tmp, file);
		return { ok: true };
	} catch (err) {
		return { ok: false, message: `写入 providers.json 失败：${(err as Error).message}` };
	}
}

/**
 * 首次运行导入：本机还没有 providers.json 时，从 Obsidian 插件配置复制一份作为起点。
 * 只读不写插件配置；之后两边互不影响。已导入过（文件存在）则跳过。
 *
 * 导入时会改写 dsweb 条目的端口为桌面端默认端口（9224）——插件的 data.json
 * 里通常写的是 9223，沿用会与插件抢同一个浏览器实例，破坏「两边独立」。
 */
export function ensureImported(vaultPath?: string): { imported: boolean; count: number } {
	const file = storeFile();
	if (fs.existsSync(file)) return { imported: false, count: 0 };
	if (!vaultPath) return { imported: false, count: 0 };
	const s = loadExplainerSettings(vaultPath);
	if (!s) return { imported: false, count: 0 };
	const providers = (s.providers ?? [])
		.filter(Boolean)
		.map((p) => {
			const copy = { ...p };
			// 网页版：换成桌面端自己的端口，避免与插件共用同一浏览器实例
			// （插件的 data.json 里通常是 9223；沿用会破坏「两边独立」）
			if (copy.ptype === "dsweb") copy.dswebPort = DSWEB_DEFAULT_PORT;
			return copy;
		});
	if (!providers.length) return { imported: false, count: 0 };
	const active =
		providers.find((p) => p.id === s.activeProviderId && p.enabled) ??
		providers.find((p) => p.enabled) ??
		providers[0];
	const store: ProviderStore = {
		providers,
		activeProviderId: active?.id ?? "",
		activeModel: s.activeModel || active?.models?.[0] || "",
		importedFromVault: vaultPath,
		importedAt: Date.now(),
	};
	const res = saveStore(store);
	if (res.ok) {
		console.log(`[providers] 首次导入 ${providers.length} 个供应商（来源：${vaultPath}）`);
	}
	return { imported: res.ok, count: providers.length };
}

/** 当前生效的供应商 */
export function activeOf(store: ProviderStore): ResolvedProvider | null {
	const list = store.providers.filter(Boolean);
	if (!list.length) return null;
	const byId = store.activeProviderId ? list.find((p) => p.id === store.activeProviderId && p.enabled) : undefined;
	const firstEnabled = list.find((p) => p.enabled);
	const chosen = byId ?? firstEnabled ?? list[0];
	return { ...chosen };
}

/** 生成供应商 id */
function genId(): string {
	return "p" + Math.random().toString(36).slice(2, 9);
}

/** baseURL 规范化（补 https、去尾斜杠） */
export function normalizeURL(url: string): string {
	let u = String(url || "").trim();
	if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
	return u.replace(/\/+$/, "");
}

/** 模型输入规整（数组 / 逗号 / 中文逗号 / 分号 / 换行） */
export function parseModels(input: string[] | string | undefined): string[] {
	if (Array.isArray(input)) return input.map((m) => String(m).trim()).filter(Boolean);
	return String(input ?? "")
		.split(/[\n,，;；]/)
		.map((m) => m.trim())
		.filter(Boolean);
}

export interface StoreWriteResult {
	ok: boolean;
	id?: string;
	created?: boolean;
	message?: string;
}

export interface NewProviderInput {
	name?: string;
	baseURL?: string;
	apiKey?: string;
	models?: string[] | string;
	ptype?: "api" | "dsweb";
	activate?: boolean;
	dswebPort?: number;
	expertMode?: boolean;
	webSearch?: boolean;
	vision?: boolean;
}

/** 新增供应商（写入本机 providers.json） */
export function addProvider(input: NewProviderInput): StoreWriteResult {
	const ptype = input.ptype === "dsweb" ? "dsweb" : "api";
	const models = parseModels(input.models);
	const name = String(input.name || "").trim();
	if (ptype === "api") {
		if (!String(input.baseURL || "").trim()) return { ok: false, message: "请填写 Base URL（中转站地址）" };
		if (!models.length) return { ok: false, message: "请至少填写一个模型名" };
	}
	if (ptype === "dsweb" && !models.length) models.push(...DSWEB_DEFAULT_MODELS);

	const store = loadStore();
	const prov: ProviderConfig = {
		id: genId(),
		name: name || (ptype === "dsweb" ? "DeepSeek 网页版" : "新供应商"),
		baseURL: ptype === "dsweb" ? normalizeURL(input.baseURL || DSWEB_BASE_URL) : normalizeURL(input.baseURL || ""),
		apiKey: String(input.apiKey || "").trim(),
		models,
		enabled: true,
		ptype,
	};
	if (ptype === "dsweb") {
		prov.vision = input.vision !== false;
		prov.dswebPort = Number(input.dswebPort) || DSWEB_DEFAULT_PORT;
		prov.expertMode = input.expertMode !== false;
		prov.webSearch = !!input.webSearch;
	} else if (input.vision) {
		prov.vision = true;
	}
	store.providers.push(prov);
	if (input.activate !== false) {
		store.activeProviderId = prov.id;
		store.activeModel = prov.models[0];
	}
	const res = saveStore(store);
	if (!res.ok) return { ok: false, message: res.message };
	console.log(`[providers] 已新增 ${prov.name}（${prov.ptype}，id=${prov.id}）`);
	return { ok: true, id: prov.id, created: true };
}

export interface ProviderPatch {
	name?: string;
	baseURL?: string;
	apiKey?: string;
	models?: string[] | string;
	enabled?: boolean;
	ptype?: "api" | "dsweb";
	dswebPort?: number;
	expertMode?: boolean;
	webSearch?: boolean;
	vision?: boolean;
}

/** 更新供应商 */
export function updateProvider(id: string, patch: ProviderPatch): StoreWriteResult {
	if (!id) return { ok: false, message: "缺少供应商 id" };
	const store = loadStore();
	const idx = store.providers.findIndex((p) => p?.id === id);
	if (idx === -1) return { ok: false, message: "供应商不存在（可能已被删除）" };
	const cur = store.providers[idx];
	const next: ProviderConfig = { ...cur };
	if (patch.name !== undefined) next.name = String(patch.name).trim() || cur.name;
	if (patch.baseURL !== undefined) next.baseURL = normalizeURL(patch.baseURL);
	if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey).trim();
	if (patch.models !== undefined) next.models = parseModels(patch.models);
	if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
	if (patch.ptype !== undefined) next.ptype = patch.ptype === "dsweb" ? "dsweb" : "api";
	if (patch.dswebPort !== undefined) next.dswebPort = Number(patch.dswebPort) || DSWEB_DEFAULT_PORT;
	if (patch.expertMode !== undefined) next.expertMode = !!patch.expertMode;
	if (patch.webSearch !== undefined) next.webSearch = !!patch.webSearch;
	if (patch.vision !== undefined) next.vision = !!patch.vision;
	if (next.ptype === "api") {
		if (!next.baseURL?.trim()) return { ok: false, message: "Base URL 不能为空" };
		if (!next.models?.length) return { ok: false, message: "至少保留一个模型名" };
	}
	store.providers[idx] = next;
	if (store.activeProviderId === id && next.models?.length && !next.models.includes(store.activeModel)) {
		store.activeModel = next.models[0];
	}
	const res = saveStore(store);
	if (!res.ok) return { ok: false, message: res.message };
	console.log(`[providers] 已更新 ${next.name}（id=${id}）`);
	return { ok: true, id, created: false };
}

/** 删除供应商（删使用中的自动切到其它可用项） */
export function deleteProvider(id: string): StoreWriteResult {
	if (!id) return { ok: false, message: "缺少供应商 id" };
	const store = loadStore();
	const idx = store.providers.findIndex((p) => p?.id === id);
	if (idx === -1) return { ok: false, message: "供应商不存在（可能已被删除）" };
	const [removed] = store.providers.splice(idx, 1);
	if (store.activeProviderId === id) {
		const next = store.providers.find((p) => p?.enabled) ?? store.providers[0];
		store.activeProviderId = next?.id ?? "";
		store.activeModel = next?.models?.[0] ?? "";
	}
	const res = saveStore(store);
	if (!res.ok) return { ok: false, message: res.message };
	console.log(`[providers] 已删除 ${removed?.name ?? id}（id=${id}）`);
	return { ok: true, id, created: false };
}

/** 切换使用中的供应商 */
export function setActive(id: string, model?: string): StoreWriteResult {
	const store = loadStore();
	if (id && !store.providers.some((p) => p.id === id)) {
		return { ok: false, message: "供应商不存在" };
	}
	store.activeProviderId = id;
	const hit = store.providers.find((p) => p.id === id);
	store.activeModel = model || hit?.models?.[0] || "";
	const res = saveStore(store);
	return res.ok ? { ok: true, id } : { ok: false, message: res.message };
}

/**
 * 确保存在一个 DeepSeek 网页版条目（登录流程用）。
 * 已有则返回其 id（并可切换为使用中），没有则新建。
 */
export function ensureDswebProvider(opts: { port?: number; activate?: boolean } = {}): StoreWriteResult {
	const store = loadStore();
	const existing = store.providers.find((p) => p?.ptype === "dsweb");
	if (existing?.id) {
		if (opts.activate !== false && store.activeProviderId !== existing.id) {
			store.activeProviderId = existing.id;
			store.activeModel = existing.models?.[0] ?? DSWEB_DEFAULT_MODELS[0];
			saveStore(store);
		}
		return { ok: true, id: existing.id, created: false };
	}
	return addProvider({ ptype: "dsweb", dswebPort: opts.port ?? DSWEB_DEFAULT_PORT, activate: opts.activate !== false });
}

/** 是否可用（dsweb 免 Key） */
export function isUsable(p: ProviderConfig): { ok: boolean; reason?: string } {
	if (!p.enabled) return { ok: false, reason: "已禁用" };
	if (p.ptype === "dsweb") return { ok: true };
	if (!p.baseURL?.trim()) return { ok: false, reason: "缺少 Base URL" };
	if (!p.apiKey?.trim()) return { ok: false, reason: "缺少 API Key" };
	if (!(p.models?.length > 0)) return { ok: false, reason: "未配置模型" };
	return { ok: true };
}

/** 配置来源说明（UI 展示用） */
export function storePath(): string {
	return storeFile();
}

/** 兼容旧调用的占位（供应商已独立，不再需要 vault） */
export function vaultDataPath(vaultPath: string): string {
	return explainerDataPath(vaultPath);
}
export type { AiExplainerSettings };
