# Phase 3: 执行循环

> spawn 前 MUST 按角色类型选择注入源：执行类读 `$DIR/context.md`，审查类读 `$DIR/session.md`。
> 角色文件在 `.cursor/agents/*.md`，prompt 首行 `按 .cursor/agents/{role}.md 执行`。

## 全局短路规则

**任何 HARD_FAIL 步骤（d-1/O10/d-2 等确定性门控）经 error-fixer 修复 + 重试仍 FAIL 时，统一短路到步骤 h 标记 FAILED，跳过后续所有检查步骤。** 不需要逐步评估后续步骤的跳过条件——代码不能通过确定性门控时，后续的测试/CCC/质量门均无意义。

门控类型分类（完整定义见 `references/protocols.md`「Gate Taxonomy」）：
- **HARD_FAIL**（确定性）：编译/lint/单测/产出校验 exit 非 0 → error-fixer + 重试 → 仍 FAIL → 短路到 h
- **SOFT_FAIL**（启发式）：CCC/质量门/回归测试 → 记 pending.md（`soft:` 前缀），不阻塞后续步骤

## 状态机（严格按此流转，不得跳步）

```
          ┌──────────────────────────────┐
          ▼                              │
  ┌──── 3.1 $O next ────┐               │
  │                      │               │
  ▼ READY                ▼ WAITING       │
 3.2 并行资格判定     过期清理           │
  │                   → 回 3.1           │
  ├─ 可并行 ──→ 并行 spawn ─┐           │
  └─ 串行 ──→ 逐个 a→b→c ─┐ │           │
                            ▼ ▼           │
               3.3 后置检查 d-0 ~ j ─────┘
                            │
                            ▼ ALL_DONE
                          Phase 4
```

## 3.0 观测前置检查（CDP 断路器）

> 仅在 `.pipeline-orchestrator.yaml` 配置 `observability.enabled: true`（默认）时执行。

Phase 3 进入循环前，检测本地主窗口 CDP 可用性：

```
[Shell] CallMcpTool("cursor-cdp", "status", {})   # 5s 超时
```

- 返回 `connected: true` → 设 `cdp_observe_available=true`
- 失败 / 超时 / `connected: false` → 设 `cdp_observe_available=false`，记 INFO

**断路器管理**（贯穿 Phase 3）：
- 任意观测 CDP 调用失败 → 立即 `cdp_observe_available=false`，后续跳过所有观测动作
- 每完成 5 个 local task 后惰性重试一次 `status()`（5s 超时）
- 剩余 task ≤ 5 时不重试
- `observability.enabled: false` 或 `task.type == "remote"` 时所有观测钩子跳过

## 3.1 查询可执行 task

```
[Shell] $O next $DIR
```

解析 JSON 输出的 `status` 字段：
- `"READY"` → 取 `tasks` 数组，进入 3.2（→ `phase-3-parallel.md`）
- `"ALL_DONE"` → 执行 `$O validate $DIR`，通过后进入 Phase 4
- `"WAITING"` → 检查 RUNNING task 是否超时（`config.timeout_minutes`，默认 10 分钟），超时标记 FAILED 后重新执行 3.1；非当前批次的遗留 RUNNING task 标记 FAILED（原因 "orphaned"），重新执行 3.1

## 3.2 并行判定 + 执行

详见 → **`phase-3-parallel.md`**

包含：并行资格 4 级判定（P0~P3）、接口先行（O12）、CCC-merge、Integrator 批次编译（O3）、批次排序规则。

## 3.3 后置检查链

详见 → **`phase-3-post-checks.md`**

包含：d-0 产出校验 → d-0.5 验收标准 → O9 依赖 → d-1 编译 → O10 Lint → d-1.5 覆盖delta → d-2 单测 → d-3 回归 → d-4 性能 → e CCC-2 → f 质量门B → g 快照 → h 标记状态 → i 更新上下文 → j 计划偏离。

## 3.4 Context Reset 检查 + 回到 3.1

每批 task 后置检查全部完成后，检查 `context_usage`（Phase 3 进入后已执行的 Shell + Task 调用总数）：

- `context_usage ≥ 30` → 确保所有持久化已完成，然后输出：
  > 「当前编排进度：{completed}/{total}。context 使用量较高（{context_usage} 次调用），建议在新 context 中继续。
  > - 继续当前 chat → 输入"继续"
  > - 开启新 chat → 执行 `/pipeline` 自动恢复」
- `context_usage < 30` → 不提示，直接回到 3.1

### Phase 状态机推进

所有 task 完成（`$O next` 返回 `ALL_DONE`）后推进 Phase：
```
[Shell] $O advance-phase --dir $DIR
```
