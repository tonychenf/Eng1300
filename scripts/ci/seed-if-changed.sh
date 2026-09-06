#!/usr/bin/env bash
# 只导入内容变过的种子文件。
#
# 起因：整套题库重新导入一次要写约 5700 行，而 D1 免费版每天只有 10 万行
# 写入额度。每次部署都无条件重导，跑十几次就把额度耗光，之后所有写操作
# （包括登录时更新最后登录时间）全部报 D1_ERROR，站点等于不可用。
#
# 做法：把每个种子文件的内容指纹存进 seed_state 表，指纹没变就跳过。
# 稳态部署因此不产生任何题库写入。
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
  sha=$(sha256sum "$f" | cut -c1-64)
  if [ "${FORCE_SEED:-0}" != "1" ] && echo "$EXISTING" | grep -qx "$name $sha"; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "── 导入 $name"
  npx wrangler d1 execute "$D1_NAME" --remote --yes --file="$f" || exit 1
  npx wrangler d1 execute "$D1_NAME" --remote --yes --command \
    "INSERT INTO seed_state (name, sha, applied_at) VALUES ('$name', '$sha', datetime('now'))
     ON CONFLICT(name) DO UPDATE SET sha = excluded.sha, applied_at = excluded.applied_at;" \
    >/dev/null || exit 1
  applied=$((applied + 1))
done

echo "题库导入完成：$applied 个文件有变化已导入，$skipped 个内容未变已跳过。"
