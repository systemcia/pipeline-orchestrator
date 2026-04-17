# 数据库 Schema 与数据源说明

Pipeline Orchestrator 管理台涉及三层数据源：外部 SQLite（Cursor IDE 生态维护）、Session 文件系统、管理台内部 API。本文档列出所有表结构和字段，以及如何让各功能模块正常工作。

---

## 数据源总览

| 数据源 | 路径 | 写入方 | 管理台访问方式 | 依赖功能 |
|--------|------|--------|---------------|----------|
| pipeline.db | `$PIPELINE_DATA_DB`（默认 `$PIPELINE_SESSIONS_DIR/pipeline.db`） | scripts/sync/sync_chats.py（systemd timer） | 只读 | 效能分析、知识库、RAG 搜索、Token 统计、会话搜索 |
| ai-tracking.db | `~/.cursor/ai-tracking/ai-code-tracking.db` | Cursor IDE | 只读 | AI 代码追踪统计 |
| Session 文件系统 | `$PIPELINE_SESSIONS_DIR/` | engine.py ($O) | 读写 | Session 管理、编排趋势、反馈提案 |

---

## 1. pipeline.db

**路径**：`$PIPELINE_DATA_DB`（默认 `$PIPELINE_SESSIONS_DIR/pipeline.db`）
**写入方**：`scripts/sync/sync_chats.py`（systemd timer 定时同步，也可手动执行）

### 如何安装

运行 `bash scripts/sync/install-timer.sh` 安装定时任务，或手动运行 `python3 scripts/sync/sync_chats.py`。未同步则相关功能可能无数据或依赖接口报错。

### 表：daily_summaries

效能分析概览（`/api/analytics/overview`）的数据源。

| 字段 | 类型 | 说明 |
|------|------|------|
| date | TEXT | 日期，YYYY-MM-DD |
| summary | TEXT | 当日工作摘要 |
| work_categories | TEXT | JSON 对象，如 `{"coding": 5, "review": 2}` |
| total_sessions | INTEGER | 当日会话总数 |
| projects | TEXT | JSON 数组，每项含 `project_name`、`session_count`、`work_items` |

### 表：rag_knowledge_chunks

知识库核心数据（`/api/knowledge/*`、RAG 搜索）的数据源。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | Chunk ID |
| session_id | TEXT | 所属会话 ID |
| chunk_index | INTEGER | 分片序号 |
| project_name | TEXT | 项目名 |
| user_query | TEXT | 用户提问 |
| ai_response_core | TEXT | AI 回答核心内容 |
| main_topic | TEXT | 主题分类 |
| tags | TEXT | 标签 |
| tools_used | TEXT | 使用的工具 |
| code_languages | TEXT | 涉及的编程语言 |
| has_code | BOOLEAN | 是否含代码 |
| enrichment_status | TEXT | 提炼状态 |
| timestamp | INTEGER | 时间戳（毫秒） |

### 表：prompt_gems

高质量提示词精华（`/api/knowledge/gems`）的数据源。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | Gem ID |
| session_id | TEXT | 所属会话 ID |
| project_name | TEXT | 项目名 |
| source | TEXT | 来源 |
| user_prompt | TEXT | 用户提示词 |
| ai_response_summary | TEXT | AI 回答摘要 |
| quality_score | REAL | 质量评分 |
| quality_tags | TEXT | 质量标签 |
| category | TEXT | 分类 |
| timestamp | INTEGER | 时间戳（毫秒） |

### 表：workspace_sessions

Token 消耗统计（`/api/knowledge/token-stats`）和会话搜索的数据源。

| 字段 | 类型 | 说明 |
|------|------|------|
| composer_id | TEXT | 会话 ID（主键） |
| name | TEXT | 会话名称 |
| created_at | INTEGER | 创建时间（ms） |
| last_updated_at | INTEGER | 最后更新时间 |
| unified_mode | TEXT | agent/ask/edit |
| subtitle | TEXT | 副标题 |
| total_lines_added | INTEGER | 代码行增加 |
| total_lines_removed | INTEGER | 代码行删除 |
| files_changed_count | INTEGER | 文件变更数 |
| context_usage_percent | REAL | 上下文使用率 |
| is_archived | INTEGER | 是否归档 |
| created_on_branch | TEXT | 创建时的分支 |
| token_count | INTEGER | Token 消耗估算 |
| workspace_id | TEXT | 工作区标识 |
| cached_at | INTEGER | 缓存时间戳 |
| panel_id | TEXT | 面板 ID |

### 表：session_file_index

会话文件索引，供后端 loadSessionContext 快速定位 JSONL 文件。

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | TEXT | 会话 ID（主键） |
| file_path | TEXT | 文件绝对路径 |
| source_type | TEXT | jsonl 或 storedb |
| updated_at | INTEGER | 更新时间（ms） |

---

## 2. ai-tracking.db

**路径**：`~/.cursor/ai-tracking/ai-code-tracking.db`
**写入方**：Cursor IDE 内置功能（自动记录 AI 代码生成行为）

### 如何获得

此数据库由 Cursor IDE 自动创建和维护，无需额外安装。只要日常使用 Cursor 写代码，数据会自动积累。

### 表：ai_code_hashes

AI 代码追踪统计（`/api/analytics/ai-tracking`）的数据源。

| 字段 | 类型 | 说明 |
|------|------|------|
| createdAt | INTEGER | 创建时间戳（毫秒 Unix epoch） |
| model | TEXT | AI 模型名称（如 claude-3.5-sonnet） |
| source | TEXT | 来源（agent / chat / inline） |

---

## 3. Session 文件系统

**路径**：`$PIPELINE_SESSIONS_DIR/<project_id>/pipe-<timestamp>/`
**读写方**：engine.py（$O CLI）+ 管理台后端

### 目录结构

```
pipe-20260415-143000/
├── state.json           # 核心状态（Session + Task 列表）
├── state.lock           # 文件锁（fcntl 排他）
├── session.md           # 完整上下文（用户需求/约束/阶段详情）
├── context.md           # 精简上下文（自动生成，≤3000 字符）
├── pending.md           # 待确认事项表
├── telemetry.jsonl      # 遥测数据（JSONL）
├── audit.jsonl          # 审计日志（JSONL）
├── archive-session.md   # session.md 归档溢出内容
├── lessons.md           # 经验教训（Phase 5 产出）
├── improvements.md      # 改进建议（Phase 5 产出）
├── logs/
│   ├── 001-t1.md        # Task t1 执行日志
│   ├── 002-t2.md        # Task t2 执行日志
│   └── 003-ccc-task-t1.md  # CCC 校验日志
└── snapshots/
    └── after-t1.ref     # Git tag 引用
```

### state.json 核心字段

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | Session ID（目录名） |
| project_id | string | 项目归属 |
| name | string | Session 名称 |
| status | string | APPLYING / COMPLETED / FAILED / PAUSED |
| scale | string | small / medium / large |
| current_phase | number | 当前 Phase ID (0-5) |
| phases[] | array | Phase 状态列表 |
| tasks[] | array | Task 列表（见下表） |
| gate_results[] | array | 质量门决策记录 |
| rag_queries[] | array | RAG 查询记录 |
| consistency_checks[] | array | CCC 校验记录 |
| test_results[] | array | 测试门记录 |
| config | object | 项目配置快照 |

### tasks[] 元素

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | Task ID（如 t1） |
| name | string | Task 名称 |
| status | string | PENDING / RUNNING / COMPLETED / FAILED / SKIPPED |
| depends_on | string[] | 前置依赖 Task ID 列表 |
| agent_type | string | SubAgent 类型 |
| skill | string? | 关联 Skill |
| corrections | number | 修复次数 |
| log_file | string? | 日志文件相对路径 |
| snapshot_ref | string? | Git tag 名 |
| owns_globs | string[]? | 并行任务文件所有权声明 |

---

## 功能与数据源对应关系

| 管理台功能 | API 路径 | 数据源 | 无数据时行为 |
|-----------|----------|--------|-------------|
| 效能概览 | `/api/analytics/overview` | pipeline.db → daily_summaries | 返回全零数据 |
| AI 代码追踪 | `/api/analytics/ai-tracking` | ai-tracking.db → ai_code_hashes | 报错 500 |
| 编排趋势 | `/api/analytics/pipeline-trend` | Session 文件系统 | 返回全零数据 |
| 反馈提案 | `/api/analytics/feedback-proposals` | Session → improvements.md | 返回空数组 |
| Token 统计 | `/api/knowledge/token-stats` | pipeline.db → workspace_sessions | 报错 500 |
| 知识库统计 | `/api/knowledge/stats` | pipeline.db → rag_knowledge_chunks + prompt_gems | 报错 500 |
| 知识库搜索 | `/api/knowledge/search` | pipeline.db + Session → improvements.md | 仅返回磁盘结果 |
| RAG 搜索 | `/api/knowledge/rag` | pipeline.db → rag_knowledge_chunks + prompt_gems | 报错 500 |
| Session 管理 | `/api/sessions/*` | Session 文件系统 | 正常（空列表） |
| 会话搜索 | `/api/search/*` | pipeline.db → workspace_sessions + rag_knowledge_chunks | 报错 500 |

---

## 注意事项

- ai-tracking.db **不是本项目创建的**，由 Cursor IDE 内置功能自动维护。
- pipeline.db 由 `scripts/sync/sync_chats.py` 定时同步创建和维护，默认每日凌晨 3 点运行。
- Session 文件使用 `fcntl` 文件锁保证并发安全，**仅支持 Linux/macOS/WSL2**。
- `node:sqlite` API 要求 **Node.js 22+**。
- 若未同步或缺少 pipeline.db，管理台的效能分析、知识库、RAG、Token 统计、会话搜索等功能可能无数据或报错，但**不影响核心编排流程**（engine.py / $O CLI 独立运行）。
