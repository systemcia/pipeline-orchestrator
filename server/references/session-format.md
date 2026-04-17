# Session 格式定义

## 目录结构

```
/opt/pipeline-orchestrator/sessions/<session-id>/
├── state.json              # 结构化状态
├── session.md              # 完整语义记录（人类审计 + 断点恢复真相源）
├── context.md              # SubAgent 注入用精简上下文（≤ 3000 字符，引擎自动维护）
├── archive-session.md      # session.md 膨胀保护归档（自动生成）
├── pending.md              # 待用户确认事项
├── telemetry.jsonl         # 任务级遥测（engine start/done/fail 追加，含可选成本字段）
├── lessons.md              # 经验教训（Phase 5 生成）
├── improvements.md         # 改进建议（Phase 5 生成）
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
| `context.md` | SubAgent 注入 | `$O update-context`（每次 task done/fail 后自动重建） | ≤ 3000 字符 | 需求摘要 + 通用约束 + 最近 3 个 task 产出摘要 + 活跃约束 |

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

## pending.md 模板

**决策点**列建议带 **`hard:`** / **`soft:`** 前缀，与 `references/protocols.md`「Gate Taxonomy」一致（见 `governance-constitution.md`）。

```markdown
# 待确认事项

| # | 阶段 | 时间 | 决策点 | 自动选择 | 风险 |
|---|------|------|--------|----------|------|
```

## 落盘时机

| 事件 | state.json | session.md | 日志文件 | pending.md |
|------|-----------|-----------|---------|-----------|
| task 开始 | status=RUNNING, started_at, agent_type, skill | — | — | — |
| task 完成 | status=COMPLETED, completed_at, log_file | 当前阶段详情追加 | `{seq}-{tid}-{name}.md` | — |
| task 失败 | status=FAILED, completed_at, error, log_file | 当前阶段详情追加 | `{seq}-{tid}-{name}.md` | — |
| 自动决策 | — | — | — | 追加记录 |
| 用户决策 | — | 关键约束追加 | — | — |
| session.md 更新 | session_md_lines | — | — | — |
| task start/done/fail | — | — | — | —（telemetry.jsonl 追加） |

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
