// 端到端干跑：用真实 XML 跑完整链路（解析 → 映射 → 生成），把文档写到本地暂存目录（不进 vault）。
// 不加 --write 时只打印计划；加 --write 才落盘。重复执行同一目录可验证冲突策略。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseXxlXml } from "../src/xxljob/parser";
import { buildFlowTree } from "../src/xxljob/mapping";
import { buildImportPlans } from "../src/xxljob/writer";
import { guessExecutorFromFileName, sanitizeExecutorDir } from "../src/xxljob/executors";
import { mergePreservingBody } from "../src/xxljob/writer";
import type { ParsedJob } from "../src/xxljob/types";

const args = process.argv.slice(2);
const write = args.includes("--write");
const policyArg = args.find((a) => a.startsWith("--policy="))?.split("=")[1] ?? "skip";
const outArg = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? ".dryrun";
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
	console.error("用法：node scripts/dryrun.mjs <xml 路径...> [--write] [--policy=skip|update|rename] [--out=.dryrun]");
	process.exit(1);
}

const outRoot = resolve(outArg);
const docsFolder = "8.xxljob";

// 模板：默认用仓库内 templates 的副本；--templates=<dir> 可指定目录（如真实 vault 的 _template 目录）
const tplArg = args.find((a) => a.startsWith("--templates="))?.split("=")[1] ?? "templates";
const tplDir = resolve(tplArg);
const readTpl = (name: string): string | undefined => {
	const p = join(tplDir, name);
	return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
};
const templates = {
	taskFlow: readTpl("xxljob-任务流-renwuliu.md"),
	task: readTpl("xxljob-批任务-pirenwu.md"),
	component: readTpl("xxljob-任务组件-renwuzujian.md"),
};
console.log(
	`模板：任务流 ${templates.taskFlow ? "已加载" : "缺失"} · 批任务 ${templates.task ? "已加载" : "缺失"} · 任务组件 ${templates.component ? "已加载" : "缺失"}（目录 ${tplDir}）`,
);

const parsed = files.map((f) => ({
	file: f,
	name: f.split("/").pop() ?? f,
	result: parseXxlXml(readFileSync(f, "utf-8"), f),
}));

for (const p of parsed) {
	console.log(`文件 ${p.name}：任务 ${p.result.jobs.length} 个，jobGroup ${p.result.jobGroups.join("/") || "(无)"}`);
	for (const w of p.result.warnings) console.log(`  警告：${w}`);
}

const tree = buildFlowTree(parsed.map((p) => p.result));
const executorByFile = new Map(parsed.map((p) => [p.name, guessExecutorFromFileName(p.name)]));
const executorFor = (job: ParsedJob): string =>
	sanitizeExecutorDir(executorByFile.get(job.sourceFile.split("/").pop() ?? job.sourceFile) ?? "未命名执行器");

const { plans, warnings } = buildImportPlans(tree, executorFor, { docsFolder, templates });
console.log(`\n计划生成 ${plans.length} 份文档，警告 ${warnings.length} 条`);
for (const w of warnings) console.log(`  警告：${w}`);

let created = 0;
let updated = 0;
let renamed = 0;
let skipped = 0;

for (const plan of plans) {
	const target = join(outRoot, plan.path);
	if (write) {
		mkdirSync(dirname(target), { recursive: true });
		if (!existsSync(target)) {
			writeFileSync(target, plan.content, "utf-8");
			created += 1;
		} else if (policyArg === "skip") {
			skipped += 1;
		} else if (policyArg === "update") {
			writeFileSync(target, mergePreservingBody(readFileSync(target, "utf-8"), plan.content), "utf-8");
			updated += 1;
		} else {
			let i = 2;
			let alt = target;
			while (existsSync(alt)) {
				alt = target.replace(/\.md$/, ` (${i}).md`);
				i += 1;
			}
			writeFileSync(alt, plan.content, "utf-8");
			renamed += 1;
		}
	} else {
		console.log(`  [${plan.kind}] ${plan.path}`);
	}
}

console.log(`\n结果：新建 ${created} · 更新 ${updated} · 副本 ${renamed} · 跳过 ${skipped}`);
if (write) console.log(`落盘目录：${outRoot}`);
