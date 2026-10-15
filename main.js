'use strict';
const path = require('path');
const {
  Plugin, Modal, Notice, Setting, PluginSettingTab, TFile, EditorSuggest, normalizePath, stringifyYaml, setIcon,
  MarkdownRenderer, Component
} = require('obsidian');
// xxl-job XML 导入子模块：由本仓库 src/xxljob/ 构建产出，产物 xxljob-bundle.cjs 不入库。
// bundle 内部不再 require('obsidian')（Obsidian 对插件子模块的 require 解析不可靠，会一路
// 解析到 electron.asar 抛 Invalid package）——宿主先把 API 挂到全局 __schemaStudioObsidian，
// bundle 统一从全局取。没构建 / 加载失败时整个 xxl-job 域自动降级，不影响接口 / 数据库两条链路。
const XXL_OBSIDIAN_KEY = '__schemaStudioObsidian';
let xxl = null;
let xxlLoadError = '';
let xxlLoadLog = [];
function xxlErrText(e) { return (e && (e.message || String(e))) || String(e); }
function ensureXxlGlobal() {
  if (!globalThis[XXL_OBSIDIAN_KEY]) {
    globalThis[XXL_OBSIDIAN_KEY] = { Plugin, Modal, Notice, Setting, PluginSettingTab, TFile, EditorSuggest, normalizePath, stringifyYaml, setIcon };
  }
  return globalThis[XXL_OBSIDIAN_KEY];
}
function evalXxlSource(src, dirHint) {
  const api = ensureXxlGlobal();
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', src);
  const fakeRequire = (name) => {
    if (name === 'obsidian') return api;
    throw new Error('xxljob-bundle 请求了宿主未提供的模块：' + name);
  };
  fn(fakeRequire, mod, mod.exports, dirHint || '', dirHint ? dirHint + '/xxljob-bundle.cjs' : 'xxljob-bundle.cjs');
  return mod.exports;
}
function xxlCandidateDirs() {
  const dirs = [];
  if (typeof __dirname !== 'undefined' && __dirname) dirs.push(__dirname);
  try {
    if (module && module.filename) {
      const d = path.dirname(module.filename);
      if (dirs.indexOf(d) === -1) dirs.push(d);
    }
  } catch (e) { /* 忽略 */ }
  return dirs;
}
function loadXxlBundle(extraDir) {
  const log = [];
  const dirs = [];
  if (extraDir && dirs.indexOf(extraDir) === -1) dirs.push(extraDir);
  for (const d of xxlCandidateDirs()) if (dirs.indexOf(d) === -1) dirs.push(d);
  // 1) 常规 require：bundle 内已无 require('obsidian')，相对路径解析正常时这条路最快
  try {
    ensureXxlGlobal();
    const m = require('./xxljob-bundle.cjs');
    if (m && typeof m === 'object' && Object.keys(m).length) return { mod: m, log: ['require: 成功'] };
    log.push('require: 返回空模块');
  } catch (e) { log.push('require: ' + xxlErrText(e)); }
  // 2) 读文件 + eval：完全不依赖 Node 模块解析
  let fs = null;
  try { fs = require('fs'); } catch (e) { log.push('require(fs): ' + xxlErrText(e)); }
  if (fs) {
    for (const d of dirs) {
      try {
        const p = path.join(d, 'xxljob-bundle.cjs');
        // 先确认存在再读：electron.asar 这类伪目录上 readFileSync 会抛出误导性的错误
        if (!fs.existsSync(p)) { log.push('eval ' + d + ': 没有 xxljob-bundle.cjs'); continue; }
        const src = fs.readFileSync(p, 'utf-8');
        const mod = evalXxlSource(src, d);
        log.push('eval(' + p + '): 成功');
        return { mod, log };
      } catch (e) { log.push('eval ' + d + ': ' + xxlErrText(e)); }
    }
  }
  return { mod: null, log };
}
// Obsidian 里插件 main.js 的 __dirname 是 electron.asar/renderer（不是插件目录），
// 相对 require 也解析不到（require stack: electron/js2c/renderer_init），
// manifest.dir 又只是 vault 相对路径——唯一可靠坐标是 vault 绝对路径 + manifest.dir。
function xxlAbsolutePluginDir(plugin) {
  try {
    const dir = plugin && plugin.manifest && plugin.manifest.dir;
    if (!dir) return '';
    const adapter = plugin.app && plugin.app.vault && plugin.app.vault.adapter;
    const base = adapter && typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
    return base ? path.join(base, dir) : dir;
  } catch (e) { return ''; }
}
function bootXxl(extraDir) {
  const r = loadXxlBundle(extraDir);
  if (r.mod) { xxl = r.mod; xxlLoadError = ''; xxlLoadLog = r.log; return true; }
  if (!xxl) {
    xxlLoadLog = r.log;
    xxlLoadError = r.log.length ? r.log[r.log.length - 1] : '未知错误';
    console.warn('[Schema Studio] 加载 xxljob-bundle.cjs 失败，xxl-job 域不可用\n  ' + r.log.join('\n  '));
  }
  return false;
}
bootXxl(null);
const core = (() => {
function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\[\]/g, '_list')
    .replace(/\.+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field';
}

function inferScalarType(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function inferArrayItemType(arr) {
  const nonNull = arr.filter((x) => x !== null && x !== undefined);
  if (!nonNull.length) return { kind: 'unknown', dataType: 'unknown' };
  const kinds = new Set(nonNull.map((x) => Array.isArray(x) ? 'array' : typeof x));
  if (kinds.size > 1) return { kind: 'mixed', dataType: 'mixed' };
  const kind = [...kinds][0];
  if (kind === 'object') return { kind: 'object', dataType: 'object' };
  if (kind === 'array') return { kind: 'array', dataType: 'array' };
  const scalarTypes = new Set(nonNull.map(inferScalarType));
  return scalarTypes.size === 1
    ? { kind: 'scalar', dataType: [...scalarTypes][0] }
    : { kind: 'mixed', dataType: [...scalarTypes].sort().join('|') };
}

function flattenJsonSample(input) {
  const rows = [];
  let order = 10;
  const push = (row) => rows.push({
    path: row.path,
    parent_path: row.parent_path || '',
    name: row.name,
    shape: row.shape,
    data_type: row.data_type,
    order: order += 10,
  });

  function walkValue(value, path, parentPath, name) {
    if (Array.isArray(value)) {
      const info = inferArrayItemType(value);
      if (info.kind === 'object') {
        push({ path, parent_path: parentPath, name, shape: 'List<Object>', data_type: 'array<object>' });
        const sample = value.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
        for (const [k, v] of Object.entries(sample)) {
          walkValue(v, `${path}[].${k}`, path, k);
        }
      } else if (info.kind === 'array') {
        push({ path, parent_path: parentPath, name, shape: 'List', data_type: 'array<array>' });
      } else {
        push({ path, parent_path: parentPath, name, shape: 'List', data_type: `array<${info.dataType}>` });
      }
      return;
    }
    if (value && typeof value === 'object') {
      push({ path, parent_path: parentPath, name, shape: 'Object', data_type: 'object' });
      for (const [k, v] of Object.entries(value)) {
        walkValue(v, path ? `${path}.${k}` : k, path, k);
      }
      return;
    }
    push({ path, parent_path: parentPath, name, shape: 'Scalar', data_type: inferScalarType(value) });
  }

  if (Array.isArray(input)) {
    const info = inferArrayItemType(input);
    push({ path: '$', parent_path: '', name: '$', shape: info.kind === 'object' ? 'List<Object>' : 'List', data_type: `array<${info.dataType}>` });
    if (info.kind === 'object') {
      const sample = input.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
      for (const [k, v] of Object.entries(sample)) walkValue(v, `[].${k}`, '$', k);
    }
  } else if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) walkValue(v, k, '', k);
  } else {
    push({ path: '$', parent_path: '', name: '$', shape: 'Scalar', data_type: inferScalarType(input) });
  }
  // First actual field should start at 10.
  rows.forEach((row, i) => { row.order = (i + 1) * 10; });
  return rows;
}

function splitTopLevel(input, delimiter = ',') {
  const result = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      buf += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) { result.push(buf.trim()); buf = ''; }
    else buf += ch;
  }
  if (buf.trim()) result.push(buf.trim());
  return result;
}

function unquoteIdent(s) {
  return String(s || '').trim().replace(/^[`"\[]|[`"\]]$/g, '');
}

function normalizeType(type) {
  // 统一「NUMBER(10,0)」→「NUMBER(10, 0)」，与知识库里既有写法和 DDL 原文保持一致
  return String(type || '').trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');
}

function parseCreateTables(sql) {
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?[^\s(`"\]]+[`"\]]?\.)?[`"\[]?[^\s(`"\]]+[`"\]]?)\s*\(/ig;
  let m;
  while ((m = re.exec(sql))) {
    const rawName = m[1];
    let i = re.lastIndex;
    let depth = 1, quote = null, escaped = false;
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = sql.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
    // 支持 schema 限定的表名（如 "CAPITAL"."ACCOUNT_FILE_FLAG"）：schema 用于新建文档时落到对应子目录
    const nameParts = String(rawName).split('.');
    const tableName = unquoteIdent(nameParts.pop());
    const schemaName = nameParts.length ? unquoteIdent(nameParts.pop()) : '';
    const parts = splitTopLevel(body);
    const columns = [];
    const pk = new Set();
    const indexed = new Set();
    const refs = new Map();

    for (const part of parts) {
      const p = part.trim();
      let cm;
      if ((cm = p.match(/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i))) {
        splitTopLevel(cm[1]).forEach((x) => pk.add(unquoteIdent(x.split(/\s+/)[0])));
        continue;
      }
      if ((cm = p.match(/^(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:[`"\[]?[^\s(]+[`"\]]?\s*)?\(([^)]+)\)/i))) {
        splitTopLevel(cm[1]).forEach((x) => indexed.add(unquoteIdent(x.split(/\s+/)[0])));
        continue;
      }
      if ((cm = p.match(/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i))) {
        const local = splitTopLevel(cm[1]).map((x) => unquoteIdent(x.trim()));
        const remoteTable = unquoteIdent(cm[2].split('.').pop());
        const remote = splitTopLevel(cm[3]).map((x) => unquoteIdent(x.trim()));
        local.forEach((c, idx) => refs.set(c, { table: remoteTable, column: remote[idx] || remote[0] }));
        continue;
      }
      if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|KEY|CHECK)\b/i.test(p)) continue;

      const nameMatch = p.match(/^([`"\[]?[^\s`"\]]+[`"\]]?)\s+(.+)$/s);
      if (!nameMatch) continue;
      const name = unquoteIdent(nameMatch[1]);
      const rest = nameMatch[2].trim();
      // CONSTRAINT 必须在列里：Oracle 导出常见「<类型> constraint SYS_xxx check (...)」，
      // 少了它就会把 constraint 及其后的内容一起吃进数据类型（如 "DATE constraint SYS_C0050516"）。
      const stop = /\s+(?=CONSTRAINT\b|NOT\s+NULL|NULL\b|DEFAULT\b|PRIMARY\s+KEY|UNIQUE\b|REFERENCES\b|COMMENT\b|COLLATE\b|CHECK\b|GENERATED\b|AUTO_INCREMENT\b)/i;
      const stopMatch = stop.exec(rest);
      const type = normalizeType(stopMatch ? rest.slice(0, stopMatch.index) : rest);
      const constraints = stopMatch ? rest.slice(stopMatch.index).trim() : '';
      const nullable = !/\bNOT\s+NULL\b/i.test(constraints);
      const inlinePk = /\bPRIMARY\s+KEY\b/i.test(constraints);
      const inlineUnique = /\bUNIQUE\b/i.test(constraints);
      const def = constraints.match(/\bDEFAULT\s+((?:'[^']*')|(?:"[^"]*")|(?:[^\s,]+))/i);
      const comment = constraints.match(/\bCOMMENT\s+'((?:''|[^'])*)'/i);
      const inlineRef = constraints.match(/\bREFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i);
      columns.push({
        name,
        data_type: type,
        nullable,
        primary_key: inlinePk,
        indexed: inlinePk || inlineUnique,
        default_value: def ? def[1] : '',
        ddl_comment: comment ? comment[1].replace(/''/g, "'") : '',
      });
      if (inlineRef) refs.set(name, { table: unquoteIdent(inlineRef[1].split('.').pop()), column: unquoteIdent(inlineRef[2].trim()) });
    }
    columns.forEach((c, idx) => {
      if (pk.has(c.name)) c.primary_key = true;
      if (pk.has(c.name) || indexed.has(c.name)) c.indexed = true;
      if (refs.has(c.name)) c.references = refs.get(c.name);
      c.order = (idx + 1) * 10;
    });
    out.push({ table: tableName, schema: schemaName, table_comment: '', columns });
  }
  return out;
}

function diffRecords(existing, incoming, managedKeys) {
  const result = [];
  const existingMap = new Map(existing.map((r) => [r.key, r]));
  const incomingMap = new Map(incoming.map((r) => [r.key, r]));
  for (const inc of incoming) {
    const old = existingMap.get(inc.key);
    if (!old) { result.push({ key: inc.key, status: 'added', before: null, after: inc, changes: managedKeys }); continue; }
    const changes = managedKeys.filter((k) => JSON.stringify(old[k] ?? '') !== JSON.stringify(inc[k] ?? ''));
    result.push({ key: inc.key, status: changes.length ? 'changed' : 'unchanged', before: old, after: inc, changes });
  }
  for (const old of existing) {
    if (!incomingMap.has(old.key)) result.push({ key: old.key, status: 'removed', before: old, after: null, changes: [] });
  }
  return result;
}

function parseWikiTarget(value) {
  const s = String(value || '');
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return m ? m[1] : s;
}

function makeApiFieldFilename(apiName, direction, path) {
  return `${sanitizeSegment(apiName)}__${sanitizeSegment(direction)}__${sanitizeSegment(path)}`;
}
function makeDbColumnFilename(table, column) {
  return `${sanitizeSegment(table)}__${sanitizeSegment(column)}`;
}
// 取某张表在这份 SQL 中的原始 DDL 片段，用于同步到表文档的「## 建表语句」代码块。
// 三段按序拼接：CREATE TABLE 主体 → 该表的 COMMENT ON（Oracle 把列注释写在建表语句之外）
// → 该表的 CREATE [UNIQUE] INDEX。每段都**原样保留源文本与其结束符**（SQL*Plus 的 `/` 或 `;`），
// 所以同步出来的内容与人工粘贴的形态一致。
function extractTableDdlText(sqlText, table) {
  const sql = String(sqlText == null ? '' : sqlText);
  const target = String(table == null ? '' : table).trim().toLowerCase();
  if (!sql.trim() || !target) return '';
  // 语句里的表名归属：COMMENT ON COLUMN 形如 schema.表.列 → 取倒数第二段；其余取最后一段。
  const ownerOf = (raw, kind) => {
    const names = String(raw).split('.').map(unquoteIdent).map((x) => x.toLowerCase());
    if (!names.length) return '';
    if (kind === 'COLUMN') return names.length > 1 ? names[names.length - 2] : '';
    return names[names.length - 1];
  };
  const withTerminator = (start, end) => {
    const tail = /^(\s*(?:;[ \t]*|\/[ \t]*)?)/.exec(sql.slice(end));
    return sql.slice(start, end + (tail ? tail[1].length : 0)).trim();
  };
  const matchParen = (from) => {
    let depth = 0, quote = null, escaped = false;
    for (let i = from; i < sql.length; i++) {
      const ch = sql[i];
      if (quote) { if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  const create = [], comments = [], indexes = [];
  let m;
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?[^\s(`"\]]+[`"\]]?\.)?[`"\[]?[^\s(`"\]]+[`"\]]?)\s*\(/ig;
  while ((m = re.exec(sql))) {
    if (ownerOf(m[1], 'TABLE') !== target) continue;
    const end = matchParen(re.lastIndex - 1);
    if (end < 0) continue;
    re.lastIndex = end;
    create.push(withTerminator(m.index, end));
  }
  const cre = /COMMENT\s+ON\s+(TABLE|COLUMN)\s+([^\s;]+)\s+IS\s+'(?:''|[^'])*'/gi;
  while ((m = cre.exec(sql))) {
    if (ownerOf(m[2], String(m[1]).toUpperCase()) !== target) continue;
    comments.push(withTerminator(m.index, cre.lastIndex));
  }
  const ire = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+[^\s(]+\s+ON\s+([^\s(]+)\s*\(/gi;
  while ((m = ire.exec(sql))) {
    if (ownerOf(m[1], 'TABLE') !== target) continue;
    const end = matchParen(ire.lastIndex - 1);
    if (end < 0) continue;
    ire.lastIndex = end;
    indexes.push(withTerminator(m.index, end));
  }
  return create.concat(comments, indexes).join('\n');
}

return {
  sanitizeSegment,
  inferScalarType,
  flattenJsonSample,
  splitTopLevel,
  parseCreateTables,
  normalizeType,
  diffRecords,
  parseWikiTarget,
  makeApiFieldFilename,
  extractTableDdlText,
  makeDbColumnFilename,
};
})();


const DEFAULTS = {
  apiDocsFolder: '02-接口',
  dbDocsFolder: '03-数据库',
  apiFieldsFolder: '_data/api-fields',
  dbColumnsFolder: '_data/db-columns',
  apiBaseName: 'ApiFields.base',  dbBaseName: 'DbColumns.base',
  // 新建接口 / 表文档时套用的仓库模板；留空则回退到内置的最小结构。
  // 内部接口（含「不区分」）用 api-接口文档-jiekou，外部接口另用 clientDocuments 模板。
  apiDocTemplate: '_template/业务模板/api-接口文档-jiekou/api-接口文档-jiekou.md',
  // 外部接口（6.client）：与内部接口同名时靠字段文件名的「外部接口-」前缀区分。
  // 新建外部接口文档走 client 模板（章节与属性都与内部接口文档不同）。
  clientDocsFolder: '6.client',
  clientDocTemplate: '_template/业务模板/client-外部接口-waibu/client-外部接口-waibu.md',
  // 新建表文档时套用的模板；留空则回退到内置的最小结构
  dbDocTemplate: '_template/业务模板/db-数据库-shuju/db-数据库-shuju.md',
  // --- 字段表 → 表文档「## 建表语句」实时同步（自 v0.7.22 移植） ---
  // 默认关闭：这条链路会改写表文档里的 SQL（虽然是补丁式、幂等的）。
  // 建议先用命令面板在单张表上跑一次，确认产物符合预期后再打开自动同步。
  syncTableDocFromFields: false,
  autoSyncDebounceMs: 1200,
  // 重建时用的方言：auto = 按 SQL 特征猜（本库默认落到 Oracle）
  autoSyncDialect: 'auto',
  // --- 表文档「## 建表语句」 → 字段表（反向同步，同样默认关闭） ---
  // 与 syncTableDocFromFields 互为镜像；两个都打开时靠自写抑制 + 重入锁避免来回抖。
  syncFieldsFromTableDoc: false,
  prioritizeInlineSuggest: true,
  // --- xxl-job XML 导入（子模块 xxljob-flow-atlas） ---
  xxljobDocsFolder: '8.xxljob',
  xxljobConflictPolicy: 'skip',
  xxljobExecutors: [],
  xxljobFlowTemplate: '_template/业务模板/xxljob-批任务-pirenwu/xxljob-任务流-renwuliu.md',
  xxljobTaskTemplate: '_template/业务模板/xxljob-批任务-pirenwu/xxljob-批任务-pirenwu.md',
  xxljobComponentTemplate: '_template/业务模板/xxljob-批任务-pirenwu/xxljob-任务组件-renwuzujian.md',
  gridViewPrefs: {
    api: { hiddenProps: [], sorts: [], filters: [] },
    db: { hiddenProps: [], sorts: [], filters: [] },
  },
};

// xxl-job 文档的三级目录名（与 xxljob-flow-atlas 的 levelToDirName 一致）
const XXL_DIRS = { flow: '任务流', task: '任务', component: '任务组件' };
// 三级目录 → fileClass 名：xxl-job 文档分散在 <根目录>/<执行器>/<层级> 下，
// 执行器层不固定，没法用 filesPaths 精确匹配，改按 fileClass 名直接找定义。
const XXL_CLASS_BY_LEVEL = { [XXL_DIRS.flow]: '任务流', [XXL_DIRS.task]: '批任务', [XXL_DIRS.component]: '任务组件' };
// 与 db 域的 .schema-state.json 分开，避免两套记录的键互相污染
const XXL_STATE_FILENAME = '.xxljob-state.json';
function xxlStatePathFor(docsFolder) {
  return normalizePath(`${normalizePath(docsFolder || '8.xxljob')}/${XXL_STATE_FILENAME}`);
}
function xxlSettings(plugin) {
  return {
    docsFolder: plugin.settings.xxljobDocsFolder || DEFAULTS.xxljobDocsFolder,
    conflictPolicy: plugin.settings.xxljobConflictPolicy || DEFAULTS.xxljobConflictPolicy,
    executors: Array.isArray(plugin.settings.xxljobExecutors) ? plugin.settings.xxljobExecutors : [],
    flowTemplate: plugin.settings.xxljobFlowTemplate || '',
    taskTemplate: plugin.settings.xxljobTaskTemplate || '',
    componentTemplate: plugin.settings.xxljobComponentTemplate || '',
  };
}

function bool(v, fallback = false) { return typeof v === 'boolean' ? v : fallback; }
function arrish(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
function fmLinkPath(v) { return core.parseWikiTarget(v || ''); }
function basenameNoExt(path) { return String(path || '').split('/').pop().replace(/\.md$/i, ''); }
// 列/字段文档的文件名格式是「<对象名>__<字段名>」。当 frontmatter 里的字段名缺失或被清空时，
// 用它从文件名还原真实字段名——直接拿整个文件名会带上表名前缀，导致与 DDL/JSON 里的字段匹配不上。
function memberNameFromFilename(path, ownerName) {
  const base = basenameNoExt(path);
  const owner = String(ownerName || '');
  if (!owner) return base;
  const prefix = `${owner}__`;
  return base.startsWith(prefix) ? base.slice(prefix.length) : base;
}
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Find a standalone @ trigger in the text immediately before the cursor.
// Keep email addresses and the old [[@ form from opening the schema picker.
function findAtTrigger(text) {
  const source = String(text || '');
  const at = source.lastIndexOf('@');
  if (at < 0) return null;
  const previous = source.slice(0, at).slice(-1);
  if (previous && /[\p{L}\p{N}_@[\]]/u.test(previous)) return null;
  return { startCh: at, query: source.slice(at + 1) };
}

async function ensureFolder(app, folder) {
  folder = normalizePath(folder || '');
  if (!folder) return;
  const parts = folder.split('/');
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

function noteBodyApiField(apiName, direction, row) {
  const parent = row.parent_path ? `\n父路径：\`${row.parent_path}\`` : '';
  return `# ${apiName}.${direction}.${row.path}\n\n${row.description || '待补充说明。'}\n\n所属接口：[[${apiName}]]\n方向：\`${direction}\`\n路径：\`${row.path}\`\n结构：\`${row.shape}\` / \`${row.data_type}\`${parent}\n`;
}
function noteBodyDbColumn(table, row, tableDocPath) {
  const link = tableDocPath ? `[[${String(tableDocPath).replace(/\.md$/i, '')}|${table}]]` : `[[${table}]]`;
  return `# ${table}.${row.name}\n\n${row.description || '待补充说明。'}\n\n所属表：${link}\n`;
}

// 模板正文里的 {{...}} 是填写提示：建表语句那处填入 DDL 原文，其余保留提示供人工填写
function fillTemplatePlaceholders(text, ddlText) {
  return String(text || '').replace(/\{\{([\s\S]*?)\}\}/g, (full, inner) => (/建表语句/.test(inner) ? String(ddlText || '').trim() : full));
}
function stripFrontmatterBlock(text) {
  const m = String(text || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? String(text).slice(m[0].length) : String(text || '');
}


const FRONTMATTER_INTERNAL_KEYS = new Set(['position']);

// 工具运行态键：不再写入业务文档 frontmatter，改由中心化状态文件承载。
// 载体：`<字段记录目录的上级>/.schema-state.json`（默认 `_data/.schema-state.json`，可随 git 追踪）。
const SCHEMA_STATE_KEY_NAMES = new Set([
  'schema_source','schema_dialect','schema_orphaned','last_imported_at',
  '来源方式','方言','疑似删除','最后导入时间',
]);
// 已废弃的真实结构键与旧注释键：知识库侧已从 Fileclass 定义移除，导入时不再写入并顺带清理。
// 注意 `注释` 不在此列——它是通用中文词，可能被别的知识库当作人工属性用，只读不删。
const SCHEMA_DEPRECATED_KEY_NAMES = new Set(['references','引用','order','顺序','ddl_comment','DDL注释']);
// 统一的内部键名单（P2）：界面过滤、字段定义推断、写入前清理都只认这一份。
const SCHEMA_INTERNAL_KEYS = new Set([...FRONTMATTER_INTERNAL_KEYS, ...SCHEMA_STATE_KEY_NAMES, ...SCHEMA_DEPRECATED_KEY_NAMES]);
const SCHEMA_STATE_FILENAME = '.schema-state.json';

function schemaStatePathFor(dbColumnsFolder) {
  const folder = normalizePath(dbColumnsFolder || '');
  const cut = folder.lastIndexOf('/');
  const dir = cut < 0 ? '' : folder.slice(0, cut);
  return normalizePath(dir ? `${dir}/${SCHEMA_STATE_FILENAME}` : SCHEMA_STATE_FILENAME);
}

// 写入前清理：内部键不得落进 frontmatter（P0 / P1）。
function purgeSchemaInternalKeys(record) {
  if (!record) return record;
  for (const key of Object.keys(record)) if (SCHEMA_INTERNAL_KEYS.has(key)) delete record[key];
  return record;
}

// 参与「导入 Diff」比对的键。api 侧只留真正落盘的三个（方向 / 字段路径 / 数据类型）：
// parent_path、name、shape 现在不写进 frontmatter（模板里没这几个属性，层级由路径表达），
// 留在比对集合里会让每一个既有字段都显示成「有变化」——旧记录读不到值、新记录有值，
// 纯属假差异。shape 的变化已由 data_type 覆盖（shape 就是从 data_type 反推的）。
const API_IMPORT_MANAGED_KEYS = ['direction','path','data_type'];
// `ddl_comment` 已并入 `说明`（P4），`references` / `order` 已废弃 → 三者都不再参与写入与 Diff。
const DB_IMPORT_MANAGED_KEYS = ['name','data_type','nullable','primary_key','indexed','default_value','description'];
const SCHEMA_KEY_ALIASES = {
  api: {
    api: ['api','接口名称'], direction: ['direction','请求/响应'], path: ['path','字段路径'],
    parent_path: ['parent_path','父级路径'], name: ['name','字段名'], shape: ['shape','结构'],
    data_type: ['data_type','数据类型'], order: ['order','顺序'], schema_orphaned: ['schema_orphaned','疑似删除'],
    schema_source: ['schema_source','来源方式'], schema_dialect: ['schema_dialect','方言'], last_imported_at: ['last_imported_at','最后导入时间'],
  },
  db: {
    table: ['table','数据表','数据表名称'], name: ['name','字段','列名','字段名'], data_type: ['data_type','数据类型'],
    nullable: ['nullable','可为空','是否可为空'], primary_key: ['primary_key','主键','是否主键'], indexed: ['indexed','索引','是否索引'],
    high_risk: ['high_risk','是否高风险'], description: ['description','说明','字段说明'], default_value: ['default_value','默认值'],
    references: ['references','引用'], ddl_comment: ['ddl_comment','DDL注释','注释'], order: ['order','顺序'],
    schema_orphaned: ['schema_orphaned','疑似删除'], schema_source: ['schema_source','来源方式'], schema_dialect: ['schema_dialect','方言'],
    last_imported_at: ['last_imported_at','最后导入时间'],
  },
};
const NON_EDITABLE_IDENTITY_KEYS = new Set([
  'api','接口名称','table','数据表','数据表名称','direction','请求/响应','path','字段路径','parent_path','父级路径',
  'name','字段','列名','字段名',
  ...SCHEMA_INTERNAL_KEYS,
]);

function normalizeFieldDefinition(raw) {
  if (!raw || !raw.name) return null;
  return {
    name: String(raw.name),
    type: String(raw.type || 'Input'),
    required: !!raw.required,
    options: Array.isArray(raw.options) ? raw.options.map(String) : [],
    default: raw.default,
  };
}
function defaultForField(def) {
  if (def && def.default !== undefined) return def.default;
  const type = String(def?.type || '').toLowerCase();
  if (type === 'boolean') return false;
  if (type.includes('multi')) return [];
  return '';
}
function stripCacheKeys(obj) {
  const out = {};
  for (const [k,v] of Object.entries(obj || {})) if (!FRONTMATTER_INTERNAL_KEYS.has(k)) out[k] = v;
  return out;
}
function schemaKeyCandidates(domain, key) {
  return SCHEMA_KEY_ALIASES[domain]?.[key] || [key];
}
// 这些是业务字段的身份信息：导入值缺失时绝不能把文件里已有的值覆盖成空。
// 一旦被写空，该文件就会与 DDL/JSON 里的字段匹配不上，后续导入会把它当成新字段、因重名直接中断。
const SCHEMA_GUARDED_KEYS = { api: ['path', 'name', 'data_type'], db: ['name', 'data_type'] };
// 合并结果里身份键若为空/缺失，用既有记录补齐；两边都没有该键时直接删掉，避免落一个空值。
// existing 传入既有文件的 frontmatter：合并基底虽已含旧值，但本次解析出的空值会把它覆盖掉，
// 所以必须回头从既有记录回填 —— 只删键的话，旧值同样丢了（对端 v0.7.18 §2 的教训：
// 一次导入把 10 个列文件的「字段名 / 数据类型」写空）。
function dropBlankGuardedValues(domain, props, existing) {
  for (const key of SCHEMA_GUARDED_KEYS[domain] || []) {
    const value = schemaValue(props, domain, key);
    if (value === undefined || value === null || String(value).trim() === '') {
      const previous = existing ? schemaValue(existing, domain, key) : undefined;
      const candidates = schemaKeyCandidates(domain, key);
      if (previous === undefined || previous === null || String(previous).trim() === '') {
        for (const candidate of candidates) delete props[candidate];
        continue;
      }
      setSchemaValue(props, domain, key, previous);
    }
  }
}
function schemaValue(fm, domain, key) {
  for (const candidate of schemaKeyCandidates(domain, key)) {
    if (Object.prototype.hasOwnProperty.call(fm || {}, candidate)) return fm[candidate];
  }
  return undefined;
}
function setSchemaValue(record, domain, key, value) {
  const candidates = schemaKeyCandidates(domain, key);
  // Preserve the naming convention already used by the Fileclass/frontmatter.
  const target = candidates.slice(1).find(candidate => Object.prototype.hasOwnProperty.call(record || {}, candidate))
    || (Object.prototype.hasOwnProperty.call(record || {}, candidates[0]) ? candidates[0] : candidates[0]);
  const storedValue = domain === 'api' && key === 'direction' && target === '请求/响应'
    ? (value === 'Request' ? '请求字段' : value === 'Response' ? '响应字段' : value)
    : value;
  record[target] = storedValue;
  for (const candidate of candidates) if (candidate !== target) delete record[candidate];
  return target;
}
// 生成侧裁剪：只保留模板（Fileclass）里定义过的属性（+ fileClass）。
// 解析过程的中间键（parent_path / shape / order，以及模板未定义的英文别名 name）在模板里
// 没有对应属性 —— 本库字段文件一个都没有这些键，写进去只会污染业务文档与 git diff。
// 与对端 v0.7.17 白名单净化的区别：这里只决定「我们写什么」，**不删既有文件里已有的键** ——
// 既让产物保持干净，又不会像对端那样抹掉用户在字段文件上自建/手填的属性。
// 英文历史键按别名归位到模板属性名，值不丢（name → 字段名、data_type → 数据类型 …）。
function stripRecordToFileclass(record, domain, allowed) {
  if (!allowed || !allowed.size || !record) return record;
  const aliases = SCHEMA_KEY_ALIASES[domain] || {};
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'fileClass' || key === 'key' || allowed.has(key)) { out[key] = value; continue; }
    const hit = Object.values(aliases).find((candidates) => candidates.includes(key));
    const target = hit && hit.find((candidate) => allowed.has(candidate));
    if (target && !(target in out)) out[target] = value;
  }
  return out;
}
// 从字段路径推导层级信息（父路径 / 叶子名 / 结构形状）。
// 模板里这一层「不另设属性」——父子关系由 `creditInfo.annualRate` 这样的路径本身表达，
// 所以读取侧自己算，而不是要求把 parent_path / shape 落进 frontmatter。
// shape 由数据类型反推（object / array<…>），与导入时解析出的值一致。
function deriveApiHierarchy(pathValue, dataType) {
  const p = String(pathValue || '').trim();
  const type = String(dataType || '').trim().toLowerCase();
  const segs = p.split('.').filter(Boolean);
  const name = segs.length ? segs[segs.length - 1].replace(/\[\]$/, '') : '';
  const parent_path = segs.length > 1 ? segs.slice(0, -1).map((s) => s.replace(/\[\]$/, '')).join('.') : '';
  let shape = 'Scalar';
  if (type === 'object') shape = 'Object';
  else if (/^array<\s*object\s*>$/.test(type)) shape = 'List<Object>';
  else if (/^array<\s*array/.test(type)) shape = 'List';
  else if (/^array</.test(type)) shape = 'List';
  return { parent_path, name, shape };
}

function canonicalSchemaRecord(domain, fm) {
  const out = stripCacheKeys(fm);
  for (const key of Object.keys(SCHEMA_KEY_ALIASES[domain] || {})) {
    const value = schemaValue(fm, domain, key);
    if (value !== undefined) out[key] = domain === 'api' && key === 'direction' ? normalizeDirection(value) || value : value;
  }
  return out;
}
// 表格读值：先按属性名直取（中文键知识库就是这种情形），取不到再按别名解析，
// 保证「旧值（规范记录）」和「新值（frontmatter 形态记录）」读同一套语义，不产生假差异。
function readSchemaCell(record, domain, key) {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  const value = schemaValue(record, domain, key);
  return value === undefined ? '' : value;
}
function normalizeDirection(value) {
  const s = String(value || '').trim().toLowerCase();
  if (['request','req','请求','请求字段','入参'].includes(s)) return 'Request';
  if (['response','resp','res','响应','响应字段','出参'].includes(s)) return 'Response';
  return '';
}


// --- 接口模块（内部 / 外部）与前缀约定（自 v0.7.19 / v0.7.20 分支移植）-----------
// 本库 `5.api/` 与 `6.client/` 下存在**同名**接口（如两边的「助贷放款申请接口」），
// 字段记录靠文件名的「内部接口- / 外部接口-」前缀区分，而接口文档名本身**不带**前缀。
// 所以比较接口名、推导文档路径、生成字段文件名时都必须先归一化前缀，
// 否则会把既有字段整批误判为新增，并写出 `[[5.api/内部接口-xxx]]` 这类不存在的链接。

// 报文封套：标准内部接口报文形如 { head: {公共报文头}, body: {业务字段} }。
// head 每个接口都一样 → 导入时应忽略；body 才是业务字段 → 全部导入，且字段路径不带 body. 前缀。
// 规则：①「业务根节点」（默认 body）存在且是对象 → 只取该节点；
//       ② 否则按「忽略的顶层节点」（默认 head）逐项丢弃，其余整体导入。
// 两个选项都来自导入页，留空即完全不处理（导任意 JSON 的老用法行为不变）。
const API_MODULE_PREFIX_RE = /^(?:内部接口|外部接口)[-_]/;
function stripApiModulePrefix(name) {
  return String(name == null ? '' : name).trim().replace(API_MODULE_PREFIX_RE, '').trim();
}
function sameApiName(a, b) {
  const left = String(a == null ? '' : a).trim();
  const right = String(b == null ? '' : b).trim();
  return left === right || (!!left && stripApiModulePrefix(left) === stripApiModulePrefix(right));
}
// 模块前缀的取值固定为这两个（外加空＝不区分）。导入页的下拉只用这三个值，不要自定义。
const API_MODULES = ['内部接口', '外部接口'];
// 从文件名（可带目录）推断模块：`外部接口-xxx__Request__a.md` → 外部接口。
// 只在文档路径判断不出来时兜底用（路径永远比文件名可靠）。
function apiModuleFromFilename(pathOrName) {
  const base = String(pathOrName == null ? '' : pathOrName).split('/').pop();
  for (const m of API_MODULES) if (base.startsWith(m + '-') || base.startsWith(m + '_')) return m;
  return '';
}
// 选了模块就把前缀统一加上（先剥旧前缀，避免出现「内部接口-外部接口-xxx」这种叠加）。
// 不选模块时**保持用户输入的原文**，不擅自剥前缀——避免误伤名字里本来就带这些字的接口。
function applyApiModulePrefix(apiName, module) {
  const raw = String(apiName == null ? '' : apiName).trim();
  if (!module) return raw;
  const base = stripApiModulePrefix(raw) || raw;
  return base ? `${module}-${base}` : '';
}
// 标准内部接口报文形如 { head: { 公共报文头 }, body: { 业务字段 } }：
//   · head 每个接口都一样 → 导入时应忽略；
//   · body 才是业务字段 → 全部导入，且**字段路径不带 body. 前缀**。
// 规则：①「业务根节点」（默认 body）存在且是对象/数组 → 只取该节点（其余顶层节点一并丢弃，
//       路径天然不带该节点名前缀）；② 否则按「忽略的顶层节点」（默认 head）逐项丢弃，其余整体导入。
// 两个选项都来自导入页，留空即完全不处理（老用户导任意 JSON 时行为不变）。
function splitNameList(value) {
  return String(value == null ? '' : value).split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
}
function selectImportPayload(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data, root: '', dropped: [] };
  const root = String(options.payloadRoot == null ? '' : options.payloadRoot).trim();
  if (root && data[root] && typeof data[root] === 'object') {
    return { data: data[root], root, dropped: Object.keys(data).filter((k) => k !== root) };
  }
  const ignore = splitNameList(options.ignoreTopKeys);
  if (!ignore.length) return { data, root: '', dropped: [] };
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(data)) {
    if (ignore.includes(k)) { dropped.push(k); continue; }
    out[k] = v;
  }
  return { data: out, root: '', dropped };
}
// --- XML 报文解析（自 v0.7.11 分支移植）----------------------------------------
// 手写的一个小解析器：Obsidian 沙箱里没有 DOMParser，也不该为一个导入功能引入第三方依赖。
// 只支持导入场景需要的子集：元素、属性、文本、CDATA、注释、处理指令、实体。
// 约定（与对端一致，勿改）：
//   1. 根元素只是报文容器 —— 解析结果从根的**子元素**开始，根名不出现在字段路径里。
//   2. 属性写成 `@属性名`（如 `@id`），与子元素区分开。
//   3. 同名重复元素自动识别为数组（XML 没有数组概念，只能靠重复出现推断）。
//   4. 元素既有属性又有文本时，文本记为 `_text`（不用 `#text`，避免与 Obsidian 链接锚点冲突）。
//   5. 类型推断默认关闭：XML 里一切都是字符串，`<age>18</age>` 也保持 "18"。
//      （推断会伤害「0001」这类有前导零的编码，故默认不推断，可在导入页打开。）
//   6. `<__schema api="..." direction="..."/>` 作为元信息元素，不参与字段解析。
function decodeXmlEntities(value) {
  return String(value == null ? '' : value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return Object.prototype.hasOwnProperty.call(named, body) ? named[body] : match;
  });
}
function findXmlTagEnd(text, from) {
  let quote = null;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return j;
  }
  return -1;
}
function parseXmlTagAttributes(source) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(source))) attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}
function parseXmlToTree(source) {
  const text = String(source == null ? '' : source).replace(/^\uFEFF/, '');
  const fail = (msg) => { throw new Error(`XML 解析失败：${msg}`); };
  let i = 0, root = null;
  const stack = [];
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      const tail = text.slice(i);
      if (stack.length) stack[stack.length - 1].texts.push(decodeXmlEntities(tail));
      else if (tail.trim()) fail('根元素之外存在文本内容');
      break;
    }
    if (lt > i) {
      const chunk = text.slice(i, lt);
      if (stack.length) stack[stack.length - 1].texts.push(decodeXmlEntities(chunk));
      else if (chunk.trim()) fail('根元素之外存在文本内容');
      i = lt;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) fail('注释未闭合');
      i = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) fail('CDATA 区段未闭合');
      if (stack.length) stack[stack.length - 1].texts.push(text.slice(i + 9, end));
      i = end + 3; continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) fail('处理指令未闭合');
      i = end + 2; continue;
    }
    if (text.startsWith('<!', i)) {
      const end = findXmlTagEnd(text, i + 2);
      if (end < 0) fail('声明未闭合');
      i = end + 1; continue;
    }
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) fail('结束标签未闭合');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open) fail(`多余的结束标签 </${name}>`);
      if (open.name !== name) fail(`标签不匹配：<${open.name}> 与 </${name}>`);
      i = end + 1; continue;
    }
    const end = findXmlTagEnd(text, i + 1);
    if (end < 0) fail('开始标签未闭合');
    const raw = text.slice(i + 1, end);
    const selfClosing = /\/\s*$/.test(raw);
    const body = selfClosing ? raw.replace(/\/\s*$/, '') : raw;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m) fail('开始标签缺少名称');
    const node = { name: m[1], attrs: parseXmlTagAttributes(m[2]), children: [], texts: [] };
    const parent = stack[stack.length - 1] || null;
    if (parent) parent.children.push(node);
    else if (root) fail('存在多个根元素（XML 只允许一个根元素）');
    else root = node;
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  if (stack.length) fail(`标签未闭合：<${stack[stack.length - 1].name}>`);
  if (!root) fail('未找到根元素');
  return root;
}
function normalizeXmlScalar(value, inferTypes) {
  const text = String(value == null ? '' : value).trim();
  if (!inferTypes || text === '') return text;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d+$/.test(text)) {
    const num = Number(text);
    return Number.isSafeInteger(num) ? num : text;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    const num = Number(text);
    return Number.isFinite(num) ? num : text;
  }
  return text;
}
function xmlNodeToValue(node, inferTypes) {
  const record = {};
  for (const [k, v] of Object.entries(node.attrs || {})) record[`@${k}`] = v;
  for (const child of node.children || []) {
    const value = xmlNodeToValue(child, inferTypes);
    if (Object.prototype.hasOwnProperty.call(record, child.name)) {
      if (Array.isArray(record[child.name])) record[child.name].push(value);
      else record[child.name] = [record[child.name], value];
    } else record[child.name] = value;
  }
  const text = (node.texts || []).join('').trim();
  const keys = Object.keys(record);
  if (!keys.length) return normalizeXmlScalar(text, inferTypes);
  if (text) record['_text'] = normalizeXmlScalar(text, inferTypes);
  return record;
}
function parseXmlPayload(source, options = {}) {
  const inferTypes = !!(options && options.inferTypes);
  const root = parseXmlToTree(source);
  let metaEl = null;
  for (const child of root.children) {
    if (child.name === '__schema' || child.name === '_schema') { metaEl = child; break; }
  }
  let meta = null;
  if (metaEl) { meta = {}; for (const [k, v] of Object.entries(metaEl.attrs || {})) meta[k] = v; }
  const data = {};
  for (const child of root.children) {
    if (child === metaEl) continue;
    const value = xmlNodeToValue(child, inferTypes);
    if (Object.prototype.hasOwnProperty.call(data, child.name)) {
      if (Array.isArray(data[child.name])) data[child.name].push(value);
      else data[child.name] = [data[child.name], value];
    } else data[child.name] = value;
  }
  return { data, meta, rootName: root.name };
}
function looksLikeXmlText(text) {
  const s = String(text == null ? '' : text).trim();
  return s.charAt(0) === '<';
}
function parseJsonFilenameTarget(filename) {
  // 扩展名同时认 json 与 xml —— 导入页现在接受两种报文，文件名路由规则保持一致
  const base = String(filename || '').replace(/\.(?:json|xml)$/i,'').trim();
  const m = base.match(/^(.+?)[._\-\s]+(request|response|req|resp|res|请求|响应|入参|出参)$/i);
  if (!m) return null;
  const direction = normalizeDirection(m[2]);
  return direction ? { apiName: m[1].trim(), direction } : null;
}
// 导入单元解析：JSON 与 XML 走同一入口。判据是「文件名以 .xml 结尾」或「内容以 < 开头」。
// 返回里多带两项：`sourceFormat`（json / xml，决定示例代码块的语言标记）与 `sample`
// （剥掉 __schema 之后的原始报文，用于回写接口文档的「## 请求示例 / ## 响应示例」）。
function extractJsonImportUnit(text, filename='', fallback={}) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) throw new Error('导入内容为空：请粘贴 JSON / XML 字符串，或选择文件');
  const isXml = /\.xml$/i.test(String(filename || '')) || looksLikeXmlText(raw);
  let data, meta = null;
  if (isXml) {
    // 类型推断默认关闭：XML 里一切都是字符串，`<code>0001</code>` 不该被读成数字 1
    const xml = parseXmlPayload(raw, { inferTypes: !!fallback.xmlInferTypes });
    data = xml.data;
    meta = xml.meta;
  } else {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`JSON 解析失败：${e.message}。若内容其实是 XML，请确认它以 < 开头，或将文件名改为 .xml`); }
    data = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.__schema && typeof parsed.__schema === 'object' && !Array.isArray(parsed.__schema)) meta = parsed.__schema;
      else if (parsed._schema && typeof parsed._schema === 'object' && !Array.isArray(parsed._schema)) meta = parsed._schema;
    }
  }
  const originalData = data;
  const fromName = parseJsonFilenameTarget(filename);
  const rawApiName = String(meta?.api || meta?.apiName || meta?.interface || fromName?.apiName || fallback.apiName || '').trim();
  // 模块前缀由导入页选择（不区分 / 内部接口 / 外部接口），决定字段文件名的前缀与新建文档的目录
  const apiModule = String(fallback.apiModule || '').trim();
  const apiName = applyApiModulePrefix(rawApiName, apiModule);
  const direction = normalizeDirection(meta?.direction || fromName?.direction || fallback.direction);
  // ★ 报文封套（head / body）只是**内部接口文档**的标准报文格式：外部接口文档与 XML 不适用，
  //   所以自动封套剥离只在「模块＝内部接口 且 非 XML」时生效。
  const envelopeApplies = !isXml && apiModule === API_MODULES[0];
  let payloadFromMeta = false;
  if (meta) {
    // __schema 存在时的解包保持**无条件**（与历史行为一致）：收窄成"仅内部接口"会让
    // 以前能用的导入突然失效，不冒这个险。封套只是它的补充，不替代它。
    const key = String(meta.dataKey || meta.payloadKey || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(data, key)) { data = data[key]; payloadFromMeta = true; }
    else if (Object.prototype.hasOwnProperty.call(data, 'payload')) { data = data.payload; payloadFromMeta = true; }
    else if (Object.prototype.hasOwnProperty.call(data, 'body')) { data = data.body; payloadFromMeta = true; }
    else if (Object.prototype.hasOwnProperty.call(data, 'data')) { data = data.data; payloadFromMeta = true; }
    // XML 的 __schema 是根下的一个元素，剥根时已经跳过，不必再过滤
    else if (!isXml) data = Object.fromEntries(Object.entries(data).filter(([k]) => k !== '__schema' && k !== '_schema'));
  }
  // 报文封套剥离：__schema 已经解包过就不再猜；否则按导入页的「业务根节点 / 忽略的顶层节点」
  // 处理。两项都留空时完全 no-op（导任意 JSON 的老用法不受影响）。
  let envelope = { root: '', dropped: [], applies: envelopeApplies };
  if (!payloadFromMeta && envelopeApplies) {
    envelope = Object.assign({ applies: true }, selectImportPayload(data, { payloadRoot: fallback.payloadRoot, ignoreTopKeys: fallback.ignoreTopKeys }));
    data = envelope.data;
  }
  // 原始样例：只剥掉 __schema 元信息，其余原样保留 —— 示例给的是报文的真实形态
  let sample = '';
  if (isXml) sample = raw.trim();
  else if (originalData && typeof originalData === 'object') {
    const clone = Array.isArray(originalData) ? originalData
      : Object.fromEntries(Object.entries(originalData).filter(([k]) => k !== '__schema' && k !== '_schema'));
    try { sample = JSON.stringify(clone, null, 2); } catch (_e) { sample = ''; }
  }
  const sourceLabel = filename || (isXml ? 'XML 字符串' : 'JSON 字符串');
  if (!apiName || !direction) throw new Error(`无法确定导入目标：${sourceLabel}。请使用“接口名.Request.json / 接口名.Request.xml”，或在内容中提供 __schema.api + __schema.direction。`);
  return { apiName, direction, data, filename: sourceLabel, sourceFormat: isXml ? 'xml' : 'json', apiModule, envelope, sample };
}
function diffValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? '（空）' : v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function detailedDiffRows(diff) {
  const rows = [];
  for (const d of diff || []) {
    if (d.status === 'unchanged') continue;
    if (d.status === 'changed') {
      for (const prop of d.changes || []) rows.push({ status:'changed', key:d.key, property:prop, before:d.before?.[prop], after:d.after?.[prop] });
    } else if (d.status === 'added') {
      const props = (d.changes || []).filter(k => d.after && d.after[k] !== undefined);
      if (!props.length) rows.push({ status:'added', key:d.key, property:'字段', before:undefined, after:'新增' });
      else for (const prop of props) rows.push({ status:'added', key:d.key, property:prop, before:undefined, after:d.after?.[prop] });
    } else if (d.status === 'removed') {
      rows.push({ status:'removed', key:d.key, property:'字段', before:'存在', after:'源中未出现（将标记疑似删除）' });
    }
  }
  return rows;
}

function parseClipboardTable(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else {
      if (ch === '"' && cell === '') quoted = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
  }
  row.push(cell); rows.push(row);
  while (rows.length > 1 && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}
function clipboardValueForType(raw, def) {
  const type = String(def?.type || 'Input').toLowerCase();
  const s = String(raw ?? '').trim();
  if (type === 'boolean') {
    const l = s.toLowerCase();
    if (['true','1','yes','y','是','√','✓'].includes(l)) return true;
    if (['false','0','no','n','否','×','✗',''].includes(l)) return false;
    return !!s;
  }
  if (type === 'number') return s === '' ? '' : (Number.isFinite(Number(s)) ? Number(s) : s);
  if (type.includes('multi')) return s === '' ? [] : s.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  return raw == null ? '' : String(raw);
}
function displayGridValue(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch {} }
  return String(v);
}
function valuesEqual(a, b) {
  return JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
}

const DEMO_ROOT = '_SchemaTools-Demo';

function demoPaths(root = DEMO_ROOT) {
  root = normalizePath(root);
  return {
    root,
    start: `${root}/00-开始这里.md`,
    design: `${root}/01-设计文档`,
    apiDocs: `${root}/02-接口`,
    dbDocs: `${root}/03-数据库`,
    apiFields: `${root}/_data/api-fields`,
    dbColumns: `${root}/_data/db-columns`,
    fileclasses: `${root}/_fileclasses`,
    bases: `${root}/_bases`,
    samples: `${root}/_samples`,
    apiBase: `${root}/_bases/ApiFields.base`,
    dbBase: `${root}/_bases/DbColumns.base`,
  };
}

function demoApiClass(paths) {
  return `---\nfilesPaths:\n  - ${paths.apiFields}\nfields:\n  - name: api\n    id: DEMOAF001\n    type: File\n    required: true\n    path: ''\n  - name: direction\n    id: DEMOAF002\n    type: Select\n    required: true\n    options: [Request, Response]\n    path: ''\n  - name: path\n    id: DEMOAF003\n    type: Input\n    required: true\n    path: ''\n  - name: parent_path\n    id: DEMOAF004\n    type: Input\n    required: false\n    path: ''\n  - name: name\n    id: DEMOAF005\n    type: Input\n    required: true\n    path: ''\n  - name: shape\n    id: DEMOAF006\n    type: Select\n    required: true\n    options: [Scalar, Object, List, List<Object>]\n    path: ''\n  - name: data_type\n    id: DEMOAF007\n    type: Input\n    required: true\n    path: ''\n  - name: required\n    id: DEMOAF008\n    type: Boolean\n    required: true\n    path: ''\n  - name: high_risk\n    id: DEMOAF009\n    type: Boolean\n    required: true\n    path: ''\n  - name: description\n    id: DEMOAF010\n    type: Input\n    required: true\n    path: ''\n  - name: db_column\n    id: DEMOAF011\n    type: File\n    required: false\n    path: ''\n  - name: reviewed\n    id: DEMOAF012\n    type: Boolean\n    required: true\n    path: ''\n  - name: order\n    id: DEMOAF013\n    type: Number\n    required: true\n    path: ''\n  - name: schema_orphaned\n    id: DEMOAF014\n    type: Boolean\n    required: true\n    path: ''\n---\n\n# 体验接口字段\n\n这是 Schema Tools 中文体验样例使用的接口字段 Fileclass。\n`;
}

function demoDbClass(paths) {
  return `---\nfilesPaths:\n  - ${paths.dbColumns}\nfields:\n  - name: table\n    id: DEMODC001\n    type: File\n    required: true\n    path: ''\n  - name: name\n    id: DEMODC002\n    type: Input\n    required: true\n    path: ''\n  - name: data_type\n    id: DEMODC003\n    type: Input\n    required: true\n    path: ''\n  - name: nullable\n    id: DEMODC004\n    type: Boolean\n    required: true\n    path: ''\n  - name: primary_key\n    id: DEMODC005\n    type: Boolean\n    required: true\n    path: ''\n  - name: indexed\n    id: DEMODC006\n    type: Boolean\n    required: true\n    path: ''\n  - name: high_risk\n    id: DEMODC007\n    type: Boolean\n    required: true\n    path: ''\n  - name: description\n    id: DEMODC008\n    type: Input\n    required: true\n    path: ''\n  - name: default_value\n    id: DEMODC009\n    type: Input\n    required: false\n    path: ''\n  - name: references\n    id: DEMODC010\n    type: File\n    required: false\n    path: ''\n  - name: order\n    id: DEMODC011\n    type: Number\n    required: true\n    path: ''\n  - name: schema_orphaned\n    id: DEMODC012\n    type: Boolean\n    required: true\n    path: ''\n---\n\n# 体验数据库字段\n\n这是 Schema Tools 中文体验样例使用的数据库字段 Fileclass。\n`;
}

function demoApiBase() {
  return `properties:\n  api:\n    displayName: 接口\n  direction:\n    displayName: 方向\n  path:\n    displayName: 路径\n  shape:\n    displayName: 结构\n  data_type:\n    displayName: 类型\n  required:\n    displayName: 必填\n  high_risk:\n    displayName: 高风险\n  description:\n    displayName: 说明\n  db_column:\n    displayName: 对应数据库字段\n  reviewed:\n    displayName: 已复核\nviews:\n  - type: fileclass-table\n    name: 当前接口 Request\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n        - api == this.file.asLink()\n        - direction == "Request"\n    order: [path, shape, data_type, required, high_risk, description, db_column, reviewed]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 当前接口 Response\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n        - api == this.file.asLink()\n        - direction == "Response"\n    order: [path, shape, data_type, required, high_risk, description, db_column, reviewed]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 全部接口字段\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n    order: [api, direction, path, shape, data_type, required, high_risk, description, db_column, reviewed]\n`;
}

function demoDbBase() {
  return `properties:\n  table:\n    displayName: 数据表\n  name:\n    displayName: 字段\n  data_type:\n    displayName: 类型\n  nullable:\n    displayName: Nullable\n  primary_key:\n    displayName: PK\n  indexed:\n    displayName: 索引\n  high_risk:\n    displayName: 高风险\n  description:\n    displayName: 说明\n  references:\n    displayName: 引用\nviews:\n  - type: fileclass-table\n    name: 当前数据表\n    filters:\n      and:\n        - fileClass.containsAny("体验数据库字段")\n        - table == this.file.asLink()\n    order: [name, data_type, nullable, primary_key, indexed, high_risk, description, references]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 全部数据库字段\n    filters:\n      and:\n        - fileClass.containsAny("体验数据库字段")\n    order: [table, name, data_type, nullable, primary_key, indexed, high_risk, description, references]\n`;
}

function demoDescription(path) {
  const map = {
    buyer: '购买人', 'buyer.user_id': '用户 ID', 'buyer.contact': '联系人', 'buyer.contact.name': '联系人姓名', 'buyer.contact.mobile': '联系人手机号',
    items: '订单商品列表', 'items[].sku_id': 'SKU ID', 'items[].quantity': '购买数量', 'items[].price': '下单单价', 'items[].attributes': '商品销售属性', 'items[].attributes[].key': '属性名', 'items[].attributes[].value': '属性值',
    coupon_codes: '优惠券编码列表', payment: '支付信息', 'payment.channel': '支付渠道', 'payment.amount': '支付金额',
    order: '订单摘要', 'order.id': '订单 ID', 'order.order_no': '订单号', 'order.status': '订单状态', 'order.amount': '订单金额',
    timeline: '订单状态时间线', 'timeline[].status': '状态', 'timeline[].time': '状态时间', order_no: '订单号'
  };
  return map[path] || path.split('.').pop().replace(/\[\]/g, '');
}

function demoDbColumnLink(paths, table, column) {
  return `[[${paths.dbColumns}/${core.makeDbColumnFilename(table, column)}]]`;
}

function demoDbMapping(paths, path) {
  const map = {
    'buyer.user_id': ['orders','user_id'],
    'items[].sku_id': ['order_item','sku_id'],
    'items[].quantity': ['order_item','quantity'],
    'items[].price': ['order_item','price'],
    'payment.channel': ['orders','payment_channel'],
    'payment.amount': ['orders','amount'],
    'order.id': ['orders','id'],
    'order.order_no': ['orders','order_no'],
    'order.status': ['orders','status'],
    'order.amount': ['orders','amount'],
    order_no: ['orders','order_no'],
  };
  const hit = map[path];
  return hit ? demoDbColumnLink(paths, hit[0], hit[1]) : '';
}

function buildDemoFilePlan(root = DEMO_ROOT) {
  const p = demoPaths(root);
  const createOrderRequest = {
    buyer: { user_id: 10001, contact: { name: '张三', mobile: '13800000000' } },
    items: [{ sku_id: 20001, quantity: 2, price: 99.9, attributes: [{ key: '颜色', value: '红色' }] }],
    coupon_codes: ['新人满减券'],
    payment: { channel: '微信支付', amount: 199.8 },
  };
  const createOrderResponse = { order: { id: 90001, order_no: 'O202609120001', status: '已创建', amount: 199.8 } };
  const queryResponse = {
    order_no: 'O202609120001',
    buyer: { user_id: 10001, name: '张三', mobile: '13800000000' },
    items: [{ sku_id: 20001, name: '红色经典T恤', quantity: 2, attributes: [{ key: '颜色', value: '红色' }] }],
    timeline: [{ status: '已创建', time: '2026-09-12T10:00:00+08:00' }],
  };
  const requestV2 = {
    ...createOrderRequest,
    shipping_address: { province: '广东省', city: '深圳市', district: '南山区', detail: '科技园一号楼' },
    payment: { channel: '微信支付', amount: 199.8, currency: '人民币' },
  };
  const mysql = `CREATE TABLE orders (\n  id BIGINT NOT NULL PRIMARY KEY COMMENT '订单主键',\n  order_no VARCHAR(40) NOT NULL COMMENT '订单号',\n  user_id BIGINT NOT NULL COMMENT '购买用户ID',\n  amount DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '订单金额',\n  payment_channel VARCHAR(20) COMMENT '支付渠道',\n  status VARCHAR(20) NOT NULL COMMENT '订单状态',\n  KEY idx_user (user_id),\n  UNIQUE KEY uk_order_no (order_no)\n);\n\nCREATE TABLE order_item (\n  id BIGINT NOT NULL PRIMARY KEY COMMENT '订单商品主键',\n  order_id BIGINT NOT NULL COMMENT '订单ID',\n  sku_id BIGINT NOT NULL COMMENT '商品SKU ID',\n  quantity INT NOT NULL COMMENT '购买数量',\n  price DECIMAL(18,2) NOT NULL COMMENT '下单单价',\n  KEY idx_order (order_id),\n  CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES orders(id)\n);\n`;
  const mysqlV2 = mysql
    .replace("status VARCHAR(20) NOT NULL COMMENT '订单状态',", "status VARCHAR(40) NOT NULL COMMENT '订单状态',\n  currency VARCHAR(8) NOT NULL DEFAULT 'CNY' COMMENT '币种',")
    .replace("price DECIMAL(18,2) NOT NULL COMMENT '下单单价',", "price DECIMAL(18,2) NOT NULL COMMENT '下单单价',\n  discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '优惠金额',");
  const oracle = `CREATE TABLE ORDERS (\n  ID NUMBER(19) CONSTRAINT ORDERS_PK PRIMARY KEY,\n  ORDER_NO VARCHAR2(40) CONSTRAINT ORDERS_NO_NN NOT NULL,\n  USER_ID NUMBER(19) NOT NULL,\n  AMOUNT NUMBER(18,2) DEFAULT 0 NOT NULL,\n  STATUS VARCHAR2(20) NOT NULL\n);\nCOMMENT ON COLUMN ORDERS.ID IS '订单主键';\nCOMMENT ON COLUMN ORDERS.ORDER_NO IS '订单号';\nCOMMENT ON COLUMN ORDERS.USER_ID IS '购买用户ID';\nCOMMENT ON COLUMN ORDERS.AMOUNT IS '订单金额';\nCOMMENT ON COLUMN ORDERS.STATUS IS '订单状态';\nCREATE INDEX IDX_ORDERS_USER ON ORDERS(USER_ID);\n`;

  const files = [];
  const add = (path, content) => files.push({ path: normalizePath(path), content });
  add(`${p.fileclasses}/体验接口字段.md`, demoApiClass(p));
  add(`${p.fileclasses}/体验数据库字段.md`, demoDbClass(p));
  add(p.apiBase, demoApiBase());
  add(p.dbBase, demoDbBase());

  const apiDocs = [
    ['创建订单', createOrderRequest, createOrderResponse],
    ['查询订单详情', null, queryResponse],
  ];
  for (const [apiName, request, response] of apiDocs) {
    const apiDocPath = `${p.apiDocs}/${apiName}.md`;
    add(apiDocPath, `# ${apiName}\n\n这是 Schema Tools 中文体验样例中的接口文档。\n\n## 请求参数\n\n![[${p.apiBase}#当前接口 Request]]\n\n## 响应参数\n\n![[${p.apiBase}#当前接口 Response]]\n`);
    for (const [direction, sample] of [['Request',request],['Response',response]]) {
      if (sample == null) continue;
      const rows = core.flattenJsonSample(sample);
      for (const row of rows) {
        const required = !['coupon_codes','items[].attributes'].includes(row.path);
        const highRisk = row.path.endsWith('mobile');
        const props = {
          fileClass: '体验接口字段',
          api: `[[${apiDocPath.replace(/\.md$/,'')}]]`,
          direction,
          path: row.path,
          parent_path: row.parent_path || '',
          name: row.name,
          shape: row.shape,
          data_type: row.data_type,
          required,
          high_risk: highRisk,
          description: demoDescription(row.path),
          db_column: demoDbMapping(p, row.path),
        };
        const fp = `${p.apiFields}/${core.makeApiFieldFilename(apiName,direction,row.path)}.md`;
        add(fp, `---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(apiName,direction,props)}`);
      }
    }
  }

  const dbTables = {
    orders: [
      ['id','BIGINT',false,true,true,false,'订单主键',''],
      ['order_no','VARCHAR(40)',false,false,true,false,'订单号',''],
      ['user_id','BIGINT',false,false,true,false,'购买用户ID',''],
      ['amount','DECIMAL(18,2)',false,false,false,true,'订单金额',''],
      ['payment_channel','VARCHAR(20)',true,false,false,false,'支付渠道',''],
      ['status','VARCHAR(20)',false,false,false,false,'订单状态',''],
    ],
    order_item: [
      ['id','BIGINT',false,true,true,false,'订单商品主键',''],
      ['order_id','BIGINT',false,false,true,false,'订单ID',demoDbColumnLink(p,'orders','id')],
      ['sku_id','BIGINT',false,false,false,false,'商品SKU ID',''],
      ['quantity','INT',false,false,false,false,'购买数量',''],
      ['price','DECIMAL(18,2)',false,false,false,false,'下单单价',''],
    ],
  };
  for (const [table, cols] of Object.entries(dbTables)) {
    const tableDocPath = `${p.dbDocs}/${table}.md`;
    const tableTitle = table === 'orders' ? 'orders（订单表）' : table === 'order_item' ? 'order_item（订单商品表）' : table;
    add(tableDocPath, `# ${tableTitle}\n\n这是 Schema Tools 中文体验样例中的数据库表。\n\n## 字段\n\n![[${p.dbBase}#当前数据表]]\n`);
    cols.forEach((c, i) => {
      const [name,data_type,nullable,primary_key,indexed,high_risk,description,references] = c;
      const props = { fileClass:'体验数据库字段', table:`[[${tableDocPath.replace(/\.md$/,'')}]]`, name, data_type, nullable, primary_key, indexed, high_risk, description };
      const fp = `${p.dbColumns}/${core.makeDbColumnFilename(table,name)}.md`;
      add(fp, `---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(table,props)}`);
    });
  }

  add(`${p.design}/订单创建设计.md`, `# 订单创建设计\n\n这个文档用于体验设计文档中的精准引用。\n\n## 业务说明\n\n创建订单时，需要记录购买人、商品明细、优惠券和支付信息。商品明细中的 SKU 会落库到订单商品表。\n\n## 精准引用体验\n\n在正文或笔记属性值输入框输入 \`@\`，依次选择：\n\n- 接口字段 → 创建订单 → Request → items → sku_id\n- 数据库字段 → order_item → sku_id\n\n示例关系：创建订单中的商品 SKU 最终写入 [[${p.dbColumns}/${core.makeDbColumnFilename('order_item','sku_id')}|order_item.sku_id]]。\n`);
  add(`${p.samples}/创建订单-请求.json`, JSON.stringify({__schema:{api:'创建订单',direction:'请求'},payload:createOrderRequest}, null, 2));
  add(`${p.samples}/创建订单-响应.json`, JSON.stringify({__schema:{api:'创建订单',direction:'响应'},payload:createOrderResponse}, null, 2));
  add(`${p.samples}/创建订单-请求-v2.json`, JSON.stringify({__schema:{api:'创建订单',direction:'请求'},payload:requestV2}, null, 2));
  add(`${p.samples}/订单表-MySQL.sql`, mysql);
  add(`${p.samples}/订单表-MySQL-v2.sql`, mysqlV2);
  add(`${p.samples}/订单表-Oracle.sql`, oracle);
  add(p.start, `# Schema Tools 中文体验样例\n\n> 样例中的接口名称、文档说明、JSON 字符串值、DDL 注释和引导内容均使用中文；字段名、表名等技术标识保留工程中常见的英文命名。\n\n本样例的所有文件都位于 **${p.root}/**，不会把接口、数据库、字段记录散落到 Vault 根目录。\n\n## 推荐体验顺序\n\n1. 点击左侧 Ribbon 的 **Schema Studio**，浏览“创建订单”和数据库表。\n2. 在 [[${p.design}/订单创建设计|订单创建设计]] 中输入 \`@\`，体验逐层精准引用；笔记属性值输入框也支持该功能。\n3. 打开 [[${p.apiDocs}/创建订单|创建订单]]，体验 Fileclass + Bases 的接口字段表。\n4. Schema Studio → 创建订单 → **JSON 导入 / 更新**，选择 [[${p.samples}/创建订单-请求-v2.json|创建订单-请求-v2.json]]，查看单元格内 \`旧值 → 新值\` 的差异。\n5. 数据库 → orders → **DDL 导入 / 更新**，使用 [[${p.samples}/订单表-MySQL-v2.sql|订单表-MySQL-v2.sql]]。\n6. 在 Schema Studio 字段表中体验 Excel/WPS 多单元格复制粘贴、排序、筛选、属性、搜索与新建。\n\n## 关于配置\n\n安装样例时，Schema Tools 会临时切换 API/数据库相关目录到本样例目录；如果已安装 Fileclass，还会把 **Class files folder** 临时切到 \`${p.fileclasses}\`。原配置已备份。\n\n完成体验后运行命令：\n\n**API & DB Schema Tools: 退出体验样例并恢复插件配置**\n\n它只恢复配置，不会自动删除 \`${p.root}/\`，避免误删你在样例中做的修改。\n`);
  return { paths:p, files };
}
function getFileclassPlugin(app) {
  return app?.plugins?.plugins?.fileclass || null;
}

function getFileclassClassPath(fileclass) {
  return String(fileclass?.settings?.classFilesPath || '');
}

async function setFileclassClassPath(fileclass, path) {
  if (!fileclass?.settings) return false;
  const normalized = path ? `${normalizePath(path).replace(/\/$/,'')}/` : '';
  fileclass.settings.classFilesPath = normalized;
  if (typeof fileclass.saveSettings === 'function') await fileclass.saveSettings();
  else if (typeof fileclass.saveData === 'function') await fileclass.saveData(fileclass.settings);
  return true;
}

class DemoInstallModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.plan = buildDemoFilePlan(); }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text:'安装 Schema Tools 中文体验样例' });
    contentEl.createEl('p', { text:`只会在 Vault 根目录新增一个目录：${this.plan.paths.root}/。样例共 ${this.plan.files.length} 个文件，全部位于该目录内。` });
    const callout = contentEl.createDiv({ cls:'schema-tools-demo-callout' });
    callout.createEl('strong', { text:'安装会修改插件配置，请确认：' });
    const ul = callout.createEl('ul');
    const settingsChanges = [
      ['Schema Tools · 接口文档目录', this.plugin.settings.apiDocsFolder, this.plan.paths.apiDocs],
      ['Schema Tools · 数据库文档目录', this.plugin.settings.dbDocsFolder, this.plan.paths.dbDocs],
      ['Schema Tools · 接口字段目录', this.plugin.settings.apiFieldsFolder, this.plan.paths.apiFields],
      ['Schema Tools · 数据库字段目录', this.plugin.settings.dbColumnsFolder, this.plan.paths.dbColumns],
      ['Schema Tools · API Base', this.plugin.settings.apiBaseName, this.plan.paths.apiBase],
      ['Schema Tools · DB Base', this.plugin.settings.dbBaseName, this.plan.paths.dbBase],
    ];
    for (const [name,before,after] of settingsChanges) ul.createEl('li', { text:`${name}：${before || '（空）'} → ${after}` });
    const fc = getFileclassPlugin(this.app);
    if (fc) {
      const oldFc = getFileclassClassPath(fc);
      ul.createEl('li', { text:`Fileclass · Class files folder：${oldFc || '（空）'} → ${this.plan.paths.fileclasses}/` });
      if (oldFc && normalizePath(oldFc) !== normalizePath(this.plan.paths.fileclasses)) {
        const impact = contentEl.createDiv({ cls:'schema-tools-demo-warning' });
        impact.setText('注意：切换 Fileclass Class files folder 后，你当前 class 目录中的类会暂时不参与 Fileclass 解析；运行“退出体验样例并恢复插件配置”后会恢复原路径。');
      }
    } else ul.createEl('li', { text:'Fileclass：未安装，不修改。样例仍可在 Schema Studio 中使用，但 .base 的 typed editing 需要安装并配置 Fileclass。' });
    contentEl.createEl('p', { text:'切换期间 Schema Studio 也只浏览样例目录中的接口/数据库；不会移动、改写或删除现有业务文件。退出样例模式可一键恢复上述插件配置；样例目录会保留，避免误删你的体验修改。', cls:'schema-tools-muted' });
    const existing = this.app.vault.getAbstractFileByPath(this.plan.paths.root);
    if (existing) {
      const warn = contentEl.createDiv({ cls:'schema-tools-demo-warning' });
      warn.setText(`检测到 ${this.plan.paths.root}/ 已存在。为避免覆盖，安装命令不会修改其中任何文件。如果这是旧版本样例，请先恢复配置并自行重命名或删除该目录，再重新安装中文样例。`);
    }
    const actions = contentEl.createDiv({ cls:'schema-tools-actions' });
    const cancel = actions.createEl('button', { text:'取消' }); cancel.onclick=()=>this.close();
    if (existing) {
      const open = actions.createEl('button', { text:'只打开入口' });
      open.onclick=async()=>{ this.close(); await this.plugin.openDemoStart(); };
      const activate = actions.createEl('button', { text:this.plugin.settings.demoState?.active ? '样例模式已启用' : '切换到现有样例', cls:'mod-cta' });
      activate.disabled = !!this.plugin.settings.demoState?.active;
      activate.onclick=async()=>{ activate.disabled=true; try { await this.plugin.activateExistingDemo(this.plan); this.close(); } catch(e) { new Notice(`切换失败：${e.message}`); activate.disabled=false; } };
    } else {
      const install = actions.createEl('button', { text:'创建样例并切换配置', cls:'mod-cta' });
      install.onclick=async()=>{ install.disabled=true; try { await this.plugin.installDemo(this.plan); this.close(); } catch(e) { console.error(e); new Notice(`样例安装失败：${e.message}`); install.disabled=false; } };
    }
  }
  onClose(){ this.contentEl.empty(); }
}

class DemoRestoreModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin=plugin; }
  onOpen(){
    const {contentEl}=this; contentEl.empty(); contentEl.createEl('h2',{text:'退出 Schema Tools 体验样例'});
    const state=this.plugin.settings.demoState;
    if(!state?.active){ contentEl.createEl('p',{text:'当前没有处于体验样例模式。'}); const b=contentEl.createEl('button',{text:'关闭'});b.onclick=()=>this.close();return; }
    contentEl.createEl('p',{text:'将恢复安装样例前备份的 Schema Tools 配置；如果安装时修改了 Fileclass Class files folder，也会恢复。'});
    contentEl.createEl('p',{text:`不会删除 ${state.root || DEMO_ROOT}/，避免误删你在样例中的修改。`,cls:'schema-tools-muted'});
    const actions=contentEl.createDiv({cls:'schema-tools-actions'}); const cancel=actions.createEl('button',{text:'取消'});cancel.onclick=()=>this.close(); const restore=actions.createEl('button',{text:'恢复配置并退出样例',cls:'mod-cta'});restore.onclick=async()=>{restore.disabled=true;try{await this.plugin.restoreDemoSettings();this.close();}catch(e){new Notice(`恢复失败：${e.message}`);restore.disabled=false;}};
  }
  onClose(){this.contentEl.empty();}
}


class SchemaToolsPlugin extends Plugin {
  async onload() {
    // 顶层 boot 在 Obsidian 里注定失败（__dirname 指向 electron.asar/renderer）。
    // 这里用 vault 绝对路径 + manifest.dir 拼出插件真实目录再试一次。
    if (!xxl) {
      const absDir = xxlAbsolutePluginDir(this);
      if (absDir) bootXxl(absDir);
    }
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.schemaState = { version: 1, updatedAt: '', records: {} };
    await this.loadSchemaState();
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file && normalizePath(file.path) === this.schemaStatePath()) this.loadSchemaState().catch(() => {});
    }));
    this.addSettingTab(new SchemaToolsSettingTab(this.app, this));

    // Register our suggester normally, then move only this suggester ahead of the
    // native wikilink suggester. Obsidian stops at the first EditorSuggest whose
    // onTrigger() returns a context. SchemaInlineSuggest returns null unless the
    // cursor is after a standalone @, so normal wikilinks still fall through to
    // Obsidian.
    this.schemaInlineSuggest = new SchemaInlineSuggest(this);
    this.registerEditorSuggest(this.schemaInlineSuggest);
    this.setSchemaInlineSuggestPriority(this.settings.prioritizeInlineSuggest !== false);

    // Obsidian's EditorSuggest only covers CodeMirror editors. Note Properties
    // are native input/textarea elements, so they need a small DOM-backed
    // suggester that reuses the same hierarchical suggestion builder.
    this.propertySuggest = new SchemaPropertySuggest(this);
    this.propertySuggest.register();
    this.register(() => this.propertySuggest.destroy());

    this.addRibbonIcon('database', 'Schema Studio', () => {
      new SchemaStudioModal(this.app, this).open();
    });
    this.addCommand({
      id: 'open-schema-studio',
      name: '打开 Schema Studio',
      callback: () => new SchemaStudioModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'install-demo-sample',
      name: '安装 / 打开体验样例',
      callback: () => new DemoInstallModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'restore-from-demo-sample',
      name: '退出体验样例并恢复插件配置',
      callback: () => new DemoRestoreModal(this.app, this).open(),
    });

    // ★ 字段表 → 表文档「## 建表语句」实时同步（默认关闭，见设置项）。
    //   三个事件都听：新增列、改列、删列都会影响建表语句。
    this._fieldTimers = new Map();
    const onFieldChange = (file) => this.onFieldFileModified(file);
    this.registerEvent(this.app.vault.on('modify', onFieldChange));
    this.registerEvent(this.app.vault.on('create', onFieldChange));
    this.registerEvent(this.app.vault.on('delete', onFieldChange));
    this.register(() => {
      for (const t of this._fieldTimers.values()) clearTimeout(t);
      this._fieldTimers.clear();
    });
    // 反向：表文档里的建表语句被改动 → 同步字段表（同样默认关闭）
    this._tableDocTimers = new Map();
    const onTableDocChange = (file) => this.onTableDocModified(file);
    this.registerEvent(this.app.vault.on('modify', onTableDocChange));
    this.register(() => {
      for (const t of this._tableDocTimers.values()) clearTimeout(t);
      this._tableDocTimers.clear();
    });
    this.addCommand({
      id: 'sync-fields-to-table-doc',
      name: '按字段表更新当前表的建表语句',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isTableDocPath(file.path)) return false;
        if (!checking) this.runFieldsToTableDocSync(file.path, { manual: true });
        return true;
      },
    });
    this.addCommand({
      id: 'sync-all-fields-to-table-docs',
      name: '同步全部字段表到各表的建表语句',
      callback: () => this.syncAllFieldsToTableDocs(),
    });
    this.addCommand({
      id: 'sync-table-doc-to-fields',
      name: '按当前表的建表语句更新字段表',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isTableDocPath(file.path)) return false;
        if (!checking) this.runTableDocSync(file.path, { manual: true });
        return true;
      },
    });
    this.addCommand({
      id: 'sync-all-table-docs-to-fields',
      name: '同步全部建表语句到各表的字段表',
      callback: () => this.syncAllTableDocsToFields(),
    });
  }
  async saveSettings() { await this.saveData(this.settings); }

  // --- 中心化状态载体（P0 / P1）------------------------------------------------
  // 运行态（来源方式 / 方言 / 疑似删除 / 最后导入时间）不再寄生在业务文档上，
  // 统一放在字段记录目录同级的 `.schema-state.json`；`疑似删除` 也从这里读。
  schemaStatePath() { return schemaStatePathFor(this.settings.dbColumnsFolder); }
  // xxl-job 域独立的状态文件：记来源 XML / 原任务 id / 导入时间，不写进业务文档正文
  xxljobStatePath() { return xxlStatePathFor(this.settings.xxljobDocsFolder || DEFAULTS.xxljobDocsFolder); }
  async loadXxljobState() { return this.loadSchemaState(this.xxljobStatePath()); }
  async patchXxljobState(patch) { return this.patchSchemaState(patch, this.xxljobStatePath()); }
  schemaStateFor(filePath) { return this.schemaState?.records?.[normalizePath(filePath)] || null; }
  isSchemaOrphaned(filePath) { return !!this.schemaStateFor(filePath)?.orphaned; }
  async loadSchemaState(statePath) {
    const path = statePath || this.schemaStatePath();
    const empty = { version: 1, updatedAt: '', records: {} };
    // 只有读「主状态文件」时才覆盖内存态；读别的状态文件（如 xxl-job 的）不能顶掉它
    if (!statePath) this.schemaState = empty;
    const out = statePath ? { version: 1, updatedAt: '', records: {} } : this.schemaState;
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return out;
      const parsed = JSON.parse(await this.app.vault.read(file));
      if (parsed && typeof parsed === 'object') {
        out.version = parsed.version || 1;
        out.updatedAt = parsed.updatedAt || '';
        out.records = parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
      }
    } catch (e) { console.warn('[Schema Studio] 读取状态文件失败，按空状态继续', e); }
    return out;
  }
  async patchSchemaState(patch, statePath) {
    if (!patch || !Object.keys(patch).length) return;
    const path = statePath || this.schemaStatePath();
    const state = await this.loadSchemaState(path);
    for (const [filePath, value] of Object.entries(patch)) {
      const key = normalizePath(filePath);
      state.records[key] = Object.assign({}, state.records[key] || {}, value);
    }
    state.updatedAt = new Date().toISOString();
    try {
      await ensureFolder(this.app, path.split('/').slice(0, -1).join('/'));
      const body = JSON.stringify(state, null, 2) + '\n';
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.app.vault.modify(file, body);
      else await this.app.vault.create(path, body);
      if (!statePath) this.schemaState = state;
    } catch (e) { console.warn('[Schema Studio] 写入状态文件失败', e); }
  }

  async createDemoFiles(plan) {
    for (const item of plan.files) {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      if (parent) await ensureFolder(this.app, parent);
      if (this.app.vault.getAbstractFileByPath(item.path)) throw new Error(`目标已存在：${item.path}`);
      await this.app.vault.create(item.path, item.content);
    }
  }

  async activateDemoSettings(plan = buildDemoFilePlan()) {
    if (this.settings.demoState?.active) return;
    const previousSchemaSettings = {
      apiDocsFolder: this.settings.apiDocsFolder,
      dbDocsFolder: this.settings.dbDocsFolder,
      apiFieldsFolder: this.settings.apiFieldsFolder,
      dbColumnsFolder: this.settings.dbColumnsFolder,
      apiBaseName: this.settings.apiBaseName,
      dbBaseName: this.settings.dbBaseName,
    };
    const fc = getFileclassPlugin(this.app);
    const previousFileclassPath = fc ? getFileclassClassPath(fc) : null;
    this.settings.demoState = {
      active: true,
      root: plan.paths.root,
      installedAt: new Date().toISOString(),
      previousSchemaSettings,
      fileclassInstalled: !!fc,
      previousFileclassPath,
    };
    Object.assign(this.settings, {
      apiDocsFolder: plan.paths.apiDocs,
      dbDocsFolder: plan.paths.dbDocs,
      apiFieldsFolder: plan.paths.apiFields,
      dbColumnsFolder: plan.paths.dbColumns,
      apiBaseName: plan.paths.apiBase,
      dbBaseName: plan.paths.dbBase,
      gridViewPrefs: { api:{ hiddenProps:[], sorts:[], filters:[] }, db:{ hiddenProps:[], sorts:[], filters:[] } },
    });
    await this.saveSettings();
    if (fc) await setFileclassClassPath(fc, plan.paths.fileclasses);
  }

  async installDemo(plan = buildDemoFilePlan()) {
    if (this.app.vault.getAbstractFileByPath(plan.paths.root)) throw new Error(`样例目录已存在：${plan.paths.root}`);
    await this.createDemoFiles(plan);
    await this.activateDemoSettings(plan);
    new Notice(`体验样例已创建：${plan.paths.root}/`);
    await this.openDemoStart();
  }

  async activateExistingDemo(plan = buildDemoFilePlan()) {
    if (!this.app.vault.getAbstractFileByPath(plan.paths.start)) throw new Error('现有样例不完整：缺少 00-开始这里.md');
    await this.activateDemoSettings(plan);
    new Notice('已切换到现有体验样例配置');
    await this.openDemoStart();
  }

  async openDemoStart() {
    const root = this.settings.demoState?.root || DEMO_ROOT;
    const file = this.app.vault.getAbstractFileByPath(`${normalizePath(root)}/00-开始这里.md`);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
    else new Notice('没有找到体验样例入口文档');
  }

  async restoreDemoSettings() {
    const state = this.settings.demoState;
    if (!state?.active) { new Notice('当前没有处于体验样例模式'); return; }
    Object.assign(this.settings, state.previousSchemaSettings || {});
    this.settings.demoState = Object.assign({}, state, { active:false, restoredAt:new Date().toISOString() });
    await this.saveSettings();
    const fc = getFileclassPlugin(this.app);
    if (fc && state.fileclassInstalled) await setFileclassClassPath(fc, state.previousFileclassPath || '');
    new Notice('已恢复安装体验样例前的插件配置。样例目录仍保留。');
  }

  setSchemaInlineSuggestPriority(enabled) {
    // Compatibility switch: Obsidian has no public EditorSuggest priority API.
    // When enabled we move only our own suggester to the front so @ can beat
    // the native suggesters. When disabled we move it to the end. This gives
    // users a reversible A/B test for plugin conflicts without disabling
    // Schema Studio itself.
    try {
      const list = this.app?.workspace?.editorSuggest?.suggests;
      if (!Array.isArray(list) || !this.schemaInlineSuggest) return;
      const index = list.indexOf(this.schemaInlineSuggest);
      if (index >= 0) list.splice(index, 1);
      if (enabled) list.unshift(this.schemaInlineSuggest);
      else list.push(this.schemaInlineSuggest);
    } catch (error) {
      console.warn('[API Database Schema Tools] Could not change inline schema suggester priority.', error);
    }
  }

  findFileClassForFolder(folder, fallbackName) {
    const target = normalizePath(folder || '');
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const paths = arrish(fm.filesPaths).map(x => normalizePath(String(x || '')));
      if (paths.includes(target) && Array.isArray(fm.fields)) {
        return { file, className: basenameNoExt(file.path), fields: fm.fields.map(normalizeFieldDefinition).filter(Boolean) };
      }
    }
    // 目录不固定（例如 xxl-job 的 8.xxljob/<执行器>/任务）时，按 fileClass 名兜底
    return fallbackName ? this.findFileClassByName(fallbackName) : null;
  }

  /** 按 fileClass 名找定义文件：命中「文件名 == 类名且含 fields 定义」的那份 md */
  findFileClassByName(className) {
    const name = String(className || '').trim();
    if (!name) return null;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (basenameNoExt(file.path) !== name) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      if (!Array.isArray(fm.fields)) continue;
      return { file, className: name, fields: fm.fields.map(normalizeFieldDefinition).filter(Boolean) };
    }
    return null;
  }

  /** xxl-job 某层级目录对应的 fileClass 定义（找不到返回 null，不阻塞浏览与导入） */
  xxljobFileClass(levelDir) {
    return this.findFileClassByName(XXL_CLASS_BY_LEVEL[levelDir]);
  }

  getFieldDefinitions(domain) {
    if (domain === 'xxljob') {
      // xxl-job 是「一份任务一份文档」的三层树，不做字段级 grid 编辑；
      // 这里只用来让「新建文档」等场景能拿到对应层级的字段定义。
      const fields = new Map();
      for (const dirName of [XXL_DIRS.flow, XXL_DIRS.task, XXL_DIRS.component]) {
        for (const def of this.xxljobFileClass(dirName)?.fields || []) if (!fields.has(def.name)) fields.set(def.name, def);
      }
      return { className: 'xxljob', fields: [...fields.values()] };
    }
    const folder = domain === 'api' ? this.settings.apiFieldsFolder : this.settings.dbColumnsFolder;
    const cls = this.findFileClassForFolder(folder);
    const defs = new Map((cls?.fields || []).map(d => [d.name, d]));
    const rows = domain === 'api' ? this.scanApiFields() : this.scanDbColumns();
    for (const row of rows) for (const key of Object.keys(row.fm || {})) {
      if (FRONTMATTER_INTERNAL_KEYS.has(key) || key === 'fileClass' || SCHEMA_INTERNAL_KEYS.has(key)) continue;
      if (!defs.has(key)) defs.set(key, { name:key, type:typeof row.fm[key] === 'boolean' ? 'Boolean' : typeof row.fm[key] === 'number' ? 'Number' : 'Input', required:false, options:[] });
    }
    return { className: cls?.className || (domain === 'api' ? 'ApiField' : 'DbColumn'), fields:[...defs.values()] };
  }

  defaultPropertiesForDomain(domain) {
    const schema = this.getFieldDefinitions(domain);
    const out = { fileClass: schema.className };
    for (const def of schema.fields) out[def.name] = defaultForField(def);
    return out;
  }

  // 模板（Fileclass）里**定义过**的属性名单。落盘前用它过滤生成侧的多余键：
  // getFieldDefinitions 会把「扫描到的未知键」也并进列定义（为了让历史英文键仍能显示与编辑），
  // 那份名单不能直接当白名单用 —— 拿它过滤会误伤；这里只取模板自己的 fields。
  fileclassPropertySet(domain) {
    if (domain !== 'api' && domain !== 'db') return null;
    const folder = domain === 'api' ? this.settings.apiFieldsFolder : this.settings.dbColumnsFolder;
    const cls = this.findFileClassForFolder(folder, domain === 'api' ? 'ApiField' : 'DbColumn');
    const names = (cls?.fields || []).map((d) => String(d.name));
    return names.length ? new Set(names) : null;
  }

  scanApiFields() {
    const prefix = normalizePath(this.settings.apiFieldsFolder) + '/';
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => {
      const fm = stripCacheKeys(this.app.metadataCache.getFileCache(file)?.frontmatter || {});
      const apiPath = fmLinkPath(schemaValue(fm,'api','api'));
      const directionValue = schemaValue(fm,'api','direction');
      const apiName = basenameNoExt(apiPath);
      // 模块判定：接口文档路径落在哪个目录最可靠；判定不出来再退回字段文件名前缀。
      // 本库 5.api 与 6.client 下有同名接口，不区分就会把两边的字段混成一组。
      const apiModule = this.apiModuleForPath(apiPath) || apiModuleFromFilename(file.path);
      const direction = normalizeDirection(directionValue) || directionValue || '';
      // 文件名格式「<接口名>__<方向>__<字段路径>」，字段名缺失时按同样规则剥掉前缀还原
      const fallbackName = memberNameFromFilename(memberNameFromFilename(file.path, apiName), direction);
      const pathValue = schemaValue(fm,'api','path') || '';
      // 层级**从路径推导**，不再依赖落盘的 parent_path / name / shape / order：
      // 模板（ApiField）里写明「父子层级完全由路径本身表达，不另设层级属性」，
      // 这几个键在模板里没有对应属性，落盘只会污染业务文档（自动提示的树也从这里长出来）。
      const derived = deriveApiHierarchy(pathValue, schemaValue(fm,'api','data_type'));
      return {
        file, filePath: file.path, apiPath, apiName, apiModule,
        direction, path: pathValue,
        parent_path: schemaValue(fm,'api','parent_path') || derived.parent_path,
        name: schemaValue(fm,'api','name') || derived.name || fallbackName,
        shape: schemaValue(fm,'api','shape') || derived.shape,
        data_type: schemaValue(fm,'api','data_type') || '',
        schema_orphaned: this.isSchemaOrphaned(file.path), order: Number(schemaValue(fm,'api','order') || 0), fm,
      };
    }).filter(x => x.apiName && x.direction && x.path);
  }
  // 接口文档路径 → 模块。落在外部接口目录下就是外部接口，落在接口目录下就是内部接口，
  // 其余（老数据 / 自定义目录）返回 '' 表示不区分。
  apiModuleForPath(docPath) {
    const p = normalizePath(String(docPath || ''));
    if (!p) return '';
    const inside = (folder) => { const f = normalizePath(String(folder || '')); return !!f && (p === f || p.startsWith(f + '/')); };
    if (inside(this.settings.clientDocsFolder)) return API_MODULES[1];
    if (inside(this.settings.apiDocsFolder)) return API_MODULES[0];
    return '';
  }
  scanDbColumns() {
    const prefix = normalizePath(this.settings.dbColumnsFolder) + '/';
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => {
      const fm = stripCacheKeys(this.app.metadataCache.getFileCache(file)?.frontmatter || {});
      const tablePath = fmLinkPath(schemaValue(fm,'db','table'));
      const table = basenameNoExt(tablePath);
      return {
        file, filePath: file.path, tablePath, table,
        // 字段名缺失时从文件名还原（剥掉「<表名>__」前缀），否则整串文件名会被当成列名
        name: schemaValue(fm,'db','name') || memberNameFromFilename(file.path, table), data_type: schemaValue(fm,'db','data_type') || '',
        nullable: bool(schemaValue(fm,'db','nullable'), true), primary_key: bool(schemaValue(fm,'db','primary_key')),
        indexed: bool(schemaValue(fm,'db','indexed')), schema_orphaned: this.isSchemaOrphaned(file.path),
        default_value: schemaValue(fm,'db','default_value') ?? '', references: schemaValue(fm,'db','references') || '',
        ddl_comment: schemaValue(fm,'db','ddl_comment') || '', order: Number(schemaValue(fm,'db','order') || 0), fm,
      };
    }).filter(x => x.table && x.name);
  }

  // ==== 字段表 → 表文档「## 建表语句」（自 v0.7.22 移植） ========================
  // 表文档判定：在 dbDocsFolder 子树内，且不与 dbColumnsFolder 重叠（重叠时分不清源与产物）
  isTableDocPath(path) {
    const p = normalizePath(String(path || ''));
    if (!p || !/\.md$/i.test(p)) return false;
    const inside = (folder) => { const f = normalizePath(String(folder || '')); return !!f && (p === f || p.startsWith(f + '/')); };
    return inside(this.settings.dbDocsFolder) && !inside(this.settings.dbColumnsFolder);
  }
  isFieldFilePath(path) {
    const p = normalizePath(String(path || ''));
    if (!p || !/\.md$/i.test(p)) return false;
    const f = normalizePath(String(this.settings.dbColumnsFolder || ''));
    return !!f && (p === f || p.startsWith(f + '/'));
  }
  // 插件自己刚写过这份表文档 → 没有用户新意图，跳过；否则会与「建表语句 → 字段表」来回抖
  markDocSelfWrite(path, text) {
    if (!this._docSelfWrites) this._docSelfWrites = new Map();
    this._docSelfWrites.set(normalizePath(path), String(text == null ? '' : text));
  }
  isDocSelfWrite(path, text) {
    const key = normalizePath(path);
    const rec = this._docSelfWrites && this._docSelfWrites.get(key);
    if (rec === undefined) return false;
    if (rec === String(text == null ? '' : text)) return true;
    this._docSelfWrites.delete(key);
    return false;
  }
  // 由列文件反查所属表文档：优先读 frontmatter 的「数据表」链接，其次按文件名前缀在表文档目录里找
  async resolveTableDocForFieldFile(fieldPath) {
    const p = normalizePath(fieldPath);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (file) {
      const fm = stripCacheKeys(this.app.metadataCache.getFileCache(file)?.frontmatter || {});
      const link = fmLinkPath(schemaValue(fm, 'db', 'table'));
      if (link) return link.replace(/\.md$/i, '') + '.md';
    }
    const tableName = basenameNoExt(p).split('__')[0];
    if (!tableName) return null;
    const prefix = normalizePath(String(this.settings.dbDocsFolder || '')) + '/';
    const hit = this.app.vault.getMarkdownFiles().find((f) => f.path.startsWith(prefix) && basenameNoExt(f.path) === tableName && this.isTableDocPath(f.path));
    return hit ? hit.path : null;
  }
  onFieldFileModified(file) {
    if (!this.settings.syncTableDocFromFields) return;
    if (!this.isFieldFilePath(file && file.path)) return;
    if (!this._fieldTimers) this._fieldTimers = new Map();
    const p = normalizePath(file.path);
    const prev = this._fieldTimers.get(p);
    if (prev) clearTimeout(prev);
    // 防抖：属性面板里连续改几个属性只同步一次
    this._fieldTimers.set(p, setTimeout(() => {
      this._fieldTimers.delete(p);
      this.runFieldsToTableDocSync(p, { manual: false });
    }, Math.max(300, Number(this.settings.autoSyncDebounceMs) || 1200)));
  }
  // 核心：以字段表为源，补丁式重建表文档「## 建表语句」（幂等，见 buildDdlFromColumns）
  async syncFieldsToTableDoc(docPath) {
    const path = normalizePath(docPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return { ok: false, reason: 'not-found' };
    const text = String(await this.app.vault.read(file));
    const sql = readSectionCodeBlock(text, '建表语句');
    // 占位注释（`-- 待补充`）与空代码块不算 DDL，一律跳过
    if (!sql.trim() || !/create\s+table/i.test(sql)) return { ok: false, reason: 'empty' };
    const table = basenameNoExt(path);
    // 「疑似删除」的列不参与重建 —— 否则删除标记形同失效（重建会把它加回 SQL）
    const columns = this.scanDbColumns().filter(x => x.table === table && !x.schema_orphaned)
      .map(x => ({
        name: x.name, data_type: x.data_type, nullable: x.nullable !== false,
        primary_key: !!x.primary_key, indexed: !!x.indexed,
        default_value: x.default_value == null ? '' : String(x.default_value),
        desc: String(schemaValue(x.fm || {}, 'db', 'description') || ''),
      }));
    if (!columns.length) return { ok: false, reason: 'no-columns', table };
    const wanted = String(this.settings.autoSyncDialect || 'auto');
    const dialectId = (wanted === 'auto' || !DDL_DIALECTS[wanted]) ? detectDdlDialect(sql) : wanted;
    const r = buildDdlFromColumns({ sql, table, columns, dialect: dialectId });
    if (!r.ok) return { ok: false, reason: r.reason, table };
    // 安全闸：一次要删掉的列超过一半，多半是「列文件只建了一部分」而不是真要删列，宁可不改
    let originCount = 0;
    try { const t = parseDdlWithDialect(sql, dialectId).find(x => String(x.table || '').toLowerCase() === table.toLowerCase()); originCount = t ? t.columns.length : 0; } catch (e) { /* 解析失败时按 0 处理，等于不放行 */ }
    const maxDrop = Math.max(1, Math.floor(originCount * 0.5));
    if (r.stats.removed > maxDrop) return { ok: false, reason: 'too-many-removed', table, stats: r.stats, removed: r.stats.removed, existing: originCount };
    if (!r.changed) return { ok: true, noop: true, table, stats: r.stats };
    const next = upsertSectionCodeBlock(text, '建表语句', 'sql', r.sql);
    if (next !== text) {
      await this.app.vault.modify(file, next);
      this.markDocSelfWrite(path, next);
    }
    return { ok: true, table, stats: r.stats };
  }
  async runFieldsToTableDocSync(path, options = {}) {
    const manual = !!(options && options.manual);
    const name = basenameNoExt(path);
    return this.withSyncLock(async () => {
      try {
        let docPath = null;
      if (this.isTableDocPath(path)) {
        docPath = normalizePath(path);            // 用户在表文档里手动触发：不查自写抑制
      } else {
        docPath = await this.resolveTableDocForFieldFile(path);
      }
      if (!docPath || !this.isTableDocPath(docPath)) {
        if (manual) new Notice(`「${name}」没有找到所属的表文档，未同步。`);
        return { ok: false, reason: 'no-table-doc' };
      }
      const r = await this.syncFieldsToTableDoc(docPath);
      if (!r.ok) {
        if (manual) {
          const docName = basenameNoExt(docPath);
          const why = r.reason === 'empty' ? '表文档里没有可用的「## 建表语句」（占位注释不算）'
            : r.reason === 'not-found' ? '表文档不存在'
            : r.reason === 'no-columns' ? `「${r.table || docName}」没有对应的列文件`
            : r.reason === 'parse-error' ? '建表语句解析失败（不是可识别的 CREATE TABLE）'
            : r.reason === 'no-create-table' ? '建表语句里找不到这张表的 CREATE TABLE'
            : r.reason === 'too-many-removed' ? `字段表只覆盖 ${r.existing - r.removed} 列，建表语句有 ${r.existing} 列，疑似列文件不完整，已跳过`
            : r.reason;
          new Notice(`「${docName}」未同步：${why}`);
        } else if (r.reason === 'too-many-removed') {
          new Notice(`「${basenameNoExt(docPath)}」建表语句有 ${r.existing} 列、字段表只覆盖 ${r.existing - r.removed} 列，疑似列文件不完整，已跳过本次自动同步。`);
        }
        return r;
      }
      if (r.noop) {
        if (manual) new Notice(`「${r.table}」建表语句已与字段表一致，无需更新。`);
        return r;
      }
      const s = r.stats || {}, bits = [];
      if (s.added) bits.push(`新增列 ${s.added}`);
      if (s.changed) bits.push(`更新列 ${s.changed}`);
      if (s.removed) bits.push(`移除列 ${s.removed}`);
      if (s.primaryKey === 'added') bits.push('补主键');
      if (s.primaryKey === 'updated') bits.push('更新主键');
      if (s.primaryKey === 'removed') bits.push('移除主键');
      if (s.commentsAdded) bits.push(`补注释 ${s.commentsAdded}`);
      if (s.indexesAdded) bits.push(`补索引 ${s.indexesAdded}`);
      new Notice(`「${r.table}」建表语句已按字段表更新：${bits.length ? bits.join(' · ') : '已重建'}`);
      return r;
    } catch (e) {
      console.error('[Schema Studio] 字段表同步建表语句失败：', path, e);
      if (manual) new Notice(`「${name}」同步失败：${(e && e.message) || e}`);
      return { ok: false, reason: 'exception', message: (e && e.message) || String(e) };
      }
    });
  }
  async syncAllFieldsToTableDocs() {
    const prefix = normalizePath(String(this.settings.dbDocsFolder || '')) + '/';
    const docs = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix) && this.isTableDocPath(f.path));
    if (!docs.length) { new Notice(`「${this.settings.dbDocsFolder}」下没有找到表文档。`); return; }
    let synced = 0, skipped = 0;
    for (const f of docs) {
      try {
        const r = await this.syncFieldsToTableDoc(f.path);
        if (r.ok && !r.noop) synced++; else skipped++;
      } catch (e) {
        console.error('[Schema Studio] 批量同步建表语句失败：', f.path, e);
        skipped++;
      }
    }
    new Notice(`字段 → 建表语句 同步完成：${synced} 个已更新 · ${skipped} 个无变化或已跳过（共 ${docs.length} 个表文档）`);
  }

  // ==== 表文档「## 建表语句」 → 字段表（反向同步） ============================
  // 无界面地借用 SchemaStudioModal 的纯逻辑（读文档 → 解析 → 分析 → 落盘）。
  // 刻意不走构造函数：Modal / Scope 会带来 DOM 与快捷键副作用，而这些方法只用到 app / plugin。
  createSyncOperator() {
    const op = Object.create(SchemaStudioModal.prototype);
    op.app = this.app;
    op.plugin = this;
    op.importState = null;
    op.pendingEdits = new Map();
    return op;
  }
  // 重入锁：两个方向同时开着时，一方的写文件会触发另一方的 vault 事件。
  // 幂等重建 + 自写抑制已经是第二道防线，这层保证同一时刻只有一个方向在跑。
  async withSyncLock(fn) {
    if (this._syncBusy) return { ok: false, reason: 'busy' };
    this._syncBusy = true;
    try { return await fn(); } finally { this._syncBusy = false; }
  }
  onTableDocModified(file) {
    if (!this.settings.syncFieldsFromTableDoc) return;
    if (!this.isTableDocPath(file && file.path)) return;
    if (!this._tableDocTimers) this._tableDocTimers = new Map();
    const p = normalizePath(file.path);
    const prev = this._tableDocTimers.get(p);
    if (prev) clearTimeout(prev);
    // 防抖：用户还在键盘上敲 SQL 时不触发，停手后才同步一次
    this._tableDocTimers.set(p, setTimeout(() => {
      this._tableDocTimers.delete(p);
      this.runTableDocSync(p, { manual: false });
    }, Math.max(300, Number(this.settings.autoSyncDebounceMs) || 1200)));
  }
  async runTableDocSync(docPath, options = {}) {
    const manual = !!(options && options.manual);
    const name = basenameNoExt(docPath);
    return this.withSyncLock(async () => {
      try {
        const op = this.createSyncOperator();
        const r = await op.syncTableDocToFields(docPath);
        if (!r.ok) {
          // 自动模式下的「无 SQL / 无变化」是常态，静默跳过；其余原因一律提示，避免"改了没反应"
          if (manual) {
            const why = r.reason === 'no-sql' ? '没有找到「## 建表语句」代码块（占位注释不算）'
              : r.reason === 'not-found' ? '文档不存在'
              : r.reason === 'self-write' ? '文档内容与插件上次写入的一致，没有新的改动需要同步'
              : r.reason === 'parse-error' ? `SQL 解析失败：${r.message || ''}`
              : r.reason === 'too-many-removed' ? `建表语句里少了 ${r.removed} 列（原 ${r.existing} 列），疑似 SQL 未写完，已跳过`
              : r.reason === 'busy' ? '另一侧同步正在执行，已跳过'
              : r.reason;
            new Notice(`「${name}」未同步：${why}`);
          } else if (r.reason === 'too-many-removed') {
            new Notice(`「${name}」建表语句里少了 ${r.removed} 列（原 ${r.existing} 列），疑似还没写完，已跳过本次自动同步。`);
          }
          return r;
        }
        if (r.noop) {
          if (manual) new Notice(`「${r.table}」字段已与建表语句一致，无需同步。`);
          return r;
        }
        const res = r.result || {}, bits = [];
        if (res.created) bits.push(`新增列 ${res.created}`);
        if (res.updated) bits.push(`更新列 ${res.updated}`);
        if (res.repaired) bits.push(`补写字段名 ${res.repaired}`);
        if (res.restored) bits.push(`解除删除标记 ${res.restored}`);
        if (res.orphaned) bits.push(`标记删除 ${res.orphaned}`);
        new Notice(`「${r.table}」字段已按建表语句更新：${bits.length ? bits.join(' · ') : '已同步'}`);
        return r;
      } catch (e) {
        console.error('[Schema Studio] 建表语句同步字段失败：', docPath, e);
        if (manual) new Notice(`「${name}」同步失败：${(e && e.message) || e}`);
        return { ok: false, reason: 'exception', message: (e && e.message) || String(e) };
      }
    });
  }
  async syncAllTableDocsToFields() {
    const prefix = normalizePath(String(this.settings.dbDocsFolder || '')) + '/';
    const docs = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix) && this.isTableDocPath(f.path));
    if (!docs.length) { new Notice(`「${this.settings.dbDocsFolder}」下没有找到表文档。`); return; }
    let synced = 0, skipped = 0;
    for (const f of docs) {
      const r = await this.runTableDocSync(f.path);
      if (r && r.ok && !r.noop) synced++; else skipped++;
    }
    new Notice(`建表语句 → 字段 同步完成：${synced} 个已更新 · ${skipped} 个无变化或已跳过（共 ${docs.length} 个表文档）`);
  }
}

class SchemaToolsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('h2', { text: 'Schema Tools' });
    const fields = [
      ['apiDocsFolder','接口文档目录'],['clientDocsFolder','外部接口文档目录'],['dbDocsFolder','数据库文档目录'],
      ['apiFieldsFolder','接口字段记录目录'],['dbColumnsFolder','数据库字段记录目录'],
    ];
    for (const [key, name] of fields) {
      new Setting(containerEl).setName(name).addText(t => t.setValue(this.plugin.settings[key]).onChange(async v => {
        this.plugin.settings[key] = v.trim(); await this.plugin.saveSettings();
      }));
    }
    new Setting(containerEl)
      .setName('新建表文档的模板')
      .setDesc('DDL 导入或手工新建数据库表时，套用这个模板生成表文档：表中文名取 DDL 的 COMMENT ON TABLE，数据库Schema、表名、建表语句自动填。留空则使用内置的最小结构。')
      .addText(t => t.setValue(this.plugin.settings.dbDocTemplate || '').onChange(async v => {
        this.plugin.settings.dbDocTemplate = v.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('新建接口文档的模板（内部接口）')
      .setDesc('导入 JSON / XML 时若接口文档尚不存在，用这个模板新建（含幂等、分页排序、交易状态判断等章节）。模板里的 {{:填写提示}} 会原样保留给用户填。留空则用内置简版。')
      .addText(t => t.setValue(this.plugin.settings.apiDocTemplate || '').onChange(async v => {
        this.plugin.settings.apiDocTemplate = v.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('新建外部接口文档的模板')
      .setDesc('导入页选「外部接口」模块时，新建的接口文档套用这个模板（章节与属性都与内部接口文档不同）。模板里的 {{:填写提示}} 会原样保留给用户填。留空则用内置简版。')
      .addText(t => t.setValue(this.plugin.settings.clientDocTemplate || '').onChange(async v => {
        this.plugin.settings.clientDocTemplate = v.trim(); await this.plugin.saveSettings();
      }));
    containerEl.createEl('h3', { text: '字段表 ⇄ 建表语句 同步' });
    new Setting(containerEl)
      .setName('字段表属性变化实时更新建表语句')
      .setDesc('改 _data/db-columns 里列文件的属性（数据类型 / 可为空 / 主键 / 索引 / 说明）后，自动重建表文档「## 建表语句」。补丁式重建：只改真不一致的地方，没变化时不落盘；注释只补不改、索引只补不删。默认关闭，建议先用下面的命令在单张表上验证。')
      .addToggle(t => t.setValue(!!this.plugin.settings.syncTableDocFromFields).onChange(async v => {
        this.plugin.settings.syncTableDocFromFields = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('建表语句变化实时更新字段表')
      .setDesc('改表文档「## 建表语句」里的 SQL 后，停手一会儿自动把列写回 _data/db-columns（新增列 / 改类型与注释 / 把消失的列标记为疑似删除，不删文件）。与上一项互为镜像，同样默认关闭。两个都打开时靠自写抑制与重入锁避免来回触发。')
      .addToggle(t => t.setValue(!!this.plugin.settings.syncFieldsFromTableDoc).onChange(async v => {
        this.plugin.settings.syncFieldsFromTableDoc = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('重建建表语句的方言')
      .setDesc('auto 按 SQL 特征自动判断（本库默认落到 Oracle）。')
      .addDropdown(d => d.addOption('auto', 'auto（自动判断）').addOption('oracle', 'Oracle').addOption('mysql', 'MySQL')
        .setValue(this.plugin.settings.autoSyncDialect || 'auto').onChange(async v => {
          this.plugin.settings.autoSyncDialect = v; await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('自动同步防抖（毫秒）')
      .setDesc('连续改几个属性只会同步一次。')
      .addText(t => t.setValue(String(this.plugin.settings.autoSyncDebounceMs || 1200)).onChange(async v => {
        this.plugin.settings.autoSyncDebounceMs = Math.max(300, Number(String(v).trim()) || 1200); await this.plugin.saveSettings();
      }));
    containerEl.createEl('h3', { text: 'xxl-job XML 导入' });
    if (!xxl) {
      containerEl.createEl('p', { text: '未加载 xxljob-bundle.cjs，xxl-job 域不可用。请在本仓库执行 npm install && npm run build:xxljob（./sync.sh to-vault 会自动构建并部署），然后重载插件。接口 / 数据库两条链路不受影响。' });
    }
    const xxlFolderFields = [['xxljobDocsFolder', '文档根目录']];
    for (const [key, name] of xxlFolderFields) {
      new Setting(containerEl).setName(name).setDesc('生成 任务流 / 批任务 / 任务组件 三级文档的根目录，实际落在 <根目录>/<执行器>/{任务流,任务,任务组件}。')
        .addText(t => t.setValue(this.plugin.settings[key] ?? DEFAULTS.xxljobDocsFolder).onChange(async v => {
          this.plugin.settings[key] = v.trim() || DEFAULTS.xxljobDocsFolder; await this.plugin.saveSettings();
        }));
    }
    const xxlTplFields = [
      ['xxljobFlowTemplate', '任务流文档模板'],
      ['xxljobTaskTemplate', '批任务文档模板'],
      ['xxljobComponentTemplate', '任务组件文档模板'],
    ];
    for (const [key, name] of xxlTplFields) {
      new Setting(containerEl).setName(name).setDesc('留空则用内置最小结构。模板的 frontmatter 键顺序会被保留，能推断的填真实值，推断不了的保留 {{填写提示}}。')
        .addText(t => t.setValue(this.plugin.settings[key] || '').onChange(async v => {
          this.plugin.settings[key] = v.trim(); await this.plugin.saveSettings();
        }));
    }
    new Setting(containerEl)
      .setName('重名文档处理')
      .setDesc('导入时目标路径已存在文档：跳过 / 更新（frontmatter 整体替换、归属章节刷新、手写正文保留）/ 新建副本。')
      .addDropdown(d => d.addOptions({ skip: '跳过（保留现有文档）', update: '更新（保留手写正文）', rename: '新建副本' })
        .setValue(this.plugin.settings.xxljobConflictPolicy || DEFAULTS.xxljobConflictPolicy)
        .onChange(async v => { this.plugin.settings.xxljobConflictPolicy = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('执行器清单')
      .setDesc('每行一个：执行器名称，或 执行器名称|任务分组编号1,编号2。XML 里只有 jobGroup 编号、没有执行器名，靠这份清单匹配；导入确认后会自动回写。')
      .addTextArea(t => {
        t.setValue(xxl ? xxl.executorListToText(Array.isArray(this.plugin.settings.xxljobExecutors) ? this.plugin.settings.xxljobExecutors : []) : '');
        t.onChange(async v => {
          this.plugin.settings.xxljobExecutors = xxl ? xxl.textToExecutorList(v) : [];
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 6; t.inputEl.style.width = '100%';
      });
    new Setting(containerEl)
      .setName('让 @ Schema 联想优先于原生建议')
      .setDesc('默认开启。关闭后 Schema Studio 仍可使用，但 @ 可能被 Obsidian 或其他插件的建议器抢先。该开关也用于排查与 Bases / Fileclass 的兼容性问题。')
      .addToggle(t => t.setValue(this.plugin.settings.prioritizeInlineSuggest !== false).onChange(async v => {
        this.plugin.settings.prioritizeInlineSuggest = v;
        await this.plugin.saveSettings();
        this.plugin.setSchemaInlineSuggestPriority(v);
        new Notice(v ? '已启用 @ 联想优先级' : '已关闭 @ 联想优先级（兼容测试模式）');
      }));
  }
}


class SchemaInlineSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.lastContext = null;
  }

  onTrigger(cursor, editor, file) {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const match = findAtTrigger(before);
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: match.startCh },
      end: cursor,
      query: match.query,
    };
  }

  getSuggestions(context) {
    this.lastContext = context;
    return this.buildSuggestions(context.query || '');
  }

  buildSuggestions(query) {
    const parts = String(query).split('/');
    const mode = (parts[0] || '').toLowerCase();

    // Root: @ -> choose only the schema domain. A typed term filters this layer.
    if (!query.includes('/') && mode !== 'api' && mode !== 'db') {
      const term = mode;
      return [
        { kind: 'nav', label: '接口字段', detail: '接口 → Request/Response → Object/List → 字段', next: 'api/' },
        { kind: 'nav', label: '数据库字段', detail: '数据库表 → 列', next: 'db/' },
      ].filter(x => !term || x.label.includes(term) || x.next.startsWith(term));
    }

    if (mode === 'api') return this.buildApiSuggestions(parts);
    if (mode === 'db') return this.buildDbSuggestions(parts);
    return [];
  }

  buildApiSuggestions(parts) {
    const rows = this.plugin.scanApiFields().filter(x => !x.schema_orphaned);
    // api/<interface-filter>
    if (parts.length <= 2) {
      const term = parts[1] || '';
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.apiName)) by.set(r.apiName, r);
      }
      return [...by.values()]
        .filter(r => this.matches(r.apiName, term))
        .sort((a,b) => a.apiName.localeCompare(b.apiName, 'zh-CN'))
        .map(r => ({ kind:'nav', label:r.apiName, detail:'接口文档', next:`api/${r.apiName}/` }));
    }

    const apiName = parts[1];
    const apiRows = rows.filter(r => r.apiName === apiName);
    if (!apiRows.length) return [];

    // api/<interface>/<direction-filter>
    if (parts.length <= 3) {
      const term = parts[2] || '';
      const dirs = [...new Set(apiRows.map(r => r.direction))];
      return dirs
        .filter(d => this.matches(d, term))
        .sort((a,b) => a.localeCompare(b))
        .map(d => ({ kind:'nav', label:d, detail:`${apiRows.filter(r=>r.direction===d).length} 个 Schema 节点`, next:`api/${apiName}/${d}/` }));
    }

    const direction = parts[2];
    const dirRows = apiRows.filter(r => r.direction === direction);
    if (!dirRows.length) return [];

    const completedNames = parts.slice(3, -1).filter(Boolean);
    const term = parts[parts.length - 1] || '';
    let parent = '';
    for (const name of completedNames) {
      const node = dirRows.find(r => (r.parent_path || '') === parent && r.name === name);
      if (!node) return [];
      parent = node.path;
    }

    const children = dirRows
      .filter(r => (r.parent_path || '') === parent && this.matches(r.name, term))
      .sort((a,b) => (a.order-b.order) || a.name.localeCompare(b.name, 'zh-CN'));

    const prefix = `api/${apiName}/${direction}/${completedNames.length ? completedNames.join('/') + '/' : ''}`;
    return children.map(r => {
      const isContainer = r.shape === 'Object' || r.shape === 'List<Object>';
      if (isContainer) {
        return {
          kind:'nav', label:r.name,
          detail:`${r.shape} · ${r.path}`,
          next:`${prefix}${r.name}/`,
        };
      }
      return {
        kind:'leaf', label:r.name,
        detail:`${r.data_type}${r.required?' · 必填':''}${r.high_risk?' · 高风险':''} · ${r.path}`,
        record:r,
        domain:'api',
      };
    });
  }

  buildDbSuggestions(parts) {
    const rows = this.plugin.scanDbColumns().filter(x => !x.schema_orphaned);
    // db/<table-filter>
    if (parts.length <= 2) {
      const term = parts[1] || '';
      const by = new Map();
      for (const r of rows) if (!by.has(r.table)) by.set(r.table, r);
      return [...by.values()]
        .filter(r => this.matches(r.table, term))
        .sort((a,b) => a.table.localeCompare(b.table))
        .map(r => ({ kind:'nav', label:r.table, detail:'数据库表', next:`db/${r.table}/` }));
    }

    const table = parts[1];
    const term = parts[2] || '';
    return rows
      .filter(r => r.table === table && this.matches(r.name, term))
      .sort((a,b) => (a.order-b.order) || a.name.localeCompare(b.name))
      .map(r => ({
        kind:'leaf', label:r.name,
        detail:`${r.data_type}${r.primary_key?' · PK':''}${!r.nullable?' · NOT NULL':''}${r.high_risk?' · 高风险':''}`,
        record:r,
        domain:'db',
      }));
  }

  matches(value, term) {
    if (!term) return true;
    return String(value || '').toLowerCase().includes(String(term).toLowerCase());
  }

  renderSuggestion(item, el) {
    el.addClass('schema-tools-inline-suggestion');
    const row = el.createDiv({ cls:'schema-tools-inline-row' });
    row.createDiv({ text: item.kind === 'nav' ? `› ${item.label}` : item.label, cls:'schema-tools-inline-title' });
    if (item.detail) row.createDiv({ text:item.detail, cls:'schema-tools-inline-detail' });
  }

  selectSuggestion(item, evt) {
    const ctx = this.context || this.lastContext;
    if (!ctx) return;
    const editor = ctx.editor;
    if (item.kind === 'nav') {
      editor.replaceRange(`@${item.next}`, ctx.start, ctx.end);
      return;
    }
    if (item.domain === 'api') {
      const r = item.record;
      const alias = `${r.apiName}.${r.direction}.${r.path}`;
      editor.replaceRange(`[[${r.filePath.replace(/\.md$/,'')}|${alias}]]`, ctx.start, ctx.end);
      return;
    }
    if (item.domain === 'db') {
      const r = item.record;
      const alias = `${r.table}.${r.name}`;
      editor.replaceRange(`[[${r.filePath.replace(/\.md$/,'')}|${alias}]]`, ctx.start, ctx.end);
    }
  }
}


class SchemaPropertySuggest {
  constructor(plugin) {
    this.plugin = plugin;
    this.context = null;
    this.popup = null;
    this.selectedIndex = 0;
    this.onInput = (event) => {
      const input = this.getPropertyInput(event.target);
      if (input) this.refresh(input);
    };
    this.onKeydown = (event) => {
      const input = this.getPropertyInput(event.target) || this.getPropertyInput(document.activeElement);
      if (!input || !this.context || this.context.input !== input || !this.context.suggestions.length) return;
      if (!this.popup || this.popup.style.display === 'none') return;
      const consume = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (event.key === 'ArrowDown') {
        consume();
        this.selectedIndex = (this.selectedIndex + 1) % this.context.suggestions.length;
        this.render();
      } else if (event.key === 'ArrowUp') {
        consume();
        this.selectedIndex = (this.selectedIndex - 1 + this.context.suggestions.length) % this.context.suggestions.length;
        this.render();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        consume();
        this.select(this.selectedIndex);
      } else if (event.key === 'Escape') {
        consume();
        this.hide();
      }
    };
    this.onMousedown = (event) => {
      if (!this.context) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && (this.context.input.contains(target) || this.popup?.contains(target))) return;
      this.hide();
    };
    this.onViewportChange = () => {
      if (this.context) this.position();
    };
  }

  register() {
    document.addEventListener('input', this.onInput, true);
    // Capture at window level so Obsidian's property editor does not consume
    // Enter before the active schema suggestion gets a chance to handle it.
    window.addEventListener('keydown', this.onKeydown, true);
    document.addEventListener('keydown', this.onKeydown, true);
    document.addEventListener('mousedown', this.onMousedown, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('scroll', this.onViewportChange, true);
  }

  destroy() {
    document.removeEventListener('input', this.onInput, true);
    window.removeEventListener('keydown', this.onKeydown, true);
    document.removeEventListener('keydown', this.onKeydown, true);
    document.removeEventListener('mousedown', this.onMousedown, true);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    this.hide();
    this.popup?.remove();
    this.popup = null;
  }

  getPropertyInput(target) {
    const element = target instanceof Element ? target : null;
    const input = element?.closest('input, textarea, [contenteditable="true"]');
    if (!input || !input.isConnected || input.closest('.schema-tools-property-suggest')) return null;
    if (input.tagName === 'INPUT' && !['', 'text', 'search', 'url'].includes(String(input.type || '').toLowerCase())) return null;

    const property = input.closest('.metadata-property');
    if (!property) return null;
    if (input.closest('.metadata-property-key, .metadata-property-key-input')) return null;
    return input;
  }

  readInput(input) {
    if ('value' in input) {
      const value = String(input.value || '');
      const caret = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
      return { value, caret, prefix: value.slice(0, caret) };
    }

    const value = input.textContent || '';
    let caret = value.length;
    const selection = window.getSelection();
    if (selection?.rangeCount && selection.anchorNode && input.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      caret = range.toString().length;
    }
    return { value, caret, prefix: value.slice(0, caret) };
  }

  refresh(input) {
    const state = this.readInput(input);
    const trigger = findAtTrigger(state.prefix);
    if (!trigger) {
      if (this.context?.input === input) this.hide();
      return;
    }

    const suggestions = this.plugin.schemaInlineSuggest.buildSuggestions(trigger.query || '');
    if (!suggestions.length) {
      this.hide();
      return;
    }
    const previousContext = this.context;
    this.context = {
      input,
      start: trigger.startCh,
      end: state.caret,
      query: trigger.query,
      suggestions,
    };
    this.selectedIndex = previousContext?.input === input && previousContext.query === trigger.query
      ? Math.min(this.selectedIndex, suggestions.length - 1)
      : 0;
    this.render();
  }

  ensurePopup() {
    if (this.popup) return;
    this.popup = document.createElement('div');
    this.popup.className = 'schema-tools-property-suggest';
    this.popup.addEventListener('mousedown', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-schema-suggestion-index]') : null;
      if (!target) return;
      event.preventDefault();
      this.select(Number(target.dataset.schemaSuggestionIndex));
    });
    document.body.appendChild(this.popup);
  }

  render() {
    if (!this.context) return;
    this.ensurePopup();
    this.popup.replaceChildren();
    this.context.suggestions.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'schema-tools-property-suggest-row';
      row.dataset.schemaSuggestionIndex = String(index);
      if (index === this.selectedIndex) row.classList.add('is-selected');
      const title = document.createElement('div');
      title.className = 'schema-tools-inline-title';
      title.textContent = item.kind === 'nav' ? `› ${item.label}` : item.label;
      row.appendChild(title);
      if (item.detail) {
        const detail = document.createElement('div');
        detail.className = 'schema-tools-inline-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      row.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.popup.querySelectorAll('[data-schema-suggestion-index]').forEach((entry, entryIndex) => {
          entry.classList.toggle('is-selected', entryIndex === index);
        });
      });
      this.popup.appendChild(row);
    });
    this.popup.style.display = 'block';
    this.position();
  }

  position() {
    if (!this.context || !this.popup) return;
    const rect = this.context.input.getBoundingClientRect();
    const width = Math.max(280, Math.min(520, Math.max(rect.width, 320)));
    this.popup.style.width = `${width}px`;
    const popupHeight = this.popup.offsetHeight;
    let top = rect.bottom + 4;
    if (top + popupHeight > window.innerHeight - 8 && rect.top > popupHeight + 8) top = rect.top - popupHeight - 4;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${Math.max(8, top)}px`;
  }

  hide() {
    this.context = null;
    if (this.popup) this.popup.style.display = 'none';
  }

  select(index) {
    const context = this.context;
    const item = context?.suggestions[index];
    if (!context || !item) return;

    let replacement = '';
    if (item.kind === 'nav') replacement = `@${item.next}`;
    else if (item.domain === 'api') {
      const r = item.record;
      replacement = `[[${r.filePath.replace(/\.md$/, '')}|${r.apiName}.${r.direction}.${r.path}]]`;
    } else if (item.domain === 'db') {
      const r = item.record;
      replacement = `[[${r.filePath.replace(/\.md$/, '')}|${r.table}.${r.name}]]`;
    }
    if (!replacement) return;
    this.replaceRange(context.input, context.start, context.end, replacement);
    this.hide();
    if (item.kind === 'nav') {
      // The input event above can be handled by Obsidian's property renderer
      // asynchronously. Refresh once after that render so the next hierarchy
      // level stays open instead of requiring another character first.
      const previousInput = context.input;
      const refreshNextLevel = () => {
        const activeInput = this.getPropertyInput(document.activeElement) || previousInput;
        if (activeInput?.isConnected) this.refresh(activeInput);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshNextLevel);
      else setTimeout(refreshNextLevel, 0);
    }
  }

  replaceRange(input, start, end, replacement) {
    input.focus();
    if ('value' in input && typeof input.setRangeText === 'function') {
      input.setRangeText(replacement, start, end, 'end');
    } else {
      const value = input.textContent || '';
      input.textContent = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
      this.setContentEditableCaret(input, start + replacement.length);
    }
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
    } catch (error) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  setContentEditableCaret(root, offset) {
    const selection = window.getSelection();
    if (!selection) return;
    const walker = document.createTreeWalker(root, 4);
    let node = walker.nextNode();
    let remaining = offset;
    while (node) {
      const length = node.textContent?.length || 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}


// --- DDL dialect adapters -------------------------------------------------
// Main UI/diff/apply code consumes one normalized shape regardless of dialect:
// { table, columns: [{ name, data_type, nullable, primary_key, indexed,
//   default_value, ddl_comment, references, order }] }
// Adding a dialect only requires registering another adapter below.

function tableKey(name) {
  return String(name || '').replace(/^[`"\[]|[`"\]]$/g, '').split('.').pop().toLowerCase();
}

function findParsedTable(parsed, rawName) {
  const key = tableKey(rawName);
  return parsed.find(t => tableKey(t.table) === key);
}

function findColumn(table, rawName) {
  if (!table) return null;
  const key = String(rawName || '').replace(/^[`"\[]|[`"\]]$/g, '').toLowerCase();
  return table.columns.find(c => String(c.name || '').toLowerCase() === key) || null;
}

function markIndexColumns(parsed, sql) {
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:[`"\[]?[^\s`"\]]+[`"\]]?)\s+ON\s+((?:[`"\[]?[^\s(`"\]]+[`"\]]?\.)?[`"\[]?[^\s(`"\]]+[`"\]]?)\s*\(([^)]+)\)/ig;
  let m;
  while ((m = re.exec(sql))) {
    const table = findParsedTable(parsed, m[2]);
    if (!table) continue;
    core.splitTopLevel(m[3]).forEach(part => {
      const col = findColumn(table, part.trim().split(/\s+/)[0]);
      if (col) col.indexed = true;
    });
  }
}

function applyAlterTableConstraints(parsed, sql) {
  const re = /ALTER\s+TABLE\s+((?:[`"\[]?[^\s`"\]]+[`"\]]?\.)?[`"\[]?[^\s`"\]]+[`"\]]?)\s+ADD\s+(?:CONSTRAINT\s+(?:[`"\[]?[^\s`"\]]+[`"\]]?)\s+)?([\s\S]*?);/ig;
  let m;
  while ((m = re.exec(sql))) {
    const table = findParsedTable(parsed, m[1]);
    if (!table) continue;
    const clause = m[2].trim();
    let cm;
    if ((cm = clause.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i))) {
      core.splitTopLevel(cm[1]).forEach(x => { const c=findColumn(table,x.trim()); if(c){c.primary_key=true;c.indexed=true;c.nullable=false;} });
      continue;
    }
    if ((cm = clause.match(/^UNIQUE\s*\(([^)]+)\)/i))) {
      core.splitTopLevel(cm[1]).forEach(x => { const c=findColumn(table,x.trim()); if(c)c.indexed=true; });
      continue;
    }
    if ((cm = clause.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i))) {
      const locals=core.splitTopLevel(cm[1]);
      const remotes=core.splitTopLevel(cm[3]);
      locals.forEach((x,i)=>{const c=findColumn(table,x.trim());if(c)c.references={table:String(cm[2]).replace(/^[`"\[]|[`"\]]$/g,'').split('.').pop(),column:String(remotes[i]||remotes[0]||'').trim().replace(/^[`"\[]|[`"\]]$/g,'')};});
    }
  }
}

function normalizePrimaryKeyNullability(parsed) {
  for (const table of parsed) for (const col of table.columns) if (col.primary_key) col.nullable = false;
}

// 表注释：COMMENT ON TABLE <schema.>?<table> IS '...'（表中文名的来源）
function applyTableComments(parsed, sql) {
  const re = /COMMENT\s+ON\s+TABLE\s+((?:"[^"]+"|[\w$#]+)\.)?("[^"]+"|[\w$#]+)\s+IS\s+'((?:''|[^'])*)'\s*(?:;|\/|$)/ig;
  let m;
  while ((m = re.exec(sql))) {
    const table = findParsedTable(parsed, m[2]);
    if (table) table.table_comment = m[3].replace(/''/g, "'");
  }
}

function parseMySqlDdl(sql) {
  const parsed = core.parseCreateTables(sql);
  applyTableComments(parsed, sql);
  markIndexColumns(parsed, sql);
  applyAlterTableConstraints(parsed, sql);
  normalizePrimaryKeyNullability(parsed);
  return parsed;
}

function parseOracleDdl(sql) {
  // Oracle dump tools often emit named inline constraints after the datatype,
  // e.g. VARCHAR2(25) CONSTRAINT EMP_NAME_NN NOT NULL. Normalize only the
  // constraint name token; the semantic keyword remains for the common parser.
  const normalized = sql.replace(/\bCONSTRAINT\s+(?:"[^"]+"|[\w$#]+)\s+(?=NOT\s+NULL|PRIMARY\s+KEY|UNIQUE\b|REFERENCES\b|CHECK\b)/ig, '');
  const parsed = core.parseCreateTables(normalized);

  // Oracle commonly stores comments outside CREATE TABLE.
  const commentRe = /COMMENT\s+ON\s+COLUMN\s+((?:"[^"]+"|[\w$#]+)\.)?("[^"]+"|[\w$#]+)\.("[^"]+"|[\w$#]+)\s+IS\s+'((?:''|[^'])*)'\s*(?:;|\/|$)/ig;
  let m;
  while ((m = commentRe.exec(sql))) {
    const table = findParsedTable(parsed, m[2]);
    const col = findColumn(table, m[3]);
    if (col) col.ddl_comment = m[4].replace(/''/g, "'");
  }
  applyTableComments(parsed, sql);

  // Oracle PK/FK/UNIQUE are frequently emitted as ALTER TABLE statements;
  // indexes are also commonly emitted separately.
  applyAlterTableConstraints(parsed, sql);
  markIndexColumns(parsed, sql);

  // Identity columns are implicitly NOT NULL in Oracle.
  const createRe = /CREATE\s+TABLE\s+((?:"[^"]+"|[\w$#]+\.)?(?:"[^"]+"|[\w$#]+))\s*\(([\s\S]*?)\)\s*(?:TABLESPACE\b[\s\S]*?)?;/ig;
  while ((m = createRe.exec(sql))) {
    const table = findParsedTable(parsed, m[1]);
    if (!table) continue;
    for (const part of core.splitTopLevel(m[2])) {
      if (!/GENERATED\s+(?:ALWAYS|BY\s+DEFAULT(?:\s+ON\s+NULL)?)\s+AS\s+IDENTITY/i.test(part)) continue;
      const nm = part.trim().match(/^("[^"]+"|[\w$#]+)/);
      const col = nm ? findColumn(table, nm[1]) : null;
      if (col) { col.nullable = false; col.default_value = ''; }
    }
  }
  normalizePrimaryKeyNullability(parsed);
  return parsed;
}

const DDL_DIALECTS = {
  // 顺序即下拉顺序：Oracle 在前 —— 本库的 DDL 全部来自 Oracle 导出（SQL*Plus `/` 结束符），
  // 默认落在 Oracle 上可避免「忘了切方言 → 用 MySQL 解析器解 Oracle 导出脚本」这个老坑。
  oracle: {
    id: 'oracle',
    label: 'Oracle',
    description: 'NUMBER/VARCHAR2/DATE 等列定义，COMMENT ON COLUMN、ALTER TABLE 约束、CREATE INDEX、IDENTITY，以及 SQL*Plus 的 `/` 结束符。',
    parse: parseOracleDdl,
  },
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    description: 'CREATE TABLE、内联 COMMENT、PK/KEY/INDEX、FOREIGN KEY、DEFAULT，以及独立 CREATE INDEX / ALTER TABLE 约束。',
    parse: parseMySqlDdl,
  },
};

function parseDdlWithDialect(sql, dialectId) {
  const adapter = DDL_DIALECTS[dialectId];
  if (!adapter) throw new Error(`不支持的数据库方言：${dialectId}`);
  return adapter.parse(sql);
}

// --- 字段表 ⇄ 表文档「## 建表语句」同步（自 v0.7.21 / v0.7.22 分支移植） ---------
// 这一层全是纯函数：不碰 vault、不碰 UI，只做「章节代码块定位」与「补丁式重建 DDL」。
// 设计要点（与对端一致，勿改）：
//   1. 补丁式重建而非整段重写 —— 列定义只在「类型 / 可为空 / 默认值」真不同时才重生成，
//      其余逐字节复用原文（含对齐空格、内联约束、USING INDEX 之类的存储子句）。
//      ⇒ 「什么都没改」时 buildDdlFromColumns 的输出 === 输入（幂等基准，有回归守护）。
//   2. 注释只补不改 —— 人工润色过的「说明」与 DDL 原始注释几乎必然不同，覆盖即毁人工成果。
//   3. 索引只补不改不删 —— 仅回收本插件按 IDX_<表>_<列> 规则命名的索引，人工索引一律不动。
//   4. 解析不出该表时直接放弃（reason: parse-error），宁可不改也不能改坏。
// 接线（设置项 / vault 事件 / 命令）见后续批次，这里只提供能力。
function escapeRe(s) { return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 把 `## {heading}`（任意层级）章节下的**第一个围栏代码块**整块替换为 ```{lang}\n{code}\n```。
// 用途：模板里的「## 建表语句」「## 请求示例」「## 响应示例」都是唯一的占位代码块，
// 导入时把真实内容同步进去。章节或代码块缺失时**返回原文**，不擅自往文档里塞新结构。
function upsertSectionCodeBlock(markdown, heading, lang, code) {
  const text = String(markdown == null ? '' : markdown);
  const value = String(code == null ? '' : code).trim();
  if (!value) return text;
  const head = new RegExp('^(#{1,6})[ \\t]*' + escapeRe(heading) + '[ \\t]*$', 'm').exec(text);
  if (!head) return text;
  const level = head[1].length;
  const after = head.index + head[0].length;
  // 章节范围：到下一个「同级或更高级」标题为止（`## 请求示例` 会被 `# 响应字段说明` 截断）。
  const next = new RegExp('^#{1,' + level + '}[ \\t]', 'm').exec(text.slice(after));
  const end = next ? after + next.index : text.length;
  const section = text.slice(after, end);
  const block = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n?[ \t]*\2[ \t]*$/m.exec(section);
  if (!block) return text;
  const at = after + block.index;
  const indent = block[1];
  const replacement = indent + '```' + String(lang || '') + '\n' + value + '\n' + indent + '```';
  return text.slice(0, at) + replacement + text.slice(at + block[0].length);
}
// `upsertSectionCodeBlock` 的配对方：读出 `## {heading}` 章节里**第一个围栏代码块**的内容。
// 用途：表文档「## 建表语句」→ 反向解析成字段；与写入侧共用同一套章节定位规则，保证读写对称。
function readSectionCodeBlock(markdown, heading) {
  const text = String(markdown == null ? '' : markdown);
  const head = new RegExp('^(#{1,6})[ \\t]*' + escapeRe(heading) + '[ \\t]*$', 'm').exec(text);
  if (!head) return '';
  const level = head[1].length;
  const after = head.index + head[0].length;
  const next = new RegExp('^#{1,' + level + '}[ \\t]', 'm').exec(text.slice(after));
  const end = next ? after + next.index : text.length;
  const section = text.slice(after, end);
  const block = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\2[ \t]*$/m.exec(section);
  return block ? String(block[3] || '').trim() : '';
}
// 反向同步时猜表文档里 SQL 的方言。本库既有 SQL\*Plus 导出的 Oracle 脚本，也可能粘 MySQL DDL，
// 所以按特征打分而不是只看一个关键字；两边都没特征时按库默认的 Oracle 处理。
function detectDdlDialect(sql) {
  const text = String(sql == null ? '' : sql);
  if (!text.trim()) return 'oracle';
  let oracle = 0, mysql = 0;
  if (/^[ \t]*\/[ \t]*$/m.test(text)) oracle += 3;                        // SQL*Plus 的 `/` 结束符
  if (/\b(?:N?VARCHAR2|NCLOB|BINARY_DOUBLE|RAW)\b/i.test(text)) oracle += 2;
  if (/\bCOMMENT\s+ON\s+(?:TABLE|COLUMN)\b/i.test(text)) oracle += 2;
  if (/\bNUMBER\s*\(/i.test(text)) oracle += 1;
  if (/\bENABLE\b/i.test(text)) oracle += 1;
  if (/`/.test(text)) mysql += 3;                                          // 反引号标识符
  if (/\bENGINE\s*=/i.test(text)) mysql += 2;
  if (/\bAUTO_INCREMENT\b/i.test(text)) mysql += 2;
  if (/\b(?:TINYINT|MEDIUMINT|DATETIME|LONGTEXT|DOUBLE)\b/i.test(text)) mysql += 1;
  if (/\)[^()\n]*COMMENT\s+'/i.test(text)) mysql += 2;                     // 列内联 COMMENT '…'
  return mysql > oracle ? 'mysql' : 'oracle';
}

// ---------- 字段表 → 表文档「## 建表语句」（v0.7.22） ----------
// 与「文档 → 字段」相反的方向：**字段表是源**。
// 关键设计是**补丁式重建**而不是整段重写：列定义只在「数据类型 / 可为空 / 默认值」
// 真的不同时才重新生成，其余列**原样保留原文本**（含对齐空格、SQL*Plus 生成的
// `constraint SYS_C0050515 check ("X" IS NOT NULL)` 这类内联约束）。所以「什么都没改」
// 时重建结果逐字节等于原文 —— 同步天然幂等，也不会出现"改一列、整段格式跳一次"。
// 注释（COMMENT ON COLUMN）**只补不改**：本库里人工润色过的「说明」与 DDL 原始注释
// 几乎必然不同（加句号、改括号、加反引号），覆盖回去等于毁掉人工成果。
// 索引同样**只增不改不删**：`索引: false` 是"未标记"而不是"明确无索引"，
// 只有 `索引: true` 才是明确意图，才值得补一条 CREATE INDEX。

// 按顶层分隔符（默认逗号）把 [from,to) 切成区间列表，保留每个片段的原始下标。
// 与 core.splitTopLevel 的区别：那个只返回文本，这个要拿位置才能做补丁替换。
function splitTopLevelRanges(text, from, to, delimiter = ',') {
  const out = [];
  let start = from, depth = 0, quote = null, escaped = false;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === delimiter && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  out.push([start, to]);
  return out;
}

// 定位 CREATE TABLE 主体：返回各列表项（列定义 / 表级约束）的原文区间与文本。
// 不做语法解析，只做引号感知的括号配平与顶层逗号切分 —— 因为重建要**原样复用**原文片段。
function scanCreateTable(sqlText, table) {
  const sql = String(sqlText == null ? '' : sqlText);
  const target = String(table == null ? '' : table).trim().toLowerCase();
  if (!sql || !target) return null;
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?/ig;
  let m;
  while ((m = re.exec(sql))) {
    // 收集限定名 token（可能形如 "CAPITAL"."T" / `db`.`t` / T），直到左括号。
    let i = re.lastIndex, token = '', found = false;
    while (i < sql.length) {
      const ch = sql[i];
      if (ch === '(') { found = true; break; }
      if (!/[\s"`\[\]\w$#.]/.test(ch)) break;
      token += ch; i++;
    }
    if (!found) continue;
    const segs = token.trim().replace(/["`\[\]]/g, '').split('.').filter(Boolean);
    if (!segs.length || segs[segs.length - 1].toLowerCase() !== target) continue;
    const openParen = i;
    let depth = 1, quote = null, escaped = false, j = openParen + 1;
    for (; j < sql.length && depth > 0; j++) {
      const ch = sql[j];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    const closeParen = j - 1;
    const items = [];
    for (const [a, b] of splitTopLevelRanges(sql, openParen + 1, closeParen)) {
      const raw = sql.slice(a, b);
      if (!raw.trim()) continue;
      const trimmed = raw.trim();
      const head = /^(?:constraint\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$#]+))/.exec(trimmed);
      const name = (head && (head[1] || head[2] || head[3] || head[4])) || '';
      const isConstraint = /^(?:constraint\b|primary\s+key\b|unique\b|check\b|foreign\s+key\b|key\b|index\b|fulltext\b|spatial\b)/i.test(trimmed);
      items.push({ start: a, end: b, kind: isConstraint ? 'constraint' : 'column', name, text: trimmed });
    }
    // 列项首行缩进（原文风格，通常是 4 个空格）；续行缩进在 item.text 内部原样保留。
    const rawOf = (it) => sql.slice(it.start, it.end);
    let indent = '    ';
    const firstColumn = items.find((x) => x.kind === 'column');
    if (firstColumn) {
      const rawFirst = rawOf(firstColumn);
      const lead = /^\s*\n([ \t]*)/.exec(rawFirst) || /^([ \t]+)\S/.exec(rawFirst);
      if (lead) indent = lead[1];
    }
    // 还原原文的排版风格：`(` 与首项之间的空白（有的 dump 把首列写在 `(` 同一行）、
    // 相邻项之间的分隔空白、末项与 `)` 之间的空白。不记这些，重建会把
    // `(\t"DATE_TIME" …` 硬改成 `(\n\t"DATE_TIME" …`，逐字节幂等就没了。
    const leadOf = (it) => (/^\s*/.exec(rawOf(it)) || [''])[0];
    const trailOf = (it) => (/\s*$/.exec(rawOf(it)) || [''])[0];
    const headGap = items.length ? leadOf(items[0]) : '\n';
    const sep = items.length >= 2 ? (leadOf(items[1]) || '\n' + indent) : ('\n' + indent);
    const tailGap = items.length ? trailOf(items[items.length - 1]) : '\n';
    // 建表语句的结束符（SQL*Plus 的 `/` 或普通 `;`）：新增注释/索引时沿用同一风格。
    let termEnd = closeParen + 1;
    while (termEnd < sql.length && /[ \t]/.test(sql[termEnd])) termEnd++;
    if (sql[termEnd] === '/' || sql[termEnd] === ';') termEnd++;
    const hasSlashTerminator = /^[ \t]*\/[ \t]*$/m.test(sql);
    return { openParen, closeParen, termEnd, tableToken: token.trim(), segments: segs, indent, headGap, sep, tailGap, items, hasSlashTerminator };
  }
  return null;
}

// 渲染一条列定义。Oracle 沿用本库 dump 的顺序（类型 → default → not null）；
// MySQL 用反引号标识符 + 内联 COMMENT。
function renderColumnDef(name, col, dialect, padWidth) {
  const desc = String((col && col.desc) || '').trim();
  const def = String((col && col.default_value) || '').trim();
  if (dialect === 'mysql') {
    // 反引号占 2 个字符，对齐时按显示宽度补。
    const parts = ['`' + name + '`' + ' '.repeat(Math.max(0, padWidth - String(name).length - 1))];
    parts.push(String((col && col.data_type) || 'TEXT'));
    if (col && col.nullable === false) parts.push('NOT NULL');
    if (def) parts.push('DEFAULT ' + def);
    if (desc) parts.push(`COMMENT '${desc.replace(/'/g, "''")}'`);
    return parts.join(' ');
  }
  const parts = [String(name).padEnd(padWidth, ' '), String((col && col.data_type) || 'VARCHAR2(1)')];
  if (def) parts.push('default ' + def);
  if (col && col.nullable === false) parts.push('not null');
  return parts.join(' ');
}

// 补丁式重建：以文档里现有 SQL 为基底，只把「字段表与 SQL 不一致」的地方改掉。
// 返回 { ok, reason, sql, stats }；stats 用于给用户生成提示。
function buildDdlFromColumns(opts) {
  const o = opts || {};
  const sql = String(o.sql == null ? '' : o.sql);
  const table = String(o.table || '').trim();
  const dialect = o.dialect === 'mysql' ? 'mysql' : 'oracle';
  const columns = Array.isArray(o.columns) ? o.columns : [];
  const stats = { added: 0, changed: 0, removed: 0, commentsAdded: 0, indexesAdded: 0, primaryKey: 'unchanged' };
  if (!sql.trim()) return { ok: false, reason: 'empty', sql, stats };
  if (!table) return { ok: false, reason: 'no-table', sql, stats };
  if (!columns.length) return { ok: false, reason: 'no-columns', sql, stats };
  const scan = scanCreateTable(sql, table);
  if (!scan) return { ok: false, reason: 'no-create-table', sql, stats };

  // 权威现状取自解析器（类型归一、check(IS NOT NULL) → nullable=false 等判定都在那里）。
  let curTable = null;
  try {
    curTable = parseDdlWithDialect(sql, dialect).find((t) => String(t.table || '').toLowerCase() === table.toLowerCase()) || null;
  } catch (e) { /* 解析失败时退化为"全部重生成"，仍能用字段表产出合法 DDL */ }
  const curByName = new Map();
  if (curTable) for (const c of curTable.columns) curByName.set(String(c.name).toUpperCase(), c);
  // 解析不出这张表时**一律放弃**：否则所有列都会走"重新生成"分支，把原文本
  // （内联约束、对齐、索引）整段冲掉。宁可不改，也不能改坏。
  if (!curByName.size) return { ok: false, reason: 'parse-error', sql, stats };

  const normType = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
  const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const originItems = scan.items.filter((x) => x.kind === 'column');
  const constraintItems = scan.items.filter((x) => x.kind === 'constraint');
  const itemByName = new Map(originItems.map((it) => [String(it.name).toUpperCase(), it]));
  // 原表用带引号的标识符（`"DATE_TIME"`）时，重生成的列也要带引号 —— 否则同一张表里
  // 一半带引号一半不带，看起来像两拨人写的。
  const anyQuoted = originItems.some((it) => /^"/.test(it.text));

  // 目标顺序：原文已有列保持原来的先后，新列按列名排序追加到末尾。
  const orderOf = new Map(originItems.map((it, i) => [String(it.name).toUpperCase(), i]));
  const target = columns.map((c) => ({
    name: String(c.name),
    data_type: String(c.data_type == null ? '' : c.data_type),
    nullable: c.nullable !== false,
    primary_key: !!c.primary_key,
    indexed: !!c.indexed,
    default_value: c.default_value == null ? '' : String(c.default_value),
    desc: c.desc == null ? '' : String(c.desc),
  }));
  target.sort((a, b) => {
    const ka = a.name.toUpperCase(), kb = b.name.toUpperCase();
    const ia = orderOf.has(ka) ? orderOf.get(ka) : Number.MAX_SAFE_INTEGER;
    const ib = orderOf.has(kb) ? orderOf.get(kb) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return ka.localeCompare(kb);
  });
  const padWidth = Math.max(1, ...[...target.map((c) => c.name), ...originItems.map((it) => it.name)].map((s) => String(s).length)) + 1;

  // --- 列定义 ---
  const outColumns = [], outColumnSrc = [];
  for (const c of target) {
    const key = c.name.toUpperCase();
    const item = itemByName.get(key);
    const cur = curByName.get(key);
    let text = null;
    if (item && cur) {
      const same = normType(cur.data_type) === normType(c.data_type)
        && !!cur.nullable === !!c.nullable
        && normText(cur.default_value) === normText(c.default_value);
      if (same) text = item.text;           // 原样保留（含内联约束 / 对齐 / 大小写）
      else stats.changed++;
    } else if (!item) {
      // 解析器认得出的列却找不到条目（原文写法罕见）→ 算"更新"而非"新增"。
      if (curByName.has(key)) stats.changed++; else stats.added++;
    }
    if (!text) {
      const quoted = item ? /^"/.test(item.text) : anyQuoted;
      text = renderColumnDef(quoted ? `"${c.name}"` : c.name, c, dialect, padWidth + (quoted ? 2 : 0));
    }
    outColumns.push(text);
    outColumnSrc.push(item || null);
  }
  // DDL 里有、字段表里没有的列 → 连同它的列块一起消失。
  const targetKeys = new Set(target.map((c) => c.name.toUpperCase()));
  const dropped = originItems.filter((it) => !targetKeys.has(String(it.name).toUpperCase()));
  stats.removed = dropped.length;

  // --- 主键约束（表级） ---
  const pkColumns = target.filter((c) => c.primary_key).map((c) => c.name);
  const pkItem = constraintItems.find((it) => /primary\s+key/i.test(it.text)) || null;
  let pkText = null;
  if (pkColumns.length) {
    // 主键也走"最小改动"：列集合一致就**原样保留整条约束**，包括
    // `USING INDEX PCTFREE … ENABLE` 这类工具生成、本插件无法凭空重建的子句。
    // 列集合变了只替换 `(…)` 里的列表，约束名与后续子句一律不动。
    const pkMatch = pkItem && /primary\s+key\s*\(([^)]*)\)/i.exec(pkItem.text);
    const quoted = !!(pkMatch && /"/.test(pkMatch[1]));
    const pkList = () => (quoted ? pkColumns.map((c) => `"${c}"`) : pkColumns).join(', ');
    if (pkMatch) {
      const curPk = core.splitTopLevel(pkMatch[1]).map((x) => x.trim().replace(/["`\[\]]/g, '').toUpperCase());
      const wantPk = pkColumns.map((c) => c.toUpperCase());
      if (curPk.join(',') === wantPk.join(',')) {
        pkText = pkItem.text;
      } else {
        const at = pkMatch.index + pkMatch[0].indexOf('(');
        pkText = pkItem.text.slice(0, at) + '(' + pkList() + ')' + pkItem.text.slice(at + 2 + pkMatch[1].length);
        stats.primaryKey = 'updated';
      }
    } else if (pkItem) {
      pkText = pkItem.text;               // 认不出列列表，别乱动
    } else {
      pkText = `constraint PK_${table.toUpperCase().slice(0, 24)} primary key (${pkList()})`;
      stats.primaryKey = 'added';
    }
  } else if (pkItem) {
    stats.primaryKey = 'removed';
  }

  // 约束项保持原文相对顺序：主键在它原来的位置上被替换，其它约束原样收进来。
  // 每项都记着它来自原文的哪一段，重建时逐项沿用**原文自己的**缩进 —— Oracle dump
  // 常把约束项缩进得比列项多一个空格，统一缩进就会逐字节不一致。
  const bodyItems = outColumns.map((t, i) => ({ text: t, item: outColumnSrc[i] }));
  for (const it of constraintItems) {
    if (it === pkItem) { if (pkText) bodyItems.push({ text: pkText, item: it }); continue; }
    bodyItems.push({ text: it.text, item: it });
  }
  if (pkText && !pkItem) bodyItems.push({ text: pkText, item: null });
  const leadOfItem = (it) => (/^\s*/.exec(sql.slice(it.start, it.end)) || [''])[0];
  const parts = bodyItems.map((x) => (x.item ? leadOfItem(x.item) : '\n' + scan.indent) + x.text);
  if (parts.length) parts[0] = scan.headGap + bodyItems[0].text;   // 首项的空白由 headGap 提供
  const body = parts.join(',') + scan.tailGap;

  // --- 注释（Oracle 才有独立的 COMMENT ON COLUMN；MySQL 走列内联） ---
  const edits = [{ start: scan.openParen + 1, end: scan.closeParen, text: body }];
  if (dialect !== 'mysql') {
    const haveCols = new Set();
    const cmtRe = /comment\s+on\s+column\s+([\w$#".]+)\s*\.\s*([\w$#"]+)\s+is\s+'/gim;
    let cm;
    while ((cm = cmtRe.exec(sql))) haveCols.add(cm[2].replace(/"/g, '').toUpperCase());
    const need = target.filter((c) => String(c.desc).trim() && !haveCols.has(c.name.toUpperCase()));
    stats.commentsAdded = need.length;
    if (need.length) {
      // 只增不改：接在最后一条 COMMENT 之后（没有就接在建表语句的结束符之后）。
      let anchor = scan.termEnd;
      const tailRe = /comment\s+on\s+(?:column|table)\s+[\w$#".\s]+\s+is\s+'(?:''|[^'])*'\s*(?:;|\/)?/gim;
      let last = null, tm;
      while ((tm = tailRe.exec(sql))) if (!last || (tm.index + tm[0].length) > (last.index + last[0].length)) last = tm;
      if (last) anchor = last.index + last[0].length;
      const term = scan.hasSlashTerminator ? '\n/' : ';';
      const stmts = need.map((c) => `comment on column ${scan.tableToken}.${c.name} is '${String(c.desc).trim().replace(/'/g, "''")}'`);
      edits.push({ start: anchor, end: anchor, text: '\n' + stmts.map((s) => s + term).join('\n') + '\n' });
    }
    // 列块被移除时，它的 COMMENT 也一并删掉，否则文档里会留下指向不存在列的孤儿注释。
    // （只对"字段表里确实少了这一列"生效 —— 列文件整体不完整的情况已被上层安全闸拦住。）
    const droppedNames = new Set(dropped.map((it) => String(it.name).toUpperCase()));
    if (droppedNames.size) {
      const delRe = /^[ \t]*comment\s+on\s+column\s+(?:[\w$#"]+\s*\.\s*)*("[^"]+"|`[^`]+`|[\w$#]+)\s+is\s+'(?:''|[^'])*'[ \t]*(?:;|\/)?[ \t]*\r?\n?/gim;
      let dm;
      while ((dm = delRe.exec(sql))) {
        if (!droppedNames.has(dm[1].replace(/["`\[\]]/g, '').toUpperCase())) continue;
        edits.push({ start: dm.index, end: dm.index + dm[0].length, text: '' });
      }
    }
  }

  // --- 索引：补缺少的；回收"本插件按命名规则生成、且已不再需要"的那几条 ---
  // 人工写的索引（名字各式各样）一律不动；`索引: false` 只代表"没标"，不代表"要删"。
  const covered = new Set();
  const ownIdx = [];   // 原文里由本插件命名的索引语句（可能本轮要回收）
  const abbrUpper = table.toUpperCase().split('_').map((x) => x[0] || '').join('');
  const ownNames = new Set();
  for (const c of target) {
    const col = c.name.toUpperCase();
    ownNames.add(`IDX_${table.toUpperCase()}_${col}`.replace(/[^\w$#]/g, '_'));
    ownNames.add(`IDX_${abbrUpper}_${col}`.replace(/[^\w$#]/g, '_'));
  }
  const idxRe = /create\s+(?:unique\s+)?index\s+([\w$#".]+)\s+on\s+([\w$#".]+)\s*\(([^)]*)\)\s*(?:;|\/)?/gim;
  let im;
  while ((im = idxRe.exec(sql))) {
    const seg = String(im[2]).replace(/["`\[\]]/g, '').split('.').filter(Boolean);
    if (seg.length && seg[seg.length - 1].toLowerCase() !== table.toLowerCase()) continue;
    for (const col of core.splitTopLevel(im[3])) covered.add(col.trim().replace(/\s+(?:asc|desc)$/i, '').replace(/["`\[\]]/g, '').toUpperCase());
    const nm = String(im[1]).replace(/["`\[\]]/g, '').toUpperCase();
    const cols = core.splitTopLevel(im[3]).map((x) => x.trim().replace(/\s+(?:asc|desc)$/i, '').replace(/["`\[\]]/g, '').toUpperCase());
    // 只认"名字严格等于 IDX_<表全名>_<列> / IDX_<表缩写>_<列>、且单列覆盖"的索引 —— 命名足够特定，
    // 不会误命中人工索引（实测本库三个索引名都不匹配）。
    if (ownNames.has(nm) && cols.length === 1) ownIdx.push({ name: nm, col: cols[0], start: im.index, len: im[0].length });
  }
  const noLongerNeeded = (col) => {
    const c = target.find((x) => x.name.toUpperCase() === col);
    return !c || !c.indexed || c.primary_key;    // 列没了 / 取消勾选 / 变成主键 → 不再需要这条索引
  };
  if (dialect !== 'mysql') {
    for (const o of ownIdx) {
      if (!noLongerNeeded(o.col)) continue;
      let s0 = o.start;
      while (s0 > 0 && sql[s0 - 1] !== '\n') s0--;                 // 回退到该语句的行首
      let e0 = o.start + o.len;
      if (sql.startsWith('\r\n', e0)) e0 += 2; else if (sql[e0] === '\n') e0 += 1;
      edits.push({ start: s0, end: e0, text: '' });
      covered.delete(o.col);
    }
  }
  for (const it of constraintItems) {
    if (!/^(?:key|index|unique\s+key|fulltext\b|spatial\b)/i.test(it.text)) continue;
    const cols = /\(([^)]*)\)/.exec(it.text);
    if (cols) for (const col of core.splitTopLevel(cols[1])) covered.add(col.trim().replace(/\s+(?:asc|desc)$/i, '').replace(/["`\[\]]/g, '').toUpperCase());
  }
  const needIdx = target.filter((c) => c.indexed && !c.primary_key && !covered.has(c.name.toUpperCase()));
  if (needIdx.length && dialect !== 'mysql') {
    stats.indexesAdded = needIdx.length;
    let anchor = scan.termEnd;
    const tailIdxRe = /create\s+(?:unique\s+)?index\s+[\w$#".]+\s+on\s+[\w$#".]+\s*\([^)]*\)\s*(?:;|\/)?/gim;
    let last = null, tm;
    while ((tm = tailIdxRe.exec(sql))) if (!last || (tm.index + tm[0].length) > (last.index + last[0].length)) last = tm;
    if (last) anchor = last.index + last[0].length;
    const term = scan.hasSlashTerminator ? '\n/' : ';';
    const stmts = needIdx.map((c) => {
      const col = c.name.toUpperCase();
      const full = table.toUpperCase();
      let nm = `IDX_${full}_${col}`.replace(/[^\w$#]/g, '_');
      if (nm.length > 30) {
        // Oracle 老版本标识符上限 30。先缩表名（CIPA 这类首字母缩写，与库里既有索引风格一致），
        // 列名是辨识度所在，尽量保住。
        const abbr = full.split('_').map((x) => x[0] || '').join('');
        nm = `IDX_${abbr}_${col}`.replace(/[^\w$#]/g, '_');
      }
      if (nm.length > 30) nm = nm.slice(0, 30);
      return `create index ${nm}\n    on ${scan.tableToken} (${c.name})`;
    });
    edits.push({ start: anchor, end: anchor, text: '\n' + stmts.map((s) => s + term).join('\n') + '\n' });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = sql;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { ok: true, sql: out, stats, changed: out !== sql };
}

// --- Schema Studio --------------------------------------------------------

class SchemaStudioModal extends Modal {
  constructor(app, plugin) {
    super(app); this.plugin=plugin; this.domain='api'; this.selectedKey=null; this.page='browse'; this.importState=null;
    this.pendingEdits=new Map(); this.gridSearch={api:'',db:''}; this.activeGridPopover=null; this.activeGridEditor=null;
    this._forceClosing=false; this._closePromptOpen=false;
    // Do not register another Escape handler here. Obsidian's Modal already owns
    // Escape. We override close() below so *every* close path (native Escape and
    // the title-bar X included) first yields to an active cell editor and then
    // passes through the same unsaved-change guard.
    this.scope?.register?.(null,'Enter',(evt)=>{
      if(evt?.__schemaStudioCellHandled)return false;
      if(this.activeGridEditor){
        if(evt)evt.__schemaStudioCellHandled=true;
        this.activeGridEditor.commit();
        return false;
      }
      return true;
    });
    this.scope?.register?.(['Mod'],'s',(evt)=>{
      evt?.preventDefault?.();
      if(this.activeGridEditor)this.activeGridEditor.commit();
      if(this.page==='browse'&&this.pendingEdits.size){this.saveAllPendingEdits({render:true,notify:true});return false;}
      return false;
    });
  }
  onOpen(){this.modalEl.addClass('schema-studio-modal');this.render();}
  onClose(){this.unloadMarkdownComponents();}
  // 阅读模式渲染：MarkdownRenderer 需要 Component 承载子任务生命周期，
  // 模态关闭时统一 unload，避免每次重渲染都泄漏一批渲染任务。
  ensureMarkdownComponent(){
    if(this._mdComponent)return this._mdComponent;
    this._mdComponent=new Component();
    this._mdComponent.load();
    if(!this._mdComponents)this._mdComponents=[];
    this._mdComponents.push(this._mdComponent);
    return this._mdComponent;
  }
  unloadMarkdownComponents(){
    for(const c of this._mdComponents||[])try{c.unload();}catch(e){/* 已卸载 */}
    this._mdComponents=[];this._mdComponent=null;
  }
  // 把 markdown 渲染进容器（阅读模式）。MarkdownRenderer 不可用时降级为纯文本，不影响主流程。
  renderMarkdown(el,markdown,sourcePath){
    if(!el)return;
    const md=String(markdown??'');
    if(typeof MarkdownRenderer?.render!=='function'){el.setText(md);return;}
    try{
      const comp=this.ensureMarkdownComponent();
      const done=MarkdownRenderer.render(this.app,md,el,String(sourcePath||''),comp);
      if(done&&typeof done.catch==='function')done.catch(e=>{console.warn('[Schema Studio] 阅读模式渲染失败',e);el.setText(md);});
    }catch(e){console.warn('[Schema Studio] 阅读模式渲染失败',e);el.setText(md);}
  }
  getPendingEditStats(){
    let records=0,cells=0;
    for(const edits of this.pendingEdits.values()){const n=Object.keys(edits||{}).length;if(n){records++;cells+=n;}}
    return {records,cells};
  }
  hasPendingImport(){return (this.page==='json-diff'||this.page==='ddl-diff'||this.page==='xxljob-diff')&&!!this.importState?.analysis?.length;}
  hasUnsavedChanges(){const p=this.getPendingEditStats();return p.cells>0||this.hasPendingImport();}
  unsavedSummary(){
    const p=this.getPendingEditStats(),parts=[];
    if(p.cells)parts.push(`${p.records} 条记录共 ${p.cells} 处手工修改`);
    if(this.hasPendingImport())parts.push(this.page==='json-diff'?'JSON 导入对比尚未应用':this.page==='ddl-diff'?'DDL 导入对比尚未应用':'xxl-job 导入对比尚未应用');
    return parts.join('；')||'存在未保存修改';
  }
  close(){
    if(this._forceClosing)return super.close();
    // Native Modal Escape can fire before the editor DOM keydown. Treat the first
    // close request while a cell is active as "leave/cancel cell edit" only.
    if(this.activeGridEditor){this.activeGridEditor.cancel();return;}
    if(this.hasUnsavedChanges()){this.openUnsavedPrompt();return;}
    return super.close();
  }
  forceClose(){this._forceClosing=true;return super.close();}
  openUnsavedPrompt(){
    if(this._closePromptOpen)return;
    this._closePromptOpen=true;
    new SchemaStudioUnsavedModal(this.app,this).open();
  }
  async saveAllPendingEdits({render=true,notify=true}={}){
    let count=0;
    for(const [filePath,edits] of [...this.pendingEdits.entries()]){
      if(!edits||!Object.keys(edits).length){this.pendingEdits.delete(filePath);continue;}
      const file=this.app.vault.getAbstractFileByPath(filePath);
      if(!file)continue;
      await this.app.fileManager.processFrontMatter(file,fm=>{for(const[k,v]of Object.entries(edits))fm[k]=v;});
      this.pendingEdits.delete(filePath);count++;
    }
    if(notify)new Notice(count?`已保存 ${count} 条 Schema 记录`:'没有需要保存的修改');
    if(render)this.render();
    return count;
  }
  async saveDirtyAndClose(){
    try{
      // Apply import first, then manual pending edits. If an import analysis was
      // built from an older snapshot, the user's latest manual edits must win.
      if(this.page==='json-diff'&&this.importState?.analysis)await this.applyJson(this.importState);
      else if(this.page==='ddl-diff'&&this.importState?.analysis)await this.applyDdl(this.importState);
      else if(this.page==='xxljob-diff'&&this.importState?.analysis)await this.applyXxljob(this.importState);
      await this.saveAllPendingEdits({render:false,notify:false});
      this.forceClose();
    }catch(error){console.error('[Schema Studio] 保存并关闭失败',error);new Notice(`保存失败：${error?.message||error}`);}
  }
  discardDirtyAndClose(){this.pendingEdits.clear();this.importState=null;this.forceClose();}
  render(){
    this.activeGridEditor=null;
    this.contentEl.empty(); const shell=this.contentEl.createDiv({cls:'schema-studio-shell'}); this.sidebarEl=shell.createDiv({cls:'schema-studio-sidebar'}); this.mainEl=shell.createDiv({cls:'schema-studio-main'}); this.renderSidebar();
    if(this.page==='json-import')this.renderJsonImport(); else if(this.page==='json-diff')this.renderJsonDiff(); else if(this.page==='ddl-import')this.renderDdlImport(); else if(this.page==='ddl-diff')this.renderDdlDiff(); else if(this.page==='xxljob-import')this.renderXxljobImport(); else if(this.page==='xxljob-diff')this.renderXxljobDiff(); else this.renderBrowse();
  }
  renderSidebar(){
    const title=this.sidebarEl.createDiv({cls:'schema-studio-brand'});title.createDiv({text:'Schema Studio',cls:'schema-studio-brand-title'});title.createDiv({text:'接口 / 数据库结构管理',cls:'schema-tools-muted'});
    const tabs=this.sidebarEl.createDiv({cls:'schema-studio-domain-tabs'});this.domainButton(tabs,'api','接口');this.domainButton(tabs,'db','数据库');this.domainButton(tabs,'xxljob','xxl-job');
    const importBtn=this.sidebarEl.createEl('button',{text:this.domain==='api'?'+ 导入 / 新建接口':this.domain==='db'?'+ 批量导入 / 更新 DDL':'+ 导入 xxl-job XML',cls:'schema-studio-import-button mod-cta'});importBtn.onclick=()=>{this.page=this.domain==='api'?'json-import':this.domain==='db'?'ddl-import':'xxljob-import';this.importState=null;this.render();};
    const search=this.sidebarEl.createEl('input',{type:'search',placeholder:'筛选…',cls:'schema-studio-nav-search'});const list=this.sidebarEl.createDiv({cls:'schema-studio-nav-list'});
    const draw=()=>{list.empty();const q=search.value.trim().toLowerCase();const items=this.domain==='api'?this.getApiGroups():this.domain==='db'?this.getDbGroups():this.getXxljobGroups();items.filter(x=>!q||x.label.toLowerCase().includes(q)).forEach(item=>{const row=list.createDiv({cls:`schema-studio-nav-item${this.selectedKey===item.key&&this.page==='browse'?' is-active':''}`});row.createDiv({text:item.label,cls:'schema-studio-nav-title'});row.createDiv({text:item.detail,cls:'schema-tools-muted'});row.onclick=()=>{this.selectedKey=item.key;this.page='browse';this.render();};});if(!items.length)list.createDiv({text:'暂无数据',cls:'schema-tools-muted schema-studio-empty'});};search.oninput=draw;draw();
  }
  domainButton(parent,domain,label){const btn=parent.createEl('button',{text:label,cls:this.domain===domain?'is-active':''});btn.onclick=()=>{this.domain=domain;this.selectedKey=null;this.page='browse';this.importState=null;this.render();};}
  // 按「模块 + 接口名」分组：5.api 与 6.client 下的同名接口是两回事，不能合成一组，
  // 否则两边的字段会混在一起、编辑时互相覆盖。
  getApiGroups(){const map=new Map();for(const r of this.plugin.scanApiFields()){const label=`${r.apiModule?r.apiModule+'-':''}${r.apiName}`;if(!map.has(label))map.set(label,{key:label,label,apiModule:r.apiModule||'',apiName:r.apiName,rows:[],apiPath:r.apiPath});map.get(label).rows.push(r);}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')).map(x=>({...x,detail:`${x.rows.filter(r=>!r.schema_orphaned).length} 个节点`}));}
  getDbGroups(){const map=new Map();for(const r of this.plugin.scanDbColumns()){if(!map.has(r.table))map.set(r.table,{key:r.table,label:r.table,rows:[],tablePath:r.tablePath});map.get(r.table).rows.push(r);}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label)).map(x=>({...x,detail:`${x.rows.filter(r=>!r.schema_orphaned).length} 列`}));}
  renderBrowse(){this.domain==='api'?this.renderApiBrowse():this.domain==='db'?this.renderDbBrowse():this.renderXxljobBrowse();}
  // --- xxl-job 域：按执行器分组，列出 <执行器>/{任务流,任务,任务组件} 下的文档 ---
  getXxljobGroups(){
    const root=normalizePath(this.plugin.settings.xxljobDocsFolder||DEFAULTS.xxljobDocsFolder)+'/';const map=new Map();
    for(const file of this.app.vault.getMarkdownFiles()){
      if(!file.path.startsWith(root))continue;
      const parts=file.path.slice(root.length).split('/');
      if(parts.length<3)continue; // <执行器>/<层级>/<名称>.md
      const executor=parts[0],level=parts[1];
      if(level!==XXL_DIRS.flow&&level!==XXL_DIRS.task&&level!==XXL_DIRS.component)continue;
      if(!map.has(executor))map.set(executor,{key:executor,label:executor,counts:{flow:0,task:0,component:0},files:[]});
      const g=map.get(executor);g.files.push({file,level,name:basenameNoExt(file.path)});
      if(level===XXL_DIRS.flow)g.counts.flow++;else if(level===XXL_DIRS.task)g.counts.task++;else g.counts.component++;
    }
    return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')).map(x=>({...x,detail:`${x.counts.flow} 个任务流 / ${x.counts.task} 个任务 / ${x.counts.component} 个组件`}));
  }
  renderXxljobBrowse(){
    if(!xxl){this.xxljobUnavailable();return;}
    const groups=this.getXxljobGroups(),folder=this.plugin.settings.xxljobDocsFolder||DEFAULTS.xxljobDocsFolder;
    if(!groups.length){this.renderWelcome('还没有 xxl-job 文档',`点左下角「+ 导入 xxl-job XML」，从 xxl-job 平台导出的 XML 生成 ${folder}/<执行器>/{任务流,任务,任务组件} 三级文档。`);return;}
    const group=groups.find(g=>g.key===this.selectedKey)||groups[0];this.selectedKey=group.key;
    this.renderHeader(group.label,`${group.detail} · ${folder}/${group.label}`,[{text:'xxl-job XML 导入',primary:true,onclick:()=>{this.page='xxljob-import';this.importState=null;this.render();}}]);
    const statLine=this.mainEl.createDiv({cls:'schema-tools-muted'});
    void this.plugin.loadXxljobState().then(st=>{if(st?.updatedAt)statLine.setText(`上次导入：${new Date(st.updatedAt).toLocaleString('zh-CN')} · 来源记录见 ${this.plugin.xxljobStatePath()}`);});
    for(const dirName of [XXL_DIRS.flow,XXL_DIRS.task,XXL_DIRS.component]){
      const files=group.files.filter(f=>f.level===dirName).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
      if(!files.length)continue;
      this.mainEl.createDiv({text:`${dirName}（${files.length}）`,cls:'schema-tools-label'});
      const list=this.mainEl.createDiv({cls:'schema-studio-selected-files schema-studio-xxl-list'});
      for(const f of files){
        // 每份文档一张卡片：标题点击打开笔记，下方只预览「笔记属性」块
        const card=list.createDiv({cls:'schema-studio-xxl-card'});
        const chip=card.createDiv({text:f.name,cls:'schema-studio-file-chip schema-studio-xxl-card-title'});
        chip.onclick=()=>{const file=this.app.vault.getAbstractFileByPath(f.file.path);if(file instanceof TFile)void this.app.workspace.getLeaf(false).openFile(file);};
        // 浏览页的「笔记属性」预览也走阅读模式，与导入清单页保持一致
        const host=card.createDiv({cls:'schema-studio-xxl-preview'});
        host.setText('（读取中…）');
        void this.app.vault.cachedRead(f.file)
          .then(text=>{
            host.empty();
            this.renderMarkdown(host,xxl.frontmatterToMarkdown(text)||'（无笔记属性）',f.file.path);
          })
          .catch(()=>host.setText('（读取失败）'));
      }
    }
  }
  renderWelcome(title,text){this.mainEl.createDiv({text:title,cls:'schema-studio-welcome-title'});this.mainEl.createDiv({text,cls:'schema-tools-muted schema-studio-welcome-text'});}

  renderHeader(title,subtitle,buttons=[]){
    const header=this.mainEl.createDiv({cls:'schema-studio-main-header'});const left=header.createDiv();left.createEl('h2',{text:title});if(subtitle)left.createDiv({text:subtitle,cls:'schema-tools-muted'});const actions=header.createDiv({cls:'schema-studio-header-actions'});for(const b of buttons){const btn=actions.createEl('button',{text:b.text,cls:b.primary?'mod-cta':''});btn.onclick=b.onclick;}return header;
  }
  getGridDefinitions(domain,extraKeys=[]){
    const schema=this.plugin.getFieldDefinitions(domain);
    const hidden=new Set(['api','table',...SCHEMA_INTERNAL_KEYS]);
    const defs=schema.fields.filter(d=>!hidden.has(d.name));
    const by=new Map(defs.map(d=>[d.name,d]));
    // extraKeys 只在 Fileclass 里没有对应属性（含中文别名）时才补列，避免同一属性出现中英文两列
    for(const key of extraKeys||[])if(key&&!hidden.has(key)&&!by.has(key)&&!schemaKeyCandidates(domain,key).some(c=>by.has(c))){
      const d={name:key,type:key==='order'?'Number':['nullable','primary_key','indexed'].includes(key)?'Boolean':'Input',required:false,options:[]};
      by.set(key,d);defs.push(d);
    }
    return {schema,defs};
  }
  getGridViewPrefs(domain){
    const root=this.plugin.settings.gridViewPrefs||(this.plugin.settings.gridViewPrefs={});
    const cur=root[domain]||(root[domain]={hiddenProps:[],sorts:[],filters:[]});
    if(!Array.isArray(cur.hiddenProps))cur.hiddenProps=[];
    if(!Array.isArray(cur.sorts))cur.sorts=[];
    if(!Array.isArray(cur.filters))cur.filters=[];
    return cur;
  }
  persistGridViewPrefs(){ this.plugin.saveSettings().catch(e=>console.warn('[Schema Studio] 保存视图设置失败',e)); }
  toolbarButton(parent,icon,label,onClick,active=false){
    const btn=parent.createEl('button',{cls:`schema-studio-view-tool${active?' is-active':''}`,attr:{type:'button','aria-label':label}});
    const ico=btn.createSpan({cls:'schema-studio-view-tool-icon'});try{setIcon(ico,icon);}catch(_e){}
    btn.createSpan({text:label,cls:'schema-studio-view-tool-label'});btn.onclick=(e)=>{e.preventDefault();e.stopPropagation();onClick(btn,e);};return btn;
  }
  closeGridPopover(){ if(this.activeGridPopover){this.activeGridPopover.remove();this.activeGridPopover=null;} }
  openGridPopover(toolbar,button,title,build){
    if(this.activeGridPopover){const same=this.activeGridPopover.dataset.owner===button.dataset.toolOwner;this.closeGridPopover();if(same)return;}
    if(!button.dataset.toolOwner)button.dataset.toolOwner=`tool-${Date.now()}-${Math.random()}`;
    const pop=toolbar.createDiv({cls:'schema-studio-view-popover'});pop.dataset.owner=button.dataset.toolOwner;
    const head=pop.createDiv({cls:'schema-studio-view-popover-head'});head.createDiv({text:title,cls:'schema-studio-view-popover-title'});
    const close=head.createEl('button',{cls:'schema-studio-view-popover-close',attr:{type:'button','aria-label':'关闭'}});try{setIcon(close,'x');}catch(_e){}close.onclick=()=>this.closeGridPopover();
    build(pop);this.activeGridPopover=pop;
  }
  compareGridValues(a,b){
    if(a==null&&b==null)return 0;if(a==null)return -1;if(b==null)return 1;
    if(typeof a==='number'&&typeof b==='number')return a-b;
    if(typeof a==='boolean'&&typeof b==='boolean')return Number(a)-Number(b);
    return String(a).localeCompare(String(b),'zh-CN',{numeric:true,sensitivity:'base'});
  }
  toggleGridSort(prefs,field,event,draw){
    const multi=!!event?.shiftKey;
    const sorts=Array.isArray(prefs.sorts)?prefs.sorts:(prefs.sorts=[]);
    const index=sorts.findIndex(rule=>rule?.field===field);
    if(!multi){
      const current=index===0?sorts[0]:null;
      if(current){
        if(current.dir!=='desc')current.dir='desc';
        else sorts.splice(0,1);
      }else{
        if(index>=0)sorts.splice(index,1);
        prefs.sorts=[{field,dir:'asc'},...sorts];
      }
    }else if(index>=0){
      const current=sorts[index];
      if(current.dir!=='desc')current.dir='desc';
      else sorts.splice(index,1);
    }else sorts.push({field,dir:'asc'});
    this.persistGridViewPrefs();
    draw({focusSortField:field});
  }
  gridSortHeaderState(sorts,field){
    const index=(sorts||[]).findIndex(rule=>rule?.field===field);
    if(index<0)return {index:-1,dir:null};
    return {index,dir:sorts[index]?.dir==='desc'?'desc':'asc'};
  }
  gridModelMatchesFilter(model,rule){
    const v=model.getValue(rule.field);const text=displayGridValue(v).toLowerCase();const q=String(rule.value??'').toLowerCase();
    if(rule.op==='eq')return text===q;if(rule.op==='neq')return text!==q;if(rule.op==='empty')return text==='';if(rule.op==='notEmpty')return text!=='';
    if(rule.op==='starts')return text.startsWith(q);return text.includes(q);
  }
  renderGridToolbar(rows,models,defs,domain,gridHost,draw){
    const prefs=this.getGridViewPrefs(domain);const toolbar=this.mainEl.createDiv({cls:'schema-studio-view-toolbar'});
    const left=toolbar.createDiv({cls:'schema-studio-view-toolbar-left'});const vi=left.createSpan({cls:'schema-studio-view-icon'});try{setIcon(vi,'table-properties');}catch(_e){}
    left.createSpan({text:domain==='api'?'当前接口字段':'当前数据表字段',cls:'schema-studio-view-name'});const count=left.createSpan({cls:'schema-studio-view-count'});
    const right=toolbar.createDiv({cls:'schema-studio-view-toolbar-right'});
    const updateCount=(n)=>count.setText(`${n} 个结果`);
    const sortBtn=this.toolbarButton(right,'arrow-up-down','排序',(btn)=>this.openGridPopover(toolbar,btn,'排序',(pop)=>{
      const list=pop.createDiv({cls:'schema-studio-rule-list'});
      const redrawRules=()=>{list.empty();prefs.sorts.forEach((rule,i)=>{
        const row=list.createDiv({cls:'schema-studio-rule-row'});const sel=row.createEl('select');defs.forEach(d=>sel.createEl('option',{value:d.name,text:d.name}));sel.value=rule.field||defs[0]?.name||'';
        const dir=row.createEl('select');dir.createEl('option',{value:'asc',text:'升序'});dir.createEl('option',{value:'desc',text:'降序'});dir.value=rule.dir||'asc';
        const del=row.createEl('button',{text:'×',attr:{type:'button','aria-label':'移除排序'}});
        sel.onchange=()=>{rule.field=sel.value;this.persistGridViewPrefs();draw();};dir.onchange=()=>{rule.dir=dir.value;this.persistGridViewPrefs();draw();};del.onclick=()=>{prefs.sorts.splice(i,1);this.persistGridViewPrefs();redrawRules();draw();};
      });if(!prefs.sorts.length)list.createDiv({text:'未设置排序',cls:'schema-tools-muted'});};redrawRules();
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const add=actions.createEl('button',{text:'+ 添加排序'});add.onclick=()=>{prefs.sorts.push({field:defs[0]?.name||'',dir:'asc'});this.persistGridViewPrefs();redrawRules();draw();};const clear=actions.createEl('button',{text:'清除'});clear.onclick=()=>{prefs.sorts=[];this.persistGridViewPrefs();redrawRules();draw();};
    }),prefs.sorts.length>0);
    const filterBtn=this.toolbarButton(right,'filter','筛选',(btn)=>this.openGridPopover(toolbar,btn,'筛选（全部条件同时满足）',(pop)=>{
      const list=pop.createDiv({cls:'schema-studio-rule-list'});
      const redrawRules=()=>{list.empty();prefs.filters.forEach((rule,i)=>{
        const row=list.createDiv({cls:'schema-studio-rule-row schema-studio-filter-rule'});const sel=row.createEl('select');defs.forEach(d=>sel.createEl('option',{value:d.name,text:d.name}));sel.value=rule.field||defs[0]?.name||'';
        const op=row.createEl('select');[['contains','包含'],['eq','等于'],['neq','不等于'],['starts','开头是'],['empty','为空'],['notEmpty','不为空']].forEach(([v,t])=>op.createEl('option',{value:v,text:t}));op.value=rule.op||'contains';
        const value=row.createEl('input',{type:'text',placeholder:'值'});value.value=rule.value||'';value.toggleClass('is-hidden',['empty','notEmpty'].includes(op.value));
        const del=row.createEl('button',{text:'×',attr:{type:'button','aria-label':'移除筛选'}});
        sel.onchange=()=>{rule.field=sel.value;this.persistGridViewPrefs();draw();};op.onchange=()=>{rule.op=op.value;value.toggleClass('is-hidden',['empty','notEmpty'].includes(op.value));this.persistGridViewPrefs();draw();};value.oninput=()=>{rule.value=value.value;this.persistGridViewPrefs();draw();};del.onclick=()=>{prefs.filters.splice(i,1);this.persistGridViewPrefs();redrawRules();draw();};
      });if(!prefs.filters.length)list.createDiv({text:'未设置筛选',cls:'schema-tools-muted'});};redrawRules();
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const add=actions.createEl('button',{text:'+ 添加筛选'});add.onclick=()=>{prefs.filters.push({field:defs[0]?.name||'',op:'contains',value:''});this.persistGridViewPrefs();redrawRules();draw();};const clear=actions.createEl('button',{text:'清除'});clear.onclick=()=>{prefs.filters=[];this.persistGridViewPrefs();redrawRules();draw();};
    }),prefs.filters.length>0);
    const propBtn=this.toolbarButton(right,'list','属性',(btn)=>this.openGridPopover(toolbar,btn,'显示属性',(pop)=>{
      const hidden=new Set(prefs.hiddenProps);const list=pop.createDiv({cls:'schema-studio-property-list'});
      defs.forEach(def=>{const label=list.createEl('label',{cls:'schema-studio-property-row'});const cb=label.createEl('input',{type:'checkbox'});cb.checked=!hidden.has(def.name);label.createSpan({text:def.name});cb.onchange=()=>{const set=new Set(prefs.hiddenProps);if(cb.checked)set.delete(def.name);else set.add(def.name);if(set.size>=defs.length){cb.checked=true;new Notice('至少保留一个属性列');return;}prefs.hiddenProps=[...set];this.persistGridViewPrefs();draw();};});
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const all=actions.createEl('button',{text:'全部显示'});all.onclick=()=>{prefs.hiddenProps=[];this.persistGridViewPrefs();this.closeGridPopover();draw();};
    }),prefs.hiddenProps.length>0);
    let searchInput=null;
    const searchBtn=this.toolbarButton(right,'search','搜索',(_btn)=>{
      if(searchInput){searchInput.remove();searchInput=null;this.gridSearch[domain]='';draw();return;}
      searchInput=right.createEl('input',{type:'search',placeholder:'搜索当前表…',cls:'schema-studio-view-search'});searchInput.value=this.gridSearch[domain]||'';searchInput.oninput=()=>{this.gridSearch[domain]=searchInput.value;draw();};searchInput.onkeydown=(e)=>{if(e.key==='Escape'){e.preventDefault();searchInput.remove();searchInput=null;this.gridSearch[domain]='';draw();}};searchInput.focus();
    },!!this.gridSearch[domain]);
    this.toolbarButton(right,'plus','新建',(btn)=>this.openNewRecordPopover(toolbar,btn,domain,rows));
    return {toolbar,count,updateCount};
  }
  async createManualRecord(domain,rows,values){
    if(domain==='api'){
      const apiName=this.selectedKey;const direction=String(values.direction||'Request');const path=String(values.path||'').trim();if(!path){new Notice('请输入字段 path');return;}
      if(rows.some(r=>r.direction===direction&&r.path===path)){new Notice(`${direction} / ${path} 已存在`);return;}
      const group=this.getApiGroups().find(x=>x.key===apiName);const apiDocPath=normalizePath(group?.apiPath||`${this.plugin.settings.apiDocsFolder}/${apiName}.md`);await ensureFolder(this.app,this.plugin.settings.apiFieldsFolder);await ensureFolder(this.app,this.plugin.settings.apiDocsFolder);
      if(!this.app.vault.getAbstractFileByPath(apiDocPath))await this.app.vault.create(apiDocPath,`# ${apiName}\n\n## Request\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Request]]\n\n## Response\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Response]]\n`);
      const parentRaw=path.includes('.')?path.slice(0,path.lastIndexOf('.')):'';const parent=parentRaw.replace(/\[\]$/,'');const leaf=(path.includes('.')?path.slice(path.lastIndexOf('.')+1):path).replace(/\[\]$/,'');
      const props=this.plugin.defaultPropertiesForDomain('api');
      for(const [key,value] of Object.entries({api:`[[${apiDocPath.replace(/\.md$/,'')}]]`,direction,path,parent_path:parent,name:leaf,shape:values.shape||'Scalar',data_type:values.data_type||'string'}))setSchemaValue(props,'api',key,value);
      purgeSchemaInternalKeys(props);
      const filePath=normalizePath(`${this.plugin.settings.apiFieldsFolder}/${core.makeApiFieldFilename(apiName,direction,path)}.md`);if(this.app.vault.getAbstractFileByPath(filePath)){new Notice(`目标文件已存在：${filePath}`);return;}await this.app.vault.create(filePath,`---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(apiName,direction,canonicalSchemaRecord('api',props))}`);new Notice(`已新建 ${direction} / ${path}`);
    }else{
      const table=this.selectedKey;const name=String(values.name||'').trim();if(!name){new Notice('请输入列名');return;}if(rows.some(r=>r.name===name)){new Notice(`${name} 已存在`);return;}
      const group=this.getDbGroups().find(x=>x.key===table);const tableDocPath=normalizePath(group?.tablePath||`${this.plugin.settings.dbDocsFolder}/${table}.md`);await ensureFolder(this.app,this.plugin.settings.dbColumnsFolder);await ensureFolder(this.app,this.plugin.settings.dbDocsFolder);if(!this.app.vault.getAbstractFileByPath(tableDocPath))await this.app.vault.create(tableDocPath,await this.renderNewTableDoc({table,schema:'',tableComment:''},''));
      const props=this.plugin.defaultPropertiesForDomain('db');
      for(const [key,value] of Object.entries({table:`[[${tableDocPath.replace(/\.md$/,'')}]]`,name,data_type:values.data_type||'VARCHAR(255)',nullable:true,primary_key:false,indexed:false}))setSchemaValue(props,'db',key,value);
      purgeSchemaInternalKeys(props);
      const filePath=normalizePath(`${this.plugin.settings.dbColumnsFolder}/${core.makeDbColumnFilename(table,name)}.md`);if(this.app.vault.getAbstractFileByPath(filePath)){new Notice(`目标文件已存在：${filePath}`);return;}await this.app.vault.create(filePath,`---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(table,canonicalSchemaRecord('db',props),tableDocPath)}`);new Notice(`已新建 ${table}.${name}`);
    }
    this.closeGridPopover();this.render();
  }
  openNewRecordPopover(toolbar,button,domain,rows){
    this.openGridPopover(toolbar,button,domain==='api'?'新建接口字段':'新建数据库列',(pop)=>{
      const form=pop.createDiv({cls:'schema-studio-new-form'});const values={};
      if(domain==='api'){
        const lab1=form.createEl('label');lab1.createSpan({text:'方向'});const dir=lab1.createEl('select');dir.createEl('option',{value:'Request',text:'Request'});dir.createEl('option',{value:'Response',text:'Response'});dir.onchange=()=>values.direction=dir.value;values.direction='Request';
        const lab2=form.createEl('label');lab2.createSpan({text:'path'});const path=lab2.createEl('input',{type:'text',placeholder:'items[].sku_id'});path.oninput=()=>values.path=path.value;
        const lab3=form.createEl('label');lab3.createSpan({text:'shape'});const shape=lab3.createEl('select');['Scalar','Object','List','List<Object>'].forEach(x=>shape.createEl('option',{value:x,text:x}));shape.onchange=()=>values.shape=shape.value;values.shape='Scalar';
        const lab4=form.createEl('label');lab4.createSpan({text:'data_type'});const dt=lab4.createEl('input',{type:'text',placeholder:'string'});dt.value='string';dt.oninput=()=>values.data_type=dt.value;values.data_type='string';
      }else{
        const lab1=form.createEl('label');lab1.createSpan({text:'列名'});const name=lab1.createEl('input',{type:'text',placeholder:'column_name'});name.oninput=()=>values.name=name.value;
        const lab2=form.createEl('label');lab2.createSpan({text:'data_type'});const dt=lab2.createEl('input',{type:'text',placeholder:'VARCHAR(255)'});dt.value='VARCHAR(255)';dt.oninput=()=>values.data_type=dt.value;values.data_type='VARCHAR(255)';
      }
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const create=actions.createEl('button',{text:'创建',cls:'mod-cta'});create.onclick=()=>this.createManualRecord(domain,rows,values);
    });
  }

  renderGenericEditor(rows,domain){
    const {schema,defs}=this.getGridDefinitions(domain);const prefs=this.getGridViewPrefs(domain);
    const models=rows.map(row=>({
      key:domain==='api'?row.path:row.name,source:row,
      getValue:(name)=>{const pending=this.pendingEdits.get(row.file.path);return pending&&Object.prototype.hasOwnProperty.call(pending,name)?pending[name]:row.fm?.[name];},
      getBefore:(name)=>row.fm?.[name],
      setValue:(name,value)=>{let pending=this.pendingEdits.get(row.file.path)||{};if(valuesEqual(row.fm?.[name],value))delete pending[name];else pending[name]=value;if(Object.keys(pending).length)this.pendingEdits.set(row.file.path,pending);else this.pendingEdits.delete(row.file.path);},
      readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name),status:'normal'
    }));
    const gridHost=this.mainEl.createDiv({cls:'schema-studio-grid-host'});let toolbarCtl=null;
    const draw=(renderOptions={})=>{
      const previousWrap=gridHost.querySelector('.schema-studio-grid-wrap');
      const previousHint=gridHost.querySelector('.schema-studio-grid-hint');
      const previousActive=document.activeElement;
      const previousCell=previousActive?.closest?.('.schema-studio-grid-cell');
      const previousFocus={key:previousCell?.getAttribute('data-schema-grid-key')||'',field:previousCell?.getAttribute('data-schema-grid-field')||''};
      const scroll={top:previousWrap?.scrollTop||0,left:previousWrap?.scrollLeft||0};
      const hidden=new Set(prefs.hiddenProps||[]);let visibleDefs=defs.filter(d=>!hidden.has(d.name));if(!visibleDefs.length)visibleDefs=defs.slice(0,1);
      let visible=models.slice();const q=String(this.gridSearch[domain]||'').trim().toLowerCase();if(q)visible=visible.filter(m=>defs.some(d=>displayGridValue(m.getValue(d.name)).toLowerCase().includes(q)));
      for(const rule of prefs.filters||[])visible=visible.filter(m=>this.gridModelMatchesFilter(m,rule));
      if((prefs.sorts||[]).length)visible.sort((a,b)=>{for(const rule of prefs.sorts){const c=this.compareGridValues(a.getValue(rule.field),b.getValue(rule.field));if(c)return rule.dir==='desc'?-c:c;}return 0;});
      // Build the replacement off-screen first, then swap complete nodes. This
      // avoids the blank frame caused by emptying the live host before refresh.
      const staging=gridHost.createDiv({cls:'schema-studio-grid-staging'});
      const rendered=this.renderDataGrid(visible,visibleDefs,{domain,editable:true,parentEl:staging,sorts:prefs.sorts,onSort:(field,event)=>this.toggleGridSort(prefs,field,event,draw)});
      previousWrap?.remove();previousHint?.remove();
      while(staging.firstChild)gridHost.appendChild(staging.firstChild);
      staging.remove();
      const nextWrap=rendered.wrap;
      nextWrap.scrollTop=scroll.top;nextWrap.scrollLeft=scroll.left;
      const focusSortField=renderOptions.focusSortField;
      if(focusSortField){
        const sortButton=[...nextWrap.querySelectorAll('.schema-studio-grid-sort-button')].find(button=>button.dataset.schemaGridSortField===focusSortField);
        sortButton?.focus({preventScroll:true});
      }else if(previousFocus.key&&previousFocus.field){
        const cell=[...nextWrap.querySelectorAll('.schema-studio-grid-cell')].find(td=>td.getAttribute('data-schema-grid-key')===previousFocus.key&&td.getAttribute('data-schema-grid-field')===previousFocus.field);
        cell?.focus({preventScroll:true});
      }
      nextWrap.scrollTop=scroll.top;nextWrap.scrollLeft=scroll.left;
      toolbarCtl?.updateCount(visible.length);
    };
    toolbarCtl=this.renderGridToolbar(rows,models,defs,domain,gridHost,draw);this.mainEl.insertBefore(toolbarCtl.toolbar,gridHost);draw();return schema;
  }
  renderDataGrid(models,defs,options={}){
    const parentEl=options.parentEl||this.mainEl;
    const wrap=parentEl.createDiv({cls:'schema-studio-grid-wrap'});
    wrap.tabIndex=0;
    const table=wrap.createEl('table',{cls:'schema-studio-grid'});
    const thead=table.createEl('thead'),hr=thead.createEl('tr');
    if(options.showStatus)hr.createEl('th',{text:'',cls:'schema-studio-grid-status-head'});
    const sorts=options.sorts||[];
    for(const def of defs){
      const state=this.gridSortHeaderState(sorts,def.name);
      const buttonClasses=['schema-studio-grid-sort-button'];if(state.index>=0)buttonClasses.push('is-sorted');if(state.index===0)buttonClasses.push('is-primary-sort');
      const th=hr.createEl('th',{cls:'schema-studio-grid-sort-header',attr:{scope:'col','aria-sort':state.dir==='asc'?'ascending':state.dir==='desc'?'descending':'none'}});
      const button=th.createEl('button',{cls:buttonClasses.join(' '),attr:{type:'button','aria-label':state.dir?`${def.name}，当前${state.dir==='asc'?'升序':'降序'}，点击切换；Shift-点击追加排序`:`按 ${def.name} 排序；Shift-点击追加排序`}});
      button.dataset.schemaGridSortField=def.name;
      button.createSpan({text:def.name,cls:'schema-studio-grid-sort-label'});
      if(state.index>=0){
        button.createSpan({text:state.dir==='asc'?'↑':'↓',cls:'schema-studio-grid-sort-indicator',attr:{'aria-hidden':'true'}});
        if(sorts.length>1)button.createSpan({text:String(state.index+1),cls:'schema-studio-grid-sort-order',attr:{'aria-hidden':'true'}});
      }
      button.onclick=(event)=>{event.preventDefault();event.stopPropagation();options.onSort?.(def.name,event);};
    }
    const body=table.createEl('tbody');
    const state={anchor:null,focus:null,cells:[],editing:null,mouseDown:false,mouseMoved:false,mouseWasFocused:false,history:[],future:[]};
    const cellAt=(r,c)=>state.cells.find(x=>x.r===r&&x.c===c);
    const refreshSelection=()=>{
      const a=state.anchor,f=state.focus;
      for(const cell of state.cells)cell.td.removeClass('is-selected','is-selection-edge');
      if(!a||!f)return;
      const r1=Math.min(a.r,f.r),r2=Math.max(a.r,f.r),c1=Math.min(a.c,f.c),c2=Math.max(a.c,f.c);
      for(const cell of state.cells)if(cell.r>=r1&&cell.r<=r2&&cell.c>=c1&&cell.c<=c2){
        cell.td.addClass('is-selected');
        if(cell.r===r1||cell.r===r2||cell.c===c1||cell.c===c2)cell.td.addClass('is-selection-edge');
      }
    };
    const selectCell=(r,c,extend=false,ensureVisible=true)=>{
      if(!extend||!state.anchor)state.anchor={r,c};
      state.focus={r,c};refreshSelection();
      const cell=cellAt(r,c);if(cell){cell.td.focus({preventScroll:true});if(ensureVisible)cell.td.scrollIntoView?.({block:'nearest',inline:'nearest'});}
    };
    const getRange=()=>{
      if(!state.anchor||!state.focus)return null;
      return {r1:Math.min(state.anchor.r,state.focus.r),r2:Math.max(state.anchor.r,state.focus.r),c1:Math.min(state.anchor.c,state.focus.c),c2:Math.max(state.anchor.c,state.focus.c)};
    };
    // --- 编辑历史（撤销 / 重做）------------------------------------------------
    // 每次「提交一批修改」（编辑单元格、区域粘贴、剪切、清空、布尔切换）记录受影响单元格
    // 的旧值；撤销按批回写，重做反向回写。**所有改值都必须经 applyValue** —— 新增一条写值
    // 的代码路径时务必也走它，否则那条路径就撤不回来（对端踩过这个坑）。
    const HISTORY_LIMIT=80;
    const canWrite=(cell)=>!!cell&&options.editable&&cell.model.status!=='removed'&&!cell.model.readonly?.(cell.def.name);
    const pushHistory=(batch)=>{
      if(!batch||!batch.length)return;
      state.history.push(batch);
      if(state.history.length>HISTORY_LIMIT)state.history.shift();
      state.future.length=0;   // 产生新分支后，原来的重做链作废
    };
    const applyValue=(cell,value,batch)=>{
      const field=cell.def.name;
      const before=cell.model.getValue(field);
      if(valuesEqual(before,value))return false;
      cell.model.setValue(field,value);
      renderCell(cell);
      if(batch)batch.push({cell,field,before,after:value});
      return true;
    };
    // 撤销/重做不会在编辑态被调用：单元格的 keydown 开头就 `if(state.editing)return`，
    // 焦点在输入框时 Ctrl/Cmd+Z 交给输入框自己撤销刚打的字（原生行为），不动表格历史。
    const undoEdit=()=>{
      const batch=state.history.pop();
      if(!batch){new Notice('没有可撤销的修改');return;}
      for(let i=batch.length-1;i>=0;i--){const it=batch[i];it.cell.model.setValue(it.field,it.before);renderCell(it.cell);}
      state.future.push(batch);
      new Notice(`已撤销 ${batch.length} 个单元格修改`);
    };
    const redoEdit=()=>{
      const batch=state.future.pop();
      if(!batch){new Notice('没有可重做的修改');return;}
      for(const it of batch){it.cell.model.setValue(it.field,it.after);renderCell(it.cell);}
      state.history.push(batch);
      if(state.history.length>HISTORY_LIMIT)state.history.shift();
      new Notice(`已重做 ${batch.length} 个单元格修改`);
    };
    const renderCell=(cell)=>{
      const {td,model,def}=cell;td.empty();
      const value=model.getValue(def.name),before=model.getBefore?model.getBefore(def.name):undefined;
      const changed=!!model.getBefore&&!valuesEqual(before,value);
      const removed=model.status==='removed';
      td.toggleClass('is-readonly',!!model.readonly?.(def.name));
      td.toggleClass('has-diff',changed);
      td.toggleClass('is-removed-cell',removed);
      if(changed){
        td.createEl('del',{text:displayGridValue(before)||'（空）',cls:'schema-studio-grid-old'});
        td.createSpan({text:displayGridValue(value)||'（空）',cls:'schema-studio-grid-new'});
      }else if(removed){
        td.createEl('del',{text:displayGridValue(before!==undefined?before:value)||'（空）',cls:'schema-studio-grid-old'});
      }else{
        const s=td.createSpan({text:displayGridValue(value),cls:'schema-studio-grid-value'});
        if(displayGridValue(value)==='')s.addClass('is-empty');
      }
    };
    const finishEditor=(cell,input,{cancel=false,focusCell=true}={})=>{
      if(!cell||!input)return;
      // Detach blur first. Otherwise Escape -> focus(cell) can blur the editor and
      // accidentally commit the value we are trying to cancel.
      input.onblur=null;
      if(!cancel){
        let v;
        if(input.tagName==='SELECT')v=input.value;
        else if(input.type==='checkbox')v=input.checked;
        else v=clipboardValueForType(input.value,cell.def);
        const batch=[];applyValue(cell,v,batch);pushHistory(batch);
      }
      if(state.editing?.input===input)state.editing=null;
      if(this.activeGridEditor?.input===input)this.activeGridEditor=null;
      cell.td.removeClass('is-editing');
      renderCell(cell);
      if(focusCell)cell.td.focus({preventScroll:true});
    };
    const commitEditor=(cell,input,focusCell=true)=>finishEditor(cell,input,{cancel:false,focusCell});
    const cancelEditor=(cell,input,focusCell=true)=>finishEditor(cell,input,{cancel:true,focusCell});
    const beginEdit=(cell,initial,caretClientX)=>{
      if(!options.editable||cell.model.status==='removed'||cell.model.readonly?.(cell.def.name))return;
      if(state.editing?.cell===cell)return;
      if(state.editing&&state.editing.cell!==cell)commitEditor(state.editing.cell,state.editing.input);
      const type=String(cell.def.type||'Input').toLowerCase(),cur=cell.model.getValue(cell.def.name);
      cell.td.empty();cell.td.addClass('is-editing');
      let input;
      if(type==='boolean'){
        const batch=[];applyValue(cell,!Boolean(cur),batch);pushHistory(batch);
        cell.td.focus();
        return;
      }else if(type==='select'&&cell.def.options?.length){
        input=cell.td.createEl('select');for(const x of cell.def.options)input.createEl('option',{value:String(x),text:String(x)});input.value=cur==null?'':String(cur);
      }else{
        input=cell.td.createEl('input',{type:type==='number'?'number':'text',cls:'schema-studio-grid-editor'});
        input.value=initial!==undefined?String(initial):displayGridValue(cur);
        const placeCaret=()=>{
          if(!input.setSelectionRange)return;
          if(initial!==undefined){const n=String(initial).length;input.setSelectionRange(n,n);return;}
          const text=input.value||'';if(caretClientX==null){input.setSelectionRange(text.length,text.length);return;}
          const rect=input.getBoundingClientRect(),style=getComputedStyle(input),pad=parseFloat(style.paddingLeft)||0,x=Math.max(0,caretClientX-rect.left-pad+(input.scrollLeft||0));
          const canvas=beginEdit._canvas||(beginEdit._canvas=document.createElement('canvas'));const ctx=canvas.getContext('2d');if(!ctx){input.setSelectionRange(text.length,text.length);return;}ctx.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ctx.measureText(text.slice(0,mid)).width<=x)lo=mid;else hi=mid-1;}input.setSelectionRange(lo,lo);
        };
        requestAnimationFrame(placeCaret);
      }
      state.editing={cell,input};
      this.activeGridEditor={
        input,
        commit:()=>commitEditor(cell,input,true),
        cancel:()=>cancelEditor(cell,input,true),
      };
      input.focus();
      input.onblur=()=>commitEditor(cell,input,false);
      const handleEditorKeydown=(e)=>{
        if(e.key==='Enter'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          commitEditor(cell,input,true);
          return;
        }
        if(e.key==='Escape'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          cancelEditor(cell,input,true);
          return;
        }
        if(e.key==='Tab'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          commitEditor(cell,input,false);
          const nc=Math.max(0,Math.min(defs.length-1,cell.c+(e.shiftKey?-1:1)));
          selectCell(cell.r,nc);
        }
      };
      // Capture on the editor itself so Enter/Escape are consumed before they
      // can bubble into Obsidian's Modal/Scope keyboard handlers.
      input.addEventListener('keydown',handleEditorKeydown,true);
    };
    // 没有拖选区域时退回「当前焦点单元格」——单击一格后直接 Ctrl/Cmd+C 也能复制，
    // 不必先拖一个 1×1 的区域（对端 v0.7.13 的加固，行为保持一致）。
    const currentRange=()=>getRange()||(state.focus?{r1:state.focus.r,r2:state.focus.r,c1:state.focus.c,c2:state.focus.c}:null);
    const copySelection=(e)=>{
      const rg=currentRange();if(!rg)return;
      const lines=[];
      for(let r=rg.r1;r<=rg.r2;r++){const vals=[];for(let c=rg.c1;c<=rg.c2;c++){const cell=cellAt(r,c);vals.push(displayGridValue(cell?.model.getValue(cell.def.name)));}lines.push(vals.join('\t'));}
      e.clipboardData?.setData('text/plain',lines.join('\n'));e.preventDefault();
    };
    const selectAll=()=>{
      if(!models.length||!defs.length)return;
      state.anchor={r:0,c:0};state.focus={r:models.length-1,c:defs.length-1};
      refreshSelection();
    };
    // 剪切：先写剪贴板，再把区域清空（只清可写的单元格，只读列与已标记删除的行跳过）
    const cutSelection=(e)=>{
      const rg=currentRange();if(!rg||!options.editable)return;
      copySelection(e);
      const batch=[];
      for(let r=rg.r1;r<=rg.r2;r++)for(let c=rg.c1;c<=rg.c2;c++){const cell=cellAt(r,c);if(!canWrite(cell))continue;applyValue(cell,clipboardValueForType('',cell.def),batch);}
      pushHistory(batch);
      new Notice(batch.length?`已剪切 ${batch.length} 个单元格（可 Ctrl/Cmd+Z 撤销）`:'所选区域没有可剪切的单元格');
    };
    const pasteSelection=(e)=>{
      if(!options.editable)return;
      if(!state.focus){new Notice('请先点击目标单元格，再粘贴');return;}
      const raw=e.clipboardData?.getData('text/plain');if(raw==null)return;
      const matrix=parseClipboardTable(raw);if(!matrix.length)return;
      e.preventDefault();
      let headerMap=null,startRow=0;
      const headerMatches=matrix[0].map(v=>defs.findIndex(d=>d.name===String(v).trim()));
      if(headerMatches.filter(i=>i>=0).length>=2){headerMap=headerMatches;startRow=1;}
      const batch=[];let skipped=0;
      for(let sr=startRow;sr<matrix.length;sr++){
        const tr=state.focus.r+(sr-startRow);if(tr>=models.length){skipped+=matrix[sr].length;continue;}
        for(let sc=0;sc<matrix[sr].length;sc++){
          const tc=headerMap?(headerMap[sc]??-1):(state.focus.c+sc);if(tc<0||tc>=defs.length){skipped++;continue;}
          const cell=cellAt(tr,tc);if(!canWrite(cell)){skipped++;continue;}
          applyValue(cell,clipboardValueForType(matrix[sr][sc],cell.def),batch);
        }
      }
      pushHistory(batch);
      if(batch.length)new Notice(`已粘贴 ${batch.length} 个单元格${skipped?`，跳过 ${skipped} 个不可写/越界单元格`:''}（可 Ctrl/Cmd+Z 撤销）`);
      else new Notice(skipped?'粘贴区域内没有可写入的单元格':'粘贴内容与当前值相同，未发生修改');
    };
    models.forEach((model,r)=>{
      const tr=body.createEl('tr',{cls:`schema-studio-grid-row schema-grid-row-${model.status||'normal'}`});
      if(options.showStatus){const s=tr.createEl('td',{cls:'schema-studio-grid-status'});s.setText(model.status==='added'?'+':model.status==='removed'?'−':model.status==='changed'?'~':'');s.setAttr('title',model.status==='added'?'新增':model.status==='removed'?'源中消失':model.status==='changed'?'有变化':'未变化');}
      defs.forEach((def,c)=>{
        const td=tr.createEl('td',{cls:'schema-studio-grid-cell',attr:{tabindex:'0','data-schema-grid-key':String(model.source?.file?.path||model.key||''),'data-schema-grid-field':def.name}});
        const cell={r,c,td,model,def};state.cells.push(cell);renderCell(cell);
        if(model.readonly?.(def.name)){td.setAttr('title',`${def.name}：结构标识字段，只读`);td.setAttr('aria-readonly','true');}
        td.onmousedown=(e)=>{
          if(e.button!==0)return;
          if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
          state.mouseWasFocused=!!state.focus&&state.focus.r===r&&state.focus.c===c;
          state.mouseMoved=false;state.mouseDown=true;selectCell(r,c,e.shiftKey);
        };
        td.onmouseenter=()=>{if(state.mouseDown){state.mouseMoved=true;state.focus={r,c};refreshSelection();}};
        td.onmouseup=()=>state.mouseDown=false;
        td.onclick=(e)=>{
          if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
          const isBoolean=String(cell.def.type||'').toLowerCase()==='boolean';
          if(!isBoolean&&state.mouseWasFocused&&!state.mouseMoved&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey)beginEdit(cell,undefined,e.clientX);
        };
        td.ondblclick=(e)=>{
          e.preventDefault();
          beginEdit(cell,undefined,e.clientX);
        };
        td.onkeydown=(e)=>{
          if(state.editing)return;
          // Ctrl/Cmd 组合键在单元格聚焦时也要生效（撤销 / 重做 / 全选 / 剪切）。
          // 注意：keydown 事件上的 clipboardData 是 undefined，cut 只能"清空区域"，
          // 剪贴板写入仍由真正的 cut 事件（td.oncut）负责。
          if((e.ctrlKey||e.metaKey)&&!e.altKey){
            const key=String(e.key||'').toLowerCase();
            if(key==='z'){e.preventDefault();e.stopPropagation();if(e.shiftKey)redoEdit();else undoEdit();return;}
            if(key==='y'){e.preventDefault();e.stopPropagation();redoEdit();return;}
            if(key==='a'){e.preventDefault();e.stopPropagation();selectAll();return;}
            if(key==='x'){e.preventDefault();e.stopPropagation();cutSelection(e);return;}
          }
          if(e.key==='Enter'||e.key==='F2'||(e.key===' '&&String(cell.def.type||'').toLowerCase()==='boolean')){e.preventDefault();beginEdit(cell);return;}
          if((e.key==='Delete'||e.key==='Backspace')&&options.editable){e.preventDefault();const rg=getRange();if(!rg)return;const batch=[];for(const cc of state.cells)if(cc.r>=rg.r1&&cc.r<=rg.r2&&cc.c>=rg.c1&&cc.c<=rg.c2&&canWrite(cc)){applyValue(cc,clipboardValueForType('',cc.def),batch);}pushHistory(batch);return;}
          if((e.ctrlKey||e.metaKey)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
            e.preventDefault();const dx=e.key==='ArrowLeft'?-Math.max(180,wrap.clientWidth*.65):e.key==='ArrowRight'?Math.max(180,wrap.clientWidth*.65):0;const dy=e.key==='ArrowUp'?-Math.max(120,wrap.clientHeight*.65):e.key==='ArrowDown'?Math.max(120,wrap.clientHeight*.65):0;wrap.scrollBy({left:dx,top:dy,behavior:'auto'});return;
          }
          const move={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0],Tab:[0,e.shiftKey?-1:1]}[e.key];
          if(move){e.preventDefault();selectCell(Math.max(0,Math.min(models.length-1,r+move[0])),Math.max(0,Math.min(defs.length-1,c+move[1])),e.shiftKey&&e.key!=='Tab',true);return;}
          if(options.editable&&e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();beginEdit(cell,e.key);}
        };
        td.oncopy=copySelection;td.onpaste=pasteSelection;td.oncut=cutSelection;
      });
    });
    wrap.oncopy=copySelection;wrap.onpaste=pasteSelection;wrap.oncut=cutSelection;
    wrap.onmouseleave=()=>{state.mouseDown=false;state.mouseMoved=false;};
    const hint=parentEl.createDiv({cls:'schema-studio-grid-hint schema-tools-muted'});
    hint.setText('点击表头按该列升序，再次点击改为降序，第三次点击清除排序；Shift-点击可追加多列排序。单击选择；双击文本/数值单元格进入编辑并把光标放到点击位置，不会全选；输入后 Enter 确认。Boolean 双击、Enter 或空格直接 true/false 切换。方向键移动单元格焦点；Ctrl/Cmd + 方向键滚动表格窗口。修改会立即显示“旧值删除线 → 新值”，顶部保存编辑提交。拖拽或 Shift 选择区域；Ctrl/Cmd+C 复制；Excel/WPS 区域可直接 Ctrl/Cmd+V 粘贴；Ctrl/Cmd+X 剪切、Ctrl/Cmd+A 全选区域；Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做（编辑、粘贴、剪切、清空、布尔切换均可撤销）。');
    return {wrap,table,state};
  }
  async saveDynamicEdits(rows){
    const allowed=new Set((rows||[]).map(r=>r.file.path));let count=0;
    for(const [filePath,edits] of [...this.pendingEdits.entries()]){if(!allowed.has(filePath)||!edits||!Object.keys(edits).length)continue;const file=this.app.vault.getAbstractFileByPath(filePath);if(!file)continue;await this.app.fileManager.processFrontMatter(file,fm=>{for(const[k,v]of Object.entries(edits))fm[k]=v;});this.pendingEdits.delete(filePath);count++;}
    new Notice(count?`已保存 ${count} 条 Schema 记录`:'没有需要保存的修改');this.render();
  }

  renderApiBrowse(){
    const groups=this.getApiGroups();if(!this.selectedKey&&groups.length)this.selectedKey=groups[0].key;const group=groups.find(x=>x.key===this.selectedKey);if(!group)return this.renderWelcome('接口 Schema','从左侧批量导入 JSON，或选择已有接口查看和编辑字段。');
    const rows=group.rows.filter(r=>!r.schema_orphaned).sort((a,b)=>a.direction.localeCompare(b.direction)||(a.order-b.order)||a.path.localeCompare(b.path));
    this.renderHeader(group.label,group.apiPath||'接口文档',[{text:'保存编辑',onclick:()=>this.saveDynamicEdits(rows)},{text:'JSON 导入 / 更新',primary:true,onclick:()=>{this.page='json-import';this.importState={apiName:group.apiName,apiModule:group.apiModule,direction:'Request',jsonText:'',jsonFiles:[]};this.render();}}]);
    this.mainEl.createDiv({text:'字段列来自 Fileclass 定义；以后在 ApiField Fileclass 中增删属性，Schema Studio 会自动同步。路径/归属等标识字段只读，其他属性可直接编辑。',cls:'schema-tools-callout'});this.renderGenericEditor(rows,'api');
    const orphan=group.rows.filter(r=>r.schema_orphaned);if(orphan.length)this.mainEl.createDiv({text:`另有 ${orphan.length} 个“疑似删除”节点。`,cls:'schema-tools-muted schema-studio-footnote'});
  }
  renderDbBrowse(){
    const groups=this.getDbGroups();if(!this.selectedKey&&groups.length)this.selectedKey=groups[0].key;const group=groups.find(x=>x.key===this.selectedKey);if(!group)return this.renderWelcome('数据库 Schema','批量导入 DDL，或选择已有数据表查看和编辑列。');
    const rows=group.rows.filter(r=>!r.schema_orphaned).sort((a,b)=>(a.order-b.order)||a.name.localeCompare(b.name));
    this.renderHeader(group.label,group.tablePath||'数据库文档',[{text:'保存编辑',onclick:()=>this.saveDynamicEdits(rows)},{text:'DDL 导入 / 更新',primary:true,onclick:()=>{this.page='ddl-import';this.importState={dialect:'oracle',ddlText:'',ddlFiles:[],focusTable:group.label};this.render();}}]);
    this.mainEl.createDiv({text:'字段列来自 DbColumn Fileclass 定义；自定义属性会自动出现并在重导入时保留。',cls:'schema-tools-callout'});this.renderGenericEditor(rows,'db');
  }

  renderPageHeader(title,subtitle=''){this.renderHeader(title,subtitle,[{text:'返回',onclick:()=>{this.page='browse';this.importState=null;this.render();}}]);}
  renderMultiFileChooser(kind,state,key){
    const text=kind==='json'?'选择 JSON / XML 文件（可多选）':kind==='xml'?'选择 xxl-job XML 文件（可多选）':'选择 SQL/DDL 文件（可多选）';
    const accept=kind==='json'?'.json,.xml,application/json,text/xml,application/xml':kind==='xml'?'.xml,text/xml,application/xml':'.sql,.ddl,text/plain,application/sql';
    const row=this.mainEl.createDiv({cls:'schema-studio-source-row'});const label=row.createEl('label',{cls:'schema-studio-file-label'});label.createSpan({text});const input=label.createEl('input',{type:'file',attr:{accept,multiple:'multiple'}});
    input.onchange=async()=>{const files=[...(input.files||[])];const loaded=[];for(const f of files){try{loaded.push({name:f.name,text:await f.text()});}catch(e){new Notice(`读取 ${f.name} 失败：${e.message}`);}}state[key]=loaded;this.render();};
    row.createDiv({text:'可一次选择多个文件',cls:'schema-tools-muted'});if((state[key]||[]).length){const box=this.mainEl.createDiv({cls:'schema-studio-selected-files'});box.createDiv({text:`已选择 ${state[key].length} 个文件`,cls:'schema-tools-label'});for(const f of state[key])box.createDiv({text:f.name,cls:'schema-studio-file-chip'});}
  }

  // --- xxl-job XML 导入：子模块 xxljob-bundle.cjs（由 src/xxljob/ 构建） ---
  xxljobUnavailable(){
    this.renderPageHeader('xxl-job XML 导入','子模块未加载');
    this.mainEl.createDiv({text:'xxl-job 域不可用：没有加载到 xxljob-bundle.cjs。请在本仓库执行 npm install && npm run build:xxljob（./sync.sh to-vault 会自动构建并把 bundle 拷进插件目录），然后重载插件。接口 / 数据库两条链路不受影响。',cls:'schema-tools-callout'});
    // xxlLoadError / xxlLoadLog 带出真实原因与逐步尝试记录（产物缺失 / 路径不对 / 构建失败）
    if(xxlLoadError){
      this.mainEl.createDiv({text:'加载错误',cls:'schema-tools-label'});
      this.mainEl.createDiv({text:xxlLoadError,cls:'schema-studio-file-chip'});
    }
    if(xxlLoadLog && xxlLoadLog.length){
      this.mainEl.createDiv({text:'加载过程',cls:'schema-tools-label'});
      for(const line of xxlLoadLog)this.mainEl.createDiv({text:line,cls:'schema-studio-file-chip'});
    }
  }
  async xxljobTemplates(notify=false){
    const s=xxlSettings(this.plugin);
    const r=await xxl.readTemplates(this.app,{flowTemplate:s.flowTemplate,taskTemplate:s.taskTemplate,componentTemplate:s.componentTemplate},notify);
    return r.templates||{};
  }
  async analyzeXxljob(state){
    if(!state.xmlFiles?.length){new Notice('请先选择 xxl-job 导出的 XML 文件');return;}
    const s=xxlSettings(this.plugin);
    if(state.policy&&state.policy!==s.conflictPolicy){this.plugin.settings.xxljobConflictPolicy=state.policy;await this.plugin.saveSettings();}
    state.templates=await this.xxljobTemplates();
    state.analysis=xxl.buildPlansFromFiles(state.xmlFiles.map(f=>({name:f.name,content:f.text})),{
      docsFolder:s.docsFolder,templates:state.templates,
      executorOfFile:(name)=>state.executorByName?.[name]||'',
    });
    // 读已存在文档，计算属性级改动点：用户手工改过 → 重导入也能看到差异，而不是一句「跳过」
    for(const p of state.analysis.plans){
      p.existing=false;p.changes=[];
      const file=this.app.vault.getAbstractFileByPath(p.path);
      if(file){
        p.existing=true;
        try{p.changes=xxl.diffFrontmatter(await this.app.vault.cachedRead(file),p.content);}
        catch(e){console.warn('[Schema Studio] 读取已存在文档失败',p.path,e);}
      }
    }
    this.page='xxljob-diff';this.render();
  }
  renderXxljobImport(){
    if(!xxl){this.xxljobUnavailable();return;}
    const s=xxlSettings(this.plugin);
    const state=this.importState||{xmlFiles:[],executorByName:{},policy:s.conflictPolicy};this.importState=state;
    this.renderPageHeader('xxl-job XML → 任务文档','从 xxl-job 平台导出的 XML 生成「任务流 / 批任务 / 任务组件」三级文档；归属关系以双链写在正文的「对应任务流 / 对应批任务」章节。');
    this.mainEl.createDiv({text:`文档输出到 ${s.docsFolder}/<执行器>/{${XXL_DIRS.flow},${XXL_DIRS.task},${XXL_DIRS.component}}，内容套用设置里的三份 xxljob 模板；模板里的人工填写项会保留为提示，任务参数只在批任务 frontmatter。`,cls:'schema-tools-callout'});
    this.renderMultiFileChooser('xml',state,'xmlFiles');
    if(!state.xmlFiles.length)return;
    const form=this.mainEl.createDiv({cls:'schema-studio-form'});
    this.mainEl.createDiv({text:'执行器确认',cls:'schema-tools-label'});
    for(const f of state.xmlFiles){
      const parsed=xxl.parseXxlXml(f.text,f.name);
      const groups=(parsed.jobGroups||[]).join('/');
      const guess=xxl.findExecutorByGroup(s.executors,(parsed.jobGroups||[])[0])?.name||xxl.guessExecutorFromFileName(f.name);
      if(!state.executorByName[f.name])state.executorByName[f.name]=guess;
      new Setting(form).setName(f.name).setDesc(`任务 ${parsed.jobs.length} 个${groups?` · jobGroup ${groups}`:''}`)
        .addText(t=>t.setPlaceholder('执行器名称').setValue(state.executorByName[f.name]||'').onChange(v=>{state.executorByName[f.name]=v.trim()||guess;}));
    }
    this.mainEl.createDiv({text:'XML 里只有 jobGroup、没有执行器中文名，确认后会自动回写到执行器清单，下次同分组不再询问。',cls:'schema-tools-muted'});
    new Setting(this.mainEl).setName('重名文档处理').addDropdown(d=>d.addOptions({skip:'跳过（保留现有文档）',update:'更新（保留手写正文）',rename:'新建副本'}).setValue(state.policy||s.conflictPolicy).onChange(v=>{state.policy=v;}));
    const actions=this.mainEl.createDiv({cls:'schema-tools-actions'});
    const analyze=actions.createEl('button',{text:'分析并查看导入清单',cls:'mod-cta'});
    analyze.onclick=()=>{void this.analyzeXxljob(state);};
  }
  renderXxljobDiff(){
    if(!xxl){this.xxljobUnavailable();return;}
    const state=this.importState,res=state?.analysis;
    if(!res){this.page='xxljob-import';return this.render();}
    const policy=state.policy||xxlSettings(this.plugin).conflictPolicy;
    const policyLabel={skip:'跳过',update:'更新',rename:'新建副本'}[policy]||policy;
    // 智能跳过：skip 策略下有属性改动的文档按更新写入，只有完全无改动才真的跳过。
    // 这样「目标状态」与用户预期一致——检测到改动就是更新，而不是一句「跳过（N 处改动）」。
    const planAction=(p)=>{
      if(!this.app.vault.getAbstractFileByPath(p.path))return 'create';
      if(policy==='rename')return 'rename';
      if(policy==='update')return 'update';
      return (p.changes&&p.changes.length)?'update':'skip';
    };
    let willCreate=0,willUpdate=0,willRename=0,willSkip=0;
    for(const p of res.plans){
      const a=planAction(p);
      if(a==='create')willCreate++;else if(a==='update')willUpdate++;else if(a==='rename')willRename++;else willSkip++;
    }
    const smartNote=policy==='skip'?'（策略「跳过」：有属性改动则更新、无改动才跳过）':`（按「${policyLabel}」处理）`;
    this.renderHeader('xxl-job 导入清单',`共 ${res.plans.length} 份：新建 ${willCreate} · 更新 ${willUpdate}${willRename?` · 新建副本 ${willRename}`:''} · 跳过 ${willSkip} ${smartNote}`,[
      {text:'返回修改',onclick:()=>{this.page='xxljob-import';this.render();}},
      {text:'写入文档',primary:true,onclick:()=>{void this.applyXxljob(state);}}
    ]);
    if(res.warnings?.length){const box=this.mainEl.createDiv({cls:'schema-studio-selected-files'});box.createDiv({text:`警告 ${res.warnings.length} 条`,cls:'schema-tools-label'});for(const w of res.warnings.slice(0,20))box.createDiv({text:w,cls:'schema-studio-file-chip'});}
    const wrap=this.mainEl.createDiv({cls:'schema-tools-table-wrap'});const table=wrap.createEl('table',{cls:'schema-tools-table'});
    const hr=table.createEl('thead').createEl('tr');['类型','文档','输出路径','目标状态'].forEach(x=>hr.createEl('th',{text:x}));
    const body=table.createEl('tbody');
    for(const p of res.plans){
      const action=planAction(p),nChanges=p.changes&&p.changes.length||0;
      const status=action==='create'?'新建':action==='rename'?'新建副本':action==='update'?`更新${nChanges?`（${nChanges} 处改动）`:''}`:'跳过';
      const tr=body.createEl('tr',{cls:`schema-status-${action==='create'?'added':action==='update'?'changed':action==='rename'?'changed':'unchanged'}`});
      tr.createEl('td',{text:p.kind});
      tr.createEl('td',{text:p.title});
      tr.createEl('td',{text:p.path,cls:'schema-studio-diff-property'});
      tr.createEl('td',{text:status});
      const preview=body.createEl('tr');const cell=preview.createEl('td',{attr:{colspan:'4'}});
      // 有改动的文档预览默认展开——与数据库域「打开就能看到 diff」的体验一致，
      // 改动键名直接写在 summary 里，不用再展开翻找。
      const changeKeys=(p.changes||[]).map(c=>c.key).join('、');
      const det=cell.createEl('details',nChanges?{attr:{open:''}}:{});
      det.createEl('summary',{text:nChanges?`预览 · 属性改动 ${nChanges} 处：${changeKeys}`:'预览'});
      const host=det.createDiv({cls:'schema-studio-xxl-preview'});
      this.renderMarkdown(host,xxl.frontmatterToMarkdown(p.content,p.changes)||'（无笔记属性）',p.path);
    }
  }
  async applyXxljob(state){
    const s=xxlSettings(this.plugin);
    const policy=state.policy||s.conflictPolicy;
    let outcome;
    // 智能跳过交给 bundle：skip 策略下有属性改动的文档走 update（保留手写正文），无改动才跳过
    try{outcome=await xxl.applyXxljobPlans(this.app,state.analysis.plans,policy,{smartSkip:true});}
    catch(e){console.error('[Schema Studio] xxl-job 导入失败',e);new Notice(`xxl-job 导入失败：${e?.message||e}`);return;}
    let list=s.executors;
    for(const g of state.analysis.jobGroups||[]){
      const name=xxl.sanitizeExecutorDir(state.executorByName?.[g.name]||'');
      if(name)list=xxl.upsertExecutor(list,name,g.groups||[]);
    }
    this.plugin.settings.xxljobExecutors=list;
    this.plugin.settings.xxljobConflictPolicy=policy;
    await this.plugin.saveSettings();
    // 来源信息（原任务 id / 来源 XML / 导入时间）写状态文件，不污染文档正文
    const importedAt=new Date().toISOString(),patch={};
    for(const p of state.analysis.plans){
      const st=outcome.created.includes(p.path)?'created':outcome.updated.includes(p.path)?'updated':outcome.renamed.includes(p.path)?'renamed':'skipped';
      patch[p.path]={kind:p.kind,jobId:p.jobId,sourceFile:p.source?.sourceFile||'',author:p.source?.author||'',importedAt,lastResult:st,orphaned:false};
    }
    await this.plugin.patchXxljobState(patch);
    new Notice(`xxl-job 导入完成：新建 ${outcome.created.length} · 更新 ${outcome.updated.length} · 副本 ${outcome.renamed.length} · 跳过 ${outcome.skipped.length}`);
    this.domain='xxljob';this.selectedKey=null;this.page='browse';this.importState=null;this.render();
  }

  renderJsonImport(){
    // 与 DDL 导入页共用 this.importState：从 DDL 页切过来时状态形状不对（没有接口名/方向键），
    // 直接重建默认值，否则会报「无法确定导入目标」且输入框还是上一页的残留值。
    const cur=this.importState;
    const state=(cur&&cur.jsonFiles)?cur:{apiName:'',direction:'Request',jsonText:'',jsonFiles:[],xmlInferTypes:false,apiModule:'',payloadRoot:'',ignoreTopKeys:''};this.importState=state;this.renderPageHeader('JSON / XML → 接口 Schema','支持 JSON 与 XML 字符串、单文件和批量文件；批量文件按文件名或 __schema 元信息自动路由。');
    this.mainEl.createDiv({text:'批量命名示例：创建订单.Request.json、创建订单-Response.xml。也可以在内容中加入 __schema: { api, direction }（XML 用 <__schema api="创建订单" direction="Request"/> 元素），payload/body/data 作为实际样例。XML 解析：剥离根元素（根只作报文容器）；属性写成 @属性名（如 @id）；同名重复元素自动识别为数组；元素既有属性又有文本时文本记为 _text（不用 #text，避免与 Obsidian 链接锚点冲突）；命名空间前缀保留原样。导入的原始报文会逐字节写进接口文档的「## 请求示例 / ## 响应示例」代码块（文档里没有该章节则不写）。导入器只覆盖可推断的结构属性，Fileclass 中的其他自定义属性会保留。',cls:'schema-tools-callout'});
    this.renderMultiFileChooser('json',state,'jsonFiles');
    const form=this.mainEl.createDiv({cls:'schema-studio-form'});new Setting(form).setName('JSON 字符串的接口名称').setDesc('仅用于下方粘贴的 JSON，或单个无法从文件名识别的文件。').addText(t=>t.setValue(state.apiName||'').onChange(v=>state.apiName=v.trim()));new Setting(form).setName('方向').addDropdown(d=>d.addOptions({Request:'Request',Response:'Response'}).setValue(state.direction||'Request').onChange(v=>state.direction=v));new Setting(form).setName('接口模块').setDesc('决定字段记录的文件名前缀与新建接口文档的目录。本库 5.api 与 6.client 下有同名接口，靠这个区分；选「外部接口」时文档落 6.client 并套 client 模板。').addDropdown(d=>d.addOption('','不区分').addOption(API_MODULES[0],API_MODULES[0]).addOption(API_MODULES[1],API_MODULES[1]).setValue(state.apiModule||'').onChange(v=>{state.apiModule=v;if(v===API_MODULES[0]){if(!state.payloadRoot)state.payloadRoot='body';if(!state.ignoreTopKeys)state.ignoreTopKeys='head';}this.render();}));new Setting(form).setName('业务根节点').setDesc('仅「模块＝内部接口」且内容是 JSON 时生效。内部接口报文形如 { head, body }，填 body 则只取 body 里的字段、路径不带 body. 前缀。留空不处理。').addText(t=>t.setValue(state.payloadRoot||'').onChange(v=>state.payloadRoot=v.trim()));new Setting(form).setName('忽略的顶层节点').setDesc('同上生效条件。没有命中「业务根节点」时，按这里逐项丢弃顶层节点（默认丢弃公共报文头 head），其余整体导入。多个用逗号分隔，留空不处理。').addText(t=>t.setValue(state.ignoreTopKeys||'').onChange(v=>state.ignoreTopKeys=v.trim()));new Setting(form).setName('XML 类型推断').setDesc('默认关闭：XML 里一切都是字符串。打开后 <age>18</age> 会读成数字、<flag>true</flag> 读成布尔 —— 但「0001」这类有前导零的编码会被吞掉前导零，按需开启。').addToggle(t=>t.setValue(!!state.xmlInferTypes).onChange(v=>state.xmlInferTypes=v));
    this.mainEl.createDiv({text:'JSON 字符串（可选）',cls:'schema-tools-label'});const ta=this.mainEl.createEl('textarea',{cls:'schema-tools-textarea',attr:{placeholder:'{\n  "mobile": "13800000000"\n}'}});ta.value=state.jsonText||'';ta.oninput=()=>state.jsonText=ta.value;
    const actions=this.mainEl.createDiv({cls:'schema-tools-actions'});const analyze=actions.createEl('button',{text:'分析全部并查看 Diff',cls:'mod-cta'});analyze.onclick=()=>this.analyzeJson(state);
  }
  buildApiAnalysis(unit){
    // 匹配既有字段：接口名按「剥掉模块前缀」归一化比较（本库 5.api 与 6.client 下有同名接口，
    // 直接比字符串会把另一边整个当成新增）。选了模块就只在同模块内匹配；没选模块则不限，
    // 老用法（不带前缀的历史数据）不受影响。
    const inferred=core.flattenJsonSample(unit.data);const existing=this.plugin.scanApiFields().filter(x=>x.direction===unit.direction&&sameApiName(x.apiName,unit.apiName)&&(!unit.apiModule||!x.apiModule||x.apiModule===unit.apiModule));
    const exMap=new Map(existing.map(x=>[x.path,x]));const defaults=this.plugin.defaultPropertiesForDomain('api');
    const incoming=inferred.map(struct=>{const old=exMap.get(struct.path);const base=old?stripCacheKeys(old.fm):Object.assign({},defaults);for(const [key,value] of Object.entries(Object.assign({},struct,{direction:unit.direction})))setSchemaValue(base,'api',key,value);base.key=struct.path;return base;});
    const existingCanonical=existing.map(x=>Object.assign({key:x.path},canonicalSchemaRecord('api',x.fm)));
    const incomingCanonical=incoming.map(x=>Object.assign({key:x.key},canonicalSchemaRecord('api',x)));
    const diff=core.diffRecords(existingCanonical,incomingCanonical,API_IMPORT_MANAGED_KEYS);return {apiName:unit.apiName,apiModule:unit.apiModule||'',direction:unit.direction,sourceName:unit.filename,sourceFormat:unit.sourceFormat||'json',sample:unit.sample||'',envelope:unit.envelope||null,incoming,existing,diff};
  }
  analyzeJson(state){
    const fb={apiName:state.apiName,direction:state.direction,xmlInferTypes:!!state.xmlInferTypes,apiModule:state.apiModule||'',payloadRoot:state.payloadRoot||'',ignoreTopKeys:state.ignoreTopKeys||''};
    const units=[];const files=state.jsonFiles||[];try{for(const f of files)units.push(extractJsonImportUnit(f.text,f.name,files.length===1?fb:{xmlInferTypes:!!state.xmlInferTypes,apiModule:state.apiModule||'',payloadRoot:state.payloadRoot||'',ignoreTopKeys:state.ignoreTopKeys||''}));if((state.jsonText||'').trim())units.push(extractJsonImportUnit(state.jsonText,'',fb));}catch(e){new Notice(`导入映射失败：${e.message}`);return;}if(!units.length){new Notice('请选择文件或粘贴 JSON / XML 字符串');return;}
    const seen=new Set();for(const u of units){const k=`${u.apiModule}\u0000${u.apiName}\u0000${u.direction}`;if(seen.has(k)){new Notice(`批量导入中目标重复：${u.apiModule?u.apiModule+'-':''}${u.apiName} / ${u.direction}`);return;}seen.add(k);}
    state.analysis=units.map(u=>this.buildApiAnalysis(u));this.page='json-diff';this.render();
  }
  renderDiffDetails(diff){
    const rows=detailedDiffRows(diff);if(!rows.length){this.mainEl.createDiv({text:'没有结构变化。',cls:'schema-tools-muted'});return;}const wrap=this.mainEl.createDiv({cls:'schema-tools-table-wrap schema-studio-diff-table'});const table=wrap.createEl('table',{cls:'schema-tools-table'});const hr=table.createEl('thead').createEl('tr');['状态','字段 / 列','发生变化的属性','修改前','修改后'].forEach(x=>hr.createEl('th',{text:x}));const body=table.createEl('tbody');for(const r of rows){const tr=body.createEl('tr',{cls:`schema-status-${r.status}`});tr.createEl('td',{text:labelStatus(r.status)});tr.createEl('td',{text:r.key});tr.createEl('td',{text:r.property,cls:'schema-studio-diff-property'});tr.createEl('td',{text:diffValue(r.before),cls:'schema-studio-diff-before'});tr.createEl('td',{text:diffValue(r.after),cls:'schema-studio-diff-after'});}
  }
  renderJsonDiff(){
    const state=this.importState,analyses=state?.analysis;if(!analyses){this.page='json-import';return this.render();}
    this.renderHeader('JSON 导入对比','旧值在同一单元格内以删除线显示；新值仍可直接编辑，也支持 Excel / WPS 区域粘贴。',[
      {text:'返回修改导入',onclick:()=>{this.page='json-import';this.render();}},
      {text:'应用全部更新',primary:true,onclick:()=>this.applyJson(state)}
    ]);
    const {defs}=this.getGridDefinitions('api',API_IMPORT_MANAGED_KEYS);
    for(const a of analyses){
      const counts=countStatuses(a.diff);
      this.mainEl.createEl('h3',{text:`${a.apiModule?a.apiModule+'-':''}${stripApiModulePrefix(a.apiName)} / ${a.direction} · ${a.sourceName}`});
      if(a.envelope&&a.envelope.applies&&(a.envelope.root||(a.envelope.dropped||[]).length))this.mainEl.createDiv({text:a.envelope.root?`报文封套：只取顶层「${a.envelope.root}」节点${(a.envelope.dropped||[]).length?`，已丢弃 ${a.envelope.dropped.join('、')}`:''}（字段路径不带该节点名前缀）`:`报文封套：已丢弃顶层 ${a.envelope.dropped.join('、')}`,cls:'schema-tools-muted schema-studio-footnote'});
      this.mainEl.createDiv({text:`新增 ${counts.added} · 属性变化 ${counts.changed} · 未变化 ${counts.unchanged} · 源中消失 ${counts.removed}`,cls:'schema-tools-summary'});
      const byDiff=new Map(a.diff.map(d=>[d.key,d])),byIncoming=new Map(a.incoming.map(r=>[r.key,r]));
      const keys=[...a.incoming.map(r=>r.key),...a.diff.filter(d=>d.status==='removed').map(d=>d.key)];
      const models=keys.map(key=>{
        const d=byDiff.get(key),row=byIncoming.get(key);
        if(d?.status==='removed')return{
          key,status:'removed',
          getValue:(name)=>readSchemaCell(d.before,'api',name),
          getBefore:(name)=>readSchemaCell(d.before,'api',name),
          setValue:()=>{},
          readonly:()=>true
        };
        return{
          key,status:d?.status||'unchanged',
          getValue:(name)=>readSchemaCell(row,'api',name),
          getBefore:(name)=>readSchemaCell(d?.before,'api',name),
          setValue:(name,value)=>{if(row)setSchemaValue(row,'api',name,value);},
          readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name)
        };
      });
      this.renderDataGrid(models,defs,{domain:'api',editable:true,showStatus:true});
    }
  }
  // 把导入的原始报文写进接口文档的占位代码块（Request → ## 请求示例，Response → ## 响应示例）。
  // 文档里没有对应章节或代码块时**不新建** —— 宁可不写，也不往手写文档里凭空插章节。
  async syncDocCodeBlock(docPath,heading,lang,content){
    const file=this.app.vault.getAbstractFileByPath(docPath);
    if(!file||!String(content||'').trim())return false;
    const text=String(await this.app.vault.read(file));
    const next=upsertSectionCodeBlock(text,heading,lang,content);
    if(next===text)return false;
    await this.app.vault.modify(file,next);
    return true;
  }
  async applyOneApiAnalysis(a){
    const now=new Date().toISOString(),folder=normalizePath(this.plugin.settings.apiFieldsFolder);await ensureFolder(this.app,folder);
    // 接口文档优先落在现有字段已指向的位置；只有确实没有可依据的位置时才用设置里的目录。
    const apiDocPath=this.resolveApiDocPath(a);
    await ensureFolder(this.app,apiDocPath.split('/').slice(0,-1).join('/'));
    const apiLink=`[[${apiDocPath.replace(/\.md$/,'')}]]`;
    if(!this.app.vault.getAbstractFileByPath(apiDocPath))await this.app.vault.create(apiDocPath,await this.renderNewApiDoc(a));
    // 导入的原始报文写进「## 请求示例 / ## 响应示例」（文档里没这个章节就不写，不去凭空插章节）
    const sampleHeading=a.direction==='Response'?'响应示例':'请求示例';
    const sampleLang=a.sourceFormat==='xml'?'xml':'json';
    const wroteSample=a.sample?await this.syncDocCodeBlock(apiDocPath,sampleHeading,sampleLang,a.sample):false;
    if(a.sample&&!wroteSample)new Notice(`「${a.apiName}」文档里没有「## ${sampleHeading}」占位代码块，原始报文未写入（字段已正常导入）。`);
    const exMap=new Map(a.existing.map(x=>[x.path,x]));
    // 兜底：按文件路径匹配，避免字段名丢失时把已存在的文档当成新建、因重名抛错中断整批导入
    const exPathMap=new Map(a.existing.map(x=>[normalizePath(x.filePath),x]));
    const className=this.plugin.getFieldDefinitions('api').className;const allowed=this.plugin.fileclassPropertySet('api');const statePatch={};
    for(const r of a.incoming){const old=exMap.get(r.key);let props=stripCacheKeys(r);delete props.key;props.fileClass=props.fileClass||className;purgeSchemaInternalKeys(props);props=stripRecordToFileclass(props,'db',allowed);
      // 已存在的字段文档保留它自己的接口链接，不按设置里的目录改写
      if(!old){setSchemaValue(props,'api','api',apiLink);setSchemaValue(props,'api','direction',a.direction);}
      if(old)dropBlankGuardedValues('api',props,old.fm);
      if(old){await this.app.fileManager.processFrontMatter(old.file,fm=>{Object.assign(fm,props);purgeSchemaInternalKeys(fm);});statePatch[old.filePath]={source:'json-sample',orphaned:false,lastImportedAt:now};}
      else{const path=normalizePath(`${folder}/${core.makeApiFieldFilename(a.apiName,a.direction,r.key)}.md`);
        const byPath=exPathMap.get(path);
        if(byPath){await this.app.fileManager.processFrontMatter(byPath.file,fm=>{Object.assign(fm,props);purgeSchemaInternalKeys(fm);});statePatch[byPath.filePath]={source:'json-sample',orphaned:false,lastImportedAt:now};}
        else{await this.app.vault.create(path,`---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(a.apiName,a.direction,canonicalSchemaRecord('api',props))}`);statePatch[path]={source:'json-sample',orphaned:false,lastImportedAt:now};}}}
    for(const d of a.diff.filter(x=>x.status==='removed')){const old=exMap.get(d.key);if(old){await this.app.fileManager.processFrontMatter(old.file,fm=>{purgeSchemaInternalKeys(fm);});statePatch[old.filePath]={source:'json-sample',orphaned:true,lastImportedAt:now};}}
    await this.plugin.patchSchemaState(statePatch);
  }
  async applyJson(state){for(const a of state.analysis||[])await this.applyOneApiAnalysis(a);new Notice(`已更新 ${state.analysis?.length||0} 个接口方向 Schema`);this.domain='api';this.selectedKey=state.analysis?.[0]?.apiName||null;this.page='browse';this.importState=null;this.render();}

  // 解析「本批要写入哪个表/接口文档」：优先沿用现有字段记录已指向、且确实存在的位置，
  // 避免按设置里的扁平目录改写链接（多 Schema 分子目录的知识库里那会造成断链）。
  resolveDocPathFromRows(rows, domain, name, schema, apiModule) {
    const linkKey = domain === 'api' ? 'api' : 'table';
    for (const row of rows) {
      const link = schemaValue(row.fm, domain, linkKey);
      const target = fmLinkPath(link);
      if (target && this.app.vault.getAbstractFileByPath(`${target}.md`)) return `${target}.md`;
    }
    // 新建时才按设置目录落位：外部接口落 clientDocsFolder，其余落 apiDocsFolder
    const folder = domain === 'api'
      ? (apiModule === API_MODULES[1] ? this.plugin.settings.clientDocsFolder : this.plugin.settings.apiDocsFolder)
      : this.plugin.settings.dbDocsFolder;
    // 接口文档：字段记录的链接可能缺失/过期，但文档其实已存在于某个子目录（本库是 5.api/助贷/）。
    // 在目标目录子树内按剥掉模块前缀后的文档名找一次，避免在根目录多出一份同名副本。
    if (domain === 'api') {
      const prefix = normalizePath(String(folder || '')) + '/';
      const want = stripApiModulePrefix(name);
      if (want) {
        const hit = this.app.vault.getMarkdownFiles().find((f) =>
          f.path.startsWith(prefix) && (f.basename === want || stripApiModulePrefix(f.basename) === want));
        if (hit) return hit.path;
      }
    }
    // 全新的表：DDL 里带 schema 时落到同名子目录（如 CAPITAL → 7.db/capital/），与多 Schema 目录结构一致
    const sub = domain === 'db' && String(schema || '').trim()
      ? normalizePath(`${folder}/${String(schema).trim().toLowerCase()}`)
      : normalizePath(folder);
    return normalizePath(`${sub}/${stripApiModulePrefix(name)}.md`);
  }

  // 新建表文档：按模板生成（表中文名取 DDL 的表注释，数据库Schema / 表名自动填，建表语句放 DDL 原文）
  async renderNewTableDoc(a, ddlText) {
    const fallback = `# ${a.table}\n\n## 字段\n\n![[${this.plugin.settings.dbBaseName}#当前数据表]]\n`;
    const tplPath = normalizePath(String(this.plugin.settings.dbDocTemplate || '').replace(/\.md$/i, ''));
    if (!tplPath) return fallback;
    const file = this.app.vault.getAbstractFileByPath(`${tplPath}.md`);
    if (!file) return fallback;
    let raw = '';
    try { raw = await this.app.vault.read(file); } catch (e) { return fallback; }
    const fm = Object.assign({}, this.app.metadataCache.getFileCache(file)?.frontmatter || {});
    for (const key of Object.keys(fm)) if (FRONTMATTER_INTERNAL_KEYS.has(key)) delete fm[key];
    // 能自动确定的键用真实值覆盖（保持模板原有的键顺序）；其余保留模板里的 {{填写提示}} 作为待填提醒
    fm['表名'] = a.table;
    const schema = String(a.schema || '').trim().toLowerCase();
    if (schema) fm['数据库Schema'] = schema;
    const cnName = String(a.tableComment || '').trim();
    if (cnName) fm['表中文名'] = cnName;
    if (!('是否入仓' in fm)) fm['是否入仓'] = false;
    if (!('是否被抽数' in fm)) fm['是否被抽数'] = false;
    const body = fillTemplatePlaceholders(stripFrontmatterBlock(raw), ddlText);
    return `---\n${stringifyYaml(fm)}---\n\n${body.replace(/^\n+/, '')}`;
  }
  resolveApiDocPath(a) { return this.resolveDocPathFromRows(a.existing, 'api', a.apiName, null, a.apiModule); }
  // 新建接口文档：内部接口 / 外部接口各套自己的仓库模板（章节与属性都不同，
  // `api-接口文档-jiekou` 有幂等 / 分页排序 / 交易状态判断，`client-外部接口-waibu` 有重试 / 路由规则）。
  // 模板缺失、路径为空或读取失败时回退到内置简版，不让一次模板问题中断整批导入。
  apiDocTemplateFor(apiModule) {
    const external = String(apiModule || '').trim() === API_MODULES[1];
    return normalizePath(String((external ? this.plugin.settings.clientDocTemplate : this.plugin.settings.apiDocTemplate) || '').trim());
  }
  async renderNewApiDoc(a) {
    const title = stripApiModulePrefix(a.apiName) || a.apiName;
    // 内置兜底的链接必须带 `_bases/` 前缀 —— 裸 `![[ApiFields.base#…]]` 在本库是死链，
    // 而它会被复制进此后新建的每一份接口文档（对端 v0.7.14 修过同一个坑）。
    const base = `_bases/${this.plugin.settings.apiBaseName || 'ApiFields.base'}`;
    const fence = '```';
    const fallback = `# ${title}\n\n# 请求字段说明\n\n![[${base}#当前接口请求字段]]\n\n## 请求示例\n\n${fence}json\n{}\n${fence}\n\n# 响应字段说明\n\n![[${base}#当前接口响应字段]]\n\n## 响应示例\n\n${fence}json\n{}\n${fence}\n`;
    const tplPath = this.apiDocTemplateFor(a.apiModule);
    if (!tplPath) return fallback;
    const file = this.app.vault.getAbstractFileByPath(/\.md$/i.test(tplPath) ? tplPath : `${tplPath}.md`);
    if (!file) return fallback;
    let raw = '';
    try { raw = await this.app.vault.read(file); } catch (e) { return fallback; }
    const fm = Object.assign({}, this.app.metadataCache.getFileCache(file)?.frontmatter || {});
    for (const key of Object.keys(fm)) if (FRONTMATTER_INTERNAL_KEYS.has(key)) delete fm[key];
    // body 里的 {{:填写提示}} 原样保留 —— 那是给用户的待填提醒，不该被清掉
    const body = fillTemplatePlaceholders(stripFrontmatterBlock(raw), '').replace(/^\n+/, '');
    return Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n\n${body}` : body;
  }
  resolveDbDocPath(a) { return this.resolveDocPathFromRows(a.existing, 'db', a.table, a.schema); }

  renderDdlImport(){
    // 与 JSON 导入页共用 this.importState：切页时若拿到的是另一页的形状，直接重建默认值，互不污染
    // （否则从 JSON 页切过来会带着死掉的 jsonFiles，反之亦然）。
    const cur=this.importState;
    const state=(cur&&cur.ddlFiles)?cur:{dialect:'oracle',ddlText:'',ddlFiles:[],focusTable:''};this.importState=state;this.renderPageHeader('DDL → 数据库 Schema','同一批文件使用同一方言；每个 CREATE TABLE 自动路由到对应表。');const form=this.mainEl.createDiv({cls:'schema-studio-form'});new Setting(form).setName('数据库方言').setDesc(DDL_DIALECTS[state.dialect]?.description||'').addDropdown(d=>{for(const x of Object.values(DDL_DIALECTS))d.addOption(x.id,x.label);d.setValue(state.dialect).onChange(v=>{state.dialect=v;this.render();});});this.renderMultiFileChooser('sql',state,'ddlFiles');
    this.mainEl.createDiv({text:'DDL / SQL 字符串（可选）',cls:'schema-tools-label'});const ta=this.mainEl.createEl('textarea',{cls:'schema-tools-textarea schema-tools-ddl',attr:{placeholder:'create table CAPITAL_LOAN_APPLY\n(\n    ID          NUMBER(19) not null,\n    APPLY_NO    VARCHAR2(64),\n    CREATE_TIME DATE\n);'}});ta.value=state.ddlText||'';ta.oninput=()=>state.ddlText=ta.value;const note=this.mainEl.createDiv({cls:'schema-studio-dialect-note'});note.createDiv({text:`当前适配器：${DDL_DIALECTS[state.dialect].label}`,cls:'schema-studio-dialect-title'});note.createDiv({text:DDL_DIALECTS[state.dialect].description,cls:'schema-tools-muted'});const actions=this.mainEl.createDiv({cls:'schema-tools-actions'});const analyze=actions.createEl('button',{text:'分析全部并查看 Diff',cls:'mod-cta'});analyze.onclick=()=>this.analyzeDdl(state);
  }
  // sql：这份分析对应的原始建表语句。DDL 导入时用于新建表文档时填代码块，
  //      「建表语句 → 字段表」同步时也带着它 —— 落盘管线只认 a.sql，不再依赖 UI 上的 state。
  buildDbAnalysis(table,sourceName,sql){
    const existing=this.plugin.scanDbColumns().filter(x=>x.table===table.table),exMap=new Map(existing.map(x=>[x.name,x])),defaults=this.plugin.defaultPropertiesForDomain('db');
    const incoming=table.columns.map(c=>{const old=exMap.get(c.name);const base=old?stripCacheKeys(old.fm):Object.assign({},defaults);
      const normalized=Object.assign({},c);
      // DDL 注释并入 `说明`（P4）：仅在现有说明为空时填入，不覆盖人工文案；
      // `references` / `order` 属已废弃结构键，不再写入。
      delete normalized.ddl_comment;delete normalized.references;delete normalized.order;
      const comment=String(c.ddl_comment||'').trim();
      if(comment&&!String(schemaValue(base,'db','description')||'').trim())normalized.description=comment;
      for(const [key,value] of Object.entries(normalized))setSchemaValue(base,'db',key,value);
      base.key=c.name;return base;});
    const existingCanonical=existing.map(x=>Object.assign({key:x.name},canonicalSchemaRecord('db',x.fm)));
    const incomingCanonical=incoming.map(x=>Object.assign({key:x.key},canonicalSchemaRecord('db',x)));
    const diff=core.diffRecords(existingCanonical,incomingCanonical,DB_IMPORT_MANAGED_KEYS);return {table:table.table,schema:table.schema||'',tableComment:table.table_comment||'',sourceName,sql:String(sql||''),incoming,existing,diff};
  }
  analyzeDdl(state){
    const sources=[...(state.ddlFiles||[])];if((state.ddlText||'').trim())sources.push({name:'DDL 字符串',text:state.ddlText});if(!sources.length){new Notice('请选择 DDL 文件或粘贴 SQL');return;}const analyses=[];const seen=new Set();try{for(const source of sources){const parsed=parseDdlWithDialect(source.text,state.dialect);for(const t of parsed){const key=t.table.toLowerCase();if(seen.has(key))throw new Error(`同一批次重复定义表：${t.table}`);seen.add(key);
      // 按表切片：一份脚本里多张表各归各的文档，ORDER_ITEMS 的内容不会跑到 ORDERS 里。
      // 切片 = 该表 CREATE TABLE + 该表 COMMENT ON + 该表 CREATE INDEX（原样保留结束符）。
      // 切不出来（写法超出识别范围）时退回整份文本，总好过写一个空代码块。
      const sliced=core.extractTableDdlText(source.text,t.table)||source.text;
      analyses.push(this.buildDbAnalysis(t,source.name,sliced));}}}catch(e){new Notice(`DDL 解析失败：${e.message}`);return;}if(!analyses.length){new Notice(`没有识别到 ${DDL_DIALECTS[state.dialect].label} CREATE TABLE`);return;}state.analysis=analyses;this.page='ddl-diff';this.render();
  }
  renderDdlDiff(){
    const state=this.importState,analyses=state?.analysis;if(!analyses){this.page='ddl-import';return this.render();}
    this.renderHeader(`${DDL_DIALECTS[state.dialect].label} DDL 导入对比`,'变化直接显示在字段表单元格中：删除线为旧值，后面的值为本次导入结果。',[
      {text:'返回修改导入',onclick:()=>{this.page='ddl-import';this.render();}},
      {text:'应用全部更新',primary:true,onclick:()=>this.applyDdl(state)}
    ]);
    const {defs}=this.getGridDefinitions('db',DB_IMPORT_MANAGED_KEYS);
    for(const a of analyses){
      const counts=countStatuses(a.diff);
      this.mainEl.createEl('h3',{text:`${a.table} · ${a.sourceName}`});
      this.mainEl.createDiv({text:`新增 ${counts.added} · 属性变化 ${counts.changed} · 未变化 ${counts.unchanged} · DDL 中消失 ${counts.removed}`,cls:'schema-tools-summary'});
      const byDiff=new Map(a.diff.map(d=>[d.key,d])),byIncoming=new Map(a.incoming.map(r=>[r.key,r]));
      const keys=[...a.incoming.map(r=>r.key),...a.diff.filter(d=>d.status==='removed').map(d=>d.key)];
      const models=keys.map(key=>{
        const d=byDiff.get(key),row=byIncoming.get(key);
        if(d?.status==='removed')return{
          key,status:'removed',
          getValue:(name)=>readSchemaCell(d.before,'db',name),
          getBefore:(name)=>readSchemaCell(d.before,'db',name),
          setValue:()=>{},
          readonly:()=>true
        };
        return{
          key,status:d?.status||'unchanged',
          getValue:(name)=>readSchemaCell(row,'db',name),
          getBefore:(name)=>readSchemaCell(d?.before,'db',name),
          setValue:(name,value)=>{if(row)setSchemaValue(row,'db',name,value);},
          readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name)
        };
      });
      this.renderDataGrid(models,defs,{domain:'db',editable:true,showStatus:true});
    }
  }
  // 单表落盘：把一份 buildDbAnalysis 的结果写进字段记录目录（新建 / 更新 / 标记删除）。
  // DDL 导入与「建表语句 → 字段表」同步共用这一条管线 —— 两条路径的产物必须完全一致，
  // 否则同一个库会出现「导入进来的字段」与「同步生成的字段」长得不一样。
  // options: { now, dialect, tableDocPath, createDocIfMissing, statePatch }
  async applyDbAnalysis(a,options={}){
    const now=options.now||new Date().toISOString(),dialect=options.dialect||'mysql';
    await ensureFolder(this.app,this.plugin.settings.dbColumnsFolder);const className=this.plugin.getFieldDefinitions('db').className;const allowed=this.plugin.fileclassPropertySet('db');
    const statePatch=options.statePatch||{},counts={created:0,updated:0,repaired:0,restored:0,orphaned:0,ddlsynced:0};
    const exMap=new Map(a.existing.map(x=>[x.name,x]));
    // 兜底：按文件路径匹配。字段名被清空/改名后按名字会匹配不上，直接走新建会撞上已存在的文件。
    const exPathMap=new Map(a.existing.map(x=>[normalizePath(x.filePath),x]));
    // 表文档优先落在现有列文件已指向且确实存在的位置；只有确实无从判断时才用设置目录。
    const tableDocPath=options.tableDocPath||this.resolveDbDocPath(a);
    await ensureFolder(this.app,tableDocPath.split('/').slice(0,-1).join('/'));
    const tableLink=`[[${tableDocPath.replace(/\.md$/,'')}]]`;
    // 新建的表文档按模板生成（表中文名取 DDL 的表注释、数据库Schema、表名、建表语句自动填）
    if(options.createDocIfMissing!==false&&!this.app.vault.getAbstractFileByPath(tableDocPath))await this.app.vault.create(tableDocPath,await this.renderNewTableDoc(a,a.sql||''));
    // 把本次导入的 DDL（按表切片后的建表 + 该表注释 + 该表索引）同步进表文档的「## 建表语句」代码块。
    // 既有表文档同样替换该代码块（幂等，不会越堆越多）—— 否则重新导入一份改过的 DDL 时，
    // 文档里还是旧 SQL，反向同步开着的话会把旧结构又推回字段表，等于白导。
    if(options.writeDocBlock!==false){
      const ddlText=String(a.sql||'');
      if(ddlText.trim()){
        const docFile=this.app.vault.getAbstractFileByPath(tableDocPath);
        if(docFile){
          const docText=String(await this.app.vault.read(docFile));
          const next=upsertSectionCodeBlock(docText,'建表语句','sql',ddlText);
          if(next!==docText){await this.app.vault.modify(docFile,next);this.plugin.markDocSelfWrite(tableDocPath,next);counts.ddlsynced++;}
        }
      }
    }
    for(const r of a.incoming){const old=exMap.get(r.key);let props=stripCacheKeys(r);delete props.key;props.fileClass=props.fileClass||className;purgeSchemaInternalKeys(props);props=stripRecordToFileclass(props,'api',allowed);
      // 已存在的列文件保留它自己的 `数据表` 链接，不按设置里的目录改写
      if(!old)setSchemaValue(props,'db','table',tableLink);
      if(!r.default_value)for(const key of schemaKeyCandidates('db','default_value'))delete props[key];
      // 导入值缺失时保留文件里已有的 字段名/数据类型，绝不写空
      const isBlank=(v)=>v===undefined||v===null||String(v).trim()==='';
      if(old){const wasBlank=isBlank(schemaValue(props,'db','name'))||isBlank(schemaValue(props,'db','data_type'));dropBlankGuardedValues('db',props,old.fm);if(wasBlank&&!isBlank(schemaValue(props,'db','name'))&&!isBlank(schemaValue(props,'db','data_type')))counts.repaired++;}
      const wasOrphaned=old?this.plugin.isSchemaOrphaned(old.filePath):false;
      if(old){await this.app.fileManager.processFrontMatter(old.file,fm=>{Object.assign(fm,props);purgeSchemaInternalKeys(fm);if(!r.default_value)for(const key of schemaKeyCandidates('db','default_value'))delete fm[key];});statePatch[old.filePath]={source:'ddl',dialect,orphaned:false,lastImportedAt:now};counts.updated++;if(wasOrphaned)counts.restored++;}
      else{const path=normalizePath(`${this.plugin.settings.dbColumnsFolder}/${core.makeDbColumnFilename(a.table,r.key)}.md`);
        // 名字没匹配上、但该文件确实存在时，按路径更新它，而不是新建（新建会因重名直接抛错中断整批导入）
        const byPath=exPathMap.get(path);
        if(byPath){dropBlankGuardedValues('db',props,byPath.fm);await this.app.fileManager.processFrontMatter(byPath.file,fm=>{Object.assign(fm,props);purgeSchemaInternalKeys(fm);if(!r.default_value)for(const key of schemaKeyCandidates('db','default_value'))delete fm[key];});statePatch[byPath.filePath]={source:'ddl',dialect,orphaned:false,lastImportedAt:now};counts.updated++;if(this.plugin.isSchemaOrphaned(byPath.filePath))counts.restored++;}
        else{await this.app.vault.create(path,`---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(a.table,canonicalSchemaRecord('db',props),tableDocPath)}`);statePatch[path]={source:'ddl',dialect,orphaned:false,lastImportedAt:now};counts.created++;}}}
    for(const d of a.diff.filter(x=>x.status==='removed')){const old=exMap.get(d.key);if(old){await this.app.fileManager.processFrontMatter(old.file,fm=>{purgeSchemaInternalKeys(fm);});statePatch[old.filePath]={source:'ddl',dialect,orphaned:true,lastImportedAt:now};if(!this.plugin.isSchemaOrphaned(old.filePath))counts.orphaned++;}}
    await this.plugin.patchSchemaState(statePatch);
    return counts;
  }
  async applyDdl(state){
    const now=new Date().toISOString(),statePatch={},summary=[];
    for(const a of state.analysis){
      try{
        const r=await this.applyDbAnalysis(a,{now,dialect:state.dialect,statePatch});
        const parts=[`新增 ${r.created}`,`更新 ${r.updated}`];
        if(r.repaired)parts.push(`补写字段名 ${r.repaired}`);
        if(r.restored)parts.push(`恢复 ${r.restored}`);
        if(r.orphaned)parts.push(`标记删除 ${r.orphaned}`);
        if(r.ddlsynced)parts.push('建表语句已同步');
        summary.push(`${a.table}：${parts.join(' · ')}`);
      }catch(e){
        console.error('[Schema Studio] 应用 DDL 失败：',a&&a.table,e);
        new Notice(`表 ${(a&&a.table)||''} 应用失败：${(e&&e.message)||e}`);
      }
    }
    new Notice(`DDL 导入完成：${summary.length?summary.join('；'):'无变更'}`);this.domain='db';this.selectedKey=state.focusTable||state.analysis?.[0]?.table||null;this.page='browse';this.importState=null;this.render();
  }
  // ★ 反向同步：读表文档「## 建表语句」里的 SQL → 解析成列 → 写回字段记录文件。
  //   与 DDL 导入共用 buildDbAnalysis + applyDbAnalysis，两边产物必须一致。
  //   返回值：{ok:false,reason} 表示没同步；{ok:true,noop:true} 表示本来一致。
  async syncTableDocToFields(docPath,options={}){
    const path=normalizePath(docPath);
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!file)return {ok:false,reason:'not-found'};
    const text=String(await this.app.vault.read(file));
    // 文档还是插件自己刚写的那一版（只可能是「字段表 → 建表语句」刚回写过）→ 没有用户新意图，跳过。
    // 不抑制的话两个方向会互相触发：字段改 → 改 SQL → 又同步回字段。
    if(this.plugin.isDocSelfWrite&&this.plugin.isDocSelfWrite(path,text))return {ok:false,reason:'self-write'};
    const sql=readSectionCodeBlock(text,'建表语句');
    // 占位注释（`-- 待补充`）与空代码块不算 DDL
    if(!sql.trim()||!/create\s+table/i.test(sql))return {ok:false,reason:'no-sql'};
    // 本库约定：表文档名 ＝ 表名。多表粘贴时优先取与文档同名的那张，找不到才退回第一张。
    const docTable = basenameNoExt(path);
    const wanted=String(options.dialect||this.plugin.settings.autoSyncDialect||'auto');
    const dialectId=(wanted==='auto'||!DDL_DIALECTS[wanted])?detectDdlDialect(sql):wanted;
    let parsed=[];
    try{parsed=parseDdlWithDialect(sql,dialectId);}
    catch(e){return {ok:false,reason:'parse-error',message:e.message};}
    if(!parsed.length)return {ok:false,reason:'parse-error',message:`未识别到 ${DDL_DIALECTS[dialectId].label} 的 CREATE TABLE`};
    const hit=parsed.find(t=>String(t.table||'').toLowerCase()===docTable.toLowerCase())||parsed[0];
    const a=this.buildDbAnalysis(hit,basenameNoExt(path)+'.md',sql);
    const counts=countStatuses(a.diff);
    // 安全闸：SQL 只敲了一半（列还没写完）时会出现「大量列消失」，这时不落盘，
    // 避免把整表列误标成疑似删除。删一列以内仍然实时生效。
    const maxDrop=Math.max(1,Math.floor(a.existing.length*0.5));
    if(counts.removed>maxDrop)return {ok:false,reason:'too-many-removed',table:a.table,counts,removed:counts.removed,existing:a.existing.length};
    // 「疑似删除」账本不在 diff 里，所以"零差异"不等于"无事可做"：
    // 用户把删掉的列又加回 SQL 后，列文件与 DDL 已完全一致，但仍挂着上一次的删除标记，
    // 这里必须继续走一遍落盘，让 applyDbAnalysis 把它解除（restored）。
    const staleLedger=a.existing.some(x=>this.plugin.isSchemaOrphaned(x.filePath));
    if(!counts.added&&!counts.changed&&!counts.removed&&!staleLedger)return {ok:true,noop:true,table:a.table,counts};
    const r=await this.applyDbAnalysis(a,{tableDocPath:path,dialect:dialectId,createDocIfMissing:false,writeDocBlock:false});
    return {ok:true,table:a.table,counts,result:r};
  }
}

class SchemaStudioUnsavedModal extends Modal {
  constructor(app,studio){super(app);this.studio=studio;this.busy=false;}
  onOpen(){
    this.modalEl.addClass('schema-studio-unsaved-modal');this.contentEl.empty();
    this.contentEl.createEl('h2',{text:'有未保存的修改'});
    this.contentEl.createDiv({text:this.studio.unsavedSummary(),cls:'schema-studio-unsaved-summary'});
    this.contentEl.createDiv({text:'保存后关闭，或放弃这些修改。Esc 取消关闭并返回 Schema Studio。',cls:'schema-tools-muted'});
    const actions=this.contentEl.createDiv({cls:'schema-studio-unsaved-actions'});
    const cancel=actions.createEl('button',{text:'取消  Esc'});
    const discard=actions.createEl('button',{text:'不保存'});
    const save=actions.createEl('button',{text:'保存并关闭  ↵',cls:'mod-cta'});
    const doSave=async()=>{if(this.busy)return;this.busy=true;save.disabled=discard.disabled=cancel.disabled=true;this.close();await this.studio.saveDirtyAndClose();};
    cancel.onclick=()=>this.close();
    discard.onclick=()=>{if(this.busy)return;this.close();this.studio.discardDirtyAndClose();};
    save.onclick=doSave;
    this.modalEl.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'&&!e.shiftKey&&!e.altKey){e.preventDefault();e.stopPropagation();doSave();return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();doSave();}
    },true);
    requestAnimationFrame(()=>save.focus());
  }
  onClose(){this.studio._closePromptOpen=false;this.contentEl.empty();}
}

function countStatuses(diff){const c={added:0,changed:0,unchanged:0,removed:0};for(const d of diff)c[d.status]=(c[d.status]||0)+1;return c;}
function labelStatus(s){return {added:'新增',changed:'变化',unchanged:'未变',removed:'消失'}[s]||s;}
function changeSummary(d){if(!d||d.status!=='changed')return '';return '变更：'+d.changes.map(k=>`${k} ${JSON.stringify(d.before?.[k]??'')} → ${JSON.stringify(d.after?.[k]??'')}`).join('；');}

SchemaToolsPlugin._test = { core, DDL_DIALECTS, DEFAULTS, xxlLoaded: () => !!xxl, xxlBoot: bootXxl, xxlAbsDir: xxlAbsolutePluginDir, xxlLog: () => xxlLoadLog, XXL_DIRS, XXL_CLASS_BY_LEVEL, XXL_STATE_FILENAME, xxlSettings, xxlStatePathFor, parseDdlWithDialect, parseMySqlDdl, parseOracleDdl, parseJsonFilenameTarget, extractJsonImportUnit, detailedDiffRows, normalizeDirection, parseClipboardTable, clipboardValueForType, displayGridValue, valuesEqual, schemaValue, setSchemaValue, canonicalSchemaRecord, buildDemoFilePlan, demoPaths, SchemaStudioModal, SchemaStudioUnsavedModal, DemoInstallModal, DemoRestoreModal, SCHEMA_INTERNAL_KEYS, SCHEMA_STATE_KEY_NAMES, SCHEMA_DEPRECATED_KEY_NAMES, SCHEMA_GUARDED_KEYS, dropBlankGuardedValues, memberNameFromFilename, API_IMPORT_MANAGED_KEYS, DB_IMPORT_MANAGED_KEYS, purgeSchemaInternalKeys, schemaStatePathFor, stripCacheKeys, schemaKeyCandidates, readSchemaCell, API_MODULES, stripApiModulePrefix, applyApiModulePrefix, sameApiName, apiModuleFromFilename, splitNameList, selectImportPayload, decodeXmlEntities, parseXmlToTree, parseXmlPayload, xmlNodeToValue, normalizeXmlScalar, looksLikeXmlText, escapeRe, upsertSectionCodeBlock, readSectionCodeBlock, detectDdlDialect, splitTopLevelRanges, scanCreateTable, renderColumnDef, buildDdlFromColumns };
module.exports = SchemaToolsPlugin;
