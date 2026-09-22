# MVP 服务器 — Cloudflare Workers + D1 部署版

## 线上地址

**https://eng1300-mvp.eng1300-79fe2787.workers.dev**

已上线并通过线上验证（健康检查、未登录 401、admin 登录返回超级管理员角色、超级管理员可访问后台用户接口）。

### 已知缺口（下一阶段要补）

- 登录接口没有失败次数限制，公网可访问的情况下存在被暴力猜密码的风险，需要加限流/锁定。
- 普通用户尚无「修改自己密码」的接口（设计里有，MVP 未实现）；管理员可通过重置密码接口代为处理。


这是 `../server`（Node + Express + 本地 SQLite）的**同一套登录/权限逻辑**，改写成 Cloudflare Workers + D1，用于部署到一个真正的、免费、支持多人同时访问的公网地址：

- Cloudflare Workers 是按请求计费的无服务器架构，**没有"休眠"问题**（不像很多免费 PaaS 平台空闲后会休眠、首次访问要等几十秒），多个用户同时访问也能正常并发处理。
- D1 是 Cloudflare 的免费托管数据库，数据**持久保存**，不会因为服务重启/重新部署而丢失（这点比很多"免费 Node 托管"更适合我们这个需要保存用户账号的场景——调研发现同类免费平台如 Render，免费档的磁盘是"临时"的，一旦服务休眠重启，本地 SQLite 文件就会被清空，账号数据会随机消失，不适合这个用途）。
- 已经在本地用 `wrangler dev`（Cloudflare 官方 CLI 的本地模拟环境）完整跑通了一遍登录、建号、越权拦截、禁用账号的流程，逻辑与 `../server` 那版一致。

## 怎么部署：由 GitHub Actions 自动完成

Claude Code 的沙盒开发环境出站网络策略禁止访问 `api.cloudflare.com`，无法在里面直接部署。因此部署交给 GitHub Actions 执行（`.github/workflows/deploy-worker.yml`），它跑在 GitHub 的运行器上，网络不受限制。

流水线会自动完成：解析 Cloudflare 账号 ID → 确保 workers.dev 子域名存在 → 创建（或复用）D1 数据库 → 建表 → 部署 Worker → 生成并写入 `JWT_SECRET` / `SETUP_TOKEN` → 调用一次 `/api/setup` 创建超级管理员 → 输出公网地址。

**唯一需要人工做的一步**：在仓库里添加两个 Secret（Settings → Secrets and variables → Actions → New repository secret）：

| Secret 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（模板选 "Edit Cloudflare Workers"，需含 D1:Edit 权限） |
| `ADMIN_PASSWORD` | 你想用的超级管理员 `admin` 初始密码 |

添加后重跑一次流水线即可。流水线是幂等的：数据库和密钥已存在时会复用，不会重复创建，也不会覆盖已有的超级管理员账号。

Cloudflare API Token 的获取方式：https://dash.cloudflare.com/profile/api-tokens → "Create Token" → 模板 "Edit Cloudflare Workers"。部署完成后可随时在同一页面删除或轮换该 Token。

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

## D1 免费版每日写入额度

免费版每天 10 万行写入，世界时零点（北京时间早八点）重置。这个额度在
2026-09-06 被耗光过一次，整站不可用，教训记在这里：

**为什么会耗光。** 流水线原先每次部署都无条件重导整套题库，一次约 5700 行；
连着部署十几次就到顶了。现在每个种子文件末尾自带内容指纹（写进 `seed_state`），
指纹没变就跳过，稳态部署零题库写入。指纹和数据同属一次 `d1 execute --file`
导入——早先分两次调用，第一次成功第二次撞额度，数据进去了指纹没记上，
下次部署原样重导再死在同一处，每跑一次白烧约 578 行，永远走不出来。

**额度用尽时会怎样。** 站点退化成"写不进新数据"，不是"打不开"：

- 登录照常放行。登录成功后那两条记账写入（清失败计数、更新最后登录时间）
  是尽力而为的，写不进去不影响发令牌。
- 组卷、交卷、练习作答这些真要落库的操作会失败，接口返回 503
  `storage_quota_exceeded`，前端显示一句说明何时恢复。
- 流水线里的迁移、部署、写密钥都不涉及行写入，代码照常能发布。题库导入
  会停在额度耗尽处并说明原因；AI 配置写不进去时，库里已有配置就沿用并
  打 warning，不挡住后面的线上验证。

**恢复办法。** 等世界时零点重置后重跑一次 `deploy-worker.yml`。

**排查用的额度读数**：`wrangler d1 execute` 每次都会打印本次的
`rows_read` / `rows_written`，想知道某一步花了多少，看它就行。
