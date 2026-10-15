import type { CanvasGraph, FlowEdge, FlowNode, ParseResult, ParsedJob, XxlLevel } from "./types";
import { asText } from "./util";

/** XML 实体反转义 */
export function unescapeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function extractBlock(text: string, tag: string): string | undefined {
	const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return m ? m[1] : undefined;
}

function extractField(block: string, tag: string): string | undefined {
	const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	if (!m) return undefined;
	const v = unescapeXml(m[1].trim());
	return v.length > 0 ? v : undefined;
}

/** 雪花 ID 超过 JS Number 安全范围，先给长数字加引号再 parse，保证按字符串处理 */
function parseJsonPreserveLongIds(raw: string): Record<string, unknown> {
	const safe = raw.replace(/("triggerId"\s*:\s*)(\d{15,})/g, '$1"$2"');
	return JSON.parse(safe) as Record<string, unknown>;
}

function parseFlowInfo(raw: string): { nodes: FlowNode[]; edges: FlowEdge[] } | undefined {
	try {
		const obj = parseJsonPreserveLongIds(raw);
		const nodes: FlowNode[] = [];
		for (const n of (obj.nodes as Record<string, unknown>[]) ?? []) {
			if (n.type !== "node") continue; // 只收任务节点
			const triggerId = asText(n.triggerId);
			if (!triggerId) continue;
			nodes.push({
				triggerId,
				label: asText(n.label ?? triggerId),
				nodeId: asText(n.id ?? triggerId),
			});
		}
		const edges: FlowEdge[] = [];
		for (const e of (obj.edges as Record<string, unknown>[]) ?? []) {
			const source = asText(e.source);
			const target = asText(e.target);
			if (source && target) edges.push({ source, target });
		}
		return { nodes, edges };
	} catch {
		return undefined;
	}
}

function parseCanvas(raw: string): CanvasGraph | undefined {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const nodes = [];
		for (const n of (obj.nodes as Record<string, unknown>[]) ?? []) {
			nodes.push({
				id: asText(n.id),
				label: asText(n.label ?? n.name),
				dataType: asText(n.dataType),
				processClass:
					typeof n.processClass === "string" && n.processClass.trim().length > 0
						? n.processClass.trim()
						: undefined,
			});
		}
		const edges = [];
		for (const e of (obj.edges as Record<string, unknown>[]) ?? []) {
			const source = asText(e.source);
			const target = asText(e.target);
			if (source && target) edges.push({ source, target });
		}
		return { nodes, edges };
	} catch {
		return undefined;
	}
}

function classify(jobInfoBlock: string, triggerBlock?: string): XxlLevel {
	const explicit = extractField(jobInfoBlock, "jobLevelType");
	if (explicit === "MAIN_TRIGGER_JOB") return "MAIN";
	if (explicit === "VIRTUAL_JOB") return "VIRTUAL";
	if (explicit === "COMPONENT_JOB") return "COMPONENT";
	// 回退：按字段存在性判定
	if (extractBlock(jobInfoBlock, "yrJobInfo") || /<yrJobInfo>/.test(jobInfoBlock)) return "COMPONENT";
	if (triggerBlock) {
		return extractField(jobInfoBlock, "jobCron") ? "MAIN" : "VIRTUAL";
	}
	return "COMPONENT";
}

/**
 * 解析 xxl-job 导出的任务 XML（<linked-list>/<job> 结构）。
 * 返回统一模型 + 警告清单；单条任务解析失败不阻断整批。
 */
export function parseXxlXml(xml: string, sourceFile = ""): ParseResult {
	const warnings: string[] = [];
	const jobs: ParsedJob[] = [];
	const seen = new Set<string>();
	const jobGroups = new Set<string>();

	const rootMatch = xml.match(/<linked-list>[\s\S]*<\/linked-list>/);
	if (!rootMatch) {
		return { jobs: [], warnings: ["不是 xxl-job 任务导出格式（缺少 <linked-list> 根元素）"], jobGroups: [] };
	}

	const jobBlocks = rootMatch[0].match(/<job>[\s\S]*?<\/job>/g) ?? [];
	for (const jobBlock of jobBlocks) {
		try {
			const jobInfoBlock = extractBlock(jobBlock, "xxlJobInfo");
			if (!jobInfoBlock) {
				warnings.push(`${sourceFile}: 存在不含 xxlJobInfo 的 job 节点，已跳过`);
				continue;
			}
			const id = extractField(jobInfoBlock, "id");
			const jobDesc = extractField(jobInfoBlock, "jobDesc") ?? "";
			if (!id) {
				warnings.push(`${sourceFile}: 任务「${jobDesc || "(无 jobDesc)"}」缺少 id，已跳过`);
				continue;
			}
			if (seen.has(id)) {
				warnings.push(`${sourceFile}: 任务 id ${id}（${jobDesc}）重复出现，已去重`);
				continue;
			}
			seen.add(id);

			const level = classify(jobInfoBlock, extractBlock(jobBlock, "yrTriggerInfo"));
			const jobGroup = extractField(jobInfoBlock, "jobGroup");
			if (jobGroup) jobGroups.add(jobGroup);

			const executorParam = extractField(jobInfoBlock, "executorParam");
			let paramJson: Record<string, unknown> | undefined;
			let paramError: string | undefined;
			if (executorParam) {
				try {
					paramJson = JSON.parse(executorParam) as Record<string, unknown>;
				} catch (e) {
					paramError = `executorParam 非法 JSON：${e instanceof Error ? e.message : String(e)}`;
					warnings.push(`${sourceFile}: 任务「${jobDesc}」${paramError}，参数原样保留`);
				}
			}

			const yrJobInfoBlock = extractBlock(jobBlock, "yrJobInfo");
			const yrJobName = yrJobInfoBlock ? extractField(yrJobInfoBlock, "name") : undefined;

			// processClass：优先 yrJobInfo.jobInfo 画布，回退 xxlJobInfo.jobInfo
			let processClass: string | undefined;
			const canvasRaw = (yrJobInfoBlock ? extractField(yrJobInfoBlock, "jobInfo") : undefined)
				?? extractField(jobInfoBlock, "jobInfo");
			let canvas: CanvasGraph | undefined;
			if (canvasRaw) {
				canvas = parseCanvas(canvasRaw);
				const rect = canvas?.nodes.find((n) => n.dataType === "rect" && n.processClass);
				processClass = rect?.processClass;
			}

			const triggerBlock = extractBlock(jobBlock, "yrTriggerInfo");
			let taskFlow: { nodes: FlowNode[]; edges: FlowEdge[] } | undefined;
			const flowRaw = triggerBlock ? extractField(triggerBlock, "taskFlowInfo") : undefined;
			if (flowRaw) {
				taskFlow = parseFlowInfo(flowRaw);
				if (!taskFlow) {
					warnings.push(`${sourceFile}: 任务「${jobDesc}」的 taskFlowInfo 解析失败，依赖关系不可用`);
				}
			}

			jobs.push({
				id,
				level,
				jobDesc,
				jobGroup,
				cron: extractField(jobInfoBlock, "jobCron"),
				author: extractField(jobInfoBlock, "author"),
				alarmMobile: extractField(jobInfoBlock, "alarmMobile"),
				addTime: extractField(jobInfoBlock, "addTime"),
				updateTime: extractField(jobInfoBlock, "updateTime"),
				executorParam,
				paramJson,
				paramError,
				routeStrategy: extractField(jobInfoBlock, "executorRouteStrategy"),
				blockStrategy: extractField(jobInfoBlock, "executorBlockStrategy"),
				misfireStrategy: extractField(jobInfoBlock, "misfireStrategy"),
				executeBizDateType: extractField(jobInfoBlock, "executeBizDateType"),
				triggerStatus: extractField(jobInfoBlock, "triggerStatus"),
				yrJobName,
				processClass,
				taskFlow,
				canvas,
				childrenIds: taskFlow ? taskFlow.nodes.map((n) => n.triggerId) : [],
				sourceFile,
			});
		} catch (e) {
			warnings.push(`${sourceFile}: 单个任务解析失败已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	if (jobs.length === 0) {
		warnings.push(`${sourceFile}: 未解析到任何任务节点`);
	}
	return { jobs, warnings, jobGroups: [...jobGroups] };
}
