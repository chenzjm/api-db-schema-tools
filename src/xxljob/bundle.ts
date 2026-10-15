/**
 * 子模块入口：供 Schema Studio（api-db-schema-tools）以
 * `require('./xxljob-bundle.cjs')` 的方式集成。
 *
 * 这里**不注册**命令 / ribbon / 设置页（那是独立插件 main.ts 的事），
 * 只导出能力：解析 → 建树 → 生成计划 → 写盘，以及可选的向导工厂。
 */
import type { App } from "obsidian";
import { parseXxlXml } from "./parser";
import {
	buildFlowTree,
	levelToDirName,
	levelToDocKind,
	sanitizeFileName,
	type FlowTree,
} from "./mapping";
import { buildImportPlans, mergePreservingBody, LINK_HEADINGS, type TemplateSources } from "./writer";
import { applyPlans, type ApplyPlansOptions, type ImportOutcome } from "./importer";
import { readTemplate, readTemplates, type TemplatePaths } from "./templates";
import {
	frontmatterBlock,
	frontmatterEntries,
	frontmatterToMarkdown,
	normalizeFmScalar,
	diffFrontmatter,
	type FrontmatterChange,
} from "./frontmatter";
import { XxlImportModal } from "./ui/importModal";
import { DEFAULT_SETTINGS, type ConflictPolicy } from "./settings";
import {
	executorListToText,
	findExecutorByGroup,
	guessExecutorFromFileName,
	sanitizeExecutorDir,
	textToExecutorList,
	upsertExecutor,
	type ExecutorEntry,
} from "./executors";
import type { FilePlan, ParsedJob } from "./types";

// ---------- 高层封装：给宿主（Schema Studio）用 ----------

export interface XxlSourceFile {
	name: string;
	content: string;
}

export interface BuildPlansOptions {
	docsFolder?: string;
	templates?: TemplateSources;
	/** 按文件名指定执行器（宿主收集好执行器确认结果后传入） */
	executorOfFile?: (fileName: string) => string;
	/** 直接按任务给执行器（优先级高于 executorOfFile） */
	executorFor?: (job: ParsedJob) => string;
}

export interface BuildPlansResult {
	tree: FlowTree;
	plans: FilePlan[];
	warnings: string[];
	/** 每个源文件的 jobGroup（供宿主做执行器匹配） */
	jobGroups: Array<{ name: string; groups: string[] }>;
	counts: { 任务流: number; 批任务: number; 任务组件: number };
}

/**
 * 一次到位：XML 文本 → 解析 → 建树 → 生成文档计划。
 * 宿主只需拿到 plans 再调 applyXxljobPlans 写盘。
 */
export function buildPlansFromFiles(files: XxlSourceFile[], opts: BuildPlansOptions = {}): BuildPlansResult {
	const parsed = files
		.filter((f) => /\.xml$/i.test(f.name))
		.map((f) => ({ name: f.name, result: parseXxlXml(f.content, f.name) }));
	const tree = buildFlowTree(parsed.map((p) => p.result));
	const executorFor =
		opts.executorFor ??
		((job: ParsedJob): string =>
			sanitizeExecutorDir(
				opts.executorOfFile?.(job.sourceFile) ?? guessExecutorFromFileName(job.sourceFile),
			));
	const { plans, warnings } = buildImportPlans(tree, executorFor, {
		docsFolder: opts.docsFolder ?? DEFAULT_SETTINGS.docsFolder,
		templates: opts.templates ?? {},
	});
	const counts = { 任务流: 0, 批任务: 0, 任务组件: 0 };
	for (const p of plans) counts[p.kind] += 1;
	return {
		tree,
		plans,
		warnings: [...new Set(warnings)],
		jobGroups: parsed.map((p) => ({ name: p.name, groups: p.result.jobGroups })),
		counts,
	};
}

/** 写盘：与独立插件共用同一套冲突策略实现 */
export async function applyXxljobPlans(
	app: App,
	plans: FilePlan[],
	policy: ConflictPolicy,
	options: ApplyPlansOptions = {},
): Promise<ImportOutcome> {
	return applyPlans(app, plans, policy, options);
}

// ---------- 可选：沿用独立插件的四步向导 ----------

export interface XxlWizardOptions {
	docsFolder: string;
	policy: () => ConflictPolicy;
	getExecutors: () => ExecutorEntry[];
	onExecutorsChanged: (next: ExecutorEntry[]) => Promise<void>;
	templates: TemplateSources;
}

export interface XxlWizardHandle {
	open(): void;
	close(): void;
}

export function createXxlImportWizard(app: App, opts: XxlWizardOptions): XxlWizardHandle {
	const modal = new XxlImportModal(app, {
		docsFolder: opts.docsFolder,
		policy: opts.policy,
		getExecutors: opts.getExecutors,
		onExecutorsChanged: opts.onExecutorsChanged,
		templates: opts.templates,
	});
	return {
		open: () => modal.open(),
		close: () => modal.close(),
	};
}

// ---------- 再导出：纯逻辑与工具 ----------

export {
	parseXxlXml,
	buildFlowTree,
	buildImportPlans,
	mergePreservingBody,
	frontmatterBlock,
	frontmatterEntries,
	frontmatterToMarkdown,
	normalizeFmScalar,
	diffFrontmatter,
	LINK_HEADINGS,
	applyPlans,
	readTemplate,
	readTemplates,
	XxlImportModal,
	DEFAULT_SETTINGS,
	levelToDirName,
	levelToDocKind,
	sanitizeFileName,
	sanitizeExecutorDir,
	guessExecutorFromFileName,
	findExecutorByGroup,
	upsertExecutor,
	executorListToText,
	textToExecutorList,
};
export type { TemplateSources, TemplatePaths, ConflictPolicy, ExecutorEntry, FilePlan, ImportOutcome, ApplyPlansOptions, FlowTree, ParsedJob, FrontmatterChange };
