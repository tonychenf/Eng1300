#!/usr/bin/env bash
# 部署动库之前，把这一刻的时间旅行书签打进日志和本次运行的摘要（CR-M6）。只读，不占写入额度。
#
# 这次部署要是把数据弄坏了：手动触发 d1-restore 流水线，方式选 time-travel，时间点填这里打出来的
# 书签，整库回到部署前（docs/数据恢复手册.md）。
#
# 读不到只告警、不拦部署：书签只是方便，按北京时间填时间点照样能恢复；真正兜底的是紧接着的
# 加密备份，那一步失败才拦。
#
# 需要：D1_NAME（wrangler.toml 已回填 database_id）；可选 WRANGLER_DIR
set -uo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
cd "${WRANGLER_DIR:-$WORKER}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

if ! npx wrangler d1 time-travel info "$D1_NAME" --json > "$T/out.json" 2> "$T/err.log"; then
  echo "::warning::读不到时间旅行书签（不拦部署；要恢复时按北京时间填时间点也行）：$(head -c 200 "$T/out.json" | tr '\n' ' ') $(tail -3 "$T/err.log" | tr '\n' ' ' | head -c 300)"
  exit 0
fi
BM=$(jq -r '.bookmark // empty' "$T/out.json" 2>/dev/null)
if [ -z "$BM" ]; then
  echo "::warning::时间旅行接口没给书签（收到的前 200 字：$(head -c 200 "$T/out.json")）"
  exit 0
fi
NOW_BJ=$(TZ=Asia/Shanghai date '+%F %T')
echo "部署前的恢复点：$BM（北京时间 $NOW_BJ）"
echo "这次部署要是把数据弄坏了：手动触发 d1-restore，方式选 time-travel，时间点填上面这个书签。"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### 部署前的恢复点"; echo; echo "- 书签：\`$BM\`"; echo "- 北京时间：$NOW_BJ"
    echo "- 数据被这次部署弄坏了：手动触发 d1-restore（time-travel），时间点填这个书签"; } >> "$GITHUB_STEP_SUMMARY"
fi
