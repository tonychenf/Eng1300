#!/usr/bin/env bash
# 恢复演练（CR-M6）：在一次性的库上，把恢复手册里的每条路真走一遍，逐步断言结果。
# 由 d1-drill 流水线跑：手动触发；改了恢复相关的脚本、推送时也会自动跑一次。
#
# 一次性的库叫 xlearn-drill-<运行编号>-a / -b / -c，跑完不管成败都删掉（开头先清掉以前没删干净的）。
# 线上库一行都不碰：wrangler 命令都在只写着一次性库的配置目录里跑（d1-tool-dir.sh）；
# 删库只走 d1-delete-db.sh，它只认 xlearn-drill- 开头的名字。
#
#   1. 建库 A、迁移、导生化第 1 章、造学员数据
#   2. 记下时间点（北京时间）和书签，然后故意搞坏：删学员、改题面
#   3. 按北京时间恢复 → 数据回来了；用撤销书签恢复 → 坏的又回来了；按书签恢复 → 又好了
#   4. 备份脚本整库导出、加密 → 导入脚本导进新库 B → 逐表核对 + 再导出逐字节比；
#      反面：导进非空库、口令不对、目标写成线上库名，都要拒绝
#   5. （可选）把最近一份线上备份导进库 C 核对：证明真实的备份解得开、导得回去、一行不少。
#      导不进去时接着诊断：只打印结构信息（d1-dump-inspect.sh），再按外键先父后子重排、导进库 D 试一次
#
# 占 D1 写入额度：1–4 段约一千行；第 5 段约等于线上整库的行数。不调 AI。
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
# 可选：DRILL_ID（默认 GITHUB_RUN_ID）、REAL_BACKUP_DIR + REAL_BACKUP_PASSPHRASE（第 5 段）、
#       DRILL_MARGIN（时间点前后各等几秒，默认 65：时间旅行的粒度按分钟算也够）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export WRANGLER_SEND_METRICS=false
ID="${DRILL_ID:-${GITHUB_RUN_ID:-}}"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "::error::DRILL_ID 应该是一串数字（运行编号），拿到的是「$ID」"; exit 1; }
MARGIN="${DRILL_MARGIN:-65}"
PROD=$(bash "$HERE/d1-name.sh") || exit 1
BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID:?需要 CLOUDFLARE_ACCOUNT_ID}/d1/database"

PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
step() { echo; echo "== $* =="; }
T=$(mktemp -d)
declare -A DBID=()
cleanup() {
  local n
  for n in "${!DBID[@]}"; do
    bash "$HERE/d1-delete-db.sh" "$n" "${DBID[$n]}" || echo "::warning::$n 没删掉，下一次演练开头会再清"
  done
  DBID=()
  rm -rf "$T"
}
trap cleanup EXIT

db() { echo "xlearn-drill-$ID-$1"; }
mk() {  # 建一次性库 <字母>，准备只写着它的配置目录 $T/<字母>
  local n; n=$(db "$1")
  local id; id=$(bash "$HERE/d1-create-db.sh" "$n") || return 1
  DBID[$n]=$id
  bash "$HERE/d1-tool-dir.sh" "$T/$1" "$n" "$id"
}
x() {  # x <字母> <sql>：执行，不要输出
  (cd "$T/$1" && npx wrangler d1 execute "$(db "$1")" --remote --yes --command "$2") > "$T/x.log" 2>&1 \
    || { echo "  !! 执行失败：$(tail -3 "$T/x.log" | tr '\n' ' ' | head -c 300)"; return 1; }
}
one() {  # one <字母> <sql>：第一行第一列
  (cd "$T/$1" && npx wrangler d1 execute "$(db "$1")" --remote --json --command "$2" 2> "$T/one.err") \
    | jq -r '.[0].results[0] | to_entries[0].value // "读不到"' 2>/dev/null || echo "读不到"
}
counts() { WRANGLER_DIR="$T/$1" bash "$HERE/d1-table-counts.sh" --remote "$(db "$1")"; }
restore() {  # restore <字母> <时间点或书签>：输出进 $T/restore.log
  WRANGLER_DIR="$T/$1" D1_NAME="$(db "$1")" CONFIRM_NAME="$(db "$1")" \
    bash "$HERE/d1-restore.sh" "$2" > "$T/restore.log" 2>&1
}
show() { sed 's/^/     /' "$1"; }
stem_sha() { (cd "$T/a" && npx wrangler d1 execute "$(db a)" --remote --json \
  --command "SELECT stem FROM questions WHERE exam_id = 'biochem-ch01' ORDER BY question_id;" 2>/dev/null) \
  | jq -c '.[0].results' | sha256sum | cut -c1-16; }
state() {  # 学员还在不在 / 改坏的题面有几道
  echo "$(one a "SELECT COUNT(*) FROM users WHERE username = 'DRILL01';")/$(one a "SELECT COUNT(*) FROM questions WHERE stem = '演练：被改坏的题面';")"
}

step "0. 清掉以前没删干净的一次性库"
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE?name=xlearn-drill-&per_page=100" > "$T/left.json" || true
while IFS=$'\t' read -r n id; do
  [ -n "$n" ] || continue
  [[ "$n" =~ ^xlearn-drill-[0-9]+-[a-z]$ ]] && [[ "$n" != "xlearn-drill-$ID-"* ]] || continue
  bash "$HERE/d1-delete-db.sh" "$n" "$id" || true
done < <(jq -r '.result[]? | [.name, .uuid] | @tsv' "$T/left.json" 2>/dev/null)

step "1. 建一次性库 A，迁移，导生化第 1 章，造学员数据"
mk a || exit 1
D1_NAME="$(db a)" WRANGLER_DIR="$T/a" bash "$HERE/apply-migrations.sh" --remote > "$T/mig.log" 2>&1 \
  || { echo "  !! 迁移失败："; tail -15 "$T/mig.log" | sed 's/^/     /'; exit 1; }
(cd "$REPO" && SEED_SUBJECT_DIR="$REPO/data/subjects/biochem" node scripts/build-seed-sql.mjs "$T/seed") > "$T/gen.log" 2>&1 \
  || { echo "  !! 生成生化种子失败："; tail -10 "$T/gen.log"; exit 1; }
for f in "$T"/seed/*.sql; do
  (cd "$T/a" && npx wrangler d1 execute "$(db a)" --remote --yes --file "$f") > "$T/seed.log" 2>&1 \
    || { echo "  !! 导 $(basename "$f") 失败："; tail -10 "$T/seed.log"; exit 1; }
done
# 最后一条是刁钻的文本：同时有换行和字面的 \n（公式里的 \nu、\neq）。本地的导出器会把它写走样
# （restore-local 照出来的），线上的是不是同一个毛病，看第 4 段
x a "INSERT INTO users (username, password_hash, role) VALUES ('DRILL01', 'drill-hash', 'USER');
     INSERT INTO login_attempts (username, fail_count, last_failed_at) VALUES ('DRILL01|192.0.2.1', 2, datetime('now'));
     UPDATE exams SET status = '已发布' WHERE exam_id = 'biochem-ch01';
     INSERT INTO system_settings (key, value, description) VALUES ('drill-tricky', '第一行' || char(10) || '公式 \\nu 和 \\neq', NULL);" || exit 1
TRICKY_HEX=$(one a "SELECT hex(value) FROM system_settings WHERE key = 'drill-tricky';")
check "（前提）刁钻的文本里确实同时有换行和字面的 \\n" \
  "$(one a "SELECT instr(value, char(10)) > 0 AND instr(value, '\\n') > 0 FROM system_settings WHERE key = 'drill-tricky';")" "1"
BEFORE=$(counts a) || exit 1
NQ=$(one a "SELECT COUNT(*) FROM questions WHERE exam_id = 'biochem-ch01';")
STEMS=$(stem_sha)
echo "     $(jq length <<<"$BEFORE") 张表、$(jq '[.[]] | add' <<<"$BEFORE") 行；生化第 1 章 $NQ 道题"
check "（前提）库 A 里有学员、有题" "$(state)/$(( NQ > 0 ))" "1/0/1"

step "2. 记下时间点和书签，然后故意搞坏"
sleep "$MARGIN"
POINT_BJ=$(TZ=Asia/Shanghai date '+%F %T')
B1=$( (cd "$T/a" && npx wrangler d1 time-travel info "$(db a)" --json 2>/dev/null) | jq -r '.bookmark // empty')
echo "     时间点：北京时间 $POINT_BJ；书签：${B1:-（没拿到）}"
check "拿到了现在的书签" "$([ -n "$B1" ] && echo 有)" "有"
sleep "$MARGIN"
x a "DELETE FROM login_attempts; DELETE FROM users WHERE username = 'DRILL01';
     UPDATE questions SET stem = '演练：被改坏的题面' WHERE exam_id = 'biochem-ch01';" || exit 1
check "（前提）搞坏了：学员没了、$NQ 道题面全变了" "$(state)" "0/$NQ"

step "3a. 按北京时间恢复（$POINT_BJ）"
START=$(date +%s); restore a "$POINT_BJ"; RC=$?
show "$T/restore.log"
echo "     用了 $(( $(date +%s) - START )) 秒"
check "恢复成功" "$RC" "0"
UNDO=$(grep -o -E '时间点填 [0-9a-f-]+' "$T/restore.log" | tail -1 | sed 's/时间点填 //')
check "打出了撤销书签" "$([ -n "$UNDO" ] && echo 有)" "有"
check "每张表的行数回到搞坏之前" "$(counts a)" "$BEFORE"
check "学员回来了、题面全回来了" "$(state)/$(stem_sha)" "1/0/$STEMS"

step "3b. 撤销：用撤销书签恢复，坏的那份应该又回来"
restore a "$UNDO"; RC=$?
show "$T/restore.log"
check "恢复成功" "$RC" "0"
check "回到了搞坏之后的样子" "$(state)" "0/$NQ"

step "3c. 按书签恢复（第 2 段记下的那个）"
restore a "$B1"; RC=$?
show "$T/restore.log"
check "恢复成功" "$RC" "0"
check "每张表的行数回到搞坏之前" "$(counts a)" "$BEFORE"
check "学员回来了、题面全回来了" "$(state)/$(stem_sha)" "1/0/$STEMS"

step "4. 备份脚本加密导出 → 导入脚本导进新库 B"
BACKUP_PASSPHRASE=$(openssl rand -base64 33); export BACKUP_PASSPHRASE
START=$(date +%s)
D1_NAME="$(db a)" WRANGLER_DIR="$T/a" bash "$HERE/d1-backup.sh" --remote "$T/bk" > "$T/backup.log" 2>&1; RC=$?
show "$T/backup.log"
echo "     用了 $(( $(date +%s) - START )) 秒"
check "备份成功" "$RC" "0"
check "备份目录里只有密文和 manifest" "$(ls "$T/bk" | sed -E 's/^.*\.sql\.gpg$/密文/' | LC_ALL=C sort | paste -sd, -)" "manifest.json,密文"
check "密文里看不到明文（学员用户名）" "$(grep -r -c -a 'DRILL01' "$T/bk" | awk -F: '{s += $NF} END {print s + 0}')" "0"
check "日志里没有导出的下载链接" "$(grep -c -E 'https?://' "$T/backup.log")" "0"
check "manifest 的行数就是库里的行数" "$(jq -S -c .tables "$T/bk/manifest.json")" "$(counts a | jq -S -c .)"
mk b || exit 1
START=$(date +%s)
WRANGLER_DIR="$T/b" PROD_D1_NAME="$PROD" bash "$HERE/d1-import-backup.sh" --remote "$T/bk" "$(db b)" > "$T/import.log" 2>&1; RC=$?
show "$T/import.log"
echo "     用了 $(( $(date +%s) - START )) 秒"
check "导进新库 B 成功" "$RC" "0"
check "  逐表行数核对过了" "$(grep -c '^核对一' "$T/import.log")" "1"
check "  再导出来和备份一致" "$(grep -c '^核对二' "$T/import.log")" "1"
check "  按原样补回的文本核对过了（至少刁钻的那一条）" "$(( $(jq -r '.fixups // 0' "$T/bk/manifest.json") >= 1 ))/$(grep -c '^核对三' "$T/import.log")" "1/1"
check "B 和 A 每张表的行数一样" "$(counts b)" "$(counts a)"
check "刁钻的文本在 B 里一个字节都没变" \
  "$( (cd "$T/b" && npx wrangler d1 execute "$(db b)" --remote --json --command "SELECT hex(value) AS h FROM system_settings WHERE key = 'drill-tricky';" 2>/dev/null) | jq -r '.[0].results[0].h // "读不到"')" "$TRICKY_HEX"

step "4x. 反面：该拒绝的都拒绝"
WRANGLER_DIR="$T/a" PROD_D1_NAME="$PROD" bash "$HERE/d1-import-backup.sh" --remote "$T/bk" "$(db a)" > "$T/neg1.log" 2>&1; RC=$?
check "导进非空库（A）：拒绝" "$RC/$(grep -c '不是空库' "$T/neg1.log")" "1/1"
BACKUP_PASSPHRASE="not-the-right-passphrase" WRANGLER_DIR="$T/b" PROD_D1_NAME="$PROD" \
  bash "$HERE/d1-import-backup.sh" --remote "$T/bk" "$(db b)" > "$T/neg2.log" 2>&1; RC=$?
check "口令不对：解不开" "$RC/$(grep -c '解不开' "$T/neg2.log")" "1/1"
bash "$HERE/d1-import-backup.sh" --remote "$T/bk" "$PROD" > "$T/neg3.log" 2>&1; RC=$?
check "目标写成线上库「$PROD」：拒绝" "$RC/$(grep -c '目标是线上库' "$T/neg3.log")" "1/1"

if [ -n "${REAL_BACKUP_DIR:-}" ]; then
  step "5. 最近一份线上备份导进一次性库 C"
  mk c || exit 1
  START=$(date +%s)
  BACKUP_PASSPHRASE="${REAL_BACKUP_PASSPHRASE:-}" WRANGLER_DIR="$T/c" PROD_D1_NAME="$PROD" \
    bash "$HERE/d1-import-backup.sh" --remote "$REAL_BACKUP_DIR" "$(db c)" > "$T/real.log" 2>&1; RC=$?
  show "$T/real.log"
  echo "     用了 $(( $(date +%s) - START )) 秒"
  check "线上备份解得开、导得回去" "$RC" "0"
  check "  逐表行数和备份一致" "$(grep -c '^核对一' "$T/real.log")" "1"
  check "  再导出来和备份一致" "$(grep -c '^核对二' "$T/real.log")" "1"
  if [ "$RC" != "0" ]; then
    # 2026-10-02 线上备份第一次导不进去，D1 只回 {"D1_RESET_DO":true}。诊断只打印结构，不打印任何数据
    step "5b. 诊断：线上备份的结构（只有表名、条数、字节数，没有数据）"
    BACKUP_PASSPHRASE="${REAL_BACKUP_PASSPHRASE:-}" bash "$HERE/d1-dump-inspect.sh" "$REAL_BACKUP_DIR" > "$T/inspect.log" 2>&1; RC=$?
    show "$T/inspect.log"
    check "诊断跑完了" "$RC" "0"
    step "5c. 建表语句放最前、数据按外键先父后子重排，再导进一次性库 D"
    mk d || exit 1
    START=$(date +%s)
    BACKUP_PASSPHRASE="${REAL_BACKUP_PASSPHRASE:-}" IMPORT_ORDER=parent-first WRANGLER_DIR="$T/d" PROD_D1_NAME="$PROD" \
      bash "$HERE/d1-import-backup.sh" --remote "$REAL_BACKUP_DIR" "$(db d)" > "$T/real-d.log" 2>&1; RC=$?
    show "$T/real-d.log"
    echo "     用了 $(( $(date +%s) - START )) 秒"
    check "重排之后导得进去" "$RC" "0"
    check "  逐表行数和备份一致" "$(grep -c '^核对一' "$T/real-d.log")" "1"
    check "  再导出来和备份一致" "$(grep -c '^核对二' "$T/real-d.log")" "1"
    check "  按原样补回的文本核对过了" "$(grep -c '^核对三' "$T/real-d.log")" "1"
  fi
fi

step "6. 删掉一次性库"
cleanup; trap - EXIT
LEFT=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE?name=xlearn-drill-$ID&per_page=100" \
  | jq -r --arg p "xlearn-drill-$ID-" '[.result[]? | select(.name | startswith($p))] | length' 2>/dev/null || echo 读不到)
check "这次演练建的库都删了" "$LEFT" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
