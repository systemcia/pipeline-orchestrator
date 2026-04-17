# Phase 1: 探索 + 提案

> **适用规模**：中 / 大。小规模跳过本 Phase，直接进入 Phase 2-小。

> **统一抽象**：两种编排模式（增强/OpenSpec）的**流程骨架一致**：探索 → 拆解 → 校验 → 审批。差异仅在于**制品格式**：增强模式产出 JSON 信封 `{ "tasks": [...], "design_brief": "..." }`（planner 同时输出 task 列表与设计简报），OpenSpec 模式产出 proposal.md / design.md / tasks.md。Phase 2 之后两种模式**完全统一**——session 中的 task DAG 格式一致，后续 Phase 3~5 无分叉。

## 1a. 编排模式选择（用户意图驱动）

**模式判定逻辑**（按优先级）：

1. **用户显式指定** → 用户说"帮我提案"/"openspec 提案"/"走提案流程" → OpenSpec 模式；用户说"帮我编排"/"全自动开发"/"流水线执行" → 增强编排模式
2. **未显式指定** → 默认**增强编排模式**（轻量高效，85% 场景适用）

确定模式后，检测 OpenSpec 工具链是否可用（仅 OpenSpec 模式需要）：
```
[Shell] ls openspec/config.yaml 2>/dev/null && echo "HAS_OPENSPEC" || echo "NO_OPENSPEC"
```

- OpenSpec 模式 + `NO_OPENSPEC` → 提示用户"未找到 openspec/config.yaml，是否改用增强编排模式？"
- 增强编排模式 → 无论 `openspec/config.yaml` 是否存在，均走增强编排流程

记录 `MODE`（`enhanced` / `openspec`）。

## 1a-2. 需求确认（中/大规模，主 Agent 内联执行）

基于需求原文，主 Agent 向用户输出结构化理解：

**我的理解**：
1. {功能点 1}
2. {功能点 2}
...

**假设**（如有）：
- {技术假设或业务假设}

**模糊点**（如有）：
- {需要用户澄清的点}

等待用户确认：
- 用户确认（"没问题"/"可以"/"ok"）→ 继续 1b
- 用户补充/修正 → 更新需求理解后继续 1b
- 用户取消 → 终止编排

适用规模：中/大。小规模跳过（小规模在 Phase 2-小 展示 task 摘要时已有隐式确认）。

**追踪落盘**（MUST）：
```
ANALYSIS_TRACE+="

## 2. 需求理解与确认
- **原始输入**: <用户需求原文>
- **结构化理解**:
  1. {功能点 1}
  2. {功能点 2}
- **假设**: {假设列表，无则"无"}
- **模糊点与澄清**:
  - Q: {问题} → A: {用户回答}
- **确认结论**: {用户确认/补充的内容}"
```

## 1b. RAG 预搜索（管理台可用时）

```
[Shell] curl -sf "http://localhost:18000/api/knowledge/rag-search?q=<需求关键词>&limit=5" | python3 -m json.tool
```

提取返回结果的 `topic` + `answer_core`，作为 `[RAG_CONTEXT]` 注入后续 prompt。

管理台不可用时，回退到本地搜索：
```
[Shell] grep -rl "<需求关键词>" /opt/pipeline-orchestrator/sessions/*/session-analysis.md /opt/pipeline-orchestrator/sessions/*/lessons.md 2>/dev/null | head -3 | xargs -I{} head -20 {} 2>/dev/null || echo "INFO: 无本地历史经验"
```
将匹配结果作为 `[RAG_CONTEXT]`。两者均不可用 → `[RAG_CONTEXT]` 设为空。

**追踪落盘**（MUST）：
```
ANALYSIS_TRACE+="

## 3. 历史经验检索
- **搜索词**: {RAG 查询关键词}
- **命中结果**:
  - [{topic}] {answer_core 摘要} — 采纳/忽略，原因: {reason}
- **未命中时**: 无相关历史经验"
```

## 1c. 探索（可选，满足任一触发条件时执行）

**触发条件**（满足任一即执行）：
1. 用户需求涉及 **≥2 个模块/目录**（从需求描述判断或 1a-2 确认中识别）
2. 需求描述中存在 **模糊指代**（如"那个服务"、"相关接口"）
3. 编排层**首次在该项目执行**（`$O list` 无同项目的历史 session）
4. 用户显式要求探索（"先看看代码"、"分析下结构"）

不触发时直接跳到 1d。

```
[Task] spawn explore SubAgent，指令：
  "探索项目结构，重点关注与以下需求相关的模块：<需求原文>。
   输出：相关目录、核心文件、现有接口、技术栈。"
```

探索完成后，将产出摘要持久化（避免仅靠主 Agent 记忆传递）：
```
EXPLORE_SUMMARY="技术栈: {tech_stack}; 相关模块: {dirs}; 现有接口: {apis}"
```
此摘要在 Phase 2 的 `$O update-session $DIR "关键约束和决策"` 中作为第一条注入。

**追踪落盘**（MUST，未触发探索时写"未触发"）：
```
ANALYSIS_TRACE+="

## 4. 代码探索发现
- **触发原因**: {触发条件编号及描述，或"未触发（不满足任何探索条件）"}
- **发现**:
  - 技术栈: {tech_stack}
  - 相关模块: {dirs}
  - 现有接口: {apis}
  - 关键发现: {影响拆解决策的发现，如"现有表无 team_id 字段"}"
```

## 1d. 需求拆解与提案

### 增强编排模式（默认）

**MUST 执行以下步骤，不可省略为"分析需求拆解为 JSON"。**

按 `references/prompt-templates.md`「增强编排模式 — 需求拆解」模板，填入 `{user_requirement}`、`{explore_context}` 和 `{rag_context}` 后 spawn：
- `{explore_context}`：Phase 1c 的 `EXPLORE_SUMMARY` 变量内容（含技术栈、相关模块、现有接口、关键发现）。未触发 1c 探索时设为 `"未执行代码探索（未满足任何触发条件）"`
```
[Task] spawn generalPurpose SubAgent，指令：<填充后的需求拆解模板，角色引用 planner.md>
```

### 1d-1. 解析与 design_brief 暂存（增强编排模式）

主机 Agent 收到 planner 返回后：

1. **解析 JSON 信封**：`{ "tasks": [...], "design_brief": "<Markdown 字符串>" }`。解析失败 → 按既有策略处理（例如要求 planner 修正输出后重试），不得进入后续步骤。
2. **解析成功后**：将 `design_brief` 字段（Markdown 原文）**暂存于主 Agent 变量 `DESIGN_BRIEF`**。**落盘时机**：Phase 2 `$O init` 创建 session 目录（`$DIR`）之后，立即执行 `echo "$DESIGN_BRIEF" > $DIR/design-brief.md`（UTF-8，覆盖写入）。Phase 1 期间 `$DIR` 尚不存在，**不可**在此步直接写文件。

**与「1d-2. 轻量提案检查」的顺序**：若两者均执行，**必须先完成本步 JSON 解析与 `DESIGN_BRIEF` 暂存，再进入 1d-2**；不得先跑轻量检查再解析信封。

**追踪落盘**（MUST，增强编排模式）：
```
ANALYSIS_TRACE+="

## 5. 需求拆解推理
- **模式**: 增强编排（planner JSON 信封）
- **拆解策略**: {为什么选择这种拆法，如"按数据层→逻辑层→展示层分层"}
- **备选方案**: {考虑过但放弃的拆法，含放弃原因；如"曾考虑前后端合并为单 task，但变更面过大放弃"}
- **最终 task 列表**:
  - t1: {name} — {为什么需要这个 task}
  - t2: {name}（依赖 t1）— {为什么依赖 t1}
- **依赖关系设计理由**: {如"t2 需要 t1 创建的数据表才能编码后端逻辑"}"
```

### 1d-2. 轻量质量检查（增强编排模式，中/大规模执行）

在 **`design_brief` 已成功解析并暂存为 `DESIGN_BRIEF`**（见 1d-1）之后，执行 [待确认] 自动扫描 + 轻量质量检查：

**[待确认] 自动暂停**：扫描 planner 输出的 task JSON 中 description 是否包含 `[待确认]` 文本。有则向用户展示待确认项并暂停，用户明确后继续。无则直接进入质量检查。

**轻量质量检查**（中/大规模）：
```
[Task] spawn generalPurpose SubAgent，指令：
  "按 .cursor/agents/evaluator.md 执行轻量提案质量评估。
   仅检查以下 5 条（跳过其余）：
   - PA05: 验收标准齐全
   - PA06: 任务拆分合理
   - PA07: 依赖关系正确
   - PA09: task 描述可独立执行
   - PA13: 无范围蔓延（task 不包含需求未提及的功能）
   审查对象：拆解出的 task 列表。
   输出格式与质量门 A 一致：{items: [{id, result, evidence}], summary: PASS|FAIL}"
```

FAIL → 将 FAIL 条目反馈给 planner 重新拆解（**最多 1 次**）。仍 FAIL → 记 pending.md，继续。

> **角色说明**：`planner.md` 专职需求分析与任务拆解；`codebase-researcher.md` 仅在 Phase 1c 探索阶段使用，不混用。

### OpenSpec 模式（用户显式选择时）

```
[Shell] openspec list --json
```

检查是否已有同名 change。无则创建：
```
[Shell] openspec new change "<需求kebab-case名>"
```

然后 spawn SubAgent 生成提案：
```
[Task] spawn generalPurpose SubAgent，指令：
  "调用 openspec-propose Skill，change 名称为 '<需求kebab-case名>'。
   ## 用户需求原文（防失忆 — 不可截断）
   <需求全文>
   ## 代码探索发现（防失忆 — 来自 Phase 1c 探索，设计时 MUST 对齐）
   <EXPLORE_SUMMARY 或 "未执行代码探索">
   ## 历史经验（防幻觉 — 来自 RAG）
   [RAG_CONTEXT]
   ## 约束
   - 按 Skill 指引生成 proposal.md、design.md、tasks.md
   - 每个 task 必须有明确验收标准
   - 不要创建无关文档
   ## 完成后输出
   生成的文件列表 + 关键设计决策摘要"
```

**追踪落盘**（MUST，OpenSpec 模式的 §5 拆解推理）：
```
ANALYSIS_TRACE+="

## 5. 需求拆解推理
- **模式**: OpenSpec（proposal.md + design.md + tasks.md）
- **拆解策略**: {openspec-propose SubAgent 的拆解逻辑概述}
- **备选方案**: {考虑过但放弃的设计方案，从 proposal.md/design.md 提取}
- **最终 task 列表**:
  - {从 tasks.md 提取的 task 概览}
- **关键设计决策**: {从 design.md 提取的核心决策}"
```

## 1f. 质量门 A — 提案自检（大规模执行）

PA13/PA14 已覆盖原 CCC-1 的需求覆盖率和术语一致性校验。

spawn evaluator SubAgent，按 `evaluator.md` + `references/proposal-checklist.md` 逐条判定提案产出：
```
[Task] spawn generalPurpose SubAgent，指令：
  "按 .cursor/agents/evaluator.md 执行提案质量评估。
   读取 references/proposal-checklist.md 检查清单和提案文件。
   逐条 PASS/FAIL 判定，任一 FAIL 则整体 FAIL + 问题清单。"
```

审查对象：
- OpenSpec 模式：`openspec/changes/<name>/` 下的 proposal.md、design.md、tasks.md
- 增强编排模式：拆解出的 task 列表

FAIL → 修复后重检（**最多 1 次**）。仍 FAIL → 记 pending.md：决策点"质量门A未通过"、自动选择"继续执行"、风险"提案质量待人工确认"，继续。

**追踪落盘**（MUST，1d-2 和/或 1f 执行后统一记录；均跳过时写"跳过"）：
```
ANALYSIS_TRACE+="

## 6. 质量门审查记录
- **检查类型**: {轻量质量检查(1d-2) / 质量门 A(1f) / 两者均执行 / 跳过（小规模）}
- **结果**: PASS / FAIL
- **FAIL 条目与修正**:
  - {PA-id}: {问题描述} → 修正为: {修正内容}
- **重试**: {是否触发 planner 重拆或重检，结果如何}"
```

## 1g. 确认状态 + 用户审批

OpenSpec 模式时，先查询状态：
```
[Shell] openspec status --change "<name>" --json
```

向用户展示提案摘要（核心内容 + task 列表），等待用户确认：
- 用户确认 → Phase 2（OpenSpec 模式 → Phase 2A，增强编排模式 → Phase 2B）
- 用户要求修改 → 回到 1d 修正（**回到 1d 时更新 §5 拆解推理**，追加修改原因）
- 用户取消 → 终止编排

**追踪落盘**（MUST）：
```
ANALYSIS_TRACE+="

## 7. 用户审批
- **展示内容摘要**: {给用户展示的 task 列表和核心设计}
- **用户反馈**: {确认/修改要求/补充意见}
- **最终决策**: 确认执行 / 要求修改(→回 1d) / 取消"
```

### Dry-Run 终止检查

如果 `MODE=dry-run`：
- 在展示内容最后标注 `[DRY-RUN] 预览结束，不进入实施阶段`
- 终止编排流程（不进入 Phase 2）

### Phase 状态机推进

Phase 1 尚未创建 session（`$DIR` 不存在），Gate 决策和 Phase 推进**延迟到 Phase 2 `$O init` 创建 session 之后**执行（见 `phase-2-session.md`「Phase 状态机追赶」）。
