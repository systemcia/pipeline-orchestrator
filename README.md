# Pipeline Orchestrator

全链路 AI 开发闭环引擎。以编排层为核心，驱动 9 个专职 SubAgent 完成从需求分析到代码交付的完整开发闭环。

**核心能力**：6 Phase 流水线 · 三级质量门 · CCC 一致性校验 · O8 上下文预算 · 规模自适应 Profile · TDD 纪律集成 · 断点续传 · RAG 防幻觉

## 项目结构

本仓库分为两个完全独立的子目录，可分别安装使用：

| 目录 | 说明 | 依赖 | 安装 |
|------|------|------|------|
| [`skill/`](skill/) | AI 编排 Skill（核心） | Python 3.10+ | `cd skill && bash install.sh` |
| [`server/`](server/) | 管理台（Web UI + API） | Node.js 22+ / Python 3.10+ | `cd server && bash install.sh` |

- **只用 AI 编排**：装 `skill/` 即可，零 Node.js 依赖
- **要管理台增强**（RAG 搜索、趋势统计、Session 管理）：再装 `server/`
- **全部都要**：两个都装

## 快速开始

### 方式一：只装 Skill（推荐）

```bash
git clone <repo-url> pipeline-orchestrator
cd pipeline-orchestrator/skill
bash install.sh
```

安装完成后在 Cursor IDE 任意项目输入 `/pipeline` 或「帮我编排」触发。

### 方式二：Skill + 管理台

```bash
git clone <repo-url> pipeline-orchestrator

# 装 Skill
cd pipeline-orchestrator/skill && bash install.sh

# 装管理台
cd ../server && bash install.sh

# 启动管理台
npm run dev
```

### 方式三：Docker（仅管理台）

```bash
cd pipeline-orchestrator/server
docker compose up -d
# http://localhost:18000
```

## 架构

```
Skill（编排层 — 只调度不执行）
  ├── SKILL.md               → 编排主入口
  ├── phases/                 → Phase 0-5 执行步骤
  ├── .cursor/agents/         → 9 个 SubAgent 角色
  ├── references/             → 协议、清单、策略
  ├── scripts/engine.py       → 状态追踪、DAG 调度
  └── packages/generator/     → 声明式 Skill 生成器

Server（管理台 — 可选增强）
  ├── packages/server/        → Fastify API（RAG / 趋势 / 事件）
  ├── web/                    → React 前端
  ├── scripts/sync/           → 数据同步引擎
  └── Dockerfile              → 容器化部署
```

## 其他目录

| 路径 | 说明 |
|------|------|
| `.cursor/` | 本仓库开发用的 Cursor 配置 |
| `openspec/` | OpenSpec 变更历史 |

## License

[MIT](LICENSE)
