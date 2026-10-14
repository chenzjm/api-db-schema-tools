# 接口与数据库结构工具 v0.6.3

Schema Studio 用于维护接口字段和数据库字段。底层仍然是普通 Markdown、YAML Frontmatter 和 Wikilink；Fileclass 提供属性定义，Schema Tools 负责 JSON/DDL 导入、字段管理和精准引用。本仓库的接口字段属性名称统一使用中文，接口协议里的字段名、路径和类型保留原始写法。

默认目录：接口文档为 `5.api/`，数据库文档为 `7.db/`，接口字段为 `_data/api-fields/`，数据库字段为 `_data/db-columns/`，总览视图为 `_bases/`。

迁移兼容：插件仍可读取历史英文属性；新建、保存和重新导入接口字段时，会统一写入中文属性。`ApiField`、`DbColumn` 是插件识别用的技术类名，不是团队需要记忆的业务字段名称。

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

插件仓库与 Obsidian vault 的部署目录之间用 `sync.sh` 双向同步：

```bash
./sync.sh to-vault      # 仓库 → vault：把改好的插件部署到 Obsidian，重载后生效
./sync.sh from-vault    # vault → 仓库：把 vault 里现场改的 main.js 收回仓库，再 git commit
```

默认目标目录是本机 vault 路径，可用 `VAULT_DIR=/别的/路径 ./sync.sh to-vault` 覆盖。

### 版本

`manifest.json` 当前版本 **0.7.10**（需 Obsidian ≥ 1.8.9）。README 上方「v0.6.3」为新增中文文档分类那一节的版本号，历史小节按版本倒序保留。
