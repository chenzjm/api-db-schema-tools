/** frontmatter 读写（纯逻辑，不依赖 obsidian） */

export interface SplitResult {
	fm: string;
	body: string;
}

/** 拆分 frontmatter 与正文（不匹配时返回 undefined） */
export function splitFrontmatter(content: string): SplitResult | undefined {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return undefined;
	return { fm: m[1], body: content.slice(m[0].length) };
}

/** 保留旧文件正文，只替换 frontmatter */
export function mergeFrontmatter(oldContent: string, newContent: string): string {
	const o = splitFrontmatter(oldContent);
	const n = splitFrontmatter(newContent);
	if (!n) return newContent;
	if (!o) return `${newContent}\n${oldContent}`;
	const body = o.body.startsWith("\n") ? o.body : `\n${o.body}`;
	return `---\n${n.fm}\n---\n${body}`;
}

/** 只取 frontmatter 块（含首尾 --- 分隔线）；没有则返回空串。用于预览「笔记属性」 */
export function frontmatterBlock(content: string): string {
	const m = String(content ?? "").match(/^---\r?\n[\s\S]*?\r?\n---/);
	return m ? m[0] : "";
}

/**
 * frontmatter 行级键值解析：续行（缩进行 / 列表项）并入上一键，
 * 让多行值（如任务参数 JSON 列表）也能整体对比。
 */
export function frontmatterEntries(fm: string): Map<string, string> {
	const map = new Map<string, string>();
	let key: string | null = null;
	for (const raw of String(fm ?? "").split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const m = line.match(/^([^:\s][^:]*?):\s*(.*)$/);
		if (m && !/^\s+/.test(raw)) {
			key = m[1].trim();
			map.set(key, m[2] ?? "");
		} else if (key) {
			const prev = map.get(key) || "";
			map.set(key, prev ? `${prev}\n${line}` : line);
		}
	}
	return map;
}

export interface FrontmatterChange {
	key: string;
	type: "added" | "changed" | "removed";
	oldValue?: string;
	newValue?: string;
}

/**
 * 笔记属性块 → markdown 列表（供阅读模式渲染，不再展示 YAML 源码）。
 *
 * 有改动点时行内标注（与数据库域的单元格 diff 同款观感）：
 * 修改 → `~~旧值~~ → **新值**`；新增 → `**新值**`；删除 → `~~旧值~~`。
 * 删除的键不在新文档里，追在末尾——提示这些手写属性会被覆盖清除。
 */
export function frontmatterToMarkdown(content: string, changes?: FrontmatterChange[]): string {
	const parsed = splitFrontmatter(content);
	const entries = frontmatterEntries(parsed ? parsed.fm : "");
	const byKey = new Map<string, FrontmatterChange>();
	for (const c of changes || []) byKey.set(c.key, c);
	// 多行值（任务参数 JSON 列表等）缩进续行，保持同一个 markdown 列表项
	const fmtValue = (v?: string) => {
		const raw = String(v ?? "").replace(/\r?\n\s*/g, "\n  ").trim();
		return raw || "（空）";
	};
	const lines: string[] = [];
	for (const [k, v] of entries) {
		const c = byKey.get(k);
		if (c?.type === "changed") lines.push(`- **${k}**：~~${fmtValue(c.oldValue)}~~ → **${fmtValue(c.newValue)}**`);
		else if (c?.type === "added") lines.push(`- **${k}**：**${fmtValue(c.newValue)}**`);
		else lines.push(`- **${k}**：${fmtValue(v)}`);
	}
	for (const c of changes || []) {
		if (c.type !== "removed" || entries.has(c.key)) continue;
		lines.push(`- **${c.key}**：~~${fmtValue(c.oldValue)}~~`);
	}
	return lines.join("\n");
}

/**
 * 对比两份文档的 frontmatter，返回属性级改动点。
 * 排序：修改 → 新增 → 删除（各自保持文档内键序），调用方按需展示。
 */
export function diffFrontmatter(oldContent: string, newContent: string): FrontmatterChange[] {
	const o = splitFrontmatter(oldContent);
	const n = splitFrontmatter(newContent);
	const oe = frontmatterEntries(o ? o.fm : "");
	const ne = frontmatterEntries(n ? n.fm : "");
	const changed: FrontmatterChange[] = [];
	const added: FrontmatterChange[] = [];
	const removed: FrontmatterChange[] = [];
	for (const [k, v] of ne) if (!oe.has(k)) added.push({ key: k, type: "added", newValue: v });
	for (const [k, v] of oe) {
		const nv = ne.get(k);
		if (nv === undefined) removed.push({ key: k, type: "removed", oldValue: v });
		else if (nv !== v) changed.push({ key: k, type: "changed", oldValue: v, newValue: nv });
	}
	return [...changed, ...added, ...removed];
}
