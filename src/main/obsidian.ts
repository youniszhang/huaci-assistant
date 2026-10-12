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

/** DeepSeek 网页版默认模型名（与插件「添加供应商」时写入的一致） */
const DSWEB_DEFAULT_MODELS = ["DeepSeek-V4-Pro（专家模式）", "DeepSeek-V4-Flash（快速模式）"];
/** 网页版默认地址与端口（与插件一致） */
const DSWEB_BASE_URL = "https://chat.deepseek.com";
const DSWEB_DEFAULT_PORT = 9223;

export interface ProviderWriteResult {
	ok: boolean;
	/** 新建/更新的供应商 id */
	id?: string;
	/** 是否本次新建（false = 已存在 / 仅更新） */
	created?: boolean;
	message?: string;
}

/** 生成供应商 id（与插件 genId 同风格，避免两边混用时分不清） */
function genProviderId(): string {
	return "p" + Math.random().toString(36).slice(2, 9);
}

/** baseURL 规范化（对齐插件 normalizeBaseURL：补 https、去尾部斜杠） */
export function normalizeProviderURL(url: string): string {
	let u = String(url || "").trim();
	if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
	return u.replace(/\/+$/, "");
}

/**
 * 读取 → 修改 → 原子写回插件配置（所有供应商增删改共用）。
 *
 * 安全约束（写的是用户的 Obsidian 配置文件，必须保守）：
 *  - 写入前备份 data.json.bak；写入用「临时文件 + rename」保证原子性
 *  - 只改 providers（及相关 active 字段），其余设置原样保留
 *  - 配置不存在/损坏时拒绝，绝不覆盖
 */
function mutateExplainerSettings(
	vaultPath: string,
	mutate: (raw: Record<string, unknown>, providers: ProviderConfig[]) => ProviderWriteResult
): ProviderWriteResult {
	const file = explainerDataPath(vaultPath);
	if (!fs.existsSync(file)) {
		return { ok: false, message: `未找到插件配置：${file}` };
	}
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return { ok: false, message: `插件配置解析失败：${(err as Error).message}` };
	}
	if (!Array.isArray(raw.providers)) raw.providers = [];
	const providers = raw.providers as ProviderConfig[];

	let result: ProviderWriteResult;
	try {
		result = mutate(raw, providers);
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}
	if (!result.ok) return result;

	try {
		try {
			fs.copyFileSync(file, `${file}.bak`);
		} catch {
			console.error("[obsidian] 备份 data.json 失败，继续写入");
		}
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
		fs.renameSync(tmp, file);
		return result;
	} catch (err) {
		return { ok: false, message: `写入插件配置失败：${(err as Error).message}` };
	}
}

export interface NewProviderInput {
	name?: string;
	/** api 类型必填；dsweb 可留空（用默认地址） */
	baseURL?: string;
	apiKey?: string;
	/** 模型名（数组或逗号/换行分隔的字符串） */
	models?: string[] | string;
	ptype?: "api" | "dsweb";
	/** 新建后是否切为使用中（默认 true） */
	activate?: boolean;
	/** dsweb 专属 */
	dswebPort?: number;
	expertMode?: boolean;
	webSearch?: boolean;
	vision?: boolean;
}

/** 把模型输入规整为数组（支持数组 / 逗号 / 换行分隔） */
export function parseModels(input: string[] | string | undefined): string[] {
	if (Array.isArray(input)) return input.map((m) => String(m).trim()).filter(Boolean);
	return String(input ?? "")
		.split(/[\n,，;；]/)
		.map((m) => m.trim())
		.filter(Boolean);
}

/**
 * 新增供应商（API 中转站 / DeepSeek 网页版都走这里）。
 * 校验对齐插件：api 类型必须有 baseURL 与至少一个模型；dsweb 无需 Key。
 */
export function addProvider(vaultPath: string, input: NewProviderInput): ProviderWriteResult {
	const ptype = input.ptype === "dsweb" ? "dsweb" : "api";
	const models = parseModels(input.models);
	const name = String(input.name || "").trim();

	if (ptype === "api") {
		if (!String(input.baseURL || "").trim()) return { ok: false, message: "请填写 Base URL（中转站地址）" };
		if (!models.length) return { ok: false, message: "请至少填写一个模型名" };
	}
	if (ptype === "dsweb" && !models.length) {
		// 网页版用默认模型名，用户没填也能用
		models.push(...DSWEB_DEFAULT_MODELS);
	}

	const prov: ProviderConfig = {
		id: genProviderId(),
		name: name || (ptype === "dsweb" ? "DeepSeek 网页版" : "新供应商"),
		baseURL: ptype === "dsweb" ? normalizeProviderURL(input.baseURL || DSWEB_BASE_URL) : normalizeProviderURL(input.baseURL || ""),
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

	return mutateExplainerSettings(vaultPath, (raw, providers) => {
		providers.push(prov);
		if (input.activate !== false) {
			raw.activeProviderId = prov.id;
			raw.activeModel = prov.models[0];
		}
		console.log(`[obsidian] 已新增供应商 ${prov.name}（${prov.ptype}，id=${prov.id}）`);
		return { ok: true, id: prov.id, created: true };
	});
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

/** 更新供应商（只改传入的字段） */
export function updateProvider(vaultPath: string, id: string, patch: ProviderPatch): ProviderWriteResult {
	if (!id) return { ok: false, message: "缺少供应商 id" };
	return mutateExplainerSettings(vaultPath, (raw, providers) => {
		const idx = providers.findIndex((p) => p?.id === id);
		if (idx === -1) return { ok: false, message: "供应商不存在（可能已被删除）" };
		const cur = providers[idx];
		const next: ProviderConfig = { ...cur };
		if (patch.name !== undefined) next.name = String(patch.name).trim() || cur.name;
		if (patch.baseURL !== undefined) next.baseURL = normalizeProviderURL(patch.baseURL);
		if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey).trim();
		if (patch.models !== undefined) next.models = parseModels(patch.models);
		if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
		if (patch.ptype !== undefined) next.ptype = patch.ptype === "dsweb" ? "dsweb" : "api";
		if (patch.dswebPort !== undefined) next.dswebPort = Number(patch.dswebPort) || DSWEB_DEFAULT_PORT;
		if (patch.expertMode !== undefined) next.expertMode = !!patch.expertMode;
		if (patch.webSearch !== undefined) next.webSearch = !!patch.webSearch;
		if (patch.vision !== undefined) next.vision = !!patch.vision;
		// api 类型的基本校验（避免把必填项清空导致不可用）
		if (next.ptype === "api") {
			if (!next.baseURL?.trim()) return { ok: false, message: "Base URL 不能为空" };
			if (!next.models?.length) return { ok: false, message: "至少保留一个模型名" };
		}
		providers[idx] = next;
		// 当前使用中的条目被改名/换模型 → 同步 activeModel，避免指向已不存在的模型
		if (raw.activeProviderId === id) {
			const activeModel = String(raw.activeModel ?? "");
			if (next.models?.length && !next.models.includes(activeModel)) {
				raw.activeModel = next.models[0];
			}
		}
		console.log(`[obsidian] 已更新供应商 ${next.name}（id=${id}）`);
		return { ok: true, id, created: false };
	});
}

/**
 * 删除供应商。
 * 若删的是当前使用中的条目 → 自动切到剩下的第一个启用项（对齐插件 deleteProvider），
 * 否则会留下指向不存在 id 的 activeProviderId，表现为「生成时找不到供应商」。
 */
export function deleteProvider(vaultPath: string, id: string): ProviderWriteResult {
	if (!id) return { ok: false, message: "缺少供应商 id" };
	return mutateExplainerSettings(vaultPath, (raw, providers) => {
		const idx = providers.findIndex((p) => p?.id === id);
		if (idx === -1) return { ok: false, message: "供应商不存在（可能已被删除）" };
		const [removed] = providers.splice(idx, 1);
		if (raw.activeProviderId === id) {
			const next = providers.find((p) => p?.enabled) ?? providers[0];
			raw.activeProviderId = next?.id ?? "";
			raw.activeModel = next?.models?.[0] ?? "";
		}
		console.log(`[obsidian] 已删除供应商 ${removed?.name ?? id}（id=${id}）`);
		return { ok: true, id, created: false };
	});
}

/**
 * 确保插件配置里存在一个 DeepSeek 网页版供应商条目。
 *
 * 为什么需要它：供应商列表完全来自插件的 data.json，插件本身没有任何预置
 * 条目（addProvider 只由用户手动触发）。所以新机器上用户点「登录网页版」
 * 登录成功后，配置里若没有 ptype=dsweb 的条目，列表里就没有它可选 ——
 * 登录态有效却无处可用。此函数补齐这个条目，让「登录即可用」成立。
 *
 * 幂等：已有 dsweb 条目（含被禁用的）时只读返回，不改配置。
 */
export function ensureDswebProvider(
	vaultPath: string,
	opts: { port?: number; activate?: boolean } = {}
): ProviderWriteResult {
	return mutateExplainerSettings(vaultPath, (raw, providers) => {
		const existing = providers.find((p) => p?.ptype === "dsweb");
		if (existing?.id) {
			// 已存在 → 不动配置；但若要求激活则切过去（登录后即用）
			if (opts.activate !== false && raw.activeProviderId !== existing.id) {
				raw.activeProviderId = existing.id;
				raw.activeModel = existing.models?.[0] ?? DSWEB_DEFAULT_MODELS[0];
				console.log(`[obsidian] 已切换到既有网页版供应商（id=${existing.id}）`);
				return { ok: true, id: existing.id, created: false };
			}
			return { ok: true, id: existing.id, created: false };
		}
		const prov: ProviderConfig = {
			id: genProviderId(),
			name: "DeepSeek 网页版",
			baseURL: DSWEB_BASE_URL,
			apiKey: "",
			models: [...DSWEB_DEFAULT_MODELS],
			enabled: true,
			ptype: "dsweb",
			vision: true,
			dswebPort: opts.port ?? DSWEB_DEFAULT_PORT,
			expertMode: true,
		};
		providers.push(prov);
		if (opts.activate !== false) {
			raw.activeProviderId = prov.id;
			raw.activeModel = prov.models[0];
		}
		console.log(`[obsidian] 已补建 DeepSeek 网页版供应商（id=${prov.id}）`);
		return { ok: true, id: prov.id, created: true };
	});
}
