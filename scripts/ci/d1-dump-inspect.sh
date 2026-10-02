#!/usr/bin/env bash
# 解开一份 d1-backup.sh 做的备份，只打印结构信息（CR-M6，2026-10-02）：备份导不进新库时用来查原因。
#
# 打印什么、为什么只打印结构，见 d1-dump-tool.py 开头：表名、语句种类、条数、字节数、文件里的位置，
# 外键检查和几种导法的结果；任何一个值都不打——仓库是公开的，流水线日志谁都能看。
# 明文只在 mktemp 的临时目录里，退出就删。不连任何库。
#
# 用法：d1-dump-inspect.sh <备份目录>
# 需要：BACKUP_PASSPHRASE
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${1:-}"
[ -d "$DIR" ] || { echo "::error::备份目录不存在：$DIR"; exit 1; }
[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "::error::缺 BACKUP_PASSPHRASE"; exit 1; }
[ -f "$DIR/manifest.json" ] || { echo "::error::$DIR 里没有 manifest.json，不是 d1-backup.sh 做的备份"; exit 1; }
FILE=$(jq -r '.file // empty' "$DIR/manifest.json")
[ -n "$FILE" ] && [ -f "$DIR/$FILE" ] || { echo "::error::manifest 里写的密文「$FILE」不在 $DIR 里"; exit 1; }
[ "$(sha256sum "$DIR/$FILE" | cut -d' ' -f1)" = "$(jq -r .cipherSha256 "$DIR/manifest.json")" ] \
  || { echo "::error::密文的校验和和 manifest 对不上"; exit 1; }

T=$(mktemp -d)
export GNUPGHOME; GNUPGHOME=$(mktemp -d /tmp/xlearn-gpg.XXXXXX)
cleanup() { gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$T" "$GNUPGHOME"; }
trap cleanup EXIT
if ! gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3 \
       --decrypt --output "$T/dump.sql" "$DIR/$FILE" 3< <(printf '%s' "$BACKUP_PASSPHRASE") 2> "$T/gpg.log"; then
  rm -f "$T/dump.sql"
  echo "::error::解不开：口令不对，或者密文被改过"
  exit 1
fi
[ "$(sha256sum "$T/dump.sql" | cut -d' ' -f1)" = "$(jq -r .plainSha256 "$DIR/manifest.json")" ] \
  || { echo "::error::解出来的内容和做备份时的校验和对不上"; exit 1; }
echo "诊断：备份 $FILE（$(jq -r .createdAtBeijing "$DIR/manifest.json") 北京时间，$(jq -r '.tables | length' "$DIR/manifest.json") 张表、$(jq -r .rows "$DIR/manifest.json") 行）"
python3 "$HERE/d1-dump-tool.py" inspect "$T/dump.sql"
