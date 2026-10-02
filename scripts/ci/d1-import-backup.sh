#!/usr/bin/env bash
# 把 d1-backup.sh 做的加密备份导进一个**新的空库**，再逐表核对（CR-M6）。
#
# 只导进空库，并且不许是线上库：直接往线上库里导，要么撞主键半途失败，要么得先清空线上库，
# 两样都比手上的事故更糟。恢复线上的路是：导进新库 → 核对 → 把 worker/wrangler.toml 的
# database_name 改成新库名推送，部署就绑到新库上（docs/数据恢复手册.md）。旧库留着查原因。
#
# 核对三道：
#   1. 每张表的行数和 manifest 一致（manifest 是做备份时从导出文件本身数的）；
#   2. 把导进去的库再导出来，数据行（INSERT）和备份逐行比：行数对上、内容错了它也看得出来。
#      只比数据行、不比建表语句：本地导入时 wrangler 会把建表语句里的注释剥成空行，数据没变、文本变了。
#      导出只读，不占写入额度。
#   3. 备份末尾"按原样补回"的那些文本（d1-backup.sh 里有来由），逐个查一遍导进去的值和原样一致——
#      导出器会把它们写走样，而走样的值再导出、写法一模一样，第 2 道看不出来。
#      期望值留在本地，发给 D1 的只是"按主键取回十六进制"，一句一百来字节、和文本多长无关，分批发
#      （以前把原文十六进制整个塞进一条命令，文本越多越长，D1 和命令行都有长度上限：d1-query-chunks.sh）。
#
# 用法：d1-import-backup.sh --remote|--local <备份目录（d1-backup.sh 的输出）> <目标库名>
# 需要：BACKUP_PASSPHRASE
# 可选：WRANGLER_DIR（在哪个目录跑 wrangler，默认仓库的 worker/）、PROD_D1_NAME（默认读 wrangler.toml）、
#       IMPORT_ORDER（as-is：原样导，默认；parent-first：建表语句放最前、数据按外键先父后子重排再导，见 d1-dump-tool.py）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER="$(cd "$HERE/../../worker" && pwd)"
case "${IMPORT_ORDER:-as-is}" in
  as-is|parent-first) ;;
  *) echo "::error::IMPORT_ORDER 只能是 as-is 或 parent-first，拿到的是「${IMPORT_ORDER}」"; exit 1 ;;
esac
case "${1:-}" in
  --remote) MODE=--remote ;;
  --local)  MODE=--local ;;
  *) echo "::error::用法：d1-import-backup.sh --remote|--local <备份目录> <目标库名>"; exit 1 ;;
esac
DIR="${2:-}"; TARGET="${3:-}"
[ -d "$DIR" ] || { echo "::error::备份目录不存在：$DIR"; exit 1; }
[[ "$TARGET" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || { echo "::error::目标库名不合法：「$TARGET」"; exit 1; }
PROD="${PROD_D1_NAME:-$(bash "$HERE/d1-name.sh")}"
if [ "$TARGET" = "$PROD" ]; then
  echo "::error::目标是线上库「$PROD」，拒绝。备份只导进新库：导完核对，再把 wrangler.toml 的 database_name 改成新库名。"
  exit 1
fi
[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "::error::缺 BACKUP_PASSPHRASE"; exit 1; }
[ -f "$DIR/manifest.json" ] || { echo "::error::$DIR 里没有 manifest.json，不是 d1-backup.sh 做的备份"; exit 1; }
FILE=$(jq -r '.file // empty' "$DIR/manifest.json")
[ -n "$FILE" ] && [ -f "$DIR/$FILE" ] || { echo "::error::manifest 里写的密文「$FILE」不在 $DIR 里"; exit 1; }
[ "$(sha256sum "$DIR/$FILE" | cut -d' ' -f1)" = "$(jq -r .cipherSha256 "$DIR/manifest.json")" ] \
  || { echo "::error::密文的校验和和 manifest 对不上：拿错了文件，或者文件坏了"; exit 1; }
echo "备份：$FILE（$(jq -r .createdAtBeijing "$DIR/manifest.json") 北京时间，$(jq -r '.tables | length' "$DIR/manifest.json") 张表、$(jq -r .rows "$DIR/manifest.json") 行）→ $TARGET"

T=$(mktemp -d)
export GNUPGHOME; GNUPGHOME=$(mktemp -d /tmp/xlearn-gpg.XXXXXX)
cleanup() { gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$T" "$GNUPGHOME"; }
trap cleanup EXIT
redact() { sed -E 's#https?://[^[:space:]"'"'"']+#[链接已隐去]#g'; }
cd "${WRANGLER_DIR:-$WORKER}"

# ── 解密。gpg 发现密文被改过时照样会把（坏的）明文写出来、只是退出码非 0，所以失败一律删掉输出
if ! gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3 \
       --decrypt --output "$T/dump.sql" "$DIR/$FILE" 3< <(printf '%s' "$BACKUP_PASSPHRASE") 2> "$T/gpg.log"; then
  rm -f "$T/dump.sql"
  echo "::error::解不开：口令不对，或者密文被改过（$(tr '\n' ' ' < "$T/gpg.log" | head -c 200)）"
  exit 1
fi
[ "$(sha256sum "$T/dump.sql" | cut -d' ' -f1)" = "$(jq -r .plainSha256 "$DIR/manifest.json")" ] \
  || { echo "::error::解出来的内容和做备份时的校验和对不上"; exit 1; }

# ── 目标必须是空库（库不存在时 wrangler 会报错，照样停在这里）
if ! npx wrangler d1 execute "$TARGET" "$MODE" --json --command \
     "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
        AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_';" > "$T/n.json" 2> "$T/n.err"; then
  echo "::error::读不了目标库「$TARGET」（不存在？先建库）：$(jq -r '.error.text // empty' "$T/n.json" 2>/dev/null | head -c 200) $(tail -3 "$T/n.err" | tr '\n' ' ' | head -c 300)"
  exit 1
fi
N=$(jq -r '.[0].results[0].n // "读不到"' "$T/n.json")
[ "$N" = "0" ] || { echo "::error::目标库「$TARGET」不是空库（已有 $N 张表），拒绝往里导"; exit 1; }

# ── 导入
# 2026-10-02 演练照出：线上那份备份导不进新库。线上库跑过 N3 的旧表重建，questions、knowledge_points 在
# sqlite_master 里排到了子表后面，导出按建表顺序写，子表的数据就排在父表的建表语句前面——外键开着时往子表插
# 一行，父表还没建就报 no such table（本地照样复现）。parent-first 先把建表语句全放最前、数据按外键先父后子排。
IMPORT_FILE="$T/dump.sql"
if [ "${IMPORT_ORDER:-as-is}" = "parent-first" ]; then
  python3 "$HERE/d1-dump-tool.py" reorder "$T/dump.sql" "$T/reordered.sql" > "$T/reorder.log" 2>&1 \
    || { echo "::error::重排失败：$(tail -3 "$T/reorder.log" | tr '\n' ' ' | head -c 400)"; exit 1; }
  sed 's/^/导入顺序：/' "$T/reorder.log"
  IMPORT_FILE="$T/reordered.sql"
fi
START=$(date +%s)
if ! npx wrangler d1 execute "$TARGET" "$MODE" --file "$IMPORT_FILE" -y > "$T/import.log" 2>&1; then
  echo "::error::导入失败（链接已涂掉）："; tail -20 "$T/import.log" | redact
  exit 1
fi
echo "导入用了 $(( $(date +%s) - START )) 秒"

# ── 核对一：每张表的行数
WRANGLER_DIR="$PWD" bash "$HERE/d1-table-counts.sh" "$MODE" "$TARGET" > "$T/counts.json"
DIFF=$(jq -r --slurpfile got "$T/counts.json" '
  .tables as $want | $got[0] as $g
  | [ ($want | to_entries[] | select(($g[.key] // -1) != .value)
        | "\(.key)（备份 \(.value) 行，导进去 \($g[.key] // "没有这张表")）"),
      ($g | keys[] | select($want[.] == null) | "\(.)（备份里没有这张表，导进去却有）") ]
  | join("；")' "$DIR/manifest.json")
if [ -n "$DIFF" ]; then echo "::error::逐表行数对不上：$DIFF"; exit 1; fi
echo "核对一：$(jq -r '.tables | length' "$DIR/manifest.json") 张表的行数和备份一致"

# ── 核对二：导回来再导出，数据行和备份比
if ! npx wrangler d1 export "$TARGET" "$MODE" --output "$T/again.sql" -y > "$T/export.log" 2>&1; then
  echo "::error::导进去之后再导出失败（链接已涂掉）："; tail -20 "$T/export.log" | redact
  exit 1
fi
grep '^INSERT INTO ' "$T/dump.sql" > "$T/rows-backup.sql" || true
grep '^INSERT INTO ' "$T/again.sql" > "$T/rows-again.sql" || true
NROWS=$(wc -l < "$T/rows-backup.sql")
if cmp -s "$T/rows-backup.sql" "$T/rows-again.sql"; then
  echo "核对二：导进去再导出来，$NROWS 行数据和备份逐行相同"
elif cmp -s <(LC_ALL=C sort "$T/rows-backup.sql") <(LC_ALL=C sort "$T/rows-again.sql"); then
  echo "核对二：导进去再导出来，$NROWS 行数据和备份相同（顺序不同）"
else
  echo "::error::导进去再导出来，数据和备份不一样（$(diff <(LC_ALL=C sort "$T/rows-backup.sql") <(LC_ALL=C sort "$T/rows-again.sql") | grep -c '^[<>]') 行有出入）"
  exit 1
fi

# ── 核对三：按原样补回的文本，逐个看导进去的值
grep -E '^UPDATE "[A-Za-z0-9_]+" SET "[A-Za-z0-9_]+" = CAST\(X'"'"'[0-9A-F]*'"'"' AS TEXT\) WHERE .+;$' "$T/dump.sql" > "$T/fixups.sql" || true
NFIX=$(grep -c . "$T/fixups.sql" || true)
[ "$NFIX" = "$(jq -r '.fixups // 0' "$DIR/manifest.json")" ] \
  || { echo "::error::备份里补回的文本有 $NFIX 处，manifest 记的是 $(jq -r '.fixups // 0' "$DIR/manifest.json") 处"; exit 1; }
if [ "$NFIX" -gt 0 ]; then
  # 第 n 处补丁 → 「SELECT n AS i, hex(列) AS h FROM 表 WHERE 主键」发给 D1；「n 十六进制」留在本地比
  RE='^([0-9]+) UPDATE ("[A-Za-z0-9_]+") SET ("[A-Za-z0-9_]+") = CAST\(X'"'"'([0-9A-F]*)'"'"' AS TEXT\) WHERE (.+);$'
  awk '{ print NR " " $0 }' "$T/fixups.sql" | sed -E "s/$RE/SELECT \1 AS i, hex(\3) AS h FROM \2 WHERE \5;/" > "$T/verify-fixups.sql"
  awk '{ print NR " " $0 }' "$T/fixups.sql" | sed -E "s/$RE/\1 \4/" > "$T/expected.txt"
  # 用 --command 不用 --file：线上的 --file 走导入接口，不回查询结果
  if ! WRANGLER_DIR="$PWD" bash "$HERE/d1-query-chunks.sh" "$MODE" "$TARGET" "$T/verify-fixups.sql" > "$T/vf.json" 2> "$T/vf.err"; then
    echo "::error::核对补回的文本时查询失败：$(tail -3 "$T/vf.err" | tr '\n' ' ' | head -c 600)"; exit 1
  fi
  # 主键对不上（补丁落空）时那一句查不到行，取不到值，同样算不一致
  BAD=$(jq -r --rawfile exp "$T/expected.txt" '
    ([.[].results[] | {(.i | tostring): .h}] | add // {}) as $got
    | [$exp | split("\n")[] | select(length > 0) | split(" ") | select($got[.[0]] != (.[1] // "")) | .[0]]
    | join(",")' "$T/vf.json") || { echo "::error::读不懂核对补回文本的查询结果"; exit 1; }
  if [ -n "$BAD" ]; then
    echo "::error::按原样补回的 $NFIX 处文本里，有 $(tr ',' '\n' <<<"$BAD" | grep -c .) 处导进去的值和备份不一致（第 $BAD 处补丁）"
    exit 1
  fi
  echo "核对三：$NFIX 处会被导出改写的文本，导进去的值和原样一致；查询$(sed -n 's/^分批：//p' "$T/vf.err" | tail -1)"
else
  echo "核对三：没有会被导出改写的文本"
fi
echo "导入完成：$TARGET"
