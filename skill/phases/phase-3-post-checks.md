# Phase 3: 后置检查链 (d-0 ~ j)

> 全局短路规则：任何 HARD_FAIL 步骤经 error-fixer + 重试仍 FAIL 时，**直接跳到步骤 h 标记 FAILED**，不再评估后续步骤。
> task 在本链执行期间仍为 RUNNING 状态，直到步骤 h 最终标记。

## 步骤速查

| 步骤 | 门控 | 执行方 | 跳过条件 |
|------|------|--------|---------|
| d-0 产出校验 | HARD | 主Agent内联 | PRE_SHA=NO_GIT；remote 改查 `remote/{tid}/` |
| d-0.5 验收标准 | HARD/SOFT | 主Agent内联 | 无验收标准关键词；remote SKIP |
| O9 依赖安装 | SOFT | 主Agent内联 | 无元数据文件；remote SKIP |
| d-1 编译检查 | HARD | 主Agent内联 | 无对应语言文件；remote SKIP |
| O10 Lint | HARD | 主Agent内联 | 无配置/CLI；remote SKIP |
| d-1.5 覆盖delta | HARD/SOFT | 主Agent内联 | `tdd_mode=off`；remote SKIP |
| d-2 单元测试 | HARD | 主Agent内联 | 无测试框架；remote SKIP |
| d-3 回归测试 | SOFT | 主Agent内联 | 非大规模/首task；remote SKIP |
| d-4 性能基准 | SOFT | 主Agent内联 | 无`benchmark_cmd`；remote SKIP |
| e CCC-2 | SOFT | 内联(≤5)/spawn | 非中大规模；remote SKIP |
| f 质量门B | SOFT | 内联(≤3)/spawn | 非大规模；remote SKIP |
| g 快照 | — | Shell | 非大规模 |
| h 标记状态 | — | Shell | — |
| i 更新上下文 | — | Shell | retry时跳过 |
| j 计划偏离 | — | 主Agent内联 | 非中大规模 |

SubAgent 返回后若输出包含 `## 执行结果: FAILED` → 跳过后续检查，直接到步骤 h 标记 FAILED。

---

## d-0) 产出校验（所有规模）

**remote 分支**（`task.type == "remote"`）：
```
[Shell] ls -la $DIR/remote/{tid}/ && cat $DIR/remote/{tid}/status.json && cat $DIR/remote/{tid}/verify-output.txt
```
- `remote/{tid}/` 缺失或 `status.json` 无 `post_sha` → HARD_FAIL
- `verify_result` 非 PASS → HARD_FAIL
- `changed_files` 为空 → HARD_FAIL
- 通过 → 将 `changed_files` 赋给 `CHANGED`，跳到 g)

**local 分支**（`task.type != "remote"`）：
```
[Shell] _SHA=$PRE_SHA_{tid}; if [ "$_SHA" = "NO_GIT" ]; then echo "SKIP"; else CHANGED=$({ git diff --name-only "$_SHA" HEAD 2>/dev/null; git diff --name-only 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u); echo "$CHANGED"; fi
```
- `PRE_SHA=NO_GIT` → 跳过，继续 d-0.5
- CHANGED 为空 → **HARD_FAIL**（executor 声称 SUCCESS 但无文件变更）
- CHANGED 含明显无关文件 → 记 pending（`soft:`），继续 d-0.5

> `CHANGED` 变量为后续所有步骤的共享输入，按 `{tid}` 隔离。

## d-0.5) 验收标准验证（所有规模）

> remote → SKIP

从 `state.json` 当前 task 的 `description` 解析 `验收标准:` 内容，主 Agent 逐条对照：

1. 正则匹配 `验收标准:` / `验收标准：` 之后文本，按行/分号拆为条目
2. 逐条判定：检查 executor 输出中是否有对应实现证据
3. 产出 JSON：`{"items": [...], "all_met": true/false}`

- `all_met: true` → 继续 O9
- 未满足 ≤ 2 条 → **SOFT_FAIL**：记 pending，继续 O9
- 未满足 > 2 条 → **HARD_FAIL**：跳到 h（error: "验收标准大面积未满足"）
- 无法解析验收标准 → 跳过，记 INFO

## O9) 依赖探测（所有规模，d-1 之前）

> remote → SKIP

以变更文件路径为锚，向上搜索 `go.mod` / `package.json` / `requirements.txt`：

| 元数据 | 命令 |
|--------|------|
| `go.mod` | `go mod tidy` |
| `package.json` | 有 `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`；有 `yarn.lock` → `yarn install --frozen-lockfile`；有 `package-lock.json` → `npm ci`；仅 `package.json` 无 lock → SKIP+INFO |
| `requirements.txt` | `python3 -m pip install -r requirements.txt` |

- PASS（exit 0）→ 继续 d-1
- FAIL → **SOFT_FAIL**：记 pending（`soft: O9 {tid} 安装失败`），仍继续 d-1
- 无 CHANGED 列表 → 仅对当前工作目录扫描

## d-1) 编译检查（所有规模）

> remote → SKIP

根据变更文件语言执行：
- `*.go` → `go vet ./变更包/...`
- `*.ts/*.tsx` → `npx tsc --noEmit`（需 tsconfig.json）
- `*.py` → `python3 -m py_compile {各变更py文件}`
- 无以上类型 → 跳过

**顺序（MUST）**：先执行编译 Shell，仅当 exit 0 后立即调用 `test-gate`：
```
[Shell] {编译命令}
[Shell] $O test-gate $DIR compile '{"passed": true, "shell_exit_code": 0, "output": "..."}'
```

- FAIL → spawn error-fixer，修复后重试 1 次。**仍 FAIL → 短路到 h**

## O10) Lint（仅当 d-1 已通过或跳过之后）

> remote → SKIP

根据变更文件类型 + 配置文件是否存在：
- `*.go` + `.golangci.yml` → `golangci-lint run`
- `*.ts/*.tsx/*.js/*.jsx` + ESLint 配置 → `npx eslint ...`
- `*.py` + `ruff.toml` / `pyproject.toml[tool.ruff]` → `ruff check`
- 无配置/无 CLI → SKIP+INFO

- PASS → 继续 d-1.5
- FAIL → spawn error-fixer，重试 1 次。**仍 FAIL → 短路到 h**

## d-1.5) 测试覆盖 delta（`tdd_mode` ≠ `off` 时）

> remote → SKIP

检查新增/修改的生产代码是否有对应测试文件：
```
[Shell] # 对每个生产源文件检查同目录/同包下是否有对应测试文件
```

- PASS → 继续 d-2
- UNCOVERED + `tdd_mode=prompt` → **SOFT_FAIL**，记 pending，继续 d-2
- UNCOVERED + `tdd_mode=strict` → **HARD_FAIL**，spawn error-fixer 补充测试，仍失败 → 短路到 h

## d-2) 单元测试（有测试框架时）

> remote → SKIP

探测测试框架并执行：
- `go.mod` → `go test ./变更包/... -count=1 -timeout=60s`
- `package.json` 有 test script → `npm test -- --passWithNoTests`
- `pytest.ini` / `pyproject.toml[tool.pytest]` → `python3 -m pytest {变更目录} -q --timeout=60`
- 无测试框架 → 跳过

```
[Shell] {单测命令}
[Shell] $O test-gate $DIR unit '{"passed": true, "shell_exit_code": 0, "output": "..."}'
```

- FAIL → spawn error-fixer，重试 1 次。**仍 FAIL → 短路到 h**

## d-3) 增量回归测试（大规模，非首个 COMPLETED task）

> remote → SKIP

确保当前 task 变更未破坏前序 task 产出。基于 import graph 推导受影响测试：
- Go: `go test ./... -count=1 -timeout=120s`
- TS: `npm test -- --passWithNoTests`
- Python: `python3 -m pytest -q --timeout=120`

- FAIL → **SOFT_FAIL**，记 pending（`soft: 回归测试 {tid} 影响前序 task`）

## d-4) 性能基准测试（`.pipeline-orchestrator.yaml` 配置 `benchmark_cmd` 时）

> remote → SKIP

```
[Shell] eval "$BENCH_CMD"
```
- FAIL → **SOFT_FAIL**，记 pending

---

## e) CCC-2 上下文一致性校验（中/大规模）

> remote → SKIP

**对照基准分流**：
- 增强编排：`$DIR/design-brief.md` 为 mandatory design baseline
- OpenSpec：`design.md` / `session.md` 关键约束

**按变更文件数分流**：
- ≤ 5 个文件 → 主 Agent 内联自检（按 `references/prompt-templates.md`「内联 CCC-2」模板）
- \> 5 个文件 → spawn consistency-checker SubAgent

```
[Shell] $O consistency-check $DIR task {tid} '<CCC JSON>'
```

- 偏离 → **SOFT_FAIL**，记 pending（`soft: CCC-2 {tid} 偏离设计`）

## f) 质量门 B — task 质检（大规模）

> remote → SKIP

**轻重路由**：变更文件 ≤ 3 → 主 Agent 内联 checklist；> 3 → spawn quality-reviewer。

**FAIL 时修复链**：
1. 落盘 FAIL 条目到 `$DIR/review-feedback-{tid}.md`（含 `## Review 反馈`）
2. Re-spawn executor（读取 review-feedback 修复）
3. Delta 重检：FAIL ≤ 3 条 → 主 Agent 内联；> 3 条 → spawn quality-reviewer Delta 模式
4. Delta 通过 → 继续 g)
5. Delta 仍 FAIL → spawn error-fixer 兜底 → 完整重执行门 B（最多 1 轮）→ 仍 FAIL → 记 pending（`soft: 质量门B {tid} 未通过`），不再循环

## g) 快照（大规模）

```
[Shell] $O snapshot $DIR {tid}
```

---

## h) 标记最终状态

### 成功路径

**h-done-observe**（`cdp_observe_available=true` 且 `screenshot_on_complete: true` 且非 remote，默认关闭）：
```
[Shell] CallMcpTool("cursor-cdp", "screenshot", { "path": "$DIR/observability/task-{tid}-done-{epoch}.png" })
```

```
[Shell] echo "# {tid}: {name}\n- 变更文件: {files}\n- 产出摘要: {summary}\n- 新增接口: {apis}" | $O done $DIR {tid}
```

h-done 后清理中规模 stash（如有）：
```
[Shell] git stash list | grep "pre-{tid}" | head -1 | cut -d: -f1 | xargs git stash drop 2>/dev/null || true
```

### 失败路径

**h-fail-observe**（`cdp_observe_available=true` 且非 remote）：
```
[Shell] CallMcpTool("cursor-cdp", "screenshot", { "path": "$DIR/observability/task-{tid}-fail-{epoch}.png" })
[Shell] CDP_READ=$(CallMcpTool("cursor-cdp", "read", {}))
```
- `read` 成功 → 截断 2000 字符写入 `$DIR/observability/task-{tid}-fail-conversation.txt`
- 任一 CDP 失败 → 断路器 open，不影响 fail 流程

```
[Shell] echo "# {tid}: {name}\n- 错误: {detail}" | $O fail $DIR {tid} "{error_one_line}"
```

### h-1) 错误恢复重试（corrections < max_task_retries 时）

**Systematic Debugging 注入**（`tdd_mode` ≠ `off`）：error-fixer prompt 追加四阶段根因分析。

**对话快照注入**（`read_on_fail: true` 且捕获了 `last_message`）：追加 `## 失败时 Cursor 对话快照` 小节。

修复后验证命令取决于原始失败类型：

| 原始失败来源 | 验证命令 |
|-------------|---------|
| d-1 编译 / O10 Lint | 同编译/lint 命令 |
| d-2 单元测试 | 编译 + 单测 |
| d-3 回归测试 | 编译 + 回归 |
| d-0.5 验收大面积未满足 | 编译 |
| 其他（executor FAILED） | 编译 |

验证通过 → `$O retry $DIR {tid}`，回到 3.1。验证不通过 → 进入 h-2。

**重试上限**：`max_task_retries`（默认 1，范围 1~3）。`corrections >= max_task_retries` 时放弃。

### h-2) 连续失败检查

连续 ≥ 2 个 FAILED task → **MUST 暂停**：
> 「连续 {N} 个 task 失败。
> - 回滚 → `$O rollback $DIR {last_success_tid}`
> - 继续 → 忽略
> - 终止 → 结束编排」

---

## i) 更新上下文（MUST，无论 COMPLETED/FAILED）

> h-1 retry 回到 3.1 时跳过本步。

COMPLETED 时 `{summary}` 含：(1) 变更文件列表，(2) 接口变更摘要。FAILED 时记录失败原因。

```
[Shell] $O update-session $DIR "当前阶段详情" "{tid}: {summary}"
```

## j) 计划偏离检测（中/大规模，COMPLETED 时）

检查 executor 输出中的信号：
1. 包含"发现"/"注意"/"需要额外" → 后续 task 可能需调整
2. 新增非预定接口（对比 task description vs 实际新增导出）
3. 修改了 `owns_globs` 范围外的文件

**命中时**主 Agent 内联评估后续 PENDING task 是否受影响：
- 无影响 → INFO 日志，继续
- 可内联修正 → `$O update-session` 追加约束到"关键约束和决策"
- 影响面大（2+ task 前置假设失效）→ 暂停，展示选项：继续/调整计划/终止
