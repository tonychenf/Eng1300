#!/usr/bin/env bash
# 备份与导回的本地往返（CR-M6），不起服务：
#   d1-backup.sh 把本地库 A 整库导出、加密 → d1-import-backup.sh 解密、导进空库 B → 逐表核对、再导出逐字节比。
# 和线上演练（d1-drill）、部署里的备份跑的是同一份脚本，只是 --local。线上导出走 Cloudflare 的服务端，
# 本地走 miniflare，实现不同——这一套证明的是**我们的脚本**和**我们的表结构**导得出、导得回；
# 线上那条路由 d1-drill 在一次性库上证明。
#
# 另外证明每道核对都会红：
#   导进非空库、口令不对、密文被改过、manifest 的行数对不上、导回去再导出和备份不一样（类型被改写）。
# 以及明文不落地：密文里找不到明文，脚本的临时目录里也找不到。
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
CI="$REPO_DIR/scripts/ci"
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
T=$(mktemp -d)
G=$(mktemp -d /tmp/xlearn-gpg.XXXXXX)   # 测试自己做"被改写的备份"时用的 gpg 目录
cleanup() { GNUPGHOME="$G" gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$T" "$G"; }
trap cleanup EXIT

for x in a b c d; do bash "$CI/d1-tool-dir.sh" "$T/$x" "xlearn-rt-$x"; done
x() {  # x <库> <sql>
  (cd "$T/$1" && npx wrangler d1 execute "xlearn-rt-$1" --local --command "$2") > "$T/x.log" 2>&1 \
    || { echo "  !! 执行失败：$(grep -E 'ERROR|Error' "$T/x.log" | head -2)"; return 1; }
}
q() {  # q <库> <sql>：结果数组（JSON）
  (cd "$T/$1" && npx wrangler d1 execute "xlearn-rt-$1" --local --json --command "$2" 2>/dev/null) | jq -c '.[0].results'
}
counts() { WRANGLER_DIR="$T/$1" bash "$CI/d1-table-counts.sh" --local "xlearn-rt-$1"; }
imp() {  # imp <备份目录> <库> → 输出进 $T/imp.log，打印退出码
  TMPDIR="$T/tmp" WRANGLER_DIR="$T/$2" PROD_D1_NAME=xlearn \
    bash "$CI/d1-import-backup.sh" --local "$1" "xlearn-rt-$2" > "$T/imp.log" 2>&1; echo $?
}
leaks() { grep -r -a -l -e "$MARK" -e 'RT01' "$@" 2>/dev/null | wc -l; }   # 有几个文件里能找到明文
mkdir -p "$T/tmp"

echo "== 准备：本地库 A，迁移，导生化第 1 章，造几行刁钻的数据 =="
D1_NAME=xlearn-rt-a WRANGLER_DIR="$T/a" bash "$CI/apply-migrations.sh" --local > "$T/mig.log" 2>&1 \
  || { echo "迁移失败："; tail -10 "$T/mig.log"; exit 1; }
(cd "$REPO_DIR" && SEED_SUBJECT_DIR="$REPO_DIR/data/subjects/biochem" node scripts/build-seed-sql.mjs "$T/seed") > "$T/gen.log" 2>&1 \
  || { echo "生成生化种子失败："; tail -10 "$T/gen.log"; exit 1; }
for f in "$T"/seed/*.sql; do
  (cd "$T/a" && npx wrangler d1 execute xlearn-rt-a --local --file "$f") > "$T/seed.log" 2>&1 \
    || { echo "导 $(basename "$f") 失败："; tail -10 "$T/seed.log"; exit 1; }
done
MARK="rt-$$-往返标记"
# 换行、单双引号、反斜杠、百分号、emoji、NULL：导出成 SQL 文本再执行回去，最容易在这些地方走样
x a "INSERT INTO users (username, password_hash, role) VALUES ('RT01', 'it''s \"q\" \\ back', 'USER');
     INSERT INTO exam_parsing_notes (exam_id, note) VALUES ('biochem-ch01', '第一行
第二行：$MARK 😀 100% ''单'' \"双\" \\n（字面的反斜杠 n）');
     INSERT INTO system_settings (key, value, description) VALUES ('rt-null', '值', NULL);" || exit 1
A_COUNTS=$(counts a) || exit 1
echo "     库 A：$(jq length <<<"$A_COUNTS") 张表、$(jq '[.[]] | add' <<<"$A_COUNTS") 行"
TRICKY="SELECT u.password_hash, n.note, s.description IS NULL AS desc_null
          FROM users u, exam_parsing_notes n, system_settings s
         WHERE u.username = 'RT01' AND n.note LIKE '%往返标记%' AND s.key = 'rt-null';"
A_TRICKY=$(q a "$TRICKY")
check "（前提）刁钻的那几行在 A 里" "$(jq length <<<"$A_TRICKY")" "1"

echo
echo "== 备份：导出、加密 =="
export BACKUP_PASSPHRASE="本地往返测试的口令-$$-0123456789"
GPG_DIRS_BEFORE=$(ls -d /tmp/xlearn-gpg.* 2>/dev/null | grep -v -x "$G" | LC_ALL=C sort)
TMPDIR="$T/tmp" D1_NAME=xlearn-rt-a WRANGLER_DIR="$T/a" bash "$CI/d1-backup.sh" --local "$T/bk" > "$T/backup.log" 2>&1; RC=$?
sed 's/^/     /' "$T/backup.log"
check "备份成功" "$RC" "0"
check "目录里只有密文和 manifest" "$(ls "$T/bk" | sed -E 's/^xlearn-rt-a-[0-9]{8}-[0-9]{6}\.sql\.gpg$/密文/' | LC_ALL=C sort | paste -sd, -)" "manifest.json,密文"
check "manifest 记的每张表的行数就是 A 的行数" "$(jq -S -c .tables "$T/bk/manifest.json")" "$(jq -S -c . <<<"$A_COUNTS")"
check "manifest 的总行数" "$(jq .rows "$T/bk/manifest.json")" "$(jq '[.[]] | add' <<<"$A_COUNTS")"
# 导出器把"换行 + 字面的 \n"写走样（d1-backup.sh 里有来由），刁钻的那条存疑正是这种，要按原样补回
check "manifest 记下 1 处要按原样补回的文本（就是同时有换行和字面 \\n 的那条）" "$(jq .fixups "$T/bk/manifest.json")" "1"
check "密文和 manifest 里都找不到明文" "$(leaks "$T/bk")" "0"
check "脚本的临时目录里没留下明文" "$(leaks "$T/tmp")" "0"
check "gpg 的工作目录也删了" "$(ls -d /tmp/xlearn-gpg.* 2>/dev/null | grep -v -x "$G" | LC_ALL=C sort)" "$GPG_DIRS_BEFORE"

echo
echo "== 导进空库 B：解密、导入、逐表核对、再导出比 =="
RC=$(imp "$T/bk" b)
sed 's/^/     /' "$T/imp.log"
check "导入成功" "$RC" "0"
check "  逐表行数核对过了" "$(grep -c '^核对一' "$T/imp.log")" "1"
check "  再导出来，数据和备份逐行相同" "$(grep -c -E '^核对二：导进去再导出来，[0-9]+ 行数据和备份逐行相同' "$T/imp.log")" "1"
check "  按原样补回的那 1 处文本核对过了" "$(grep -c '^核对三：1 处' "$T/imp.log")" "1"
check "B 每张表的行数和 A 一样" "$(counts b)" "$A_COUNTS"
check "刁钻的那几行原样回来了（换行、引号、反斜杠、emoji、NULL）" "$(q b "$TRICKY")" "$A_TRICKY"
check "解密出来的明文没留在临时目录" "$(leaks "$T/tmp")" "0"

echo
echo "== 该红的都红 =="
RC=$(imp "$T/bk" b)
check "再导一次进 B（已经不是空库）：拒绝" "$RC/$(grep -c '不是空库' "$T/imp.log")" "1/1"
check "  B 没被动过" "$(counts b)" "$A_COUNTS"

RC=$(BACKUP_PASSPHRASE="不是这个口令-0123456789" imp "$T/bk" c)
check "口令不对：解不开" "$RC/$(grep -c '解不开' "$T/imp.log")" "1/1"
check "  C 还是空的" "$(counts c)" "{}"

cp -r "$T/bk" "$T/bk-tampered"
CF=$(ls "$T/bk-tampered"/*.gpg)
SIZE=$(wc -c < "$CF")
printf '\x5a' | dd of="$CF" bs=1 seek=$(( SIZE / 2 )) conv=notrunc 2>/dev/null
jq --arg s "$(sha256sum "$CF" | cut -d' ' -f1)" '.cipherSha256 = $s' "$T/bk/manifest.json" > "$T/bk-tampered/manifest.json"
RC=$(imp "$T/bk-tampered" c)
check "密文被改过（manifest 也跟着改了校验和）：gpg 发现、解不开" "$RC/$(grep -c '解不开' "$T/imp.log")" "1/1"
check "  被改过的明文没留在临时目录" "$(leaks "$T/tmp")" "0"
check "  C 还是空的" "$(counts c)" "{}"

cp -r "$T/bk" "$T/bk-rows"
jq '.tables.users += 1' "$T/bk/manifest.json" > "$T/bk-rows/manifest.json"
RC=$(imp "$T/bk-rows" c)
check "manifest 说 users 多一行：核对一报红并点名" "$RC/$(grep -c '逐表行数对不上：users（备份' "$T/imp.log")" "1/1"

# 核对二能红：做一份"导回去再导出就变样"的备份。往明文里加一行把数字 1.5 写进 TEXT 列——
# SQLite 按列的类型把它改写成文本 '1.5'，行数照样对得上（核对一过），只有再导出比才看得出来。
GNUPGHOME="$G" gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
  --output "$T/plain.sql" "$(ls "$T/bk"/*.gpg)" 3< <(printf '%s' "$BACKUP_PASSPHRASE") 2>/dev/null
printf '\nINSERT INTO "system_settings" ("key","value","description") VALUES('"'"'rt-affinity'"'"',1.5,NULL);' >> "$T/plain.sql"
mkdir -p "$T/bk-affinity"
NF="xlearn-rt-a-20260101-000000.sql.gpg"
GNUPGHOME="$G" gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
  --output "$T/bk-affinity/$NF" "$T/plain.sql" 3< <(printf '%s' "$BACKUP_PASSPHRASE")
jq --arg f "$NF" --arg p "$(sha256sum "$T/plain.sql" | cut -d' ' -f1)" \
   --arg c "$(sha256sum "$T/bk-affinity/$NF" | cut -d' ' -f1)" \
   '.file = $f | .plainSha256 = $p | .cipherSha256 = $c | .tables.system_settings += 1 | .rows += 1' \
   "$T/bk/manifest.json" > "$T/bk-affinity/manifest.json"
rm -f "$T/plain.sql"
RC=$(imp "$T/bk-affinity" d)
check "导回去再导出和备份不一样：核对一过、核对二报红" \
  "$RC/$(grep -c '^核对一' "$T/imp.log")/$(grep -c '数据和备份不一样' "$T/imp.log")" "1/1/1"

# 核对三能红：manifest 说要补回 1 处，备份里的补丁却丢了（导回去那条存疑就走样了）
GNUPGHOME="$G" gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
  --output "$T/plain.sql" "$(ls "$T/bk"/*.gpg)" 3< <(printf '%s' "$BACKUP_PASSPHRASE") 2>/dev/null
grep -v -E '^UPDATE ' "$T/plain.sql" > "$T/plain-nofix.sql"; rm -f "$T/plain.sql"
mkdir -p "$T/bk-nofix"
GNUPGHOME="$G" gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
  --output "$T/bk-nofix/$NF" "$T/plain-nofix.sql" 3< <(printf '%s' "$BACKUP_PASSPHRASE")
jq --arg f "$NF" --arg p "$(sha256sum "$T/plain-nofix.sql" | cut -d' ' -f1)" \
   --arg c "$(sha256sum "$T/bk-nofix/$NF" | cut -d' ' -f1)" '.file = $f | .plainSha256 = $p | .cipherSha256 = $c' \
   "$T/bk/manifest.json" > "$T/bk-nofix/manifest.json"
rm -f "$T/plain-nofix.sql"
bash "$CI/d1-tool-dir.sh" "$T/e" xlearn-rt-e
RC=$(imp "$T/bk-nofix" e)
check "备份里按原样补回的文本丢了：核对三报红" "$RC/$(grep -c '备份里补回的文本有 0 处，manifest 记的是 1 处' "$T/imp.log")" "1/1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
