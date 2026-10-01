#!/usr/bin/env bash
# 用 D1 时间旅行把整个库回滚到某个时间点或书签（CR-M6）。由 d1-restore 流水线手动触发。
#
# 会丢什么：恢复点之后的**一切写入**——学员的作答和错题、后台的改动、登录记录、上传的内容，
# 整库回去，不能挑表。所以动手前先把"现在"的书签打出来：恢复错了，用它再跑一次就回到恢复前。
# 免费版只能回到 7 天内（付费版 30 天）；每个库 10 分钟内最多恢复 10 次。
#
# 时间点的写法（任选一种）：
#   书签                 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683（部署日志「部署前的恢复点」那行）
#   北京时间             2026-10-01 15:00 或 2026-10-01 15:00:30（按北京时间理解，不用自己换算）
#   带时区的 RFC3339     2026-10-01T07:00:00Z、2026-10-01T15:00:00+08:00
#   Unix 秒              1790838000
#
# 用法：d1-restore.sh [--parse-only] <时间点或书签>
#   --parse-only  只打印怎么理解这个时间点，不碰库（流水线先跑这一步，本地测试也用它）
# 需要：D1_NAME、CONFIRM_NAME（必须和 D1_NAME 一样：手输库名，防手滑）；可选 WRANGLER_DIR
set -euo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
PARSE_ONLY=0
if [ "${1:-}" = "--parse-only" ]; then PARSE_ONLY=1; shift; fi
POINT="$(printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
[ -n "$POINT" ] || { echo "::error::没给时间点或书签"; exit 1; }

BOOKMARK=""; TS=""
if [[ "$POINT" =~ ^[0-9a-f]{8}(-[0-9a-f]{8}){2}-[0-9a-f]{32}$ ]]; then
  BOOKMARK="$POINT"
  echo "按书签恢复：$BOOKMARK"
else
  if [[ "$POINT" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})[\ T]([0-9]{2}:[0-9]{2})(:[0-9]{2})?$ ]]; then
    TS="${BASH_REMATCH[1]}T${BASH_REMATCH[2]}${BASH_REMATCH[3]:-:00}+08:00"     # 没写时区：北京时间
  elif [[ "$POINT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
    TS="$POINT"
  elif [[ "$POINT" =~ ^[0-9]{10}$ ]]; then
    TS="@$POINT"
  else
    echo "::error::看不懂「$POINT」。可以写：书签；北京时间 2026-10-01 15:00；2026-10-01T07:00:00Z；Unix 秒"
    exit 1
  fi
  EPOCH=$(date -u -d "$TS" +%s 2>/dev/null) || { echo "::error::「$POINT」不是一个真实存在的时间"; exit 1; }
  NOW=$(date -u +%s)
  [ "$EPOCH" -le "$NOW" ] || { echo "::error::「$POINT」在将来"; exit 1; }
  [ $(( NOW - EPOCH )) -le $(( 30 * 86400 )) ] || { echo "::error::「$POINT」超过 30 天了，时间旅行回不去（免费版只有 7 天）——看恢复手册里的备份那条路"; exit 1; }
  [ $(( NOW - EPOCH )) -le $(( 7 * 86400 )) ] \
    || echo "::warning::「$POINT」超过 7 天：免费版的时间旅行回不去，D1 会拒绝；付费版可以"
  TS=$(date -u -d "@$EPOCH" +%FT%TZ)
  echo "按时间点恢复：北京时间 $(TZ=Asia/Shanghai date -d "@$EPOCH" '+%F %T')，即世界时 $TS"
fi
[ "$PARSE_ONLY" -eq 1 ] && exit 0

[ -n "${D1_NAME:-}" ] || { echo "::error::需要 D1_NAME"; exit 1; }
if [ "${CONFIRM_NAME:-}" != "$D1_NAME" ]; then
  echo "::error::确认的库名「${CONFIRM_NAME:-}」和要恢复的库「$D1_NAME」不一样，没动手。"
  exit 1
fi
cd "${WRANGLER_DIR:-$WORKER}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tt() {  # 跑一条 time-travel 命令，stdout 是 JSON；失败带上 stderr 的尾巴
  if ! npx wrangler d1 time-travel "$@" --json > "$T/out.json" 2> "$T/err.log"; then
    # 加了 --json 时 wrangler 有的错误写在 stdout，两边都带出来
    echo "::error::wrangler d1 time-travel $1 失败：$(head -c 300 "$T/out.json" | tr '\n' ' ') $(tail -5 "$T/err.log" | tr '\n' ' ' | head -c 400)"; return 1
  fi
}

# 先记下现在：恢复错了，用这个书签再跑一次就回到恢复前
tt info "$D1_NAME"
UNDO=$(jq -r '.bookmark // empty' "$T/out.json")
[ -n "$UNDO" ] || { echo "::error::拿不到现在的书签（收到的前 200 字：$(head -c 200 "$T/out.json")），没有撤销的退路就不动手"; exit 1; }
echo "撤销书签（恢复前的此刻）：$UNDO"

if [ -z "$BOOKMARK" ]; then
  tt info "$D1_NAME" --timestamp "$TS"
  BOOKMARK=$(jq -r '.bookmark // empty' "$T/out.json")
  [ -n "$BOOKMARK" ] || { echo "::error::这个时间点换不出书签（收到的前 200 字：$(head -c 200 "$T/out.json")）"; exit 1; }
  echo "时间点对应的书签：$BOOKMARK"
fi

START=$(date +%s)
tt restore "$D1_NAME" --bookmark "$BOOKMARK"
DONE=$(jq -r '.bookmark // empty' "$T/out.json")
PREV=$(jq -r '.previous_bookmark // empty' "$T/out.json")
[ -n "$DONE" ] || { echo "::error::恢复接口没有确认（收到的前 300 字：$(head -c 300 "$T/out.json")）"; exit 1; }
echo "已恢复到书签 $DONE（用了 $(( $(date +%s) - START )) 秒）"
echo "撤销：再跑一次 d1-restore，方式选 time-travel，时间点填 ${PREV:-$UNDO}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### 时间旅行恢复"; echo; echo "- 恢复到：\`$DONE\`"; echo "- 撤销书签：\`${PREV:-$UNDO}\`"; } >> "$GITHUB_STEP_SUMMARY"
fi
