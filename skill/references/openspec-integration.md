# OpenSpec CLI 集成

## OpenSpec 与 `$O` 主从关系（单一事实源）

- **计划与完成语义主源**：OpenSpec 当前 change 的 `tasks.md` 以及 `openspec status` 所反映的勾选/完成语义。
- **运行态投影**：`$O`（`state.json` 中的 task DAG、PENDING/RUNNING/COMPLETED 等）**必须**由上述计划在 Phase 2 通过 `openspec instructions apply` 导出并转换而来；**禁止**在 session 存活期间独自增删与 `tasks.md` 不一致的 task 而不回写 OpenSpec。
- **`$O init` 任务列表**：JSON 须来自 apply 指令对应的任务拆解；每个 task 对象**建议**包含 `openspec_task_id`（与 `tasks.md` 中行首 `N.M` 或 `N.M.K` 一致），以便 `$O validate` 做集合比对。
- **对齐校验**：`$O validate <dir>` 在 `state.json` 同时存在 `openspec_change`、`openspec_repo_root` 且各 task 带 `openspec_task_id` 时，会比对 `openspec/changes/<change>/tasks.md` 中解析出的 `N.M[.K]` 集合与 session。**失败语义**见下文「漂移校验与 HARD_FAIL」。

## 前置检查

Phase 1a 通过以下命令检测 OpenSpec 可用性。**MUST 用命令检测，NEVER 凭记忆判断。**

```bash
ls openspec/config.yaml 2>/dev/null && echo "HAS_OPENSPEC" || echo "NO_OPENSPEC"
```

**判断规则**：
- `HAS_OPENSPEC` → 走 OpenSpec 全流程（SKILL.md 分支 A）
- `NO_OPENSPEC` → 走增强编排模式（SKILL.md 分支 B）

## CLI 命令速查

| 命令 | 用途 | 阶段 |
|------|------|------|
| `openspec list --json` | 列出所有 changes | Phase 1 |
| `openspec new change "<name>"` | 创建新 change | Phase 1 |
| `openspec status --change "<name>" --json` | 查看 change 状态 | 任意 |
| `openspec instructions proposal --change "<name>" --json` | 获取 propose 指令 | Phase 1 |
| `openspec instructions apply --change "<name>" --json` | 获取 apply 指令和 tasks | Phase 2 |

## 各阶段 CLI 调用序列

### Phase 1（提案阶段）

```bash
openspec list --json                                    # 检查同名 change
openspec new change "<name>"                            # 创建 change
openspec instructions proposal --change "<name>" --json # 获取模板
# spawn SubAgent 生成 proposal/design/specs/tasks
openspec status --change "<name>" --json                # 确认状态
```

### Phase 2（创建 Session）

```bash
openspec instructions apply --change "<name>" --json    # 获取 tasks 列表
# 转换为 $O init 的 JSON 格式（每项含 id/name/description/depends_on，且含 openspec_task_id 映射到 tasks.md 的 N.M[.K]）
export PIPELINE_OPENSPEC_CHANGE="<name>"
export PIPELINE_OPENSPEC_REPO_ROOT="$(pwd)"   # 或含 openspec/changes 的仓库根
$O init "<name>" '<转换后 JSON>' '<profile>'   # profile 可选；环境变量见 scripts/orchestrate.sh init
```

**漂移校验与 HARD_FAIL**：`$O validate <dir>` 在配置齐全时若发现 `tasks.md` 与 session 的 `openspec_task_id` 集合不一致，**归类为 HARD_FAIL**（与 `references/protocols.md` Gate Taxonomy 一致）。**不允许 waiver**：须修正 `tasks.md` 或重新 `init` 对齐。**默认 Profile** 仍应执行 validate 做数据完整性检查；仅当未设置 `openspec_repo_root`/`openspec_change` 或未填 `openspec_task_id` 时跳过 OpenSpec 集合比对（仅结构校验）。

命令行覆盖（不依赖 state 中字段时）：

```bash
$O validate "$DIR" --openspec-change "<name>" --openspec-repo-root "/path/to/repo"
```

### Phase 4（归档）

```bash
openspec status --change "<name>" --json                # 确认所有 tasks 完成
# spawn SubAgent 调用 openspec-archive-change Skill
```

## openspec instructions 返回格式

```json
{
  "changeName": "xxx",
  "changeDir": "/path/to/change",
  "contextFiles": {
    "proposal": "/path/to/proposal.md",
    "design": "/path/to/design.md",
    "tasks": "/path/to/tasks.md"
  },
  "tasks": [
    {"id": "1", "description": "...", "done": false}
  ],
  "state": "ready | blocked | all_done"
}
```
