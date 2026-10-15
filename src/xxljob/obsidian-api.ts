/**
 * obsidian API 注入层 —— bundle 内**不出现任何 require('obsidian')**。
 *
 * 背景：bundle 作为插件子模块加载时，Obsidian 渲染进程对子模块里
 * `require('obsidian')` 的解析不可靠（会一路解析到 electron.asar，
 * 抛 "Invalid package .../electron.asar"）。因此由宿主（Schema Studio 的
 * main.js）在执行 bundle 前把 API 挂到全局 `__schemaStudioObsidian`，
 * 这里统一从全局取用；Node 测试环境没有宿主注入时，回退到常规
 * require（由 Module._load 桩件承接，见 scripts/bundle-check.mjs）。
 *
 * 同名类型经 `export type` 一并重导出，调用方 `import { TFile } from "./obsidian-api"`
 * 同时拿到值与类型，和直接 `import { TFile } from "obsidian"` 语义一致。
 */
import type {
	Modal as ModalT,
	Notice as NoticeT,
	Plugin as PluginT,
	PluginSettingTab as PluginSettingTabT,
	Setting as SettingT,
	TFile as TFileT,
	normalizePath as normalizePathT,
} from "obsidian";

// 同名类型别名 + 同名值导出（声明空间不同，可合并），调用方 import { TFile } 同时拿到值与类型
export type App = import("obsidian").App;
export type Modal = ModalT;
export type Notice = NoticeT;
export type Plugin = PluginT;
export type PluginSettingTab = PluginSettingTabT;
export type Setting = SettingT;
export type TFile = TFileT;

const GLOBAL_KEY = "__schemaStudioObsidian";

function resolveApi(): Record<string, unknown> {
	const injected = (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
	if (injected && typeof injected === "object") {
		return injected as Record<string, unknown>;
	}
	try {
		// 测试环境兜底：bundle-check.mjs 用 Module._load 拦截 require('obsidian')
		return require("obsidian") as Record<string, unknown>;
	} catch {
		return {};
	}
}

const api = resolveApi();

export const Modal: typeof ModalT = api.Modal as typeof ModalT;
export const Notice: typeof NoticeT = api.Notice as typeof NoticeT;
export const Setting: typeof SettingT = api.Setting as typeof SettingT;
export const TFile: typeof TFileT = api.TFile as typeof TFileT;
export const Plugin: typeof PluginT = api.Plugin as typeof PluginT;
export const PluginSettingTab: typeof PluginSettingTabT =
	api.PluginSettingTab as typeof PluginSettingTabT;
export const normalizePath: typeof normalizePathT =
	api.normalizePath as typeof normalizePathT;
