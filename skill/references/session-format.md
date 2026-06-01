# Session 格式定义

## 目录结构

```
/opt/pipeline-orchestrator/sessions/<session-id>/
├── state.json              # 结构化状态
├── session.md              # 完整语义记录（人类审计 + 断点恢复真相源）
├── context.md              # SubAgent 注入用精简上下文（≤ 3000 字符，引擎自动维护）
├── analysis-trace.md       # 需求分析追踪（Phase 0~1 的完整推理链路，人类审计用）
├── archive-session.md      # session.md 膨胀保护归档（自动生成）
├── design-brief.md         # 设计简报（增强编排模式 Phase 1d 生成，Phase 2 落盘）
├── pending.md              # 待用户确认事项
├── review-feedback-{tid}.md # 质量门 B FAIL 条目落盘（Phase 3-f，每 task 独立）
├── review-feedback-phase4.md # 质量门 C FAIL 条目落盘（Phase 4b，全局级）
├── telemetry.jsonl         # 任务级遥测（engine start/done/fail 追加，含可选成本字段）
├── lessons.md              # 经验总结（Phase 5 / SessionReviewService 生成）
├── improvements.md         # 改进建议（Phase 5 / SessionReviewService 生成）
├── session-analysis.md     # 会话分析合并报告（旧格式，向后兼容；新流程拆分为 lessons.md + improvements.md）
├── logs/                   # 执行日志（每步一个）
│   ├── 001-t1-后端API.md
│   ├── 002-t2-前端页面.md
│   └── ...
└── snapshots/              # git 快照引用
    ├── after-t1.ref
    └── ...
```

### session.md 与 context.md 的分工

| 文件 | 受众 | 更新方 | 字符上限 | 内容 |
|------|------|--------|----------|------|
| `session.md` | 人类 + 断点恢复 | `$O update-session` | 无（300 行压缩） | 完整需求、全部约束、所有 task 详情 |
| `context.md` | SubAgent 注入 | `$O update-session`（每次调用时自动重建） | ≤ 3000 字符 | 需求摘要 + 通用约束 + 最近 3 个 task 产出摘要 + 活跃约束 |

`context.md` 由引擎在每次 `update-session` 时自动从 `session.md` 精简生成，编排层**不手动维护**。

## state.json Schema

```json
{
  "id": "pipe-YYYYMMDD-HHMMSS",
  "name": "会话名称",
  "status": "APPLYING | COMPLETED | FAILED",
  "scale": "small | medium | large",
  "mode": "normal",
  "profile": "default | small | hotfix | thorough | null",
  "project_id": "项目标识（自动检测或手动指定，用于多项目隔离）",
  "openspec_change": "change-name 或 null",
  "openspec_repo_root": "含 openspec/changes 的仓库根路径或 null（与 PIPELINE_OPENSPEC_REPO_ROOT 对应）",
  "parallel_strategy": "ownership | integrator 或 null（并行合并策略摘要）",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "config": {
    "max_parallel": 3,
    "timeout_minutes": 10  // RUNNING task 过期判定阈值（恢复 session 时使用）
  },
  "tasks": [
    {
      "id": "t1",
      "name": "任务名称",
      "description": "任务描述",
      "status": "PENDING",
      "tier": "tier-1",
      "skill": "skill-name 或 null",
      "agent_type": "generalPurpose",
      "depends_on": [],
      "started_at": "ISO 8601 或 null",
      "completed_at": "ISO 8601 或 null",
      "error": "失败原因 或空",
      "snapshot_ref": "git tag 名 或空",
      "log_file": "logs/001-t1-后端API.md 或空",
      "corrections": 0,
      "openspec_task_id": "与 OpenSpec tasks.md 行首 N.M 对应，或 null",
      "owns_globs": ["src/foo/**", "可选：本 task 独占的路径 glob，用于并行判定"]
    }
  ],
  "rag_queries": [
    {"query": "搜索词", "results_count": 3, "timestamp": "ISO 8601"}
  ],
  "consistency_checks": [
    {"type": "proposal|task", "tid": "", "result": {}, "timestamp": "ISO 8601"}
  ],
  "test_results": [
    {
      "type": "compile|unit|regression|integration|e2e",
      "result": {
        "passed": true,
        "shell_exit_code": 0,
        "command": "可选：短命令摘要",
        "log_path": "可选：相对 session 目录的测试/构建日志路径",
        "output": "可选：摘录"
      },
      "timestamp": "ISO 8601"
    }
  ],
  "session_md_lines": 0
}
```

**`test_results[].result`（与 `references/protocols.md`「确定性证据」对齐）**

- **`passed` / `ok`**：是否与该次门控意图一致（由 `engine.py test-gate` 写入）。  
- **`shell_exit_code`**：对应编译/测试 Shell 的退出码；`passed: true` 时在严格模式下 **必填且为 0**（见 `PIPELINE_STRICT_TEST_EVIDENCE`）。  
- **`command`**、**`log_path`**：可选，用于复盘与抽检；路径相对于 `$DIR`。

### session status 枚举

| 值 | 含义 |
|----|------|
| APPLYING | 任务编排执行中 |
| COMPLETED | 流程完成 |
| FAILED | 失败终止 |

### task.status 枚举

| 值 | 含义 |
|----|------|
| PENDING | 未开始 |
| RUNNING | 执行中 |
| COMPLETED | 完成 |
| FAILED | 失败 |
| SKIPPED | 跳过（依赖任务失败时级联） |

## session.md 模板

```markdown
# Pipeline Session: <name>

## 用户原始需求
<用户输入的原文，永远不丢、不截断>

## 关键约束和决策
1. <从 proposal/design 提取的核心约束>
2. <讨论中确定的关键决策>

## 历史经验
（RAG 搜索结果自动追加）

## 当前阶段详情
### t1: <name> (COMPLETED)
- 变更文件: ...
- 产出摘要: ...
- 新增接口: ...

### t2: <name> (RUNNING)
- ...

## 待确认事项
→ 详见 pending.md
```

## analysis-trace.md 模板

**定位**：记录 Phase 0~1 期间的完整需求分析推理链路。与 `session.md`（记结论）互补——`analysis-trace.md` 记**过程**。Phase 2 `$O init` 后一次性落盘，后续不再修改。

**受众**：人类复盘 + Phase 5 session-analyst 回溯 + harness 自优化闭环。

**写入方**：主 Agent 在 Phase 0~1 各步骤中将分析内容追加到 `ANALYSIS_TRACE` 变量（与 `DESIGN_BRIEF` 同理，Phase 1 期间 `$DIR` 不存在），Phase 2 `$O init` 后落盘。

```markdown
# 需求分析追踪

> 生成时间: <ISO 8601>
> 编排模式: enhanced / openspec
> 规模判定: small / medium / large
> Profile: <profile name>

## 1. 规模判定依据
- **判定结果**: {scale}
- **判定理由**: {为什么是这个规模，命中了哪个锚点}

## 2. 需求理解与确认
- **原始输入**: <用户需求原文>
- **结构化理解**:
  1. {功能点 1}
  2. {功能点 2}
- **假设**: {技术/业务假设，无则"无"}
- **模糊点与澄清**:
  - Q: {问题} → A: {用户回答}
- **确认结论**: {用户确认/补充了什么}

## 3. 历史经验检索
- **搜索词**: {RAG 查询关键词}
- **命中结果**:
  - [{topic}] {answer_core 摘要} — 采纳/忽略，原因: {reason}
- **未命中时**: 无相关历史经验

## 4. 代码探索发现
- **触发原因**: {为什么需要探索，或"未触发"}
- **发现**:
  - 技术栈: {tech_stack}
  - 相关模块: {dirs}
  - 现有接口: {apis}
  - 关键发现: {影响拆解决策的发现}

## 5. 需求拆解推理
- **拆解策略**: {为什么选择这种拆法}
- **备选方案**: {考虑过但放弃的拆法，含放弃原因}
- **最终 task 列表**:
  - t1: {name} — {一句话理由}
  - t2: {name}（依赖 t1）— {为什么依赖 t1}
- **依赖关系设计理由**: {整体依赖图的设计考量}

## 6. 质量门审查记录
- **检查类型**: 轻量质量检查 / 质量门 A / 无
- **结果**: PASS / FAIL
- **FAIL 条目与修正**:
  - {PA-id}: {问题} → 修正为: {修正内容}

## 7. 用户审批
- **展示内容摘要**: {给用户展示了什么}
- **用户反馈**: {确认/修改/补充}
- **最终决策**: 确认执行 / 要求修改 / 取消
```

**小规模精简版**（跳过 Phase 1 时）：仅保留 §1 规模判定 + §2 需求理解（从 Phase 2-小的"我的理解"中提取）+ §5 拆解推理（单 task 的理由）。其余 section 写"跳过（小规模）"。

## pending.md 模板

**决策点**列建议带 **`hard:`** / **`soft:`** 前缀，与 `references/protocols.md`「Gate Taxonomy」一致（见 `governance-constitution.md`）。

```markdown
# 待确认事项

| # | 阶段 | 时间 | 决策点 | 自动选择 | 风险 |
|---|------|------|--------|----------|------|
```

## 落盘时机

| 事件 | state.json | session.md | analysis-trace.md | 日志文件 | pending.md |
|------|-----------|-----------|-------------------|---------|-----------|
| Phase 0 规模判定 | — | — | §1 追加 | — | — |
| Phase 1a-2 需求确认 | — | — | §2 追加 | — | — |
| Phase 1b RAG 搜索 | — | — | §3 追加 | — | — |
| Phase 1c 探索完成 | — | — | §4 追加 | — | — |
| Phase 1d 拆解完成 | — | — | §5 追加 | — | — |
| Phase 1d-2/1f 质量门 | — | — | §6 追加 | — | — |
| Phase 1g 用户审批 | — | — | §7 追加 | — | — |
| Phase 2 init 后 | — | — | 变量落盘为文件 | — | — |
| task 开始 | status=RUNNING, started_at, agent_type, skill | — | — | — | — |
| task 完成 | status=COMPLETED, completed_at, log_file | 当前阶段详情追加 | — | `{seq}-{tid}-{name}.md` | — |
| task 失败 | status=FAILED, completed_at, error, log_file | 当前阶段详情追加 | — | `{seq}-{tid}-{name}.md` | — |
| 自动决策 | — | — | — | — | 追加记录 |
| 用户决策 | — | 关键约束追加 | — | — | — |
| session.md 更新 | session_md_lines | — | — | — | — |
| task start/done/fail | — | — | — | — | —（telemetry.jsonl 追加） |

## telemetry.jsonl 事件格式

每行一个 JSON 对象，由 `engine.py` 在 `start`/`done`/`fail` 时追加。

### 核心字段（必有）

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | string | `start` / `done` / `fail` |
| `tid` | string | task ID |
| `timestamp` | string | ISO 8601 |
| `error_class` | string | 仅 `fail` 时：错误分类（`compile_error` / `test_failed` / `mcp_tool_failed` / `tool_invoke_failed` / `timeout` / `unknown`） |

### 扩展字段（可选 — 有则记录，无则省略）

| 字段 | 类型 | 说明 |
|------|------|------|
| `duration_ms` | number | task 执行耗时（`done`/`fail` 时，`timestamp - start_timestamp`） |
| `tokens_in` | number | SubAgent 输入 token 数（IDE Task 工具返回时可取） |
| `tokens_out` | number | SubAgent 输出 token 数 |
| `corrections` | number | 该 task 的修复轮次数（error-fixer spawn 次数） |
| `files_changed` | number | 变更文件数 |
| `agent_type` | string | SubAgent 类型 |
| `skill` | string | 使用的 Skill 名称 |

扩展字段**不强制要求**，`engine.py` 仅在调用方传入时记录。Phase 5 分析时汇总成本指标。
