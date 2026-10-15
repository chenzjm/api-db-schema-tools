import type { DocKind, ParseResult, ParsedJob } from "./types";
import { asText } from "./util";

// ---------- 枚举转换表（XML 英文值 → fileClass 中文枚举） ----------

export const ROUTE_MAP: Record<string, string> = {
	FIRST: "第一个",
	LAST: "最后一个",
	ROUND: "轮询",
	RANDOM: "随机",
	CONSISTENT_HASH: "一致性hash",
	LFU: "最不经常使用",
	LRU: "最近最久未使用",
	FAILOVER: "故障转移",
	BUSYOVER: "忙碌转移",
	SHARDING_BROADCAST: "分片广播",
};

export const BLOCK_MAP: Record<string, string> = {
	SERIAL_EXECUTION: "单机串行",
	DISCARD_LATER: "丢弃后续调度",
	COVER_EARLY: "覆盖之前调度",
};

export const MISFIRE_MAP: Record<string, string> = {
	DO_NOTHING: "忽略",
	FIRE_ONCE_NOW: "立即执行一次",
};

export const BIZDATE_MAP: Record<string, string> = {
	TODAY: "今天",
	YESTERDAY: "昨天",
};

/** 枚举转换：未识别值原样返回（由调用方决定是否警告） */
export function mapEnum(map: Record<string, string>, value?: string): string | undefined {
	if (value === undefined) return undefined;
	return map[value] ?? value;
}

/** 任务组件的分片参数：从 executorParam 的分片相关键提取，XML 无独立字段 */
export function extractShardingParam(paramJson?: Record<string, unknown>): string | undefined {
	if (!paramJson) return undefined;
	for (const key of ["shardingVal", "SHARDING_VAL", "shardingParam", "SHARDING_PARAM", "SHARDING_INDEX", "shardingIndex"]) {
		const v = paramJson[key];
		if (v !== undefined && v !== "") return asText(v);
	}
	return undefined;
}

// ---------- 层级树（n 元：任务流→n 任务→n 任务组件） ----------

export interface FlowTree {
	/** 全部任务（含去重） */
	jobs: ParsedJob[];
	/** id → job */
	byId: Map<string, ParsedJob>;
	/** 子任务 id → 父任务 id（一个子任务只挂一个父；多个父引用时记警告） */
	parentOf: Map<string, string>;
	/** 顶层入口（未被任何任务引用的 MAIN/VIRTUAL） */
	roots: ParsedJob[];
	warnings: string[];
}

export function levelToDocKind(level: ParsedJob["level"]): DocKind {
	if (level === "MAIN") return "任务流";
	if (level === "VIRTUAL") return "批任务";
	return "任务组件";
}

export function levelToDirName(kind: DocKind): string {
	if (kind === "任务流") return "任务流";
	if (kind === "批任务") return "任务";
	return "任务组件";
}

/**
 * 把一次（或多次合并）解析结果构建成父子树。
 * 父子关系来自父任务的 taskFlowInfo.nodes[].triggerId；引用了不存在的任务时记警告。
 */
export function buildFlowTree(results: ParseResult[]): FlowTree {
	const warnings: string[] = [];
	const jobs: ParsedJob[] = [];
	const byId = new Map<string, ParsedJob>();
	const seen = new Set<string>();
	for (const r of results) {
		for (const j of r.jobs) {
			if (seen.has(j.id)) continue;
			seen.add(j.id);
			jobs.push(j);
			byId.set(j.id, j);
		}
	}

	const parentOf = new Map<string, string>();
	for (const j of jobs) {
		for (const childId of j.childrenIds) {
			const child = byId.get(childId);
			if (!child) {
				warnings.push(`任务「${j.jobDesc}」引用的子任务 ${childId} 不在本批文件中，该依赖边跳过`);
				continue;
			}
			if (parentOf.has(childId) && parentOf.get(childId) !== j.id) {
				warnings.push(`任务「${child.jobDesc}」被多个父任务引用（${byId.get(parentOf.get(childId)!)?.jobDesc} 与 ${j.jobDesc}），以首个为准`);
				continue;
			}
			parentOf.set(childId, j.id);
		}
	}

	const roots = jobs.filter((j) => !parentOf.has(j.id) && (j.level === "MAIN" || j.level === "VIRTUAL"));
	return { jobs, byId, parentOf, roots, warnings };
}

/** 批任务（VIRTUAL）的所属任务流名称；无父时返回 undefined（入口任务） */
export function parentTaskFlowName(tree: FlowTree, job: ParsedJob): string | undefined {
	const parentId = tree.parentOf.get(job.id);
	if (!parentId) return undefined;
	return tree.byId.get(parentId)?.jobDesc;
}

/** 任务组件的所属批任务名称：直接父层（VIRTUAL）；若被 MAIN 直接引用则用 MAIN 名称 */
export function parentTaskName(tree: FlowTree, job: ParsedJob): string | undefined {
	const parentId = tree.parentOf.get(job.id);
	if (!parentId) return undefined;
	const parent = tree.byId.get(parentId);
	if (!parent) return undefined;
	return parent.jobDesc;
}

/**
 * jobName/jobBeanName 口径：stepList[].processClass → executorParam.executeBeanName → undefined
 * 注：画布节点上的 processClass 即业务 Bean（样例中 stepList 与画布 rect 节点等价）。
 */
export function resolveJobBeanName(job: ParsedJob): string | undefined {
	if (job.processClass) return job.processClass;
	const bean = job.paramJson?.["executeBeanName"];
	if (typeof bean === "string" && bean.length > 0) return bean;
	return undefined;
}

/** 文件名净化：替换 Obsidian/文件系统不允许字符 */
export function sanitizeFileName(name: string): string {
	return name.replace(/[/\\:*?"<>|#^[\]]/g, "-").trim();
}
