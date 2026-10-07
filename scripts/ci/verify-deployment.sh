#!/usr/bin/env bash
# 部署后的线上验证。逐条打 OK / FAIL，最后有一条 FAIL 就整步失败。
#
# 需要：WORKER_URL；可选 ADMIN_TOKEN（没有就只跑不用登录的几条）
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e
# 临时文件放在自己的目录里：本地两个套件会同时跑这几份脚本，用 /tmp 下的固定文件名会互相覆盖
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  OK   $1"; else echo "  FAIL $1（期望 $3，实际 $2）"; FAIL=1; fi
}

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/health" || echo 000)
check "健康检查" "$CODE" "200"

CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/me" || echo 000)
check "未登录访问 /api/me 被拒绝" "$CODE" "401"

# 导题库那一步拒绝了哪些文件（CR-H4）。导入过的题库文件不许改：被改了的那一步不导入、库里一行不动，
# 也不在那一步失败（不然后面的初始化和这里的验证全被跳过），而是记进清单，由这里报红并点名。
# 清单不在就是那一步没跑完或者没交接上——当成"没有拒绝"的话，这条就永远是绿的。
if [ -z "${SEED_REFUSED_FILE:-}" ] || [ ! -f "$SEED_REFUSED_FILE" ]; then
  echo "  FAIL 导题库那一步没有留下拒绝清单（${SEED_REFUSED_FILE:-SEED_REFUSED_FILE 没设}），说不清有没有文件被拒"; FAIL=1
elif [ -s "$SEED_REFUSED_FILE" ]; then
  echo "  FAIL 导题库拒绝了 $(grep -c . "$SEED_REFUSED_FILE") 个题库文件（库里没动它们）："
  sed 's/^/         /; s/\t/：/' "$SEED_REFUSED_FILE"
  FAIL=1
else
  echo "  OK   导题库没有拒绝任何文件（导入过的题库文件都没被改过）"
fi

if [ -n "${ADMIN_TOKEN:-}" ]; then
  ROLE=$(curl -sS -m 20 "$WORKER_URL/api/me" -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq -r '.user.role // "none"' || echo none)
  check "admin 令牌有效且为超级管理员" "$ROLE" "SUPER_ADMIN"

  TOKEN="$ADMIN_TOKEN"
  {
    CODE=$(curl -sS -m 20 -o "$T/users.json" -w '%{http_code}' "$WORKER_URL/api/admin/users" \
      -H "Authorization: Bearer $TOKEN" || echo 000)
    check "超级管理员可访问后台用户接口" "$CODE" "200"
    # 只数 T001–T010 是否齐全，不比总数，免得以后手工新建账号把这条弄红
    STUDENTS=$(jq -r '[.users[] | select(.username | test("^T0(0[1-9]|10)$"))] | length' "$T/users.json" 2>/dev/null || echo 0)
    check "学员账号 T001–T010 已创建" "$STUDENTS" "10"

    # 真有一条写入落库了吗？
    #
    # 这条不是凑数：D1 免费版写入额度用尽时，读接口全都正常，只有写会失败，
    # 所以上面那些检查全绿也说明不了站点能用。
    #
    # 哨兵是 admin 这次登录写下的"最后登录时间"：每次部署都要登录一次（取管理员令牌那步），
    # 额度用尽时登录照样放行，只是这一笔写不进去（记账类写入，失败吞掉）。所以它不早于
    # 这次登录的时刻，就说明这次部署的写入落了库；登录本身成没成功说明不了这件事。
    # 以前读的是「教学」AI 配置的更新时间，靠的是它每次部署都被重写——AI 配置改成只补不改
    # 之后（CR-M10）它就不变了。留 60 秒给运行器和 D1 的时钟差。
    LAST_LOGIN=$(jq -r '[.users[] | select(.username == "admin")][0].last_login_at // ""' "$T/users.json" 2>/dev/null || true)
    if [ -z "${ADMIN_LOGIN_AT:-}" ] || [ -z "$LAST_LOGIN" ]; then
      check "写入已恢复（这次登录的最后登录时间已落库）" \
        "读不到（登录时刻 ${ADMIN_LOGIN_AT:-无}，最后登录时间 ${LAST_LOGIN:-无}）" "读得到"
    else
      # last_login_at 由 SQLite datetime('now') 生成，是世界时
      LAST_EPOCH=$(date -u -d "${LAST_LOGIN}Z" +%s 2>/dev/null || echo 0)
      if [ "$LAST_EPOCH" -ge $(( ADMIN_LOGIN_AT - 60 )) ]; then
        echo "  OK   写入已恢复（admin 这次登录写的最后登录时间 $LAST_LOGIN 已落库）"
      else
        echo "  FAIL 写入未恢复：admin 最后登录时间停在 $LAST_LOGIN，早于这次登录（$(date -u -d "@$ADMIN_LOGIN_AT" '+%F %T')），说明这次没写进去"
        FAIL=1
      fi
    fi

    STATS=$(curl -sS -m 20 "$WORKER_URL/api/admin/bank/stats" -H "Authorization: Bearer $TOKEN" || echo '{}')
    # 仓库里每个题库文件的章节都在库里、题数和文件一致（CR-M16）。
    # 这里原先断的是"英语 20 套 / 1020 道"。H4 之后内容要改的正规做法是加一个新文件，加一个
    # 英语文件这两条就红——和 M14 是同一个毛病：把某一时刻的数字当成不变量，红了只能改数字。
    # 期望从文件现算（会随业务变的数字不写死），实际从后台接口读，两边不同源。
    # 只看仓库里的文件：后台上传的章节不在这里，也不该在这里。
    SUBJ_ROOT="${SUBJECTS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/data/subjects}"
    curl -sS -m 20 -o "$T/all-exams.json" "$WORKER_URL/api/admin/bank/exams" \
      -H "Authorization: Bearer $TOKEN" || true
    if ! jq -e '.exams | type == "array"' "$T/all-exams.json" >/dev/null 2>&1; then
      echo "  FAIL 读不到库里的章节列表，没法和题库文件比对（收到的前 200 字：$(head -c 200 "$T/all-exams.json" 2>/dev/null)）"; FAIL=1
    else
      jq -r '.exams[] | "\(.exam_id)\t\(.question_count)"' "$T/all-exams.json" | LC_ALL=C sort > "$T/db-counts.tsv"
      : > "$T/file-counts.tsv"; UNREADABLE=""
      for f in "$SUBJ_ROOT"/*/groups/*.json; do
        [ -e "$f" ] || continue
        # 读不了的文件不能悄悄跳过：跳过就等于这一章没被检查
        LINE=$(jq -r '[(.examId // .groupId // error("没有 examId / groupId")),
                       ([.sections[].questions | length] | add // 0)] | @tsv' "$f" 2>/dev/null) \
          && [ -n "$LINE" ] && printf '%s\n' "$LINE" >> "$T/file-counts.tsv" \
          || UNREADABLE="$UNREADABLE$(basename "$f")（读不了）；"
      done
      LC_ALL=C sort -o "$T/file-counts.tsv" "$T/file-counts.tsv"
      NFILES=$(grep -c . "$T/file-counts.tsv" || true)
      MISMATCH=$(LC_ALL=C join -t "$(printf '\t')" -a 1 -e '没有' -o '1.1,1.2,2.2' "$T/file-counts.tsv" "$T/db-counts.tsv" \
        | awk -F'\t' '$3 == "没有" { printf "%s（文件 %s 道，库里没有这一章）；", $1, $2; next }
                      $2 != $3   { printf "%s（文件 %s 道，库里 %s 道）；", $1, $2, $3 }')
      if [ "${NFILES:-0}" -eq 0 ]; then
        echo "  FAIL 在 $SUBJ_ROOT 下一个题库文件都没找到，没法比对"; FAIL=1
      elif [ -n "$MISMATCH$UNREADABLE" ]; then
        echo "  FAIL 题库文件和库里对不上：$MISMATCH$UNREADABLE"; FAIL=1
      else
        echo "  OK   仓库里 $NFILES 个题库文件的章节都在库里，题数和文件一致"
      fi
    fi

    # 真正要守的性质是"00015 不再作为独立课程存在"，不是"课程总数是 1"。
    # 后者在加第二个学科的课程行之后自动为假，而 00015 有没有被并掉与它无关。
    check "00015 不再是独立课程" \
      "$(echo "$STATS" | jq -r '[.byCourse[].course_code] | index("00015") // "无"')" "无"

    # 部署不该改变任何章节的发布状态（CR-M14）。这里原先断的是"英语 20 套试卷全部已发布"——
    # H2 之后撤回会保留，管理员撤回任何一套英语卷，之后每次部署都会红，和下面生化那段说的是
    # 同一个毛病。真正要守的是部署前后一样：多了是"撤回的被放回去"（H2），少了是"被部署弄丢了"
    # （以前种子整章重导会冲回草稿；CR-H4 之后导入过的章节不再重导，这条守着它别再回来）。
    # 部署前的状态由导题库之前那步读库记下（record-published.sh），部署后的从后台接口取，两边不同源。
    curl -sS -m 20 -G -o "$T/published.json" "$WORKER_URL/api/admin/bank/exams" \
      --data-urlencode "status=已发布" -H "Authorization: Bearer $TOKEN"
    if ! jq -e '.exams | type == "array"' "$T/published.json" >/dev/null 2>&1; then
      echo "  FAIL 读不到部署后的已发布章节（收到的前 200 字：$(head -c 200 "$T/published.json")）"; FAIL=1
    elif [ -z "${PUBLISHED_BEFORE_FILE:-}" ] || [ ! -f "$PUBLISHED_BEFORE_FILE" ]; then
      # 没有记录不能当成"没变"：那样这条就永远是绿的
      echo "  FAIL 部署前的发布状态没有记录（${PUBLISHED_BEFORE_FILE:-PUBLISHED_BEFORE_FILE 没设}），比对不了"; FAIL=1
    else
      jq -r '.exams[].exam_id' "$T/published.json" | LC_ALL=C sort > "$T/published-after.txt"
      MORE=$(LC_ALL=C comm -13 "$PUBLISHED_BEFORE_FILE" "$T/published-after.txt" | paste -sd' ' -)
      LESS=$(LC_ALL=C comm -23 "$PUBLISHED_BEFORE_FILE" "$T/published-after.txt" | paste -sd' ' -)
      if [ -z "$MORE$LESS" ]; then
        echo "  OK   部署没有改变任何章节的发布状态（$(wc -l < "$T/published-after.txt") 章已发布）"
      else
        echo "  FAIL 部署改变了章节的发布状态：${MORE:+多了 $MORE}${MORE:+${LESS:+；}}${LESS:+少了 $LESS}"; FAIL=1
      fi
    fi

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
    # CR-H4：停用的题退回草稿、整卷发布跳过它，所以"已发布又停用"永远该是 0
    check "没有一道停用的题还在已发布状态" "$(echo "$STATS" | jq -r '.retiredButPublished')" "0"
    # 2026-10-07：已发布的题，按标准答案作答必须拿得到满分（answer-check.js，用真判分器判一遍）。
    # 第 1 章 q04、q05 就是答案在、也确认了，判分器却读不懂它的枚举——学员一交答案就 500。
    # 红的时候把是哪几道、为什么打出来（只有题号和原因，没有学员数据）
    UNGRADABLE=$(echo "$STATS" | jq -r '.publishedUngradable')
    check "没有一道已发布的题，按标准答案作答都拿不到满分" "$UNGRADABLE" "0"
    if [ "$UNGRADABLE" != "0" ]; then
      echo "$STATS" | jq -r '.publishedUngradableSample[]? | "       \(.questionId)：\(.problems | join("；"))"' | head -10
    fi
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
    # 这里原先断"存疑题确实被排除在可抽题之外"：已发布题数 < 英语总题数（CR-M16 删掉）。它成立靠的是
    # "现在恰好有题没发布"，管理员把题都核完、发布了，它就红——又是一条快照断言；还拿全学科的已发布数
    # 去比英语一科的总数。存疑的题抽不到由抽题判据保证（pickableSql 只认已发布），本地 m3-smoke 测着。
    # 英语总题数原本出自上面删掉的"1020 道"那条；变量没了 bash 算术当 0，这条就悄悄变成恒红——
    # 是部署彩排 deploy-local 当场照出来的。
    PUBLISHED_Q=$(echo "$STATS" | jq -r '[.byType[].published] | add // 0')
    ALL_Q=$(echo "$STATS" | jq -r '[.byType[].total] | add // 0')
    echo "     （全库 $ALL_Q 题，其中 $PUBLISHED_Q 题可参与组卷）"
    # 这里原先断"解析存疑记录已清零"（全库），那是部署每次跑 publish-all.sql 清掉全部存疑的年代。
    # H2 之后部署不再替人清：新导入还没人看的章节、后台上传还没核的内容，存疑都是正常在等人看的，
    # 全库清零会拦正常操作。要守的是：已发布的章节没有未处理的存疑——发布那道门要求存疑清零，
    # 有哪条路绕过了那道门（或者已发布的章节被插进了新的存疑），这里就红。
    check "已发布的章节没有未处理的解析存疑" \
      "$(jq -r '[.exams[].open_notes] | add // 0' "$T/published.json" 2>/dev/null)" "0"

    # 组卷模板（2026-10-04）：生化的模板写在仓库文件里、从没进过库，学员点「生成试卷」才知道，
    # 这里一直是绿的。不变量是"有已发布章节的课程都配了组卷模板"；按现在已发布的题凑不凑得够
    # 只打信息不判红——停用、撤回是管理员的正常操作，新章节发布前凑不够也正常。
    curl -sS -m 30 -o "$T/readiness.json" "$WORKER_URL/api/admin/bank/exam-readiness" \
      -H "Authorization: Bearer $TOKEN" || true
    if ! jq -e '.courses | type == "array"' "$T/readiness.json" >/dev/null 2>&1; then
      echo "  FAIL 读不到组卷体检（收到的前 200 字：$(head -c 200 "$T/readiness.json" 2>/dev/null)）"; FAIL=1
    else
      NO_TPL=$(jq -r '[.courses[] | select(.publishedExams > 0 and .templateItems == 0) | .courseCode] | join("、")' "$T/readiness.json")
      if [ -z "$NO_TPL" ]; then
        echo "  OK   有已发布章节的课程都配了组卷模板"
      else
        echo "  FAIL 有已发布章节的课程都配了组卷模板（没有模板：$NO_TPL）"; FAIL=1
      fi
      jq -r '.courses[] | select(.publishedExams > 0) | "     （" + .courseCode + " 组卷："
        + (if .problem then "模板有问题：" + .problem elif .ready then "凑得够" else "凑不够" end)
        + (if (.parts | length) > 0 then "，" + ([.parts[] | .label + " " + (.available | tostring)
             + (if .pickUnit == "SECTION" then " 篇可选" else "/" + (.required | tostring) end)] | join("、")) else "" end)
        + "）"' "$T/readiness.json"
    fi

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
    curl -sS -m 20 -o "$T/bio-courses.json" "$WORKER_URL/api/s/biochem/courses" \
      -H "Authorization: Bearer $TOKEN"
    curl -sS -m 20 -o "$T/en-courses.json" "$WORKER_URL/api/s/english/courses" \
      -H "Authorization: Bearer $TOKEN"
    check "生化学科名下没有英语的课程" \
      "$(jq -r --argjson en "$(jq -c '[.courses[].course_code]' "$T/en-courses.json")" \
         '[.courses[].course_code] | map(select(. as $c | $en | index($c))) | length' "$T/bio-courses.json")" "0"
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

    # ---- 考点按学科（2026-10-03）----
    # 用户在线上校对页看不到备选（那次是界面的毛病：备选藏在浏览器的输入提示里，人看不见）。
    # 我们连不上线上，"线上到底有没有备选"只能靠这里打进部署日志。
    # ① 看板上的考点都属于某个学科：不属于任何学科的考点，在哪一科的备选里都看不到。
    check "看板上每个考点都属于某个学科" \
      "$(echo "$STATS" | jq -r 'if (.byTag | type) == "array" then [.byTag[] | select(.subject_code == null)] | length else "看板没有考点分布" end')" "0"
    # ② 每一章的备选 = 这一科有题挂着的考点：一个学科只要有一道题挂着考点，它的每一章都该有备选。
    #    期望从看板的考点分布算，实际从备选接口读——两个接口、两套查询，互相对照。
    #    章节列表读不到时不能当成"没有章节要查"：那样这条永远是绿的。
    KP_BAD=""
    N_EX=$(jq -r '.exams | length' "$T/all-exams.json" 2>/dev/null || echo 0)
    [ "${N_EX:-0}" -gt 0 ] || KP_BAD="读不到章节列表，一章都没查"
    for EID in $(jq -r '.exams[]?.exam_id' "$T/all-exams.json" 2>/dev/null); do
      LIB=$(curl -sS -m 20 "$WORKER_URL/api/admin/bank/knowledge-points?examId=$EID" \
        -H "Authorization: Bearer $TOKEN" || echo '{}')
      SC=$(echo "$LIB" | jq -r '.subject.code // empty' 2>/dev/null)
      if [ -z "$SC" ]; then KP_BAD="$KP_BAD $EID（读不到学科：$(echo "$LIB" | head -c 80)）"; continue; fi
      WANT=$(echo "$STATS" | jq -r --arg s "$SC" '[.byTag[] | select(.subject_code == $s) | .name] | unique | join("|")')
      GOT=$(echo "$LIB" | jq -r '[.knowledgePoints[].name] | unique | join("|")')
      [ "$GOT" = "$WANT" ] || KP_BAD="$KP_BAD $EID（备选 $(echo "$LIB" | jq -r '.knowledgePoints | length') 个，看板上这一科 $(echo "$STATS" | jq -r --arg s "$SC" '[.byTag[] | select(.subject_code == $s)] | length') 个）"
    done
    check "每一章校对页的备选都是本学科有题挂着的考点（和看板对得上，共 ${N_EX:-0} 章）" "${KP_BAD:-全部对得上}" "全部对得上"
    echo "     （考点：$(echo "$STATS" | jq -r '[.byTag[]? | .subject_name] | group_by(.) | map("\(.[0]) \(length) 个") | join("，")')）"

    # ---- N2 学科权限 ----
    # 迁移里那段"给既有学员补授权"在线上到底生效没有，只有这几条能证明。
    # 补漏了的话现象是学员打不开任何学科，而流水线其余断言全绿。
    T001=$(jq -r '.users[] | select(.username=="T001") | .id' "$T/users.json")
    if [ -n "$T001" ] && [ "$T001" != "null" ]; then
      curl -sS -m 20 -o "$T/grants.json" "$WORKER_URL/api/admin/users/$T001/subjects" \
        -H "Authorization: Bearer $TOKEN"
      check "授权接口在线上可用" \
        "$(jq -r 'has("subjects")' "$T/grants.json")" "true"
      # 单人授权视图必须把"还没开通的学科"也列出来，否则管理员在界面上
      # 根本点不到它、没法开通。用 LEFT JOIN 写错成 INNER JOIN 正是这个
      # 现象，而且不报错。拿 /api/me/subjects 的学科数来对（两个接口走的
      # 是不同的查询），不写死数字——将来加学科这条不该跟着红。
      # 只比启用的：授权视图连停用学科也列（管理员要能看到），
      # /api/me/subjects 不列，管理员哪天停用一个学科这条就会无故变红。
      ALL_SUBJ=$(echo "$SUBJ" | jq -r '.subjects | length')
      check "单人视角列出了全部 $ALL_SUBJ 个启用学科（含未开通的）" \
        "$(jq -r '[.subjects[] | select(.subject_status=="启用")] | length' "$T/grants.json")" \
        "$ALL_SUBJ"
      # 权限是新增的约束，不该追溯剥夺既有学员的访问。
      # 只断"至少有一个已开通"而不是"全部已开通"：后者在管理员真撤销过
      # 某个学科之后会在下次部署误报，而这条要守的是"补授权跑了没有"。
      ACTIVE_N=$(jq -r '[.subjects[] | select(.grant_status=="ACTIVE")] | length' "$T/grants.json")
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
      curl -sS -m 20 -o "$T/pack.json" "$WORKER_URL/api/admin/subjects/$ENG_ID/pack" \
        -H "Authorization: Bearer $TOKEN"
      check "英语能力包已落库（题型）" \
        "$(jq -r '.questionTypes | length > 0' "$T/pack.json")" "true"
      check "英语有生效中的评价标准" \
        "$(jq -r '.currentRubric != null' "$T/pack.json")" "true"
      # 作文权重合计不等于 1 的话分数会整体虚高，而批改照常"成功"
      check "作文维度权重合计为 1" \
        "$(jq -r '[.currentRubric.payload | fromjson | .essay.dimensions[].weight] | add | (. * 1000 | round)' "$T/pack.json")" "1000"
      check "四类 AI 提示词都在" \
        "$(jq -r '[.prompts[] | select(.missing != true)] | length' "$T/pack.json")" "4"
      # 题型声明里引用的归一化器必须都在注册表里，否则判分时会抛 unknown_normalizer
      check "题型引用的归一化器都认识" \
        "$(jq -r '[.questionTypes[].normalizers | fromjson[]] - .availableNormalizers | length' "$T/pack.json")" "0"
    else
      echo "  FAIL 找不到英语学科，无法验证能力包"; FAIL=1
    fi
    # ---- N4 英语迁入 ----
    # 题型改名（fill_blank_transform → fill_text）落到线上没有，只有这两条能证明。
    # 没落地的话现象是发布被 N3 那道门拦下，或者判分时抛 question_type_not_declared，
    # 而这两件事都要等有人真去做题才会发生。
    if [ -n "$ENG_ID" ] && [ "$ENG_ID" != "null" ]; then
      check "英语已声明 fill_text" \
        "$(jq -r '[.questionTypes[].type_code] | index("fill_text") != null' "$T/pack.json")" "true"
      check "旧题型码已不在声明里" \
        "$(jq -r '[.questionTypes[].type_code] | index("fill_blank_transform") // "absent"' "$T/pack.json")" "absent"
    fi
    # ---- N5 得分单元与判分骨架 ----
    # 线上那张 subject_question_types 是 N3 建的，没有这两列。迁移里的
    # CREATE TABLE IF NOT EXISTS 不会给它加列，全靠 ensure-columns.sh 补列加回填。
    # 补漏了的现象是：读接口全绿，而任何人一交卷就 500（判分读不到策略）。
    if [ -n "$ENG_ID" ] && [ "$ENG_ID" != "null" ]; then
      check "每个题型都有判分策略（补列与回填都跑到了）" \
        "$(jq -r '[.questionTypes[] | select(.grading_strategy == null)] | length' "$T/pack.json")" "0"
      check "每个题型都有作答形态" \
        "$(jq -r '[.questionTypes[] | select(.answer_shape == null)] | length' "$T/pack.json")" "0"
      # 声明的策略必须都是已实现的，否则判分时抛 strategy_not_implemented
      check "题型声明的策略都已实现" \
        "$(jq -r '[.questionTypes[].grading_strategy] - [.availableStrategies[] | select(.implemented) | .code] | length' "$T/pack.json")" "0"
      # needs_ai 与策略打架的话，交卷时的"待批改"计数与实际判分对不上
      check "needs_ai 与判分策略一致" \
        "$(jq -r '[.questionTypes[] | select((.needs_ai == 1) != (.grading_strategy | startswith("AI_")))] | length' "$T/pack.json")" "0"
    fi

    # 题型声明真的在起作用：写作声明成不进练习，可选题型里就不该有它。
    check "写作仍然不进专项练习（题型声明生效）" \
      "$(curl -sS -m 20 "$WORKER_URL/api/practice/section-types?courseCode=13000" \
         -H "Authorization: Bearer $TOKEN" | jq -r '[.sectionTypes[].section_type] | index("写作") // "absent"')" "absent"

    # 这里原先还断"13000-2026-04 第 15 题已扣下（存疑）"（CR-M16 删掉）。导入过的章节不再重导之后，
    # 这道题的状态归管理员管：在后台补了原文、改了状态，部署就红。扣下机制本身由本地 m3-smoke 测。
  }
fi

# 前端：首页应返回 HTML，未知前端路由要回落到同一个 index.html
TYPE=$(curl -sS -m 20 -o "$T/index.html" -w '%{content_type}' "$WORKER_URL/" || echo none)
case "$TYPE" in
  text/html*) echo "  OK   首页返回 HTML" ;;
  *) echo "  FAIL 首页返回 $TYPE"; FAIL=1 ;;
esac
if grep -q 'id="root"' "$T/index.html"; then
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
