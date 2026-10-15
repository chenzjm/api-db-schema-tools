import type { App } from "obsidian";
import { Modal, Notice, Setting, TFile } from "../obsidian-api";
import { parseXxlXml } from "../parser";
import { buildFlowTree, levelToDocKind, type FlowTree } from "../mapping";
import { buildImportPlans, type TemplateSources } from "../writer";
import type { ParseResult, ParsedJob } from "../types";
import { applyPlans, type ImportOutcome } from "../importer";
import {
	findExecutorByGroup,
	guessExecutorFromFileName,
	sanitizeExecutorDir,
	upsertExecutor,
	type ExecutorEntry,
} from "../executors";

interface PickedFile {
	name: string;
	content: string;
	result: ParseResult;
}

const STEP_TITLES = ["选择 XML", "确认执行器", "预览确认", "导入结果"];

export class XxlImportModal extends Modal {
	private readonly docsFolder: string;
	private readonly policy: () => "skip" | "update" | "rename";
	private readonly getExecutors: () => ExecutorEntry[];
	private readonly onExecutorsChanged: (next: ExecutorEntry[]) => Promise<void>;
	private readonly templates: TemplateSources;

	private files: PickedFile[] = [];
	private executorByFile = new Map<string, string>();
	private step = 0;
	private outcome: ImportOutcome | undefined;
	private lastPlans: ReturnType<typeof buildImportPlans> | undefined;

	constructor(
		app: App,
		opts: {
			docsFolder: string;
			policy: () => "skip" | "update" | "rename";
			getExecutors: () => ExecutorEntry[];
			onExecutorsChanged: (next: ExecutorEntry[]) => Promise<void>;
			templates: TemplateSources;
		},
	) {
		super(app);
		this.docsFolder = opts.docsFolder;
		this.policy = opts.policy;
		this.getExecutors = opts.getExecutors;
		this.onExecutorsChanged = opts.onExecutorsChanged;
		this.templates = opts.templates;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ---------- 渲染 ----------

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(`导入 xxl-job 任务 XML · ${STEP_TITLES[this.step] ?? ""}`);

		const head = contentEl.createDiv({ cls: "xxlfa-steps" });
		STEP_TITLES.forEach((t, i) => {
			const chip = head.createSpan({ cls: i === this.step ? "xxlfa-chip xxlfa-chip-on" : "xxlfa-chip", text: `${i + 1}. ${t}` });
			chip.setAttribute("aria-label", t);
		});

		const body = contentEl.createDiv({ cls: "xxlfa-body" });
		if (this.step === 0) this.renderPick(body);
		else if (this.step === 1) this.renderExecutors(body);
		else if (this.step === 2) this.renderPreview(body);
		else this.renderResult(body);

		this.renderFooter(contentEl);
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: "xxlfa-footer" });
		if (this.step > 0 && this.step < 3) {
			new Setting(footer).addButton((b) =>
				b.setButtonText("上一步").onClick(() => {
					this.step -= 1;
					this.render();
				}),
			);
		}
		if (this.step === 3) {
			new Setting(footer).addButton((b) =>
				b.setButtonText("完成").setCta().onClick(() => this.close()),
			);
			return;
		}
		const canNext = this.step === 0 ? this.files.length > 0 : true;
		new Setting(footer).addButton((b) =>
			b
				.setButtonText(this.step === 2 ? "开始导入" : "下一步")
				.setCta()
				.setDisabled(!canNext)
				.onClick(async () => {
					if (this.step === 2) {
						await this.runImport();
						return;
					}
					this.step += 1;
					this.render();
				}),
		);
	}

	// ---------- Step 1：选择文件 ----------

	private renderPick(parent: HTMLElement): void {
		parent.createDiv({
			cls: "xxlfa-hint",
			text: "选择一个或多个 xxl-job 导出的 XML，也可直接选择整个目录（自动筛选 XML 文件）。",
		});

		const bar = parent.createDiv({ cls: "xxlfa-row" });
		new Setting(bar)
			.addButton((b) => b.setButtonText("选择文件").onClick(() => this.pick(false)))
			.addButton((b) => b.setButtonText("选择目录").onClick(() => this.pick(true)));
		void bar;

		if (this.files.length > 0) {
			const list = parent.createDiv({ cls: "xxlfa-list" });
			for (const f of this.files) {
				const row = list.createDiv({ cls: "xxlfa-list-row" });
				row.createSpan({ text: f.name });
				const jobs = f.result.jobs.length;
				row.createSpan({
					cls: "xxlfa-muted",
					text: `  任务 ${jobs} 个${f.result.jobGroups.length ? ` · jobGroup ${f.result.jobGroups.join("/")}` : ""}`,
				});
				if (f.result.warnings.length > 0) {
					row.createSpan({ cls: "xxlfa-warn", text: `  警告 ${f.result.warnings.length} 条` });
				}
			}
		parent.createDiv({
			cls: "xxlfa-hint",
			text: `共 ${this.files.length} 个文件，合计 ${this.files.reduce((n, f) => n + f.result.jobs.length, 0)} 个任务节点。`,
		});
		}
	}

	private pick(useDirectory: boolean): void {
		// 隐藏的 input 挂在 modal 内部（不往 document.body 塞节点），选完即弃
		const input = this.contentEl.createEl("input", {
			cls: "xxlfa-hidden",
			type: "file",
		});
		input.multiple = true;
		input.accept = ".xml,text/xml,application/xml";
		if (useDirectory) {
			// 目录选择只在桌面端生效，移动端会退化为文件选择
			input.setAttribute("webkitdirectory", "");
		}
		input.addEventListener("change", () => {
			void this.consumeFiles(input.files);
		});
		input.click();
	}

	private async consumeFiles(list: FileList | null): Promise<void> {
		if (!list || list.length === 0) return;
		const picked: Array<{ name: string; content: string }> = [];
		for (const file of Array.from(list)) {
			if (!/\.xml$/i.test(file.name)) continue;
			picked.push({ name: file.name, content: await file.text() });
		}
		if (picked.length === 0) {
			new Notice("本次未选中任何 XML 文件");
			return;
		}
		this.files = picked.map((p) => ({
			...p,
			result: parseXxlXml(p.content, p.name),
		}));
		this.outcome = undefined;
		this.lastPlans = undefined;
		this.executorByFile = new Map();
		for (const f of this.files) {
			this.executorByFile.set(f.name, this.suggestExecutor(f));
		}
		this.render();
	}

	private suggestExecutor(f: PickedFile): string {
		const list = this.getExecutors();
		for (const g of f.result.jobGroups) {
			const hit = findExecutorByGroup(list, g);
			if (hit) return hit.name;
		}
		return guessExecutorFromFileName(f.name);
	}

	// ---------- Step 2：执行器确认 ----------

	private renderExecutors(parent: HTMLElement): void {
		parent.createDiv({
			cls: "xxlfa-hint",
			text: "XML 内没有执行器中文名，只有 jobGroup。已按清单匹配或用文件名推断，可修改；导入后会回写执行器清单。",
		});
		for (const f of this.files) {
			const groups = f.result.jobGroups.join("/");
			new Setting(parent)
				.setName(f.name)
				.setDesc(groups ? `jobGroup：${groups}` : "未识别到 jobGroup")
				.addText((t) =>
					t
						.setPlaceholder("执行器名称")
						.setValue(this.executorByFile.get(f.name) ?? "")
						.onChange((v) => {
							this.executorByFile.set(f.name, v.trim() || guessExecutorFromFileName(f.name));
						}),
				);
		}
	}

	// ---------- Step 3：预览 ----------

	private buildTree(): FlowTree {
		return buildFlowTree(this.files.map((f) => f.result));
	}

	private renderPreview(parent: HTMLElement): void {
		const tree = this.buildTree();
		const executorFor = (job: ParsedJob): string =>
			sanitizeExecutorDir(this.executorByFile.get(job.sourceFile) ?? guessExecutorFromFileName(job.sourceFile));
		const { plans, warnings } = buildImportPlans(tree, executorFor, {
			docsFolder: this.docsFolder,
			templates: this.templates,
		});
		this.lastPlans = { plans, warnings };

		const counts = { 任务流: 0, 批任务: 0, 任务组件: 0 } as Record<string, number>;
		for (const p of plans) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
		parent.createDiv({
			cls: "xxlfa-hint",
			text: `将生成 ${plans.length} 份文档：任务流 ${counts["任务流"]} / 批任务 ${counts["批任务"]} / 任务组件 ${counts["任务组件"]}。重名策略：${this.policyLabel()}。`,
		});

		const treeBox = parent.createDiv({ cls: "xxlfa-tree" });
		if (tree.roots.length === 0) {
			treeBox.createDiv({ cls: "xxlfa-warn", text: "未识别到任何顶层任务流（任务可能都在别的文件里）" });
		}
		for (const root of tree.roots) this.renderTreeRow(treeBox, tree, root, 0);

		if (warnings.length > 0) {
			const box = parent.createDiv({ cls: "xxlfa-warnbox" });
			box.createDiv({ cls: "xxlfa-warn", text: `警告 ${warnings.length} 条` });
			for (const w of warnings.slice(0, 20)) box.createDiv({ cls: "xxlfa-muted", text: `· ${w}` });
			if (warnings.length > 20) box.createDiv({ cls: "xxlfa-muted", text: `…另有 ${warnings.length - 20} 条` });
		}
	}

	private renderTreeRow(box: HTMLElement, tree: FlowTree, job: ParsedJob, depth: number): void {
		const row = box.createDiv({ cls: "xxlfa-tree-row" });
		const pad = depth === 0 ? "" : "  ".repeat(depth) + "└ ";
		const label = `${pad}[${levelToDocKind(job.level)}] ${job.jobDesc}`;
		row.createSpan({ text: label });
		if (job.cron) row.createSpan({ cls: "xxlfa-muted", text: `  Cron: ${job.cron}` });
		for (const cid of job.childrenIds) {
			const child = tree.byId.get(cid);
			if (child) this.renderTreeRow(box, tree, child, depth + 1);
		}
	}

	private policyLabel(): string {
		const p = this.policy();
		if (p === "skip") return "跳过";
		if (p === "update") return "更新 frontmatter";
		return "新建副本";
	}

	// ---------- Step 4：导入与结果 ----------

	private async runImport(): Promise<void> {
		const tree = this.buildTree();
		const executorFor = (job: ParsedJob): string =>
			sanitizeExecutorDir(this.executorByFile.get(job.sourceFile) ?? guessExecutorFromFileName(job.sourceFile));
		const { plans } = buildImportPlans(tree, executorFor, {
			docsFolder: this.docsFolder,
			templates: this.templates,
		});
		this.outcome = await applyPlans(this.app, plans, this.policy());

		// 回写执行器清单（按 jobGroup 绑定）
		let list = this.getExecutors();
		for (const f of this.files) {
			const name = sanitizeExecutorDir(this.executorByFile.get(f.name) ?? guessExecutorFromFileName(f.name));
			if (name) list = upsertExecutor(list, name, f.result.jobGroups);
		}
		await this.onExecutorsChanged(list);

		this.step = 3;
		this.render();
		new Notice(`导入完成：新建 ${this.outcome.created.length} 份文档`);
	}

	private renderResult(parent: HTMLElement): void {
		const o = this.outcome;
		if (!o) {
			parent.createDiv({ cls: "xxlfa-warn", text: "尚未执行导入" });
			return;
		}
		parent.createDiv({
			cls: "xxlfa-hint",
			text: `新建 ${o.created.length} · 更新 ${o.updated.length} · 副本 ${o.renamed.length} · 跳过 ${o.skipped.length} · 失败 ${o.failed.length}`,
		});
		this.renderPathList(parent, "新建", o.created);
		this.renderPathList(parent, "更新", o.updated);
		this.renderPathList(parent, "副本", o.renamed);
		this.renderPathList(parent, "跳过", o.skipped);
		if (o.failed.length > 0) {
			const box = parent.createDiv({ cls: "xxlfa-warnbox" });
			box.createDiv({ cls: "xxlfa-warn", text: `失败 ${o.failed.length} 条` });
			for (const f of o.failed) box.createDiv({ cls: "xxlfa-muted", text: `· ${f.path}：${f.reason}` });
		}
		void this.lastPlans;
	}

	private renderPathList(parent: HTMLElement, title: string, paths: string[]): void {
		if (paths.length === 0) return;
		const box = parent.createDiv({ cls: "xxlfa-group" });
		box.createDiv({ cls: "xxlfa-group-title", text: `${title}（${paths.length}）` });
		for (const p of paths.slice(0, 30)) {
			const link = box.createEl("a", { cls: "xxlfa-link", text: p, href: "#" });
			link.addEventListener("click", (ev) => {
				ev.preventDefault();
				const file = this.app.vault.getAbstractFileByPath(p);
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				}
			});
		}
		if (paths.length > 30) box.createDiv({ cls: "xxlfa-muted", text: `…另有 ${paths.length - 30} 份` });
	}
}
