#!/usr/bin/env bash
# 在插件仓库与 Obsidian vault 部署目录之间同步插件文件
#
# 用法：
#   ./sync.sh to-vault     仓库 → vault（把仓库里改好的插件部署到 Obsidian，改完记得重启/重载插件）
#   ./sync.sh from-vault   vault → 仓库（把 vault 里现场改的 main.js 收回仓库，再 git commit）
#
# vault 路径可用环境变量覆盖：VAULT_DIR=/path/to/plugin ./sync.sh to-vault
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${VAULT_DIR:-/Users/chenzhongjun/Desktop/文档编辑器/消金业务合作平台/.obsidian/plugins/api-db-schema-tools}"
FILES=(main.js manifest.json styles.css README.md versions.json)

if [ ! -d "$VAULT" ]; then
  echo "找不到 vault 插件目录：$VAULT" >&2
  exit 1
fi

case "${1:-}" in
  to-vault)
    for f in "${FILES[@]}"; do
      [ -f "$REPO/$f" ] || { echo "仓库缺少文件：$f" >&2; exit 1; }
      cp "$REPO/$f" "$VAULT/$f"
    done
    echo "已部署到 vault：$VAULT"
    echo "提示：在 Obsidian 中用 Ctrl/Cmd+P → Reload app without saving 让插件生效。"
    ;;
  from-vault)
    for f in "${FILES[@]}"; do
      [ -f "$VAULT/$f" ] || { echo "vault 缺少文件：$f" >&2; exit 1; }
      cp "$VAULT/$f" "$REPO/$f"
    done
    echo "已从 vault 收回到仓库：$REPO"
    echo "提示：检查 git diff 后提交。"
    ;;
  *)
    echo "用法: ./sync.sh to-vault | from-vault" >&2
    exit 1
    ;;
esac
