# 编排协议

分层职责、冲突优先级、optimization-master 与 evaluator 边界、automation_tier 与 gate_mode 关系、pending 的 `hard:`/`soft:` 前缀、**`$O` 路径与 `PIPELINE_ORCHESTRATOR_HOME`**、全局 Skill 同步要求 → 见 **`references/governance-constitution.md`**。本文聚焦 SubAgent 协议、防失忆与交接字段。

## Gate Taxonomy（门控分类）

编排将失败与门控结果分为两类，**重试与 interactive 语义不同**：

| 类型 | 含义 | 典型来源 | 默认编排语义 |
|------|------|----------|--------------|
| **HARD_FAIL** | 确定性失败（可机器判定） | 编译/单测/`go vet`/golangci-lint/eslint/ruff/tsc/py_compile 非 0；`engine.py validate` 失败（含 **OpenSpec `tasks.md` 与 session `openspec_task_id` 集合不一致** 时的漂移错误）；SubAgent 报告 `## 执行结果: FAILED` 且伴随构建错误；**Git merge 冲突**（并行集成失败）；**产出校验**（executor 声称 SUCCESS 但无文件变更） | 走 error-fixer + 内联重试（Phase 3 已定义次数）；仍失败 → `fail`；`gate_mode: interactive` 时在「编译/单测连续 FAIL」节点暂停 |
| **SOFT_FAIL** | 启发式/审查失败 | CCC `aligned: false`；quality-reviewer / evaluator 的 FAIL；质量门 delta 仍 FAIL；**MCP/外部工具连续失败达到熔断阈值后的降级决策**（若编排选择不阻塞主路径而记 pending） | 记 **pending.md**（决策点建议前缀 `soft:`）；`gate_mode: interactive` 时在质量门 B/C、CCC 严重偏离等节点暂停；auto 模式多标记后继续 |

**error-fixer**：仅对 **HARD_FAIL** 或可映射为具体代码修复的测试失败 spawn；**SOFT_FAIL** 以「记 pending + 用户/下一轮裁决」为主，避免无意义循环改代码。**例外（与 `phases/phase-3-execute.md` 3-f、`phases/phase-4-complete.md` 4b 对齐）**：质量门 B/C 在 **executor 修复 + Delta 重检** 后仍 FAIL 时，允许 **1 轮** error-fixer 兜底，随后**完整重执行**该门控；仍 FAIL 再记 pending。

**pending.md**：与自动决策相关的记录，**决策点**字段建议使用 `hard:` 或 `soft:` 前缀，与上表一致（详见 `governance-constitution.md` §5）。

### 确定性证据（Evidence）

与上表 **HARD_FAIL** 一致：编译/单测/E2E/`validate` 等**通过**的必要条件是**同编排步骤内**对应 Shell（或 `engine.py` CLI 以退出码表示成败的子命令）**已成功结束（exit 0）**。SubAgent 自然语言或 JSON 叙述 **不得**作为唯一通过依据。

**`$O test-gate`（`scripts/engine.py` `test-gate`）**：仅将结果**摘要落盘**到 `state.json` 的 `test_results` 与 `logs/*-test-*.md`。**禁止**在未执行对应命令或命令失败时写入 `passed: true`。推荐在 JSON 中携带 **`shell_exit_code`**（与 Shell 一致）、可选 **`command`**、**`log_path`**（相对 `$DIR`），便于抽检与 Phase 5 复盘（字段定义见 `references/session-format.md`）。

**严格证据模式**：设置环境变量 **`PIPELINE_STRICT_TEST_EVIDENCE=1`**（取值亦接受 `true`/`yes`/`on`）时，引擎 **拒绝** `passed: true` 且缺少 **`shell_exit_code`** 或非 **0** 的 `test-gate` 请求（打印修复提示并 exit 1）。未设置时保持对历史 JSON（仅 `passed`/`ok`）的兼容。Profile 级开关可由编排层将来在调用引擎前映射到该环境变量（当前引擎不读取 YAML Profile）。

## 工具与 MCP 熔断（默认映射）

- **连续失败**：同一 MCP 工具或同一外部 RPC 在**单 task** 内连续失败次数 ≥ `circuit_breaker_n`（见 `references/mcp-capabilities.md` Policy 列；未登记则默认 **3**）→ 视为 **熔断打开**。
- **打开后默认**：停止该 task 的**非只读** MCP 调用；仅允许读文件/只读工具或改用手动步骤；在 `pending.md` 记一条，前缀默认 **`soft:`**（决策点示例：`soft: MCP 工具 X 熔断，已降级为只读`）。若项目将「无 MCP 不可用」定义为阻塞（如强依赖某 API），可在 Profile 中约定改为 **`hard:`** 并 `fail` 该 task。
- **telemetry**：`fail` 时 `error` 文本含 `mcp` / 明显工具调用失败特征时，`engine.py` 会将 `error_class` 记为 `mcp_tool_failed` 或 `tool_invoke_failed`，便于 Phase 5 聚类（字段兼容既有 JSONL 读者）。

## RAG 接地（防检索替代读源）

- **MUST**：在将 RAG 检索结论作为**实现或验收依据**之前，主 Agent / SubAgent **须已直接读取**与本 change 相关的 OpenSpec 制品（`proposal`/`design`/`spec.md`/`tasks.md` 等）及将修改的仓库源文件。
- **MUST NOT**：仅凭无可追溯 `source` 的检索片段关闭 task 或作为唯一 PASS 证据；此类材料**仅作启发**，须在 session 或日志中标明**非绑定**。
- **与 Phase 3 的关系**：`inject-rag` 步骤**不**免除上述读源义务；执行类 prompt 仍须带 session 真相源指针（见「防失忆协议」）。
- **搜索范围**：`inject-rag` 默认搜索 `lessons` 和 `improvements` 两类内容（管理台 RAG 端点 `scope=lessons,improvements`）；SubAgent prompt 中注入的 RAG 结果应标注来源类别（`[lessons]` / `[improvements]`），便于区分经验总结与改进建议。

## SubAgent 角色路由表

| Phase | 角色文件 | 用途 |
|-------|---------|------|
| 1c / 1d 前置 | `codebase-researcher.md` | 需求拆解前的代码库研究 |
| 1d (增强编排模式) | `planner.md` | 需求分析与任务拆解 |
| 1f | `evaluator.md` | 质量门 A 提案自检（含 PA13/PA14 覆盖原 CCC-1） |
| 3-c | `executor.md` | 开发任务执行；编排层按 task tags/描述注入 Scope（Backend/Frontend） |
| 3-c（`task-type: test` / 测试生成） | `tester.md` | Phase 3 测试生成；与 `references/skill-routing-table.md` 的 `task-type: test` 路由一致 |
| 3-d | `error-fixer.md` | 编译/单测等 **HARD_FAIL** 路径 FAIL 后修复（见 Phase 3-d） |
| 3-e | `consistency-checker.md` | CCC-2 一致性校验 |
| 3-f | `quality-reviewer.md` | 质量门 B（task 级审查；支持 Delta 重检模式） |
| 4b | `quality-reviewer.md` | 质量门 C（全局级审查） |
| 5a | `session-analyst.md` | 会话经验总结与改进建议 |

**质量门 B / C 首轮 FAIL 后的角色顺序**（与 Phase **3-f** / **4b** 一致，**非**「先 error-fixer」）：编排层将 FAIL 条目落盘至 **`review-feedback-{tid}.md`**（门 B）或 **`review-feedback-phase4.md`**（门 C）→ **re-spawn `executor.md`**（读取 `## Review 反馈`）→ **Delta 重检**（内联或 `quality-reviewer` Delta 模式）→ Delta 仍 FAIL → **`error-fixer.md` 兜底** → **完整重执行**该门控 **最多 1 轮** → 仍 FAIL 记 `pending.md`（`soft:`）。

**spawn 时角色注入方式**：在 SubAgent prompt 首行写 `按 .cursor/agents/{role}.md 执行`，SubAgent 会自动读取该角色文件获取角色锚定、检查维度、输出契约和范围锁定。

## SubAgent 输出解析协议

审查/评估类 SubAgent（evaluator、quality-reviewer、consistency-checker）要求输出**严格 JSON**，但 LLM 实际输出常包含 markdown 代码块标记、前言或后语。编排层**接收 SubAgent 返回后 MUST 按以下流程提取 JSON**：

### 解析流程（三级降级）

1. **直接解析**：对返回文本尝试 `JSON.parse`（或 `json.loads`）→ 成功则使用
2. **代码块提取**：失败后，用正则提取第一个 `` ```json ... ``` `` 或 `` ``` ... ``` `` 代码块内容 → 解析成功则使用
3. **花括号/方括号提取**：仍失败，用贪心正则提取最外层 `{...}` 或 `[...]` → 解析成功则使用
4. **全部失败**：记 pending.md（`soft: SubAgent {role} 输出解析失败，降级为 PASS`），该门控结果**降级为 PASS**（不阻塞编排），将原始输出写入 `logs/{tid}-{role}-parse-fail.md` 供复盘

### 适用范围

| SubAgent 角色 | 预期输出格式 | 解析失败降级行为 |
|--------------|-------------|----------------|
| evaluator | `{items: [...], summary}` | 降级 PASS，记 pending |
| quality-reviewer | `{items: [...], summary}` | 降级 PASS，记 pending |
| quality-reviewer (Delta 重检模式) | `{items: [...], summary}` | 降级 PASS，记 pending |
| consistency-checker (CCC-2/merge) | `{aligned, issues}` | 降级 aligned=true，记 pending |

### 执行者 / 修复者输出

executor 和 error-fixer 的输出为 Markdown（`## 执行结果: SUCCESS|FAILED`），**不走本协议**。编排层通过文本匹配 `## 执行结果:` 行提取状态，匹配失败时视为 FAILED。

## 角色间交接协议

编排层负责在 spawn 时传递以下字段：

| 上游角色 | 下游角色 | 传递字段 | 格式 |
|---------|---------|---------|------|
| executor → | quality-reviewer | `files_changed`（变更文件列表） | 从 executor 输出的 `## 执行结果` 中提取 |
| executor → | consistency-checker | `files_changed` + `task.description` | 同上 + session.md |
| quality-reviewer（质量门 B/C 首轮 FAIL，已落盘）→ | executor | `review-feedback-{tid}.md` 或 `review-feedback-phase4.md`（含 `## Review 反馈` 与 FAIL 条目） | 编排层从首轮 JSON 提取后写入；见 Phase 3-f / 4b |
| quality-reviewer → | quality-reviewer (Delta 重检模式) | `items[result=FAIL]`（待重检 FAIL 条目的 `id` 列表） | executor SUCCESS 后的 Delta 路径；从内联或上轮 JSON 提取 |
| quality-reviewer（Delta 仍 FAIL）/ 编排层 → | error-fixer | 仍 `result=FAIL` 的条目；若无 Delta 产物则回退首轮落盘文件 | 仅质量门 B/C **Delta 仍 FAIL** 后的兜底；见 Phase 3-f / 4b |
| error-fixer → | quality-reviewer | 修复后的 `files_changed`（随后 **完整重执行** 门 B 或门 C，非仅 Delta） | 质量门 B/C 兜底轮；与 Phase「完整重执行」一致 |

**升级路径**（当角色无法完成任务时）：
- error-fixer 报 UNFIXED → 编排层记 pending.md，标记 task FAILED，不再循环
- 质量门 B/C：**Delta 仍 FAIL** → error-fixer 兜底 → **完整重执行**该门控 1 轮；仍 FAIL → 记 pending.md（Phase 3-f 继续后续步骤 / 4b 继续 4c）
- consistency-checker 报 `aligned: false` 且 issues ≥ 3 → interactive 模式暂停，auto 模式记 pending.md

## 防失忆协议

SubAgent 无法访问主 Agent 的上下文。**每次 spawn 前 MUST 执行**：

1. **按角色类型选择注入源**（详见 `references/context-engineering.md`「注入源分层」）：
   - 执行类 → 读取 `$DIR/context.md`（精简版，≤3000 字符）
   - 审查/规划/反馈类 → 读取 `$DIR/session.md`（完整版）
2. OpenSpec 模式还要读 contextFiles（proposal/design/specs/tasks）
3. **用户画像注入**（详见 `references/context-engineering.md`「用户画像注入规则」）
4. 按 prompt 模板的分块标签注入（`防失忆`/`防幻觉`/`范围锁定`）

### 完整规则

注入预算公式、裁剪优先级、用户画像注入规则、语言特化 Hints、Context Reset 协议 → 见 **`references/context-engineering.md`**。

## 并行合并协议

当 Phase 3 并行 spawn 多个 task 时，需在所有并行 task 完成后执行合并检查（包含文件冲突检测 + CCC-merge 语义冲突检测）。

> **唯一规范位置**：合并的完整执行流程定义在 `phases/phase-3-execute.md` Step 2.5 中。本节为协议层面的原则说明，不重复执行细节。

### 执行时序

并行 spawn（c）→ 全部返回 → **合并检查（Step 2.5）** → 逐个 d~i。

### 合并检查包含两层

1. **文件冲突检测**（主 Agent 内联 git 命令）：检查变更文件交集
2. **CCC-merge 语义冲突检测**（spawn consistency-checker）：检查并行产出的语义一致性

### 冲突处理策略

| 冲突类型 | 处理方式 | 门控类型 |
|---------|---------|---------|
| 同文件不同区域 | 尝试 `git merge` 自动合并 | 成功则继续 |
| 同文件同区域 | **HARD_FAIL**，记 pending（`hard:` 前缀） | 阻塞 |
| 接口签名不一致 | spawn error-fixer 修复接口对齐 | 修复后重检 |
| CCC-merge 语义冲突 | **SOFT_FAIL**，记 pending（`soft:` 前缀） | 不阻塞 |

### 冲突修复原则

- 按「后完成的 task 适配先完成的 task」原则
- 修复范围仅限冲突文件，不扩大到其他文件
- 修复后须重新执行编译检查（d-1）验证

### 并行原子性

由 `.pipeline-orchestrator.yaml` 的 `parallel_atomicity` 配置（默认 `best-effort`）：

| 策略 | 语义 | 适用场景 |
|------|------|----------|
| `best-effort` | 并行 task 独立处理，部分成功部分失败互不影响 | 独立模块（owns_globs 无交集）|
| `all-or-nothing` | 并行批次中任一 task FAILED → 全部回退，重新排队为 PENDING | 强耦合并行（如同一 API 的前后端） |

**all-or-nothing 回退流程**：
1. 检测到并行批次中有 FAILED task
2. 对该批次所有已完成 task 执行 `$O rollback`（大规模）或 `git checkout $PRE_SHA_{tid} -- .`（中规模并行）
3. 所有 task 状态重置为 PENDING
4. 降格为串行重新执行（禁用本批次并行）
5. 记 pending：`hard: 并行批次 {batch_ids} 原子性回退，降格串行`

### 与 owns_globs 的关系

- `owns_globs` 互不重叠时，理论上不会产生文件冲突（并行判定的目的）
- 即使 `owns_globs` 声明无重叠，合并后仍须检测实际变更文件是否有意外交集
- 发现 `owns_globs` 声明与实际变更不一致时，记 pending（`soft: owns_globs 声明与实际变更不一致`）

## 人类升级协议（Human Escalation Protocol）

当编排遇到 SubAgent 无法解决的问题时，按结构化格式升级到用户。

### 升级触发条件

| 条件 | 升级级别 | gate_mode: auto | gate_mode: interactive |
|------|----------|----------------|----------------------|
| 连续 2 task FAIL | 强制 | MUST 暂停 | MUST 暂停 |
| error-fixer 报 UNFIXED | 标准 | 记 pending | 暂停 |
| CCC `aligned: false` 且 issues ≥ 3 | 标准 | 记 pending | 暂停 |
| 质量门 C FAIL（全局审查） | 标准 | 记 pending | 暂停 |
| 需求歧义（planner 标注 `[待确认]`） | 强制 | MUST 暂停 | MUST 暂停 |

### 升级消息格式（MUST 遵循）

```
## 需要人工决策

**问题**：{一句话描述问题}
**阶段**：Phase {N} / Task {tid}
**已尝试**：{已自动执行的修复措施，如 "error-fixer 重试 1 次仍 UNFIXED"}

**上下文**：
- 相关文件：{files}
- 错误摘要：{error_summary，≤ 200 字符}

**选项**：
1. {选项 A — 推荐}（风险：{risk}）
2. {选项 B}（风险：{risk}）
3. 终止编排

请回复选项编号（如 "1"），或补充说明。
```

### 用户回复处理

- 选项编号 → 执行对应操作
- 补充说明 → 追加到 session.md「关键约束和决策」，按说明继续
- 无响应超过 5 分钟 → 不自动决策，保持暂停（用户可在新 chat 恢复）

## 错误恢复

| 错误类型 | 处理方式 | 最大重试 |
|----------|----------|----------|
| python3 不可用 | **阻塞**，提示用户安装 | 0 |
| $O 命令执行失败 | 检查 stderr，修复参数后重试 | 1 |
| 管理台 API 不可用 | RAG 回退到本地 lessons/improvements 文件搜索；趋势跳过，不阻塞 | 0 |
| 编译检查 FAIL | 主 Agent 内联执行检查；FAIL 后 spawn SubAgent 修复，修复后先内联编译确认再重试 | 1 |
| 单元测试 FAIL | spawn SubAgent 修复 | 1 |
| E2E 测试 FAIL | **SOFT_FAIL**：记 pending.md（`soft:` 前缀），不阻塞（E2E 依赖外部环境，前序门已保障代码质量） | 0 |
| CCC 偏离 | 小型 task（≤3 文件）主 Agent 内联自检；大型 task spawn SubAgent；偏离记 pending.md，不阻塞 | 0 |
| 质量门 B/C FAIL | **executor** 按落盘反馈修复 → **Delta 重检** → 仍 FAIL 则 **error-fixer** 兜底 → **完整重执行**该门 1 轮；仍 FAIL 记 pending.md | 1（每门每轮编排上限见 Phase 3-f / 4b） |
| SubAgent 超时无响应 | 标记 task FAILED，继续后续（依赖 IDE Task 工具内置超时） | 0 |
| 恢复 session 时有 RUNNING task | 检查 started_at 是否过期（> timeout_minutes），过期则标记 FAILED | 0 |
| git tag 失败 | WARN 日志，跳过快照，不阻塞 | 0 |
| 重试仍失败 | FAILED + 记 pending.md（按标准操作），继续后续 | — |
| 连续 2 task FAIL | **MUST 暂停**（不论 gate_mode）：提示回滚到最后成功 task，用户确认后 `$O rollback` | 0 |
