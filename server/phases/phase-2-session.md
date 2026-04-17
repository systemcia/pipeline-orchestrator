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
```
[Shell] $O init --project $PROJECT_ID "<name>" '[{"name":"<name>","description":"<需求全文，含验收标准>","depends_on":[]}]' 'small'
```

## 通用（MUST 全部执行）

记录 `$DIR` = `$O init` 输出的 `session_dir` 字段值。

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

```
[Shell] $O advance-phase --dir $DIR
```

→ Phase 3
