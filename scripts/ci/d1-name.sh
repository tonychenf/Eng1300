#!/usr/bin/env bash
# 打印本平台的 D1 库名。只有一个出处：worker/wrangler.toml 的 database_name（CR-M6）。
#
# 流水线以前在 YAML 里另写了一份（env: D1_NAME: xlearn）。从备份恢复时要把线上切到一个新库
# （docs/数据恢复手册.md），切换就是改 database_name 这一行；YAML 里要是还写着旧名字，部署会
# 找到旧库、把旧库的 id 填进一个写着新库名的配置里——两处写同一个名字，改一处漏一处。
#
# 用法：N=$(bash scripts/ci/d1-name.sh)   读不到合法的名字就失败，不给默认值
set -euo pipefail
TOML="${WRANGLER_TOML:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/worker/wrangler.toml}"
NAME=$(grep -E '^[[:space:]]*database_name[[:space:]]*=' "$TOML" | head -1 | sed -E 's/.*"([^"]*)".*/\1/' || true)
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "::error::从 $TOML 读不到合法的 database_name（读到「$NAME」）" >&2
  exit 1
fi
printf '%s\n' "$NAME"
