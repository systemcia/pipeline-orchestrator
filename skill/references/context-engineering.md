# 上下文工程（Context Engineering）

> 本文件从 `protocols.md` 抽取，集中管理 SubAgent 上下文注入的所有策略。`protocols.md` 保留**防失忆协议**的总述和跳转引用，细节规则在此。

## 注入源分层

| SubAgent 类型 | 主注入源 | 补充源 |
|--------------|---------|--------|
| 执行类（executor / error-fixer） | `$DIR/context.md`（精简版，≤3000 字符） | 任务描述 + `$DIR/design-brief.md`（按需摘要或路径指针，见下）+ 设计上下文按需追加 |
| 审查类（quality-reviewer / evaluator / consistency-checker） | `$DIR/session.md`（完整版） | 需求全文 + 约束完整注入 |
| 规划类（planner / codebase-researcher） | `$DIR/session.md`（完整版） | 用户原始需求完整注入 |
| 反馈类（session-analyst） | `$DIR/session.md` + `$DIR/logs/` | 完整会话记录 |

执行类 SubAgent 使用 `context.md` 而非 `session.md`，避免过长上下文干扰（对应假设 H02）。审查类需要完整信息以做出准确判断，因此使用 `session.md`。

### design-brief.md（执行类）

Planner 信封中的 `design_brief` 由 Phase 1d 解析暂存，Phase 2 `$O init` 后落盘为 `$DIR/design-brief.md`。执行类 SubAgent 将其视为**设计侧补充源**，注入策略与「用户原始需求摘要 + session 路径指针」同一风格：**默认不假设全文进窗**，由编排层按预算择一或组合：

1. **摘要**：从四块语义（接口签名、数据模型、模块交互、技术决策）中抽取与本 task 最相关的段落，总长建议 ≤600 字符；不足覆盖处附文件路径指针（`$DIR/design-brief.md`）供按需读取。
2. **路径指针**：仅注入一行指针（路径 + 一句「完整设计见该文件」），适用于 brief 已在同一次 spawn 的其它位置出现、或即将超预算时。
3. **择重**：若 Phase 3-c 模板已通过 `{design_brief}` 将 `$DIR/design-brief.md` **全文内联**进本次 executor prompt，则追加的「设计上下文」块**不得再重复贴全文**；改为指针或本 task 相关的一句对照提示即可，避免双倍占用 token 预算。若模板侧为缺失降级措辞（未带正文），则在本块用摘要补齐设计要点。

上述摘要/指针**计入**执行类动态预算（与「设计上下文」同属可裁剪块；通用约束仍不计入）。与 `{design_brief}` 的关系：**模板占位负责把落盘文件接进 prompt 构造；本文负责 SubAgent 侧预算与裁剪语义**，二者分工不同、可叠加但应避免同文重复满量注入。

### context.md 生成机制

`context.md` 由引擎 `$O update-session` 命令自动重建（每次调用 `update-session` 时同步更新），无需编排层手动维护。其内容为 `session.md` 的精简投影：

| session.md 区段 | context.md 映射 | 裁剪规则 |
|----------------|----------------|---------|
| 用户原始需求 | 需求摘要 | 按当前 task 相关度摘要，≤800 字符 |
| 关键约束和决策 | 通用约束（完整） + 领域约束（前 3 条） | 通用约束永不裁剪 |
| 当前阶段详情 | 最近 3 个 task 的产出摘要 | 更早的 task 被归档 |
| 历史经验 | 最相关 1 条 | 按 task 关键词匹配 |

总量硬限制：≤3000 字符。超出时按裁剪优先级（见下方）逐级削减。

## 注入预算

### 执行类 SubAgent

除通用约束外的各上下文注入块（需求摘要 + 领域约束 + 前置产出 + RAG + design-brief 摘要/指针 + 设计上下文）总量按 **task 规模分档（O8）** 与 **`depends_on` 基数**联合计算（不含任务描述、固定格式框架和通用约束）。

#### O8：规模分档（小 / 中 / 大）

| 档位 | 典型含义 | 判定信号（优先级从高到低，命中即定档或升档） |
|------|----------|---------------------------------------------|
| **小** | 单文件改动、局部补丁 | ① task 描述/范围锁定明确「单文件」或等价；② 计划变更路径可收敛为 1 个文件；③ 无跨包/跨顶层目录耦合描述 |
| **中** | 多文件、同模块或同子树 | ① 2 个及以上文件且仍在同一顶层模块子树（如仅 `server/` 内）；② 或 `depends_on` 为 1–2 且描述涉及多文件协同；③ `owns_globs` 条目数 ≥2 |
| **大** | 跨模块、契约面多 | ① 显式「跨模块 / 跨包 / 前后端 / 多服务」等；② 变更路径跨两个及以上顶层目录（如 `server/` + `web/`）；③ 或 `depends_on ≥ 3`（与前几项组合时至少定为**中**，若已跨模块则**大**） |

**定档规则**：按 **大 → 中 → 小** 顺序检视（先检高档信号，避免小改动被低估）；各行内 **① 优先于 ② 优先于 ③**。若低档形态与高档信号冲突（例如单文件但 `depends_on ≥ 3`），**取较高档**，避免上下文不足。

#### O8：分档建议上限（与 depends_on 衔接）

先由 `depends_on` 得到基数 `base_by_deps`（与下表一致，不变），再按档位施加**上限封顶**，得到可注入块总预算：

```
budget = max(floor_tier, min(cap_tier, base_by_deps))
```

| depends_on 数量 | base_by_deps | 典型场景 |
|-----------------|-------------|---------|
| 0 | 1000 | 简单独立 task，少量上下文即可 |
| 1-2 | 2000 | 有前置依赖，需要接口契约 |
| 3+ | 3000 | 复杂交叉 task，需要更多上下文 |

| 档位 | cap_tier（建议上限） | floor_tier（建议下限） | 与 base_by_deps 的关系 |
|------|---------------------|------------------------|-------------------------|
| **小** | 1400 | 800 | `base_by_deps` 可被压到 ≤1400，避免小改动窗口被历史块占满 |
| **中** | 2400 | 1000 | 在中小依赖基数上留足多文件契约，仍低于全局硬顶 |
| **大** | 3000 | 1200 | 与历史「≤3000 字符」硬顶对齐；高依赖时取满 `base_by_deps` |

`context.md` 全量仍受「≤3000 字符」硬限制（见上文映射表）；**本公式仅约束「可计入预算的注入块」之和**，与 `depends_on` 动态公式为**衔接关系**：`base_by_deps` 不变，**O8 增加 `floor_tier`/`cap_tier` 两层夹逼**，使规模与依赖同时参与预算。

通用约束始终完整注入，不计入预算。规划/审查类不设上限。

### 规划/审查类 SubAgent

不设 token 预算上限。用户原始需求完整注入，关键约束完整注入。

## 上下文裁剪优先级

执行类 SubAgent 总量超预算时，按此顺序裁剪（序号越大越先裁）：

1. 通用约束（范围锁定类） — **永不裁剪**
2. 用户原始需求 — 执行类按 task 相关度摘要（≤800 字符）+ session 路径指针
3. 领域约束 — 保留与本 task 最相关的 3 条
4. 前置 task 产出 — 默认：仅保留接口签名，删除文件列表；**大档（O8）** 时优先保留「接口变更摘要 + 变更文件列表」的压缩版（各一行要点），再删冗长正文；仍超预算再退回「仅接口签名」
5. design-brief / 设计上下文 — `design-brief.md` 先缩为指针或更短摘要；仍超预算则设计上下文仅保留当前 task 对应的 spec 片段
6. RAG 历史经验 — 减少到最相关 1 条或丢弃
7. 非依赖 task 详情 — 丢弃

规划/审查类裁剪优先级：用户原始需求完整注入 → 关键约束完整注入 → 其余按相关度裁剪。

## O18：task 完成后增量丰富（供后续 task 消费）

每个 task **成功结束**（如 `$O done` 校验通过、state 进入 COMPLETED）时，编排层应将**可机读、可裁剪**的增量写回会话落盘，使下一次 `update-session` 重建的 `context.md` 中「最近 task 产出」携带足够契约信息，而不过度依赖主 Agent 口述。

### 追加内容（固定两类）

1. **变更文件列表**：相对仓库根的路径列表；与 SubAgent 汇报的「修改了哪些文件」一致即可，便于后续 task 做范围与冲突判断。
2. **接口变更摘要**：仅导出面（公开函数/类型/路由/配置键等）的新增、签名变更、废弃说明；一句话级条目即可，避免整文件贴码。

### 提取来源（按可操作性排序）

| 来源 | 提取方式 |
|------|----------|
| **SubAgent 输出** | 从 executor / error-fixer 的结构化汇报中摘取：「修改文件」「新增/变更的导出符号」小节；若无小节，由编排层从正文用固定模板追问一行摘要 |
| **diff 摘要** | 对本次 task 涉及文件执行 `git diff`（或引擎等价的 diff 摘要）：统计路径 + 对 hunk 做「仅导出符号/接口行」的摘要；禁止把大段实现细节写入 context |

### 落盘与消费路径

- **写入**：追加到 `session.md`「当前阶段详情」中**该 task 的产出段落**（与现有 task 摘要并列）；引擎 `update-session` 将其映射为 `context.md`「最近 3 个 task 的产出摘要」的一部分（见上文映射表）。
- **消费**：后续 task 的执行类注入从 `context.md` 读取；若带 `depends_on`，优先保留依赖 task 的「变更文件列表 + 接口变更摘要」条目，再纳入本轮需求摘要（与裁剪优先级第 4 条一致）。

### 与 depends_on / O8 的关系

- 增量丰富**不替代** `depends_on` 拓扑；它为依赖边提供**事实摘要**，减少「只知道依赖 id 不知道改了什么」的空洞。
- **大档**或 **depends_on ≥ 2** 时，编排层应更严格校验本块非空（至少文件列表或接口摘要其一），否则后续 task 易重复踩坑。

## 用户画像注入规则

当 `.cursor/rules/user-profile.mdc` 存在时：

| 角色类型 | 注入维度 | 字符上限 |
|---------|---------|---------|
| 执行类（executor / error-fixer） | 编码风格 + 项目约定 | ≤300 |
| 审查类（quality-reviewer / consistency-checker / evaluator） | 项目约定 + 沟通风格 | ≤200 |
| 研究类（codebase-researcher / planner） | 技术画像 | ≤200 |
| 编排/自优化类（session-analyst） | 不注入 | 0 |

画像摘要**计入 token 预算**。画像为偏好默认值，**不覆盖安全/正确性要求**。

## 语言特化 Hints

编排层在构造执行类 SubAgent prompt 时，根据 task 涉及的变更文件扩展名注入 `{language_hints}`：

| 文件扩展名 | language_hints 内容 |
|-----------|-------------------|
| `.go` | 遵循 Go 标准：go vet 通过、error 不可吞、导出函数有注释 |
| `.ts` / `.tsx` | TypeScript strict mode、避免 any、组件 Props 类型显式声明 |
| `.py` | type hints、docstring、避免 bare except |
| `.java` | 遵循项目 checkstyle 规则、异常不可吞 |
| 其他/混合 | 不注入，使用通用约束 |

多种语言混合时，按变更文件数量最多的语言注入。

## Context Reset 协议

大规模编排（4+ tasks）时，主 Agent 的 context window 会因大量 Shell/Task 调用而膨胀，导致后期 task 的编排质量下降（对应假设 H09）。

### context_usage 指标

`context_usage` = 当前会话中已执行的 Shell + Task 调用总数（主 Agent 自行计数）。

### 触发条件

Phase 3 每批 task 后置检查全部完成后，检查 `context_usage`：
- `context_usage ≥ 15` → 触发 Reset 建议
- `context_usage < 15` → 不触发，继续下一批

### 触发前持久化检查

输出 Reset 建议前，**MUST** 确保以下持久化已完成：
- 当前批次所有 task 的 state.json 状态已更新（COMPLETED/FAILED）
- session.md 的「当前阶段详情」已追加本批次 task 的产出摘要
- 所有 pending.md 决策已记录
- `$O validate $DIR` 无 ERROR

### 建议消息模板

```
当前编排进度：{completed}/{total}。context 使用量较高（{context_usage} 次调用），建议在新 context 中继续以保持编排质量。
- 继续当前 chat → 输入"继续"
- 开启新 chat → 执行 `/pipeline` 自动恢复
```

### 行为约束

- Reset 为**建议性**，用户选择继续当前 chat 时编排正常推进
- 用户开启新 chat → Phase 0b 自动检测未完成 session，从 state.json 恢复

### 与自动压缩的关系

`engine.py` 的 `update-session` 在 `session_md_lines > 300` 时自动压缩 `当前阶段详情` section（保留最近 3 个 task，其余归档到 `archive-session.md`）。

- **自动压缩是 Reset 的前置防线**：通过控制 session.md 体积，延缓 context_usage 触发 Reset 的时机
- **两者互补不替代**：压缩减少 SubAgent 注入的上下文量，Reset 刷新主 Agent 的 context window
- 压缩发生在引擎侧（每次 `update-session` 自动检查），Reset 由主 Agent 在 Phase 3 每批后置检查后触发
