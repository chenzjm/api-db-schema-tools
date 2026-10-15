import { App, Notice, TFile, normalizePath } from "obsidian";
import type { TemplateSources } from "./writer";

export interface TemplatePaths {
	flowTemplate: string;
	taskTemplate: string;
	componentTemplate: string;
}

/** 读单个模板原文；路径为空、文件不存在或读取失败都返回 undefined（由调用方回退内置结构） */
export async function readTemplate(app: App, path: string): Promise<string | undefined> {
	const p = normalizePath(path || "");
	if (!p) return undefined;
	const file = app.vault.getAbstractFileByPath(p);
	if (!(file instanceof TFile)) return undefined;
	try {
		return await app.vault.cachedRead(file);
	} catch {
		return undefined;
	}
}

/** 读三类文档模板；读不到的路径会在返回里列出（可选弹一次提示） */
export async function readTemplates(
	app: App,
	paths: TemplatePaths,
	notify = true,
): Promise<{ templates: TemplateSources; missing: string[] }> {
	const entries: Array<[keyof TemplateSources, string]> = [
		["taskFlow", paths.flowTemplate],
		["task", paths.taskTemplate],
		["component", paths.componentTemplate],
	];
	const templates: TemplateSources = {};
	const missing: string[] = [];
	for (const [key, path] of entries) {
		const raw = path ? await readTemplate(app, path) : undefined;
		if (raw === undefined) {
			if (path) missing.push(path);
			continue;
		}
		templates[key] = raw;
	}
	if (notify && missing.length > 0) {
		new Notice(`以下模板没读到，将回退内置结构：${missing.join("、")}`);
	}
	return { templates, missing };
}
