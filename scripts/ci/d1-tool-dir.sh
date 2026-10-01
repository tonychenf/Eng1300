#!/usr/bin/env bash
# 给恢复、演练用的 wrangler 建一个只认一个库的配置目录（CR-M6）。
#
# 在仓库的 worker/ 下跑，wrangler.toml 里写着线上库；演练和"备份导进新库"碰的都不是线上库，
# 所以干脆换一个目录、一份只写着目标库的配置——线上库名在这些命令的配置里根本不出现，
# 名字写错也找不到线上库头上。
#
# 用法：d1-tool-dir.sh <目录> <库名> [库 id，本地用可省]
# node_modules 软链到 worker/ 的那一份（npx wrangler 从这里找）。
set -euo pipefail
DIR="$1"; NAME="$2"; ID="${3:-00000000-0000-0000-0000-000000000000}"
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "::error::库名不合法：$NAME"; exit 1; }
mkdir -p "$DIR"
cat > "$DIR/wrangler.toml" <<TOML
name = "xlearn-d1-tool"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "TARGET"
database_name = "$NAME"
database_id = "$ID"
TOML
[ -e "$DIR/node_modules" ] || ln -s "$WORKER/node_modules" "$DIR/node_modules"
