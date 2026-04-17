# Phase 3: 执行循环

> SubAgent 协议（角色路由 / 防失忆 / 错误恢复）→ 完整规则见 `references/protocols.md`。
> spawn 前 MUST 按角色类型选择注入源：执行类读 `$DIR/context.md`，审查类读 `$DIR/session.md`（详见 `references/context-engineering.md`「注入源分层」）。角色文件在 `.cursor/agents/*.md`，prompt 首行 `按 .cursor/agents/{role}.md 执行`。

## 状态机（严格按此流转，不得跳步）

```
          ┌──────────────────────────────┐
          ▼                              │
  ┌──── 3.1 $O next ────┐               │
  │                      │               │
  ▼ READY                ▼ WAITING       │
 3.2 并行资格判定     过期清理           │
  │                   → 回 3.1           │
  ├─ 可并行 ──→ 并行 spawn c ─┐         │
  └─ 串行 ──→ 逐个 a→b→c ──┐  │         │
                             ▼  ▼         │
                3.3 逐个后置检查 d-0→d-0.5→O9→d-1→O10→d-2~j ────┘
                             │
                             ▼ ALL_DONE
                           Phase 4
```

## 3.1 查询可执行 task

```
[Shell] $O next $DIR
```

解析 JSON 输出的 `status` 字段：
- `"READY"` → 取 `tasks` 数组，进入 3.2
- `"ALL_DONE"` → 执行前置校验 `$O validate $DIR`（确认 state 数据完整性），通过后进入 Phase 4
- `"WAITING"` → 存在 RUNNING task（通常是恢复中断 session 时遗留的）。检查每个 RUNNING task 的 `started_at`，若距当前时间超过 `config.timeout_minutes`（默认 10 分钟），标记 FAILED（原因 "timeout: started_at 已过期"）。标记后重新执行 3.1。若未过期且非当前批次并行启动的 task，标记 FAILED（原因 "orphaned: 非当前 Agent 管理的遗留 RUNNING task"），重新执行 3.1

## 3.2 执行 ready task

**批处理规则**：`$O next` 返回多个 READY task 时，按以下流程决定并行或串行。

**Step 1 — 并行资格判定**：
- **强制串行**：Profile `force_serial: true` → 全部串行

**引擎计算优先**：`$O next` 输出中包含 `parallel_groups` 字段（如 `[["t1","t2"],["t3"]]`），引擎根据 `owns_globs` 不重叠 + `max_parallel` 上限自动分组。**有 `parallel_groups` 时直接使用，不再做下方启发式判定**。

**回退判定（无 `parallel_groups` 时）**：
1. **Planner owns_globs**（优先）：若 ready tasks 中有 task 提供了 `owns_globs`，按路径不重叠判定并行资格。不同 task 的 `owns_globs` 无交集 → 可并行；有交集 → 降格串行或拆批。
2. **启发式**：无 `owns_globs` 时，按原有规则判定：彼此不在 `depends_on` 中 + tier/模块分析 + `description` 指向不同模块 + 数量 ≤ `config.max_parallel`（默认 3）。
3. **parallel_hint**（辅助）：planner 标记 `parallel_hint: true` 的 task 增加并行权重，但不作为最终判断的唯一依据。

- **integrator 策略**（叠加于上）：若 `state.parallel_strategy`（或 `PIPELINE_PARALLEL_STRATEGY=integrator`）为 integrator，并行 task 仅产出 patch/分支，**必须由指定后续 task 单点合并**；合并出现 **Git 冲突 → HARD_FAIL**（记 `pending` 前缀 `hard:`，走 error-fixer / interactive）。
- 其余串行

**Step 2 — 执行**：
1. 对所有待执行 task 串行完成 a（RAG）+ b（标记开始）— Shell 命令不可并行
1.5. **接口先行（O12）**（仅当本批 **将并行 spawn ≥2 个 task** 时评估；若本批为串行——仅 1 个 READY task 或 Step 1 判定为逐个 a→b→c——**整步跳过**，不读 `design-brief.md`、不阻塞）：

a) **输入**：读取 **`$DIR/design-brief.md`**。文件不存在或正文无可判定段落 → **跳过**本步（可在本轮说明中写一句 `O12 skip: no design-brief`）。

b) **判定**：在增强编排下 **`$DIR/design-brief.md` 为 mandatory design baseline**（与下文 **3-e CCC-2**「对照基准（按编排模式分流）」增强编排分支一致；**不得**仅用 task 文案替代 brief 做本判定）。判断 brief 是否**明示或结构化等价地描述**本批**并行** task 之间（非仅与外部系统）的**接口交互依赖**，例如：A 消费 B 将产出的包/函数/类型/端点、共享的公共契约、跨 task 的模块边界与调用方向等（与 planner `design_brief` 常见块：接口签名、模块交互、数据模型、技术决策——中对齐）。

c) **否**（无此类跨并行 task 依赖）→ **跳过**，不在 3-c prompt 中追加契约块。

d) **是** → 主 Agent **内联**生成 **接口契约摘要**（建议 ≤800 字、结构化）：本批各 `{tid}` 的生产者/消费者关系、须先稳定的签名或类型名、兼容约束；**禁止臆造** brief 中未出现的接口或文件名（缺失信息时写「brief 未展开」而非编造）。

e) **注入**：为本批**每一个**并行 task 构造 **3-c**「开发任务执行」模板时，追加固定小节标题 **`## 并行批次接口契约（摘要）`**，填入上一步摘要（可全批共用同一段落，或按 task 裁剪但须保留与本 task 相关的跨边界信息，避免割裂导致实现漂移）。

> **OpenSpec 模式**：若以 `design.md` 为主且无 `design-brief.md`，按 (a) 视为缺失 → **跳过** O12；**不**将 OpenSpec 制品在此步强行替代为 mandatory 输入（与 P0「OpenSpec 模式不将 design-brief.md 提升为 mandatory baseline」的分流一致，本步仅在有该文件时启用）。

2. 可并行 task 的 c（spawn）在同一消息中发出多个 `[Task]` 调用；不可并行的逐个 a→b→c
2.5. **并行合并语义检查（CCC-merge）**（仅并行批次触发）：

所有并行 SubAgent 返回后、**逐个后置检查（3.3）之前**，执行以下检查：

a) **文件冲突检测**（已有步骤，不变）

b) **CCC-merge — 语义冲突检测**（新增）：
若本批 2+ 个并行 task 完成，按 `references/prompt-templates.md`「CCC-merge」模板 spawn：
```
[Task] spawn generalPurpose SubAgent，指令：<填充后的 CCC-merge 模板，角色引用 consistency-checker.md CCC-merge 模式>
```
- `aligned: true` → 继续
- `aligned: false`（**SOFT_FAIL**）→ 记 pending.md：决策点 `soft: CCC-merge 并行语义冲突`、自动选择「继续执行」、风险「{issues 摘要}」

2.6. **Integrator 批次编译（O3）**（**仅**本批 **≥2 个 task 以并行方式执行**且各 SubAgent 已返回、并完成 **2.5**（含 CCC-merge 的 spawn/判定与 pending 落盘）之后；**串行批**或单 task **不触发**，整步跳过）：

在**进入步骤 3「先全部执行 d-0」之前**，主 Agent **内联**执行**一次**批次级确定性编译检查（与 **d-1** 同一命令规则：按本批**合并变更文件集**判定语言——将本批各 `{tid}` 相对其 `PRE_SHA_{tid}` 的变更路径取并集、去重后，含 `*.go` → `go vet` 覆盖涉及包；含 `*.ts/*.tsx` → `npx tsc --noEmit`（需 tsconfig）；含 `*.py` → `python3 -m py_compile` 各文件；无以上类型 → 跳过本步）。

```
[Shell] {与本批合并变更集对应的编译命令，规则同 d-1}
```

- **PASS**（exit 0）→ 可选：`$O test-gate $DIR compile` 写入摘要（`shell_exit_code:0` 证据规则同 d-1）→ **进入步骤 3**
- **FAIL**（**HARD_FAIL**）→ 按 `references/prompt-templates.md` 错误修复模板 spawn **error-fixer**（`.cursor/agents/error-fixer.md`），上下文含编译输出与本批合并变更文件列表；修复后主 Agent **再次内联**同批次编译命令，**至少重试 1 次**
- **仍 FAIL** → 对本批**每一个**并行 `{tid}` 执行步骤 **h** 的 `$O fail $DIR {tid} "integrator batch compile failed after O3 retry"`；pending 记 **`hard: Integrator 批次编译（O3）未通过`**；**不再**执行步骤 3 中本批的 d-0~i，回到 **3.1**

3. 所有并行 SubAgent 返回后，**先全部执行 d-0 产出校验**（快速区分 SUCCESS/FAILED），然后按「SUCCESS 优先、FAILED 在后」的顺序逐个串行执行完整 d~i。原因：SUCCESS 的 task 后置检查不应被 FAILED task 的 retry 流程阻塞；FAILED task 的 h-1 retry 在本批 SUCCESS task 全部完成后才执行，retry 后回到 3.1 正常排队
4. 一批全部完（含后置检查）后回到 3.1

**对每个 task 执行**：

**a) RAG 注入**（所有规模）
```
[Shell] $O inject-rag $DIR "<task描述关键词>"
```

管理台不可用时，回退到**本地文件搜索**：
```
[Shell] grep -rl "<关键词>" /opt/pipeline-orchestrator/sessions/*/session-analysis.md /opt/pipeline-orchestrator/sessions/*/lessons.md 2>/dev/null | head -3 | xargs -I{} head -20 {} 2>/dev/null || echo "INFO: 无本地历史经验"
```
将匹配内容作为 `[RAG_CONTEXT]` 注入。两种来源取并集（管理台可用时优先用管理台，本地结果作为补充）。

**b) Skill 路由 + 标记开始**

通过 `$O skill-route` 确定 task 的 **skill**（YAML 解析由引擎完成，编排层不直接解析配置文件）：

```
[Shell] PRE_SHA_{tid}=$(git rev-parse HEAD 2>/dev/null || echo "NO_GIT")
[Shell] SKILL=$($O skill-route $DIR {tid}) && echo "Skill: $SKILL"
[Shell] $O start $DIR {tid} {agent_type} ${SKILL:+$SKILL}
```

> **并行注意**：`PRE_SHA` 按 `{tid}` 后缀隔离（如 `PRE_SHA_t1`），避免并行 task 覆盖彼此基线。后续 d-0 引用时使用对应的 `PRE_SHA_{tid}`。

路由优先级（由 `$O skill-route` 内部实现，完整说明见 `references/skill-routing-table.md`）：
1. `state.json` 中该 task 已有非空 `skill`（恢复 session）→ 直接返回
2. `.pipeline-orchestrator.yaml` 的 `skill_routes` 有序列表首条命中
3. `custom_routes` 关键词匹配
4. 内置 `skill-routing-table.md` 关键词表
5. 无匹配 → 返回空，使用通用 prompt

**b-2) 中规模轻量快照**（中规模 + git 仓库中 + **串行执行时**）

> **并行时不 stash**：`git stash` 是全局栈，并行 task 同时 push/pop 会导致串扰。并行场景下改用 `$O snapshot`（git tag）或依赖 `PRE_SHA_{tid}` 做 `git checkout` 回退。

串行 task 开始前保存轻量快照，用于 task 失败时回退：
```
[Shell] git stash push -m "pre-{tid}" --include-untracked 2>/dev/null && echo "stash OK" || echo "INFO: 非 git 仓库或无变更，跳过 stash"
```

- task 成功完成后：`git stash drop` 清理（如有）
- task 失败需回退时：`git stash pop` 恢复
- 大规模使用 `$O snapshot`（git tag），不使用 stash
- 并行执行时：跳过 stash，回退使用 `git checkout $PRE_SHA_{tid} -- .`（配合 d-0 记录的基线）

详见 `references/snapshot-ops.md`「中规模 stash 策略」。

**Step 3a — 选择 Agent**

若当前 task 标记 **`task-type: test`**（见 `references/skill-routing-table.md`「task-type」），须 spawn **`tester.md`**；否则实现类 task 使用 **`executor.md`**（以下并行路由中的 Scope 仍仅作用于 executor）。

### 并行路由策略（全栈项目适用）

当 YAML topology 或 session config 中定义了并行 Agent 时：

1. **Tag 匹配**：检查 task 的 `tags` 属性
   - 包含 `backend`/`go`/`api`/`server` → 路由到 `executor`，prompt 注入 `## Scope: Backend`
   - 包含 `frontend`/`react`/`ui`/`web` → 路由到 `executor`，prompt 注入 `## Scope: Frontend`
   - 无明确标签 → 使用通用 `executor`（无 Scope 注入）

2. **Scope 匹配**（备选）：检查 task 描述
   - 匹配 `## Backend Tasks` → executor + Scope: Backend
   - 匹配 `## Frontend Tasks` → executor + Scope: Frontend

3. **并行 spawn**：同一层级的前后端 task 可以并行 spawn（同一 executor 角色，通过 Scope 区分）

4. **Review 路由**：统一使用 `quality-reviewer`，编排层按变更文件扩展名注入领域专项维度

**c) 执行 — spawn SubAgent**

**MUST** 先读取 `$DIR/context.md`（执行类 SubAgent）或 `$DIR/session.md`（审查类 SubAgent）提取最新上下文（选择依据见 `references/context-engineering.md`「注入源分层」），然后按 `references/prompt-templates.md`「开发任务执行」模板构造 prompt，填入以下参数：

若项目存在 **`references/mcp-capabilities.md`**，按其中登记仅为**本 task 类型相关**的 MCP 工具生成白名单段落注入 prompt；不存在该文件则仍按 `references/skill-routing-table.md` 扫描 `mcps/` 描述符，按需注入、禁止无关 MCP。

**MCP 策略段落（MUST 出现在 SubAgent 指令中）**：在 spawn 前追加固定小节 **「MCP / 工具策略」**：(1) 本 task 允许的工具名列表（来自上段白名单）；(2) 若登记表含 Policy 列，写出 **max_calls_per_task** 与 **circuit_breaker_n**；(3) 熔断打开后仅只读/停止非只读调用（语义见 `references/protocols.md`「工具与 MCP 熔断」）。无登记文件时写一句：**未登记 MCP Policy，按 skill-routing 最小注入，自觉限制调用次数**。

| 参数 | 来源 |
|------|------|
| `{tid}`, `{task_name}`, `{task_description}` | state.json 当前 task |
| `{task_requirement_summary}` | 执行类：从 context.md 需求摘要提取；审查类：从 session.md 完整需求按 task 相关度摘要，≤800 字符 |
| `{requirement_source_ref}` | `完整用户原始需求见 $DIR/session.md「## 用户原始需求」`（始终指向 session.md） |
| `{universal_constraints}` | context.md / session.md 通用约束，始终完整注入 |
| `{domain_constraints_filtered}` | context.md / session.md 领域约束，按 task 相关度过滤 |
| `{predecessor_outputs}` | context.md / session.md 当前阶段详情中 depends_on 相关摘要 |
| `{rag_context}` | context.md / session.md 历史经验中相关条目 |
| `{design_context}` | OpenSpec 模式：contextFiles 摘要；否则跳过 |
| `{language_hints}` | 根据变更文件类型注入语言特定约束（见 protocols.md） |

注入预算和裁剪规则见 `references/context-engineering.md`。

```
[Task] spawn generalPurpose SubAgent，指令：<填充后的模板>
```

**d) 测试门**（task 仍为 RUNNING 状态）

门控类型见 **`references/protocols.md`「Gate Taxonomy」**：编译/单测等工具非 0 为 **HARD_FAIL**；CCC/质量门 B 为 **SOFT_FAIL**。**O9 依赖安装**失败为 **SOFT_FAIL**（记 `pending.md`，前缀 `soft:`，**不阻塞**进入 **d-1**，与表中 SOFT_FAIL「记 pending、auto 模式继续」一致）。**O10 Lint** 工具 exit 非 0 为 **HARD_FAIL**（与编译门同属**确定性**工具失败语义，走 error-fixer + 内联重试；仍失败 → `fail` / `hard:` pending，与表一致）。

SubAgent 返回后，检查其输出中是否包含 `## 执行结果: FAILED` 或明确报告未完成任务 → 是则跳过后续检查，直接到步骤 h 标记 FAILED（视为 **HARD_FAIL** 路径，因执行契约未满足）。

SubAgent 成功完成后，按层级执行测试（先探测再执行）：

**d-0) 产出校验**（所有规模，主 Agent 内联执行）

SubAgent 返回 `## 执行结果: SUCCESS` 后，校验实际变更（对比步骤 b 记录的 `PRE_SHA_{tid}` 基线）：

```
[Shell] _SHA=$PRE_SHA_{tid}; if [ "$_SHA" = "NO_GIT" ]; then echo "SKIP: 非 git 仓库"; else CHANGED=$({ git diff --name-only "$_SHA" HEAD 2>/dev/null; git diff --name-only 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u); echo "$CHANGED"; fi
```

- `PRE_SHA_{tid}=NO_GIT` → 跳过 d-0 校验，继续 **d-0.5**（无 CHANGED 列表时 O9 按「无 CHANGED 列表」条处理）
- CHANGED 为空（未修改/新增任何文件）→ **HARD_FAIL**，原因 "executor 声称 SUCCESS 但无实际文件变更"
- CHANGED 包含明显与 task 无关的文件（如修改了 session.md 或编排层文件）→ 记 pending（soft: 产出范围可能超出 task 描述），继续 **d-0.5**
- 其他 → 通过，继续 **d-0.5**

**d-0.5) 验收标准验证**（所有规模，**主 Agent 内联执行**）

从 `state.json` 中提取当前 task 的 `description` 字段，解析其中 `验收标准:` 后的内容。主 Agent **逐条对照** executor 输出和实际变更文件，判断每条验收标准是否已满足：

1. **提取验收标准**：正则匹配 `验收标准:` 或 `验收标准：` 之后的文本，按行或分号拆为条目列表
2. **逐条判定**：对每条标准，检查 executor 输出中是否有对应的实现证据（变更文件、新增接口、行为描述）
3. **产出 JSON**：`{"items": [{"criterion": "...", "met": true/false, "evidence": "..."}], "all_met": true/false}`

- `all_met: true` → 通过，继续 **O9**
- `all_met: false` 且未满足条目数 ≤ 2 → **SOFT_FAIL**：记 pending.md（`soft: 验收标准 {tid} 部分未满足: {未满足条目摘要}`），继续 **O9**（不阻塞，因 executor 可能已实现但未在输出中明确提及）
- `all_met: false` 且未满足条目数 > 2 → **HARD_FAIL**：大面积未满足视为 executor 执行不完整，跳到步骤 **h** 标记 FAILED（error 为 `"验收标准大面积未满足: {条目摘要}"`）
- 无法解析验收标准（task description 不含 `验收标准:` 关键词）→ 跳过本步，记 INFO

> **设计考量**：验收标准由 planner 在 Phase 1d 写入 task description，是 task 的核心契约。d-0 检查"有没有做事"，d-0.5 检查"做的对不对"，d-1+ 检查"做的好不好"。

**O9) 依赖探测**（所有规模，**主 Agent 内联执行**，**位于 d-1 之前**）

在 **d-1 编译检查**之前，按**项目元数据**探测并安装依赖；**无对应元数据**的栈 **SKIP**。探测：以本 task **各变更文件路径**为锚，自其所在目录**向上**直至仓库根，**枚举路径上每个目录**；对**每个目录**分别判定是否含 `go.mod` / `package.json` / `requirements.txt`，命中则按上表将对应命令加入待执行队列（**同一目录、同一元数据类型只执行一次**；多变更文件共享目录时去重）。若队列最终为空（无任何可执行命令）→ **SKIP** 本步。

| 元数据 | 命令（MUST 在对应目录执行） |
|--------|---------------------------|
| `go.mod` | `go mod tidy` |
| `package.json` | 同目录存在 `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`；否则存在 `yarn.lock` → `yarn install --frozen-lockfile`（或项目文档约定的等价冻结安装）；否则存在 `package-lock.json` 或 `npm-shrinkwrap.json` → `npm ci`；**仅** `package.json` 而无上述 lock 文件 → **SKIP+INFO**（不写为失败） |
| `requirements.txt` | `pip install -r requirements.txt`（推荐 `python3 -m pip install -r requirements.txt` 以固定解释器） |

- **无 CHANGED 列表**（如 **d-0** 因 `NO_GIT` 跳过且无文件清单）→ **O9** 仅对 **当前工作目录**（通常为 clone 根）扫描上表三种元数据；无命中 → **SKIP**
- **PASS**（各已执行命令 exit 0，或本步无命令需执行）→ 继续 **d-1**
- **FAIL**（任一已执行命令 exit 非 0）→ **SOFT_FAIL**：记 `pending.md`（决策点 `soft: 依赖探测 O9 {tid} 安装失败`、自动选择「继续执行」、风险「{命令与摘要}」），**仍继续** **d-1**（不因此 `fail` task）

**d-1) 编译检查**（所有规模，**主 Agent 内联执行**）：

主 Agent 根据 **变更文件的语言**（非全项目）直接执行对应检查命令：
- 变更含 `*.go` → `go vet ./变更文件所在包/...`
- 变更含 `*.ts/*.tsx` → `npx tsc --noEmit`（需 tsconfig.json 存在）
- 变更含 `*.py` → `python3 -m py_compile {各变更py文件}`
- 变更无以上类型 → 跳过编译检查

**顺序（MUST）**：**先**执行编译类 Shell，**仅当 exit 0** 后**立即**调用 `test-gate` 写 `passed: true`；失败时 exit 非 0 则 `passed: false`，并在 `session.md` 或本轮说明中引用 `logs/` 下已有记录。

```
[Shell] {对应编译命令}
[Shell] $O test-gate $DIR compile '{"passed": true, "shell_exit_code": 0, "output": "..."}'
```

（未设 `PIPELINE_STRICT_TEST_EVIDENCE=1` 时仍可使用历史形式 `{"passed":true/false,"output":"..."}`；开启严格模式时 `passed:true` **必须**含 `shell_exit_code:0`。）

FAIL（**HARD_FAIL**）→ spawn SubAgent 修复（按 `.cursor/agents/error-fixer.md` 角色定义 + `references/prompt-templates.md` 错误修复模板），修复后主 Agent 再次内联执行编译命令重试 1 次。仍 FAIL → 步骤 h 标记 FAILED；pending 记 `hard:`。

**O10) Lint**（所有规模，**主 Agent 内联执行**，**仅当 d-1 已通过或跳过**之后）

主 Agent 根据 **变更文件类型** 选择静态分析工具（与 **d-1** 语言判定一致；变更无 `*.go` / `*.ts` / `*.tsx` / `*.js` / `*.jsx` / `*.py` → **SKIP** 本步）。**工具或项目侧配置缺失** → **SKIP+INFO**（不写为失败、不 spawn error-fixer）。

| 变更触达 | 条件 | 命令（示例） |
|----------|------|----------------|
| `*.go` | 可执行 `golangci-lint`，且存在 `.golangci.yml` / `.golangci.yaml` / `golangci.yml`（于模块根或仓库根） | `golangci-lint run`（默认仓库根；monorepo 时限于含 `go.mod` 的模块目录） |
| `*.ts` / `*.tsx` / `*.js` / `*.jsx` | 存在 ESLint 配置（如 `.eslintrc.*`、`eslint.config.*`，或 `package.json` 内 `eslintConfig`），且 `npx eslint` 可用 | `npx eslint ...`（范围限于变更文件或项目既有 lint 脚本所定范围） |
| `*.py` | 存在 `ruff.toml` 或 `pyproject.toml` 中 `[tool.ruff]`，且 `ruff` 或 `python3 -m ruff` 可用 | `ruff check`（范围限于变更文件或目录） |

- **SKIP**（无对应类型 / 无配置 / 无可用 CLI）→ 在 session 或本轮说明中 **INFO** 一条（如 `O10 skip: no eslint config`），继续 **d-2** 或后续
- **PASS**（exit 0）→ 继续 **d-2**（或后续步骤）
- **FAIL**（exit 非 0）→ **HARD_FAIL**（语义同 **`references/protocols.md`「Gate Taxonomy」** 中确定性工具失败）→ 按 `references/prompt-templates.md` 错误修复模板 spawn **error-fixer**（`.cursor/agents/error-fixer.md`），上下文含 lint 输出与变更文件列表；修复后主 Agent **再次内联**同 lint 命令，**至少重试 1 次**。仍 FAIL → 步骤 h 标记 FAILED；pending 记 **`hard:`**（如 `hard: Lint O10 {tid} 未通过`）

**d-2) 单元测试**（所有规模，有测试框架时执行）：

先探测项目是否有可运行的测试框架：
- `go.mod` 存在 → `go test ./变更包/... -count=1 -timeout=60s`
- `package.json` 中有 `test` script → `npm test -- --passWithNoTests`
- `pytest.ini` / `pyproject.toml[tool.pytest]` 存在 → `python3 -m pytest {变更目录} -q --timeout=60`
- 无测试框架 → 跳过，不阻塞

**顺序（MUST）**：**先**执行单测 Shell，**仅当 exit 0** 后再 `test-gate` 写 `passed: true`（同 d-1 证据规则）。

```
[Shell] {对应单测命令}
[Shell] $O test-gate $DIR unit '{"passed": true, "shell_exit_code": 0, "output": "..."}'
```

FAIL（**HARD_FAIL**）→ spawn SubAgent 修复（按 `.cursor/agents/error-fixer.md`），重试 1 次。仍 FAIL → 步骤 h 标记 FAILED；pending 记 `hard:`。

**d-3) 增量回归测试**（大规模执行，当前 task 非首个 COMPLETED task 时）

确保当前 task 的变更未破坏前序 task 的产出。仅在**已有 ≥1 个 COMPLETED task 且当前 task 编译通过**时执行。

回归范围：基于当前 task 变更文件的 import graph，推导可能受影响的前序 task 测试文件。

```
[Shell] {根据语言执行对应全量或受影响范围的测试命令}
[Shell] $O test-gate $DIR regression '{"passed": true/false, "shell_exit_code": N, "scope": "affected", "output": "..."}'
```

- Go: `go test ./... -count=1 -timeout=120s`（全量但快速）
- TS: `npm test -- --passWithNoTests`（依赖项目 test 配置）
- Python: `python3 -m pytest -q --timeout=120`（全量）
- 无测试框架 → 跳过，不阻塞

FAIL（**SOFT_FAIL**）→ 记 pending.md：决策点 `soft: 回归测试 {tid} 影响前序 task`、自动选择「继续执行」、风险「{失败摘要}」。回归测试为 SOFT_FAIL 而非 HARD_FAIL，因为回归可能由外部因素导致（环境差异等）。

**e) CCC-2 上下文一致性校验**（中/大规模执行，task 仍为 RUNNING）

**对照基准（按编排模式分流）**：
- **增强编排模式**（Phase 1d 解析 `design_brief` 后，Phase 2 落盘至 `$DIR/design-brief.md` 的会话）：**`$DIR/design-brief.md` 为本步骤的 mandatory design baseline（设计侧真相源）**。CCC-2 SHALL 将实现与此文件对齐，**不得**仅以 task 文案替代设计对照；相对 task 描述，**与实现一致性判定的主基准为该文件**。填充 `references/prompt-templates.md`「内联 CCC-2」之 `{design_or_constraints}` 或下方 spawn 模板之**对照基准**时，**必须以 `$DIR/design-brief.md` 为首要对照**（可读入摘要/指针，但不得跳过；文件缺失时按模板 sentinel 降级，并仍可辅以 `session.md` 关键约束）。与 prompt-templates 中 CCC-2 模板为**补充关系**：模板结构不变，编排层注入/指明的对照内容在增强编排下 **SHALL** 显式锚定该文件。
- **OpenSpec 模式**（以 OpenSpec `design.md` 等制品为主导时）：保持以 **`design.md` / `session.md` 关键约束** 为主对照基准（与 `.cursor/agents/consistency-checker.md` CCC-2 约定一致）；**不**将 `design-brief.md` 提升为 mandatory baseline（该文件可能不存在或非主路径）。

按变更规模分两路径（**文件数阈值：5** — 以本 task 实际变更文件数计数）：

**小型 task（变更文件 ≤ 5 个）— 主 Agent 内联自检**：
主 Agent 按 `references/prompt-templates.md` 中「内联 CCC-2」模板，依上列**对照基准分流**读取关键约束（增强编排：**`$DIR/design-brief.md` 为主** + 必要时的 `session.md`；OpenSpec：**`design.md` / `session.md`**）；**对比 task 描述与实际变更文件列表，确认无 scope 偏离**；对变更文件逐一检查，产出与 SubAgent 版相同结构的 JSON。
```
[Shell] $O consistency-check $DIR task {tid} '<CCC JSON>'
```

**大型 task（变更文件 > 5 个）或无法判定变更数量 — spawn SubAgent**：

按 `references/prompt-templates.md`「CCC 上下文一致性校验」模板，填入 `{files}` 和**对照基准**后 spawn（对照基准的选取 **MUST** 遵守本节段首「对照基准（按编排模式分流）」；增强编排下 **SHALL** 以 `$DIR/design-brief.md` 为 mandatory design baseline 注入或指针化引用）：
```
[Task] spawn generalPurpose SubAgent，指令：<填充后的 CCC 模板，角色引用 consistency-checker.md CCC-2 模式>
```
```
[Shell] $O consistency-check $DIR task {tid} '<CCC JSON>'
```

偏离（**SOFT_FAIL**）→ 记 pending.md：决策点 `soft: CCC-2 {tid} 偏离设计`、自动选择「继续执行」、风险「{偏离摘要}」，不阻塞后续。

**f) 质量门 B — task 质检**（大规模执行。task 仍为 RUNNING）

**轻重量路由**：编排层根据变更文件数量内联判定（不依赖引擎字段）：
- 变更文件数 ≤ 3 → **主 Agent 内联执行** checklist 自检（按 `references/quality-checklist.md` 逐条检查，直接输出 JSON），**不 spawn SubAgent**
- 变更文件数 > 3 → 走下方 SubAgent 审查流程

按 `references/prompt-templates.md`「质量门 B」模板，填入 `{files}` 后 spawn：
```
[Task] spawn generalPurpose SubAgent，指令：<填充后的质量门 B 模板，角色引用 quality-reviewer.md>
```

**FAIL 时（`summary` 为 FAIL；内联 checklist 与 SubAgent 审查两条路径汇合）**：

1. **落盘 FAIL 条目**：编排层 **MUST** 从本轮质量门 B 输出 JSON 提取 `items` 中 `result=FAIL` 的条目，写入 **`$DIR/review-feedback-{tid}.md`**（**task 级**门 B 专用；与 Phase **4b** 全局门 C 的 **`$DIR/review-feedback-phase4.md`** 路径区分，避免互相覆盖）。文件正文 **SHALL** 包含固定小节标题 **`## Review 反馈`**，其下承载 FAIL 条目（含各条目的 `id`/`evidence`；可直接落 JSON 子集或等价结构化 Markdown），以便 executor 与人工可追溯。**不得**在未落盘的情况下直接进入 error-fixer。

2. **优先 re-spawn 原 executor**（同一 `{tid}`、同一 task 描述与 Scope 注入）：按 `references/prompt-templates.md`「开发任务执行」模板再次 `[Task] spawn generalPurpose SubAgent`（`.cursor/agents/executor.md`）。指令 **必须** 包含固定小节标题 **`## Review 反馈`**（与 Phase 4b 同形）：要求读取 **`$DIR/review-feedback-{tid}.md`**，按其中 FAIL 条目做最小化修复；其余契约与本轮首次 **3-c** 执行一致。

3. **Delta 重检**：针对 **步骤 1 写入 `review-feedback-{tid}.md` 的 FAIL 条目**，分流与既有 quality-reviewer **Delta 重检**语义一致（并与 Phase **4b**「Delta 重检」对齐）。**若步骤 2 的 executor 输出可解析为 `## 执行结果: SUCCESS`**，则执行：
   - **FAIL 项数 ≤ 3**：主 Agent **内联**执行 delta 重检（读取该 FAIL 清单，逐条对照对应文件/变更是否已修复），**不 spawn** SubAgent。
   - **FAIL 项数 > 3**：按 `.cursor/agents/quality-reviewer.md` 的 **Delta 重检模式** spawn quality-reviewer SubAgent（prompt 注入 `## 模式: Delta 重检` + 上述 FAIL 条目的 `id` 列表），仅重检这些条目。

   **若步骤 2 的 executor 非 SUCCESS 或无法解析**：**跳过**上述 Delta 成功路径，**视同 Delta 仍 FAIL**，直接进入步骤 5。

4. **Delta 通过**（无 FAIL 剩余 / `summary` PASS）→ 继续 **g)**（若大规模）或 **h)**。

5. **Delta 仍 FAIL**（**SOFT_FAIL**）→ **兜底**：spawn generalPurpose SubAgent（`.cursor/agents/error-fixer.md`），修复清单优先取 **Delta 输出**中仍 `result=FAIL` 的条目；若步骤 3 未产生可用 Delta 产物，则取 **`review-feedback-{tid}.md`** 中的首轮 FAIL 条目。修复后 **完整重执行** 本小节质量门 B（自「按质量门 B 模板 spawn」或内联 checklist 判定起，**最多 1 轮**；与 Phase **4b** error-fixer 后「完整重执行」轮次上限一致）。仍 FAIL → 记 pending.md：决策点 `soft: 质量门B {tid} 未通过`、自动选择「继续执行」、风险「{问题摘要}」，**不再循环**。

**g) 快照**（大规模执行）
```
[Shell] $O snapshot $DIR {tid}
```

**h) 标记最终状态**

所有前置检查通过（或跳过的检查无阻塞性问题）：
```
[Shell] echo "# {tid}: {name}
- 变更文件: {files}
- 产出摘要: {summary}
- 新增接口: {apis}" | $O done $DIR {tid}
```

h-done 后，清理中规模 stash（如有）：
```
[Shell] git stash list | grep "pre-{tid}" | head -1 | cut -d: -f1 | xargs git stash drop 2>/dev/null || true
```

SubAgent 执行失败 或 测试门最终未通过：
```
[Shell] echo "# {tid}: {name}
- 错误: {detail}" | $O fail $DIR {tid} "{error_one_line}"
```

**h-1) 错误恢复重试**（`$O fail` 输出的 corrections < 2 时执行）

spawn error-fixer SubAgent 修复后，**先内联编译检查**确认修复有效：
```
[Shell] {根据变更文件语言执行对应编译命令，同 d-1}
```
- 编译通过 → 将 task 重置为 PENDING 并重新执行
- 编译不通过 → 直接进入 h-2（避免无意义重试循环）

编译通过后重置：
```
[Shell] $O retry $DIR {tid}
```
然后回到 3.1（`$O next` 会重新将该 task 列为 READY）。

**重试次数上限**：由 `.pipeline-orchestrator.yaml` 的 `max_task_retries` 配置（默认 **1**，取值范围 1~3）。`corrections < max_task_retries` 时可重试；`corrections >= max_task_retries` 时 `$O retry` 会输出 WARN，应放弃重试进入 h-2。个人不计成本使用时建议设为 2~3。

**h-2) 连续失败检查**

标记 FAILED 后，检查当前 session 中最近连续 FAILED task 数量（不含 SKIPPED）：
- 连续 ≥ 2 个 FAILED → **MUST 暂停**（不论 gate_mode）：
  > 「连续 {N} 个 task 失败，建议回滚到最后成功的 task ({last_success_tid})。
  > - 回滚 → 执行 `$O rollback $DIR {last_success_tid}`
  > - 继续 → 忽略并执行后续 task
  > - 终止 → 结束编排」
- 连续 < 2 → 继续后续 task

**i) 更新上下文**（MUST 执行 — 无论 task 最终为 COMPLETED 或 FAILED，均需更新。h-1 retry 回到 3.1 时**跳过**本步，因 task 将重新执行）

按 `references/context-engineering.md`「O18：task 完成后增量丰富」，COMPLETED 时 `{summary}` 应包含：(1) 变更文件列表，(2) 接口变更摘要（新增/变更的导出符号）。从 SubAgent 输出或 `git diff` 提取，禁止贴大段实现代码。FAILED 时记录失败原因摘要。

```
[Shell] $O update-session $DIR "当前阶段详情" "{tid}: {summary}（含变更文件列表 + 接口变更摘要）"
```

**j) 计划偏离检测与自适应调整**（中/大规模，task COMPLETED 时执行）

task 完成后，主 Agent 检查 executor 输出中是否包含以下信号之一：
1. **发现信号**：executor 输出包含"发现"/"注意"/"需要额外"/"建议增加"等暗示后续 task 可能需要调整的关键词
2. **接口偏离**：executor 新增了非 task 描述中预定的接口（对比 task description 与实际新增导出）
3. **依赖变更**：executor 修改了 task 未声明 `owns_globs` 范围外的文件（与 d-0 的 pending 记录交叉验证）

**任一信号命中时**（非必停，主 Agent 内联评估）：

主 Agent 读取 `$DIR/state.json` 中后续 PENDING task 的 `description`，**快速评估**：当前 task 的实际产出是否导致后续某个 task 的前置假设失效。

- **无影响**（多数情况）→ 记一条 INFO 日志，继续
- **有影响但可内联修正** → 主 Agent 直接通过 `$O update-session` 在"关键约束和决策"中追加发现（如"`{tid}` 实际产出与计划偏离：新增了 `xxx` 表字段，后续 `{next_tid}` 需适配"），后续 task 的 executor 通过 context.md 获取此约束
- **影响面大（后续 2+ 个 task 的前置假设失效）** → 暂停并向用户展示：
  > 「`{tid}` 执行中发现计划偏离：{偏离描述}。后续 task 受影响：{受影响 task 列表}。
  > - 继续（我会在后续 task 的上下文中注入偏离信息）
  > - 调整计划（回到 Phase 1d 重新拆解后续 task）
  > - 终止」

> **设计考量**：不引入重量级"重规划"机制（避免过度工程化），而是利用已有的 session.md 上下文注入链路，将执行中的发现**增量传递**给后续 task。仅在大面积偏离时暂停人工决策。

## 3.3 Context Reset 检查 + 回到 3.1

每批 task 后置检查全部完成后，检查 `context_usage`（当前会话中已执行的 Shell + Task 调用总数）：

- `context_usage ≥ 15` → 确保当前批次所有持久化已完成（state.json、session.md、context.md、pending.md），然后向用户输出：
  > 「当前编排进度：{completed}/{total}。context 使用量较高（{context_usage} 次调用），建议在新 context 中继续以保持编排质量。
  > - 继续当前 chat → 输入"继续"
  > - 开启新 chat → 执行 `/pipeline` 自动恢复」
- `context_usage < 15` → 不提示，直接回到 3.1

详见 `references/protocols.md` § Context Reset 协议。

### Phase 状态机推进

所有 task 完成（`$O next` 返回 `ALL_DONE`）后推进 Phase：
```
[Shell] $O advance-phase --dir $DIR
```
