/**
 * 与 obsidian-ai-explainer 插件完全兼容的配置类型。
 * 字段定义严格对齐插件 src/main.ts 的 ProviderConfig / AiExplainerSettings，
 * 以便直接读取 vault 里 .obsidian/plugins/ai-explainer/data.json。
 */

export interface ProviderConfig {
	id: string;
	name: string;
	baseURL: string;
	apiKey: string;
	models: string[];
	enabled: boolean;
	/** api = OpenAI 兼容接口；dsweb = DeepSeek 网页版（免 Key，CDP 驱动） */
	ptype?: "api" | "dsweb";
	/** 支持图片识别 */
	vision?: boolean;
	/** dsweb：CDP 调试端口（默认 9223） */
	dswebPort?: number;
	/** dsweb：专家模式（深度思考），默认开 */
	expertMode?: boolean;
	/** dsweb：联网搜索 */
	webSearch?: boolean;
}

export type InsertMode = "collapse" | "footnote" | "callout" | "inline";

/** 插件设置（我们只用其中的供应商相关字段 + 提示词模板） */
export interface AiExplainerSettings {
	baseURL: string;
	model: string;
	apiKey: string;
	explainTemplate: string;
	mergeTemplate: string;
	followupTemplate: string;
	insertMode: InsertMode;
	calloutType: string;
	contextChars: number;
	autoMerge: boolean;
	chatWithContext: boolean;
	providers: ProviderConfig[];
	activeProviderId: string;
	activeModel: string;
	temperature: number;
	[key: string]: unknown;
}

/** 解析后的供应商（含来源信息） */
export interface ResolvedProvider extends ProviderConfig {
	/** 来源 vault 路径，用于 UI 标注 */
	sourceVault?: string;
}

/** dsweb 默认端口（与插件一致，便于复用同一浏览器登录态） */
export const DEFAULT_DSWEB_PORT = 9223;
