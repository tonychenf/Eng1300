#!/usr/bin/env bash
# N3：线上旧库重建脚本（scripts/ci/rebuild-legacy-schema.sh）的测试。不需要起服务。
#
# 这个脚本只在**线上那个 N0 时期建的库**上真正动手。本地跑测试每次都是新库、
# 天生就是新结构，脚本一律跳过——也就是说正常回归永远走不到它的主路径。
# 所以这里先按 test/fixtures/legacy-schema.sql 把库退回旧结构，再让脚本去处理。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
SCRIPT="$ROOT_DIR/../scripts/ci/rebuild-legacy-schema.sh"

PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
sql()  { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one()  { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
ddl()  { sql "SELECT sql FROM sqlite_master WHERE type='table' AND name='$1'" | jq -r '.[0].results[0].sql // empty'; }
has()  { ddl "$1" | grep -qF "$2" && echo yes || echo no; }
exists() { [ -n "$(ddl "$1")" ] && echo yes || echo no; }
migrate() {
  for m in migrations/*.sql; do
    npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "$m"; return 1; }
  done
  return 0
}

cleanup() { rm -rf "$ROOT_DIR/.wrangler"; }
trap cleanup EXIT

echo "== 把库退回线上那个库的样子 =="
rm -rf .wrangler
# 先跑完整迁移把周边表建齐，再把这三张换成旧结构。
# 反过来做不行：0002 里 idx_questions_subject 建在 subject_id 上，旧表没这一列，
# 迁移当场就断——这正是线上会遇到的情形，也是重建必须排在迁移之前的原因。
BAD=$(migrate) || { echo "初始迁移失败：$BAD"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --command "
  DROP TABLE questions; DROP TABLE knowledge_points; DROP TABLE ai_settings;
" >/dev/null 2>&1 || { echo "拆掉新结构失败"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/legacy-schema.sql >/dev/null 2>&1 \
  || { echo "旧结构固定件导入失败"; exit 1; }

# 造数据：题库、考点、关联、AI 配置，外加一份作答记录。
# 作答记录是重点——它引用 questions，不清掉的话 DROP 一定失败。
npx wrangler d1 execute "$D1_NAME" --local --command "
  INSERT INTO users (username, password_hash, role) VALUES ('RBUSER','x','USER');
  INSERT INTO courses (course_code, course_name, subject_id)
    VALUES ('RBT','重建测试课程',(SELECT subject_id FROM subjects WHERE code='english'));
  INSERT INTO exams (exam_id,course_code,title,year,month) VALUES ('rb-e','RBT','t',2026,4);
  INSERT INTO sections (section_id,exam_id,type,ord) VALUES ('rb-s','rb-e','完形填空',1);
  INSERT INTO questions (question_id,section_id,exam_id,course_code,section_type,ord,question_type,answer,status)
    VALUES ('rb-q1','rb-s','rb-e','RBT','完形填空',1,'single_choice','A','已发布'),
           ('rb-q2','rb-s','rb-e','RBT','完形填空',2,'fill_blank_transform','quickly','已发布');
  INSERT INTO knowledge_points (tag_id,name,category) VALUES ('rb-kp','副词构词','语法');
  INSERT INTO question_knowledge_points (question_id,tag_id) VALUES ('rb-q1','rb-kp');
  INSERT INTO attempts (attempt_id,user_id,course_code,mode,status)
    VALUES ('rb-a',(SELECT id FROM users WHERE username='RBUSER'),'RBT','EXAM','已交卷');
  INSERT INTO answer_records (attempt_id,question_id,user_answer,is_correct)
    VALUES ('rb-a','rb-q1','A',1);
  INSERT INTO ai_settings (purpose,base_url,api_key_encrypted,model)
    VALUES ('TUTORING','http://x/v1','ENC-KEY-DO-NOT-LOSE','m1'),
           ('PARSING','http://y/v1','ENC-KEY-2','m2');
" >/dev/null 2>&1 || { echo "造数据失败"; exit 1; }

echo
echo "== 重建前：确认它确实是旧结构（否则下面全是空测） =="
check "questions 带着题型 CHECK"                 "$(has questions 'CHECK (question_type IN')" "yes"
check "questions 没有 subject_id 列"             "$(has questions 'subject_id')" "no"
check "knowledge_points 的 name 是全局 UNIQUE"   "$(has knowledge_points 'name TEXT NOT NULL UNIQUE')" "yes"
check "ai_settings 主键只有 purpose"             "$(has ai_settings 'purpose TEXT PRIMARY KEY')" "yes"
# 前置确认：旧结构下迁移确实跑不过。这条不立住，"重建之后能跑通"就证明不了是重建的功劳
check "旧结构下整套迁移跑不过（重建必须排在迁移之前的理由）" \
  "$(migrate >/dev/null 2>&1 && echo ok || echo err)" "err"
A_BEFORE=$(one "SELECT COUNT(*) FROM ai_settings;")
USERS_BEFORE=$(one "SELECT COUNT(*) FROM users;")
SUBJ_BEFORE=$(one "SELECT COUNT(*) FROM subjects;")

echo
echo "== 跑重建脚本 =="
OUT1=$(bash "$SCRIPT" --local 2>&1)
echo "$OUT1" | grep -E '^(旧结构重建|  [+-]{2}|       )' | sed 's/^/     /'
check "脚本认出了三张旧表" "$(echo "$OUT1" | grep -c 'questions=1 knowledge_points=1 ai_settings=1')" "1"

echo
echo "== ai_settings：原地换结构，两行都保住 =="
check "改成复合主键"            "$(has ai_settings 'PRIMARY KEY (purpose, subject_id)')" "yes"
check "行数不变"                "$(one "SELECT COUNT(*) FROM ai_settings;")" "$A_BEFORE"
# 搬丢加密 Key 的话线上 AI 全废，而且直到有人用才发现
check "加密的 API Key 原样带过来" \
  "$(one "SELECT api_key_encrypted FROM ai_settings WHERE purpose='TUTORING';")" "ENC-KEY-DO-NOT-LOSE"
check "旧的全局配置落在 subject_id=0" "$(one "SELECT COUNT(*) FROM ai_settings WHERE subject_id=0;")" "$A_BEFORE"

echo
echo "== questions / knowledge_points：拆掉，等迁移重建 =="
check "旧的 questions 已拆掉"        "$(exists questions)" "no"
check "旧的 knowledge_points 已拆掉" "$(exists knowledge_points)" "no"
check "作答记录已清空"               "$(one "SELECT COUNT(*) FROM answer_records;")" "0"
check "模考记录已清空"               "$(one "SELECT COUNT(*) FROM attempts;")" "0"

echo
echo "== 只清可重新生成的数据，账号与学科不动 =="
check "账号一个没少"   "$(one "SELECT COUNT(*) FROM users;")" "$USERS_BEFORE"
check "学科一个没少"   "$(one "SELECT COUNT(*) FROM subjects;")" "$SUBJ_BEFORE"
check "课程还在"       "$(one "SELECT course_name FROM courses WHERE course_code='RBT';")" "重建测试课程"

echo
echo "== 重建之后，迁移能跑通了 =="
BAD=$(migrate) && M_OK=ok || M_OK="断在 $BAD"
check "整套迁移跑通"                  "$M_OK" "ok"
check "questions 按新结构重建出来了"  "$(exists questions)" "yes"
check "题型 CHECK 没了"               "$(has questions 'CHECK (question_type IN')" "no"
check "questions 有了 subject_id"     "$(has questions 'subject_id')" "yes"
check "状态 CHECK 还在（不该顺手删别的约束）" "$(has questions 'CHECK (status IN')" "yes"
check "knowledge_points 的全局 UNIQUE 降级了" "$(has knowledge_points 'name TEXT NOT NULL UNIQUE')" "no"

echo
echo "== 降级之后：两个学科可以有同名考点，同学科内仍然不许 =="
ins_kp() {
  npx wrangler d1 execute "$D1_NAME" --local --command \
    "INSERT INTO knowledge_points (tag_id,name,subject_id) VALUES ('$1','$2',(SELECT subject_id FROM subjects WHERE code='$3'))" \
    >/dev/null 2>&1 && echo ok || echo err
}
check "英语放一个'结构'"      "$(ins_kp rb-k1 结构 english)" "ok"
check "生化也能放一个'结构'"  "$(ins_kp rb-k2 结构 biochem)" "ok"
check "英语再放一个'结构'被拒" "$(ins_kp rb-k3 结构 english)" "err"

echo
echo "== 再跑一次：必须是空操作 =="
npx wrangler d1 execute "$D1_NAME" --local --command \
  "INSERT INTO attempts (attempt_id,user_id,course_code,mode,status) VALUES ('rb-a2',(SELECT id FROM users WHERE username='RBUSER'),'RBT','EXAM','已交卷')" >/dev/null 2>&1
OUT2=$(bash "$SCRIPT" --local 2>&1)
echo "$OUT2" | sed 's/^/     /'
check "报告跳过、零写入" "$(echo "$OUT2" | grep -c '跳过，零写入')" "1"
# 这条才是重点：第二次要是照样清一遍，每次部署都会把学员的作答记录抹掉，
# 而且不报错——日志里只会多一行"完成"
check "第二次没有再清作答记录" "$(one "SELECT COUNT(*) FROM attempts;")" "1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
