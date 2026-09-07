#!/usr/bin/env bash
# 线上端到端实测：拿一个探针账号，真的组一次卷、答一遍、交卷、跑一次 AI，
# 再看错题本与能力评估。
#
# 为什么非要在 GitHub Actions 里跑：开发沙箱的出站策略拒绝 workers.dev，
# 本机连不上线上；而这条链路里的 AI 调用又连不上真实服务商，本地只能用替身。
# 替身返回什么形状是我们自己写的，证明不了真实模型的输出扛不扛得住解析。
#
# 需要：WORKER_URL、ADMIN_TOKEN。
set -uo pipefail

PASS=0; FAIL=0
ok()   { echo "  OK   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

A=(-H "Authorization: Bearer $ADMIN_TOKEN")
api() { curl -sS -m 60 "$@"; }

echo "== 探针账号 =="
# 固定用 PROBE01，每次重置密码取一个新的随机密码——这样不必把任何口令写进
# 仓库或 Secret，也不会污染 T001–T010 这些真学员的记录。
UID_=$(api "$WORKER_URL/api/admin/users" "${A[@]}" | jq -r '.users[] | select(.username=="PROBE01") | .id')
if [ -z "$UID_" ]; then
  R=$(api -X POST "$WORKER_URL/api/admin/users" "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"PROBE01"}')
  UID_=$(echo "$R" | jq -r '.user.id'); PW=$(echo "$R" | jq -r '.initialPassword')
  echo "  已新建 PROBE01"
else
  PW=$(api -X POST "$WORKER_URL/api/admin/users/$UID_/reset-password" "${A[@]}" | jq -r '.newPassword')
  echo "  复用 PROBE01，已重置密码"
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
    fill_blank_transform) ANS="the" ;;
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
case "$ESSAY_STATUS" in
  graded|already) ok "作文批改完成（$ESSAY_STATUS）" ;;
  blank)          bad "作文被判为未作答——本次明明写了正文" ;;
  *)              bad "作文批改未完成（status=$ESSAY_STATUS）" ;;
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
TOT=$(echo "$REP2" | jq -r '.attempt.totalScore // "null"')
check "总分已补上作文分" "$([ "$TOT" != null ] && [ "$TOT" != "$OBJ" ] && echo yes)" "yes"
echo "     （客观 $OBJ → 总分 $TOT）"

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
