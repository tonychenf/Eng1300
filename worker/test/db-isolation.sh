#!/usr/bin/env bash
# 老库隔离检查的单元测试。不需要服务，不占端口。
#
# 这道检查是防事故的：它拦的是"本平台的迁移跑到 Eng1300 线上库上"。
# 事故一旦发生就是老站数据被改坏，没有第二次机会，所以守卫本身必须先被测过。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
GUARD=scripts/ci/check-db-isolation.sh
PASS=0; FAIL=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 造一份禁用名单，内容与真名单同构但用假标识——这样测的是检查逻辑，
# 不是"真名单里恰好有什么"，真名单改了也不会把这套测试弄红。
cat > "$TMP/forbidden.txt" <<'EOF'
# 注释行应被跳过
old-platform-db

deadbeefdeadbeefdeadbeefdeadbeef
EOF

toml() { printf 'name = "x"\ndatabase_id = "%s"\n' "$1" > "$TMP/wrangler.toml"; }

# 跑一次守卫，返回退出码
run() {
  env -u D1_NAME -u D1_DATABASE_ID \
    FORBIDDEN_LIST="$TMP/forbidden.txt" WRANGLER_TOML="$TMP/wrangler.toml" \
    "$@" bash "$GUARD" >"$TMP/out" 2>&1
  echo $?
}

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else
    FAIL=$((FAIL+1)); echo "  FAIL $desc (期望退出码 $want, 实际 $got)"
    sed 's/^/       /' "$TMP/out"
  fi
}

echo "== 应当放行的 =="
toml ""
check "库名与 ID 都不在名单里、toml 未提交 id" "$(run D1_NAME=xlearn D1_DATABASE_ID=aaaa1111)" 0
toml "aaaa1111"
check "toml 提交的 id 与解析出的一致" "$(run D1_NAME=xlearn D1_DATABASE_ID=aaaa1111)" 0
toml ""
check "尚未解析出 ID（ID 为空）也放行" "$(run D1_NAME=xlearn)" 0

echo "== 应当拦住的 =="
toml ""
check "库名命中禁用名单" "$(run D1_NAME=old-platform-db D1_DATABASE_ID=aaaa1111)" 1
check "库 ID 命中禁用名单" "$(run D1_NAME=xlearn D1_DATABASE_ID=deadbeefdeadbeefdeadbeefdeadbeef)" 1
check "D1_NAME 为空（流水线没显式指定）" "$(run D1_DATABASE_ID=aaaa1111)" 1
toml "deadbeefdeadbeefdeadbeefdeadbeef"
check "toml 里残留着被复制方的 id、且尚未解析" "$(run D1_NAME=xlearn)" 1
check "toml 残留值与解析出的 id 不一致" "$(run D1_NAME=xlearn D1_DATABASE_ID=aaaa1111)" 1
toml "somethingelse"
check "toml 提交了 id 但流水线还没解析" "$(run D1_NAME=xlearn)" 1

echo "== 名单文件本身缺失要当失败，不能静默放行 =="
check "禁用名单不存在" \
  "$(env -u D1_NAME FORBIDDEN_LIST="$TMP/nope.txt" WRANGLER_TOML="$TMP/wrangler.toml" \
      D1_NAME=xlearn bash "$GUARD" >"$TMP/out" 2>&1; echo $?)" 1

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
