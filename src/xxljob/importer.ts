import type { App } from "obsidian";
import { TFile, normalizePath } from "./obsidian-api";
import type { FilePlan } from "./types";
import { mergePreservingBody } from "./writer";
import type { ConflictPolicy } from "./settings";

export interface ImportOutcome {
	created: string[];
	updated: string[];
	renamed: string[];
	skipped: string[];
	failed: Array<{ path: string; reason: string }>;
}

function emptyOutcome(): ImportOutcome {
	return { created: [], updated: [], renamed: [], skipped: [], failed: [] };
}

function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** 把生成计划写入 vault；按冲突策略处理已存在文档 */
export interface ApplyPlansOptions {
	/**
	 * 智能跳过：skip 策略下，已存在文档**有属性改动**就按更新写入
	 * （mergePreservingBody 保留手写正文），只有**完全无改动**才真的跳过。
	 * 依赖宿主在分析阶段给 plan 挂上 changes。
	 */
	smartSkip?: boolean;
}

export async function applyPlans(
	app: App,
	plans: FilePlan[],
	policy: ConflictPolicy,
	options: ApplyPlansOptions = {},
): Promise<ImportOutcome> {
	const outcome = emptyOutcome();

	// 预建目录
	const dirs = new Set<string>();
	for (const p of plans) dirs.add(dirOf(normalizePath(p.path)));
	for (const d of dirs) {
		if (!d) continue;
		if (!(await app.vault.adapter.exists(d))) {
			await app.vault.adapter.mkdir(d);
		}
	}

	for (const p of plans) {
		// 所有写入 vault 的路径都必须过 normalizePath（社区插件审核要求）
		const path = normalizePath(p.path);
		try {
			const existing = app.vault.getAbstractFileByPath(path);
			if (!existing) {
				await app.vault.create(path, p.content);
				outcome.created.push(path);
				continue;
			}
			if (!(existing instanceof TFile)) {
				outcome.failed.push({ path, reason: "同名路径已存在且不是文件" });
				continue;
			}
			// 智能跳过：有属性改动的文档按更新处理（保留手写正文），无改动才跳过
			const hasChange = !!options.smartSkip && (p.changes?.length || 0) > 0;
			if (policy === "skip" && !hasChange) {
				outcome.skipped.push(path);
				continue;
			}
			if (policy === "skip" || policy === "update") {
				const old = await app.vault.cachedRead(existing);
				await app.vault.modify(existing, mergePreservingBody(old, p.content));
				outcome.updated.push(path);
				continue;
			}
			// rename：追加序号直到不冲突
			let i = 2;
			let target = path;
			while (app.vault.getAbstractFileByPath(target)) {
				target = path.replace(/\.md$/, ` (${i}).md`);
				i += 1;
			}
			await app.vault.create(target, p.content);
			outcome.renamed.push(target);
		} catch (e) {
			outcome.failed.push({ path, reason: e instanceof Error ? e.message : String(e) });
		}
	}

	return outcome;
}
