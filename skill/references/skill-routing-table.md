# Skill 路由表

## 路由规则（总序）

对 Phase 3 **`$O start` 的 skill 参数**，按以下顺序**命中即停**（详见 `phases/phase-3-execute.md` §b）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1（最高） | `state.json` 任务 **`skill` 非空** | 显式指定（含恢复 session）；不再覆盖 |
| 2 | **`.pipeline-orchestrator.yaml` 的 `skill_routes`** | 有序列表，**第一条**匹配 `task_id` / `openspec_task_id` / `description_regex` 的规则生效 |
| 3 | 同文件 **`custom_routes`** | 任务描述关键词 → Skill（项目扩展） |
| 4 | 下表 **内置关键词** | 通用默认 |
| 5 | 无匹配 | 不指定 Skill，通用 prompt |

**辅助维度（不改变上表 1～5 顺序）**：**`file-pattern`** 与 **`task-type`** 与 2～4 协同：编排层可据 task 关联路径、类型标签选择 **SubAgent**、注入 **Scope**，或对已命中规则做附加过滤；**不得**插入为新的优先级序号，亦 **不能** 覆盖优先级 1 的 `state.json` **`skill`**。若 YAML 对单条 `skill_routes` 增加限定字段，仍须满足下文「仅配置一种主匹配器」；附加条件以引擎与校验脚本为准。

### file-pattern（路径 / glob）

依据 task 关联源码路径做**语言或场景倾向**，不单独构成新优先级；与关键词命中并存时仍以 **2 列表顺序 → 3 → 4** 为准。

| file-pattern（示例 glob） | 协同说明 |
|---------------------------|----------|
| `*.go`、`go.mod` | 倾向 Backend / Go 规范上下文；若同时命中 SQL 等关键词，仍以先匹配的 `skill_routes` / `custom_routes` / 内置关键词为准 |
| `*.ts`、`*.tsx`、`*.vue` | 倾向 Frontend 上下文与对应 Scope |
| `*_test.go`、`*.spec.ts`、`*.test.ts`、`__tests__/**` | 常与 **task-type: `test`** 组合，SubAgent 侧路由至 **tester**（见下节） |

### task-type（任务类型标签）

与 OpenSpec / 编排 task 元数据中的类型字段对齐；**决定 SubAgent（如 Phase 3 派生 `tester`）与提示注入**，**不替代** Skill 的 1～5 解析——除非在优先级 **2** 的规则里显式写了 `skill`。

| task-type（示例） | SubAgent（编排层） | Skill（仍经 1～5） |
|-------------------|-------------------|-------------------|
| `test` | **tester**（`.cursor/agents/tester.md`） | 可由 `skill_routes` 首条命中绑定（如 `integration-test-generator`）；未配置则 Skill 可为空，由 tester 按仓库惯例写单测 |

**示例：`task-type: test` 与 tester 协同**

- 某 task 标记 `task-type: test`，描述为「为 `internal/foo` 补充单元测试」，关联文件含 `*.go`；`state.json` **未**写 `skill`（优先级 1 不生效）。
- 若 `.pipeline-orchestrator.yaml` 的 `skill_routes` 首条以既有主匹配器（`task_id` / `openspec_task_id` / `description_regex` 之一）命中该 task，且配置 `skill: integration-test-generator`，则 Skill 取该条（优先级 2）；编排层据 **`task-type: test`** 选 **SubAgent: tester**，执行测试文件-only 变更。
- 若无 `skill_routes` 命中、关键词也未命中内置表，则落入优先级 5（无 Skill），**SubAgent 仍为 tester**，由其在允许的文件模式内生成 `*_test.go` 等。

**扫描目录**（同名 Skill）：项目级 `.claude/skills/`、`.cursor/skills/` 优先于全局 `~/.cursor/skills/`、`~/.claude/skills/`（可通过 `skill_scan_dirs` 扩展）。

**静态检查**：`skill_routes` 须为列表且每条含非空 `skill`、且仅配置一种**主**匹配器（`task_id` / `openspec_task_id` / `description_regex` 三选一）；`file-pattern`、`task-type` 若作为附加字段出现，不得与「多主匹配器并存」混同。可执行仓库内校验脚本或按 `openspec` change `structured-skill-routing` 验收。

## Superpower 三件套联动

`tdd_mode` ≠ `off` 时，编排层自动在 SubAgent prompt 中注入对应纪律段落（见 `references/prompt-templates.md`）：

| Superpower Skill | 注入目标 | 激活条件 | 注入方式 |
|------------------|----------|----------|----------|
| `tdd-discipline` | executor | `tdd_mode=prompt\|strict` + 项目有测试框架 + 非 `task-type: test` | `{implementation_discipline}` 占位符 |
| `systematic-debugging` | error-fixer | `tdd_mode=prompt\|strict` + 失败类型为测试/运行时错误 | prompt 追加「调试纪律」段落 |
| `verification-guard` | 编排层内置 | 始终激活 | d-1/d-2 证据链（先 Shell 再 test-gate） |

三件套不作为 Skill 路由命中（不经 `skill_routes` / `custom_routes` / 内置关键词），而是由编排层根据 `tdd_mode` 配置**直接注入**对应 prompt 段落。Skill 路由表中的 1~5 优先级不受影响。

## 内置路由（通用）

| 任务类型 | 匹配关键词 | Skill 名称 | Agent 类型 |
|----------|-----------|-----------|-----------|
| 代码优化 | 优化, review, 帮我改进 | optimization-master | generalPurpose |
| 代码提交 | 提交代码, git push | smart-code-push | generalPurpose |
| SQL 审核 | SQL, DDL, DML, 建表 | sql-audit-guide | generalPurpose |

## 无 Skill 匹配的任务

| 任务类型 | 匹配特征 | Agent 类型 |
|----------|----------|------------|
| 代码实现 | 功能开发、接口实现 | generalPurpose |
| 代码探索 | 了解项目结构 | explore |
| 命令执行 | shell 命令 | shell |

## 项目级 Skill 扩展

通过 `.pipeline-orchestrator.yaml` 的 **`skill_routes`**（结构化）与 **`custom_routes`**（关键词）扩展；模板见 `templates/pipeline-orchestrator.yaml`。

```yaml
custom_routes:
  # troubleshooting: my-troubleshooting
  # deploy: deploy-helper
```

## 扫描目录配置

默认扫描（按优先级）：

```
.claude/skills/          # 项目级
.cursor/skills/          # 项目级
~/.cursor/skills/        # 全局
~/.claude/skills/        # 全局
```

可通过 `.pipeline-orchestrator.yaml` 的 `skill_scan_dirs` 字段扩展。

## MCP 工具路由

读取 `mcps/` 目录确定当前项目已配置的 MCP server，在 SubAgent prompt 中指定可用 MCP。
按需注入，不要注入与任务无关的 MCP。

若项目包含 **`references/mcp-capabilities.md`** 且已登记工具，则 **仅将与本 task 类型相关的 MCP 工具** 写入 SubAgent prompt 白名单段落；未登记的工具名不要凭记忆编造。无该文件或表为空时，行为与上段相同（仅 `mcps/` 扫描 + 最小注入）。
