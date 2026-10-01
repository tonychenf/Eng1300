#!/usr/bin/env bash
# scripts/ci/check-bank-files.sh 的单测（CR-H4）：推送里改动或删除已有的题库文件、题目图片要红，
# 新加的、和题库无关的照常过。在一个临时 git 仓库里造各种推送，不碰真实仓库。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$(cd "$ROOT_DIR/.." && pwd)/scripts/ci/check-bank-files.sh"
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
REPO=$(mktemp -d)
trap 'rm -rf "$REPO"' EXIT
cd "$REPO"
g() { git -c user.email=t@example.com -c user.name=t "$@" >/dev/null 2>&1; }
g init -q .
mkdir -p data/subjects/x/groups data/subjects/x/assets
echo '{"groupId":"a"}' > data/subjects/x/groups/a.json
echo 'png' > data/subjects/x/assets/i.png
echo 'readme' > data/subjects/x/README.md
echo 'kp' > data/subjects/x/knowledge-points.json
g add -A; g commit -qm base
BASE=$(git rev-parse HEAD)
run() { OUT=$(bash "$SCRIPT" "$@" 2>&1); RC=$?; }
reset_to_base() { g reset -q --hard "$BASE"; g clean -qfd; }

echo "== 不改已有的题库文件：过 =="
echo '{"groupId":"b"}' > data/subjects/x/groups/b.json
echo 'png2' > data/subjects/x/assets/j.png
echo 'readme2' > data/subjects/x/README.md
echo 'kp2' > data/subjects/x/knowledge-points.json
g add -A; g commit -qm add
run "$BASE" HEAD
check "新加题库文件和图片、改说明和考点文件：退出码 0" "$RC" "0"
# 同一次推送里新加、又在后一个提交里改了：推送前没有它，就不算"导入过的"
echo '{"groupId":"b","fix":1}' > data/subjects/x/groups/b.json
g add -A; g commit -qm fix-new
run "$BASE" HEAD
check "这次推送里新加又改的文件：退出码 0" "$RC" "0"

echo
echo "== 改了已有的题库文件：红 =="
reset_to_base
echo '{"groupId":"a","stem":"改过"}' > data/subjects/x/groups/a.json
g add -A; g commit -qm edit
run "$BASE" HEAD
check "退出码 1" "$RC" "1"
check "  点名是哪个文件、怎么改的" "$(echo "$OUT" | grep -c '改了 data/subjects/x/groups/a.json')" "1"
check "  说了正确做法" "$(echo "$OUT" | grep -c '停用旧题')" "1"

echo
echo "== 删了、改名了已有的文件：红 =="
reset_to_base
g rm -q data/subjects/x/assets/i.png; g commit -qm del
run "$BASE" HEAD
check "删了图片：退出码 1，点名" "$RC/$(echo "$OUT" | grep -c '删了 data/subjects/x/assets/i.png')" "1/1"
reset_to_base
g mv data/subjects/x/groups/a.json data/subjects/x/groups/a2.json; g commit -qm mv
run "$BASE" HEAD
check "改名：当成删了旧的，退出码 1" "$RC/$(echo "$OUT" | grep -c '删了 data/subjects/x/groups/a.json')" "1/1"

echo
echo "== 推送前的版本 =="
run "" HEAD
check "没有（手动触发）：跳过，退出码 0" "$RC/$(echo "$OUT" | grep -c '跳过')" "0/1"
run 0000000000000000000000000000000000000000 HEAD
check "全 0（新分支）：跳过，退出码 0" "$RC/$(echo "$OUT" | grep -c '跳过')" "0/1"
run 1234567890abcdef1234567890abcdef12345678 HEAD
check "取不到（浅克隆）：不当成没改，退出码 1" "$RC/$(echo "$OUT" | grep -c 'fetch-depth')" "1/1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
