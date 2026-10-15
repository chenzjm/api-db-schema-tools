# 接口与数据库结构工具 v0.9.0

Schema Studio 用于维护接口字段和数据库字段。底层仍然是普通 Markdown、YAML Frontmatter 和 Wikilink；Fileclass 提供属性定义，Schema Tools 负责 JSON/DDL 导入、字段管理和精准引用。本仓库的接口字段属性名称统一使用中文，接口协议里的字段名、路径和类型保留原始写法。

默认目录：接口文档为 `5.api/`，数据库文档为 `7.db/`，接口字段为 `_data/api-fields/`，数据库字段为 `_data/db-columns/`，总览视图为 `_bases/`。

迁移兼容：插件仍可读取历史英文属性；新建、保存和重新导入接口字段时，会统一写入中文属性。`ApiField`、`DbColumn` 是插件识别用的技术类名，不是团队需要记忆的业务字段名称。

## v0.9.0：新增 xxl-job 域（XML → 任务流 / 批任务 / 任务组件）

侧栏的域页签由「接口 / 数据库」扩为 **「接口 / 数据库 / xxl-job」**。第三个域用来把 xxl-job 平台导出的 XML
生成三级文档，遵守本插件的界面风格与运行机制（同一套 shell / header / 表格 / 设置页）。

### 1. 文档结构

导入输出在 `<文档根目录>/<执行器>/{任务流,任务,任务组件}`（默认根目录 `8.xxljob`）：

| 层级 | fileClass | 说明 |
|---|---|---|
| 任务流 | `任务流` | 链路入口，`jobLevelType = MAIN_TRIGGER_JOB` |
| 批任务 | `批任务` | 编排节点，`VIRTUAL_JOB` |
| 任务组件 | `任务组件` | 实际执行单元，`COMPONENT_JOB` |

- frontmatter 严格沿用模板的键顺序；能推断的填真实值，推断不了的**保留模板里的 `{{填写提示}}`**。
- 正文套用设置里的三份模板：占位简述与示例 mermaid 会被替换成真实内容，其余章节原样保留。
- **归属关系写在正文**：批任务有 `# 对应任务流`、任务组件有 `# 对应批任务`，内容是
  `[[8.xxljob/<执行器>/<层级>/<名称>|<名称>]]` 双链；章节排在 `# 任务说明` 之前。fileClass 里
  不再有 `对应任务流名称` / `对应批任务名称` 两个字段。
- 调度状态一律写「停止」；任务参数只在批任务 frontmatter，正文不展开。

### 2. 导入流程

侧栏「+ 导入 xxl-job XML」→ 选 XML（可多选）→ 确认执行器（XML 里只有 `jobGroup` 编号，
靠设置里的执行器清单匹配，确认后自动回写）→ 查看导入清单（类型 / 文档 / 路径 / 目标状态 + 预览）→ 写入。

重名策略沿用本插件的三档：**跳过 / 更新（保留手写正文）/ 新建副本**。
「更新」= frontmatter 整体替换（废弃键自动清除）+ 归属章节刷新 + 其余手写正文原样保留。

### 3. 状态文件

来源信息（原任务 id、来源 XML、导入时间）写入 `<文档根目录>/.xxljob-state.json`，
与数据库域的 `_data/.schema-state.json` 分开，互不污染，也不写进业务文档正文。

### 4. 子模块依赖

xxl-job 的实现来自独立仓库 [`xxljob-flow-atlas`](https://github.com/chenzjm/xxljob-flow-atlas)
（TypeScript + esbuild + 测试）。它以 `xxljob-bundle.cjs` 的形式被本插件 `require`：

```js
let xxl = null;
try { xxl = require('./xxljob-bundle.cjs'); } catch (e) { /* 降级：xxl-job 域不可用 */ }
```

**没拷进来时整个 xxl-job 域自动隐藏为不可用，接口 / 数据库两条链路不受影响。**
在 `xxljob-flow-atlas` 仓库执行 `./sync.sh to-vault` 会把 bundle 同步到本仓库与 vault 插件目录；
本仓库的 `sync.sh` 也已把 `xxljob-bundle.cjs` 列入部署文件。

## v0.8.2：新建表文档按模板生成（含 schema 子目录与表注释）

新增表（DDL 导入新建、或在界面手工新建）时，表文档不再是一个最小空壳，而是套用可配置的模板。

### 1. 表文档模板

新增设置项 **「新建表文档的模板」**（`dbDocTemplate`，默认 `_template/业务模板/db-数据库-shuju/db-数据库-shuju.md`）。
生成时自动填充模板里的：

| 模板字段 | 取值 |
|---|---|
| `表名` | CREATE TABLE 的表名（自动去掉 schema 前缀与引号） |
| `数据库Schema` | DDL 里的 schema，如 `"CAPITAL"` → `capital` |
| `表中文名` | `COMMENT ON TABLE ... IS '...'` 的表注释 |
| `建表语句` 代码块 | DDL 原文 |

模板里其余的 `{{...}}` 填写提示原样保留，作为人工填写提醒。模板文件不存在时回退到内置的最小结构。

### 2. 新增表注释与 schema 解析

- 新增 `applyTableComments()`：解析 `COMMENT ON TABLE <schema.>?<table> IS '...'`（表中文名的来源）。
- `CREATE TABLE` 支持 schema 限定名 `"CAPITAL"."ACCOUNT_FILE_FLAG"`，解析后同时记录 schema。
- 全部为新建表时，表文档落到同名 schema 子目录（如 `7.db/capital/ACCOUNT_FILE_FLAG.md`），
  与多 Schema 的目录结构一致，不再丢在 `7.db/` 根目录。

### 3. 其他

- 数据类型归一补上逗号后的空格：`NUMBER(10,0)` → `NUMBER(10, 0)`。
- 新建的列文件正文「所属表」使用完整路径链接（`[[7.db/capital/X|X]]`），与既有文件一致。

## v0.8.1：导入不再因文件损坏而中断，类型解析不再混入约束尾巴

修复真实导入中暴露的三类问题。

### 1. 字段名被清空后导入会中断（已修）

`字段名` 缺失时，插件原本直接用**整个文件名**兜底（如 `CAPITAL_INSURANCE_PRE_APPLY__CERT_TYPE`），
与 DDL 里的列名 `CERT_TYPE` 匹配不上 → 该列被当成新字段 → 走新建分支撞上已存在的文件 →
抛错中断，整批导入无法应用。

- 新增 `memberNameFromFilename()`：从文件名还原字段名时剥掉「`<表名>__`」前缀（API 侧再剥「`<方向>__`」）
- 应用更新时增加**按文件路径兜底匹配**：名字匹配不上、但文件确实存在时改为更新它，不再新建
- 新增 `SCHEMA_GUARDED_KEYS`：`字段名` / `数据类型` / `字段路径` 在导入值缺失时**保留文件里已有的值**，绝不写空

### 2. 数据类型混入 constraint 尾巴（已修）

Oracle 导出的命名式 check 约束写在下一行：

```sql
CREATE_TIME DATE
    constraint SYS_C0050516
        check ("CREATE_TIME" IS NOT NULL),
```

列类型截断的关键字列表原先没有 `CONSTRAINT`，会把约束一起吃进类型
（解析出 `"DATE constraint SYS_C0050516"`）。现已补上，`CREATE_TIME` 正确解析为 `DATE`（且非空）。

### 3. 回归测试扩充

新增场景 8 / 9 / 10：字段名被清空仍能匹配回填、导入值缺失不写空、两种方言下类型都不含约束尾巴。

## v0.8.0：导入不再污染业务文档

这一版针对「字段定义只收录具有业务与设计语义的属性」做了改造：工具运行态元数据不再寄生在字段文档上，DDL / JSON 导入也不再按设置里的目录改写链接。

### 1. 运行态状态迁出 frontmatter

`来源方式` / `方言` / `疑似删除` / `最后导入时间`（`schema_source` / `schema_dialect` / `schema_orphaned` / `last_imported_at`）不再写入字段文档，改由中心化状态文件承载：

```
<字段记录目录的上级>/.schema-state.json      # 默认 _data/.schema-state.json
```

```json
{
  "version": 1,
  "updatedAt": "2026-10-15T00:00:00.000Z",
  "records": {
    "_data/db-columns/表名__列名.md": {
      "source": "ddl", "dialect": "oracle", "orphaned": false, "lastImportedAt": "..."
    }
  }
}
```

- 「疑似删除」改由状态文件判断，不再依赖文档里的 `疑似删除` 属性，也不会被人手误改影响判断。
- 状态文件可随 git 追踪，团队共享同一份 diff 状态。若不想入库，加进 `.gitignore` 即可。

### 2. 废弃属性不再写入

`引用`（`references`）、`顺序`（`order`）已从字段定义移除，导入与新建都不再写入；发现历史遗留的 `引用` / `顺序` / `schema_*` / `ddl_comment` 等键时，会在**下一次导入时顺带清理掉**。

### 3. DDL 列注释并入「说明」

DDL 的 `COMMENT ON COLUMN` 不再单独存 `ddl_comment`，而是并入 `说明`：

- **已有非空 `说明` 的列不会被覆盖**（人工润色的文案优先）；
- 只有 `说明` 为空 / 空白时才用 DDL 注释补齐。

### 4. 表 / 接口文档链接不再被改写

导入时优先沿用**现有字段记录已指向且确实存在**的表文档 / 接口文档位置；只有全新对象才落到设置里的文档目录。这样多 Schema 分子目录的知识库（如 `7.db/capital/`、`5.api/助贷/`）不会再被按扁平目录改写链接、也不会在目录根部多出一份空文档。

### 5. 修复：中文键知识库下导入无法应用

`applyDdl` / `applyOneApiAnalysis` 与两个 Diff 表格此前用 `r.name` / `r.path` 取值，而中文键知识库里这些值存在 `字段名` / `字段路径` 上，取到的是 `undefined`，导致：

- 「分析全部并查看 Diff」只有一行、且行键是 `undefined`；
- 「应用全部更新」对每一列都走「新建文件」分支，实际会先写一个 `<表名>__field.md` 然后报错中断。

现在统一以规范字段名（`key`）作为行标识，并让表格读值走同一套中英别名解析，Diff 也不会再出现「值 → 空」的假差异。

### 6. 其他

- Diff 表格不再为中英双份属性各显示一列。
- 体验样例生成器不再写入 `已复核` / `顺序` / `疑似删除` / `引用`。

## v0.6.3：中文文档分类与同名接口隔离

- 专用业务文档只依靠 `fileClass` 识别；“文档类型”仅用于通用 `fileClass: 文档`。
- 同名但路径不同的接口按完整文档路径分组，新增字段文件也按接口路径生成，避免相互覆盖。
- JSON 导入可以沿用当前接口文档路径，迁移和更新时不会误写入同名接口。

## v0.6.2：Esc 分层与未保存保护

- 单元格正在编辑时，第一次 Escape **只取消当前单元格编辑**，不会关闭 Schema Studio。
- 没有活动编辑器但存在 pending edits 时，Escape 或右上角 X 会显示未保存提示。
- 未保存提示提供 **保存并关闭 / 不保存 / 取消**；Enter 或 Ctrl/Cmd+S 保存并关闭，Escape 取消关闭。
- Schema Studio 浏览页支持 Ctrl/Cmd+S 直接保存当前 pending edits。
- 所有关闭入口统一走 dirty guard，避免通过 Modal 原生 Escape 绕过保存检查。

## v0.6.1：单元格编辑键盘修复

- Enter：直接提交当前单元格编辑并退出编辑态。
- Escape：只取消当前单元格编辑并恢复旧值，不关闭 Schema Studio。
- Tab：提交当前单元格后移动到相邻单元格。
- 修复 Escape 取消后被 blur 事件再次提交的竞态。

## v0.6.0：字段视图更接近 Bases / Fileclass

字段表上方新增视图工具栏：

- **排序**：支持多条排序规则和升/降序。
- **筛选**：支持按任意动态属性做包含、等于、不等于、开头是、为空、不为空筛选；多个条件按 AND 处理。
- **属性**：按 Fileclass 动态字段配置当前显示哪些列，配置会保存。
- **搜索**：在当前 Schema 表内全文搜索。
- **新建**：当前接口下新建字段，或当前数据库表下新建列。

Fileclass 中后续新增的业务属性仍会自动出现在“属性”列表中，不需要修改插件代码。

## 表格编辑交互

- 单击选择单元格。
- 双击文本/数字单元格进入编辑；**不会全选原内容**，光标会尽量放在双击位置。
- 输入完成后按 **Enter** 确认。
- Boolean 不进入 checkbox 编辑器：双击 / Enter / 空格直接 `true ↔ false`。
- 非编辑状态：方向键移动单元格焦点，并自动把焦点单元格滚动到可见区域。
- `Ctrl/Cmd + ←/→/↑/↓`：只滚动表格窗口，不改变当前单元格焦点。
- 手工编辑与 JSON/DDL 导入共用相同 Pending Change 机制：修改后立即显示 `~~旧值~~ → 新值`，点击顶部“保存编辑”一次提交。

## Excel / WPS

支持矩形区域 TSV 复制粘贴：

1. Excel/WPS 复制一块区域。
2. Schema Studio 选中目标左上角单元格。
3. Ctrl/Cmd+V。

支持 CRLF、Tab、带引号的多行单元格，以及布尔值 `true/false`、`是/否`、`1/0`、`✓`。

如果复制内容带有 Fileclass 属性名表头，会按表头名映射，不要求列顺序一致。

## JSON / DDL 导入

- JSON 字符串、单文件、多文件批量导入。
- 文件名或 `__schema` / `_schema` 元信息自动路由到接口和 Request/Response。
- MySQL、Oracle DDL adapter；后续方言通过 adapter 扩展。
- 导入 Diff 直接显示在同一字段 Grid 中：旧值删除线 + 新值。
- 源中消失的字段仅标记为“疑似删除”（内部兼容键为 `schema_orphaned`），不直接删除 Markdown 文件。

## 精准引用

输入：

```text
[[@
```

进入接口 / 数据库的逐层联想；普通 `[[` 继续交给 Obsidian 原生 Wikilink。

## Fileclass 前置配置

如果使用 Demo 的目录结构，请在 Fileclass 设置里将 **Class files folder** 指向：

```text
_fileclasses
```

否则 Fileclass 的 Base 视图只能显示值，无法识别 typed fields 和提供单元格编辑。

## 仓库与部署

本仓库是插件本体（`main.js` 构建产物）的版本库，不含任何知识库业务数据。

| 文件 | 说明 |
|---|---|
| `main.js` | 插件构建产物，Obsidian 实际加载的文件 |
| `manifest.json` | 插件清单（id / 版本 / 最低 Obsidian 版本） |
| `styles.css` | 插件样式 |
| `versions.json` | 版本兼容表 |
| `data.json` | **不入库**：本机运行态配置（目录、网格视图偏好），已在 `.gitignore` |

### 同步脚本

插件仓库与 Obsidian vault 的部署目录之间用 `sync.sh` 同步：

```bash
./sync.sh to-vault                 # 仓库 → vault：把改好的插件部署到 Obsidian
./sync.sh from-vault               # vault → 仓库：把 vault 里现场改的文件收回仓库
./sync.sh deploy "改了什么"         # 一条命令：部署到 vault + git commit + git push
```

`deploy` 是最常用的：改完代码执行它，脚本会列出本次改动、部署到 vault、提交并推送，
最后提示去 Obsidian 重载插件。若仓库无改动或远端已是最新，会跳过对应步骤。

默认目标目录是本机 vault 路径，可用 `VAULT_DIR=/别的/路径 ./sync.sh to-vault` 覆盖。

### 改完之后如何生效

`main.js` 是 Obsidian 直接加载的文件，没有编译步骤。部署后需要在 Obsidian 里重载：

- **只改逻辑**：设置 → 第三方插件 → 关闭再打开本插件（约 1 秒）
- **改了 `styles.css`**：`Ctrl/Cmd+P` → `Reload app without saving`（整库重载，样式才一定刷新）

如果 vault 里装了 **Hot Reload** 插件（pjeby），上面两步都可以省掉：

- Hot Reload 只监听「目录里有 `.git` 或 `.hotreload` 标记」的插件，所以本插件的部署目录里需要 `.hotreload` 文件
- `./sync.sh to-vault` 和 `./sync.sh deploy` 每次都会自动重建这个标记，无需手工维护
- 标记存在且 Hot Reload 已启用时，部署一写文件就会自动重载插件，并在 Obsidian 里弹出提示

### 版本

`manifest.json` 当前版本 **0.8.0**（需 Obsidian ≥ 1.8.9）。历史小节按版本倒序保留。

`main.js` 是 Obsidian 直接加载的构建产物，没有编译步骤；改完执行部署后重载插件即可生效。
