#!/usr/bin/env bash
# 按文件名顺序执行 worker/migrations/*.sql。迁移全写成 IF NOT EXISTS / INSERT OR IGNORE，可以反复执行。
#
# 原来内联在 deploy-worker.yml 里；恢复流水线（d1-restore）回滚之后要补齐表结构、演练（d1-drill）
# 要给一次性的库建表，三处跑的是同一份。
#
# 用法：apply-migrations.sh --remote|--local
# 需要：D1_NAME；可选 WRANGLER_DIR（在哪个目录跑 wrangler，默认仓库的 worker/——演练用自己的配置目录，
#       那里只写着一次性的库，线上库名根本不出现）
set -euo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
case "${1:-}" in
  --remote) TARGET=(--remote --yes) ;;
  --local)  TARGET=(--local) ;;
  *) echo "::error::用法：apply-migrations.sh --remote|--local"; exit 1 ;;
esac
[ -n "${D1_NAME:-}" ] || { echo "::error::需要 D1_NAME"; exit 1; }
cd "${WRANGLER_DIR:-$WORKER}"
for f in "$WORKER"/migrations/*.sql; do
  echo "── 执行 migrations/$(basename "$f")"
  npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --file="$f"
done
