# Phase 3.2: 并行判定与批次执行

> 本文件由 `phase-3-execute.md` 3.2 节引用，定义并行资格判定、接口先行、spawn 流程和批次级检查。

## 并行资格判定（按优先级短路，命中即停）

| 优先级 | 条件 | 结果 |
|--------|------|------|
| **P0** | Profile `force_serial: true` | **全部串行**，跳过后续判定 |
| **P1** | `$O next` 输出含 `parallel_groups` 字段 | **直接使用**引擎分组（基于 `owns_globs` 不重叠 + `max_parallel`） |
| **P2** | 无 `parallel_groups` 但 ready tasks 有 `owns_globs` | 按路径不重叠判定：无交集 → 可并行；有交集 → 降格串行或拆批 |
| **P3** | 无 `owns_globs` | **串行**（不做启发式猜测） |

> `parallel_hint: true` 仅作为引擎计算 `parallel_groups` 时的辅助信号（P1），不在编排层独立判定中使用。

**integrator 策略**（叠加于 P1/P2）：若 `state.parallel_strategy == "integrator"`，并行 task 仅产出 patch/分支，必须由后续 task 单点合并；合并出现 Git 冲突 → **HARD_FAIL**（记 `hard:` pending）。

## 执行流程

### Step 1: 串行准备

对所有待执行 task 串行完成 a（RAG）+ b（标记开始）— Shell 命令不可并行。

### Step 1.5: 接口先行（O12）

**触发条件**：本批将并行 spawn ≥2 个 task。串行批整步跳过。

a) **输入**：读取 `$DIR/design-brief.md`（增强编排模式）。文件不存在时：
   - 检查 `$DIR/session.md` 的「关键约束和决策」段是否含设计决策内容（OpenSpec 模式下 Phase 2A 已注入 design.md 摘要）
   - 有内容 → 以该段作为接口判定依据
   - 无内容 → **跳过**（`O12 skip: no design context`）

b) **判定**：设计上下文（`design-brief.md` 或 session.md 关键约束段）是否明示本批并行 task 之间的接口交互依赖（A 消费 B 的包/函数/类型/端点、共享契约、跨 task 模块边界与调用方向等）

c) **否** → 跳过，不在 spawn prompt 中追加契约块

d) **是** → 主 Agent 内联生成接口契约摘要（≤800 字、结构化），禁止臆造设计上下文中未出现的接口

e) **注入**：为本批每一个并行 task 的 spawn prompt 追加 `## 并行批次接口契约（摘要）`

### Step 2: spawn

- 可并行 task：同一消息中发出多个 `[Task]` 调用
- 不可并行的：逐个 a→b→c 串行执行

### Step 2.5: CCC-merge（仅并行批次）

所有并行 SubAgent 返回后、后置检查之前：

a) **文件冲突检测**

b) **CCC-merge 语义冲突检测**（本批 2+ 个并行 task 完成时）：
```
[Task] spawn generalPurpose SubAgent，按 consistency-checker.md CCC-merge 模式
```
- `aligned: true` → 继续
- `aligned: false`（SOFT_FAIL）→ 记 pending.md：`soft: CCC-merge 并行语义冲突`

### Step 2.6: Integrator 批次编译（O3）

**触发条件**：本批 ≥2 个 task 以并行方式执行，且 2.5 已完成。串行批或单 task 不触发。

按本批合并变更文件集判定语言（含 `*.go` → `go vet`；含 `*.ts/*.tsx` → `npx tsc --noEmit`；含 `*.py` → `python3 -m py_compile`；无以上 → 跳过）：

```
[Shell] {与本批合并变更集对应的编译命令}
```

- **PASS**（exit 0）→ 进入 Step 3
- **FAIL**（HARD_FAIL）→ spawn error-fixer，修复后重试 1 次
- **仍 FAIL** → 本批所有 `{tid}` 执行 `$O fail`；pending 记 `hard: Integrator 批次编译（O3）未通过`；回到 3.1

### Step 3: 批次排序与分发

所有并行 SubAgent 返回后：
1. **先全部执行 d-0 产出校验**（快速区分 SUCCESS/FAILED）
2. 按「SUCCESS 优先、FAILED 在后」的顺序逐个执行完整后置检查链（→ `phase-3-post-checks.md`）
3. FAILED task 的 h-1 retry 在本批 SUCCESS task 全部完成后才执行，retry 后回到 3.1
4. 一批全部完成后回到 3.1

## 对每个 task 执行

### a) RAG 注入（所有规模）

```
[Shell] $O inject-rag $DIR "<task描述关键词>"
```

管理台不可用时回退到本地文件搜索（`grep -rl` 历史经验文件）。

### b) Skill 路由 + 标记开始

```
[Shell] PRE_SHA_{tid}=$(git rev-parse HEAD 2>/dev/null || echo "NO_GIT")
[Shell] SKILL=$($O skill-route $DIR {tid}) && echo "Skill: $SKILL"
[Shell] $O start $DIR {tid} {agent_type} ${SKILL:+$SKILL}
```

**b-1) [OBSERVE] task START 状态采集**（`cdp_observe_available=true` 且 `log_status_on_start: true` 且非 remote 时）：
```
[Shell] CallMcpTool("cursor-cdp", "status", {})
```
成功 → 记录到 `$DIR/observability/status.log`；失败 → 断路器 open

> `PRE_SHA` 按 `{tid}` 后缀隔离（如 `PRE_SHA_t1`），避免并行覆盖。

**b-2) 中规模轻量快照**（中规模 + git 仓库 + 串行执行时）：
```
[Shell] git stash push -m "pre-{tid}" --include-untracked 2>/dev/null && echo "stash OK" || echo "INFO: 跳过 stash"
```
- task 成功后 `git stash drop`；task 失败回退时 `git stash pop`
- 并行执行时跳过 stash，回退使用 `git checkout $PRE_SHA_{tid} -- .`

### Agent 选择

若 task 标记 `task-type: test` → spawn `tester.md`；否则使用 `executor.md`。

#### 并行路由策略（全栈项目）

1. **Tag 匹配**：`backend`/`go`/`api` → Scope: Backend；`frontend`/`react`/`ui` → Scope: Frontend
2. **Scope 匹配**：按 task 描述中的 `## Backend Tasks` / `## Frontend Tasks` 分流
3. **并行 spawn**：同层级前后端 task 可并行（通过 Scope 区分）
4. **Review 路由**：统一 `quality-reviewer`，按变更文件扩展名注入领域维度

### c-remote) 远程 task dispatch

当 `task.type == "remote"` 时执行本分支，跳过 c) / c-TDD) 及本地后置检查。

详见 → **`phase-3-remote.md`**

### c) 执行 — spawn SubAgent（local task）

**MUST** 先读取注入源（执行类 → `$DIR/context.md`；审查类 → `$DIR/session.md`），然后按 `references/prompt-templates.md`「开发任务执行」模板构造 prompt。

注入参数：`{tid}`, `{task_name}`, `{task_description}`, `{task_requirement_summary}`, `{requirement_source_ref}`, `{universal_constraints}`, `{domain_constraints_filtered}`, `{predecessor_outputs}`, `{rag_context}`, `{design_context}`, `{language_hints}`

**MCP 策略段落（MUST）**：spawn 前追加「MCP / 工具策略」小节，含允许工具白名单 + Policy（max_calls_per_task / circuit_breaker_n）。

若项目存在 `references/mcp-capabilities.md` 则按其生成白名单；否则按 `references/skill-routing-table.md` 最小注入。

```
[Task] spawn generalPurpose SubAgent，指令：<填充后的模板>
```

### c-TDD) 实现纪律注入（`tdd_mode` ≠ `off` 时）

条件：非 `task-type: test` + 项目有测试基础设施（`go.mod` / `package.json` test script / `pytest.ini`）。

在 executor prompt 的 `{implementation_discipline}` 占位符注入 TDD 精炼摘要。并行 task 额外追加：「TDD 循环中仅 `git add`，不 `commit`」。
