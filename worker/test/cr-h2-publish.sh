#!/usr/bin/env bash
# CR-H2：部署的「放行」只放回**重导前就是已发布**的章节，别的一律不碰。
#
# 以前部署每次都无条件跑 publish-all.sql：管理员撤回的章节被放回去、确认完答案还没点发布的
# 章节被发布、上传内容里没人看过的存疑被清零（CR 文档 H2，本地复现过）。
#
# 不起服务。直接用本地库跑流水线里的那两步——scripts/ci/seed-if-changed.sh（SEED_LOCAL=1）
# 与 sql/republish-reseeded.sql——在两步之间模拟管理员的操作和"导题库之后中途失败"。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }
export D1_NAME
PASS=0; FAIL=0
SEED_LOG=/tmp/cr-h2-seed.log

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
seed_run() {
  SEED_LOCAL=1 bash ../scripts/ci/seed-if-changed.sh > "$SEED_LOG" 2>&1 \
    || { echo "导题库失败："; tail -20 "$SEED_LOG"; exit 1; }
}
republish() {
  npx wrangler d1 execute "$D1_NAME" --local --file=sql/republish-reseeded.sql >/dev/null 2>&1 \
    || { echo "放行失败"; exit 1; }
}
markers() { sql "SELECT name FROM seed_state WHERE name LIKE 'republish:%' ORDER BY name;" | jq -r '[.[0].results[].name] | join(",")'; }

cleanup() { rm -rf "$ROOT_DIR/.wrangler"; }
trap cleanup EXIT

echo "== 准备本地数据库 =="
rm -rf .wrangler
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

echo
echo "== 首次导入：库里原来没有的章节，部署不替人发布 =="
seed_run
N_EXAMS=$(one "SELECT COUNT(*) FROM exams;")
check "种子都导进来了（否则下面测了个空）" "$([ "${N_EXAMS:-0}" -gt 0 ] && echo yes || echo no)" "yes"
check "首次导入不记放行标记" "$(markers)" ""
republish
check "放行后仍没有章节被发布——新章节由管理员自己点发布" \
  "$(one "SELECT COUNT(*) FROM exams WHERE status='已发布';")" "0"

echo
echo "== 模拟线上现状：英语已由人发布，一章被撤回，另有上传内容带着没人看过的存疑 =="
# publish-all.sql 是测试夹具：把种子题放出来，相当于"管理员发布过"
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1
ENG_SQL="SELECT e.exam_id FROM exams e JOIN courses co ON co.course_code=e.course_code
          JOIN subjects s ON s.subject_id=co.subject_id WHERE s.code='english' AND e.status='已发布'"
# B 要有存疑记录：「随重导插回来的存疑被处理」那条靠它才测得到东西
B=$(one "$ENG_SQL AND EXISTS (SELECT 1 FROM exam_parsing_notes n WHERE n.exam_id=e.exam_id) ORDER BY e.exam_id LIMIT 1;")
A=$(one "$ENG_SQL AND e.exam_id <> '$B' ORDER BY e.exam_id LIMIT 1;")
C=$(one "$ENG_SQL AND e.exam_id NOT IN ('$A', '$B') ORDER BY e.exam_id LIMIT 1;")
check "挑到了三章互不相同的已发布英语章节" "$([ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] && echo yes || echo no)" "yes"
PUB_B=$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$B' AND status='已发布';")
NOTES_B=$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='$B';")
echo "     A=$A（将被撤回）  B=$B（已发布题 $PUB_B 道、存疑 $NOTES_B 条）  C=$C（不动）"

# 管理员撤回 A：与后台 /admin/bank/exams/:id/unpublish 同一组语句
sql "UPDATE questions SET status='草稿' WHERE exam_id='$A' AND status='已发布';" >/dev/null
sql "UPDATE exams SET status='待校对', published_at=NULL WHERE exam_id='$A';" >/dev/null
check "A 已撤回" "$(one "SELECT status FROM exams WHERE exam_id='$A';")" "待校对"

# 上传内容：一章 + 一条没人看过的存疑
sql "INSERT INTO exams (exam_id, course_code, title, label, order_key, meta, year, month, source_file, status, origin)
     VALUES ('up-h2', 'biochem-main', '上传探针', '上传探针', 9999, NULL, 0, 0, 'probe.docx', '待校对', 'UPLOAD');" >/dev/null
sql "INSERT INTO exam_parsing_notes (exam_id, note, note_kind, resolved) VALUES ('up-h2', '探针：没人看过的存疑', '解析存疑', 0);" >/dev/null
check "上传章节的存疑在库里、未处理（否则那条测了个空）" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='up-h2' AND resolved=0;")" "1"

echo
echo "== 题库文件变了：A、B 两章被重导 =="
FA=$(basename "$(ls seed/*-"$A".sql)"); FB=$(basename "$(ls seed/*-"$B".sql)")
# 删掉指纹 = 文件内容变了（导题库一步只认指纹）
sql "DELETE FROM seed_state WHERE name IN ('$FA', '$FB');" >/dev/null
seed_run
grep -E "── 导入|重导前已发布" "$SEED_LOG" | sed 's/^/     /'
check "只重导了这两章" "$(grep -c '── 导入' "$SEED_LOG")" "2"
check "只给重导前已发布的 B 记了放行标记（撤回的 A 没有）" "$(markers)" "republish:$B"
check "重导确实把 B 冲回了草稿（否则放行测了个空）" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$B' AND status='已发布';")" "0"
check "B 的存疑随重导插回来了、未处理（否则那条测了个空）" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='$B' AND resolved=0;")" "$NOTES_B"

echo
echo "== 放行这一步这次没跑成（导题库之后中途失败）：标记要留在库里 =="
check "标记还在，下次部署能接着放" "$(markers)" "republish:$B"

echo
echo "== 下一次部署：没有文件再变，放行把 B 放回来 =="
seed_run
check "这次没有重导任何章节" "$(grep -c '── 导入' "$SEED_LOG")" "0"
republish
check "B 放回来了，已发布题数与重导前一样" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$B' AND status='已发布';")" "$PUB_B"
check "B 的章节状态是已发布" "$(one "SELECT status FROM exams WHERE exam_id='$B';")" "已发布"
check "B 随重导插回来的存疑已处理" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='$B' AND resolved=0;")" "0"
check "撤回过的 A 重导后仍然没有放出去" "$(one "SELECT status FROM exams WHERE exam_id='$A';")" "待校对"
check "A 一道题都没放出去" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$A' AND status='已发布';")" "0"
check "没重导的 C 保持已发布" "$(one "SELECT status FROM exams WHERE exam_id='$C';")" "已发布"
check "上传内容的存疑没被部署清掉" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='up-h2' AND resolved=0;")" "1"
check "放行完标记删掉了" "$(markers)" ""

echo
echo "== 稳态：没有标记时，放行一行都不改 =="
STATE_SQL="SELECT (SELECT group_concat(exam_id || ':' || status, ',') FROM (SELECT exam_id, status FROM exams ORDER BY exam_id)) AS e,
                  (SELECT COUNT(*) FROM questions WHERE status='已发布') AS q,
                  (SELECT COUNT(*) FROM exam_parsing_notes WHERE resolved=0) AS n;"
BEFORE=$(sql "$STATE_SQL" | jq -c '.[0].results[0]')
republish
check "再跑一次放行，章节状态、已发布题数、未处理存疑都没变" "$(sql "$STATE_SQL" | jq -c '.[0].results[0]')" "$BEFORE"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
