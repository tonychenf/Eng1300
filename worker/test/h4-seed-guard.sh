#!/usr/bin/env bash
# CR-H4：导入过的题库文件不许改。
#
# 用户 2026-10-01 定的规矩：题库文件导入之后，它的题就不能再从文件这一侧改；内容要改，在后台把
# 旧题停用，用新的内容组编号加一个新文件。
#
# 以前导题库是"指纹变了就整章先删后插"，两种坏法（CR 文档 H4 那张表）：
#   - 管理员在后台确认过的答案、改过的题面、发布状态，被冲回文件里的样子；
#   - 学员做过的章节删不掉，外键报错，部署卡死在导题库这一步，之后每次都红在同一处。
# 现在：库里没有的章节才导入（只插不删）；导过的、文件没变就跳过；导过的、文件变了就拒绝，
# 库里一行不动，记进拒绝清单，由线上验证报红。
#
# 不起服务。自己搭一份最小的仓库副本（worker 的迁移与 SQL、scripts、几份题库文件），
# 改题库文件只改副本里的——单独在真实目录跑也碰不到 data/。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BOX="$WORK/box"
EN=data/subjects/english
BIO=data/subjects/biochem
mkdir -p "$BOX/worker/test" "$BOX/worker/seed" "$BOX/$EN/groups" "$BOX/$BIO/groups"
cp -r "$ROOT_DIR/migrations" "$ROOT_DIR/sql" "$ROOT_DIR/wrangler.toml" "$ROOT_DIR/package.json" "$BOX/worker/"
cp -r "$ROOT_DIR/src" "$BOX/worker/"                   # 生成器要用 worker/src/lib 里的校验（它们又引 graders、normalizers）
cp -r "$ROOT_DIR/test/lib" "$BOX/worker/test/"
ln -s "$ROOT_DIR/node_modules" "$BOX/worker/node_modules"
cp -r "$REPO_DIR/scripts" "$BOX/"
cp "$REPO_DIR/$EN/knowledge-points.json" "$BOX/$EN/"
[ -d "$REPO_DIR/$EN/assets" ] && cp -r "$REPO_DIR/$EN/assets" "$BOX/$EN/"
for g in 00015-2024-04 13000-2025-10 13000-2026-04; do cp "$REPO_DIR/$EN/groups/$g.json" "$BOX/$EN/groups/"; done
cp "$REPO_DIR/$BIO/knowledge-points.json" "$BOX/$BIO/"
cp "$REPO_DIR/$BIO/groups/biochem-ch01.json" "$BOX/$BIO/groups/"

cd "$BOX/worker"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }
export D1_NAME
source "$BOX/worker/test/lib/d1.sh"   # sql / one / exec_sql：在副本自己的本地库上

SEED_LOG="$WORK/seed.log"
REFUSED_FILE="$WORK/refused.txt"
# 一次部署里的导题库。失败不中止这一套：改之前的代码就是在这里失败的，要能把那种失败也断言出来
seed_run() {
  rm -f "$REFUSED_FILE"
  SEED_LOCAL=1 SEED_REFUSED_FILE="$REFUSED_FILE" bash ../scripts/ci/seed-if-changed.sh > "$SEED_LOG" 2>&1
  SEED_RC=$?
}
refused() { [ -f "$REFUSED_FILE" ] && cut -f1 "$REFUSED_FILE" | sed -E 's/^[a-z]+-[0-9]{3}-//; s/\.sql$//' | sort | paste -sd, - || echo "没有清单"; }
reason_of() { grep -F -- "$1" "$REFUSED_FILE" 2>/dev/null | cut -f2- | head -1; }
imported() { grep -c '^── 导入 ' "$SEED_LOG"; }
gfp() { one "SELECT sha FROM seed_state WHERE name = 'group:$1';"; }
file_sha() { sha256sum "$1" | cut -d' ' -f1; }
# 把库里和这几章有关的状态拍成一行：发布状态、答案状态、题面、作答记录、指纹。前后一比就知道动没动
STATE_SQL="SELECT
  (SELECT group_concat(x, ';') FROM (SELECT exam_id || ':' || status || ':' || label AS x FROM exams ORDER BY exam_id)) AS exams,
  (SELECT group_concat(x, ';') FROM (SELECT question_id || ':' || status || ':' || answer_state || ':' || length(stem) || ':' || substr(stem, 1, 12) AS x
                                       FROM questions ORDER BY question_id)) AS questions,
  (SELECT COUNT(*) FROM attempt_questions) AS aq,
  (SELECT COUNT(*) FROM answer_records) AS ar,
  (SELECT group_concat(x, ';') FROM (SELECT name || ':' || sha AS x FROM seed_state WHERE name LIKE 'group:%' ORDER BY name)) AS fps;"
state() { sql "$STATE_SQL" | jq -c '.[0].results[0]' | sha256sum | cut -c1-16; }
# 改题库文件里的某道题的题干（只改副本）
edit_stem() {   # 文件 题号
  python3 - "$1" "$2" <<'PY'
import json, sys
p, qid = sys.argv[1], sys.argv[2]
d = json.load(open(p, encoding='utf-8'))
hit = 0
for s in d['sections']:
    for q in s['questions']:
        if q['questionId'] == qid:
            q['stem'] = (q.get('stem') or '') + '（文件后来改过）'; hit += 1
assert hit == 1, f'{qid} 在 {p} 里出现了 {hit} 次'
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}
# 复制一份内容组成新文件：新的内容组编号；ids=new 时题目、大题编号也跟着换（正确做法），ids=same 时不换（撞号）
clone_group() {   # 源文件 新编号 ids
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys, os
src, gid, ids = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding='utf-8'))
old = d.get('groupId') or d.get('examId')
d['groupId'] = gid
if 'examId' in d: d['examId'] = gid
d['label'] = (d.get('label') or old) + f'（{gid}）'
if ids == 'new':
    for s in d['sections']:
        s['sectionId'] = s['sectionId'].replace(old, gid, 1)
        for q in s['questions']:
            q['questionId'] = q['questionId'].replace(old, gid, 1)
json.dump(d, open(os.path.join(os.path.dirname(src), gid + '.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2)
PY
}
# 把一章从库里整个删掉（子表先删）——模拟"有导入记录、库里却没有这一章"、"库里少了题"
drop_questions() {   # WHERE 片段（作用在 questions 上）
  exec_sql "DELETE FROM question_knowledge_points WHERE question_id IN (SELECT question_id FROM questions WHERE $1);
    DELETE FROM question_assets WHERE question_id IN (SELECT question_id FROM questions WHERE $1);
    DELETE FROM question_items WHERE question_id IN (SELECT question_id FROM questions WHERE $1);
    DELETE FROM questions WHERE $1;"
}

echo "== 准备：副本里的新库 =="
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

echo
echo "== 第一次导入：四章都是新的 =="
seed_run
grep -E '^── 导入|题库导入' "$SEED_LOG" | sed 's/^/     /'
check "导题库成功" "$SEED_RC" "0"
check "四章都进了库" "$(one "SELECT COUNT(*) FROM exams;")" "4"
check "没有拒绝任何文件" "$(refused)" ""
check "每章按内容组编号记下了指纹" "$(one "SELECT COUNT(*) FROM seed_state WHERE name LIKE 'group:%';")" "4"
check "指纹就是题库文件本身的 sha256" "$(gfp biochem-ch01)" "$(file_sha "$BOX/$BIO/groups/biochem-ch01.json")"
check "种子 SQL 里一条删除语句都没有（只插不删）" "$(cat seed/*.sql | grep -ci '^ *DELETE ')" "0"
check "新导入的章节都不替人发布" "$(one "SELECT COUNT(*) FROM exams WHERE status = '已发布';")" "0"

echo
echo "== 线上现状：生化核完发布、有学员做过；英语一道题在后台改过题面 =="
exec_sql "UPDATE questions SET answer_state = '已确认', answer_reviewed_by = 'admin' WHERE exam_id = 'biochem-ch01';
  UPDATE questions SET status = '已发布' WHERE exam_id = 'biochem-ch01' AND status = '草稿';
  UPDATE exams SET status = '已发布' WHERE exam_id = 'biochem-ch01';"
QB=$(one "SELECT question_id FROM questions WHERE exam_id = 'biochem-ch01' AND status = '已发布' ORDER BY ord LIMIT 1;")
SB=$(one "SELECT section_id FROM questions WHERE question_id = '$QB';")
exec_sql "INSERT INTO users (username, password_hash, role) VALUES ('H4STU', 'x', 'USER');
  INSERT INTO attempts (attempt_id, user_id, course_code, mode, status)
    VALUES ('h4-a1', (SELECT id FROM users WHERE username = 'H4STU'), 'biochem-main', 'EXAM', '已交卷');
  INSERT INTO attempt_questions (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
    VALUES ('h4-a1', 1, '$QB', '$SB', 1, 1);
  INSERT INTO answer_records (attempt_id, question_id, user_answer, is_correct) VALUES ('h4-a1', '$QB', 'x', 0);"
QE=$(one "SELECT question_id FROM questions WHERE exam_id = '13000-2025-10' AND status = '草稿' AND stem IS NOT NULL ORDER BY ord LIMIT 1;")
exec_sql "UPDATE questions SET stem = '【后台改过】' || stem WHERE question_id = '$QE';"
echo "     学员做过的生化题 $QB；英语在后台改过题面的 $QE"
check "（前提）学员的作答引用着生化那道题" "$(one "SELECT COUNT(*) FROM attempt_questions WHERE question_id = '$QB';")" "1"
check "（前提）英语那道题的题面是后台改过的" "$(one "SELECT substr(stem, 1, 6) FROM questions WHERE question_id = '$QE';")" "【后台改过】"
S0=$(state)

echo
echo "== 平常一次部署：文件都没变 =="
seed_run
check "导题库成功、一章都没导" "$SEED_RC/$(imported)" "0/0"
check "没有拒绝任何文件" "$(refused)" ""
check "库里一行都没动" "$(state)" "$S0"

echo
echo "== 英语那章的题库文件被改了（后台改过题面的那一章） =="
EF="$BOX/$EN/groups/13000-2025-10.json"
cp "$EF" "$WORK/en.bak"
edit_stem "$EF" "$QE"
seed_run
grep -E '::error::' "$SEED_LOG" | head -2 | sed 's/^/     /'
check "导题库没有中断（拒绝的记下来，交给线上验证报红）" "$SEED_RC" "0"
check "拒绝了这一个文件" "$(refused)" "13000-2025-10"
check "  理由说的是导入过的文件不许改" "$(reason_of 13000-2025-10 | grep -c '导入过')" "1"
check "库里一行都没动：后台改过的题面还在、章节没被冲回草稿" "$(state)" "$S0"
check "后台改过的题面还在" "$(one "SELECT substr(stem, 1, 6) FROM questions WHERE question_id = '$QE';")" "【后台改过】"

echo
echo "== 生化那章的题库文件被改了（学员做过的那一章） =="
cp "$WORK/en.bak" "$EF"
BF="$BOX/$BIO/groups/biochem-ch01.json"
cp "$BF" "$WORK/bio.bak"
edit_stem "$BF" "$QB"
seed_run
check "导题库没有中断（以前这里外键报错、整步失败）" "$SEED_RC" "0"
check "拒绝了这一个文件" "$(refused)" "biochem-ch01"
check "库里一行都没动：确认、发布、作答记录都在" "$(state)" "$S0"

echo
echo "== 文件改回去：下一次部署照常 =="
cp "$WORK/bio.bak" "$BF"
seed_run
check "导题库成功、没有拒绝、一章都没导" "$SEED_RC/$(refused)/$(imported)" "0//0"
check "库里一行都没动" "$(state)" "$S0"

echo
echo "== 正确的做法：用新的内容组编号加一个新文件 =="
clone_group "$BF" biochem-ch01-v2 new
seed_run
check "导题库成功、只导了这一章" "$SEED_RC/$(imported)" "0/1"
check "新章节进了库，状态待校对" "$(one "SELECT status FROM exams WHERE exam_id = 'biochem-ch01-v2';")" "待校对"
check "新章节的题一道都没发布（发布由管理员点）" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = 'biochem-ch01-v2' AND status = '已发布';")" "0"
check "新章节的题数和原文件一样" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = 'biochem-ch01-v2';")" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = 'biochem-ch01';")"
check "旧章节没被动过" "$(one "SELECT status FROM exams WHERE exam_id = 'biochem-ch01';")" "已发布"
S1=$(state)

echo
echo "== 新文件换了内容组编号、题目编号却没换（照抄的） =="
clone_group "$BF" biochem-ch01-copy same
seed_run
check "导题库没有中断" "$SEED_RC" "0"
check "拒绝了这个文件" "$(refused)" "biochem-ch01-copy"
check "  理由说的是编号重复" "$(reason_of biochem-ch01-copy | grep -c '编号')" "1"
check "这一章没进库" "$(one "SELECT COUNT(*) FROM exams WHERE exam_id = 'biochem-ch01-copy';")" "0"
check "库里一行都没动" "$(state)" "$S1"
rm -f "$BOX/$BIO/groups/biochem-ch01-copy.json"

echo
echo "== 线上那批章节是旧方式导入的：没有按编号的指纹，只有按文件名的旧记录 =="
# 旧记录的名字是 <学科>-<序号>-<编号>.sql，序号会随文件增减变；这里故意给一个和现在不一样的序号
exec_sql "DELETE FROM seed_state WHERE name = 'group:13000-2026-04';
  INSERT INTO seed_state (name, sha) VALUES ('english-099-13000-2026-04.sql', 'legacy');"
S2=$(sql "SELECT (SELECT group_concat(x, ';') FROM (SELECT question_id || status AS x FROM questions WHERE exam_id = '13000-2026-04' ORDER BY 1)) AS q;" | jq -c '.[0].results[0]')
seed_run
grep -E '补记' "$SEED_LOG" | head -2 | sed 's/^/     /'
check "导题库成功、没有拒绝、一章都没导" "$SEED_RC/$(refused)/$(imported)" "0//0"
check "补记了按编号的指纹，就是文件本身的 sha256" "$(gfp 13000-2026-04)" "$(file_sha "$BOX/$EN/groups/13000-2026-04.json")"
check "旧记录删掉了（补记只发生一次）" \
  "$(one "SELECT COUNT(*) FROM seed_state WHERE name = 'english-099-13000-2026-04.sql';")" "0"
check "这一章的题一道没动" \
  "$(sql "SELECT (SELECT group_concat(x, ';') FROM (SELECT question_id || status AS x FROM questions WHERE exam_id = '13000-2026-04' ORDER BY 1)) AS q;" | jq -c '.[0].results[0]')" "$S2"

echo
echo "== 旧方式导入、可库里的题和文件对不上：不补记 =="
exec_sql "DELETE FROM seed_state WHERE name = 'group:biochem-ch01-v2';
  INSERT INTO seed_state (name, sha) VALUES ('biochem-002-biochem-ch01-v2.sql', 'legacy');"
drop_questions "question_id = (SELECT question_id FROM questions WHERE exam_id = 'biochem-ch01-v2' ORDER BY ord DESC LIMIT 1)"
seed_run
check "导题库没有中断" "$SEED_RC" "0"
check "拒绝了这个文件" "$(refused)" "biochem-ch01-v2"
check "  理由说的是题目编号对不上" "$(reason_of biochem-ch01-v2 | grep -c '对不上')" "1"
check "没有补记指纹" "$(gfp biochem-ch01-v2)" ""
check "旧记录还在（等人处理）" \
  "$(one "SELECT COUNT(*) FROM seed_state WHERE name = 'biochem-002-biochem-ch01-v2.sql';")" "1"
rm -f "$BOX/$BIO/groups/biochem-ch01-v2.json"
exec_sql "DELETE FROM seed_state WHERE name = 'biochem-002-biochem-ch01-v2.sql';"

echo
echo "== 库里有这一章、却没有任何导入记录 =="
exec_sql "DELETE FROM seed_state WHERE name = 'group:00015-2024-04';"
seed_run
check "拒绝了这个文件" "$SEED_RC/$(refused)" "0/00015-2024-04"
check "  理由说的是没有导入记录" "$(reason_of 00015-2024-04 | grep -c '导入记录')" "1"
check "没有替它补记指纹" "$(gfp 00015-2024-04)" ""
exec_sql "INSERT INTO seed_state (name, sha) VALUES ('group:00015-2024-04', '$(file_sha "$BOX/$EN/groups/00015-2024-04.json")');"

echo
echo "== 新文件撞上了后台上传的内容组 =="
exec_sql "INSERT INTO exams (exam_id, course_code, title, label, order_key, meta, year, month, source_file, status, origin)
  VALUES ('up-h4', 'biochem-main', '上传的', '__上传哨兵__', 9999, NULL, 0, 0, 'x.docx', '待校对', 'UPLOAD');"
clone_group "$BF" up-h4 new
seed_run
check "拒绝了这个文件" "$SEED_RC/$(refused)" "0/up-h4"
check "  理由说的是撞上了后台上传的" "$(reason_of up-h4 | grep -c '上传')" "1"
check "上传的那一章没被动过" "$(one "SELECT label || '/' || origin FROM exams WHERE exam_id = 'up-h4';")" "__上传哨兵__/UPLOAD"
rm -f "$BOX/$BIO/groups/up-h4.json"

echo
echo "== 有导入记录、库里却没有这一章 =="
clone_group "$BF" biochem-ch01-v3 new
seed_run
check "（前提）先正常导进来" "$SEED_RC/$(imported)/$(one "SELECT COUNT(*) FROM exams WHERE exam_id = 'biochem-ch01-v3';")" "0/1/1"
drop_questions "exam_id = 'biochem-ch01-v3'"
exec_sql "DELETE FROM exam_parsing_notes WHERE exam_id = 'biochem-ch01-v3';
  DELETE FROM sections WHERE exam_id = 'biochem-ch01-v3'; DELETE FROM exams WHERE exam_id = 'biochem-ch01-v3';"
seed_run
check "不悄悄重导，拒绝并说出来" "$SEED_RC/$(refused)/$(imported)" "0/biochem-ch01-v3/0"
check "  理由说的是库里却没有这一章" "$(reason_of biochem-ch01-v3 | grep -c '库里却没有这一章')" "1"
rm -f "$BOX/$BIO/groups/biochem-ch01-v3.json"
exec_sql "DELETE FROM seed_state WHERE name = 'group:biochem-ch01-v3';"

echo
echo "== 绕过脚本、手动执行种子 SQL：也覆盖不了已导入的章节 =="
ENF=$(ls seed/english-*-13000-2025-10.sql)
npx wrangler d1 execute "$D1_NAME" --local --file="$ENF" > "$WORK/manual.log" 2>&1
check "整个文件执行失败" "$?" "1"
check "  失败在编号冲突上" "$(grep -ciE 'UNIQUE|PRIMARY KEY|constraint' "$WORK/manual.log" | awk '{print ($1>0)}')" "1"
check "后台改过的题面还在" "$(one "SELECT substr(stem, 1, 6) FROM questions WHERE question_id = '$QE';")" "【后台改过】"

echo
echo "== 没有人接着报的时候（没给拒绝清单），导题库自己红 =="
edit_stem "$EF" "$QE"
SEED_LOCAL=1 bash ../scripts/ci/seed-if-changed.sh > "$SEED_LOG" 2>&1
check "有拒绝、又没处可记：退出码非 0" "$?" "1"
cp "$WORK/en.bak" "$EF"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
