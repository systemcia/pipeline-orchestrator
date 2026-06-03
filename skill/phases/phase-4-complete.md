# Phase 4: 完成

## 4-pre. 完成前置检查（MUST，所有规模）

进入 Phase 4 前，从 `$DIR/state.json` 读取 task 统计：
```
[Shell] python3 -c "import json;s=json.load(open('$DIR/state.json'));ts=s['tasks'];c=sum(1 for t in ts if t['status']=='COMPLETED');f=sum(1 for t in ts if t['status']=='FAILED');sk=sum(1 for t in ts if t['status']=='SKIPPED');print(f'COMPLETED={c} FAILED={f} SKIPPED={sk} TOTAL={len(ts)}')"
```

- **全部 FAILED/SKIPPED（无任何 COMPLETED task）** → 跳过 4a/4b/4c 质量门和概要展示（无有效产出可审查），直接进入 4c-2 用户验收，向用户展示：
  > 「所有 {total} 个 task 均未成功完成（FAILED: {failed}, SKIPPED: {skipped}）。
  > 失败详情见 `$DIR/pending.md`。
  > - **回滚** → 终止 session，代码保持 Phase 3 前状态
  > - **部分返工** → 指定需要重试的 task，回到 Phase 3
  > - **终止** → 标记 session 为 FAILED 并结束」
- **有 COMPLETED task** → 正常继续 4a

## 4a. E2E 测试门（中/大规模执行，项目有集成测试框架时）

测试未通过为 **SOFT_FAIL**（E2E 依赖外部环境，不稳定性高；前序门已保障代码质量）。记 pending 时决策点使用 `soft:` 前缀。

**框架探测**（主 Agent 内联执行，先探测再决定是否 spawn）：
```
[Shell] E2E_FW="none"
[ -d "e2e" ] || [ -d "tests/e2e" ] || [ -d "test/e2e" ] && E2E_FW="dir"
[ -f "playwright.config.ts" ] || [ -f "playwright.config.js" ] && E2E_FW="playwright"
[ -f "cypress.config.ts" ] || [ -f "cypress.config.js" ] && E2E_FW="cypress"
grep -q '"e2e"' package.json 2>/dev/null && E2E_FW="script"
echo "E2E_FW=$E2E_FW"
```

- `E2E_FW=none` → 跳过 E2E 测试，记日志 "无 E2E 框架，跳过"
- 其他 → spawn SubAgent 执行 E2E 测试

```
[Task] spawn generalPurpose SubAgent，指令：
  "为本次变更生成并运行核心集成测试。
   检测到的 E2E 框架：{E2E_FW}
   变更文件：<files>
   输出测试结果 JSON：{\"passed\": bool, \"details\": \"...\"}。"
```
```
[Shell] $O test-gate $DIR e2e '{"passed": true/false, "details": "..."}'
```

## 4b. 质量门 C — 全局审查（中/大规模执行）

审查未通过为 **SOFT_FAIL**；记 pending 时决策点使用 `soft:` 前缀。

**变更文件列表来源**：从 `$DIR/state.json` 中所有 COMPLETED task 的 `session.md`「当前阶段详情」段落中提取各 task 的变更文件列表，取并集去重。或直接执行 `git diff --name-status` 对比 session 首个 task 的 `PRE_SHA` 基线与当前 HEAD。

**文件列表裁剪**：当变更文件总数 > 15 时，按「新增(A) > 修改(M) > 接口文件(*_api/*_handler/*_router) > 其余」优先级取前 15 个，剩余记为 `...及 N 个其他文件`。避免 SubAgent 因文件过多导致审查质量下降。

按 `references/prompt-templates.md`「质量门 C」模板，填入 `{files}`（裁剪后）和 `$DIR` 后 spawn：
```
[Task] spawn generalPurpose SubAgent，指令：<填充后的质量门 C 模板，角色引用 quality-reviewer.md>
```

**FAIL 时**（`summary` 为 FAIL）：编排层 **MUST** 从返回 JSON 提取 `items` 中 `result=FAIL` 的条目，写入 **`$DIR/review-feedback-phase4.md`**（全局门 C 专用；与 task 级 `{tid}` 反馈文件区分），内容须可追溯 reviewer 意图（含各条目的 `id`/`evidence`，可直接落 JSON 子集或等价结构化 Markdown）。

然后进入 **自动修复 + 重检** 链（不创建新 task，视为当前 Phase 4 内联修复）：

1. **优先 executor**：spawn generalPurpose SubAgent（按 **`.cursor/agents/executor.md`**）。指令 **必须** 包含固定小节标题 **`## Review 反馈`**：要求读取 `$DIR/review-feedback-phase4.md`，按其中 FAIL 条目做最小化修复；其余遵循 executor 角色契约（Scope 注入、输出契约等）。与 `references/protocols.md`「角色间交接协议」一致：FAIL 条目先经落盘文件交给 **执行类**角色，再进入下方 Delta（对应表中 `quality-reviewer → quality-reviewer (Delta 重检模式)` 的字段形态）。

2. **Delta 重检**（仅当 executor 输出可解析为 `## 执行结果: SUCCESS`）：针对 **本轮门 C 的 FAIL 条目**，分流同 Phase **3-f** 质量门 B——FAIL 项数 ≤ 3 时主 Agent **内联**逐条对照文件，**不 spawn** SubAgent；> 3 时按 `.cursor/agents/quality-reviewer.md` 的 **Delta 重检模式** spawn（prompt 注入 `## 模式: Delta 重检` + 上述 FAIL 条目的 `id` 列表），仅重检这些条目。executor 非 SUCCESS 或无法解析 → **跳过本节成功路径，视同 Delta 仍 FAIL**，直接进入步骤 4。

3. **Delta 通过**（无 FAIL 剩余 / `summary` PASS）→ 继续 **4c**。

4. **Delta 仍 FAIL**（**SOFT_FAIL**）→ **兜底**：spawn generalPurpose SubAgent（按 `.cursor/agents/error-fixer.md`），修复清单优先取 **Delta 输出**中仍 `result=FAIL` 的条目；若步骤 2 未产生 Delta 产物（如 executor 非 SUCCESS），则取 **`review-feedback-phase4.md`** 中的首轮 FAIL 条目。修复后 **完整重执行 4b**（自「按质量门 C 模板 spawn」起，**最多 1 轮**）。仍 FAIL → 记 pending.md：决策点 `soft: 质量门C全局审查未通过`、自动选择「继续完成」、风险「{问题摘要}」，继续 4c。

## 4c. 执行总结（中/大规模执行）

读取 `$DIR/session.md` 的"当前阶段详情"，向用户输出编排执行概要：

**展示模板**：
```
## 编排执行概要

### 任务完成情况
- 完成: {completed} / 总计: {total} / 失败: {failed}

### 各 task 产出
| Task | 状态 | 核心产出 |
|------|------|---------|
| {tid}: {name} | COMPLETED | {files}, {apis} |
| ... | ... | ... |

### 待确认事项
{pending.md 全部内容，如行数 > 3 则展示，否则显示"无待确认事项"}
```

## 4c-2. 用户验收（中/大规模，MUST 暂停等待用户回复）

展示概要后，**MUST 暂停**等待用户验收确认：

> 请确认编排结果：
> 1. **确认** — 结果符合预期，完成 session
> 2. **部分返工** — 指出需要修改的 task，我会重置为 PENDING 重新执行
> 3. **终止** — 放弃本次编排

用户回复处理：
- **确认**（"ok"/"没问题"/"可以"）→ 继续 4d
- **部分返工** → 用户指定 task ID 列表，执行 `$O retry $DIR {tid}`（corrections 计数器不影响此处，此为用户主动返工），然后回到 Phase 3.1。返工 task 的 executor prompt 中追加 `## 用户返工要求: {用户反馈原文}`
- **终止** → 执行 `$O complete $DIR`，在 session.md 记录 "用户主动终止"

> **设计考量**：Phase 1g 审批的是"计划"，4c-2 验收的是"结果"。计划正确不代表执行正确，这是闭环的最后一道人工门。

## 4d. 完成前校验与结束 session

### 4d-1 校验（MUST）

```
[Shell] $O validate $DIR
```

- **全部 Profile**：执行数据完整性检查；若 `state.json` 已配置 `openspec_change` + `openspec_repo_root` 且各 task 含 `openspec_task_id`，**同时**比对 OpenSpec `tasks.md` 中 **N.M** 集合与 session（详见 `references/openspec-integration.md`）。**漂移为 HARD_FAIL**，须修正后再进入 4d-2。
- **thorough Profile / CI**：建议设置 `PIPELINE_OPENSPEC_*` 与 `openspec_task_id` 齐全，使漂移检测生效；**不允许 waiver**。

### 4d-2 标记 session 完成

```
[Shell] $O complete $DIR
```

## 4e. 归档（OpenSpec 模式时）

```
[Task] spawn generalPurpose SubAgent，指令：
  "调用 openspec-archive-change Skill，归档 change '<name>'。
   所有确认提示选 yes。如有 delta specs，选择 sync。"
```

### Phase 状态机推进

```
[Shell] $O advance-phase --dir $DIR
```

**按规模分流**：
- **大规模** → 继续 Phase 5（5a + 5b）
- **中规模** → 继续 Phase 5（仅 5a）
- **小规模** → 跳过 Phase 5，直接推进到结束：
  ```
  [Shell] $O advance-phase --dir $DIR --to 5   # Phase 5→SKIPPED，session 结束
  ```
