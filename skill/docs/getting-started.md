# 快速上手：从零到第一个编排 Session

本指南带你完成 AI 编排 Skill 的安装、配置，并运行第一个编排。

## 前提条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Python | 3.10+ | 编排引擎脚本 |
| Cursor IDE | 最新 | 触发编排 |
| Git | 任意 | 快照功能 |
| 操作系统 | Linux / macOS / WSL2 | `fcntl` 文件锁不支持 Windows 原生 |

> Node.js **不是必需的**。管理台是独立的可选组件。

## 一、安装

### 方式 A：install.sh（推荐）

```bash
cd skill
bash install.sh
```

脚本自动完成：环境检测 → 安装 PyYAML → 创建 Session 目录 → 注册 Skill → 写入环境变量。

### 方式 B：Cursor 内一键安装

用 Cursor 打开 skill 目录，输入「帮我安装」或「setup」，内置 Setup Skill 会交互式引导完成所有步骤。

### 方式 C：手动安装

```bash
cd skill

# 1. Python 依赖
pip3 install -r requirements.txt

# 2. Session 数据目录
mkdir -p /opt/pipeline-orchestrator/sessions

# 3. 环境变量（写入 ~/.bashrc 或 ~/.zshrc）
export PIPELINE_ORCHESTRATOR_HOME=$(pwd)
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions

# 4. 注册 Skill 到 Cursor
mkdir -p ~/.cursor/skills
ln -sfn $(pwd) ~/.cursor/skills/pipeline-orchestrator
```

## 二、配置环境变量

> install.sh 已自动写入，可跳过此节。

```bash
# 添加到 ~/.bashrc 或 ~/.zshrc
export PIPELINE_ORCHESTRATOR_HOME=/path/to/skill
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions
```

完整变量说明见 `.env.example`。

## 三、配置目标项目（可选）

在你要编排的项目根目录创建 `.pipeline-orchestrator.yaml`：

```yaml
max_parallel: 3
timeout_minutes: 10
gate_mode: auto          # auto | interactive
```

或从模板复制：

```bash
cp $PIPELINE_ORCHESTRATOR_HOME/templates/pipeline-orchestrator.yaml \
   /path/to/your/project/.pipeline-orchestrator.yaml
```

## 四、运行第一个编排

1. 用 Cursor 打开你的**目标项目**（不是 skill 目录）
2. 在聊天框输入 `/pipeline` 或「帮我编排」
3. 描述需求，例如：

   > 帮我编排：给用户管理模块添加邮箱验证功能

4. Pipeline Orchestrator 自动执行：
   - **Phase 0**：环境检查 + 规模判定
   - **Phase 1**：需求拆解 + 提案（中/大规模）
   - **Phase 2**：创建 Session
   - **Phase 3**：逐 Task 执行 + 质量门
   - **Phase 4**：全局审查 + 归档
   - **Phase 5**：经验反哺

## 五、查看编排状态

```bash
# 列出所有 Session
$PIPELINE_ORCHESTRATOR_HOME/scripts/orchestrate.sh list

# 查看某个 Session 状态
$PIPELINE_ORCHESTRATOR_HOME/scripts/orchestrate.sh status --dir /path/to/session
```

如需 Web UI 可视化、RAG 搜索、趋势统计等功能，可另行安装管理台（server 侧）。

## 六、常见问题

### Q: 编排中断了怎么办？
再次触发 `/pipeline`，引擎自动检测未完成 Session，从断点续传。

### Q: 管理台不启动会影响编排吗？
不影响核心编排。RAG 注入和趋势统计功能会降级（静默失败）。

### Q: 小需求也要走全流程吗？
不用。Phase 0 自动判定规模（1 task = 小），小需求跳过 Phase 1/5。

### Q: 如何自定义 SubAgent 行为？
编辑 `.cursor/agents/<role>.md` 文件。

### Q: 输入 /pipeline 没反应？
检查 Skill 注册：`ls -la ~/.cursor/skills/pipeline-orchestrator/SKILL.md`。确认 `PIPELINE_ORCHESTRATOR_HOME` 环境变量已配置。
