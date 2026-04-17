# Telemetry 反模式清单 v2

| 字段 | 值 |
|------|-----|
| **版本** | v2 |
| **生效日期** | 2026-04-08 |
| **判定输入** | `state.json` + `telemetry.jsonl` + `session.md`（**不**将自然语言对话「声称完成」作为唯一依据） |
| **变更说明** | 继承 v1 条目 1-2，新增条目 3-6 |

## 条目 1：COMPLETED 但无 telemetry `done`

**条件**：`state.json` 中某 task 的 `status` 为 `COMPLETED`，且在同一会话的 `telemetry.jsonl` 中**不存在** `event` 为 `done`、`tid` 与该 task `id` 一致的行。

**含义**：任务状态与引擎遥测不一致（可能手工改 state、引擎异常或落盘丢失）。复盘时 **MUST** 标为异常并调查。

**处置**：advisory（默认不阻断）；若团队有强制 harness，可升级为 blocking。

## 条目 2：`start` 无配对的 `done` / `fail`（复盘用）

**条件**：`telemetry.jsonl` 中存在某 `tid` 的 `event: start`，且在**同一会话文件范围内**该 `tid` 其后**无** `event: done` 或 `event: fail`。

**与 Phase 3 的关系**：正常运行中孤儿 `RUNNING` 由 `phase-3-execute.md` 超时 / orphan 规则处理；本条目用于 **session 已结束或复盘导出后** 检查「事件链是否闭合」，不等同于运行时自动 FAIL。

**含义**：可能崩溃、中断或漏调 `$O done`/`fail`。

**处置**：advisory；写入 `lessons.md` / `improvements.md` 时引用本条目编号。

## 条目 3：同 task 连续修复 ≥ 3 次

**条件**：`state.json` 中某 task 的 `corrections` 字段 ≥ 3，或 `telemetry.jsonl` 中同一 `tid` 的 `event: fail` 出现 ≥ 3 次。

**含义**：error-fixer 陷入修复循环，未能收敛。可能是：(1) 根因未定位，反复改症状 (2) 修复引入新问题 (3) task 拆分过粗，应进一步拆解。

**处置**：advisory；session-analyst 应将其归类为「执行失败 → 编辑循环」，并匹配改进模式「循环断路器」。

## 条目 4：质量门同一检查项连续 2 task FAIL

**条件**：`state.json` 的 `test_results` 或 `logs/` 中，quality-reviewer 的同一检查项 ID（如 `C01`）在连续 2 个不同 task 中均为 FAIL。

**含义**：系统性代码质量问题，非单 task 偶发。可能是：(1) 项目约定未注入 SubAgent (2) project-context.mdc 缺失关键规范 (3) executor 角色定义缺少该维度约束。

**处置**：advisory；session-analyst 应匹配改进模式「具体化规则」或「环境上下文注入」。

## 条目 5：CCC-2 覆盖率持续 < 80%

**条件**：连续 2 个 task 的 CCC-2 结果中 `aligned: false` 且 `issues` 数量 ≥ 2。

**含义**：设计与实现持续偏离。可能是：(1) design.md 过于宽泛 (2) task 描述与设计脱节 (3) executor 未读取设计上下文。

**处置**：advisory；`gate_mode: interactive` 时在第 2 次偏离触发暂停（与现有 CCC 严重偏离规则叠加）。

## 条目 6：session.md 行数 > 300（上下文膨胀）

**条件**：`state.json` 的 `session_md_lines` > 300。

**含义**：session.md 膨胀可能导致 SubAgent 注入的上下文过长、注意力衰减（对应假设 H02）。通常发生在大规模编排的后半段。

**处置**：advisory；建议编排层在检测到该条件时，`update-session` 使用 `replace` 模式精简历史 task 详情（保留最近 3 个），或触发 Context Reset。

## 显式非目标（v2）

- **禁止**仅凭 Chat 文本「task 已完成」判定上述条目；须以落盘文件为准。
- 不覆盖 OpenSpec、`$O validate` 漂移等已在 **HARD_FAIL** 中定义的门控。
- 条目 3-6 为高置信启发式，非确定性门控；复盘时作为**改进线索**而非**阻塞条件**。

## 演进

新增或修改语义须 bump 版本（如 `v3`）或通过 OpenSpec change 更新本清单与 spec。
