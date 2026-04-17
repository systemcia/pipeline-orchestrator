# 快速上手：管理台安装与配置

本指南带你完成 Pipeline Orchestrator 管理台的安装、启动和数据配置。

## 前提条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 22+ | `node:sqlite` 内置 API |
| Python | 3.10+ | 引擎脚本 + 数据同步 |
| Git | 任意 | 快照功能 |
| 操作系统 | Linux / macOS / WSL2 | `fcntl` 文件锁 |

## 一、安装

### 方式 A：install.sh（推荐）

```bash
cd server
bash install.sh
```

脚本自动完成：
1. 检测 Node.js 22+ / Python 3.10+
2. 安装依赖（`npm install`）
3. 构建项目（`npm run build`）
4. 创建 Session 目录
5. 写入环境变量

### 方式 B：Docker

```bash
cd server
docker compose up -d
# 管理台: http://localhost:18000
```

### 方式 C：手动安装

```bash
cd server

pip3 install -r requirements.txt
npm install && npm run build
mkdir -p /opt/pipeline-orchestrator/sessions

# 环境变量（写入 ~/.bashrc 或 ~/.zshrc）
export PIPELINE_ORCHESTRATOR_HOME=$(pwd)
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions
```

## 二、启动管理台

```bash
# 开发模式（推荐，前后端热重载）
npm run dev

# 仅后端
npm run dev:server    # http://localhost:18000

# 仅前端
npm run dev:web       # http://localhost:18001

# 生产模式
NODE_ENV=production node packages/server/dist/main.js
```

## 三、数据说明

管理台的数据自动积累，**无需额外配置**即可使用基础功能：

| 功能 | 数据来源 | 说明 |
|------|---------|------|
| Session 管理 | `$PIPELINE_SESSIONS_DIR` | 编排即产生，核心功能 |
| 编排趋势 | Session 文件系统 | 随编排次数增多自动积累 |
| 反馈提案 | Session → `improvements.md` | Phase 5 自动生成 |

以下功能需要安装数据同步定时任务：

| 功能 | 数据来源 | 说明 |
|------|---------|------|
| 效能概览 | `pipeline.db` | sync 定时任务从 Cursor 同步 |
| 知识库 | `pipeline.db` | 聊天记录自动提取为可搜索知识 |
| Token 统计 | `pipeline.db` | Cursor 会话 Token 消耗趋势 |
| 提示词精选 | `pipeline.db` | 高质量提示词自动筛选评分 |

### 安装数据同步定时任务

```bash
# 安装 systemd timer（Linux/WSL2）或 launchd plist（macOS）
bash scripts/sync/install-timer.sh

# 或手动运行一次
python3 scripts/sync/sync_chats.py
```

定时任务默认每日凌晨 3 点运行，支持增量同步。

## 四、环境变量

> install.sh 已自动写入，可跳过此节。

```bash
export PIPELINE_ORCHESTRATOR_HOME=/path/to/server
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions
```

完整变量说明见 `.env.example`。

## 五、配合 Skill 使用

管理台本身不提供编排能力，编排由 Skill 侧驱动。两者配合使用时：

1. Skill 侧编排引擎自动检测管理台是否可用（`localhost:18000`）
2. 可用时自动启用 RAG 注入、经验上传等增强功能
3. 不可用时静默降级，不影响编排

## 六、API 参考

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
```

详细 Schema 见 [database-schema.md](database-schema.md)。

## 七、常见问题

### Q: 某些页面显示空或报错？
部分功能依赖 `pipeline.db`，需安装 sync 定时任务（见第三节）。

### Q: 可以只装管理台不装 Skill 吗？
可以。管理台独立运行，用于查看 Session 数据和统计。但要产生编排数据，需要 Skill 侧驱动。

### Q: Docker 部署后如何访问 Session 数据？
通过 Volume 映射，默认挂载 `sessions` 卷到 `/data/sessions`。
