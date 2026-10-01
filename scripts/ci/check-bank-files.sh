#!/usr/bin/env bash
# 推送时先拦一道（CR-H4）：这次推送有没有改动或删除已有的题库文件、题目图片。
#
# 规矩是"导入过的题库文件不许改"（用户 2026-10-01 定的）：内容要改，在后台停用旧题，用新的内容组
# 编号加一个新文件。真正兜底的是部署时导题库那一步——它比对库里记的指纹，改过的文件一律不导入、
# 线上验证报红。但到那一步时新代码已经部署上去了；在这里拦，测试这一关就红，代码都不部署。
# 图片目录也一起看：图片随前端一起上传，改了图，已经导入的题立刻换图，导题库那一步根本看不见。
#
# 判据是 git：推送前的版本里已经有的 data/subjects/*/groups/*.json 和 data/subjects/*/assets/ 下的
# 文件，这次推送不许改、不许删、不许改名。新加的文件随便加；同一次推送里新加又改的，也随便改。
# 推送前的版本取不到（新分支、手动触发的部署）就跳过——导题库那一步照样会拒绝改过的题库文件。
#
# 用法（在仓库根目录跑）：check-bank-files.sh <推送前的提交> [推送后的提交，默认 HEAD]
set -uo pipefail
BEFORE="${1:-}"; AFTER="${2:-HEAD}"
if [ -z "$BEFORE" ] || [[ "$BEFORE" =~ ^0+$ ]]; then
  echo "没有推送前的版本（新分支或手动触发），跳过；导题库那一步照样会拒绝改过的题库文件。"
  exit 0
fi
git cat-file -e "$BEFORE^{commit}" 2>/dev/null || {
  echo "::error::取不到推送前的版本 $BEFORE——checkout 要带上历史（fetch-depth: 0），否则这道检查等于没做。"
  exit 1
}
# --no-renames：改名拆成"删了旧的 + 加了新的"，删的那一半照样拦下
CHANGED=$(git diff --name-status --no-renames "$BEFORE" "$AFTER" -- \
  'data/subjects/*/groups/*.json' 'data/subjects/*/assets/*' | awk -F'\t' '$1 != "A"')
if [ -n "$CHANGED" ]; then
  echo "::error::这次推送改动或删除了已有的题库文件。导入过的题库文件不许改——内容要改，在后台停用旧题，用新的内容组编号加一个新文件。"
  printf '%s\n' "$CHANGED" | while IFS=$'\t' read -r st f; do
    case "$st" in M) w="改了" ;; D) w="删了" ;; *) w="$st" ;; esac
    echo "::error file=$f::$w $f"
  done
  exit 1
fi
echo "推送里没有改动或删除已有的题库文件。"
