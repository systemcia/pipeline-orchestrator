# 当 AI 写代码不再靠运气：Pipeline Orchestrator 编排引擎

> 让 AI Agent 从「能写代码」进化到「能交付项目」。

---

## 痛点：AI 写代码 ≠ AI 做项目

Cursor、Copilot 让「AI 写代码」成为日常。但需求稍微复杂，就会遇到：

- **需求拆了个寂寞**：AI 把所有东西塞进一个 task，或拆出互相打架的子任务
- **上下文全靠运气**：第 3 个 task 执行时，前两个 task 的接口契约已被「遗忘」
- **质量全凭人肉**：改完一个文件忘了改关联的另一个
- **出了错就螺旋**：修 bug A 引入 bug B，来回打补丁
- **经验无法沉淀**：上次踩过的坑，下次一样踩

这些不是模型的问题，是**编排层**的问题。

---

## Pipeline Orchestrator 是什么

一句话：**把 AI Agent 从「一杆子捅到底」变成工业级流水线**。

它是一套**编排协议 + 状态引擎 + 质量治理体系**，核心解决：

> 如何让 AI Agent 在真实项目中可靠地完成从需求分析到代码交付的完整闭环。

```
编排层（只调度不执行）
  ├── 9 个专职 SubAgent  → 各司其职（规划/执行/审查/修复/分析）
  ├── 6 Phase 流水线      → Bootstrap → Propose → Session → Execute → Complete → Feedback
  ├── 三级质量门          → 提案自检 → task 级审查 → 全局审查
  ├── 上下文一致性校验    → 防止 AI 写着写着就跑偏了
  ├── RAG 防幻觉          → 历史经验注入，同样的坑不踩两次
  └── 状态引擎 ($O CLI)   → DAG 调度、断点续传、回滚
```

**核心原则**：编排层只做 decompose / delegate / validate / escalate，绝不承担实现逻辑。

---

## 解决了哪些痛点

### 上下文丢失 → 上下文工程

每个 SubAgent 的上下文分层注入、动态裁剪，既不过少做错，也不过多迷失。

```
注入源分层：
  执行类 SubAgent → context.md（精简版，≤3000 字符）
  审查类 SubAgent → session.md（完整版）
  
注入预算动态计算：
  depends_on 0 个  → 1000 字符
  depends_on 1-2个 → 2000 字符  
  depends_on 3+个  → 3000 字符
```

### 质量全靠人肉 → 三级质量门

```
质量门 A（提案阶段）→ 质量门 B（task 级）→ 质量门 C（全局）
```

HARD_FAIL（编译/测试失败）自动走 error-fixer 修复；SOFT_FAIL 记录但不阻塞。

### 需求偏离 → CCC 一致性校验

三个时机自动触发：CCC-1（提案 vs 需求）、CCC-2（代码 vs task）、CCC-merge（并行合并冲突检测）。

### 经验无法复用 → RAG + 经验反哺

Phase 5 自动总结经验教训，下次编排时 RAG 检索注入。

---

## 9 个 SubAgent 各司其职

| 角色 | 职责 |
|------|------|
| planner | 需求分析与任务拆解 |
| executor | 开发任务执行 |
| quality-reviewer | 代码审查（质量门 B/C） |
| evaluator | 提案评估（质量门 A） |
| consistency-checker | 上下文一致性校验 |
| error-fixer | 编译/测试修复 |
| codebase-researcher | 代码库探索（只读） |
| tester | 测试用例生成 |
| session-analyst | 会话复盘与经验沉淀 |

## 规模自适应

Phase 0 自动判定规模，小需求跳过重流程，大需求全保障。支持 Profile 叠加（hotfix/thorough）。

## 状态引擎：断点续传 + 回滚

`$O` CLI 管理所有状态，文件锁保证原子性，中断后自动从 `state.json` 恢复。

---

## 快速上手

```bash
# 安装
bash install.sh

# 在 Cursor 中任意项目触发
# 输入 /pipeline 或 "帮我编排"
```

只需 Python 3.10+ 和 Cursor IDE，无需 Node.js。

可选安装管理台（server 侧）获得 RAG 搜索、Web UI、趋势统计等增强功能。

---

## 设计哲学

1. **编排层只调度不执行** —— 推理判断全部委托 SubAgent
2. **角色分离 > 全能 Agent** —— 审查者不是实现者
3. **声明 > 内联** —— 角色定义外部化，拓扑声明可校验
4. **防幻觉 > 信任** —— 真相源标注、负面约束、RAG 接地
5. **经验闭环 > 一次性** —— 每次编排经验自动沉淀
6. **规模自适应 > 一刀切** —— 小需求轻量，大需求全保障

---

*Pipeline Orchestrator 是一个开源项目，欢迎 Star 和 Contribute。*
