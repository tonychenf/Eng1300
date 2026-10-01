#!/usr/bin/env bash
# 整库加密备份（CR-M6，用户 2026-10-01 选的方案 b）：部署动库之前导出一份整库 SQL，加密后由流水线
# 存成附件，留 90 天。时间旅行只能回到 7 天内、库被删了也跟着没，这份是它够不着时的兜底。
#
# 为什么必须加密：仓库是公开的，公开仓库的流水线附件登录 GitHub 的任何人都能下载；备份里有学员的
# 作答记录、密码哈希、加密后的 AI Key。口令在 Secret BACKUP_PASSPHRASE 里，用户另存了一份——
# Secret 存进去就读不回来，丢了口令备份就打不开。
#
# 为什么要把 wrangler 的输出藏起来：线上导出时它会把整库的下载链接（一小时有效）打进日志，
# 而公开仓库的流水线日志谁都能看。它的输出只进临时目录，失败时才打出来，并且先把链接涂掉。
#
# 明文只在 mktemp 的临时目录里，退出时删掉。输出目录里只有密文和 manifest.json
# （每张表的行数、校验和、时间，不含数据）。加密完当场解一遍、比对校验和：备份打不开，
# 要在做备份的这一刻知道，不是等到要恢复的那天。
#
# 导出时 D1 会把这个库的其他请求挡住，直到导出完（官方文档的说法；库小，几秒钟）。
#
# 用法：d1-backup.sh --remote|--local <输出目录>
# 需要：D1_NAME、BACKUP_PASSPHRASE（至少 16 个字符）
# 可选：WRANGLER_DIR（在哪个目录跑 wrangler，默认仓库的 worker/）、BACKUP_BOOKMARK（写进 manifest）
set -euo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
case "${1:-}" in
  --remote) MODE=--remote ;;
  --local)  MODE=--local ;;
  *) echo "::error::用法：d1-backup.sh --remote|--local <输出目录>"; exit 1 ;;
esac
OUT="${2:-}"
[ -n "$OUT" ] || { echo "::error::缺输出目录"; exit 1; }
[ -n "${D1_NAME:-}" ] || { echo "::error::需要 D1_NAME"; exit 1; }
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "::error::缺 Secret BACKUP_PASSPHRASE，不做备份就不往下部署。到仓库 Settings → Secrets and variables → Actions 新建，值用密码管理器生成（24 位以上），自己另存一份。"
  exit 1
fi
[ "${#BACKUP_PASSPHRASE}" -ge 16 ] || { echo "::error::BACKUP_PASSPHRASE 太短（至少 16 个字符）"; exit 1; }
mkdir -p "$OUT"
[ -z "$(ls -A "$OUT")" ] || { echo "::error::输出目录 $OUT 不是空的，不往里混放"; exit 1; }

T=$(mktemp -d)
# gpg 的工作目录单独放在 /tmp 下：它在里面建 agent 的 socket，路径超过 107 字节就建不出来
export GNUPGHOME; GNUPGHOME=$(mktemp -d /tmp/xlearn-gpg.XXXXXX)
cleanup() { gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$T" "$GNUPGHOME"; }
trap cleanup EXIT
redact() { sed -E 's#https?://[^[:space:]"'"'"']+#[链接已隐去]#g'; }
gpg_() { gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3 "$@" \
           3< <(printf '%s' "$BACKUP_PASSPHRASE"); }

# ── 导出
START=$(date +%s)
if ! (cd "${WRANGLER_DIR:-$WORKER}" && npx wrangler d1 export "$D1_NAME" "$MODE" --output "$T/dump.sql" -y) \
      > "$T/export.log" 2>&1; then
  echo "::error::整库导出失败（下载链接已从日志里涂掉）："
  tail -20 "$T/export.log" | redact
  exit 1
fi
SECS=$(( $(date +%s) - START ))
[ -s "$T/dump.sql" ] || { echo "::error::导出的文件是空的"; exit 1; }
NCREATE=$(grep -c -E '^CREATE TABLE ' "$T/dump.sql" || true)
[ "$NCREATE" -gt 0 ] || { echo "::error::导出里一张表都没有（$(wc -c < "$T/dump.sql") 字节）——格式变了还是库是空的？"; exit 1; }

# ── manifest：每张表的行数从导出文件本身数（和这份备份严格一致，不受导出前后有人写入的影响）。
# 空表也列进去（行数 0），导回去时连"这张表在"一起核对。sqlite_sequence 是 SQLite 自己的表，不列。
grep -o -E '^CREATE TABLE (IF NOT EXISTS )?"?[A-Za-z0-9_]+"?' "$T/dump.sql" \
  | sed -E 's/^CREATE TABLE (IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?$/\2/' | grep -v '^sqlite_' \
  | LC_ALL=C sort -u > "$T/tables.txt"
grep -o -E '^INSERT INTO "[^"]+"' "$T/dump.sql" | sed -E 's/^INSERT INTO "([^"]+)"$/\1/' \
  | grep -v '^sqlite_' | LC_ALL=C sort | uniq -c | awk '{print $2 "\t" $1}' > "$T/rows.tsv" || true
TABLES_JSON=$(jq -Rn --rawfile rows "$T/rows.tsv" '
  ([inputs] | map({(.): 0}) | add // {}) as $empty
  | ($rows | split("\n") | map(select(length > 0) | split("\t") | {(.[0]): (.[1] | tonumber)}) | add // {}) as $counts
  | $empty + $counts' < "$T/tables.txt")
TOTAL=$(jq '[.[]] | add // 0' <<<"$TABLES_JSON")
[ "$TOTAL" -gt 0 ] || { echo "::error::导出里一行数据都没有——格式变了还是库是空的？"; exit 1; }
EXTRA=$(jq -r --slurpfile t <(jq -R . "$T/tables.txt" | jq -s .) 'keys - $t[0] | join(",")' <<<"$TABLES_JSON")
[ -z "$EXTRA" ] || { echo "::error::导出里有数据却没有建表语句的表：$EXTRA"; exit 1; }

# ── 导出器会改写的文本：从库里找出来，按原样补进备份
# wrangler 的导出器把文本里的换行写成 \n、回车写成 \r，整段包一层 replace(…,'\n',char(10))。同一段文字里
# 要是本来就有字面的 \n（公式里的 \nu、\neq，作文里打的 \n），导回去时一起变成换行；而且导回去再导出，
# 两份导出一模一样——"再导出比对"天然发现不了。restore-local 拿一条刁钻的数据照出来的（2026-10-01）。
# 所以导完把这种值从库里找出来，按主键定位，十六进制原样写成 UPDATE 附在导出文件末尾。
# 导出和这次查询之间隔着几秒，这几秒里正好改了的那一格会补成新值——只影响这一格，记在这里。
q_json() {  # 查询结果（JSON）写进 $T/q.json；失败时 wrangler 把错误写在 stdout，两边都带出来
  (cd "${WRANGLER_DIR:-$WORKER}" && npx wrangler d1 execute "$D1_NAME" "$MODE" --json --command "$1") > "$T/q.json" 2> "$T/q.err" \
    || { echo "::error::$2失败：$(jq -r '.error.text // empty' "$T/q.json" 2>/dev/null | head -c 300) $(tail -2 "$T/q.err" | tr '\n' ' ' | head -c 200)"; return 1; }
}
mapfile -t WITH_ROWS < <(jq -r 'to_entries[] | select(.value > 0) | .key' <<<"$TABLES_JSON")
: > "$T/fixups.sql"
if [ "${#WITH_ROWS[@]}" -gt 0 ]; then
  for t in "${WITH_ROWS[@]}"; do [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || { echo "::error::表名不认识：$t"; exit 1; }; done
  q_json "$(printf 'PRAGMA table_info("%s");' "${WITH_ROWS[@]}")" "读表结构" || exit 1
  # 每张表一条查询：主键用 quote() 取成 SQL 字面量，会被改写的格子取 hex()，其余格子是 NULL
  DETECT=$(jq -r --args '[$ARGS.positional, .] | transpose[] | .[0] as $t | .[1].results as $cols
    | ($cols | map(select(.name | test("^[A-Za-z0-9_]+$") | not)) | length) as $bad
    | if $bad > 0 then error("表 \($t) 有认不出的列名") else . end
    | ([$cols[] | select(.pk > 0)] | sort_by(.pk) | map(.name)) as $pk
    | ($cols | map(.name)) as $names
    | def lossy(c): "(typeof(\"\(c)\") = '"'"'text'"'"' AND (instr(\"\(c)\", char(10)) > 0 OR instr(\"\(c)\", char(13)) > 0) AND (instr(\"\(c)\", '"'"'\\n'"'"') > 0 OR instr(\"\(c)\", '"'"'\\r'"'"') > 0))";
      "SELECT '"'"'\($t)'"'"' AS \"__t\", "
      + (if ($pk | length) > 0 then ($pk | map("quote(\"\(.)\") AS \"__pk_\(.)\"") | join(", ")) else "NULL AS \"__nopk\"" end)
      + ", " + ($names | map("CASE WHEN \(lossy(.)) THEN hex(\"\(.)\") END AS \"\(.)\"") | join(", "))
      + " FROM \"\($t)\" WHERE " + ($names | map(lossy(.)) | join(" OR ")) + ";"' \
    "${WITH_ROWS[@]}" < "$T/q.json") || { echo "::error::拼不出查找语句"; exit 1; }
  q_json "$DETECT" "查找会被导出改写的文本" || exit 1
  if jq -e '[.[].results[] | select(has("__nopk"))] | length > 0' "$T/q.json" >/dev/null; then
    echo "::error::没有主键的表里有会被导出改写的文本，没法按原样补回：$(jq -r '[.[].results[] | select(has("__nopk")) | .__t] | unique | join(",")' "$T/q.json")"
    exit 1
  fi
  jq -r '.[].results[] | . as $r | ([to_entries[] | select(.key | startswith("__pk_"))]) as $pk
    | to_entries[] | select((.key | startswith("__")) | not) | select(.value != null)
    | "UPDATE \"\($r.__t)\" SET \"\(.key)\" = CAST(X'"'"'\(.value)'"'"' AS TEXT) WHERE "
      + ([$pk[] | "\"\(.key | ltrimstr("__pk_"))\" = \(.value)"] | join(" AND ")) + ";"' "$T/q.json" > "$T/fixups.sql"
fi
FIXUPS=$(grep -c . "$T/fixups.sql" || true)
if [ "$FIXUPS" -gt 0 ]; then
  { printf '\n-- xlearn 备份补丁（CR-M6）：下面这些文本同时含换行和字面的 \\n 或 \\r，导出器的写法导回去会走样，按原样补回\n'
    cat "$T/fixups.sql"; } >> "$T/dump.sql"
fi

# ── 加密，当场解一遍比对
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$D1_NAME-$STAMP.sql.gpg"
gpg_ --symmetric --cipher-algo AES256 --output "$OUT/$FILE" "$T/dump.sql"
PLAIN_SHA=$(sha256sum "$T/dump.sql" | cut -d' ' -f1)
gpg_ --decrypt --output "$T/check.sql" "$OUT/$FILE" \
  || { echo "::error::加密完解不回来"; rm -f "$OUT/$FILE"; exit 1; }
[ "$(sha256sum "$T/check.sql" | cut -d' ' -f1)" = "$PLAIN_SHA" ] \
  || { echo "::error::加密完解回来和原文不一样"; rm -f "$OUT/$FILE"; exit 1; }

jq -n --arg db "$D1_NAME" --arg file "$FILE" --arg plain "$PLAIN_SHA" \
  --arg cipher "$(sha256sum "$OUT/$FILE" | cut -d' ' -f1)" --argjson bytes "$(wc -c < "$T/dump.sql")" \
  --arg at "$(date -u +%FT%TZ)" --arg atbj "$(TZ=Asia/Shanghai date '+%F %T')" \
  --arg bm "${BACKUP_BOOKMARK:-}" --argjson tables "$TABLES_JSON" --argjson rows "$TOTAL" --argjson fixups "$FIXUPS" '
  { database: $db, file: $file, createdAt: $at, createdAtBeijing: $atbj,
    bookmark: (if $bm == "" then null else $bm end),
    plainSha256: $plain, plainBytes: $bytes, cipherSha256: $cipher,
    rows: $rows, tables: $tables, fixups: $fixups,
    howToDecrypt: "gpg --decrypt --output dump.sql \($file)（口令是 BACKUP_PASSPHRASE）；导回去用 d1-restore 流水线的 backup 方式，见 docs/数据恢复手册.md" }' \
  > "$OUT/manifest.json"

echo "备份完成：$(jq length <<<"$TABLES_JSON") 张表、$TOTAL 行，明文 $(( $(wc -c < "$T/dump.sql") / 1024 )) KB，导出用了 $SECS 秒；按原样补回的文本 $FIXUPS 处"
echo "  → $FILE（密文 $(( $(wc -c < "$OUT/$FILE") / 1024 )) KB），manifest.json"
