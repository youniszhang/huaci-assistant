/**
 * 笔记写入：把 AI 解释结果录入 Obsidian vault。
 *
 * 格式对齐 obsidian-ai-explainer 插件的 collapse/callout 输出：
 *   > [!note]- ✨ 解释：<选区前 26 字>
 *   > 正文…
 *
 * 目标：<vault>/04-日常记录/AI划词解释/YYYY-MM-DD.md（每天一个文件，按时间追加）
 * 同一段文本重复解释 → 通过 djb2 哈希定位并覆盖同条目（与插件 annotationId 算法一致）
 */

import * as fs from "fs";
import * as path from "path";

export interface CaptureEntry {
	/** 选区原文 */
	selection: string;
	/** 解释正文（Markdown） */
	body: string;
	/** 动作标签：解释 / 翻译 / 总结 / 追问 */
	action: string;
	/** 来源应用名（可选） */
	sourceApp?: string;
	/** 来源 URL（可选） */
	sourceUrl?: string;
	/** 供应商/模型标注（可选） */
	model?: string;
}

const DIARY_DIR = path.join("04-日常记录", "AI划词解释");
const DEFAULT_CALLOUT = "note";

/** djb2 哈希 → 与插件 annotationId 完全一致（保证互相识别/覆盖） */
export function annotationId(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return "ai" + h.toString(36);
}

/** 批注标题：压缩空白取前 26 字 */
export function annotationTitle(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 26);
}

/** 清洗 LLM 输出（对齐插件 sanitizeAnnotationBody，防止破坏 Markdown 结构） */
export function sanitizeBody(body: string): string {
	let out = body.trim();
	out = out.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
	out = out.replace(/<br\s*\/?>/gi, "\n");
	// 清理孤立的强调标记：仅处理"行首出现 2 个以上星号且后接冒号/空白"这类空粗体前缀，
	// 不能碰正常的 **粗体** 语法
	out = out.replace(/^\*{2,}\s*([：:])\s*/gm, "$1");
	out = out.replace(/^\*{2,}\s*$/gm, "");
	out = out
		.split("\n")
		.filter((l) => !l.trim().startsWith("> [!") && !/^<!--\s*ai[a-z0-9]*\s*-->$/.test(l.trim()))
		.map((l) => l.replace(/^>\s?/, ""))
		.join("\n");
	out = out
		.split("\n")
		.map((l) => (l.trim().length > 0 && /^[\-=_*~\s]+$/.test(l) ? "" : l))
		.join("\n");
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out;
}

function todayStamp(d = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 生成 callout 块（含 HTML 注释锚点，便于重复解释时定位覆盖） */
export function buildCallout(entry: CaptureEntry, calloutType = DEFAULT_CALLOUT): string {
	const id = annotationId(entry.selection);
	const title = annotationTitle(entry.selection);
	const body = sanitizeBody(entry.body);
	// 头部 title 与插件一致（✨ 前缀 + "解释：" 等）
	const header = `> [!${calloutType}]- ✨ ${entry.action}：${title}`;
	const metaParts: string[] = [];
	if (entry.sourceApp) metaParts.push(`来源：${entry.sourceApp}`);
	if (entry.model) metaParts.push(entry.model);
	const meta = metaParts.length ? `> <sub>${metaParts.join(" · ")}</sub>` : "";
	const bodyLines = body
		.split("\n")
		.map((l) => (l.trim() === "" ? ">" : `> ${l}`));
	return [
		`<!-- ${id} -->`,
		header,
		...bodyLines,
		meta,
	].filter(Boolean).join("\n");
}

/**
 * 定位已存在的同词条 block：
 * 从 HTML 注释锚点行开始，吞掉后续所有引用行（">..."）及其间的空行，
 * 遇到第一个既非引用、又非空的行即结束（或遇到下一个锚点锚点）。
 * 返回 [start, end) 字符区间；未找到返回 null。
 */
function findExistingBlock(content: string, id: string): [number, number] | null {
	const marker = `<!-- ${id} -->`;
	const start = content.indexOf(marker);
	if (start === -1) return null;

	const lines = content.split("\n");
	// 定位 marker 所在行号
	let markerLine = -1;
	let acc = 0;
	for (let i = 0; i < lines.length; i++) {
		if (acc >= start) {
			markerLine = i;
			break;
		}
		acc += lines[i].length + 1;
	}
	if (markerLine === -1) return null;

	// 从 marker 行下一行开始扫描
	let endLine = markerLine + 1;
	let sawQuote = false;
	for (let i = markerLine + 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t.startsWith("<!-- ai")) break; // 下一个条目
		if (t.startsWith(">")) {
			sawQuote = true;
			endLine = i + 1;
			continue;
		}
		if (t === "") {
			if (sawQuote) {
				// 引用块已结束，空行后若还是引用则继续（引用块内部空行写作 ">"，所以这里应停止）
				break;
			}
			endLine = i + 1; // marker 与引用头之间的空行，继续找
			continue;
		}
		break; // 非引用内容 → 块结束
	}

	// 换算为字符区间
	const toOffset = (line: number) => lines.slice(0, line).reduce((s, l) => s + l.length + 1, 0);
	const s = toOffset(markerLine);
	const e = Math.min(toOffset(endLine), content.length);
	return [s, e];
}

export interface WriteResult {
	file: string;
	/** true = 新建了条目；false = 覆盖了已有条目 */
	replaced: boolean;
	created: boolean;
}

/**
 * 写入/覆盖一条划词记录。
 * @param vaultPath  vault 根目录
 * @param entry      记录内容
 * @param opts.calloutType  callout 类型（默认 note，取自插件设置）
 * @param opts.dir    自定义目录（默认 04-日常记录/AI划词解释）
 */
export function writeCapture(
	vaultPath: string,
	entry: CaptureEntry,
	opts: { calloutType?: string; dir?: string; date?: Date } = {}
): WriteResult {
	const dir = path.join(vaultPath, opts.dir ?? DIARY_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const day = todayStamp(opts.date);
	const file = path.join(dir, `${day}.md`);
	const block = buildCallout(entry, opts.calloutType ?? DEFAULT_CALLOUT);
	const id = annotationId(entry.selection);

	let content = "";
	let created = true;
	if (fs.existsSync(file)) {
		content = fs.readFileSync(file, "utf8");
		created = false;
	} else {
		// 新文件：最小 frontmatter（不写 Previous/NextArticle，series-nav 插件会自己注入）
		content = `---\ntype: ai-capture\ncreated: ${day}\n---\n\n# AI 划词记录 ${day}\n`;
	}

	const existing = findExistingBlock(content, id);
	if (existing) {
		const [s, e] = existing;
		content = content.slice(0, s) + block + content.slice(e);
		fs.writeFileSync(file, content.replace(/\n{3,}/g, "\n\n"), "utf8");
		return { file, replaced: true, created };
	}

	// 追加到文件末尾
	const trimmed = content.replace(/\s+$/, "");
	fs.writeFileSync(file, `${trimmed}\n\n${block}\n`, "utf8");
	return { file, replaced: false, created };
}

/** 列出已收集的记录文件（按日期倒序） */
export function listCaptures(vaultPath: string, dir?: string): { date: string; file: string; size: number }[] {
	const d = path.join(vaultPath, dir ?? DIARY_DIR);
	if (!fs.existsSync(d)) return [];
	return fs
		.readdirSync(d)
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
		.sort()
		.reverse()
		.map((f) => {
			const full = path.join(d, f);
			return { date: f.replace(/\.md$/, ""), file: full, size: fs.statSync(full).size };
		});
}

/** 读取某天记录内容 */
export function readCapture(vaultPath: string, date: string, dir?: string): string {
	const full = path.join(vaultPath, dir ?? DIARY_DIR, `${date}.md`);
	if (!fs.existsSync(full)) return "";
	return fs.readFileSync(full, "utf8");
}

export { todayStamp, timeStamp };
