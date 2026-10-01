#!/usr/bin/env bash
# 把部署存下的加密备份（流水线附件 d1-backup-<运行编号>-<第几次>）下载到一个目录（CR-M6）。
#   指定了运行编号：取那次部署的备份（同一次部署重跑过的话取最后一次）；
#   没指定：取最近的一份没过期的。
# 下载下来的仍是密文 + manifest.json，解密在 d1-import-backup.sh 里。
#
# 用法：d1-fetch-backup.sh <目录> [部署的运行编号]
# 需要：GH_TOKEN（流水线的 github.token，permissions 里要有 actions: read）、GITHUB_REPOSITORY
set -euo pipefail
DIR="${1:-}"; RUN="${2:-}"
[ -n "$DIR" ] || { echo "::error::缺目录"; exit 1; }
[ -z "$RUN" ] || [[ "$RUN" =~ ^[0-9]+$ ]] || { echo "::error::运行编号应该是一串数字：「$RUN」"; exit 1; }
REPO="${GITHUB_REPOSITORY:?需要 GITHUB_REPOSITORY}"
LIST=$(mktemp)
gh api --paginate "repos/$REPO/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.name | startswith("d1-backup-")) | select(.expired | not)
        | [.name, (.workflow_run.id | tostring), .created_at] | @tsv' > "$LIST" \
  || { echo "::error::列不出流水线附件（GH_TOKEN 有 actions: read 权限吗？）"; exit 1; }
if [ -n "$RUN" ]; then
  PICK=$(awk -F'\t' -v r="$RUN" '$2 == r' "$LIST" | sort -t$'\t' -k3 | tail -1)
  [ -n "$PICK" ] || { echo "::error::运行 $RUN 没有可用的备份（没备份、过了 90 天，或者编号不对）"; rm -f "$LIST"; exit 1; }
else
  PICK=$(sort -t$'\t' -k3 "$LIST" | tail -1)
  [ -n "$PICK" ] || { echo "::error::一份可用的备份都没有"; rm -f "$LIST"; exit 1; }
fi
rm -f "$LIST"
NAME=$(cut -f1 <<<"$PICK"); RID=$(cut -f2 <<<"$PICK"); AT=$(cut -f3 <<<"$PICK")
mkdir -p "$DIR"
gh run download "$RID" --repo "$REPO" --name "$NAME" --dir "$DIR"
[ -f "$DIR/manifest.json" ] || { echo "::error::下载下来的附件里没有 manifest.json"; exit 1; }
echo "取到备份 $NAME（运行 $RID，附件建于 $AT；备份时刻北京时间 $(jq -r .createdAtBeijing "$DIR/manifest.json")）"
