# Phase 0: 启动 + 规模判定

## 0a. 前置检查

```
[Shell] python3 --version && echo "OK" || echo "MISSING: python3"
[Shell] curl -sf http://localhost:18000/api/config >/dev/null && echo "管理台 OK" || echo "WARN: 管理台未启动，RAG/趋势降级"
[Shell] ls .cursor/rules/project-context.mdc 2>/dev/null && echo "项目规则 OK" || echo "WARN: 缺少项目规则文件"
[Shell] ls .cursor/rules/user-profile.mdc 2>/dev/null && echo "用户画像 OK" || echo "INFO: 无用户画像，SubAgent 使用通用风格"
```

### 项目标识检测（MUST）

```
[Shell] PROJECT_ID=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
[Shell] FULL_PATH=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
[Shell] SESSIONS_ROOT=${PIPELINE_SESSIONS_DIR:-/opt/pipeline-orchestrator/sessions}
```

**同名冲突检测**：不同仓库路径可能产生相同 `basename`（如 `~/proj-a/api` 和 `~/proj-b/api` 都解析为 `api`）。检测方式：扫描已有 session 的 `state.json` 中 `project_id` 对应的实际工作目录：

```
[Shell] CONFLICT=false; for d in "$SESSIONS_ROOT/$PROJECT_ID"/pipe-*/state.json; do [ -f "$d" ] || continue; SESSION_CWD=$(python3 -c "import json;s=json.load(open('$d'));print(s.get('cwd',''))" 2>/dev/null); if [ -n "$SESSION_CWD" ] && [ "$SESSION_CWD" != "$FULL_PATH" ]; then CONFLICT=true; break; fi; done; if [ "$CONFLICT" = "true" ]; then PROJECT_ID="${PROJECT_ID}-$(echo "$FULL_PATH" | md5sum | cut -c1-4)"; fi
[Shell] echo "PROJECT_ID=$PROJECT_ID"
```

> **降级**：若 `state.json` 无 `cwd` 字段（旧版引擎），碰撞检测跳过，使用原始 `PROJECT_ID`。引擎 `init` 应在 `state.json` 中记录 `cwd` 字段（值为当前工作目录绝对路径）。

`$PROJECT_ID` 在后续 Phase 2 的 `$O init --project $PROJECT_ID` 中使用。

管理台不可用**不阻塞**编排，仅 RAG 和趋势功能降级。python3 不可用**阻塞**编排。

### 拓扑校验（可选）

```
[Shell] $O validate-topology [--config .pipeline-orchestrator.yaml] && echo "拓扑校验 OK" || echo "WARN: 拓扑声明校验失败，请检查 topology 块"
```

校验不通过**不阻塞**编排（拓扑是补充校验层），但会输出具体的结构问题供开发者修复。详见 `references/topology.md`。

`project-context.mdc` 不存在时，在 Phase 0 结束前**提示用户**：
> "检测到缺少 `.cursor/rules/project-context.mdc`，SubAgent 将无法感知项目技术栈和架构约定。建议使用 `/create-rule` 生成项目规则文件（含技术栈、目录结构、代码规范、术语表）。是否现在生成？"
- 用户确认 → 调用 `/create-rule` 生成后继续
- 用户跳过 → 继续编排，SubAgent 使用通用角色（效果会降级）

## 0b. 检查已有 session

```
[Shell] $O list --project $PROJECT_ID
```

- 有未完成 session → 展示列表，问用户"继续"还是"新建"
- 用户选继续 → 从 `$O list` 输出中取对应 session 的 `dir` 字段作为 `$DIR`，读取 `$DIR/state.json` 获取 `scale` 确定规模裁剪、`profile` 确定编排 profile（无则按 scale 匹配默认 profile）、`openspec_change` 确定是否为 OpenSpec 模式，读取 `$DIR/session.md` 恢复上下文，读取 `$DIR/analysis-trace.md`（如存在）恢复需求分析链路。**如有 RUNNING 状态的 task**（上次中断遗留），在 Phase 3 的 3.1 步骤中会自动处理（过期清理）
- 恢复时如 `pending.md` 行数 > 3（超过表头），向用户展示：「上次编排有 N 个待确认事项」+ pending.md 内容摘要
- 恢复后 → 跳到 Phase 3
- 无未完成 / 用户选新建 → 继续 0c

## 0b-2. Dry-Run 检测

如果用户输入包含"dry-run"、"预览"、"看看怎么拆"、"模拟编排"关键词，或 `.pipeline-orchestrator.yaml` 中 `dry_run: true`：
- 设置 `MODE=dry-run`
- Phase 1g 展示后标注 `[DRY-RUN] 预览结束`，不进入 Phase 2

未命中则 `MODE=normal`，正常继续。

## 0c. 命名 + 规模判定

`<name>` = 需求的 kebab-case 简称（如 "用户认证模块" → `user-auth-module`），全流程统一使用。

规模判定（根据需求的显式特征判断）：

| 判定锚点 | 规模 | 后续 Phase |
|----------|------|-----------|
| 需求是单一功能/修复/调整，无跨模块依赖 | 小 | 直接 Phase 2-小 → Phase 3 |
| 需求涉及 2~3 个模块或有前后依赖的步骤 | 中 | Phase 1 → 2 → 3 → 4 |
| 需求涉及 4+ 个功能点、跨多模块、需设计评审 | 大 | Phase 1 → 2 → 3 → 4 → 5（全流程） |

**规模决定后续哪些步骤执行、哪些跳过**——见 SKILL.md「规模裁剪矩阵」。

## 0d. Profile 选择

规模判定后，读取 `templates/pipeline-orchestrator.yaml`（或项目根目录 `.pipeline-orchestrator.yaml`）中的 `profiles` 配置：
1. 需求文本匹配 profile 触发词（如包含"紧急"/"hotfix" → `hotfix` profile）→ 使用匹配的 profile
2. 无触发词匹配 → 按规模选择：小 → `small`，中/大 → `default`（大规模且需求含"全面"/"thorough" → `thorough`）
3. 配置文件不存在或无 `profiles` 字段 → 完全由规模裁剪矩阵决定（兼容旧配置）

Profile 的 `skip_phases`/`skip_steps` 与规模裁剪矩阵取**并集**（两者任一跳过则跳过）。Profile 的 `force_serial` 为 true 时，Phase 3 强制串行执行（禁用并行 spawn）。Profile 的 `gates` 覆盖默认 Gate 位置。

选定的 profile 名称传递给 Phase 2 的 `$O init` 命令，引擎自动记录到 `state.json` 的 `profile` 字段。

### 模板选择（可选）

如果项目根目录存在 `.pipeline-orchestrator.yaml` 且包含 `template` 字段，或用户指定了模板：

1. 自动检测：`$O validate-topology` 的输出中包含 template 信息
2. 手动指定：`$O init --template <name>` 传入模板名
3. 模板合并：模板 > profile > 默认值

可用模板：
- `backend-only`: 纯后端项目
- `go-react-fullstack`: Go + React 全栈项目
- 自定义模板：`templates/*.yaml`

## 0e. automation_tier（与 Profile 正交）

读取同一配置文件中的 `automation_tier`（整数 0–3）：

- **缺省或字段不存在** → 视为 **2**（与模板默认值一致）
- 向用户一句话展示：`automation_tier={N}`（例如「当前自动化等级 tier=2」），**不阻塞**后续 Phase

**tier → Profile/gate_mode 自动映射**（编排层内联执行，引擎不读取此字段）：
- **tier 0** → 设置 `MODE=dry-run`（等效 `dry_run: true`，仅 Phase 0+1 预览）
- **tier 1** → 在当前 Profile 的 `skip_steps` 基础上追加 `[ccc-2, quality-gate-b, regression-test]`
- **tier 2** → 不修改（默认行为）
- **tier 3** → 强制选择 `thorough` profile + `gate_mode: interactive`

与 Profile 同时生效时 **取更保守**（更多 `skip_steps` / 更严门控的一方优先）

## 0f. 初始化 ANALYSIS_TRACE（MUST）

规模判定 + Profile 选择完成后，初始化需求分析追踪变量：
```
ANALYSIS_TRACE="# 需求分析追踪

> 生成时间: $(date -Iseconds)
> 编排模式: $MODE
> 规模判定: $SCALE
> Profile: $PROFILE

## 1. 规模判定依据
- **判定结果**: $SCALE
- **判定理由**: <命中的锚点及理由>"
```
后续 Phase 1 各步骤通过追加 `ANALYSIS_TRACE` 变量记录分析过程，Phase 2 `$O init` 后落盘为 `$DIR/analysis-trace.md`（见 `references/session-format.md`「analysis-trace.md 模板」）。

### Phase 状态机推进

Phase 0 尚未创建 session（`$DIR` 不存在），不执行 `$O advance-phase`。Phase 状态机在 Phase 2 的 `$O init` 中自动初始化为 `phases[0]=ACTIVE`，Phase 2 结束时执行首次 `advance-phase`。

→ Phase 1（中/大规模）或 Phase 2-小（小规模）
