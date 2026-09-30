#!/usr/bin/env bash
# 线上端到端实测，两段：
#   一、上传出题：管理员传一份 4 道题的小 docx，让 AI 出答案和解析，核对落库，然后删掉（CR-M4）
#   二、英语作答：拿探针账号真的组一次卷、答一遍、交卷、跑一次 AI，再看错题本与能力评估
#
# 为什么非要在 GitHub Actions 里跑：开发沙箱的出站策略拒绝 workers.dev，
# 本机连不上线上；而这条链路里的 AI 调用又连不上真实服务商，本地只能用替身。
# 替身返回什么形状是我们自己写的，证明不了真实模型的输出扛不扛得住解析。
#
# 脚本本身由 worker/test/prod-e2e-local.sh 对本地服务 + 替身整个跑一遍（进全套回归）：
# XLearn 复制过来之后它一次都没跑成过，就是因为平时没有任何东西会跑它。
#
# 需要：WORKER_URL、ADMIN_TOKEN。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok()   { echo "  OK   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

A=(-H "Authorization: Bearer $ADMIN_TOKEN")
api() { curl -sS -m 60 "$@"; }

echo "== 上传出题：AI 出答案与解析（真实服务商） =="
# 管理员传一章 → AI 给每道题出候选答案和解析 → 落在待核（CR-M4）。这条链路以前只对本地替身
# 跑过：替身按我们要的形状瞬间返回，真实模型的返回结构和时延它都证明不了。
# 样本是生化第 1 章原件里摘的 4 道题，四种题型各一道（生成方法见 make-e2e-sample.mjs）。
# 跑完删掉，线上不留测试章节。
SAMPLE="$SCRIPT_DIR/fixtures/prod-e2e-sample.docx"
GID=e2e-probe
del_probe() {
  curl -sS -m 30 -o /dev/null -w '%{http_code}' -X DELETE "$WORKER_URL/api/admin/bank/exams/$GID" "${A[@]}"
}
# 上次跑到一半断掉的话测试章节还在，这次上传会撞 id。先清一次；没有就是 404，不算错
PRE=$(del_probe)
case "$PRE" in
  200) echo "  清掉了上次留下的测试章节" ;;
  404) ;;
  *)   bad "开跑前清不掉上次留下的测试章节（HTTP $PRE）" ;;
esac
# 中途失败也要收拾（正常路径下面会显式删一次并断言，这里只是兜底）
trap 'del_probe >/dev/null 2>&1 || true' EXIT

SETTINGS=$(api "$WORKER_URL/api/admin/ai/settings" "${A[@]}")
if [ "$(echo "$SETTINGS" | jq -r '.settings.TEXT_PARSING.hasKey // false')" != "true" ]; then
  # 没配的话会退回「图片解析」那档（OCR 模型）。先拦下来，不白花这几次调用的钱
  bad "「文字解析 AI」没配，上传出题会退回图片解析那档——这一段不调 AI"
else
  echo "     文字解析的模型：$(echo "$SETTINGS" | jq -r '.settings.TEXT_PARSING.model')"
  LABEL=$(jq -rn --arg s '线上实测探针（跑完自动删除）' '$s|@uri')
  UP=$(curl -sS -m 60 -X POST \
    "$WORKER_URL/api/admin/bank/import?subjectCode=biochem&groupId=$GID&label=$LABEL&orderKey=9999&filename=prod-e2e-sample.docx" \
    "${A[@]}" -H 'Content-Type: application/octet-stream' --data-binary "@$SAMPLE")
  check "样本上传成功" "$(echo "$UP" | jq -r '.ok // false')" "true"
  # 4 道、2 个空是样本本身的内容（生成脚本里核过），线上解析出别的数就是 Worker 里解析走样了
  check "解析出 4 道题、2 个空" "$(echo "$UP" | jq -r '"\(.questions)/\(.blanks)"')" "4/2"

  T0=$(date +%s)
  GEN=$(curl -sS -m 180 -X POST "$WORKER_URL/api/admin/bank/exams/$GID/ai-answers" "${A[@]}")
  T1=$(date +%s)
  # 时延是替身的盲区之一，打出来留档
  echo "     AI 出答案耗时 $((T1 - T0)) 秒；原始返回：$(echo "$GEN" | head -c 400)"
  check "用的是文字解析那一档，没有退回图片解析" \
    "$(echo "$GEN" | jq -r '"\(.purpose)/\(.purposeFellBack)"')" "TEXT_PARSING/false"
  check "4 道全部生成（生成/尝试）" "$(echo "$GEN" | jq -r '"\(.generated)/\(.attempted)"')" "4/4"
  check "没有生成失败的题" "$(echo "$GEN" | jq -r '.failures | length')" "0"
  [ "$(echo "$GEN" | jq -r '.failures | length')" = "0" ] \
    || echo "     失败明细：$(echo "$GEN" | jq -c '.failures' | head -c 800)"
  check "每道都带了解析" "$(echo "$GEN" | jq -r '.withoutExplanation | length')" "0"

  # 回库核对：接口说"生成了"不等于库里真有，也不等于形状对
  REV=$(api "$WORKER_URL/api/admin/bank/exams/$GID" "${A[@]}")
  Q_ALL='[.sections[].questions[]]'
  check "全部落在待核，没有一道直接当真" \
    "$(echo "$REV" | jq -r "$Q_ALL | map(select(.answer_state != \"待核\")) | length")" "0"
  check "来源都标成 AI" "$(echo "$REV" | jq -r "$Q_ALL | map(select(.answer_source != \"AI\")) | length")" "0"
  check "解析都不是一两个字的敷衍" \
    "$(echo "$REV" | jq -r "$Q_ALL | map(select((.answer_explanation // \"\") | length < 8)) | length")" "0"
  check "填空题每个空都有答案" \
    "$(echo "$REV" | jq -r "$Q_ALL | map(select(.question_type == \"fill_text\") | .items[] | select((.answer // \"\") == \"\")) | length")" "0"
  check "选择题的答案是一个选项字母" \
    "$(echo "$REV" | jq -r "$Q_ALL | map(select(.question_type == \"single_choice\") | (.answer // \"\")) | map(test(\"^[A-D]\$\")) | (length > 0 and all)")" "true"
  # AI 出的内容打出来：好不好得人看，这里只能证明形状对
  echo "$REV" | jq -r "$Q_ALL[] | \"     [\(.question_type)] 答案：\(if .question_type == \"fill_text\" then ([.items[].answer] | join(\" / \")) else (.answer // \"\") end | .[0:60])｜解析：\((.answer_explanation // \"\") | .[0:80])\""

  CODE=$(del_probe)
  check "测完删掉测试章节" "$CODE" "200"
  check "删干净了：校对页取不到" \
    "$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/admin/bank/exams/$GID" "${A[@]}")" "404"
fi

echo "== 探针账号 =="
# 固定用 PROBE01，每次重置密码取一个新的随机密码——这样不必把任何口令写进
# 仓库或 Secret，也不会污染 T001–T010 这些真学员的记录。
# 要开通英语：N2 之后没有学科授权的学员组不了卷（403）。
UID_=$(api "$WORKER_URL/api/admin/users" "${A[@]}" | jq -r '.users[] | select(.username=="PROBE01") | .id')
if [ -z "$UID_" ]; then
  R=$(api -X POST "$WORKER_URL/api/admin/users" "${A[@]}" -H 'Content-Type: application/json' \
    -d '{"username":"PROBE01","subjects":["english"]}')
  UID_=$(echo "$R" | jq -r '.user.id'); PW=$(echo "$R" | jq -r '.initialPassword')
  echo "  已新建 PROBE01（开通英语）"
else
  PW=$(api -X POST "$WORKER_URL/api/admin/users/$UID_/reset-password" "${A[@]}" | jq -r '.newPassword')
  echo "  复用 PROBE01，已重置密码"
  # 已经开通的不再写一遍：每写一次就多一条授权日志
  G=$(api "$WORKER_URL/api/admin/users/$UID_/subjects" "${A[@]}")
  EN_STATUS=$(echo "$G" | jq -r '.subjects[] | select(.code == "english") | .grant_status // "未开通"')
  if [ "$EN_STATUS" != "ACTIVE" ]; then
    EN_ID=$(echo "$G" | jq -r '.subjects[] | select(.code == "english") | .subject_id')
    api -X POST "$WORKER_URL/api/admin/subjects/$EN_ID/members" "${A[@]}" -H 'Content-Type: application/json' \
      -d '{"usernames":["PROBE01"],"note":"线上实测探针"}' >/dev/null
    echo "  给 PROBE01 补开了英语（原来是 $EN_STATUS）"
  fi
fi
[ -n "$PW" ] && [ "$PW" != null ] || { echo "::error::拿不到探针账号密码"; exit 1; }
echo "::add-mask::$PW"

STU=$(api -X POST "$WORKER_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u PROBE01 --arg p "$PW" '{username:$u,password:$p}')" | jq -r '.token')
check "探针账号登录" "$([ -n "$STU" ] && [ "$STU" != null ] && echo yes)" "yes"
S=(-H "Authorization: Bearer $STU")

echo "== 组卷（真写入） =="
GEN=$(api -X POST "$WORKER_URL/api/exams/generate" "${S[@]}" -H 'Content-Type: application/json' \
  -d '{"courseCode":"13000"}')
ATT=$(echo "$GEN" | jq -r '.attemptId // ""')
if [ -z "$ATT" ]; then
  echo "::error::组卷失败：$(echo "$GEN" | head -c 400)"; exit 1
fi
ok "组卷成功（$(echo "$GEN" | jq -r '.questionCount') 题，满分 $(echo "$GEN" | jq -r '.totalScore')）"

echo "== 逐题作答 =="
PAPER=$(api "$WORKER_URL/api/attempts/$ATT" "${S[@]}")
TOTAL_Q=$(echo "$PAPER" | jq '[.sections[].questions[]] | length')
check "取回试卷题目数与组卷一致" "$TOTAL_Q" "$(echo "$GEN" | jq -r '.questionCount')"

# 客观题一律选 A（或填一个词），作文写一段真英文——AI 批改要有东西可批
ESSAY_TEXT='Nowadays more and more students choose to study online. In my opinion this change brings both convenience and challenges. On the one hand, online courses allow learners to arrange their own time and to review difficult parts as often as they need. On the other hand, studying alone at home requires strong self-discipline, and some students find it hard to keep concentrated without a teacher nearby. Therefore I believe online study works best when it is combined with regular face-to-face discussion.'
ANSWERED=0
while read -r QID QTYPE; do
  # 题型只有三种：选择、词形变换、写作。选择一律选 A，变换填一个常见词——
  # 目的是造出"对一些错一些"的真实作答，好让错题本和 AI 分析有东西可做。
  case "$QTYPE" in
    essay)                ANS="$ESSAY_TEXT" ;;
    fill_text) ANS="the" ;;
    *)                    ANS="A" ;;
  esac
  CODE=$(api -o /dev/null -w '%{http_code}' -X PUT "$WORKER_URL/api/attempts/$ATT/answers" "${S[@]}" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')")
  [ "$CODE" = "200" ] && ANSWERED=$((ANSWERED+1))
done < <(echo "$PAPER" | jq -r '.sections[].questions[] | "\(.questionId) \(.questionType)"')
check "全部题目作答落库" "$ANSWERED" "$TOTAL_Q"

echo "== 交卷与判分 =="
SUB=$(api -X POST "$WORKER_URL/api/attempts/$ATT/submit" "${S[@]}")
check "交卷成功" "$(echo "$SUB" | jq -r '.ok // false')" "true"
REP=$(api "$WORKER_URL/api/attempts/$ATT/report" "${S[@]}")
OBJ=$(echo "$REP" | jq -r '.attempt.objectiveScore // "null"')
PENDING=$(echo "$REP" | jq -r '.attempt.pendingAi // 0')
check "客观题已判分" "$([ "$OBJ" != null ] && [ -n "$OBJ" ] && echo yes)" "yes"
echo "     （客观题 $OBJ 分，待 AI 处理 $PENDING 项）"
check "报告按部分给出得分" \
  "$([ "$(echo "$REP" | jq '.sectionScores | length')" -gt 0 ] && echo yes)" "yes"

echo "== AI 链路（真实服务商） =="
# 这一步会真的调服务商，慢，超时给宽一点；但别无限等——线上实测过一次 60 秒
# 拿不到返回，那是真问题，不该靠加超时糊过去。
AI=$(curl -sS -m 180 -X POST "$WORKER_URL/api/ai/attempts/$ATT/run" "${S[@]}")
echo "     原始返回：$(echo "$AI" | head -c 500)"
if [ -z "$AI" ]; then
  bad "AI 接口没有任何返回（很可能超时）"
fi
ESSAY_STATUS=$(echo "$AI" | jq -r '.essay.status // "none"' 2>/dev/null || echo none)
ESSAY_TOTAL=$(echo "$AI" | jq -r '.essay.total // "null"' 2>/dev/null || echo null)
case "$ESSAY_STATUS" in
  # 分数本身不断言（CR-M11）：卷子是随机组的，作文题和下面这篇固定作文未必是一个话题，
  # 按跑题判 0 分是合理结果。以前这里断"通顺英文不该是 0 分"，那是直觉不是规格——
  # 线上实测 #6 就红在这里，却分不清是跑题还是没读懂。没读懂的两种形状（维度一个都读不到、
  # 把示例原样抄回来）现在都由服务端判成 ai_bad_shape，走下面 * 那一支；
  # 真批改了，评语会说明理由，下面单独断一条。
  graded|already) ok "作文批改完成（$ESSAY_STATUS，$ESSAY_TOTAL 分 / 30）" ;;
  blank)   bad "作文被判为未作答——本次明明写了正文" ;;
  *)       bad "作文批改未完成（status=$ESSAY_STATUS）：$(echo "$AI" | jq -r '.essay.detail // ""' 2>/dev/null)" ;;
esac
# 空返回时 jq 什么都不输出，直接拿去比大小会报 integer expression expected，
# 把真正的失败原因埋在一堆 shell 报错里。给个兜底的 0。
WD=$(echo "$AI" | jq -r '.wrongItems.done // 0' 2>/dev/null || echo 0); WD=${WD:-0}
WF=$(echo "$AI" | jq -r '.wrongItems.failed // 0' 2>/dev/null || echo 0); WF=${WF:-0}
echo "     （错题分析成功 $WD 条，失败 $WF 条）"
if [ "$WD" -gt 0 ] && [ "$WF" -eq 0 ]; then ok "错题分析全部成功"
elif [ "$WD" -gt 0 ]; then bad "错题分析有 $WF 条失败"
else bad "错题分析一条都没成功"; fi

REP2=$(api "$WORKER_URL/api/attempts/$ATT/report" "${S[@]}")
check "跑完 AI 后待处理归零" "$(echo "$REP2" | jq -r '.attempt.pendingAi // 0')" "0"
# 作文这一题的题目、各维度分、评语都打出来：分数对不对得人看，0 分是跑题还是没读懂，
# 看评语一眼就分得清。线上实测 #6 就是因为没打出来，只能猜。
ESSAY=$(echo "$REP2" | jq -c '[.sections[] | .writingPrompt as $p | .questions[]
          | select(.questionType == "essay") | {prompt: ($p // .stem // ""), score, aiComment}][0] // {}')
EC=$(echo "$ESSAY" | jq -r '.aiComment // "{}"' | jq -c '.' 2>/dev/null || echo '{}')
echo "     作文题目：$(echo "$ESSAY" | jq -r '(.prompt // "") | gsub("\\s+"; " ") | .[0:120]')"
echo "     各维度分：$(echo "$EC" | jq -c '.scores // {}')"
echo "     评语：$(echo "$EC" | jq -r '(.comments // {}) | tojson | .[0:600]')"
check "作文批改带着评语（0 分也要说得出理由）" \
  "$(echo "$EC" | jq -r '[(.comments // {})[] | select(type == "string" and (gsub("\\s"; "") | length) > 0)] | length > 0')" "true"
TOT=$(echo "$REP2" | jq -r '.attempt.totalScore // "null"')
ESSAY_SCORE=$(echo "$ESSAY" | jq -r '.score // "null"')
# 总分是各题得分之和（study.js 重算 total_score 的口径）。以前断的是"总分 ≠ 客观分"，
# 作文真拿 0 分时它就红了，而那不是错。
check "总分 = 客观题 + 作文分" \
  "$(awk -v t="$TOT" -v o="$OBJ" -v e="$ESSAY_SCORE" 'BEGIN { if (t == "null" || e == "null") print "读不到"; else { d = t - o - e; print ((d < 0.01 && d > -0.01) ? "对得上" : "对不上") } }')" "对得上"
echo "     （客观 $OBJ + 作文 $ESSAY_SCORE → 总分 $TOT）"

echo "== 错题本与能力评估 =="
WB=$(api "$WORKER_URL/api/wrongbook?courseCode=13000" "${S[@]}")
check "错题已进错题本" "$([ "$(echo "$WB" | jq -r '.total // 0')" -gt 0 ] && echo yes)" "yes"
WITH_AI=$(echo "$WB" | jq '[.items[] | select((.errorAnalysis // "") != "")] | length')
check "错题带上了 AI 给的错因" "$([ "$WITH_AI" -gt 0 ] && echo yes)" "yes"
echo "     （错题 $(echo "$WB" | jq -r '.total') 条，其中 $WITH_AI 条有 AI 错因）"

AS=$(api "$WORKER_URL/api/assessment?courseCode=13000" "${S[@]}")
check "能力评估接口可用" "$(echo "$AS" | jq -r 'has("mastery")')" "true"
# 探针账号只考了一次，按 PRD §5.8 不足两次不给预测，这是设计如此不是故障
ENOUGH=$(echo "$AS" | jq -r '.enoughData')
if [ "$ENOUGH" = "false" ]; then
  ok "样本不足时按设计不给预测（$(echo "$AS" | jq -r '.message')）"
else
  ok "已给出预测区间 $(echo "$AS" | jq -r '.statistical.low')–$(echo "$AS" | jq -r '.statistical.high')"
fi

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ] || exit 1
