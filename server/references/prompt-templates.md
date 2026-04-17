# SubAgent Prompt 模板

> **核心原则**：所有 prompt 构造前 MUST 重新读取 session.md 提取信息，不依赖 LLM 记忆。

## 角色文件引用

所有 SubAgent 角色定义已持久化到 `.cursor/agents/*.md`。prompt 首行使用 `按 .cursor/agents/{role}.md 执行` 引用角色文件，SubAgent 自动获取角色锚定、检查维度、输出契约和范围锁定。

以下模板中的 `[角色定义]` 层已由角色文件承载，prompt 中不再内联角色描述。

## 提示词工程原则

### 结构化分层（每个 prompt 必须遵循）

```
[角色引用]     → 按 .cursor/agents/{role}.md 执行（替代内联角色定义）
[任务指令]     → 明确目标和验收标准
[上下文注入]   → 从 session.md 提取，分块标注用途
[输出格式]     → 精确定义返回结构（与角色文件 output_contract 一致）
[范围锁定]     → 角色文件已定义，仅补充 task 特定约束
```

### 防失忆注入策略

→ 裁剪优先级和预算详见 `references/context-engineering.md`。

**速记**：执行类按 depends_on 动态计算（800~3000 字符，通用约束不计入），规划/审查类不设上限。

### 防幻觉技巧

| 技巧 | 说明 |
|------|------|
| 真相源标注 | 用 `（防失忆 — 不可修改）` 标记不可篡改的事实 |
| 显式输出约束 | "严格 JSON，不要附加文字" 防止自由发挥 |
| 检测而非假设 | 所有文件/CLI 存在性用命令检测 |
| 负面约束 | "不要编造需求点"、"不要修改无关代码" |

---

## Prompt 模板

### 增强编排模式 — 需求拆解

```
按 .cursor/agents/planner.md 执行。将以下需求拆分为可执行的任务清单。

## 用户需求（防失忆 — 完整保留）
{user_requirement}

## 历史经验（防幻觉 — 来自 RAG）
{rag_context}

## 输出格式（严格 JSON 对象信封，不要附加文字）
示例：
{
  "tasks": [
    {
      "name": "xxx",
      "description": "xxx（含验收标准: xxx）",
      "depends_on": [],
      "skill": null,
      "owns_globs": ["src/xxx/**"],
      "parallel_hint": true
    }
  ],
  "design_brief": "# 设计简报\n\n## 核心接口签名\n- ...\n\n## 数据模型\n- ...\n\n## 模块交互\n- ...\n\n## 技术决策\n- ..."
}

## 约束
- id 自动分配 t1, t2, t3...
- 单个 task 不超过 1 小时工作量
- 每个 task 必须包含验收标准
- design_brief 必须覆盖：核心接口签名列表、数据模型草稿、模块交互关系、关键技术决策
- 不要创建文档类/测试类 task（除非需求明确要求）
```

### 开发任务执行（Phase 3-c：executor）

**`{design_brief}` 占位符（编排层替换规则）**

- **替换来源**：主 Agent 构造本模板时，将 `{design_brief}` 替换为 **`$DIR/design-brief.md` 的文件全文**（UTF-8）。该文件由 **Phase 1d** 将 planner 信封 JSON 中的 `design_brief` 字段落盘得到；`$DIR` 为当前会话工作目录根。
- **缺失降级**：若 **`$DIR/design-brief.md` 不存在**（或不可读），不得保留裸占位符、不得由模型自行编造设计正文；应整段替换为以下 **sentinel 文案**（建议一字不改，便于日志与审计识别）：
  - `[DESIGN_BRIEF_MISSING] $DIR/design-brief.md 不存在。增强编排下通常应由 Phase 1d 落盘；实现时仅以本 prompt 中已注入的「任务 / 需求摘要 / 关键约束 / 设计上下文」等段落为准对齐设计，禁止臆造未出现的接口签名、数据模型或模块边界。`

```
按 .cursor/agents/executor.md 执行。执行以下开发任务。

## 任务（你的唯一目标）
- ID: {tid}
- 名称: {task_name}
- 描述: {task_description}

## 需求摘要（防失忆 — 与本 task 相关的需求要点）
{task_requirement_summary}

> {requirement_source_ref}

## 关键约束和决策（防失忆 — 必须遵守）
{universal_constraints}
{domain_constraints_filtered}

## 前置 task 产出（防失忆 — 接口契约）
{predecessor_outputs}

## 历史经验（防幻觉 — 来自 RAG）
{rag_context}

## 设计简报（Phase 1d 落盘 — 接口/模型/模块边界与设计决策）
{design_brief}

## 设计上下文（OpenSpec 模式时注入，否则跳过）
{design_context}

## 语言约束（见 references/context-engineering.md「语言特化 Hints」）
{language_hints}

## 范围锁定（NEVER 违反）
- 仅修改与本 task 相关的文件
- 不要"顺手"修改无关代码、创建无关文档
- 不要添加示例数据或 mock 文件

## 完成后汇报（严格按此格式，不可省略）
在输出最开头写一行：'## 执行结果: SUCCESS' 或 '## 执行结果: FAILED'
然后：
1. 修改了哪些文件（新增/修改/删除）
2. 新增了哪些接口/导出
3. 关键设计决策
4. 是否有未解决的问题或告警
```

### CCC 上下文一致性校验

```
按 .cursor/agents/consistency-checker.md 执行。严格基于文件内容判断，不要编造信息。

## 原始需求（真相源 — 不可修改）
{user_requirement}

## 待审查对象
{artifact_to_review}

## 检查维度
1. 需求覆盖率：每个需求功能点是否有对应方案
2. 需求偏离度：是否包含需求未提及的额外功能
3. 术语一致性：用词是否与需求一致

## 输出格式（严格 JSON，不要附加文字）
{"coverage_pct": N, "deviations": [...], "omissions": [...]}
```

### 错误修复

```
按 .cursor/agents/error-fixer.md 执行。修复以下错误。

## 原始任务
{original_task_description}

## 错误详情
{error_details}

## 用户原始需求（防失忆）
{user_requirement}

## 关键约束（防失忆）
{key_constraints}

## 语言约束（见 references/context-engineering.md「语言特化 Hints」）
{language_hints}

## 范围锁定
仅修复错误，不扩展功能，不修改无关代码。
```

### 质量门 B — task 级代码审查

```
按 .cursor/agents/quality-reviewer.md 执行。审查以下文件的代码质量（只审查，不修复）。

## 审查文件（每行一个路径，格式: `[状态] 路径`，状态: M=修改/A=新增/D=删除）
{files}

## 检查清单
读取 references/quality-checklist.md，对其中级别为 `task` 或 `both` 的每条检查项逐一判定。

## 输出格式（严格 JSON，不要附加文字）
{"items": [{"id": "C01", "result": "PASS|FAIL|N/A", "evidence": "失败时填写：文件路径、行号、说明"}], "summary": "PASS|FAIL"}

任一 FAIL 则 summary 为 FAIL。N/A 须在 evidence 中说明理由。
```

### 质量门 C — 全局审查

```
按 .cursor/agents/quality-reviewer.md 执行。审查变更的全局一致性与跨模块影响（只审查，不修复）。

## 必读材料
- `$DIR/session.md`（会话决策与需求真相源）
- 本次变更涉及的所有文件（完整阅读内容）

## 审查文件（每行一个路径，格式: `[状态] 路径`，状态: M=修改/A=新增/D=删除）
{files}

## 检查清单
读取 references/quality-checklist.md，对其中级别为 `global` 或 `both` 的每条检查项逐一判定。

## 跨文件 / 跨模块审查维度
- 模块边界与依赖方向是否合理
- 公共接口、类型与配置在相关文件间是否一致
- 是否存在重复实现、循环依赖或隐式耦合

## 输出格式（严格 JSON，不要附加文字）
{"items": [{"id": "C01", "result": "PASS|FAIL|N/A", "evidence": "失败时填写：文件路径、行号、说明"}], "summary": "PASS|FAIL"}

任一 FAIL 则 summary 为 FAIL。N/A 须在 evidence 中说明理由。
```

### 内联 CCC-2（主 Agent 自检 — 变更文件 ≤5 时使用）

```
按 .cursor/agents/consistency-checker.md 执行。基于实际文件内容判断，不要编造信息。

## 审查对象
Task '{tid}' 的变更文件：{files}

## 对照基准
{design_or_constraints}

## 检查维度
1. 接口签名是否与设计一致
2. 是否有超出 task 描述范围的修改
3. 命名是否与需求/设计文档对齐

## 输出格式（严格 JSON）
{"aligned": true/false, "issues": [...]}
```

### CCC-merge — 并行合并语义冲突检测

```
按 .cursor/agents/consistency-checker.md 执行。检查多个并行 task 合并后的语义一致性。严格基于文件内容判断，不要编造信息。

## 并行完成的 task 列表
{parallel_tasks_with_files}

## 检查维度
1. **跨 task 公共接口签名一致性**：不同 task 导出的函数/方法/API 路径，参数类型和返回类型是否冲突
2. **跨 task 配置项/常量/枚举一致性**：不同 task 修改的配置项/常量是否存在值冲突
3. **跨 task 导入路径正确性**：不同 task 新增/修改的模块，导入路径是否能正确互引

## 输出格式（严格 JSON，不要附加文字）
{"aligned": true/false, "issues": ["issue1", "issue2"], "tasks_checked": ["t1", "t2"]}
```
