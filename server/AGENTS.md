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
| `SKILL.md` | 编排主入口（与 skill/SKILL.md 同步） |
| `packages/server/` | Fastify 后端 API |
| `packages/shared/` | 共享类型定义 |
| `packages/generator/` | 声明式 Skill 生成器 |
| `web/` | React + Ant Design 前端 |
| `scripts/` | 引擎脚本 + 数据同步（sync/） |
| `phases/` | Phase 执行步骤（server 侧副本） |
| `references/` | 协议、清单（server 侧副本） |
| `docs/` | 数据库 Schema、快速上手等文档 |

## 关键参考

- API 路由 → `packages/server/src/routes/`
- 数据库 Schema → `docs/database-schema.md`
- Skill 侧 SubAgent 定义 → `../skill/.cursor/agents/*.md`
- 编排协议 → `references/protocols.md`
