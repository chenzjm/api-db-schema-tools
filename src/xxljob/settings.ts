import type { App } from "obsidian";
import { Plugin, PluginSettingTab, Setting } from "./obsidian-api";
import {
	executorListToText,
	textToExecutorList,
	type ExecutorEntry,
} from "./executors";

/**
 * 设置页对宿主插件的最小要求。
 * 独立插件里宿主是 FlowAtlasPlugin；并入 Schema Studio 后宿主是 Studio 自己的 Plugin，
 * 所以这里不 import "./main"（Studio 里没有这个入口），只依赖这个接口。
 */
export interface SettingsHost {
	settings: FlowAtlasSettings;
	saveSettings(): Promise<void>;
}

/** 目标文档已存在时的处理策略 */
export type ConflictPolicy = "skip" | "update" | "rename";

export type { ExecutorEntry };

export interface FlowAtlasSettings {
	docsFolder: string;
	conflictPolicy: ConflictPolicy;
	executors: ExecutorEntry[];
	/** 生成任务流文档套用的模板 */
	flowTemplate: string;
	/** 生成批任务文档套用的模板 */
	taskTemplate: string;
	/** 生成任务组件文档套用的模板 */
	componentTemplate: string;
}

export const DEFAULT_SETTINGS: FlowAtlasSettings = {
	docsFolder: "8.xxljob",
	conflictPolicy: "skip",
	executors: [],
	flowTemplate: "_template/业务模板/xxljob-批任务-pirenwu/xxljob-任务流-renwuliu.md",
	taskTemplate: "_template/业务模板/xxljob-批任务-pirenwu/xxljob-批任务-pirenwu.md",
	componentTemplate: "_template/业务模板/xxljob-批任务-pirenwu/xxljob-任务组件-renwuzujian.md",
};

const POLICY_LABELS: Record<ConflictPolicy, string> = {
	skip: "跳过（保留现有文档）",
	update: "更新 frontmatter（保留正文）",
	rename: "新建副本（名称后加序号）",
};

type TemplateKey = "flowTemplate" | "taskTemplate" | "componentTemplate";

/** 三类文档对应的模板设置项：[设置键, 名称, 说明] */
const TEMPLATE_FIELDS: Array<[TemplateKey, string, string]> = [
	["flowTemplate", "任务流模板", "生成「任务流」文档时套用这个模板；留空则回退到内置结构。"],
	["taskTemplate", "批任务模板", "生成「批任务」文档时套用这个模板；留空则回退到内置结构。"],
	["componentTemplate", "任务组件模板", "生成「任务组件」文档时套用这个模板；模板里的人工填写项会保留为提示。"],
];

export class FlowAtlasSettingTab extends PluginSettingTab {
	plugin: SettingsHost;

	constructor(app: App, plugin: SettingsHost) {
		// PluginSettingTab 的构造签名要求完整 Plugin，但这里只用到 settings/saveSettings
		super(app, plugin as unknown as Plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("文档根目录")
			.setDesc("导入生成的任务文档放在哪个文件夹下（相对仓库根目录）。")
			.addText((text) =>
				text
					.setPlaceholder("8.xxljob")
					.setValue(this.plugin.settings.docsFolder)
					.onChange(async (value) => {
						this.plugin.settings.docsFolder = value.trim() || DEFAULT_SETTINGS.docsFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("重名文档处理")
			.setDesc("重复导入同一批 XML 时，目标文档已存在的处理方式。")
			.addDropdown((dd) =>
				dd
					.addOptions(POLICY_LABELS)
					.setValue(this.plugin.settings.conflictPolicy)
					.onChange(async (value) => {
						this.plugin.settings.conflictPolicy = value as ConflictPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("文档模板").setHeading();
		for (const [key, name, desc] of TEMPLATE_FIELDS) {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text
						.setValue(this.plugin.settings[key])
						.onChange(async (value) => {
							this.plugin.settings[key] = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("执行器清单")
			.setDesc("每行一条：执行器名称，或用竖线分隔任务分组编号（多个编号用逗号分隔）。导入时按任务分组编号自动匹配执行器名，新确认的名称会自动回写到这里。")
			.addTextArea((ta) =>
				ta
					.setPlaceholder("通用保险执行器|1120")
					.setValue(executorListToText(this.plugin.settings.executors))
					.onChange(async (value) => {
						this.plugin.settings.executors = textToExecutorList(value);
						await this.plugin.saveSettings();
					}),
			);
	}
}
