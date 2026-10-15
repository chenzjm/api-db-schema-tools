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
