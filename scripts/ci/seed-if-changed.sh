#!/usr/bin/env bash
# 把仓库里的题库文件导进库里。**导入过的文件不许改**（CR-H4，用户 2026-10-01 定的规矩）。
#
# 规矩：一个题库文件导入之后，它的题就不能再从文件这一侧改；内容要改，在后台把旧题停用，
# 用新的内容组编号加一个新文件。所以每个内容组（一章、一套卷）只有这几种结果：
#   - 库里没有这一章：导入（种子 SQL 只插不删）；
#   - 导过、文件没变：跳过；
#   - 导过、文件变了：**拒绝**，库里一行不动；
#   - 说不清的（撞了后台上传的编号、新文件的题目编号和库里已有的重复、库里有这一章却没有导入记录、
#     有导入记录库里却没有这一章）：同样拒绝，并说清楚是哪一种。
# 拒绝的写进 SEED_REFUSED_FILE，由线上验证报红；其余文件照常导入，部署不在这里卡住。
# 没给 SEED_REFUSED_FILE（没人接着报）时，有拒绝就自己以非 0 退出。
#
# 以前是"指纹变了就整章先删后插"：管理员在后台的确认、改过的题面、发布状态被冲回文件里的样子；
# 学员做过的章节删不掉，外键报错，部署卡死在这一步，之后每次都红在同一处（CR 文档 H4）。
#
# 指纹按**内容组编号**记（seed_state 里的 group:<编号>），算的是**题库文件本身**的字节，
# 写在种子文件最后一条语句里，与数据同属一次导入（见 build-seed-sql.mjs）。
# 线上 2026-10-01 之前导入的章节只有按种子文件名记的旧指纹（<学科>-<序号>-<编号>.sql）：
# 题目编号和文件对得上就补记一次新指纹、删掉旧记录，对不上就拒绝。补记只发生这一次。
#
# 知识点文件（<学科>-000-knowledge-points.sql）照旧按文件名记指纹，变了就重跑：它只做
# INSERT OR IGNORE，加不会删。
#
# 需要：D1_NAME。可选：SEED_LOCAL=1（本地库，给测试用）、SEED_REFUSED_FILE（拒绝清单，
# 每行"种子文件名<TAB>理由"）、SUBJECTS_ROOT（题库目录，默认 ../data/subjects）、
# SEED_OUT（种子生成到哪，默认 worker/seed）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"
if [ "${SEED_LOCAL:-0}" = "1" ]; then TARGET=(--local); else TARGET=(--remote --yes); fi
SUBJECTS_ROOT="${SUBJECTS_ROOT:-../data/subjects}"
SEED_OUT="${SEED_OUT:-seed}"
mkdir -p "$SEED_OUT"
if [ -n "${SEED_REFUSED_FILE:-}" ]; then REFUSED="$SEED_REFUSED_FILE"; else REFUSED=$(mktemp); fi
: > "$REFUSED"

# 逐个学科生成。**不能只跑英语**：`data/subjects/` 下每一科都要进库，
# 哪怕它的题还全是缺答案/待核——答案状态那道门已经保证它们抽不到、发不出，
# 而管理员要能在后台看到并逐题录答案（§6.4.10 的补答案工作流）。
# 生成失败必须中止：不显式判断的话生成器挂了也会接着往下走，
# 把上一轮留在 seed/ 里的旧文件当成本轮产物导进去。
for SUBJ_DIR in "$SUBJECTS_ROOT"/*/; do
  [ -d "$SUBJ_DIR/groups" ] || continue
  CODE=$(basename "$SUBJ_DIR")
  echo "── 生成 $CODE 的种子"
  SEED_SUBJECT_DIR="$SUBJ_DIR" node ../scripts/build-seed-sql.mjs "$SEED_OUT" \
    || { echo "::error::$CODE 的种子生成失败，中止部署。"; exit 1; }
done

q() { npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --json --command "$1" 2>/dev/null; }
# 读库要读得到才算数：读不到就停。当成"库里什么都没有"会把每一章都当新章去导，
# 当成"都导过"会把新章节静默漏掉——两边都不该替人猜。
read_rows() {   # SQL 说明
  local out
  out=$(q "$1")
  if [ $? -ne 0 ] || ! printf '%s' "$out" | jq -e '.[0].results | type == "array"' >/dev/null 2>&1; then
    echo "::error::读不到$2（收到的前 200 字：$(printf '%s' "$out" | head -c 200)），中止。" >&2
    return 1
  fi
  printf '%s' "$out" | jq -c '.[0].results'
}
FPS=$(read_rows "SELECT name, sha FROM seed_state;" "导入记录") || exit 1
EXAMS=$(read_rows "SELECT exam_id, origin FROM exams;" "库里已有的章节") || exit 1
fp_of() { printf '%s' "$FPS" | jq -r --arg n "$1" '[.[] | select(.name == $n)][0].sha // empty'; }
origin_of() { printf '%s' "$EXAMS" | jq -r --arg e "$1" '[.[] | select(.exam_id == $e)][0] | if . == null then empty else (.origin // "SEED") end'; }
# 旧方式的记录：<学科>-<三位序号>-<编号>.sql。序号会随文件增减变，所以按模式找，不按现在的文件名找
legacy_of() {
  printf '%s' "$FPS" | jq -r --arg g "$1" '
    ($g | gsub("(?<c>[.\\-])"; "\\\(.c)")) as $e
    | [.[] | select(.name | test("^[a-z][a-z0-9-]*-[0-9]{3}-" + $e + "\\.sql$"))][0].name // empty'
}
# 种子文件里的编号：第一列的字面值。章节编号在导之前已经单独核过字符
ids_in() {   # 文件 表 列
  grep -o "^INSERT INTO $2 ($3[^)]*) VALUES ('[^']*'" "$1" | sed -E "s/.*VALUES \('([^']*)'$/\1/"
}
in_list() { sed "s/.*/'&'/" | paste -sd, -; }

refused=0; applied=0; skipped=0; adopted=0
refuse() {   # 种子文件名 理由
  printf '%s\t%s\n' "$1" "$2" >> "$REFUSED"
  echo "::error::$1：$2"
  refused=$((refused + 1))
}
import_file() {   # 文件
  local out rc
  echo "── 导入 $(basename "$1")"
  out=$(npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --file="$1" 2>&1); rc=$?
  echo "$out"
  if [ $rc -ne 0 ]; then
    # 额度耗尽不是代码问题，继续导下去只会把剩下的额度也烧掉，直接停。
    if echo "$out" | grep -q 'daily row write limit'; then
      echo "::error::D1 今日写入额度已用尽，已导入 $applied 个文件，剩下的留到额度重置（世界时零点，北京时间早八点）后再跑。"
    fi
    exit 1
  fi
  applied=$((applied + 1))
}

for f in "$SEED_OUT"/*.sql; do
  name=$(basename "$f")
  GLINE=$(grep -o "VALUES ('group:[^']*', '[0-9a-f]\{64\}'" "$f" | head -1)

  # ---- 知识点这类文件：按文件名的指纹，变了就重跑（只补不删） ----
  if [ -z "$GLINE" ]; then
    sha=$(grep -o "VALUES ('$name', '[0-9a-f]\{64\}'" "$f" | grep -o "[0-9a-f]\{64\}")
    [ -n "$sha" ] || { echo "::error::$name 里找不到内容指纹，种子文件可能不是 build-seed-sql.mjs 生成的。"; exit 1; }
    if [ "$(fp_of "$name")" = "$sha" ]; then skipped=$((skipped + 1)); else import_file "$f"; fi
    continue
  fi

  # ---- 内容组 ----
  gid=$(sed -E "s/^VALUES \('group:([^']*)'.*/\1/" <<< "$GLINE")
  gsha=$(grep -o "[0-9a-f]\{64\}" <<< "$GLINE")
  [[ "$gid" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "::error::$name 里的内容组编号不合规：$gid"; exit 1; }
  rec=$(fp_of "group:$gid")
  origin=$(origin_of "$gid")

  if [ -n "$rec" ]; then
    if [ "$rec" != "$gsha" ]; then
      refuse "$name" "$gid 已经导入过，题库文件后来被改了（导入时 ${rec:0:12}…，现在 ${gsha:0:12}…）。导入过的文件不许改：把文件改回去；内容要改，在后台停用旧题，用新的内容组编号加一个新文件。"
    elif [ -z "$origin" ]; then
      refuse "$name" "有 $gid 的导入记录，库里却没有这一章——不知道是谁、为什么删的，不悄悄重导。确认要重导就先删掉 seed_state 里的 group:$gid。"
    else
      skipped=$((skipped + 1))
    fi
    continue
  fi

  if [ -n "$origin" ]; then
    if [ "$origin" = "UPLOAD" ]; then
      refuse "$name" "$gid 和后台上传的内容组撞了编号。仓库里的文件换一个内容组编号。"
      continue
    fi
    legacy=$(legacy_of "$gid")
    if [ -z "$legacy" ]; then
      refuse "$name" "库里已经有 $gid 这一章，却没有它的导入记录，说不清是不是同一份文件，不导、也不补记。"
      continue
    fi
    # 旧方式导入的：题目编号和文件对得上才补记新指纹
    FILE_IDS=$(ids_in "$f" questions question_id | LC_ALL=C sort)
    DB_ROWS=$(read_rows "SELECT question_id FROM questions WHERE exam_id = '$gid';" "$gid 库里的题") || exit 1
    DB_IDS=$(printf '%s' "$DB_ROWS" | jq -r '.[].question_id' | LC_ALL=C sort)
    if [ -z "$FILE_IDS" ] || [ "$FILE_IDS" != "$DB_IDS" ]; then
      refuse "$name" "$gid 是旧方式导入的，补记指纹前核对题目编号对不上（文件 $(printf '%s' "$FILE_IDS" | grep -c .) 道、库里 $(printf '%s' "$DB_IDS" | grep -c .) 道），不补记。"
      continue
    fi
    npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --command \
      "INSERT INTO seed_state (name, sha, applied_at) VALUES ('group:$gid', '$gsha', datetime('now')); DELETE FROM seed_state WHERE name = '$legacy';" \
      >/dev/null 2>&1 || { echo "::error::补记 $gid 的指纹失败，中止。"; exit 1; }
    echo "── 补记 $gid 的指纹（旧记录 $legacy，题目编号与文件一致）"
    adopted=$((adopted + 1))
    continue
  fi

  # ---- 新章节：先看编号有没有和库里已有的撞上 ----
  # 不看的话照样会撞主键失败，但那是整步中止、报一句约束失败；这里要说清楚是哪几个编号、该怎么办。
  QIDS=$(ids_in "$f" questions question_id | in_list)
  SIDS=$(ids_in "$f" sections section_id | in_list)
  CLASH=$(read_rows "SELECT question_id AS id FROM questions WHERE question_id IN (${QIDS:-''})
                     UNION ALL SELECT section_id FROM sections WHERE section_id IN (${SIDS:-''}) LIMIT 5;" "$gid 的编号是否重复") || exit 1
  if [ "$(printf '%s' "$CLASH" | jq 'length')" != "0" ]; then
    refuse "$name" "$gid 是新的内容组，可里面的题目或大题编号和库里已有的重复（$(printf '%s' "$CLASH" | jq -r '[.[].id] | join("、")') 等）。新文件的题目、大题编号要跟着新的内容组编号走。"
    continue
  fi
  import_file "$f"
done

echo "题库导入完成：新导入 $applied 个文件，$skipped 个导过且没变、跳过，补记指纹 $adopted 章，拒绝 $refused 个。"
if [ "$refused" -gt 0 ] && [ -z "${SEED_REFUSED_FILE:-}" ]; then
  echo "::error::有 $refused 个题库文件被拒绝（见上），而没有地方接着报（没设 SEED_REFUSED_FILE），这一步按失败算。"
  exit 1
fi
exit 0
