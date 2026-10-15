// xxl-job 导出 XML 的统一数据模型（解析层输出）
import type { FrontmatterChange } from "./frontmatter";

export type XxlLevel = "MAIN" | "VIRTUAL" | "COMPONENT";

export interface FlowNode {
	triggerId: string; // 子任务的 xxlJobInfo.id（雪花 ID，按字符串处理避免精度丢失）
	label: string; // 画布节点文字
	nodeId: string; // 画布内部节点 id（edges 用它连线）
}

export interface FlowEdge {
	source: string;
	target: string;
}

export interface CanvasNode {
	id: string;
	label: string;
	dataType: string;
	processClass?: string;
}

export interface CanvasGraph {
	nodes: CanvasNode[];
	edges: FlowEdge[];
}

export interface ParsedJob {
	id: string;
	level: XxlLevel;
	jobDesc: string;
	jobGroup?: string;
	cron?: string;
	author?: string;
	alarmMobile?: string;
	addTime?: string;
	updateTime?: string;
	executorParam?: string;
	paramJson?: Record<string, unknown>;
	paramError?: string;
	routeStrategy?: string;
	blockStrategy?: string;
	misfireStrategy?: string;
	executeBizDateType?: string;
	triggerStatus?: string;
	yrJobName?: string; // yrJobInfo.name（任务组件名称）
	processClass?: string; // jobInfo 画布中的业务 Bean
	taskFlow?: { nodes: FlowNode[]; edges: FlowEdge[] }; // MAIN/VIRTUAL：编排画布
	canvas?: CanvasGraph; // COMPONENT：组件内流程画布
	childrenIds: string[];
	sourceFile: string;
}

export interface ParseResult {
	jobs: ParsedJob[];
	warnings: string[];
	jobGroups: string[];
}

export type DocKind = "任务流" | "批任务" | "任务组件";

/** 导入来源信息：不再写进文档正文，交给状态文件记录 */
export interface SourceInfo {
	jobId: string;
	sourceFile: string;
	author?: string;
	addTime?: string;
	updateTime?: string;
	alarmMobile?: string;
}

export interface FilePlan {
	path: string; // 相对 vault 根，如 8.xxljob/<执行器>/任务/xxx.md
	content: string;
	kind: DocKind;
	title: string; // 文档名（文件名去 .md）
	jobId: string;
	source: SourceInfo;
	/**
	 * 宿主分析阶段挂上的属性级改动点（对比已存在文档得出）。
	 * 不给值 = 未比对；applyPlans 的 smartSkip 靠它判断「有改动就更新」。
	 */
	changes?: FrontmatterChange[];
}
