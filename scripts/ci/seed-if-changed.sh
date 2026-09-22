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
# 需要环境变量：D1_NAME；可选 FORCE_SEED=1 强制全部重导。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"

node ../scripts/build-seed-sql.mjs

# 取已记录的指纹。表是空的或查询失败都按"全部要导"处理。
EXISTING=$(npx wrangler d1 execute "$D1_NAME" --remote --yes --json \
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
  OUT=$(npx wrangler d1 execute "$D1_NAME" --remote --yes --file="$f" 2>&1)
  RC=$?
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
