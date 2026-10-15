/**
 * bundle 冒烟：模拟 Schema Studio 的集成方式 —— 在 Node 里 require 构建产物
 * `xxljob-bundle.cjs`，跑一遍「解析 → 建树 → 生成计划」，确认导出面完整。
 *
 * Node 里没有 Obsidian 宿主，用 Module._load 拦截 require('obsidian') 返回桩件。
 */
import Module from "node:module";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);

class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = {};
		this.titleEl = {};
	}
	open() {}
	close() {}
}
class Setting {
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setClass() {
		return this;
	}
	setHeading() {
		return this;
	}
	addText() {
		return this;
	}
	addTextArea() {
		return this;
	}
	addButton() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addToggle() {
		return this;
	}
}
class Notice {
	constructor(message) {
		this.message = message;
	}
}
const obsidianStub = {
	Modal,
	Setting,
	Notice,
	App: class App {},
	Plugin: class Plugin {},
	PluginSettingTab: class PluginSettingTab {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = {};
		}
	},
	TFile: class TFile {},
	TFolder: class TFolder {},
	normalizePath: (p) => p,
	normalizePathDeprecated: (p) => p,
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return origLoad.call(this, request, parent, isMain);
};

// bundle 优先从全局取 obsidian API（与 Schema Studio 宿主注入方式一致）
globalThis.__schemaStudioObsidian = obsidianStub;

const bundlePath = new URL("../xxljob-bundle.cjs", import.meta.url);
assert.ok(existsSync(bundlePath), "先跑 npm run build 产出 xxljob-bundle.cjs");
const xxl = require(bundlePath.pathname);
Module._load = origLoad;

// ---------- 导出面 ----------
for (const name of [
	"parseXxlXml",
	"buildFlowTree",
	"buildImportPlans",
	"mergePreservingBody",
	"applyPlans",
	"applyXxljobPlans",
	"buildPlansFromFiles",
	"createXxlImportWizard",
	"readTemplates",
	"readTemplate",
	"sanitizeExecutorDir",
	"levelToDirName",
	"levelToDocKind",
	"sanitizeFileName",
	"XxlImportModal",
	"upsertExecutor",
	"findExecutorByGroup",
	"executorListToText",
	"textToExecutorList",
	"guessExecutorFromFileName",
]) {
	assert.equal(typeof xxl[name], "function", `bundle 应导出函数 ${name}`);
}
assert.equal(xxl.DEFAULT_SETTINGS.docsFolder, "8.xxljob");
assert.deepEqual([...xxl.LINK_HEADINGS], ["对应任务流", "对应批任务"]);

// ---------- 端到端：XML → 计划 ----------
const FIXTURE =
	process.env.XXL_XML_FIXTURES ?? "/Users/chenzhongjun/Desktop/obsidian材料";
const realXml = `${FIXTURE}/通用保险执行器(xxl-job-executor-batch-job-demo).xml`;

const minimal = `<linked-list>
  <job><xxlJobInfo>
    <id>1</id><jobGroup>1120</jobGroup><jobCron>0 0 2 * * ?</jobCron>
    <jobDesc>主链路</jobDesc><author>u1</author>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <jobLevelType>MAIN_TRIGGER_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy>
  </xxlJobInfo>
  <yrTriggerInfo><triggerId>1</triggerId><taskFlowInfo>{&quot;nodes&quot;:[{&quot;triggerId&quot;:10,&quot;label&quot;:&quot;任务A&quot;,&quot;id&quot;:&quot;n1&quot;}],&quot;edges&quot;:[]}</taskFlowInfo></yrTriggerInfo>
  </job>
  <job><xxlJobInfo>
    <id>10</id><jobGroup>1120</jobGroup><jobDesc>任务A</jobDesc><author>u2</author>
    <jobLevelType>VIRTUAL_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy>
  </xxlJobInfo>
  <yrTriggerInfo><triggerId>10</triggerId><taskFlowInfo>{&quot;nodes&quot;:[{&quot;triggerId&quot;:100,&quot;label&quot;:&quot;组件A1&quot;,&quot;id&quot;:&quot;c1&quot;}],&quot;edges&quot;:[]}</taskFlowInfo></yrTriggerInfo>
  </job>
  <job><xxlJobInfo>
    <id>100</id><jobGroup>1120</jobGroup><jobDesc>组件A1</jobDesc><author>u3</author>
    <jobLevelType>COMPONENT_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy>
  </xxlJobInfo>
  <yrJobInfo><id>y100</id><name>组件A1</name></yrJobInfo>
  </job>
</linked-list>`;

const files = existsSync(realXml)
	? [{ name: "通用保险执行器.xml", content: readFileSync(realXml, "utf-8") }]
	: [{ name: "synthetic.xml", content: minimal }];

const res = xxl.buildPlansFromFiles(files, {
	docsFolder: "8.xxljob",
	executorOfFile: () => "通用保险执行器",
});

assert.ok(res.plans.length >= 3, `计划数应 >= 3，实际 ${res.plans.length}`);
assert.ok(res.counts.任务流 >= 1 && res.counts.批任务 >= 1 && res.counts.任务组件 >= 1, JSON.stringify(res.counts));
assert.equal(res.jobGroups[0].groups[0], "1120");

const task = res.plans.find((p) => p.kind === "批任务");
const comp = res.plans.find((p) => p.kind === "任务组件");
assert.match(task.content, /# 对应任务流\n/);
assert.match(comp.content, /# 对应批任务\n/);
// 归属章节排在任务说明之前
assert.ok(
	task.content.indexOf("# 对应任务流") < task.content.indexOf("# 任务说明"),
	"对应任务流 应在 任务说明 之前",
);

// 执行器清单回写
const list = xxl.upsertExecutor([], "通用保险执行器", ["1120"]);
assert.equal(xxl.findExecutorByGroup(list, "1120")?.name, "通用保险执行器");
assert.match(xxl.executorListToText(list), /通用保险执行器\|1120/);

console.log(
	`bundle 冒烟通过：导出 ${Object.keys(xxl).length} 项；本次生成 ${res.plans.length} 份计划（任务流 ${res.counts.任务流} / 批任务 ${res.counts.批任务} / 任务组件 ${res.counts.任务组件}）`,
);
