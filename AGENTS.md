# AGENTS.md — Pipeline Orchestrator

本文件为 AI Agent 的全局指令入口，遵循 Claude Code / Codex 社区惯例。

## 仓库定位

全链路 AI 开发闭环引擎。分为两个独立子目录：

| 目录 | 说明 |
|------|------|
| `skill/` | AI 编排 Skill（核心引擎、SubAgent、Phase、协议） |
| `server/` | 管理台（Web UI、API、数据同步） |

## AI Agent 操作约束

1. **编排入口**：`skill/SKILL.md`（LLM 执行指令）。直接阅读获取完整编排流程。
2. **禁止指定 model 参数**：所有 spawn SubAgent 继承主 Agent 模型。
3. **每次 Phase 切换时重读** `skill/SKILL.md` 强制约束章节。
4. **不凭记忆假设**：文件存在性、CLI 可用性、项目结构必须用命令检测。
5. **不跳过落盘**：state.json / session.md / context.md / pending.md，即使 task 看似无变更。

## 目录导航

| 目录/文件 | 说明 |
|-----------|------|
| `skill/SKILL.md` | 编排主入口（Phase 路由 + 规模矩阵 + 命令速查） |
| `skill/phases/*.md` | 各 Phase 详细执行步骤 |
| `skill/.cursor/agents/*.md` | 9 个 SubAgent 角色定义 |
| `skill/references/` | 协议、清单、模板、格式定义 |
| `skill/templates/` | 项目配置模板 |
| `skill/scripts/` | 引擎脚本（orchestrate.sh / engine.py / topology.py） |
| `skill/packages/generator/` | 声明式 Skill 生成器 |
| `skill/.cursor/skills/setup/` | 一键安装 Skill |
| `server/packages/server/` | 管理台后端（Fastify + Node.js） |
| `server/packages/shared/` | 共享类型定义 |
| `server/web/` | 管理台前端（React） |
| `openspec/` | OpenSpec 变更管理 |

## 关键参考

- 架构原则 → `skill/SKILL.md`「架构定位」
- 角色职责边界 → `skill/references/governance-constitution.md`
- SubAgent 协议 → `skill/references/protocols.md`
- 上下文注入策略 → `skill/references/context-engineering.md`
- 编排假设清单 → `skill/references/assumptions.md`
