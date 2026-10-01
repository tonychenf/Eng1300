#!/usr/bin/env bash
# 部署后的线上验证。逐条打 OK / FAIL，最后有一条 FAIL 就整步失败。
#
# 需要：WORKER_URL；可选 ADMIN_TOKEN（没有就只跑不用登录的几条）
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  OK   $1"; else echo "  FAIL $1（期望 $3，实际 $2）"; FAIL=1; fi
}

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/health" || echo 000)
check "健康检查" "$CODE" "200"

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/me" || echo 000)
check "未登录访问 /api/me 被拒绝" "$CODE" "401"

if [ -n "${ADMIN_TOKEN:-}" ]; then
  ROLE=$(curl -sS -m 20 "$WORKER_URL/api/me" -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq -r '.user.role // "none"' || echo none)
  check "admin 令牌有效且为超级管理员" "$ROLE" "SUPER_ADMIN"

  TOKEN="$ADMIN_TOKEN"
  {
    CODE=$(curl -sS -m 20 -o /tmp/users.json -w '%{http_code}' "$WORKER_URL/api/admin/users" \
      -H "Authorization: Bearer $TOKEN" || echo 000)
    check "超级管理员可访问后台用户接口" "$CODE" "200"
    # 只数 T001–T010 是否齐全，不比总数，免得以后手工新建账号把这条弄红
    STUDENTS=$(jq -r '[.users[] | select(.username | test("^T0(0[1-9]|10)$"))] | length' /tmp/users.json 2>/dev/null || echo 0)
    check "学员账号 T001–T010 已创建" "$STUDENTS" "10"

    # 真有一条写入落库了吗？
    #
    # 这条不是凑数：D1 免费版写入额度用尽时，读接口全都正常，只有写会失败，
    # 所以上面那些检查全绿也说明不了站点能用。原先"取管理员令牌"那步能当哨兵
    # （登录要写最后登录时间），但登录已经改成额度用尽也放行，哨兵没了。
    #
    # AI 配置那步每次部署都会重写一次，额度用尽时它会回退成沿用旧值并打
    # warning。所以看 updated_at 离现在多久：刚写的就是几秒，回退了就是上一次
    # 成功部署的时间。10 分钟的窗口足够覆盖一次部署的耗时。
    AI_UPDATED=$(curl -sS -m 20 "$WORKER_URL/api/admin/ai/settings" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.settings.TUTORING.updatedAt // ""')
    if [ -z "$AI_UPDATED" ]; then
      check "写入已恢复（AI 配置刚落库）" "读不到 updatedAt" "10 分钟内"
    else
      # updated_at 由 SQLite datetime('now') 生成，是世界时
      AGE=$(( $(date -u +%s) - $(date -u -d "${AI_UPDATED}Z" +%s 2>/dev/null || echo 0) ))
      if [ "$AGE" -ge 0 ] && [ "$AGE" -le 600 ]; then
        echo "  OK   写入已恢复（AI 配置 ${AGE} 秒前刚落库）"
      else
        echo "  FAIL 写入未恢复：AI 配置停在 $AI_UPDATED（${AGE} 秒前），说明这次没写进去"
        FAIL=1
      fi
    fi

    STATS=$(curl -sS -m 20 "$WORKER_URL/api/admin/bank/stats" -H "Authorization: Bearer $TOKEN" || echo '{}')
    # 这三条原来写的是全库总数（20 套 / 1020 题 / 1 门课），那是英语独占时代的
    # 数字。多一个学科就红一次，而红了之后正确的做法永远是改数字——
    # 这种断言不提供信号。按**学科**算，英语那几个数才是稳定的。
    EXAMS=$(echo "$STATS" | jq -r '[.byCourse[] | select(.course_code == "13000") | .exam_count] | add // 0')
    check "英语题库已导入 20 套真题" "$EXAMS" "20"
    QUESTIONS=$(echo "$STATS" | jq -r '[.byType[] | select(.course_code == "13000") | .total] | add // 0')
    check "英语题库已导入 1020 道题" "$QUESTIONS" "1020"

    # 真正要守的性质是"00015 不再作为独立课程存在"，不是"课程总数是 1"。
    # 后者在加第二个学科的课程行之后自动为假，而 00015 有没有被并掉与它无关。
    check "00015 不再是独立课程" \
      "$(echo "$STATS" | jq -r '[.byCourse[].course_code] | index("00015") // "无"')" "无"
    PUBLISHED_EXAMS=$(echo "$STATS" | jq -r '[.byCourse[] | select(.course_code == "13000") | .published_exams] | add // 0')
    check "英语 20 套试卷全部已发布" "$PUBLISHED_EXAMS" "20"

    # 生化在库里，而且题数不为 0。
    #
    # 这里原先断的是"一道都没被放行""34 道全是待核"——那是 N6 刚导进来
    # 那一刻的快照。人工核完第 1 章、把它发布之后，这两条就开始拦正常操作，
    # 而红了之后唯一能做的是改数字。和上面"20 套 / 1020 题"是同一个毛病：
    # **把某一时刻的状态当成不变量**，这种断言不提供信号。
    #
    # 真正的不变量是 §6.4.10：**已发布的题，答案必须是已确认的**。
    # 它与发到第几章无关，永远该是 0，下面单独断一条。
    BIO=$(echo "$STATS" | jq -r '[.byCourse[] | select(.course_code == "biochem-main")] | length')
    check "生化的内容组已导入" "$BIO" "1"
    BIO_TOTAL=$(echo "$STATS" | jq -r '[.byType[] | select(.course_code == "biochem-main") | .total] | add // 0')
    check "生化的题在库里（$BIO_TOTAL 道）" "$(( BIO_TOTAL > 0 ))" "1"

    # §6.4.10 的硬约束。分开看 status 和 answer_state 都正常，
    # 交叉起来才是"把没人核过的答案发给了学员"——所以看板专门算了这个数。
    check "没有一道已发布的题是答案未确认的（§6.4.10 硬约束）" \
      "$(echo "$STATS" | jq -r '.publishedWithoutConfirmedAnswer')" "0"
    BIO_PUB=$(echo "$STATS" | jq -r '[.byType[] | select(.course_code == "biochem-main") | .published] | add // 0')
    BIO_CONFIRMED=$(echo "$STATS" | jq -r '.byAnswerState[] | select(.subject_code == "biochem") | .confirmed')
    echo "     （生化 $BIO_TOTAL 道，已确认 $BIO_CONFIRMED 道，已发布 $BIO_PUB 道）"

    # N6b：上传接口与原文留存接口在线上挂上了没有。
    # 两条都是只读（第一条连 body 都不发），不花写入额度。
    #
    # 第二条的判据是**路由挂上了**，不是状态码：路由没挂时 Hono 回的是
    # 纯文本 404，jq 取不到 error；挂上了回的是带 error 码的 JSON。
    # 两种都是 404，只看状态码区分不了——而"整个功能没部署上去"
    # 恰好长得和"这个内容组不存在"一模一样。
    CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST \
      "$WORKER_URL/api/admin/bank/import?subjectCode=biochem&groupId=x1&label=a&orderKey=1" \
      || echo 000)
    check "未登录传不进题库" "$CODE" "401"
    ERR=$(curl -sS -m 20 "$WORKER_URL/api/admin/bank/import/no-such-group/source" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.error // "路由没挂"' || echo 取不到)
    check "原文留存接口已上线" "$ERR" "not_found"
    # 被解析存疑记录点名的题目不参与组卷，所以可抽题数少于总题数。
    # 不写死具体数字：存疑记录一旦人工核对放行，这个数就会变。
    PUBLISHED_Q=$(echo "$STATS" | jq -r '[.byType[].published] | add // 0')
    check "存疑题确实被排除在可抽题之外" "$(( PUBLISHED_Q > 0 && PUBLISHED_Q < QUESTIONS ))" "1"
    echo "     （共 $QUESTIONS 题，其中 $PUBLISHED_Q 题可参与组卷）"
    check "解析存疑记录已清零" "$(echo "$STATS" | jq -r '.unresolvedNotes')" "0"

    # ---- N1 学科骨架 ----
    # 线上没有这几条的话，学科层是不是真的上线了只能靠猜
    SUBJ=$(curl -sS -m 20 "$WORKER_URL/api/me/subjects" -H "Authorization: Bearer $TOKEN" || echo '{}')
    check "学科接口返回英语与生化两个学科" \
      "$(echo "$SUBJ" | jq -r '[.subjects[].code] | sort | join(",")')" "biochem,english"
    check "英语学科已有可抽题（ready）" \
      "$(echo "$SUBJ" | jq -r '.subjects[] | select(.code=="english") | .ready')" "true"
    CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/s/nosuchsubject" \
      -H "Authorization: Bearer $TOKEN" || echo 000)
    check "不存在的学科返回 404" "$CODE" "404"
    # 学科隔离：生化名下不能冒出英语的课程。
    # 原来断的是"生化名下一门课都没有"——N6 给生化建了课程行之后那就成了
    # 测"生化是空的"。改成断两边课程码没有交集。
    curl -sS -m 20 -o /tmp/bio-courses.json "$WORKER_URL/api/s/biochem/courses" \
      -H "Authorization: Bearer $TOKEN"
    curl -sS -m 20 -o /tmp/en-courses.json "$WORKER_URL/api/s/english/courses" \
      -H "Authorization: Bearer $TOKEN"
    check "生化学科名下没有英语的课程" \
      "$(jq -r --argjson en "$(jq -c '[.courses[].course_code]' /tmp/en-courses.json)" \
         '[.courses[].course_code] | map(select(. as $c | $en | index($c))) | length' /tmp/bio-courses.json)" "0"
    # ready 盯的是"别把一个没内容的学科报成可用"——误判成 true 的话，
    # 学员点进去看到一个空的练习页，而没有任何地方报错。
    # 但它不该写死成 false：第 1 章人工核完发布之后 ready 本来就该是 true。
    # 改成**两个不同来源互相对照**：ready 来自 /api/me/subjects，
    # 已发布题数来自 /api/admin/bank/stats，两者必须说同一件事。
    # 同源的话（拿 ready 去对 ready）就是恒等式，什么都验不到。
    BIO_READY=$(echo "$SUBJ" | jq -r '.subjects[] | select(.code=="biochem") | .ready')
    check "生化的 ready 与它有没有已发布的题对得上" \
      "$BIO_READY" "$([ "${BIO_PUB:-0}" -gt 0 ] && echo true || echo false)"
    check "看板能按学科报答案进度（N6 的新字段上线了）" \
      "$(echo "$STATS" | jq -r 'has("byAnswerState")')" "true"

    # ---- N2 学科权限 ----
    # 迁移里那段"给既有学员补授权"在线上到底生效没有，只有这几条能证明。
    # 补漏了的话现象是学员打不开任何学科，而流水线其余断言全绿。
    T001=$(jq -r '.users[] | select(.username=="T001") | .id' /tmp/users.json)
    if [ -n "$T001" ] && [ "$T001" != "null" ]; then
      curl -sS -m 20 -o /tmp/grants.json "$WORKER_URL/api/admin/users/$T001/subjects" \
        -H "Authorization: Bearer $TOKEN"
      check "授权接口在线上可用" \
        "$(jq -r 'has("subjects")' /tmp/grants.json)" "true"
      # 单人授权视图必须把"还没开通的学科"也列出来，否则管理员在界面上
      # 根本点不到它、没法开通。用 LEFT JOIN 写错成 INNER JOIN 正是这个
      # 现象，而且不报错。拿 /api/me/subjects 的学科数来对（两个接口走的
      # 是不同的查询），不写死数字——将来加学科这条不该跟着红。
      # 只比启用的：授权视图连停用学科也列（管理员要能看到），
      # /api/me/subjects 不列，管理员哪天停用一个学科这条就会无故变红。
      ALL_SUBJ=$(echo "$SUBJ" | jq -r '.subjects | length')
      check "单人视角列出了全部 $ALL_SUBJ 个启用学科（含未开通的）" \
        "$(jq -r '[.subjects[] | select(.subject_status=="启用")] | length' /tmp/grants.json)" \
        "$ALL_SUBJ"
      # 权限是新增的约束，不该追溯剥夺既有学员的访问。
      # 只断"至少有一个已开通"而不是"全部已开通"：后者在管理员真撤销过
      # 某个学科之后会在下次部署误报，而这条要守的是"补授权跑了没有"。
      ACTIVE_N=$(jq -r '[.subjects[] | select(.grant_status=="ACTIVE")] | length' /tmp/grants.json)
      check "既有学员 T001 有授权（迁移没有追溯剥夺访问）" \
        "$(( ACTIVE_N > 0 ))" "1"
      echo "     （T001 已开通 $ACTIVE_N 个学科）"
    else
      echo "  FAIL 找不到学员 T001，无法验证授权补齐"; FAIL=1
    fi
    check "审计接口在线上可用" \
      "$(curl -sS -m 20 "$WORKER_URL/api/admin/grants/audit?limit=1" \
         -H "Authorization: Bearer $TOKEN" | jq -r 'has("entries")')" "true"

    # ---- N3 学科能力包 ----
    # 判分规则、提示词、掌握度阈值现在全在数据里。种子没导进去的话，
    # 学员一交卷就是 500，而流水线其余断言全绿——所以必须在这里看一眼。
    ENG_ID=$(curl -sS -m 20 "$WORKER_URL/api/admin/subjects" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.subjects[] | select(.code=="english") | .subject_id')
    if [ -n "$ENG_ID" ] && [ "$ENG_ID" != "null" ]; then
      curl -sS -m 20 -o /tmp/pack.json "$WORKER_URL/api/admin/subjects/$ENG_ID/pack" \
        -H "Authorization: Bearer $TOKEN"
      check "英语能力包已落库（题型）" \
        "$(jq -r '.questionTypes | length > 0' /tmp/pack.json)" "true"
      check "英语有生效中的评价标准" \
        "$(jq -r '.currentRubric != null' /tmp/pack.json)" "true"
      # 作文权重合计不等于 1 的话分数会整体虚高，而批改照常"成功"
      check "作文维度权重合计为 1" \
        "$(jq -r '[.currentRubric.payload | fromjson | .essay.dimensions[].weight] | add | (. * 1000 | round)' /tmp/pack.json)" "1000"
      check "四类 AI 提示词都在" \
        "$(jq -r '[.prompts[] | select(.missing != true)] | length' /tmp/pack.json)" "4"
      # 题型声明里引用的归一化器必须都在注册表里，否则判分时会抛 unknown_normalizer
      check "题型引用的归一化器都认识" \
        "$(jq -r '[.questionTypes[].normalizers | fromjson[]] - .availableNormalizers | length' /tmp/pack.json)" "0"
    else
      echo "  FAIL 找不到英语学科，无法验证能力包"; FAIL=1
    fi
    # ---- N4 英语迁入 ----
    # 题型改名（fill_blank_transform → fill_text）落到线上没有，只有这两条能证明。
    # 没落地的话现象是发布被 N3 那道门拦下，或者判分时抛 question_type_not_declared，
    # 而这两件事都要等有人真去做题才会发生。
    if [ -n "$ENG_ID" ] && [ "$ENG_ID" != "null" ]; then
      check "英语已声明 fill_text" \
        "$(jq -r '[.questionTypes[].type_code] | index("fill_text") != null' /tmp/pack.json)" "true"
      check "旧题型码已不在声明里" \
        "$(jq -r '[.questionTypes[].type_code] | index("fill_blank_transform") // "absent"' /tmp/pack.json)" "absent"
    fi
    # ---- N5 得分单元与判分骨架 ----
    # 线上那张 subject_question_types 是 N3 建的，没有这两列。迁移里的
    # CREATE TABLE IF NOT EXISTS 不会给它加列，全靠 ensure-columns.sh 补列加回填。
    # 补漏了的现象是：读接口全绿，而任何人一交卷就 500（判分读不到策略）。
    if [ -n "$ENG_ID" ] && [ "$ENG_ID" != "null" ]; then
      check "每个题型都有判分策略（补列与回填都跑到了）" \
        "$(jq -r '[.questionTypes[] | select(.grading_strategy == null)] | length' /tmp/pack.json)" "0"
      check "每个题型都有作答形态" \
        "$(jq -r '[.questionTypes[] | select(.answer_shape == null)] | length' /tmp/pack.json)" "0"
      # 声明的策略必须都是已实现的，否则判分时抛 strategy_not_implemented
      check "题型声明的策略都已实现" \
        "$(jq -r '[.questionTypes[].grading_strategy] - [.availableStrategies[] | select(.implemented) | .code] | length' /tmp/pack.json)" "0"
      # needs_ai 与策略打架的话，交卷时的"待批改"计数与实际判分对不上
      check "needs_ai 与判分策略一致" \
        "$(jq -r '[.questionTypes[] | select((.needs_ai == 1) != (.grading_strategy | startswith("AI_")))] | length' /tmp/pack.json)" "0"
    fi

    # 题型声明真的在起作用：写作声明成不进练习，可选题型里就不该有它。
    check "写作仍然不进专项练习（题型声明生效）" \
      "$(curl -sS -m 20 "$WORKER_URL/api/practice/section-types?courseCode=13000" \
         -H "Authorization: Bearer $TOKEN" | jq -r '[.sectionTypes[].section_type] | index("写作") // "absent"')" "absent"

    # 缺原文的那道题按要求扣下，不参与组卷
    HELD=$(curl -sS -m 20 "$WORKER_URL/api/admin/bank/exams/13000-2026-04" \
      -H "Authorization: Bearer $TOKEN" \
      | jq -r '[.sections[].questions[] | select(.question_id=="13000-2026-04-q15")][0].status')
    check "13000-2026-04 第15题已扣下（缺原文支撑）" "$HELD" "存疑"
  }
fi

# 前端：首页应返回 HTML，未知前端路由要回落到同一个 index.html
TYPE=$(curl -sS -m 20 -o /tmp/index.html -w '%{content_type}' "$WORKER_URL/" || echo none)
case "$TYPE" in
  text/html*) echo "  OK   首页返回 HTML" ;;
  *) echo "  FAIL 首页返回 $TYPE"; FAIL=1 ;;
esac
if grep -q 'id="root"' /tmp/index.html; then
  echo "  OK   首页是前端应用页面"
else
  echo "  FAIL 首页内容不是前端应用"; FAIL=1
fi

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL/api/exams/generate" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}' || echo 000)
check "未登录不能组卷" "$CODE" "401"

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/admin/bank" || echo 000)
check "前端路由回落到 index.html" "$CODE" "200"

# /api/* 必须交给 Worker，不能被 SPA 回落吃掉
BODY=$(curl -sS -m 20 "$WORKER_URL/api/does-not-exist" || echo '')
case "$BODY" in
  *not_found*) echo "  OK   未知接口返回 JSON 404" ;;
  *) echo "  FAIL 未知接口被前端回落吃掉：$BODY"; FAIL=1 ;;
esac

[ "$FAIL" -eq 0 ] || { echo "::error::线上验证未全部通过。"; exit 1; }
echo "线上验证全部通过。"
