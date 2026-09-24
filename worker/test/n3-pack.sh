#!/usr/bin/env bash
# N3 学科能力包：题型声明、评价标准、AI 提示词、参数覆盖。
#
# 重点不是"能读到配置"，而是"改了配置行为真的跟着变"。只断言"英语判分还是对的"
# 证明不了任何事——写死的代码同样能让它通过。所以每条都配一对：默认配置下是 A，
# 改掉配置之后变成 B。变不动的那条就是还写死在代码里。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8790          # 端口表见 CLAUDE.md
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

sql()  { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
exec_sql() { npx wrangler d1 execute "$D1_NAME" --local --command "$1" >/dev/null 2>&1; }
one()  { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
adm()  { curl -s -H "Authorization: Bearer $ADMIN" "$@"; }
admj() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }
stu()  { curl -s -H "Authorization: Bearer $STU" "$@"; }

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n3
SETUP_TOKEN=test-setup-n3
ENCRYPTION_KEY=test-encryption-key-n3
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/n3-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n3' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ "$ADMIN" != "null" ] && [ -n "$ADMIN" ] || { echo "管理员登录失败"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"P001","password":"student12345","subjects":["english"]}'
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"P001","password":"student12345"}' | jq -r '.token')
[ "$STU" != "null" ] && [ -n "$STU" ] || { echo "学员登录失败"; exit 1; }

ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")
BIO=$(one "SELECT subject_id FROM subjects WHERE code='biochem';")
SID=$(one "SELECT id FROM users WHERE username='P001';")

echo
echo "== 能力包接口 =="
adm -o /tmp/n3-pack.json "$BASE/admin/subjects/$ENG/pack"
check "能力包接口返回题型" "$(jq -r '.questionTypes | length > 0' /tmp/n3-pack.json)" "true"
# 期望值从库里现算，不写死 3——将来加题型这条不该跟着红
check "题型数与库里一致" "$(jq -r '.questionTypes | length' /tmp/n3-pack.json)" \
  "$(one "SELECT COUNT(*) FROM subject_question_types WHERE subject_id=$ENG;")"
check "有生效中的评价标准" "$(jq -r '.currentRubric.version' /tmp/n3-pack.json)" "1"
check "四类提示词都在" "$(jq -r '[.prompts[] | select(.missing != true)] | length' /tmp/n3-pack.json)" "4"
check "英语的提示词是自己的，不是继承的" \
  "$(jq -r '[.prompts[] | select(.fromGlobal == true)] | length' /tmp/n3-pack.json)" "0"
# 原来这条把注册表的全部名字写死比对，每加一个能力就红一次，而红了之后正确的做法
# 永远是改期望值——这种断言不提供信号。界面要的其实是两件事：
# 列表非空（不然管理员点不出任何归一化器），以及**它与代码里的注册表一致**
# （前端拿到一个后端不认的名字，保存时才报 unknown_normalizer）。
AVAIL=$(jq -r '.availableNormalizers | sort | join(",")' /tmp/n3-pack.json)
check "归一化器列表不是空的" "$([ -n "$AVAIL" ] && echo 有 || echo 无)" "有"
check "界面拿到的列表与代码里的注册表一致" "$AVAIL" \
  "$(node -e "import('$ROOT_DIR/src/normalizers/index.js').then(m=>console.log(Object.keys(m.NORMALIZERS).sort().join(',')))")"
check "不存在的学科返回 404" \
  "$(adm -o /dev/null -w '%{http_code}' "$BASE/admin/subjects/99999/pack")" "404"

echo
echo "== 参数覆盖：学科 → 全局 =="
check "没覆盖时生效值等于全局值" \
  "$(jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | (.effective == .globalValue)' /tmp/n3-pack.json)" "true"
admj -o /dev/null -X PUT "$BASE/admin/subjects/$ENG/pack/settings" \
  -d '{"settings":[{"key":"practice.diagnostic_batch_size","value":"7"}]}'
adm -o /tmp/n3-pack2.json "$BASE/admin/subjects/$ENG/pack"
check "覆盖之后生效值变成覆盖值" \
  "$(jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | .effective' /tmp/n3-pack2.json)" "7"
check "全局值本身没被改掉" \
  "$(jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | .globalValue' /tmp/n3-pack2.json)" "40"
check "生化不受英语的覆盖影响" \
  "$(adm "$BASE/admin/subjects/$BIO/pack" | jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | .effective')" "40"
# 覆盖一个不存在的参数不会报错，只会永远不生效——那是最难查的一类"配了但没用"
CODE=$(admj -o /tmp/n3-badset.json -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/settings" \
  -d '{"settings":[{"key":"no.such.key","value":"1"}]}')
check "覆盖不存在的参数被拒" "$CODE" "400"
check "拒绝的理由说清楚了" "$(jq -r '.error' /tmp/n3-badset.json)" "unknown_setting"
# 恢复，免得影响后面的练习用例
admj -o /dev/null -X PUT "$BASE/admin/subjects/$ENG/pack/settings" -d '{"settings":[]}'

echo
echo "== 题型声明真的在起作用（不是写死的） =="
# 蓝本三处写死 question_type != 'essay'。下面这对断言才能区分"读配置"和"写死"。
#
# 先把写作题放行：种子里它是"存疑"状态（官方没给分项评分细则），而"存疑"本来就
# 不参与抽题。不先处理的话，"写作不在可练题型里"这条恒真——它是因为没发布才不在，
# 跟题型声明没关系，测出来的是题库状态不是被测逻辑。
exec_sql "UPDATE questions SET status='已发布' WHERE course_code='13000' AND question_type='essay';"
ESSAY_N=$(one "SELECT COUNT(*) FROM questions WHERE course_code='13000' AND question_type='essay' AND status='已发布';")
check "库里确实有已发布的写作题（决定可达性的那个属性）" "$([ "${ESSAY_N:-0}" -gt 0 ] && echo yes || echo no)" "yes"
echo "     （已发布的写作题 $ESSAY_N 道）"
check "默认：写作不在可练题型里" \
  "$(stu "$BASE/practice/section-types?courseCode=13000" | jq -r '[.sectionTypes[].section_type] | index("写作") // "absent"')" "absent"
exec_sql "UPDATE subject_question_types SET in_practice=1 WHERE subject_id=$ENG AND type_code='essay';"
check "把写作改成可练之后，它出现在可练题型里" \
  "$(stu "$BASE/practice/section-types?courseCode=13000" | jq -r '[.sectionTypes[].section_type] | index("写作") != null')" "true"
exec_sql "UPDATE subject_question_types SET in_practice=0 WHERE subject_id=$ENG AND type_code='essay';"
check "改回去之后又消失了" \
  "$(stu "$BASE/practice/section-types?courseCode=13000" | jq -r '[.sectionTypes[].section_type] | index("写作") // "absent"')" "absent"
# 反方向：关掉一个本来能练的，练习范围要跟着缩小，打开又回来
BEFORE_Q=$(stu "$BASE/practice/scope?courseCode=13000" | jq -r '.questionCount')
exec_sql "UPDATE subject_question_types SET in_practice=0 WHERE subject_id=$ENG AND type_code='single_choice';"
AFTER_Q=$(stu "$BASE/practice/scope?courseCode=13000" | jq -r '.questionCount')
check "关掉选择题之后可练题数变少" "$([ "$AFTER_Q" -lt "$BEFORE_Q" ] && echo yes || echo no)" "yes"
echo "     （$BEFORE_Q 题 → $AFTER_Q 题）"
exec_sql "UPDATE subject_question_types SET in_practice=1 WHERE subject_id=$ENG AND type_code='single_choice';"
check "打开之后题数回到原值" "$(stu "$BASE/practice/scope?courseCode=13000" | jq -r '.questionCount')" "$BEFORE_Q"

echo
echo "== 判分读的是声明的归一化器 =="
# 自己造一道答案为 traveled 的填空题，配一个只有它用的考点——
# 从真实题库里挑的话，挑到的题不一定有英美拼写变体，测出来的是题库内容不是判分。
exec_sql "INSERT INTO courses (course_code, course_name, subject_id) VALUES ('NRM','归一化器测试课', $ENG);
  INSERT INTO exams (exam_id, course_code, title, year, month) VALUES ('nrm-e','NRM','t',2026,4);
  INSERT INTO sections (section_id, exam_id, type, ord) VALUES ('nrm-s','nrm-e','完形填空',1);
  INSERT INTO questions (question_id,section_id,exam_id,course_code,section_type,ord,question_type,answer,status,answer_state,answer_source,subject_id)
    VALUES ('nrm-q','nrm-s','nrm-e','NRM','完形填空',1,'fill_text','traveled','已发布','已确认','MANUAL',$ENG);
  INSERT INTO knowledge_points (tag_id,name,subject_id) VALUES ('nrm-kp','归一化器测试考点',$ENG);
  INSERT INTO question_knowledge_points (question_id,tag_id) VALUES ('nrm-q','nrm-kp');"
exec_sql "INSERT OR IGNORE INTO user_subject_grants (user_id,subject_id) VALUES ($SID,$ENG);"

# 起一次单考点专项，取下一题，对它作答，返回 isCorrect。
# /next 这一步不能省：答题接口要求题目先落进 attempt_questions，直接提交会 404。
answer_nrm() {
  local A Q
  A=$(curl -s -X POST "$BASE/practice/drill" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d '{"courseCode":"NRM","tagId":"nrm-kp"}' | jq -r '.attemptId')
  [ "$A" != "null" ] && [ -n "$A" ] || { echo "no-attempt"; return; }
  Q=$(curl -s "$BASE/practice/$A/next" -H "Authorization: Bearer $STU" | jq -r '.question.questionId // empty')
  [ "$Q" = "nrm-q" ] || { echo "wrong-question:${Q:-none}"; return; }
  # 取不到判分结果时把接口实际返回的错误码带出来。只回一句 no-verdict 的话，
  # 将来这条变红只知道"流程断了"，不知道断在哪——而那正是证伪时最需要区分的：
  # 是判得不一样（红对了），还是整条路走不通（红错了）。
  curl -s -X POST "$BASE/practice/$A/answer" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg a "$1" '{questionId:"nrm-q",answer:$a}')" \
    | jq -r 'if .isCorrect != null then .isCorrect else "no-verdict(\(.error // "无 error 字段")):\(.message // "")" end'
}
check "原样答对"                        "$(answer_nrm traveled)"   "1"
check "大小写不影响（基础折叠）"         "$(answer_nrm TRAVELED)"   "1"
check "英式拼写判对（en-spelling 生效）" "$(answer_nrm travelled)"  "1"
check "答错的仍然判错"                   "$(answer_nrm travelling)" "0"

# 这一对才是关键：摘掉归一化器之后，同一个英式拼写就该判错。
# 变不动的话说明拼写表还写死在判分代码里，声明只是摆设。
exec_sql "UPDATE subject_question_types SET normalizers='[]' WHERE subject_id=$ENG AND type_code='fill_text';"
check "摘掉 en-spelling 之后英式拼写判错" "$(answer_nrm travelled)" "0"
check "摘掉之后原样答仍然判对（没把基础折叠一起弄丢）" "$(answer_nrm traveled)" "1"
exec_sql "UPDATE subject_question_types SET normalizers='[\"en-spelling\"]' WHERE subject_id=$ENG AND type_code='fill_text';"
check "装回去之后英式拼写又判对了" "$(answer_nrm travelled)" "1"

echo
echo "== 归一化器名字写错要当场拒绝 =="
CODE=$(admj -o /tmp/n3-badnorm.json -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/types" \
  -d '{"questionTypes":[{"typeCode":"single_choice","name":"单选","isObjective":true,"inPractice":true,"needsAi":false,"inputWidget":"choice","normalizers":["no-such-thing"]}]}')
check "引用不存在的归一化器被拒" "$CODE" "400"
check "报错里指出是哪个名字" "$(jq -r '.problems | join(" ")' /tmp/n3-badnorm.json | grep -c 'no-such-thing')" "1"
CODE=$(admj -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/types" -d '{"questionTypes":[]}')
check "一种题型都不留被拒（那样学科会瘫掉）" "$CODE" "400"

echo
echo "== 评价标准：改是新开一版，不是原地改 =="
RUBRIC=$(adm "$BASE/admin/subjects/$ENG/pack" | jq -c '.currentRubric.payload | fromjson')
NEW=$(echo "$RUBRIC" | jq -c '.mastery.masteredMinStreak = 4')
admj -o /tmp/n3-rub.json -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" \
  -d "$(jq -n --argjson p "$NEW" '{payload:$p}')"
check "存成了第 2 版" "$(jq -r '.version' /tmp/n3-rub.json)" "2"
check "旧版还在" "$(one "SELECT COUNT(*) FROM subject_rubrics WHERE subject_id=$ENG;")" "2"
check "生效的只有一版" "$(one "SELECT COUNT(*) FROM subject_rubrics WHERE subject_id=$ENG AND is_current=1;")" "1"
check "生效的是新的那版" "$(one "SELECT version FROM subject_rubrics WHERE subject_id=$ENG AND is_current=1;")" "2"

echo
echo "== 评价标准写歪了要当场拒绝 =="
bad_rubric() {  # $1 = jq 表达式
  admj -o /tmp/n3-badrub.json -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" \
    -d "$(jq -n --argjson p "$(echo "$RUBRIC" | jq -c "$1")" '{payload:$p}')"
}
# 合计 1.2 的话分数整体虚高 20%，而批改照常"成功"
check "维度权重合计不等于 1 被拒" "$(bad_rubric '.essay.dimensions[0].weight = 0.5')" "400"
check "拒绝时逐条说明" "$(jq -r '.problems | join(" ")' /tmp/n3-badrub.json | grep -c '权重合计')" "1"
# 没有兜底档时 tagWeight 会抛错，表现为练习抽不出题，而配置界面当时什么都没说
check "byStreak 没有兜底档被拒" "$(bad_rubric '.mastery.weights.byStreak = [{"upTo":1,"weight":2}]')" "400"
check "认不出的 essay.type 被拒" "$(bad_rubric '.essay.type = "SOMETHING_ELSE"')" "400"
check "不是合法 JSON 被拒" \
  "$(admj -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" -d '{"payload":"{不是json"}')" "400"

echo
echo "== 掌握度阈值读的是评价标准 =="
# 造一条"连对 3 次、做过 3 题"的掌握度记录。默认阈值（连对≥3 且做过≥3）下是"已掌握"
TAG=$(one "SELECT tag_id FROM knowledge_points WHERE subject_id=$ENG LIMIT 1;")
exec_sql "INSERT OR REPLACE INTO user_knowledge_mastery
  (user_id, course_code, tag_id, correct_count, wrong_count, consecutive_correct, last_result)
  VALUES ($SID, '13000', '$TAG', 3, 0, 3, 'correct');"
tier_now() { adm "$BASE/admin/stats/students/$SID" | jq -r --arg t "$(one "SELECT name FROM knowledge_points WHERE tag_id='$TAG';")" '.mastery[] | select(.name==$t) | .tier'; }
# 上一段已经把 masteredMinStreak 改成 4 并生效了，所以现在应当**不是**"已掌握"
check "阈值调高到连对 4 次之后，连对 3 次不算已掌握" "$(tier_now)" "待巩固"
# 调回 3，同一条数据应当变回"已掌握"——这一对才证明它读的是配置
BACK=$(echo "$RUBRIC" | jq -c '.mastery.masteredMinStreak = 3')
admj -o /dev/null -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" -d "$(jq -n --argjson p "$BACK" '{payload:$p}')"
check "阈值调回 3 之后，同一条数据变成已掌握" "$(tier_now)" "已掌握"

echo
echo "== AI 提示词：学科 → 全局兜底 =="
CODE=$(adm -o /tmp/n3-del.json -w '%{http_code}' -X DELETE "$BASE/admin/subjects/$ENG/pack/prompts/wrong_analyze")
check "删掉学科自己的那条" "$CODE" "200"
check "回落到全局" \
  "$(adm "$BASE/admin/subjects/$ENG/pack" | jq -r '.prompts[] | select(.feature=="wrong_analyze") | .fromGlobal')" "true"
# 全局兜底也没了的话，这个功能下一次调用会抛 prompt_missing，所以不许删
exec_sql "DELETE FROM subject_ai_prompts WHERE subject_id=0 AND feature='assessment';"
CODE=$(adm -o /tmp/n3-nofb.json -w '%{http_code}' -X DELETE "$BASE/admin/subjects/$ENG/pack/prompts/assessment")
check "全局没有兜底时不许删学科自己的" "$CODE" "409"
check "拒绝的理由说清楚了" "$(jq -r '.error' /tmp/n3-nofb.json)" "no_global_fallback"
CODE=$(admj -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/subjects/$ENG/pack/prompts/nonexistent" \
  -d '{"systemPrompt":"x","userTemplate":"y"}')
check "认不出的功能名被拒" "$CODE" "400"

echo
echo "== 题型校验：CHECK 去掉了，校验挪到发布路径 =="
exec_sql "INSERT INTO courses (course_code, course_name, subject_id) VALUES ('PKT','能力包测试课', $ENG);
  INSERT INTO exams (exam_id, course_code, title, year, month) VALUES ('pk-e','PKT','t',2026,4);
  INSERT INTO sections (section_id, exam_id, type, ord) VALUES ('pk-s','pk-e','完形填空',1);
  INSERT INTO questions (question_id,section_id,exam_id,course_code,section_type,ord,question_type,answer,answer_state,answer_source,subject_id)
    VALUES ('pk-q1','pk-s','pk-e','PKT','完形填空',1,'no_such_type','a','已确认','MANUAL',$ENG);"
# 先确认它确实入库了：CHECK 已经不在表上了，校验靠的是发布那一关
check "未声明的题型能写进库（CHECK 确实去掉了）" "$(one "SELECT COUNT(*) FROM questions WHERE question_id='pk-q1';")" "1"
CODE=$(adm -o /tmp/n3-pub.json -w '%{http_code}' -X POST "$BASE/admin/bank/exams/pk-e/publish")
check "发布被拒" "$CODE" "422"
check "错误码是 question_type_not_declared" "$(jq -r '.error' /tmp/n3-pub.json)" "question_type_not_declared"
check "说清楚是哪一道题、什么题型" "$(jq -r '.message' /tmp/n3-pub.json | grep -c 'no_such_type')" "1"
check "被拒时题目没有被发布出去" "$(one "SELECT status FROM questions WHERE question_id='pk-q1';")" "草稿"
# 声明这个题型之后，同一卷就能发布——这一对才证明拦的是"没声明"而不是别的
exec_sql "INSERT INTO subject_question_types (subject_id,type_code,name,input_widget,normalizers,sort_order)
          VALUES ($ENG,'no_such_type','临时题型','text','[]',9);"
CODE=$(adm -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/exams/pk-e/publish")
check "声明之后同一卷能发布" "$CODE" "200"
exec_sql "DELETE FROM subject_question_types WHERE subject_id=$ENG AND type_code='no_such_type';"

echo
echo "== 没有能力包的学科要报错，不能静默套用别人的规则 =="
exec_sql "INSERT INTO subjects (code,name,sort_order) VALUES ('nopack','没配包的学科',99);
  INSERT INTO courses (course_code,course_name,subject_id)
    VALUES ('NOPK','没配包的课程',(SELECT subject_id FROM subjects WHERE code='nopack'));"
NOPK=$(one "SELECT subject_id FROM subjects WHERE code='nopack';")
exec_sql "INSERT OR IGNORE INTO user_subject_grants (user_id,subject_id) VALUES ($SID,$NOPK);"
CODE=$(stu -o /tmp/n3-nopack.json -w '%{http_code}' "$BASE/practice/scope?courseCode=NOPK")
check "练习范围接口报错而不是返回 0 题" "$([ "$CODE" = "200" ] && echo "静默通过了" || echo "报错了")" "报错了"
check "能力包缺失的学科在后台看得出来" \
  "$(adm "$BASE/admin/subjects/$NOPK/pack" | jq -r '.questionTypes | length')" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
