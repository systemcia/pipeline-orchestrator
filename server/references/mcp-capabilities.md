# MCP 能力登记（可选）

> 不存在本文件时，编排仍按 `references/skill-routing-table.md` 扫描项目 `mcps/`。**存在时**，Phase 3 构造 SubAgent prompt 应**仅列举与本 task 相关的工具**，下列为登记模板。

## MCP 工具三层分类

与 `references/protocols.md`「工具与 MCP 熔断」对齐：**熔断打开后默认停止该 task 的「非只读」MCP 调用，仅允许读文件/只读工具**——下文 **自由层** 对应「只读/无副作用」侧；**受控层、审批层** 对应「非只读」侧，熔断打开后须停止调用（除非 Profile 另有约定）。

### 1. 自由层（Free）

**定义**：只读查询类能力；不产生持久化写、不触发不可逆环境变更；典型为文档检索、时间查询、只读 API。**SubAgent 可在与 task 相关的前提下自由选用**（仍受 Phase 3「仅列举相关工具」约束）。

**归类示例**（与本文件登记表一致）：

| MCP Server | 工具名 | 说明 |
|------------|--------|------|
| user-context7 | `resolve-library-id` | 读 Context7 API |
| user-context7 | `get-library-docs` | 读 Context7 API |
| user-mcp-deepwiki | `read_wiki_structure` | 读 DeepWiki API |
| user-mcp-deepwiki | `read_wiki_contents` | 读 DeepWiki API |
| user-ghostmcp | `ghost_get_tools` | 读本地工具列表 |
| user-mysql | `query` | 只读 SQL（登记为读库） |
| user-clickhouse | `query` | 只读 SQL（登记为读库） |
| cursor-ide-browser | `browser_snapshot` | 读当前页面 DOM/可访问性树 |

**使用规则**：

- **谁可以用**：各 Phase 中与 task 匹配的 SubAgent；编排层仍应控制 prompt 内工具列表体量。
- **审批**：一般**不需要**单独人工审批；若环境将「连生产只读库」视为敏感，可在 Profile 中升为受控/审批策略。
- **日志**：建议常规 telemetry；不强制单独「使用日志」段落（与受控层区分）。
- **熔断**（`protocols.md`）：连续失败 ≥ `circuit_breaker_n` 打开熔断后，**自由层工具仍属允许范围**（与「仅允许只读工具」一致）；若同一工具连续失败，编排层可对该工具单独限流或改用手动步骤。

### 2. 受控层（Controlled）

**定义**：有副作用但**通常可逆**或影响面限于工作区/本地会话：如工作区文件读写、本地 git 操作（不含强推等高危项时仍可能归审批层）、浏览器自动化（导航/点击可能触发外部状态，但无登记级「生产写入」语义）等。**须记录使用日志**（调用意图、目标路径/URL、task id），便于审计与熔断后复盘。

**归类示例**（本文件当前登记）：

| MCP Server | 工具名 | 说明 |
|------------|--------|------|
| user-playwright | `browser_navigate` | 网络访问；可能改变远端会话状态，默认按受控处理 |

**归类示例**（常见类别，按项目 `mcps/` 实际登记补全）：

- 工作区文件写入类 MCP、本地 `git commit`/`checkout` 等（**不含**生产分支强推、**不含**直连生产写库）。
- Playwright / 浏览器操作类（点击、填表、上传等），与 `browser_navigate` 同属受控。

**使用规则**：

- **谁可以用**：executor、error-fixer 及 Phase 文档明确授权的角色；探索类 Phase 默认收紧，避免无目的浏览器/写文件。
- **审批**：**不强制**逐次人工确认，但须在 **`pending.md` 或结构化执行日志**中可追溯（与「记录使用日志」一致）；若单次操作影响共享分支或 CI，按项目 Profile 可要求先记 `soft:` 决策点。
- **熔断**（`protocols.md`）：熔断打开后**必须停止**本层工具调用；降级为只读步骤或手动操作，并在 `pending.md` 记 **`soft:`**（示例见 `protocols.md`「工具与 MCP 熔断」）。

### 3. 审批层（Approval）

**定义**：**不可逆或难回滚**的操作：如**数据库写入/DDL/DML 落生产**、**部署/发布**、**生产环境变更**（配置、开关、扩缩容）、**删除生产数据**、**绕过常规 CI 的强制推送**等。必须**人工确认**或在执行前/执行后于 **`pending.md` 留下明确记录**（建议前缀与 `protocols.md` / `governance-constitution.md` 一致：`hard:` 表示阻塞或不可逆承诺，`soft:` 表示已知晓风险并选择继续——具体以前者为主）。

**归类示例**（本文件当前无专项登记时，以**类型**为准；接入后应增行到登记总表）：

| 类型 | 示例 |
|------|------|
| 生产写入 | 经 MCP 执行的 `INSERT`/`UPDATE`/`DELETE`、迁移脚本对生产库执行 |
| 部署 / 发布 | 触发 CD、K8s 生产集群 apply、镜像推生产 |
| 生产运维变更 | 生产限流、Kill 流量、改生产配置中心 |

**使用规则**：

- **谁可以用**：仅编排显式允许且**已完成审批路径**的角色；默认不应在无人值守 auto 模式下自动调用。
- **审批**：**必须**人工确认 **或** `pending.md` 记录（含操作内容、执行者、时间、回滚预案指针）。
- **熔断**（`protocols.md`）：熔断打开后**禁止**继续调用；若业务强依赖某审批层工具且失败，可按 `protocols.md` 在 Profile 中约定改为 **`hard:`** 并 `fail` 该 task。

---

## 登记列说明

| MCP Server | 工具名 | 三层（Free/Controlled/Approval） | 副作用（读/写/网络/费用） | 需用户授权 | 建议 task 类型 |
|------------|--------|-----------------------------------|----------------------------|------------|----------------|
| user-context7 | `resolve-library-id` | Free | 读 Context7 API | 否 | 探索、实现 |
| user-context7 | `get-library-docs` | Free | 读 Context7 API | 否 | 探索、实现 |
| user-mcp-deepwiki | `read_wiki_structure` | Free | 读 DeepWiki API | 否 | 探索 |
| user-mcp-deepwiki | `read_wiki_contents` | Free | 读 DeepWiki API | 否 | 探索、实现 |
| user-ghostmcp | `ghost_get_tools` | Free | 读本地 | 否 | 探索 |
| user-mysql | `query` | Free | 读数据库（只读） | 否 | 探索、排查 |
| user-clickhouse | `query` | Free | 读数据库（只读） | 否 | 探索、排查 |
| user-playwright | `browser_navigate` | Controlled | 网络访问 | 否 | 测试 |
| cursor-ide-browser | `browser_snapshot` | Free | 读浏览器 | 否 | 测试 |

## Policy 扩展（可选 — 与 Phase 3 MCP 策略段落配合）

对**高危或易刷爆额度**的工具，可增列或在同表后续列维护。**熔断阈值**与打开后的行为以 `references/protocols.md`「工具与 MCP 熔断」为准；下表 `circuit_breaker_n` 与该节「连续失败」定义一致。

| MCP Server | 工具名 | 三层 | max_calls_per_task | circuit_breaker_n | 建议 Step ID / 任务类型 |
|------------|--------|------|--------------------|--------------------|-------------------------|
| user-context7 | `get-library-docs` | Free | 5 | 3 | Phase 3 实现类 task |
| user-mcp-deepwiki | `read_wiki_contents` | Free | 5 | 3 | Phase 1 探索 / Phase 3 实现 |
| user-mysql | `query` | Free | 10 | 3 | Phase 3 排查类 task |
| user-clickhouse | `query` | Free | 10 | 3 | Phase 3 排查类 task |
| user-playwright | `browser_navigate` | Controlled | 5 | 2 | Phase 4 E2E 测试 |
| cursor-ide-browser | `browser_snapshot` | Free | 10 | 3 | Phase 4 E2E 测试 |

- **max_calls_per_task**：单 task 执行窗口内建议上限（编排层以 prompt 契约约束；若未来引擎计数则以实现为准）。
- **circuit_breaker_n**：同一工具**连续失败**达到该次数后，进入熔断降级；**打开后**：停止**非只读**（受控层、审批层）MCP，仅允许自由层及读文件等；详见 `references/protocols.md`「工具与 MCP 熔断」。
- **Step ID**：与 `SKILL.md` 规模矩阵中的 Step ID（如 `rag-inject`、`compile`）或任务类型标签对齐，供 SubAgent 指令模板引用。

## 示例行（请替换为真实环境后取消注释或增行）

<!-- | user-context7 | resolve_library_id | Free | 读 Context7 API | 否 | TS/Go 依赖查文档 | -->

维护原则：只登记**高频或高危**工具；其余仍可在 SubAgent 内通过 `mcps/` 描述符发现，但不应在 prompt 中一次性倾倒全部工具列表。
