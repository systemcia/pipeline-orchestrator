# 编排假设清单

> 每条编排规则都编码了一个假设——「模型自己做不到这件事」。随着模型能力提升，这些假设应定期检验，过时则简化对应规则。（参考 Anthropic Harness Design 理念）

## 假设表

| ID | 假设内容 | 来源规则 | 检验条件（何时可废弃） |
|----|---------|---------|---------------------|
| H01 | 单次 SubAgent 无法可靠处理 >5 文件的一致性校验 | CCC-2 内联/spawn 阈值 ≤5（Phase 3-e） | 模型能在单次会话中准确校验 7+ 文件的设计一致性（需 benchmark） |
| H02 | 执行类 SubAgent 会被过长上下文干扰（注意力衰减） | 防失忆协议摘要策略、token 预算 | 模型在 100k+ token 上下文中仍保持 >95% 指令遵循率 |
| H03 | AI 自审代码存在自信偏差（Generator 夸赞自身产出） | 质量门 B/C 审查与开发 SubAgent 分离 | 模型自审准确率与独立审查持平（需对照 benchmark） |
| H04 | 编译检查属于轻量操作，不需 SubAgent 上下文隔离 | 编译检查主 Agent 内联（3-d） | （已验证有效，保留为基线假设） |
| ~~H05~~ | ~~Cursor Task 工具仅支持串行 spawn~~ | ~~并行就绪占位~~ | **已废弃**（2026-04-07）：Cursor Task 原生支持同消息多 Task 并行 spawn。对应规则已更新为 Phase 3 并行优先批处理。 |
| H06 | 百分比评分不可客观复现，需逐条 PASS/FAIL | 质量清单（quality-checklist.md）+ 提案清单（proposal-checklist.md） | （已验证有效并已推广至 evaluator，保留为基线假设） |
| H07 | session.md 当前格式足以承载 LLM 所需的全部语义上下文 | session.md 模板（session-format.md） | 出现 LLM 因 session.md 信息不足导致的重复错误模式（需 lessons.md 统计） |
| H08 | quality-checklist.md 的检查项适用于所有语言和项目类型 | 质量门 B/C 通用 checklist | 某类项目的 N/A 率持续 > 50%，说明需要语言/项目特定的 checklist |
| H09 | 单次 chat context 内编排超过 15 次 Shell/Task 调用后，LLM 编排质量显著下降 | Context Reset 协议（protocols.md） | 模型在 30+ 次调用后仍保持 >90% 指令遵循率 |
| H10 | RAG 搜索返回的历史经验能有效减少重复错误 | RAG 注入（Phase 1b / 3-a） | 关闭 RAG 后的错误率与开启时无统计显著差异（需 A/B 对照） |
| H11 | 需求拆解需要专职角色（planner），不能由通用 SubAgent 兼任 | planner.md（Phase 1d） | 通用 SubAgent 的需求拆解质量（验收标准完整性、依赖准确性）与 planner 无统计差异 |
| H12 | 轻量审查（≤3 项/文件）可由主 Agent 内联执行而不损失准确性 | quality-reviewer Delta 重检内联（≤3）+ 质量门 B 内联（≤3 文件）+ CCC-2 内联（≤5 文件，H01） | 内联审查的 FAIL 漏检率 > 独立 SubAgent 审查的 10%（需 A/B 对照） |

## 维护机制

- Phase 5 经验反哺时，`lessons.md` 可包含「假设复审建议」字段，标记哪些假设的检验条件可能已被满足
- Phase 5b harness 分析时可引用 session 目录下 **`telemetry.jsonl`** 的统计（如 Shell/Task 等效调用节奏、失败聚类）作为 **H09** 等假设的复审证据，无需改 harness 代码亦可人工对照
- 当某条假设的检验条件被确认满足时，在下次编排优化 change 中简化对应规则
- 基线假设（H04/H06 等已验证的）保留作为设计决策记录，不需废弃

### 废弃假设记录格式

废弃时在假设表中使用删除线标记 ID 和内容，「检验条件」列改为 `**已废弃**（日期）：废弃原因 + 对应规则变更说明`。废弃的假设保留在表中作为设计决策历史，不删除行。
