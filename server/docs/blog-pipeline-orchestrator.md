# Pipeline Orchestrator 管理台：AI 编排的数据中枢

> 不只是仪表盘，是整个编排体系的数据层。

---

## 为什么需要管理台

Pipeline Orchestrator 的核心编排能力由 Skill 侧提供，纯文本 + Python 脚本即可运行。但在实际使用中，你会发现：

- 编排了 60+ 次 Session 后，CLI 查看状态越来越吃力
- 上次某个项目踩的坑，这次换个项目又踩了一遍
- 不知道哪些 task 最容易失败，无法针对性改进
- 团队成员想复用你的编排经验，但经验散落在各个 Session 文件里

管理台解决的就是这些问题。

---

## 核心功能

### Session 管理

所有编排 Session 的全生命周期管理：列表、详情、Task 日志、快照、数据校验。

### RAG 知识搜索

历史经验自动提取为可搜索知识。编排时 SubAgent 自动检索相关经验注入 prompt——上次踩的坑，这次主动避开。

### 编排趋势

成功率、失败率、Top 失败原因、日趋势。数据说话，知道编排质量是在变好还是变差。

### 反馈提案聚合

跨 Session 汇总 Phase 5 产出的改进建议，发现系统性问题。

### Token 统计

每次编排的 AI 消耗追踪，知道钱花在哪。

### 实时状态推送

WebSocket 推送 Session/Task 状态变化，无需轮询。

---

## 架构

**双引擎**：Python 侧承载流程引擎，Node.js 侧承载管理台 API 和前端。

```
管理台（数据中枢）
├── packages/server/     → Fastify API（Session / RAG / 趋势 / 事件）
├── packages/shared/     → 共享类型定义
├── packages/generator/  → 声明式 Skill 生成器
├── web/                 → React + Ant Design 前端
├── scripts/sync/        → 数据同步引擎（Cursor → pipeline.db）
└── scripts/engine.py    → 状态引擎（$O CLI）
```

### 三层数据源

| 数据源 | 写入方 | 功能 |
|--------|--------|------|
| Session 文件系统 | engine.py | Session 管理、编排趋势、反馈提案 |
| pipeline.db | sync 定时任务 | 效能分析、知识库、RAG、Token 统计 |
| ai-tracking.db | Cursor IDE | AI 代码追踪统计 |

---

## API 一览

```
GET  /api/sessions                        # Session 列表
GET  /api/sessions/:id                    # Session 详情
GET  /api/analytics/pipeline-trend        # 编排趋势
GET  /api/analytics/feedback-proposals    # 改进提案聚合
GET  /api/knowledge/rag-search?q=...      # RAG 语义搜索
GET  /api/knowledge/stats                 # 知识库统计
GET  /api/knowledge/token-stats           # Token 消耗统计
```

---

## 快速上手

```bash
# 安装
cd server
bash install.sh

# 启动
npm run dev
# 后端: http://localhost:18000
# 前端: http://localhost:18001
```

或 Docker 一键启动：

```bash
docker compose up -d
```

---

## 数据说话

以下是实际运行数据：

| 指标 | 数值 |
|------|------|
| 累计编排 Session | 60+ |
| 平均 task 数/session | 3.2 |
| task 一次通过率 | 78% |
| 经验命中率（RAG） | 65% |
| 质量门拦截率 | 42%（30% 为真实问题） |
| 编排覆盖代码行 | 21 万+ |

---

## 与 Skill 的关系

管理台不是编排必需品。Skill 侧完全独立运行，管理台不在时所有功能自动降级。

安装管理台后，编排引擎自动检测并启用：
- RAG 经验注入
- 经验/改进建议上传
- 趋势统计
- Session 可视化

---

*Pipeline Orchestrator 是一个开源项目，欢迎 Star 和 Contribute。*
