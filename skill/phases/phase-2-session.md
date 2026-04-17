# Phase 2: 创建 Session + 上下文注入

## 2A（OpenSpec 模式）

```
[Shell] openspec instructions apply --change "<name>" --json
```

读返回的 tasks，转换为 `$O init` 的 JSON 格式（保留 id/name/description/depends_on；**每项增加 `openspec_task_id`**，与 `openspec/changes/<name>/tasks.md` 中行首 **N.M** 一致，供 `$O validate` 漂移比对）：

```
[Shell] export PIPELINE_OPENSPEC_CHANGE="<name>"
[Shell] export PIPELINE_OPENSPEC_REPO_ROOT="$(pwd)"
[Shell] $O init --project $PROJECT_ID "<name>" '<转换后 JSON>' '<profile>'
```

（`PIPELINE_*` 亦可省略：则不在 state 中记录 OpenSpec 路径，validate 仅做数据完整性检查。）

## 2B（增强编排模式）

```
[Shell] $O init --project $PROJECT_ID "<name>" '<Phase 1 拆解的 tasks JSON>' '<profile>'
```

## 2-小（小规模专属 — 跳过 Phase 1 时使用）

orchestrator 直接构造单 task JSON，向用户简要展示：

> **我的理解**：{一句话概括需求意图}
> 将执行 1 个 task: `<name>` — `<描述摘要>`，确认？

用户确认后：

**补充 ANALYSIS_TRACE**（小规模，Phase 0 已初始化 §1，此处补齐 §2 和 §5）：
```
ANALYSIS_TRACE+="

## 2. 需求理解与确认
- **原始输入**: <用户需求原文>
- **结构化理解**: {一句话概括}
- **确认结论**: 用户确认

## 3. 历史经验检索
延迟到 Phase 3 RAG 注入（小规模在执行前注入）

## 4. 代码探索发现
跳过（小规模）

## 5. 需求拆解推理
- **拆解策略**: 单 task 直接执行（小规模无需多 task 拆解）
- **task**: <name> — {为什么这样定义 task 的描述和验收标准}

## 6. 质量门审查记录
跳过（小规模）

## 7. 用户审批
- **用户反馈**: 确认
- **最终决策**: 确认执行"
```

```
[Shell] $O init --project $PROJECT_ID "<name>" '[{"name":"<name>","description":"<需求全文，含验收标准>","depends_on":[]}]' 'small'
```

## 通用（MUST 全部执行）

记录 `$DIR` = `$O init` 输出的 `session_dir` 字段值。

**Phase 状态机追赶**（init 后 current_phase=0，需追赶到 Phase 2）：

中/大规模（走过 Phase 1）：
```
[Shell] $O advance-phase --dir $DIR          # Phase 0→COMPLETED, Phase 1→ACTIVE
[Shell] $O gate --dir $DIR --gate-id "after-propose" --decision pass --reason "用户确认"
[Shell] $O advance-phase --dir $DIR          # Phase 1→COMPLETED, Phase 2→ACTIVE
```

小规模（跳过 Phase 1）：
```
[Shell] $O advance-phase --dir $DIR --to 2   # Phase 0→COMPLETED, Phase 1→SKIPPED, Phase 2→ACTIVE
```

**analysis-trace.md 落盘**（MUST，所有规模均执行）：
```
[Shell] echo "$ANALYSIS_TRACE" > $DIR/analysis-trace.md && echo "analysis-trace.md 已落盘"
```

**design-brief.md 落盘**（增强编排模式，Phase 1d-1 暂存了 `DESIGN_BRIEF` 时）：
```
[Shell] [ -n "$DESIGN_BRIEF" ] && echo "$DESIGN_BRIEF" > $DIR/design-brief.md && echo "design-brief.md 已落盘" || echo "INFO: 无 design_brief（小规模或 OpenSpec 模式）"
```

```
[Shell] $O update-session $DIR "用户原始需求" "<需求原文>" replace
[Shell] $O update-session $DIR "关键约束和决策" "<EXPLORE_SUMMARY（如有）+ 约束列表>" replace
```

> `EXPLORE_SUMMARY` 来自 Phase 1c 探索产出（无探索时为空，不影响注入）。

管理台可用时：
```
[Shell] $O inject-rag $DIR "<需求关键词>"
```

## Transition Gate（Phase 2 → 3 前置校验，MUST 执行）

Session 创建完成后，进入 Phase 3 前校验 session 完整性：

```
[Shell] $O validate $DIR
```

校验通过 → Phase 3。校验失败 → 检查 stderr 修复后重试（通常是 session.md 未写入或 tasks 为空）。

### Phase 状态机推进

上方「Phase 状态机追赶」已将 current_phase 推进到 2，此处推进到 Phase 3：
```
[Shell] $O advance-phase --dir $DIR          # Phase 2→COMPLETED, Phase 3→ACTIVE
```

→ Phase 3
