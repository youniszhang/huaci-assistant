/**
 * 生成记录（本机历史）：每次 AI 生成完成后把「输入（选区/追问）+ 输出（正文/思考）」
 * 落盘到 userData/history/，供主窗口「生成记录」页回看。
 *
 * 与 note.ts 的区别：note.ts 是用户主动「录入笔记」写入 Obsidian vault 的成果；
 * 这里是每次生成的无损日志（含未录入的、失败的），App 内部查看。
 *
 * 存储：一条记录一个 JSON 文件（userData/history/<id>.json），
 * 避免单文件 JSONL 在并发追加/损坏时的恢复问题，也便于单条读取。
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface HistoryRecord {
	/** 唯一 id（同时是文件名） */
	id: string;
	/** 生成时间（epoch ms） */
	ts: number;
	/** 动作标签：解释 / 翻译 / 总结 / 意图分析 / 拟回复 / 追问 */
	action: string;
	actionId?: string;
	/** 来源应用（划词场景）或「屏幕区域」（OCR 场景） */
	app?: string;
	provider?: string;
	model?: string;
	/** 输入：选区原文 */
	selection: string;
	/** 追问问题（仅追问记录） */
	question?: string;
	/** 输出：正文（Markdown） */
	content: string;
	/** 思考过程（若有） */
	thinking?: string;
	/** 失败信息（部分内容 + 出错时） */
	error?: string;
	/** 是否已「录入笔记」到 Obsidian */
	saved?: boolean;
}

export interface HistorySummary {
	id: string;
	ts: number;
	action: string;
	app?: string;
	provider?: string;
	model?: string;
	/** 选区前 60 字（列表预览） */
	selectionPreview: string;
	/** 正文前 80 字（列表预览） */
	contentPreview: string;
	saved: boolean;
	hasError: boolean;
}

function historyDir(): string {
	return path.join(app.getPath("userData"), "history");
}

function recordFile(id: string): string {
	// id 由内部生成（时间戳 base36 + 随机），做基本防御避免路径穿越
	return path.join(historyDir(), `${String(id).replace(/[^a-z0-9-]/gi, "")}.json`);
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 追加一条生成记录（返回完整记录，含生成的 id） */
export function appendHistory(rec: Omit<HistoryRecord, "id" | "ts"> & { ts?: number }): HistoryRecord {
	const full: HistoryRecord = {
		...rec,
		id: newId(),
		ts: rec.ts ?? Date.now(),
	};
	try {
		fs.mkdirSync(historyDir(), { recursive: true });
		fs.writeFileSync(recordFile(full.id), JSON.stringify(full), "utf8");
		// 顺带做一次轻量清理：超过 1000 条时删最旧的 100 条（防止无限增长）
		pruneIfNeeded();
	} catch (err) {
		console.error(`[history] 写入失败：${(err as Error).message}`);
	}
	return full;
}

/** 更新一条记录（目前用于 saved 标记） */
export function updateHistory(id: string, patch: Partial<HistoryRecord>): boolean {
	const file = recordFile(id);
	try {
		if (!fs.existsSync(file)) return false;
		const cur = JSON.parse(fs.readFileSync(file, "utf8")) as HistoryRecord;
		const next = { ...cur, ...patch, id: cur.id, ts: cur.ts };
		fs.writeFileSync(file, JSON.stringify(next), "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 读取一条完整记录 */
export function getHistory(id: string): HistoryRecord | null {
	try {
		const file = recordFile(id);
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf8")) as HistoryRecord;
	} catch {
		return null;
	}
}

/** 删除一条记录 */
export function deleteHistory(id: string): boolean {
	try {
		const file = recordFile(id);
		if (!fs.existsSync(file)) return false;
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

/** 清空全部记录（返回删除条数） */
export function clearHistory(): number {
	const dir = historyDir();
	if (!fs.existsSync(dir)) return 0;
	let n = 0;
	try {
		for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
			try {
				fs.unlinkSync(path.join(dir, f));
				n += 1;
			} catch {
				// 单条失败忽略
			}
		}
	} catch {
		// 目录读取失败
	}
	return n;
}

/** 列出记录摘要（按时间倒序，默认最近 300 条） */
export function listHistory(limit = 300): HistorySummary[] {
	const dir = historyDir();
	if (!fs.existsSync(dir)) return [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: HistorySummary[] = [];
	for (const f of files) {
		try {
			const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as HistoryRecord;
			if (!rec || !rec.id) continue;
			out.push({
				id: rec.id,
				ts: rec.ts || 0,
				action: rec.action || "",
				app: rec.app,
				provider: rec.provider,
				model: rec.model,
				selectionPreview: String(rec.selection || "").replace(/\s+/g, " ").slice(0, 60),
				contentPreview: String(rec.content || "").replace(/\s+/g, " ").slice(0, 80),
				saved: !!rec.saved,
				hasError: !!rec.error,
			});
		} catch {
			// 单条损坏不影响整体
		}
	}
	out.sort((a, b) => b.ts - a.ts);
	return out.slice(0, limit);
}

/** 超过上限时清理最旧记录（默认上限 1000） */
function pruneIfNeeded(max = 1000): void {
	try {
		const dir = historyDir();
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		if (files.length <= max) return;
		const withTime = files.map((f) => {
			const full = path.join(dir, f);
			return { full, mtime: fs.statSync(full).mtimeMs };
		});
		withTime.sort((a, b) => a.mtime - b.mtime);
		for (const f of withTime.slice(0, files.length - max)) {
			try {
				fs.unlinkSync(f.full);
			} catch {
				// 忽略单条删除失败
			}
		}
	} catch {
		// 清理失败不影响主流程
	}
}
