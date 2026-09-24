#!/usr/bin/env bash
# 给已有的表补新列。
#
# 与 rebuild-legacy-schema.sh 的区别，也是它不需要门闩的理由：
# **加列是增量动作，不删任何数据。** 门闩那条规矩（见 CLAUDE.md）针对的是会删数据的
# 动作——判断错一次就没法挽回。加列判断错了最多是多建一列，而这里连这个都不会：
# 有没有那一列是直接从 PRAGMA table_info 读出来的事实，不是从 DDL 文本猜的。
#
# 为什么不写进迁移：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
# 第二次跑会报"duplicate column name"，而迁移循环没有 || true，一失败整条线就断。
# 新库从建表语句里就带着这些列，所以对新库这一步是零写入的空操作。
#
# 用法：ensure-columns.sh --local|--remote
set -uo pipefail

MODE="${1:-}"
case "$MODE" in --local|--remote) ;; *) echo "用法：$0 --local|--remote"; exit 2 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../worker"
D1_NAME="${D1_NAME:-$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')}"
[ -n "$D1_NAME" ] || { echo "读不到 database_name"; exit 1; }
FLAGS=""; [ "$MODE" = "--remote" ] && FLAGS="--yes"
d1() { npx wrangler d1 execute "$D1_NAME" "$MODE" $FLAGS "$@"; }

has_table() {
  d1 --json --command "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='$1'" 2>/dev/null \
    | jq -r '.[0].results[0].x // empty'
}
has_column() {
  d1 --json --command "SELECT COUNT(*) AS c FROM pragma_table_info('$1') WHERE name='$2'" 2>/dev/null \
    | jq -r '.[0].results[0].c // 0'
}
null_count() {
  d1 --json --command "SELECT COUNT(*) AS c FROM $1 WHERE $2 IS NULL" 2>/dev/null \
    | jq -r '.[0].results[0].c // 0'
}

# 表｜列｜类型（ADD COLUMN 的类型部分，不能带 NOT NULL 无默认值）
SPECS=(
  "answer_records|item_results|TEXT"
  "answer_records|score_rate|REAL"
  "attempts|pending_manual|INTEGER NOT NULL DEFAULT 0"
  "subject_question_types|answer_shape|TEXT"
  "subject_question_types|grading_strategy|TEXT"
  "exams|order_key|INTEGER"
  "exams|label|TEXT"
  "exams|meta|TEXT"
  "questions|answer_state|TEXT"
  "questions|answer_source|TEXT"
  "questions|answer_reviewed_by|TEXT"
  "questions|answer_reviewed_at|TEXT"
  "exam_parsing_notes|note_kind|TEXT"
  "exam_parsing_notes|corrected_from|TEXT"
  "exam_parsing_notes|corrected_to|TEXT"
  "exam_parsing_notes|corrected_by|TEXT"
  "exam_parsing_notes|corrected_at|TEXT"
)

# 补完列还要**回填**：新库从建表语句和种子里就带着值，旧库补出来的列全是 NULL，
# 而判分要读 grading_strategy，读不到就抛错（读不到值不回落默认值，见 CLAUDE.md）。
#
# 回填每次部署都跑，不加门闩，靠的是 `WHERE 该列 IS NULL` 这个条件自限：
#   - 管理员在后台改过的值不会被冲掉（那些行不是 NULL）
#   - 上一次部署补了列却没填上值（中途失败）的库，这次会被补齐
# 门闩那条规矩针对的是会删数据的动作，这里一行都不删。
# questions.answer_state 回填成"已确认"的依据：库里现有的题全是英语真题，
# 答案来自官方答案页（§6.4.10 的 OFFICIAL）。这不是"读不到就当合法"——
# 这一列是这次才加的，旧行没有它不代表答案可疑，而是这个维度以前不存在。
# 生化那批题由种子显式写 缺答案 / 待核，不经过这里。
#
# exams.order_key 回填成 year*100+month，**但只填年月是真的那些行**。
# 没有年月的学科（生化按章节）在库里把 year/month 写成 0，照着算会得到 order_key=0，
# 而 0 是个合法的排序键——那一章会静默排到所有内容组的最前面，不报错。
# 算不出来就留空，让下面的 REQUIRED 检查把它点名、让部署当场失败：
# 章节号只有导入那份数据的人知道，脚本猜不出来，也不该猜。
backfill_sql() {
  case "$1.$2" in
    subject_question_types.answer_shape) cat <<'SQL'
UPDATE subject_question_types SET answer_shape = CASE type_code
    WHEN 'single_choice' THEN 'CHOICE_ONE'
    WHEN 'fill_text'     THEN 'TEXT_SHORT'
    WHEN 'essay'         THEN 'TEXT_LONG'
    WHEN 'term_explain'  THEN 'TEXT_LONG'
    WHEN 'short_answer'  THEN 'TEXT_LONG'
  END WHERE answer_shape IS NULL;
SQL
      ;;
    subject_question_types.grading_strategy) cat <<'SQL'
UPDATE subject_question_types SET grading_strategy = CASE type_code
    WHEN 'single_choice' THEN 'EXACT'
    WHEN 'fill_text'     THEN 'EXACT'
    WHEN 'essay'         THEN 'AI_DIMENSION'
    WHEN 'term_explain'  THEN 'AI_SCORE_POINTS'
    WHEN 'short_answer'  THEN 'AI_SCORE_POINTS'
  END WHERE grading_strategy IS NULL;
SQL
      ;;
    exams.order_key) cat <<'SQL'
UPDATE exams SET order_key = year * 100 + month
 WHERE order_key IS NULL AND year > 0 AND month > 0;
SQL
      ;;
    exams.label) cat <<'SQL'
UPDATE exams SET label = title WHERE label IS NULL;
SQL
      ;;
    questions.answer_state) cat <<'SQL'
UPDATE questions SET answer_state = '已确认' WHERE answer_state IS NULL;
SQL
      ;;
    questions.answer_source) cat <<'SQL'
UPDATE questions SET answer_source = 'OFFICIAL' WHERE answer_source IS NULL;
SQL
      ;;
    exam_parsing_notes.note_kind) cat <<'SQL'
UPDATE exam_parsing_notes SET note_kind = '解析存疑' WHERE note_kind IS NULL;
SQL
      ;;
    *) return 1 ;;
  esac
}

# 回填之后仍为 NULL 的列会让整个学科判不了分。**让部署当场失败**，
# 而不是把一个读不到判分策略的学科放上线：管理员自己加过的题型不在上面那张对照表里，
# 那就得有人去后台补，猜一个策略填进去比报错危险得多。
REQUIRED=(
  "subject_question_types|answer_shape"
  "subject_question_types|grading_strategy"
  "exams|order_key"
  "exams|label"
  "questions|answer_state"
  "questions|answer_source"
  "exam_parsing_notes|note_kind"
)

added=0
for spec in "${SPECS[@]}"; do
  TABLE="${spec%%|*}"; rest="${spec#*|}"
  COL="${rest%%|*}"; TYPE="${rest##*|}"
  if [ -z "$(has_table "$TABLE")" ]; then
    echo "  -- $TABLE 还不存在，跳过（迁移还没跑？）"; continue
  fi
  if [ "$(has_column "$TABLE" "$COL")" != "0" ]; then
    echo "  -- $TABLE.$COL 已存在，跳过"; continue
  fi
  echo "  ++ 给 $TABLE 加列 $COL $TYPE"
  d1 --command "ALTER TABLE $TABLE ADD COLUMN $COL $TYPE;" >/dev/null 2>&1 || { echo "  !! 加列失败"; exit 1; }
  # 加完立刻回读确认。ALTER 成功但列没出现是不会报错的那类失败。
  [ "$(has_column "$TABLE" "$COL")" != "0" ] || { echo "  !! 加完仍读不到 $TABLE.$COL"; exit 1; }
  added=$((added+1))
done
filled=0
for spec in "${SPECS[@]}"; do
  TABLE="${spec%%|*}"; rest="${spec#*|}"; COL="${rest%%|*}"
  SQL="$(backfill_sql "$TABLE" "$COL")" || continue
  [ -n "$(has_table "$TABLE")" ] || continue
  [ "$(has_column "$TABLE" "$COL")" != "0" ] || continue
  before="$(null_count "$TABLE" "$COL")"
  [ "$before" = "0" ] && { echo "  -- $TABLE.$COL 没有待回填的行"; continue; }
  echo "  ++ 回填 $TABLE.$COL（$before 行）"
  d1 --command "$SQL" >/dev/null 2>&1 || { echo "  !! 回填失败"; exit 1; }
  after="$(null_count "$TABLE" "$COL")"
  filled=$((filled + before - after))
done

problems=0
for spec in "${REQUIRED[@]}"; do
  TABLE="${spec%%|*}"; COL="${spec##*|}"
  [ -n "$(has_table "$TABLE")" ] || continue
  left="$(null_count "$TABLE" "$COL")"
  [ "$left" = "0" ] && continue
  echo "  !! $TABLE.$COL 还有 $left 行是空的，回填对照表里没有它们："
  # 打印哪几行没填上。每张表的"身份列"不一样，写死 subject_id/type_code 的话
  # 这条查询在别的表上会直接报错，而报错会盖掉真正的原因。
  case "$TABLE" in
    subject_question_types) IDCOLS="subject_id, type_code" ;;
    exams)                  IDCOLS="exam_id, course_code" ;;
    questions)              IDCOLS="question_id, exam_id" ;;
    exam_parsing_notes)     IDCOLS="id, exam_id" ;;
    *)                      IDCOLS="rowid" ;;
  esac
  d1 --command "SELECT $IDCOLS FROM $TABLE WHERE $COL IS NULL LIMIT 20;" 2>&1 | tail -25
  problems=$((problems+1))
done
[ "$problems" = "0" ] || { echo "补列：有 $problems 个列没填全，中止部署"; exit 1; }

echo "补列：本次新增 $added 列，回填 $filled 行。"
