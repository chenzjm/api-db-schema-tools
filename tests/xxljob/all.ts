import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, skip } from "node:test";
import assert from "node:assert/strict";
import { parseXxlXml } from "../../src/xxljob/parser";
import { buildFlowTree, mapEnum, ROUTE_MAP, resolveJobBeanName, sanitizeFileName } from "../../src/xxljob/mapping";
import { buildImportPlans, mergePreservingBody, type TemplateSources } from "../../src/xxljob/writer";
import { splitFrontmatter, frontmatterBlock, frontmatterEntries, frontmatterToMarkdown, normalizeFmScalar, diffFrontmatter } from "../../src/xxljob/frontmatter";

// 测试脚本统一从仓库根目录执行（npm test）
const TPL_DIR = join(process.cwd(), "templates", "xxljob");
const readTpl = (name: string): string | undefined => {
	const p = join(TPL_DIR, name);
	return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
};
/** 与 vault 的 _template 保持一致的模板副本；缺失时 buildImportPlans 会回退内置结构 */
const TEMPLATES: TemplateSources = {
	taskFlow: readTpl("xxljob-任务流-renwuliu.md"),
	task: readTpl("xxljob-批任务-pirenwu.md"),
	component: readTpl("xxljob-任务组件-renwuzujian.md"),
};

const FIXTURE_DIR = process.env.XXL_XML_FIXTURES ?? "/Users/chenzhongjun/Desktop/obsidian材料";
const FIX_A = join(FIXTURE_DIR, "通用保险执行器(xxl-job-executor-batch-job-demo) (1).xml");
const FIX_B = join(FIXTURE_DIR, "通用保险执行器(xxl-job-executor-batch-job-demo).xml");

// ---------- 合成样例：MAIN → 2 VIRTUAL → 各 2 COMPONENT（验证 n 元树） ----------

const synthetic = `<linked-list>
  <job><xxlJobInfo>
    <id>1</id><jobGroup>100</jobGroup><jobCron>0 0 2 * * ?</jobCron>
    <jobDesc>主链路</jobDesc><author>u1</author>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <jobLevelType>MAIN_TRIGGER_JOB</jobLevelType><executeBizDateType>TODAY</executeBizDateType>
    <misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
  </xxlJobInfo>
  <yrTriggerInfo><triggerId>1</triggerId><taskFlowInfo>{&quot;nodes&quot;:[{&quot;triggerId&quot;:10,&quot;label&quot;:&quot;任务A&quot;,&quot;type&quot;:&quot;node&quot;,&quot;id&quot;:&quot;n1&quot;},{&quot;triggerId&quot;:11,&quot;label&quot;:&quot;任务B&quot;,&quot;type&quot;:&quot;node&quot;,&quot;id&quot;:&quot;n2&quot;}],&quot;edges&quot;:[{&quot;source&quot;:&quot;n1&quot;,&quot;target&quot;:&quot;n2&quot;}]}</taskFlowInfo></yrTriggerInfo>
  </job>
  <job><xxlJobInfo>
    <id>10</id><jobGroup>100</jobGroup><jobDesc>任务A</jobDesc><author>u2</author>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <executorParam>{&quot;pageSize&quot;:500,&quot;organCode&quot;:&quot;R1&quot;}</executorParam>
    <jobLevelType>VIRTUAL_JOB</jobLevelType><executeBizDateType>TODAY</executeBizDateType>
    <misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
  </xxlJobInfo>
  <yrTriggerInfo><triggerId>10</triggerId><taskFlowInfo>{&quot;nodes&quot;:[{&quot;triggerId&quot;:100,&quot;label&quot;:&quot;组件A1&quot;,&quot;type&quot;:&quot;node&quot;,&quot;id&quot;:&quot;c1&quot;},{&quot;triggerId&quot;:101,&quot;label&quot;:&quot;组件A2&quot;,&quot;type&quot;:&quot;node&quot;,&quot;id&quot;:&quot;c2&quot;}],&quot;edges&quot;:[]}</taskFlowInfo></yrTriggerInfo>
  </job>
  <job><xxlJobInfo>
    <id>11</id><jobGroup>100</jobGroup><jobDesc>任务B</jobDesc><author>u2</author>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <jobLevelType>VIRTUAL_JOB</jobLevelType><executeBizDateType>TODAY</executeBizDateType>
    <misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
  </xxlJobInfo>
  <yrTriggerInfo><triggerId>11</triggerId><taskFlowInfo>{&quot;nodes&quot;:[{&quot;triggerId&quot;:102,&quot;label&quot;:&quot;组件B1&quot;,&quot;type&quot;:&quot;node&quot;,&quot;id&quot;:&quot;c3&quot;}],&quot;edges&quot;:[]}</taskFlowInfo></yrTriggerInfo>
  </job>
  <job><xxlJobInfo>
    <id>100</id><jobGroup>100</jobGroup><jobDesc>组件A1</jobDesc><author>u3</author>
    <executorRouteStrategy>CONSISTENT_HASH</executorRouteStrategy><executorBlockStrategy>DISCARD_LATER</executorBlockStrategy>
    <jobLevelType>COMPONENT_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
    <executorParam>{&quot;pageSize&quot;:500}</executorParam>
    <jobInfo>{&quot;nodes&quot;:[{&quot;id&quot;:&quot;s&quot;,&quot;label&quot;:&quot;开始&quot;,&quot;dataType&quot;:&quot;startNode&quot;},{&quot;id&quot;:&quot;r&quot;,&quot;label&quot;:&quot;组件A1&quot;,&quot;dataType&quot;:&quot;rect&quot;,&quot;processClass&quot;:&quot;beanA1Job&quot;},{&quot;id&quot;:&quot;e&quot;,&quot;label&quot;:&quot;结束&quot;,&quot;dataType&quot;:&quot;endNode&quot;}],&quot;edges&quot;:[{&quot;source&quot;:&quot;s&quot;,&quot;target&quot;:&quot;r&quot;},{&quot;source&quot;:&quot;r&quot;,&quot;target&quot;:&quot;e&quot;}]}</jobInfo>
  </xxlJobInfo>
  <yrJobInfo><id>y100</id><name>组件A1</name></yrJobInfo>
  </job>
  <job><xxlJobInfo>
    <id>101</id><jobGroup>100</jobGroup><jobDesc>组件A2</jobDesc>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <jobLevelType>COMPONENT_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
  </xxlJobInfo>
  <yrJobInfo><id>y101</id><name>组件A2</name></yrJobInfo>
  </job>
  <job><xxlJobInfo>
    <id>102</id><jobGroup>100</jobGroup><jobDesc>组件B1</jobDesc>
    <executorRouteStrategy>FIRST</executorRouteStrategy><executorBlockStrategy>SERIAL_EXECUTION</executorBlockStrategy>
    <jobLevelType>COMPONENT_JOB</jobLevelType><misfireStrategy>DO_NOTHING</misfireStrategy><triggerStatus>0</triggerStatus>
  </xxlJobInfo>
  <yrJobInfo><id>y102</id><name>组件B1</name></yrJobInfo>
  </job>
</linked-list>`;

test("枚举映射表", () => {
	assert.equal(mapEnum(ROUTE_MAP, "FIRST"), "第一个");
	assert.equal(mapEnum(ROUTE_MAP, "SHARDING_BROADCAST"), "分片广播");
	assert.equal(mapEnum(ROUTE_MAP, "UNKNOWN_X"), "UNKNOWN_X"); // 未识别原样
});

test("文件名净化", () => {
	assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
});

test("合成样例：解析与层级", () => {
	const r = parseXxlXml(synthetic, "synthetic.xml");
	assert.equal(r.jobs.length, 6);
	const levels = Object.groupBy(r.jobs, (j) => j.level);
	assert.equal(levels.MAIN?.length, 1);
	assert.equal(levels.VIRTUAL?.length, 2);
	assert.equal(levels.COMPONENT?.length, 3);
	const main = r.jobs.find((j) => j.id === "1")!;
	assert.equal(main.cron, "0 0 2 * * ?");
	assert.deepEqual(main.childrenIds, ["10", "11"]);
	const comp = r.jobs.find((j) => j.id === "100")!;
	assert.equal(comp.processClass, "beanA1Job");
});

test("合成样例：n 元树与父子关系", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	assert.equal(tree.roots.length, 1);
	assert.equal(tree.roots[0].jobDesc, "主链路");
	assert.equal(tree.parentOf.get("10"), "1");
	assert.equal(tree.parentOf.get("11"), "1");
	assert.equal(tree.parentOf.get("100"), "10");
	assert.equal(tree.parentOf.get("102"), "11");
});

test("合成样例：三遍法生成 6 份文档", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans, warnings } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	assert.equal(plans.length, 6);
	assert.ok(warnings.length === 0, `unexpected warnings: ${warnings.join("; ")}`);
	const kinds = Object.groupBy(plans, (p) => p.kind);
	assert.equal(kinds["任务流"]?.length, 1);
	assert.equal(kinds["批任务"]?.length, 2);
	assert.equal(kinds["任务组件"]?.length, 3);

	const flow = plans.find((p) => p.kind === "任务流")!;
	assert.ok(flow.path.includes("/任务流/主链路.md"), flow.path);
	assert.match(flow.content, /fileClass: 任务流/);
	assert.match(flow.content, /调度状态: 停止/);
	assert.match(flow.content, /Cron表达式: 0 0 2 \* \* \?/);
	// mermaid 双链指向任务目录
	assert.match(flow.content, /\[\[8\.xxljob\/测试执行器\/任务\/任务A\|任务A\]\]/);
	assert.match(flow.content, /1 --> 2/); // n1→n2 边
	assert.match(flow.content, /2 --> 3/);

	const taskA = plans.find((p) => p.title === "任务A")!;
	assert.match(taskA.content, /fileClass: 批任务/);
	// 归属关系写在正文「# 对应任务流」章节，用双链引入任务流文档
	assert.match(taskA.content, /# 对应任务流/);
	assert.match(taskA.content, /\[\[8\.xxljob\/测试执行器\/任务流\/主链路\|主链路\]\]/);
	assert.doesNotMatch(taskA.content, /对应任务流名称/);
	assert.match(taskA.content, /\[\[8\.xxljob\/测试执行器\/任务组件\/组件A1\|组件A1\]\]/);
	assert.match(taskA.content, /任务参数: "\{\\"pageSize\\":500/); // 参数反转义保留

	const compA1 = plans.find((p) => p.title === "组件A1")!;
	assert.match(compA1.content, /fileClass: 任务组件/);
	// 归属关系写在正文「# 对应批任务」章节，用双链引入批任务文档
	assert.match(compA1.content, /# 对应批任务/);
	assert.match(compA1.content, /\[\[8\.xxljob\/测试执行器\/任务\/任务A\|任务A\]\]/);
	assert.doesNotMatch(compA1.content, /对应批任务名称/);
	assert.match(compA1.content, /路由策略: 一致性hash/);
	assert.match(compA1.content, /阻塞处理策略: 丢弃后续调度/);
	assert.match(compA1.content, /jobBeanName: beanA1Job/);
	assert.match(compA1.content, /分片参数: 待确认/);
	assert.match(compA1.content, /涉及分页，pageSize=500/);
	// 来源信息不再写进正文，改由 plan 携带（供状态文件记录）
	assert.doesNotMatch(compA1.content, /# 来源信息/);
	assert.equal(compA1.source.jobId, "100");

	// 组件 A1 的 mermaid 使用画布 processClass
	assert.match(compA1.content, /B\[beanA1Job\]/);
});

/** 取文档正文（去掉 frontmatter） */
function bodyOf(content: string): string {
	return splitFrontmatter(content)?.body ?? content;
}

/** 取 frontmatter 原文 */
function fmOf(content: string): string {
	return splitFrontmatter(content)?.fm ?? "";
}

test("模板驱动：章节与模板完全一致", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const headingsOf = (content: string): string[] =>
		bodyOf(content)
			.split("\n")
			.filter((l) => /^#\s/.test(l))
			.map((l) => l.trim());

	// 任务流：模板只有「# 任务说明」
	const flow = plans.find((p) => p.kind === "任务流")!;
	assert.deepEqual(headingsOf(flow.content), ["# 任务说明"], flow.content);
	const flowTplHeadings = headingsOf(TEMPLATES.taskFlow ?? "");
	assert.deepEqual(headingsOf(flow.content), flowTplHeadings);

	// 批任务：归属章节排在任务说明之前；任务参数只在 frontmatter
	const taskA = plans.find((p) => p.title === "任务A")!;
	assert.deepEqual(headingsOf(taskA.content), ["# 对应任务流", "# 任务说明"], taskA.content);
	assert.match(taskA.content, /^任务参数: /m); // frontmatter 里有
	assert.doesNotMatch(taskA.content, /# 任务参数/);

	// 任务组件同理：# 对应批任务 在 # 任务说明 之前
	const compHeadings = headingsOf(plans.find((p) => p.title === "组件A1")!.content);
	assert.equal(compHeadings[0], "# 对应批任务");
	assert.equal(compHeadings[1], "# 任务说明");

	// 任务组件：六个章节与模板一致，顺序一致
	const compA1 = plans.find((p) => p.title === "组件A1")!;
	const tplHeadings = headingsOf(TEMPLATES.component ?? "");
	assert.deepEqual(headingsOf(compA1.content), tplHeadings, compA1.content);
	assert.ok(tplHeadings.includes("# 批任务防止重复调度机制"));

	// 三类文档都不再写来源信息
	for (const p of plans) assert.doesNotMatch(p.content, /# 来源信息/, p.path);
});

test("模板驱动：frontmatter 键顺序沿用模板", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const keysOf = (content: string): string[] =>
		fmOf(content)
			.split("\n")
			.map((l) => l.match(/^([^:]+):/)?.[1]?.trim())
			.filter((k): k is string => !!k);
	for (const [kind, tpl] of [
		["任务流", TEMPLATES.taskFlow],
		["批任务", TEMPLATES.task],
		["任务组件", TEMPLATES.component],
	] as const) {
		const plan = plans.find((p) => p.kind === kind)!;
		const tplKeys = keysOf(tpl ?? "");
		assert.deepEqual(keysOf(plan.content), tplKeys, `${kind} 键顺序应与模板一致`);
	}
});

test("模板驱动：无法推断的人工项保留填写提示，示例 mermaid 被替换", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const compA1 = plans.find((p) => p.title === "组件A1")!;
	// 无法从参数推断的业务范围：保留模板提示由人工填写
	assert.match(compA1.content, /\{\{：业务范围说明\}\}/);
	// 不能推断的：防重机制 / 外部接口 / 交易状态 保留模板提示
	assert.match(compA1.content, /\{\{：防重机制说明\}\}/);
	assert.match(compA1.content, /\{\{：说明如何防止重复调用外部接口\}\}/);
	assert.match(compA1.content, /\{\{：具体说明交易状态判断逻辑，避免交易状态错误判断\}\}/);
	assert.match(compA1.content, /\{\{：调用外部接口情况说明，需要罗列完整调用外部的接口\}\}/);
	// 模板里的示例图（华能信托批扣 / 有权限?）必须被替换掉
	assert.doesNotMatch(compA1.content, /华能信托批扣/);
	assert.doesNotMatch(compA1.content, /有权限\?/);
	assert.match(compA1.content, /B\[beanA1Job\]/);
	// 契约提示行来自模板
	assert.match(compA1.content, /本页维护当前契约/);
});

test("归属章节：批任务引入任务流、任务组件引入批任务（模板与回退两条路径）", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const withTpl = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const bare = buildImportPlans(tree, () => "测试执行器", { templates: {} });
	for (const [label, res] of [
		["模板", withTpl],
		["回退", bare],
	] as const) {
		const taskA = res.plans.find((p) => p.title === "任务A")!;
		const compA1 = res.plans.find((p) => p.title === "组件A1")!;
		const taskBody = bodyOf(taskA.content);
		const compBody = bodyOf(compA1.content);
		assert.match(taskBody, /# 对应任务流\n\n\[\[8\.xxljob\/测试执行器\/任务流\/主链路\|主链路\]\]/, `${label} 批任务: ${taskBody}`);
		assert.match(compBody, /# 对应批任务\n\n\[\[8\.xxljob\/测试执行器\/任务\/任务A\|任务A\]\]/, `${label} 任务组件: ${compBody}`);
		// frontmatter 里不再有归属键（已从 fileClass 移除）
		assert.doesNotMatch(fmOf(taskA.content), /对应任务流名称/, `${label} 批任务 fm`);
		assert.doesNotMatch(fmOf(compA1.content), /对应批任务名称/, `${label} 任务组件 fm`);
	}
	// 任务流文档没有归属章节（它是最上层）
	const flow = withTpl.plans.find((p) => p.kind === "任务流")!;
	assert.doesNotMatch(bodyOf(flow.content), /# 对应任务流/);
});

test("update 合并：清掉废弃键、补归属章节、保留手写正文", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const taskA = plans.find((p) => p.title === "任务A")!;
	const old = [
		"---",
		"fileClass: 批任务",
		"执行器: 测试执行器",
		"对应任务流名称: 主链路", // 已从 fileClass 移除的废弃键
		"任务名称: 任务A",
		"---",
		"",
		"# 任务说明",
		"",
		"手写补充：这段人工说明必须保留",
		"",
	].join("\n");
	const merged = mergePreservingBody(old, taskA.content);
	assert.doesNotMatch(merged, /对应任务流名称/, "废弃键应随 frontmatter 整体替换而消失");
	assert.match(merged, /手写补充：这段人工说明必须保留/);
	assert.match(bodyOf(merged), /# 对应任务流\n\n\[\[8\.xxljob\/测试执行器\/任务流\/主链路\|主链路\]\]/);

	// 旧的归属章节会被刷新（例如父级改了名字/位置）
	const stale = [
		"---",
		"fileClass: 批任务",
		"任务名称: 任务A",
		"---",
		"",
		"# 任务说明",
		"",
		"正文",
		"",
		"# 对应任务流",
		"",
		"[[8.xxljob/旧执行器/任务流/旧名称|旧名称]]",
		"",
	].join("\n");
	const refreshed = mergePreservingBody(stale, taskA.content);
	assert.doesNotMatch(refreshed, /旧执行器/);
	assert.match(bodyOf(refreshed), /\[\[8\.xxljob\/测试执行器\/任务流\/主链路\|主链路\]\]/);
	assert.match(refreshed, /# 任务说明/);

	// vault 里旧版导入的真实结构：归属章节是文末最后一个一级章节，且章节后还有手写内容。
	// 回归：刷新归属章节时不能把章节后的手写内容吞掉（曾因整节替换到文末而丢失）。
	const realShape = [
		"---",
		"fileClass: 批任务",
		"任务名称: 任务A",
		"---",
		"",
		"# 任务说明",
		"",
		"```mermaid",
		"graph TD",
		"```",
		"",
		"# 对应任务流",
		"",
		"[[8.xxljob/旧执行器/任务流/旧名称|旧名称]]",
		"",
		"<!-- 人工补充：这段要留住 -->",
		"",
	].join("\n");
	const realMerged = mergePreservingBody(realShape, taskA.content);
	assert.match(bodyOf(realMerged), /\[\[8\.xxljob\/测试执行器\/任务流\/主链路\|主链路\]\]/, "归属双链应刷新");
	assert.doesNotMatch(realMerged, /旧执行器/, "旧双链应被替换");
	assert.match(realMerged, /<!-- 人工补充：这段要留住 -->/, "归属章节后的手写内容必须保留");
	assert.match(realMerged, /# 任务说明/, "任务说明章节必须保留");
  assert.match(realMerged, /```mermaid/, "mermaid 块必须保留");
});

test("frontmatterBlock 只取笔记属性块", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const block = frontmatterBlock(plans[0].content);
	assert.ok(block.startsWith("---"), "应以 --- 开头");
	assert.ok(block.trimEnd().endsWith("---"), "应以 --- 结尾");
	assert.match(block, /fileClass:/);
	assert.doesNotMatch(block, /# 对应/, "不应含正文章节");
	assert.ok(block.length < plans[0].content.length, "应短于全文");
	assert.equal(frontmatterBlock("没有 frontmatter 的正文"), "");
});

test("frontmatterEntries 续行并入上一键", () => {
	const m = frontmatterEntries("a: 1\nb:\n  - x\n  - y\nc: 3");
	assert.equal(m.get("a"), "1");
	assert.equal(m.get("b"), "  - x\n  - y");
	assert.equal(m.get("c"), "3");
});

test("diffFrontmatter：属性级改动点（手工改后重导入可检出）", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const taskA = plans.find((p) => p.title === "任务A")!;
	assert.deepEqual(diffFrontmatter(taskA.content, taskA.content), [], "相同内容不应有改动点");
	const manual = taskA.content
		.replace(/^任务名称:.*$/m, "任务名称: 【蚂蚁星河-广州盛大】手工改过")
		.replace(/^fileClass: 批任务$/m, "fileClass: 批任务\n手写键: 保留我");
	const changes = diffFrontmatter(manual, taskA.content);
	const nameHit = changes.find((c) => c.key === "任务名称");
	assert.ok(nameHit, `应检出 任务名称 改动：${JSON.stringify(changes)}`);
	assert.equal(nameHit.type, "changed");
	assert.match(nameHit.oldValue!, /手工改过/);
	assert.doesNotMatch(String(nameHit.newValue), /手工改过/);
	assert.ok(changes.some((c) => c.key === "手写键" && c.type === "removed"), "手工新增的键应报删除");
	assert.equal(changes.find((c) => c.key === "执行器"), undefined, "未变的键不应出现");
});

test("frontmatterToMarkdown：阅读模式列表 + 改动点行内标注", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: TEMPLATES });
	const taskA = plans.find((p) => p.title === "任务A")!;
	// 无改动：纯 `键：值` 列表，不含 YAML 源码痕迹
	const plain = frontmatterToMarkdown(taskA.content);
	assert.doesNotMatch(plain, /^---$/m, "不应再输出 --- 分隔线");
	assert.match(plain, /^- \*\*任务名称\*\*：/m, "应为 markdown 列表且键加粗");
	assert.doesNotMatch(plain, /~~/, "无改动时不应有删除线");

	const manual = taskA.content
		.replace(/^任务名称:.*$/m, "任务名称: 【蚂蚁星河-广州盛大】手工改过")
		.replace(/^fileClass: 批任务$/m, "fileClass: 批任务\n手写键: 保留我");
	const changes = diffFrontmatter(manual, taskA.content);
	const md = frontmatterToMarkdown(taskA.content, changes);
	// 修改：旧值删除线 → 新值加粗
	assert.match(md, /^- \*\*任务名称\*\*：~~.*手工改过.*~~ → \*\*/m, "修改键应标出 旧值删除线 → 新值");
	// 删除的手写键追在末尾，提示会被覆盖清除
	assert.ok(md.indexOf("手写键") > md.indexOf("任务名称"), "删除键应排在末尾");
	assert.match(md, /\*\*手写键\*\*：~~保留我~~/, "删除键应只有旧值删除线");
	// 未改动的键保持原样
	assert.doesNotMatch(md.split("手写键")[0], /\*\*执行器\*\*：~~/, "未改动键不应被标成改动");
	assert.equal(frontmatterToMarkdown("没有 frontmatter"), "");
});

test("frontmatterToMarkdown：空值与多行值", () => {
	const md = frontmatterToMarkdown("---\na: \nb:\n  - x\n  - y\n---\n正文");
	assert.match(md, /\*\*a\*\*：（空）/, "空值用「（空）」占位");
	assert.match(md, /\*\*b\*\*：\n?\s*- x/, "多行值缩进续行");
});

test("normalizeFmScalar：YAML 引号风格归一化", () => {
	// 同一份 JSON 的两种 YAML 写法，归一化后应完全一致
	const single = `'{"dayOffset":"-1","BIZ_MODE":["MYXH"]}'`;
	const double = `"{\\"dayOffset\\":\\"-1\\",\\"BIZ_MODE\\":[\\"MYXH\\"]}"`;
	assert.notEqual(single, double, "前置：两种写法文本不同");
	assert.equal(normalizeFmScalar(single), normalizeFmScalar(double), "归一化后应相等");
	assert.equal(normalizeFmScalar(single), '{"dayOffset":"-1","BIZ_MODE":["MYXH"]}');
	// 普通标量不受影响
	assert.equal(normalizeFmScalar("批任务"), "批任务");
	assert.equal(normalizeFmScalar(""), "");
	// 单引号内的 '' 表示一个引号
	assert.equal(normalizeFmScalar("'a''b'"), "a'b");
	// 多行值（续行列表）不被引号包裹：只 trim 首尾，续行缩进保留
	assert.equal(normalizeFmScalar("  - x\n  - y"), "- x\n  - y");
});

test("diffFrontmatter：引号风格不同不算改动（任务参数不再每次都报）", () => {
	const key = (q: string) => `---\nfileClass: 批任务\n任务参数: ${q}\n---\n\n# 任务说明\n`;
	const oldStyle = key(`'{"dayOffset":"-1","TENANT_ID":"000"}'`);
	const newStyle = key(`"{\\"dayOffset\\":\\"-1\\",\\"TENANT_ID\\":\\"000\\"}"`);
	assert.deepEqual(diffFrontmatter(oldStyle, newStyle), [], "仅引号风格不同不应报改动");
	// 内容真的变了仍要检出
	const realChange = diffFrontmatter(oldStyle, key(`"{\\"dayOffset\\":\\"1\\",\\"TENANT_ID\\":\\"000\\"}"`));
	const hit = realChange.find((c) => c.key === "任务参数");
	assert.ok(hit && hit.type === "changed", `dayOffset 变了应报改动：${JSON.stringify(realChange)}`);
	assert.ok(String(hit?.oldValue).includes('"dayOffset":"-1"'), "旧值应是归一化后的可读 JSON");
	assert.ok(String(hit?.newValue).includes('"dayOffset":"1"'), "新值应是归一化后的可读 JSON");
});

test("无模板时回退内置结构", () => {
	const tree = buildFlowTree([parseXxlXml(synthetic)]);
	const { plans } = buildImportPlans(tree, () => "测试执行器", { templates: {} });
	assert.equal(plans.length, 6);
	const taskA = plans.find((p) => p.title === "任务A")!;
	assert.match(taskA.content, /fileClass: 批任务/);
	assert.doesNotMatch(taskA.content, /# 来源信息/);
	assert.doesNotMatch(taskA.content, /# 任务参数/); // 回退结构也不再写任务参数表格
	assert.match(taskA.content, /# 任务说明/);
});

test("合成样例：雪花 ID 精度保持（字符串处理）", () => {
	const long = "1267443418091716608";
	// 注意：JSON 在 XML 里是 &quot; 转义形式，替换需匹配转义后的写法
	const xml = synthetic
		.replace(/<triggerId>10<\/triggerId>/g, `<triggerId>${long}</triggerId>`)
		.replace("<id>10</id>", `<id>${long}</id>`)
		.replace(/&quot;triggerId&quot;:10,/g, `&quot;triggerId&quot;:${long},`);
	const r = parseXxlXml(xml);
	const main = r.jobs.find((j) => j.id === "1")!;
	assert.ok(main.childrenIds.includes(long), `childrenIds=${main.childrenIds}`);
	const parsed = r.jobs.find((j) => j.id === long);
	assert.ok(parsed, "长 ID 任务存在");
	assert.equal(parsed!.level, "VIRTUAL");
});

// ---------- 真实样例（fixture 在仓库外，缺失则跳过） ----------

const hasA = existsSync(FIX_A);
const hasB = existsSync(FIX_B);

test("真实样例A：担保函链路（无 MAIN，顶层 VIRTUAL → 2 组件）", { skip: !hasA && "fixture 不存在" }, () => {
	const r = parseXxlXml(readFileSync(FIX_A, "utf-8"), FIX_A);
	assert.equal(r.jobs.length, 3);
	assert.equal(r.jobGroups[0], "1120");
	const tree = buildFlowTree([r]);
	assert.equal(tree.roots.length, 1);
	assert.equal(tree.roots[0].level, "VIRTUAL");
	const gen = r.jobs.find((j) => j.jobDesc === "担保函生成任务组件")!;
	assert.equal(gen.processClass, "letterOfGuaranteeGenerateJob");
	const { plans } = buildImportPlans(tree, () => "通用保险执行器", { templates: TEMPLATES });
	assert.equal(plans.length, 3);
	const up = plans.find((p) => p.title === "担保函上传任务组件")!;
	assert.match(up.content, /jobBeanName: letterOfGuaranteeUploadJob/);
	// 顶层 VIRTUAL（链路入口）没有任务流：正文「# 对应任务流」标待确认
	const task = plans.find((p) => p.kind === "批任务")!;
	assert.match(bodyOf(task.content), /# 对应任务流\n\n待确认（链路入口，暂无所属任务流）/);
});

test("真实样例B：账务文件链路（MAIN → 3 任务 → 3 组件）", { skip: !hasB && "fixture 不存在" }, () => {
	const r = parseXxlXml(readFileSync(FIX_B, "utf-8"), FIX_B);
	assert.equal(r.jobs.length, 7);
	const main = r.jobs.find((j) => j.level === "MAIN")!;
	assert.equal(main.cron, "0 15/20 4-20 * * ?");
	assert.equal(main.childrenIds.length, 3);
	assert.equal(main.alarmMobile, "17887285283");
	const tree = buildFlowTree([r]);
	assert.equal(tree.roots.length, 1);
	const { plans, warnings } = buildImportPlans(tree, () => "通用保险执行器", { templates: TEMPLATES });
	assert.equal(plans.length, 7);
	// MAIN 的 mermaid 引用三个任务
	const flow = plans.find((p) => p.kind === "任务流")!;
	assert.match(flow.content, /任务\/【蚂蚁星河-广州盛大】账务文件-数据加工/);
	assert.match(flow.content, /任务\/【蚂蚁星河-广州盛大】账务文件-文件上传/);
	// 批任务正文回链任务流
	const task = plans.find((p) => p.title === "【蚂蚁星河-广州盛大】账务文件-数据加工")!;
	assert.match(
		bodyOf(task.content),
		/# 对应任务流\n\n\[\[8\.xxljob\/通用保险执行器\/任务流\/【蚂蚁星河-广州盛大】账务文件-加工生成及上传\|【蚂蚁星河-广州盛大】账务文件-加工生成及上传\]\]/,
	);
	// jobBeanName 是任务组件级字段：在数据加工组件文档上断言
	const dataComp = plans.find((p) => p.title === "【账务文件配置】数据加工")!;
	assert.match(
		bodyOf(dataComp.content),
		/# 对应批任务\n\n\[\[8\.xxljob\/通用保险执行器\/任务\/【蚂蚁星河-广州盛大】账务文件-数据加工\|【蚂蚁星河-广州盛大】账务文件-数据加工\]\]/,
	);
	assert.match(dataComp.content, /jobBeanName: assetfileProcessJob/);
	// 组件回链批任务
	const comps = plans.filter((p) => p.kind === "任务组件");
	assert.ok(
		comps.every((c) => /# 对应批任务\n\n\[\[8\.xxljob\/通用保险执行器\/任务\//.test(bodyOf(c.content))),
		comps.map((c) => c.title).join(","),
	);
	// 未识别枚举警告为 0（样例枚举均在映射表内）
	assert.equal(warnings.filter((w) => w.includes("未识别")).length, 0, warnings.join("; "));
});

test("真实样例：A+B 合并导入（跨文件去重）", { skip: !hasA || !hasB && "fixture 不存在" }, () => {
	const ra = parseXxlXml(readFileSync(FIX_A, "utf-8"), FIX_A);
	const rb = parseXxlXml(readFileSync(FIX_B, "utf-8"), FIX_B);
	const tree = buildFlowTree([ra, rb]);
	assert.equal(tree.jobs.length, 10); // 3 + 7
	const { plans } = buildImportPlans(tree, () => "通用保险执行器", { templates: TEMPLATES });
	assert.equal(plans.length, 10);
	// 两条独立链路，roots 应为 2（B 的 MAIN + A 的顶层 VIRTUAL）
	assert.equal(tree.roots.length, 2);
});

test("resolveJobBeanName 回退 executorParam.executeBeanName", () => {
	const r = parseXxlXml(synthetic);
	const taskA = r.jobs.find((j) => j.id === "10")!;
	assert.equal(resolveJobBeanName(taskA), undefined); // 任务层无 processClass
});
