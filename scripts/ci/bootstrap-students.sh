#!/usr/bin/env bash
# 建学员账号 T001–T010，已存在的跳过；新建的一并开通当时全部启用的学科（CR-M13）。
#
# 需要：WORKER_URL、ADMIN_TOKEN、STUDENT_PASSWORD
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e
# 临时文件放在自己的目录里：本地两个套件会同时跑这几份脚本，用 /tmp 下的固定文件名会互相覆盖
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

if [ -z "${ADMIN_TOKEN:-}" ] || [ -z "$STUDENT_PASSWORD" ]; then
  echo "::warning::缺少管理员令牌或 STUDENT_PASSWORD，跳过学员账号初始化。"
  exit 0
fi
TOKEN="$ADMIN_TOKEN"

# N2 之后新建学员默认没有任何学科授权，而 N2 那段"给既有学员补授权"的迁移只给迁移那一刻
# 已有的学员补、跑一次就上门闩。线上这 10 个账号比 N2 早，被补过；在新库上（重建库、预发环境）
# 这里建出来的账号一个学科都没有，学员登录只看到"管理员尚未为你开通任何学科"（CR-M13）。
# 所以建号时一并开通当时全部启用的学科——和线上这 10 个账号现在的状态一致。
# 只对新建的生效：已存在的账号照旧跳过，管理员撤销过的授权不会被补回来。
# 读不到学科清单就停：当成"没有学科"会建出一批什么都打不开的账号，而且不报错。
SUBJ_RAW=$(curl -sS -m 30 "$WORKER_URL/api/admin/subjects" -H "Authorization: Bearer $TOKEN" || true)
SUBJECTS=$(printf '%s' "$SUBJ_RAW" | jq -c '[.subjects[] | select(.status == "启用") | .code]' 2>/dev/null || true)
if [ -z "$SUBJECTS" ]; then
  echo "::error::读不到学科清单，没法给新建的学员开通学科。收到的前 200 字：$(printf '%s' "$SUBJ_RAW" | head -c 200)"
  exit 1
fi
echo "新建的账号会开通：$(printf '%s' "$SUBJECTS" | jq -r 'join("、")')"

for i in $(seq -w 1 10); do
  NAME="T0$i"
  CODE=$(curl -sS -m 30 -o "$T/user.json" -w '%{http_code}' -X POST "$WORKER_URL/api/admin/users" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg u "$NAME" --arg p "$STUDENT_PASSWORD" --argjson s "$SUBJECTS" \
      '{username:$u,password:$p,subjects:$s}')")
  case "$CODE" in
    201) echo "  已创建 $NAME" ;;
    409) echo "  $NAME 已存在，跳过" ;;
    *)   echo "::error::创建 $NAME 失败（HTTP $CODE）"; cat "$T/user.json"; exit 1 ;;
  esac
done
