#!/usr/bin/env bash
# 部署时补 AI 配置（原来内联在 deploy-worker.yml 里，CR-M4 搬出来：本地套件 prod-e2e-local、
# deploy-local 要拿同一份脚本对本地服务真跑一遍，内联在 YAML 里的逻辑只有上线才跑得到）。
#
# 三档都只补不改（CR-M10）：库里这一档已经有 Key 就不动，没有才写。
#   模型取仓库变量、没设就用默认值，Key 取 Secret——它们只管**第一次**部署时的初值，
#   以后换模型、换地址、换 Key 都在后台「AI 配置」页改。
#   以前「图片解析」「教学」两档每次部署都无条件重写，后台改过的东西下一次推送就被冲回去，
#   界面上看不出来。代价是：在 GitHub 里换了 SILICONFLOW_API_KEY 不会再同步到线上，
#   三档要在后台各改一次（用户 2026-10-01 确认这样）。
#   「文字解析」一直是只补不改：部署以前从来不写这一档，线上传 docx 让 AI 出答案时会退回
#   「图片解析」那档（OCR 模型）去干文字活。
#
# 判断配没配要读得到清单才算数：读不到（接口出错、返回不是这个形状）时不猜——猜"没配"会覆盖掉
# 管理员的配置，猜"配了"会让它一直空着。
#
# 需要：WORKER_URL、ADMIN_TOKEN、AI_API_KEY；可选 AI_BASE_URL、AI_PARSING_MODEL、
#       AI_TUTORING_MODEL、AI_TEXT_PARSING_MODEL
set -uo pipefail

if [ -z "${ADMIN_TOKEN:-}" ] || [ -z "${AI_API_KEY:-}" ]; then
  echo "::warning::缺少管理员令牌或 SILICONFLOW_API_KEY，跳过 AI 配置（可稍后在后台页面手工填写）。"
  exit 0
fi
AI_BASE_URL="${AI_BASE_URL:-https://api.siliconflow.cn/v1}"
TOKEN="$ADMIN_TOKEN"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

list_settings() {
  curl -sS -m 30 "$WORKER_URL/api/admin/ai/settings" -H "Authorization: Bearer $TOKEN"
}

# 第四个参数不为空时，表示这一档缺了也能凑合（有回落），额度用尽写不进去只告警不报错，
# 参数本身就是告警里"缺了会怎样"那半句。
put_cfg() {
  PURPOSE=$1; MODEL=$2; VISION=$3; IF_MISSING=${4:-}
  CODE=$(curl -sS -m 30 -o "$OUT" -w '%{http_code}' -X PUT \
    "$WORKER_URL/api/admin/ai/settings/$PURPOSE" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg u "$AI_BASE_URL" --arg k "$AI_API_KEY" --arg m "$MODEL" \
      --argjson v "$VISION" '{baseUrl:$u,apiKey:$k,model:$m,protocol:"openai",visionCapable:$v}')")
  if [ "$CODE" = "200" ]; then
    echo "  $PURPOSE 配置已写入（$MODEL）"
    return 0
  fi
  # 额度用尽时写不进去。库里已经有这项配置的话，跳过就跳过——不该
  # 因为一次改不了配置，就把后面的线上验证整步跳掉、看不到站点状态。
  # 库里本来就没有（首次部署），那是真缺东西，照常报错。
  if grep -q storage_quota_exceeded "$OUT" 2>/dev/null; then
    if [ "$(list_settings | jq -r --arg p "$PURPOSE" '.settings[$p].hasKey // false')" = "true" ]; then
      echo "::warning::D1 今日写入额度已用尽，$PURPOSE 配置沿用库里已有的那份。"
      return 0
    fi
    if [ -n "$IF_MISSING" ]; then
      echo "::warning::D1 今日写入额度已用尽，$PURPOSE 这次没补上：$IF_MISSING"
      return 0
    fi
    echo "::error::D1 今日写入额度已用尽，且库里没有 $PURPOSE 配置，AI 功能不可用。请在世界时零点后重跑。"
    exit 1
  fi
  echo "::error::写入 $PURPOSE 配置失败（HTTP $CODE）"; cat "$OUT"; exit 1
}

RAW=$(list_settings)
# 一档配没配：true / false / unreadable（接口出错、不是这个形状）
has_key() {
  printf '%s' "$RAW" | jq -r --arg p "$1" \
    'if (.settings | type) == "object" and (.settings | has($p))
     then (.settings[$p].hasKey // false | tostring) else "unreadable" end' 2>/dev/null
}
fill() {   # 用途 首次的模型 是否识图 [缺了也能凑合时，缺了会怎样]
  case "$(has_key "$1")" in
    true)  echo "  $1 已经配过，不动（只补不改）" ;;
    false) put_cfg "$@" ;;
    *)     echo "::error::读不到 AI 配置清单，判断不了「$1」配没配。收到的前 200 字：$(printf '%s' "$RAW" | head -c 200)"
           exit 1 ;;
  esac
}
fill PARSING "${AI_PARSING_MODEL:-deepseek-ai/DeepSeek-OCR}" true
fill TUTORING "${AI_TUTORING_MODEL:-Qwen/Qwen3-8B}" false
fill TEXT_PARSING "${AI_TEXT_PARSING_MODEL:-Qwen/Qwen3-8B}" false \
  "上传出题会先沿用「图片解析」那档，下次部署再补。"
