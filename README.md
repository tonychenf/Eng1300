# XLearn — 跨学科自适应学习平台

由 [Eng1300](https://github.com/tonychenf/Eng1300)（自考英语真题练习系统）复制改造而来：
在原有的模考、自适应练习、错题本、能力评估之上**加一层学科架构**，让不同学科各有
独立的题库、例题解析与评价标准，共用同一套系统能力。

部署在 Cloudflare Workers + D1，**完全免费、公网可访问、手机/平板/PC 三端适配**。

**线上地址**：https://xlearn.eng1300-79fe2787.workers.dev

| | |
|---|---|
| 学科 | 英语（已上线）· 生物化学与分子生物学（题库建设中） |
| 进度 | N0 独立部署基线 ✅ · N1 学科骨架 ✅ · N2 学科权限起未开工 |
| 英语题库 | 20 套真题 · 1020 道题 · 21 个考点标签 |
| 英语试卷 | 七个部分 · 51 题 · 100 分 · 150 分钟 |
| 生化题库 | 第 1 章 34 题 / 50 空 / 32 采分点（答案待人工核对） |
| 技术栈 | Cloudflare Workers + D1 + Hono / React + Vite |
| 测试 | 本地回归 267 条 + 浏览器 19 条 + 线上验证 22 条 |

## 文档

**要做改造，从 [`docs/跨学科学习平台-需求文档.md`](docs/跨学科学习平台-需求文档.md) 开始；
要理解蓝本，从 [`docs/项目全档.md`](docs/项目全档.md) 开始** —— 背景与取舍、
技术方案、数据管线、数据库设计、核心算法、测试策略、部署流程、踩过的坑，以及从零
复现的可执行步骤。

其余文档各有分工，别在一份里找另一份的内容：

| 文件 | 内容 |
|---|---|
| [`docs/跨学科学习平台-需求文档.md`](docs/跨学科学习平台-需求文档.md) | **改造方向** v2：复制改造成跨学科平台（英语 + 生物化学与分子生物学）的需求与架构决策 |
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
