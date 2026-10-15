#!/usr/bin/env bash
# 在插件仓库与 Obsidian vault 部署目录之间同步插件文件
#
# 用法：
#   ./sync.sh to-vault             仓库 → vault（部署到 Obsidian，改完记得重载插件）
#   ./sync.sh from-vault           vault → 仓库（把 vault 里现场改的文件收回仓库，再 git commit）
#   ./sync.sh deploy "提交说明"     一条命令：部署到 vault + 提交 + 推送
#
# vault 路径可用环境变量覆盖：VAULT_DIR=/path/to/plugin ./sync.sh to-vault
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${VAULT_DIR:-/Users/chenzhongjun/Desktop/文档编辑器/消金业务合作平台/.obsidian/plugins/api-db-schema-tools}"
FILES=(main.js manifest.json styles.css README.md versions.json xxljob-bundle.cjs)

if [ ! -d "$VAULT" ]; then
  echo "找不到 vault 插件目录：$VAULT" >&2
  exit 1
fi

deploy_to_vault() {
  for f in "${FILES[@]}"; do
    [ -f "$REPO/$f" ] || { echo "仓库缺少文件：$f" >&2; exit 1; }
    cp "$REPO/$f" "$VAULT/$f"
  done
  # Hot Reload 插件靠 .hotreload 标记决定要不要监听本插件；标记丢了会自动重载失效，这里兜底重建
  touch "$VAULT/.hotreload"
}

case "${1:-}" in
  to-vault)
    deploy_to_vault
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
  deploy)
    msg="${2:-}"
    if [ -z "$msg" ]; then
      echo '用法: ./sync.sh deploy "提交说明"' >&2
      exit 1
    fi
    cd "$REPO"
    if [ ! -d .git ]; then
      echo "当前目录不是 git 仓库，只做部署、跳过提交与推送：$REPO" >&2
      deploy_to_vault
      echo "已部署到 vault：$VAULT"
      exit 0
    fi

    # 仓库里有未提交改动时先列出来，避免把不相关的东西一起提交
    dirty="$(git status --porcelain)"
    if [ -n "$dirty" ]; then
      echo "本次将提交以下改动："
      echo "$dirty" | sed 's/^/  /'
      echo
    fi

    # ① 部署到 vault
    deploy_to_vault
    echo "① 已部署到 vault"

    # ② 提交
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
      git commit -q -m "$msg"
      echo "② 已提交：$(git log --oneline -1)"
    else
      echo "② 仓库无改动，跳过提交"
    fi

    # ③ 推送
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      if [ -n "$(git log --oneline '@{u}..HEAD')" ]; then
        git push -q
        echo "③ 已推送到 origin/$branch"
      else
        echo "③ 远端已是最新，跳过推送"
      fi
    else
      git push -q -u origin "$branch"
      echo "③ 已推送并绑定上游 origin/$branch"
    fi

    echo
    echo "最后一步：在 Obsidian 中重载插件 —— 设置 → 第三方插件 → 关闭再打开本插件；"
    echo "          改了 styles.css 的话用 Ctrl/Cmd+P → Reload app without saving。"
    ;;
  *)
    echo "用法: ./sync.sh to-vault | from-vault | deploy \"提交说明\"" >&2
    exit 1
    ;;
esac
