# Pipeline Orchestrator — Server（管理台）

管理台是编排引擎的数据中枢和可视化平台，提供 Web UI、API、RAG 搜索、趋势统计、Session 管理等增强功能。

## 核心能力

- **Session 管理**：列表、详情、日志、快照、校验
- **RAG 知识搜索**：历史经验检索，注入编排 SubAgent prompt
- **编排趋势**：成功率、失败率、Top 失败原因、日趋势
- **反馈提案聚合**：跨 session 汇总改进建议
- **Token 统计**：AI 消耗追踪
- **实时状态推送**：WebSocket 推送 Session/Task 状态
- **声明式生成器**：由拓扑与配置生成可校验的编排产物

## 前提条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | **22+** | `node:sqlite` 内置 API |
| Python | 3.10+ | 引擎脚本 + 数据同步 |
| Git | 任意 | 快照功能 |
| 操作系统 | Linux / macOS / WSL2 | `fcntl` 文件锁 |

## 安装

### 方式 A：install.sh（推荐）

```bash
cd server
bash install.sh
```

自动完成：环境检测 → 安装依赖 → 构建 → 创建 Session 目录 → 写入环境变量。

### 方式 B：Docker

```bash
cd server
docker compose up -d
# 管理台: http://localhost:18000
```

### 方式 C：手动安装

```bash
cd server

pip3 install -r requirements.txt      # Python 依赖
npm install && npm run build           # Node.js 依赖 + 构建
mkdir -p /opt/pipeline-orchestrator/sessions

export PIPELINE_ORCHESTRATOR_HOME=$(cd ../skill && pwd)
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions
```

## 启动

```bash
# 开发模式（前后端分离）
npm run dev

# 仅后端
npm run dev:server    # http://localhost:18000

# 仅前端
npm run dev:web       # http://localhost:18001

# 生产模式
NODE_ENV=production node packages/server/dist/main.js
```

## API 概览

```
GET  /api/sessions                        # Session 列表
GET  /api/sessions/:id                    # Session 详情
GET  /api/sessions/:id/validate           # Session 校验
GET  /api/analytics/pipeline-trend        # 编排趋势
GET  /api/analytics/feedback-proposals    # 改进提案聚合
GET  /api/analytics/overview              # 效能概览
GET  /api/analytics/ai-tracking           # AI 代码追踪
GET  /api/knowledge/rag-search?q=...      # RAG 语义搜索
GET  /api/knowledge/stats                 # 知识库统计
GET  /api/knowledge/token-stats           # Token 消耗统计
GET  /api/knowledge/gems                  # 提示词精华
GET  /api/search/*                        # 全文搜索
```

## 数据同步

效能概览、知识库等功能需要 sync 定时任务从 Cursor 本地数据同步到 `pipeline.db`：

```bash
# 安装 systemd timer（Linux/WSL2）或 launchd plist（macOS）
bash scripts/sync/install-timer.sh

# 或手动运行一次
python3 scripts/sync/sync_chats.py
```

详细 Schema 见 [docs/database-schema.md](docs/database-schema.md)。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PIPELINE_ORCHESTRATOR_HOME` | 自动探测 | Skill 根目录（`../skill/`） |
| `PIPELINE_SESSIONS_DIR` | `/opt/pipeline-orchestrator/sessions` | Session 数据目录 |
| `PIPELINE_DATA_DB` | `$SESSIONS_DIR/pipeline.db` | 数据库路径 |
| `PIPELINE_SERVER_PORT` | `18000` | 后端端口 |
| `PIPELINE_WEB_PORT` | `18001` | 前端端口 |
| `PIPELINE_API_BASE` | `http://localhost:18000/api` | API 地址 |
| `PIPELINE_PROJECT` | `_default` | 当前项目 ID |

完整说明见 `.env.example`。

## 目录结构

```
├── packages/
│   ├── server/              # Fastify 后端 API
│   ├── shared/              # 共享类型定义
│   └── generator/           # 声明式 Skill 生成器
├── web/                     # React + Ant Design 前端
├── scripts/
│   ├── engine.py            # 状态引擎（$O CLI）
│   ├── orchestrate.sh       # 编排入口脚本
│   ├── topology.py          # 拓扑分析
│   └── sync/                # 数据同步脚本
├── phases/                  # 6 个 Phase 执行步骤（server 侧副本）
├── references/              # 协议、清单、上下文策略（server 侧副本）
├── templates/               # 配置模板
├── docs/                    # 文档
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── install.sh
```

## 与 Skill 的关系

管理台不是编排必需品。Skill 侧独立运行时，RAG/趋势等功能自动降级。
安装管理台后，编排引擎自动检测并启用增强功能（RAG 注入、趋势统计、Session 可视化）。

## License

[MIT](LICENSE)
