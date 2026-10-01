#!/usr/bin/env bash
# d1-restore 流水线的输入检查（CR-M6）：动手之前先把填的东西核一遍，说清楚接下来要做什么。
# 填错了就停在这里，什么都没碰。
#
# 需要（流水线的手动输入）：MODE（time-travel | backup）、CONFIRM_NAME，以及
#   time-travel：POINT；确认填线上库名（D1_NAME）
#   backup：BACKUP_RUN_ID、NEW_DB_NAME；确认填新库名，新库名不能是线上库名
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D1="${D1_NAME:?需要 D1_NAME}"
case "${MODE:-}" in
  time-travel)
    bash "$HERE/d1-restore.sh" --parse-only "${POINT:-}"
    [ "${CONFIRM_NAME:-}" = "$D1" ] || { echo "::error::确认栏要填线上库名「$D1」（填的是「${CONFIRM_NAME:-}」）。没动手。"; exit 1; }
    echo "要做的事：把线上库「$D1」整库恢复到上面这个时间点。之后的写入全部丢掉（动手前会先打出撤销书签）；"
    echo "恢复完补齐表结构（跑部署里那几步只补不删的脚本），再对比恢复前后每张表的行数。"
    ;;
  backup)
    [[ "${BACKUP_RUN_ID:-}" =~ ^[0-9]+$ ]] || { echo "::error::备份所在的部署运行编号应该是一串数字（部署运行页网址里 runs/ 后面那串），填的是「${BACKUP_RUN_ID:-}」"; exit 1; }
    [[ "${NEW_DB_NAME:-}" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || { echo "::error::新库名只能用小写字母、数字和连字符（例如 $D1-restored-$(date +%Y%m%d)），填的是「${NEW_DB_NAME:-}」"; exit 1; }
    [ "$NEW_DB_NAME" != "$D1" ] || { echo "::error::新库名不能是线上库名「$D1」：备份只导进新库"; exit 1; }
    [ "${CONFIRM_NAME:-}" = "$NEW_DB_NAME" ] || { echo "::error::确认栏要填新库名「$NEW_DB_NAME」（填的是「${CONFIRM_NAME:-}」）。没动手。"; exit 1; }
    echo "要做的事：取部署运行 $BACKUP_RUN_ID 存下的加密备份，新建库「$NEW_DB_NAME」，解密导进去，逐表核对。"
    echo "线上库「$D1」不碰。核对没问题、要切过去时，把 worker/wrangler.toml 的 database_name 改成「$NEW_DB_NAME」推送。"
    ;;
  *) echo "::error::恢复方式只能是 time-travel 或 backup（填的是「${MODE:-}」）"; exit 1 ;;
esac
