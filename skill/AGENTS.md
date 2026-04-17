# AGENTS.md — Pipeline Orchestrator

本文件为 AI Agent 的全局指令入口，遵循 Claude Code / Codex 社区惯例。

## 仓库定位

全链路 AI 开发闭环引擎。以编排层为核心，驱动 9 个专职 SubAgent 完成从需求分析到代码交付的完整开发闭环。

## AI Agent 操作约束

1. **编排入口**：`SKILL.md`（LLM 执行指令）。直接阅读 SKILL.md 获取完整编排流程。
2. **禁止指定 model 参数**：所有 spawn SubAgent 继承主 Agent 模型。
3. **每次 Phase 切换时重读** `SKILL.md` 强制约束章节。
4. **不凭记忆假设**：文件存在性、CLI 可用性、项目结构必须用命令检测。
5. **不跳过落盘**：state.json / session.md / context.md / pending.md，即使 task 看似无变更。

## 目录导航

| 目录/文件 | 说明 |
|-----------|------|
| `SKILL.md` | 编排主入口（Phase 路由 + 规模矩阵 + 命令速查） |
| `phases/*.md` | 各 Phase 详细执行步骤 |
| `.cursor/agents/*.md` | 9 个 SubAgent 角色定义（planner/executor/evaluator/session-analyst 等） |
| `references/` | 协议、清单、模板、格式定义（protocols/quality-checklist 等） |
| `templates/` | 项目配置模板 |
| `scripts/` | 引擎脚本（orchestrate.sh / engine.py / topology.py） |
| `packages/generator/` | 声明式 Skill 生成器 |
| `.cursor/skills/setup/` | 一键安装 Skill（探测环境 + 配置） |
| `.cursor/commands/` | Cursor 命令（OpenSpec 快捷入口） |

## 关键参考

- 架构原则 → `SKILL.md`「架构定位」
- 角色职责边界 → `references/governance-constitution.md`
- SubAgent 协议 → `references/protocols.md`
- 上下文注入策略 → `references/context-engineering.md`
- 编排假设清单 → `references/assumptions.md`
