# Eng1300 — 自考英语真题练习系统

把 20 套自考英语（二）/英语（专升本）历年真题结构化进数据库，提供按真题结构随机
组卷的限时模考、按掌握度自适应出题的专项练习、自动收录的错题本，以及 AI 作文批改
与应试能力预测。

部署在 Cloudflare Workers + D1，**完全免费、公网可访问、手机/平板/PC 三端适配**。

| | |
|---|---|
| 题库 | 20 套真题 · 1020 道题 · 21 个考点标签 |
| 试卷 | 七个部分 · 51 题 · 100 分 · 150 分钟 |
| 技术栈 | Cloudflare Workers + D1 + Hono / React + Vite |
| 测试 | 240 条断言（含真实 AI 服务商的线上端到端实测） |

## 文档

**接手这个项目，从 [`docs/项目全档.md`](docs/项目全档.md) 开始** —— 背景与取舍、
技术方案、数据管线、数据库设计、核心算法、测试策略、部署流程、踩过的坑，以及从零
复现的可执行步骤。

其余文档各有分工，别在一份里找另一份的内容：

| 文件 | 内容 |
|---|---|
| [`docs/项目全档.md`](docs/项目全档.md) | 全局视角与复现手册 |
| [`docs/prd.md`](docs/prd.md) | 需求与算法的正式规格（14 章） |
| [`docs/requirements.md`](docs/requirements.md) | 最初的需求讨论记录 |
| [`docs/开发踩坑记录.md`](docs/开发踩坑记录.md) | 每个坑的现场、根因、改法 |
| [`CLAUDE.md`](CLAUDE.md) | 本项目的环境限制、常用命令、规则落实 |
| [`.claude/skills/dev-standards/`](.claude/skills/dev-standards/) | 与项目无关的通用开发标准（29 条） |
| [`data/PARSING_GUIDE.md`](data/PARSING_GUIDE.md) | 真题解析成 JSON 的规范 |
| `docs/自考英语真题练习-学员使用手册.docx` | 面向学员的使用说明 |

## 目录结构

```
worker/        Cloudflare Worker：Hono 后端 + D1 迁移 + 种子 + 测试
  src/lib/       核心算法（组卷、练习、判分、掌握度、错题本、AI）
  src/routes/    50 个接口
  migrations/    7 个迁移，20 张表
  test/          5 套冒烟/验收 + 2 个单测 + 1 套浏览器实测
web/           React 前端（构建产物输出到 worker/public，同域名托管）
data/          题库源数据：20 个试卷 JSON + 考点表 + 解析规范
scripts/       种子生成、手册生成、CI 辅助脚本
.github/       部署、线上端到端实测、AI 协议探测三条流水线
server/        历史遗留：M1 阶段的 Node + Express 版本，仅供参考
```

## 快速开始

本地开发：

```bash
npm install --prefix worker && npm install --prefix web
cd web && npx vite build          # 前端产物进 worker/public
cd ../worker && npx wrangler dev --local --port 8787
```

跑全套回归：见 [`CLAUDE.md`](CLAUDE.md) 第二节。

部署与从零复现（含所需 Secrets、要改掉的写死标识）：见
[`docs/项目全档.md`](docs/项目全档.md) 第 8、10 节。

## 当前状态

M1–M6 全部完成并上线，线上端到端实测（含真实 AI 链路）15 条断言全过。

**唯一实质性缺口**：79 条解析存疑记录尚未人工核对，对应 125 道题被扣着不参与组卷
（895 道可抽）。这是产品决策而非技术问题——当前是"隔离而非修好"，要放行需要有人
对着原卷逐条核对。
