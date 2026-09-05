# MVP 服务器 — Cloudflare Workers + D1 部署版

这是 `../server`（Node + Express + 本地 SQLite）的**同一套登录/权限逻辑**，改写成 Cloudflare Workers + D1，用于部署到一个真正的、免费、支持多人同时访问的公网地址：

- Cloudflare Workers 是按请求计费的无服务器架构，**没有"休眠"问题**（不像很多免费 PaaS 平台空闲后会休眠、首次访问要等几十秒），多个用户同时访问也能正常并发处理。
- D1 是 Cloudflare 的免费托管数据库，数据**持久保存**，不会因为服务重启/重新部署而丢失（这点比很多"免费 Node 托管"更适合我们这个需要保存用户账号的场景——调研发现同类免费平台如 Render，免费档的磁盘是"临时"的，一旦服务休眠重启，本地 SQLite 文件就会被清空，账号数据会随机消失，不适合这个用途）。
- 已经在本地用 `wrangler dev`（Cloudflare 官方 CLI 的本地模拟环境）完整跑通了一遍登录、建号、越权拦截、禁用账号的流程，逻辑与 `../server` 那版一致。

## 我需要你提供什么才能部署上线

Cloudflare 账号必须是**你自己的**（这样这套系统以后才归你管理），我这边没办法替你注册账号或完成登录验证。麻烦你花大概 2 分钟做这几步，把结果发给我，剩下的部署工作我来完成：

1. **注册/登录 Cloudflare**：https://dash.cloudflare.com/sign-up （免费，Workers + D1 这档不需要绑信用卡）。如果你已经有账号可跳过。
2. **拿到 Account ID**：登录后在右侧栏能看到 "Account ID"，复制给我。
3. **创建 API Token**：打开 https://dash.cloudflare.com/profile/api-tokens → "Create Token" → 选择模板 "Edit Cloudflare Workers"（会自动包含 Workers 脚本编辑 + D1 编辑权限）→ 创建后把生成的 Token 值发给我。
   - 这个 Token 部署完成后你可以随时在同一个页面里删除/重新生成，不影响已经部署好的服务。

拿到这两样东西后，我会在这边执行：创建 D1 数据库、写入表结构、部署 Worker，最后给你一个形如 `https://eng1300-mvp.<你的子域>.workers.dev` 的公网地址。

## 部署后的初始化（我会代你执行，这里记录做了什么）

D1 是云端数据库，不能像本地 Node 版那样直接跑一个 `npm run seed` 脚本。所以这版加了一个**一次性初始化接口**：

```
POST /api/setup
Header: X-Setup-Token: <部署时设置的一次性令牌>
Body: {"username": "admin", "password": "你指定的初始密码"}
```

只有在用户表为空、且携带正确的 `X-Setup-Token` 时才会成功创建唯一的超级管理员账号；调用一次成功后这个接口会永久失效（用户表不再为空）。这个令牌只在部署时使用一次，之后可以从 Worker 配置里删除。

## 接口列表（与本地 Node 版完全一致）

- `POST /api/auth/login` — 登录
- `GET /api/me` — 当前用户信息
- `GET /api/admin/users` / `POST /api/admin/users` / `POST /api/admin/users/:id/reset-password` / `PATCH /api/admin/users/:id/status` — 仅超级管理员

## 本地开发（不需要 Cloudflare 账号）

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # 填 JWT_SECRET / SETUP_TOKEN
npm run db:migrate:local
npm run dev
```

`wrangler dev --local` 会在本机模拟 D1，不需要登录 Cloudflare 账号即可开发测试。
