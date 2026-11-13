#!/usr/bin/env bash
# 在自己的服务器（Ubuntu）上架一层 nginx 反向代理：学员访问 https://你的域名，服务器替他去 Cloudflare 取。
# 用法（在服务器上，用 root 或 sudo）：
#   sudo bash setup-nginx.sh 你的域名 你的邮箱
#   例：sudo bash setup-nginx.sh xue.example.com me@example.com
# 可选环境变量：
#   PROXY_SECRET   代理和 Worker 之间的暗号；不给就现生成一个，最后打印出来，要把它加进 GitHub Secret「PROXY_SECRET」
#   UPSTREAM       Cloudflare 上的地址，默认 xlearn.eng1300-79fe2787.workers.dev
#   CONF_OUT       只把 nginx 配置写到这个文件就停（不装软件、不申请证书）——给测试和想先看一眼配置的人用
# 说明见 docs/自有服务器反向代理.md。
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
UPSTREAM="${UPSTREAM:-xlearn.eng1300-79fe2787.workers.dev}"
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "第一个参数要是域名，比如 xue.example.com（收到：${DOMAIN:-空}）"; exit 1
fi
if [ -z "${CONF_OUT:-}" ] && ! [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "第二个参数要是邮箱（申请免费 HTTPS 证书用，证书快过期时会发提醒；收到：${EMAIL:-空}）"; exit 1
fi
NEW_SECRET=0
if [ -z "${PROXY_SECRET:-}" ]; then PROXY_SECRET=$(openssl rand -hex 24); NEW_SECRET=1; fi
if ! [[ "$PROXY_SECRET" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
  echo "PROXY_SECRET 只能是 16–128 位字母、数字、下划线、连字符"; exit 1
fi

render() {
  cat <<CONF
# XLearn 反向代理（scripts/proxy/setup-nginx.sh 生成）。学员访问 $DOMAIN，这里替他去 $UPSTREAM 取。
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # 拍照导入一张照片压缩后最多几 MB，base64 再大三分之一
    client_max_body_size 25m;

    # Cloudflare 的地址会变：用变量 + resolver，按 TTL 重新解析，不在启动时钉死一个 IP
    resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
    resolver_timeout 5s;
    set \$xlearn_upstream $UPSTREAM;

    location / {
        proxy_pass https://\$xlearn_upstream;
        proxy_ssl_server_name on;
        proxy_ssl_name $UPSTREAM;
        proxy_set_header Host $UPSTREAM;
        # 真实来源 IP + 暗号：Worker 对得上暗号才认 X-Real-IP（登录锁定按来源 IP 分开计）
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Proxy-Secret "$PROXY_SECRET";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        # 核答案传原书答案页、AI 出答案，单次请求最长要一分半
        proxy_connect_timeout 15s;
        proxy_send_timeout 180s;
        proxy_read_timeout 180s;
    }
}
CONF
}

if [ -n "${CONF_OUT:-}" ]; then
  render > "$CONF_OUT"
  echo "配置写到了 $CONF_OUT（没装软件、没申请证书）"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "要用 root 跑：sudo bash $0 $DOMAIN $EMAIL"; exit 1; }

echo "== 1/5 装 nginx 和证书工具 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y nginx certbot python3-certbot-nginx >/dev/null

echo "== 2/5 先确认服务器连得上 Cloudflare 那边 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://$UPSTREAM/api/health" || true)
[ "$code" = 200 ] || { echo "服务器访问 https://$UPSTREAM/api/health 拿到的是 ${code:-连不上}，不是 200；先查服务器的出网"; exit 1; }

echo "== 3/5 写 nginx 配置 =="
CONF=/etc/nginx/sites-available/xlearn
render > "$CONF"
chmod 640 "$CONF"            # 里面有暗号，别人读不到
ln -sf "$CONF" /etc/nginx/sites-enabled/xlearn
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

echo "== 4/5 确认域名已经指向这台服务器 =="
MY_IP=$(curl -s -4 -m 10 https://ifconfig.me || true)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [ -n "$MY_IP" ] && [ "$MY_IP" != "$DNS_IP" ]; then
  echo "域名 $DOMAIN 现在解析到 ${DNS_IP:-（没解析）}，这台服务器的公网 IP 是 $MY_IP。"
  echo "先到域名的 DNS 设置里加一条 A 记录：$DOMAIN → $MY_IP，等几分钟生效后再跑一次这个脚本。"
  exit 1
fi

echo "== 5/5 申请免费 HTTPS 证书（Let's Encrypt），并把 http 跳到 https =="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
systemctl reload nginx

code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://$DOMAIN/api/health" || true)
echo
if [ "$code" = 200 ]; then echo "好了：https://$DOMAIN 能用了（健康检查 200）。"; else echo "证书装好了，但 https://$DOMAIN/api/health 回的是 ${code:-连不上}，把这一屏发给 Claude 看。"; fi
if [ "$NEW_SECRET" = 1 ]; then
  echo
  echo "还差一步：把下面这串暗号加进 GitHub 仓库的 Secret，名字叫 PROXY_SECRET（Settings → Secrets and variables → Actions → New repository secret），"
  echo "然后让 Claude 重新部署一次。没加之前网站照样能用，只是登录锁定会把所有人算成同一个来源。"
  echo
  echo "    $PROXY_SECRET"
  echo
  echo "（暗号也存在 $CONF 里；这个文件只有 root 能读。不要发在聊天里，也不要提交进仓库。）"
fi
