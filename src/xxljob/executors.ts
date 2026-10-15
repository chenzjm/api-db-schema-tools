/** 执行器名维护（纯逻辑，不依赖 obsidian，便于脚本/测试复用） */

export interface ExecutorEntry {
	name: string;
	jobGroups: string[];
}

/**
 * 从文件名推断执行器名：取括号外部分（如「通用保险执行器(xxl-job-executor-xxx).xml」→ 通用保险执行器）；
 * 无括号时取文件名本身（去扩展名）。
 */
export function guessExecutorFromFileName(fileName: string): string {
	const base = fileName.replace(/\.xml$/i, "");
	const paren = base.match(/^([^(]+)\(/);
	const name = (paren ? paren[1] : base).trim();
	return name.length > 0 ? name : base;
}

/** 按 jobGroup 命中清单；未命中返回 undefined */
export function findExecutorByGroup(list: ExecutorEntry[], jobGroup: string): ExecutorEntry | undefined {
	return list.find((e) => e.jobGroups.includes(jobGroup));
}

/** 导入确认后回写清单：把 jobGroup 绑定到一个执行器名（已存在则合并） */
export function upsertExecutor(list: ExecutorEntry[], name: string, jobGroups: string[]): ExecutorEntry[] {
	const existing = list.find((e) => e.name === name);
	if (!existing) {
		return [...list, { name, jobGroups: [...new Set(jobGroups)] }];
	}
	const merged = [...new Set([...existing.jobGroups, ...jobGroups])];
	return list.map((e) => (e.name === name ? { name, jobGroups: merged } : e));
}

/** 执行器名作为目录名前的净化（禁止 / \ : 等） */
export function sanitizeExecutorDir(name: string): string {
	return name.replace(/[/\\:*?"<>|#^[\]]/g, "-").trim();
}

export function executorListToText(list: ExecutorEntry[]): string {
	return list.map((e) => (e.jobGroups.length ? `${e.name}|${e.jobGroups.join(",")}` : e.name)).join("\n");
}

export function textToExecutorList(text: string): ExecutorEntry[] {
	const out: ExecutorEntry[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const [name, groups] = line.split("|");
		const trimmed = name.trim();
		if (!trimmed) continue;
		out.push({
			name: trimmed,
			jobGroups: (groups ?? "")
				.split(",")
				.map((g) => g.trim())
				.filter((g) => g.length > 0),
		});
	}
	return out;
}
