#!/usr/bin/env bash
# 只导入内容变过的种子文件。
#
# 起因：整套题库重新导入一次要写约 5700 行，而 D1 免费版每天只有 10 万行
# 写入额度。每次部署都无条件重导，跑十几次就把额度耗光，之后所有写操作
# （包括登录时更新最后登录时间）全部报 D1_ERROR，站点等于不可用。
#
# 做法：每个种子文件的最后一条语句就是把自己的内容指纹写进 seed_state
# （由 build-seed-sql.mjs 生成）。指纹没变就跳过，稳态部署不产生任何题库写入。
#
# 指纹必须和数据同属一次导入。早先版本是导完文件再单独发一条 INSERT 记指纹，
# 第一次成功、第二次撞上额度耗尽，数据进去了指纹没记上，下一次部署原样重导
# 再死在同一处，每跑一次白烧约 578 行，永远走不出来。
#
# 需要环境变量：D1_NAME；可选 FORCE_SEED=1 强制全部重导；
# SEED_LOCAL=1 改用本地库（给 test/cr-h2-publish.sh 用，线上部署不设）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"
if [ "${SEED_LOCAL:-0}" = "1" ]; then TARGET=(--local); else TARGET=(--remote --yes); fi

# 逐个学科生成。**不能只跑英语**：`data/subjects/` 下每一科都要进库，
# 哪怕它的题还全是缺答案/待核——答案状态那道门已经保证它们抽不到、发不出，
# 而管理员要能在后台看到并逐题录答案（§6.4.10 的补答案工作流）。
# 少导一科的表现是"GitHub 里明明有，后台却没有"，没有任何地方报错。
#
# 生成失败必须中止：这个脚本没开 set -e，不显式判断的话生成器挂了也会接着往下走，
# 把上一轮留在 seed/ 里的旧文件当成本轮产物导进去。
for SUBJ_DIR in ../data/subjects/*/; do
  [ -d "$SUBJ_DIR/groups" ] || continue
  CODE=$(basename "$SUBJ_DIR")
  echo "── 生成 $CODE 的种子"
  SEED_SUBJECT_DIR="$SUBJ_DIR" node ../scripts/build-seed-sql.mjs \
    || { echo "::error::$CODE 的种子生成失败，中止部署。"; exit 1; }
done

# 取已记录的指纹。表是空的或查询失败都按"全部要导"处理。
EXISTING=$(npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --json \
  --command "SELECT name, sha FROM seed_state;" 2>/dev/null \
  | jq -r '.[0].results[]? | "\(.name) \(.sha)"' || true)

applied=0
skipped=0
for f in seed/*.sql; do
  name=$(basename "$f")
  # 指纹取自文件里那条 seed_state 语句，和入库的值同源，不会两处算法不一致
  sha=$(grep -o "VALUES ('$name', '[0-9a-f]\{64\}'" "$f" | grep -o "[0-9a-f]\{64\}")
  if [ -z "$sha" ]; then
    echo "::error::$name 里找不到内容指纹，种子文件可能不是 build-seed-sql.mjs 生成的。"
    exit 1
  fi
  if [ "${FORCE_SEED:-0}" != "1" ] && echo "$EXISTING" | grep -qx "$name $sha"; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "── 导入 $name"
  # 部署的「放行」只放回**重导前就是已发布**的章节（CR-H2）。先删后插会把章节冲回草稿，
  # 以前靠每次部署无条件跑 publish-all.sql 全部放回——管理员撤回的章节、答案确认完
  # 还没点发布的章节、上传内容的存疑，一概被部署替人做了决定。
  # 现在导之前先问这一章现在是不是已发布，是的话在**同一次导入里**记一个
  # republish:<章节> 标记，由放行一步（sql/republish-reseeded.sql）放回并删掉。
  # 标记和导入同成同败：导到一半失败时，已导进去的那几章标记也在库里，下次部署接着放，
  # 不会"导进去了、指纹记上了、却再也没人把它放回来"。
  RUN="$f"
  IDS=$(grep -o "INSERT INTO exams (exam_id[^)]*) VALUES ('[^']*'" "$f" | sed -E "s/.*VALUES \('([^']*)'$/\1/")
  if [ -n "$IDS" ]; then
    for id in $IDS; do
      [[ "$id" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "::error::$name 里的章节编号不合规：$id"; exit 1; }
    done
    IN=$(printf "'%s'," $IDS); IN="${IN%,}"
    OUTQ=$(npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --json \
      --command "SELECT exam_id FROM exams WHERE status = '已发布' AND exam_id IN ($IN);" 2>/dev/null)
    # 读不到就停：当成"没发布"会把一章静默下线，当成"已发布"会替管理员做决定
    if [ $? -ne 0 ] || ! echo "$OUTQ" | jq -e '.[0].results | type == "array"' >/dev/null 2>&1; then
      echo "::error::读不到 $name 重导前的发布状态（收到：$(printf '%s' "$OUTQ" | head -c 200)），中止。"
      exit 1
    fi
    PUB=$(echo "$OUTQ" | jq -r '.[0].results[].exam_id')
    if [ -n "$PUB" ]; then
      RUN=$(mktemp --suffix=.sql)
      { cat "$f"; printf '\n'
        for id in $PUB; do
          printf "INSERT OR REPLACE INTO seed_state (name, sha) VALUES ('republish:%s', '%s');\n" "$id" "$sha"
        done; } > "$RUN"
      echo "   重导前已发布：$(echo $PUB)，导完由放行一步放回"
    fi
  fi
  OUT=$(npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --file="$RUN" 2>&1)
  RC=$?
  [ "$RUN" != "$f" ] && rm -f "$RUN"
  echo "$OUT"
  if [ $RC -ne 0 ]; then
    # 额度耗尽不是代码问题，继续导下去只会把剩下的额度也烧掉，直接停。
    if echo "$OUT" | grep -q 'daily row write limit'; then
      echo "::error::D1 今日写入额度已用尽，已导入 $applied 个文件，剩下的留到额度重置（世界时零点，北京时间早八点）后再跑。"
    fi
    exit 1
  fi
  applied=$((applied + 1))
done

echo "题库导入完成：$applied 个文件有变化已导入，$skipped 个内容未变已跳过。"
