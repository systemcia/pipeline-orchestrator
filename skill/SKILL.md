---
name: pipeline-orchestrator
description: >
  全链路 AI 开发闭环引擎。以增强编排为默认模式（可选 OpenSpec 提案流程），管理台（18000/18001）为数据中枢，
  集成 RAG 防幻觉、上下文一致性校验、质量门、测试门、经验反哺六大能力。
  触发："帮我编排"、"/pipeline"、"流水线执行"、"全自动开发"、含 3+ 步骤的需求描述。
---

# Pipeline Orchestrator — 全链路 AI 开发闭环引擎

## 强制约束（MUST — 每次 Phase 切换时重读本节）

1. **MUST** 所有 spawn SubAgent **禁止指定 `model` 参数**，继承主 Agent 模型
2. **MUST** Phase 2 之后每次 spawn 前**重新读取** `$DIR/session.md`，提取最新上下文注入 prompt
3. **MUST** 每个 `[Shell]`/`[Task]` 步骤执行后**检查返回值**，非 0 进入错误恢复
4. **NEVER** 凭记忆假设项目结构、文件存在性、CLI 可用性——**必须用命令检测**
5. **NEVER** 跳过落盘步骤（state.json / session.md / 日志），即使 task 看似无变更

## $O 引擎定位（MUST 在 Phase 0 任何 `[Shell]` 步骤之前完成解析）

```bash
# 推荐：export PIPELINE_ORCHESTRATOR_HOME=<本仓库根目录>，避免多份安装时命中歧义（POSIX 兼容，无 mapfile）
if [ -n "${PIPELINE_ORCHESTRATOR_HOME:-}" ] && [ -f "${PIPELINE_ORCHESTRATOR_HOME}/scripts/orchestrate.sh" ]; then
  O="${PIPELINE_ORCHESTRATOR_HOME}/scripts/orchestrate.sh"
else
  _po_c=$(find . ~/.cursor/skills ~/.claude/skills -path "*/pipeline-orchestrator/scripts/orchestrate.sh" 2>/dev/null | sort -u)
  if ! printf '%s\n' "$_po_c" | grep -q .; then
    echo "ERROR: orchestrate.sh not found; export PIPELINE_ORCHESTRATOR_HOME=<repo>" >&2
    exit 1
  fi
  _po_n=$(printf '%s\n' "$_po_c" | grep -c . || true)
  if [ "$_po_n" -gt 1 ]; then
    echo "ERROR: multiple orchestrate.sh (${_po_n} paths); set PIPELINE_ORCHESTRATOR_HOME. Candidates:" >&2
    printf '%s\n' "$_po_c" >&2
    exit 1
  fi
  O=$(printf '%s\n' "$_po_c" | head -1)
fi
```

**找不到或多路径歧义均终止编排**（不可静默 `head -1`）。全局 Skill 副本须与此片段保持同步，见 `references/governance-constitution.md`。

## 命令速查

```
$O init              [--project <id>] <name> <tasks_json> [profile]  创建 session
$O list                                           列出所有 session
$O next              <dir>                         查询可执行 task
$O start             <dir> <tid> <agent> [skill]   标记开始
$O done              <dir> <tid>                   标记完成 (stdin=日志)
$O fail              <dir> <tid> <error>           标记失败 (stdin=日志)
$O retry             <dir> <tid>                   将 FAILED task 重置为 PENDING（error-fixer 修复后重试）
$O status            <dir>                         session 概览
$O validate          <dir> [--openspec-change … --openspec-repo-root …]  数据校验 + 可选 OpenSpec 任务集合漂移检测
$O skill-route       <dir> <tid> [--config path]  根据 YAML 配置解析 Skill 路由（返回 skill 名或空）
$O complete          <dir>                         完成 session
$O update-session    <dir> <section> <content> [mode]  更新 session.md (mode: append|replace，默认 append)，同时自动重建 context.md
$O inject-rag        <dir> <query>                 RAG 注入历史经验
$O consistency-check <dir> <type> [tid] <result>   上下文一致性校验
$O test-gate         <dir> <type> <result>         测试质量门记录
$O snapshot          <dir> <tid>                   创建 git 快照
$O rollback          <dir> <tid>                   回滚到指定 task，重置后续 task 为 PENDING
$O trend                                          编排趋势统计
$O advance-phase     --dir <dir> [--to <phase_id>]  推进 Phase 状态机
$O gate              --dir <dir> --gate-id <id> --decision <pass|fail|fix> [--reason <text>] [--report <JSON>]  Gate 决策（report 为结构化质量报告）
$O gen-template      --name <n> [--desc <d>] [--from <base>] [--force]  根据描述生成编排模板
$O validate-topology [--config path]              声明式拓扑校验
```

**记 pending 标准操作**（SKILL 中所有"记 pending.md"均执行此命令；**决策点**建议加 `hard:` 或 `soft:` 前缀，见 `references/governance-constitution.md`）：
```
[Shell] SEQ=$(($(wc -l < $DIR/pending.md) - 3)); echo "| $SEQ | {阶段} | $(date +%H:%M) | {决策点} | {自动选择} | {风险} |" >> $DIR/pending.md
```

## 架构定位

```
pipeline-orchestrator（编排层 — 只调度不执行）
  ├── OpenSpec Skills   → 内容生产（explore/propose/apply/archive）
  ├── optimization-master → 质量门（提案/代码/全局）
  ├── 测试 Skill        → 测试门（按项目实际情况路由）
  ├── 管理台 API (18000) → RAG 搜索 / 经验沉淀 / 趋势统计
  └── $O scripts        → 状态追踪、DAG 调度、日志、校验、Skill 路由
```

**核心原则**：编排层**只做 decompose / delegate / validate / escalate**，不承担实现逻辑。

**执行边界**：编排层允许内联的仅限**确定性、< 3 秒、无推理**的 Shell 命令（编译检查、git 操作、$O CLI 调用）。需要推理判断的操作（需求分析、代码实现、质量审查、一致性校验）**必须**委托给 SubAgent。

**职责分工**：OpenSpec 管内容，optimization-master 管质量，管理台管数据，$O 管状态与路由。

**分层治理宪法**（Rules / Agent / Skill / OpenSpec 边界与冲突优先级）→ `references/governance-constitution.md`。

**编排假设清单** → `references/assumptions.md`（H01-H12，定期检验，过时则简化对应规则）。

---

## Phase 路由

> **执行纪律**：严格按 Phase 顺序推进，每个 `[Shell]`/`[Task]` 步骤必须执行并检查结果，不得跳过、合并或凭记忆替代。
> **Phase 切换时**：读取对应 Phase 文件执行，不需要回读本文件的 Phase 详情。

| Phase | 文件 | 职责 |
|-------|------|------|
| 0 | `phases/phase-0-bootstrap.md` | 启动 + 规模判定 + Profile 选择 |
| 1 | `phases/phase-1-propose.md` | 探索 + 提案（OpenSpec/增强编排统一流程） |
| 2 | `phases/phase-2-session.md` | 创建 Session + 上下文注入 |
| 3 | `phases/phase-3-execute.md` | 执行循环（状态机 + spawn + 后置检查） |
| 4 | `phases/phase-4-complete.md` | 完成 + 全局审查 + 归档 |
| 5 | `phases/phase-5-feedback.md` | 经验反哺 + 改进建议 + 趋势 |

## 规模裁剪矩阵

| 步骤 | Step ID | 小 | 中 | 大 |
|------|---------|-----|-----|-----|
| Phase 0 前置+规模+Profile | — | ✓ | ✓ | ✓ |
| Phase 1 拆解/提案+RAG | — | 跳过 | ✓ | ✓ |
| Phase 1 需求确认 | — | 跳过 | ✓ | ✓ |
| Phase 1 轻量质量门 | `quality-gate-a-lite` | 跳过 | ✓ | ✓ |
| Phase 1 质量门 A | `quality-gate-a` | 跳过 | 跳过 | ✓ |
| Phase 1 用户审批 | — | 跳过 | ✓ | ✓ |
| Phase 2 创建 Session | — | ✓(2-小) | ✓(2A/2B) | ✓(2A/2B) |
| Phase 3 RAG 注入 | `rag-inject` | ✓† | ✓ | ✓ |
| Phase 3 产出校验 | — | ✓ | ✓ | ✓ |
| Phase 3 验收标准验证 | `acceptance-check` | ✓ | ✓ | ✓ |
| Phase 3 编译检查 | `compile` | ✓ | ✓ | ✓ |
| Phase 3 测试覆盖 delta | `test-coverage-delta` | ✓‡ | ✓‡ | ✓‡ |
| Phase 3 单元测试 | `unit-test` | ✓*† | ✓* | ✓* |
| Phase 3 增量回归测试 | `regression-test` | 跳过 | 跳过 | ✓* |
| Phase 3 CCC-2 | `ccc-2` | 跳过 | ✓ | ✓ |
| Phase 3 质量门 B | `quality-gate-b` | 跳过 | 跳过 | ✓ |
| Phase 3 快照 | `snapshot` | 跳过 | 跳过 | ✓ |
| Phase 3 计划偏离检测 | `plan-drift` | 跳过 | ✓ | ✓ |
| Phase 4 E2E 测试 | `e2e-test` | 跳过 | ✓* | ✓* |
| Phase 4 质量门 C + 总结 | — | 跳过 | ✓ | ✓ |
| Phase 4 完成+归档 | — | ✓ | ✓ | ✓ |
| Phase 5 经验总结与改进建议(5a，session-analysis.md) | — | 跳过 | ✓ | ✓ |
| Phase 5 趋势(5b) | — | 跳过 | 跳过 | ✓ |

*\* = 有测试框架时执行*
*† = 小规模新增：RAG 注入避免重复已知错误；单测（有框架时）是最低成本的正确性保障*
*‡ = 仅 `tdd_mode` ≠ `off` 时执行（由 `.pipeline-orchestrator.yaml` 配置控制）*

**Profile 叠加规则**：Profile 的 `skip_steps` 与规模裁剪矩阵取并集——两者任一标记跳过则跳过。Step ID 用于 Profile 配置中的 `skip_steps` 字段引用。无 Step ID 的步骤（如 Phase 0、Phase 2、Phase 4 完成）为必选步骤，不受 Profile 裁剪。

## 巡航模式

行为由 `templates/pipeline-orchestrator.yaml` 中的 `gate_mode` 控制（未读取到配置时等同 `auto`）：

### gate_mode: auto（默认 — 全自动巡航）

- 需求确认 → 提案自动生成 → 质量门自检 → **停：用户审批提案**（Phase 1g）
- 执行自动推进 → RAG 注入 → 验收标准验证 → 测试门 → 质量门 → 计划偏离检测
- 失败自动重试 `max_task_retries` 次（默认 1，可配 1~3）后标记 FAILED，下游依赖 task 由 `$O next` 自动级联标记 SKIPPED（原因 "dependency failed"）
- 所有自动决策写 `$DIR/pending.md`
- 完成后 → **停：用户验收**（Phase 4c-2，中/大规模） → Phase 5（中规模执行 5a，大规模执行 5a+5b）
- **必停点**：Phase 1g（计划审批）+ Phase 4c-2（结果验收）；其余自动推进

### gate_mode: interactive（交互式 — 关键节点暂停）

在以下节点暂停，向用户展示选项（**通过** / **要求修复** / **放弃本轮**）：
- **Phase 1g**：提案审批（与 auto 一致）
- **Phase 4c-2**：结果验收（与 auto 一致）
- **质量门 B 首次 FAIL**：展示失败检查项清单，用户决定是否修复
- **质量门 C FAIL**：展示全局审查问题，用户决定是否修复
- **编译/单测连续 FAIL**（重试后仍失败）：展示错误详情，用户决定是否跳过
- **CCC 严重偏离**（`aligned: false` 且 issues 数 ≥ 3）：展示偏离详情，用户决定是否继续

非上述节点时行为与 `auto` 一致（自动推进）。

### Dry-Run 模式（预览编排计划）

用户输入包含"dry-run"/"预览"/"看看怎么拆"/"模拟编排"时，或 `.pipeline-orchestrator.yaml` 中 `dry_run: true` 时激活。

- Phase 0 + Phase 1（含 RAG 搜索、代码探索、需求确认、需求拆解、质量门 A）**正常执行**
- Phase 1g 展示提案后标注 `[DRY-RUN] 预览结束`，**不进入 Phase 2**
- 不创建 session、不修改代码、不执行 git 操作
- 输出内容：规模判定、Profile 选择、task 列表（含依赖）、预估并行批次、RAG 风险提示
