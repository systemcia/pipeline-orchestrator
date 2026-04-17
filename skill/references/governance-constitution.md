# 分层治理宪法（Pipeline Orchestrator）

> 与 `references/protocols.md` 配套：协议写「怎么传上下文」，宪法写「约束写在哪、冲突谁说了算」。

## 1. 职责边界（分层载体）

各层「只放什么」见下表。单一事实源的抽象原则、引用规则、权威表示例及已知重复治理见 **§9**。

| 层 | 载体 | 只放什么 |
|----|------|----------|
| 编排锁步 | `SKILL.md` + `phases/*.md` | Phase 顺序、`[Shell]`/`[Task]`、何时调用 `$O`、规模/Profile 引用 |
| 角色契约 | `.cursor/agents/*.md` | 输出结构（JSON/PASS-FAIL）、审查维度、范围锁定、画像注入裁剪 |
| 常驻硬约束 | `.cursor/rules/*.mdc` | 安全/合规、项目技术栈、不可违背的工程红线 |
| 变更需求 | `openspec/changes/<name>/` | 某次改动的 proposal/design/specs/tasks，**不**替代全局编排协议；与 `$O` 主从关系见 **`references/openspec-integration.md`「OpenSpec 与 `$O` 主从关系」** |
| 用户偏好 | `.cursor/rules/user-profile.mdc` | 沟通风格、习惯用语；**不**覆盖正确性与安全 |

## 2. 冲突优先级（从高到低）

1. 安全与正确性（含规则中的 MUST、工具非 0 退出码）
2. `SKILL.md` / `phases/` 中的编排 MUST（顺序、落盘、禁止跳过）
3. SubAgent 角色文件中的**输出契约**（字段名、FAIL 语义）
4. OpenSpec 当前 change 的已批准需求范围
5. 用户画像与沟通偏好

**说明**：若「编排步骤」与「角色输出格式」冲突，以角色输出格式为准（否则无法解析），但编排层 MUST 仍不得跳过 `done`/`fail`/校验等落盘步骤。

## 3. 审查角色分界：evaluator、quality-reviewer 与 optimization-master

### 3.1 evaluator 与 quality-reviewer（阶段与清单不可混用）

二者**互不替代**，各有专属 checklist；编排 spawn 须与 Phase 对齐，禁止用另一角色的清单「顶替」门禁。

| 角色 | 文件 | 适用阶段 | 权威清单 | 禁止 |
|------|------|----------|----------|------|
| **evaluator** | `.cursor/agents/evaluator.md` | **Phase 1** 提案阶段 | `references/proposal-checklist.md` | 不得用 quality-reviewer 或 `quality-checklist.md` 替代本阶段提案审查 |
| **quality-reviewer** | `.cursor/agents/quality-reviewer.md` | **Phase 3 / Phase 4** 代码与交付相关阶段 | `references/quality-checklist.md` | 不得用 evaluator 或 `proposal-checklist.md` 替代本阶段代码审查 |

### 3.2 optimization-master 与 evaluator（提案质量补强）

- **默认**：Phase 1 质量门 A 使用 **evaluator**（OpenSpec 流程内），**不**自动再 spawn optimization-master，避免双重全量审查与成本翻倍。
- **例外**：用户显式要求 optimization-master，或 `references/skill-routing-table.md` 中关键词命中「优化 / review / 极致优化」等 → 可路由该 Skill，与 evaluator **择一或按用户显式顺序**，默认不串联两次全量「顶级审查」。

optimization-master 是 **Skill 流程**，不取代 §3.1 中 evaluator 相对 **quality-reviewer** 的阶段分界；代码阶段仍以 **quality-reviewer** + `quality-checklist.md` 为准。

## Skill 与 Agent 的关系

SubAgent **spawn** 时，`agent_type`（角色约束）与 **Skill**（领域流程）可同时生效。本节定义二者分工、典型组合方式及冲突裁决；**不**替代 §2 的全局优先级（安全、正确性、编排 MUST 仍优先）。

### 角色与能力

- **Agent（角色）**：由 `.cursor/agents/{role}.md` 定义，规定**行为准则**与**输出契约**（如 PASS/FAIL、JSON 字段、审查维度、**范围锁定**）。角色回答「以何种身份行事、必须交付何种形态、边界不得越过哪里」。
- **Skill（能力）**：由编排入口 `SKILL.md`、项目内 Skill 或可路由的独立 Skill 文档定义，规定**特定领域的执行流程**（步骤顺序、工具与检查单、领域惯例）。能力回答「这类任务按什么流程做」。

### spawn 叠加（典型组合）

二者常见**叠加**方式为指令同时出现：

1. **按角色文件执行**：例如「按 `.cursor/agents/{role}.md` 执行」——注入角色契约
2. **调用 Skill**：例如「调用 xxx Skill」——注入领域流程

叠加语义：Agent 提供身份、边界与交付形态；Skill 在同一角色下补充领域动作顺序与专项约束。Skill **不得**把 SubAgent 扩展为角色文件中**未定义**的职责。

### Skill 对 Agent 的从属

Skill **不**覆盖、不削弱 Agent 已声明的 **scope lock**（范围锁定）与 **output contract**（输出契约：结构、语义、FAIL 含义）。若 Skill 的步骤或表述与二者冲突，以 Agent 为准，并对 Skill 中冲突部分予以忽略或按角色边界剪裁后执行。

### 冲突优先级（本组合内，从高到低）

当 **Agent 输出契约**、**Skill 执行流程**、**未由二者显式约定的默认行为**（如模型通用习惯）发生张力时：

1. **Agent 输出契约**（含 scope lock 中的硬边界）
2. **Skill 执行流程**（在不违反上一条的前提下）
3. **默认行为**

与 §2 的衔接：全局仍以 §2 为序。当仅讨论「同一 spawn 内角色文件 + Skill 同框」、且不违背 §2 中更高优先级项时，适用上文「冲突优先级」小节的三层序。

## 4. automation_tier 与 gate_mode（正交）

|  | `gate_mode: auto` | `gate_mode: interactive` |
|--|-------------------|---------------------------|
| **tier 0** | 等效 `dry_run: true`，仅执行 Phase 0+1 预览 | 同左 |
| **tier 1** | 实现 + 确定性门（编译/单测）；跳过 CCC/质量门B/回归测试 | 确定性门 FAIL 时暂停 |
| **tier 2**（默认） | 自动推进 + Phase 1g 必停；pending 最终汇总 | 在质量门 B/C、编译连续 FAIL、CCC 严重偏离等节点额外暂停 |
| **tier 3** | 全流程 + thorough profile；仍遵守 Phase 1g | **推荐**：thorough profile + interactive，关键节点人工裁决 |

**冲突处理**：`automation_tier` 与 Profile 的 `skip_steps` 同时作用时，**更保守者生效**。

**映射关系**：tier 0 → `dry_run: true`；tier 1 → 编排层自动添加 `skip_steps: [ccc-2, quality-gate-b, regression-test]`；tier 3 → 编排层自动选择 `thorough` profile + `interactive` gate_mode。引擎不读取 `automation_tier`，映射逻辑在编排层（SKILL.md Phase 0e）。

## 5. pending.md 与门控类型

记录自动决策时，**决策点**字段建议带前缀，便于 harness 与复盘：

- **`hard:`** — 对应 `protocols.md` 中 **HARD_FAIL**（编译/测试/引擎校验等确定性失败后的自动处理）。
- **`soft:`** — 对应 **SOFT_FAIL**（CCC、质量门、evaluator 等 LLM 审查结论）。

示例：`hard: 编译连续 FAIL t2`、`soft: 质量门B t3 未通过`。

## 6. $O（orchestrate.sh）路径

多份 `pipeline-orchestrator` 安装并存时，**必须**设置唯一入口：

```bash
export PIPELINE_ORCHESTRATOR_HOME=/path/to/pipeline-orchestrator
```

发布到 `~/.cursor/skills/` 等全局目录的 Skill 副本时，须与仓库根目录 `SKILL.md` 内 **`$O` 解析片段**保持同步，避免双轨行为。

## 7. 遥测文件

每个 session 目录下可有 `telemetry.jsonl`（`engine.py` 在 `start`/`done`/`fail` 追加 JSON 行），用于 Phase 5 harness 与假设复审（如 H09 调用次数）；**不**替代管理台趋势 API（`$O trend` 仍以 18000 为准，若可用）。

复盘时对照 **`references/telemetry-anti-patterns-v2.md`** 检查事件链异常（advisory 为主，v2 含 6 条反模式）。

## 8. 确定性证据（交叉引用）

编译/测试等 HARD_FAIL 的通过条件、`$O test-gate` 与 Shell 退出码关系、**`PIPELINE_STRICT_TEST_EVIDENCE`** → 见 **`references/protocols.md`「Gate Taxonomy」§ 确定性证据（Evidence）**；不在本文件重复展开。

## 9. 单一事实源（SSOT）

SSOT 解决「**定义与细则写在哪一份文件**」。**不同文档之间何者优先**仍以 **§2 冲突优先级**为准，二者正交、不矛盾。

### 9.1 原则

- 每个**关键概念**（编排步骤、角色契约、质量清单、状态字段语义等）应有且仅有**一个**权威来源文件（或一组明确约定的文件族，如 `phases/*.md`）。
- 非权威文件只保留**指针**（例如「见 `references/context-engineering.md`」），**不**复制长段定义，避免分叉。

### 9.2 引用规则

- 需要展开细则时：在落点文件写一句跳转，读者到权威文件阅读全文。
- 发现与权威文件不一致的副本：以权威文件为准，删除或改为指针；若确需例外，须在权威文件中显式记载（仍受 §2 约束）。

### 9.3 关键概念权威表示例（本仓库路径）

| 概念域 | 权威来源 |
|--------|----------|
| Phase 流程与逐步说明 | `phases/*.md` |
| 编排入口、Phase 路由与规模矩阵等入口级约束 | `SKILL.md`（与 `phases/*.md` 须一致；步骤正文不重复展开，见 §9.4） |
| SubAgent 角色定义 | `.cursor/agents/*.md` |
| 代码阶段质量检查清单 | `references/quality-checklist.md`（与 **quality-reviewer** 配套，见 §3.1） |
| 提案阶段质量检查清单 | `references/proposal-checklist.md`（与 **evaluator** 配套，见 §3.1） |
| 上下文注入与一致性策略 | `references/context-engineering.md` |
| session 编排状态（`state.json` 字段语义与读写约定） | `scripts/engine.py`（仓库内无单独 JSON Schema 文件时，以引擎实现与落盘约定为准） |

### 9.4 已知重复与治理计划

| 现象 | 治理计划 |
|------|----------|
| **`SKILL.md` 与 `phases/*.md`** 对 Phase 顺序、门控、步骤说明均有叙述，易产生「改一处漏一处」 | 以 **`phases/*.md`** 为 Phase **步骤正文**权威来源；**`SKILL.md`** 保留入口、顺序索引、`[Shell]`/`[Task]` 路由及规模矩阵等，**新增或变更 Phase 时先改 `phases/` 再在 `SKILL.md` 做最小指针级同步**。 |
| **`AGENTS.md` 与 `SKILL.md`** 均含编排导航与约束摘要 | **`AGENTS.md`** 作为 Agent 全局索引与目录导航；编排 **MUST**、Phase 细则仍以 **`SKILL.md` + `phases/*.md`** 为准（与 §2 一致），`AGENTS.md` 不新增与二者冲突的硬性规则。 |
