# 声明式编排拓扑

## 设计目标

Phase Markdown 文件是 LLM 的详细执行指令（面向自然语言理解），topology 是引擎的机器可校验骨架（面向结构化校验）。两层互补、不替代。

```
Phase Markdown（执行层）  ← LLM 逐步读取、理解、执行
         ↑ 对齐校验
topology YAML（声明层）   ← engine.py validate-topology 结构化校验
```

## 配置位置

`topology` 块位于 `templates/pipeline-orchestrator.yaml`（模板）或项目根目录 `.pipeline-orchestrator.yaml`（项目级覆盖）。

## 结构概览

```yaml
topology:
  phases:          # Phase 骨架：顺序、步骤、转移条件
    - id: 0
      name: bootstrap
      file: phases/phase-0-bootstrap.md
      steps: [...]
      transitions: [...]
  agents:          # SubAgent 注册表
    - id: executor
      file: .cursor/agents/executor.md
      phases: [3]
  gates:           # Gate 注册表（与 profiles.gates 对齐）
    - id: after-propose
      phase: 1
```

## Phase 定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | int | ✓ | Phase 编号（0-5） |
| `name` | string | ✓ | Phase 简称 |
| `file` | string | ✓ | 对应的 Phase Markdown 文件路径 |
| `required` | bool | | 是否所有规模必须执行 |
| `skip_when` | string | | 跳过条件表达式 |
| `steps` | list | ✓ | 步骤列表 |
| `transitions` | list | | 流转目标 |

## Step 定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 步骤唯一标识（Phase 内唯一） |
| `step_id` | string | | 对应规模裁剪矩阵的 Step ID |
| `type` | enum | ✓ | `shell` / `task` / `decision` / `gate` |
| `agent` | string | | type=task 时引用的 SubAgent id |
| `description` | string | | 步骤说明 |
| `gate_type` | enum | | `hard`（阻塞） / `soft`（可降级） |
| `gate_id` | string | | type=gate 时对应的 Gate 注册 id |
| `optional` | bool | | 是否可选步骤 |
| `loop` | bool | | 是否循环执行 |
| `parallel_eligible` | bool | | 是否可并行 spawn |

## Agent 注册

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | Agent 标识，需与 `.cursor/agents/{id}.md` 对齐 |
| `file` | string | ✓ | Agent 角色定义文件路径 |
| `phases` | list[int] | ✓ | 允许参与的 Phase 列表 |
| `tools_budget` | int | | 工具调用预算 |

## Gate 注册

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 与 profiles.gates 中的值对齐 |
| `phase` | int | ✓ | 所在 Phase |
| `step` | string | | 对应的 step id |
| `required_modes` | list | | 哪些 gate_mode 下为必停点 |

## 校验规则

`$O validate-topology` 执行以下检查：

1. **Phase 结构完整性** — id 不重复、name 非空、file 文件存在
2. **Step 合法性** — type 值合法、Phase 内 id 不重复
3. **Transition 一致性** — 目标 phase id 必须已声明
4. **Agent 对齐** — steps 引用的 agent 必须在 agents 注册；agents 声明的必须被 steps 引用
5. **Gate 对齐** — profiles.gates 引用的 gate id 必须在 topology.gates 注册
6. **Agent 文件存在性** — agents.file 指向的 Markdown 文件必须存在

## 校验时机

- **Phase 0 前置检查**（可选，不阻塞编排）
- **开发者修改 topology 后手动执行**
- **CI 集成**（推荐）

## 与其他模块的关系

| 模块 | topology 的角色 |
|------|----------------|
| Phase Markdown | topology 是骨架，Phase MD 是血肉 |
| profiles | topology.gates 与 profiles.gates 对齐校验 |
| 规模裁剪矩阵 | step.step_id 对应矩阵中的 Step ID |
| SubAgent 定义 | agents 注册表与 .cursor/agents/*.md 对齐 |
| protocols.md | gate_type (hard/soft) 与 Gate Taxonomy 对齐 |
