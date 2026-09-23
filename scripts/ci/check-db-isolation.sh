#!/usr/bin/env bash
# 老库隔离检查：确认本平台不会往被复制方的数据库上写。
#
# 本平台是从 Eng1300 复制改造来的。wrangler.toml 里的 database_id 会随复制原样
# 带过来，没清掉的话本平台的迁移会直接在 Eng1300 的线上库上建表改表——而且是
# 静默搞坏：流水线全绿，迁移都写成了 IF NOT EXISTS，不会报任何错。
#
# 这一步必须排在所有 wrangler d1 execute 和 wrangler deploy 之前。
#
# 输入（环境变量）：
#   D1_NAME         本平台的数据库名（必填）
#   D1_DATABASE_ID  已解析出的数据库 ID（可空：尚未解析时就是空的）
#   WRANGLER_TOML   wrangler.toml 路径，默认 worker/wrangler.toml
#   FORBIDDEN_LIST  禁用名单路径，默认与本脚本同目录的 forbidden-databases.txt
#
# 退出码：0 放行，1 命中禁用名单或配置不一致。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOML="${WRANGLER_TOML:-worker/wrangler.toml}"
LIST="${FORBIDDEN_LIST:-$HERE/forbidden-databases.txt}"
NAME="${D1_NAME:-}"
DB_ID="${D1_DATABASE_ID:-}"
FAIL=0

die() { echo "::error::$1"; FAIL=1; }

if [ -z "$NAME" ]; then
  die "D1_NAME 为空。流水线必须显式指定本平台的数据库名，不能靠默认值。"
fi
if [ ! -f "$LIST" ]; then
  die "找不到禁用名单 $LIST。这个文件是这道检查的全部依据，缺了等于没检查。"
  echo "隔离检查失败。"; exit 1
fi

# 逐行读名单，跳过注释与空行
while IFS= read -r line || [ -n "$line" ]; do
  entry="${line%%#*}"
  entry="$(echo "$entry" | tr -d '[:space:]')"
  [ -z "$entry" ] && continue
  if [ "$NAME" = "$entry" ]; then
    die "D1_NAME=「$NAME」命中禁用名单：这是被复制方的数据库，本平台不得使用。请改成本平台自己的库名。"
  fi
  if [ -n "$DB_ID" ] && [ "$DB_ID" = "$entry" ]; then
    die "D1_DATABASE_ID=「$DB_ID」命中禁用名单：这是被复制方的数据库 ID，本平台不得指向它。"
  fi
done < "$LIST"

# wrangler.toml 里提交的 database_id：要么是空（等流水线回填），
# 要么正好等于本次解析出来的 ID。其他情况一律是复制残留。
if [ -f "$TOML" ]; then
  COMMITTED=$(grep -E '^[[:space:]]*database_id[[:space:]]*=' "$TOML" \
    | head -1 | sed -E 's/.*=[[:space:]]*"([^"]*)".*/\1/')
  if [ -n "$COMMITTED" ]; then
    if [ -z "$DB_ID" ]; then
      die "$TOML 里提交了 database_id=「$COMMITTED」。本平台要求它留空、由流水线创建后回填；提交上来的值多半是从被复制方带过来的残留。"
    elif [ "$COMMITTED" != "$DB_ID" ]; then
      die "$TOML 里提交的 database_id=「$COMMITTED」与本次解析出的「$DB_ID」不一致。不确定该信哪个，拒绝继续。"
    fi
  fi
else
  die "找不到 $TOML。"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "隔离检查未通过，已阻止后续的数据库操作与部署。"
  exit 1
fi
echo "隔离检查通过：D1_NAME=$NAME${DB_ID:+, D1_DATABASE_ID=$DB_ID}"
