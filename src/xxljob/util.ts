/** 把 JSON/未知值稳妥转成字符串：对象走 JSON.stringify，避免 [object Object] */
export function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
