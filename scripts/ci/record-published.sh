#!/usr/bin/env bash
# 导题库之前记下哪些章节是已发布的，线上验证拿它和部署后的状态逐章比对（CR-M14）。
#
# 部署不该改变任何章节的发布状态：撤回的不能被放回去（H2 修的就是这个），已发布的不能因为
# 种子重导被冲回草稿而丢掉（放行一步要负责放回）。以前线上验证断的是"英语 20 套全部已发布"——
# H2 之后撤回会保留，管理员撤回任何一套英语卷，之后每次部署都会红。那是某一时刻的状态，
# 这里记的才是要守的东西：部署前后一样。
#
# 读不到就失败，不写空文件：空文件会被当成"部署前一章都没发布"，比对时把所有已发布的章节
# 都报成"部署多放出来的"，或者在两边都空时什么都验不到。
#
# 用法：record-published.sh --remote|--local
# 需要：D1_NAME、PUBLISHED_BEFORE_FILE（写到哪里，每行一个章节编号，按编号排序）
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"

case "${1:-}" in
  --remote) TARGET=(--remote --yes) ;;
  --local)  TARGET=(--local) ;;
  *) echo "::error::用法：record-published.sh --remote|--local"; exit 1 ;;
esac
[ -n "${D1_NAME:-}" ] && [ -n "${PUBLISHED_BEFORE_FILE:-}" ] \
  || { echo "::error::需要 D1_NAME 和 PUBLISHED_BEFORE_FILE"; exit 1; }

OUT=$(npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --json \
  --command "SELECT exam_id FROM exams WHERE status = '已发布' ORDER BY exam_id;" 2>/dev/null)
RC=$?
if [ $RC -ne 0 ] || ! printf '%s' "$OUT" | jq -e '.[0].results | type == "array"' >/dev/null 2>&1; then
  echo "::error::读不到部署前的发布状态（退出码 $RC，收到的前 200 字：$(printf '%s' "$OUT" | head -c 200)）"
  exit 1
fi
printf '%s' "$OUT" | jq -r '.[0].results[].exam_id' | LC_ALL=C sort > "$PUBLISHED_BEFORE_FILE"
echo "部署前已发布 $(wc -l < "$PUBLISHED_BEFORE_FILE") 章，记在 $PUBLISHED_BEFORE_FILE"
