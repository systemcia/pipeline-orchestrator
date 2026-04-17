# Pipeline Orchestrator — AI 编排 Skill

全链路 AI 开发闭环引擎。驱动 9 个专职 SubAgent，完成从需求分析到代码交付的完整闭环。

## 核心能力

- **6 Phase 流水线**：Bootstrap → Propose → Session → Execute → Complete → Feedback
- **9 个专职 SubAgent**：planner / executor / quality-reviewer / evaluator / consistency-checker / error-fixer / codebase-researcher / tester / session-analyst
- **三级质量门**：提案自检 → task 级审查 → 全局审查
- **上下文工程**：分层预算 + 动态裁剪，每个 SubAgent 拿到「刚好够」的上下文
- **CCC 一致性校验**：防止 AI 自由发挥偏离需求
- **规模自适应**：小需求跳过重流程，大需求全保障
- **断点续传**：任何时候中断，下次自动从断点恢复

## 前提条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Python | 3.10+ | 编排引擎脚本 |
| Cursor IDE | 最新 | 触发编排 |
| Git | 任意 | 快照功能 |
| 操作系统 | Linux / macOS / WSL2 | `fcntl` 文件锁不支持 Windows 原生 |

> Node.js **不是必需的**。管理台（server 侧）可选安装。

## 安装

```bash
bash install.sh
```

安装脚本自动完成：
1. 检测 Python 3.10+
2. 安装 PyYAML（可选依赖）
3. 创建 Session 数据目录
4. 注册 Skill 到 `~/.cursor/skills/pipeline-orchestrator`
5. 写入环境变量到 shell 配置

手动安装：

```bash
pip3 install -r requirements.txt
mkdir -p /opt/pipeline-orchestrator/sessions

export PIPELINE_ORCHESTRATOR_HOME=$(pwd)
export PIPELINE_SESSIONS_DIR=/opt/pipeline-orchestrator/sessions

mkdir -p ~/.cursor/skills
ln -sfn $(pwd) ~/.cursor/skills/pipeline-orchestrator
```

## 使用

在 Cursor IDE 中打开**任意目标项目**，输入 `/pipeline` 或「帮我编排」，描述需求即可。

```
示例：帮我编排：给用户管理模块添加邮箱验证功能，需要后端 API + 前端表单 + 单元测试
```

### 配置目标项目（可选）

在目标项目根目录创建 `.pipeline-orchestrator.yaml`：

```yaml
max_parallel: 3
timeout_minutes: 10
gate_mode: auto          # auto | interactive
```

或从模板复制：`cp templates/pipeline-orchestrator.yaml /path/to/project/.pipeline-orchestrator.yaml`

### CLI 命令

```bash
scripts/orchestrate.sh list               # 列出所有 Session
scripts/orchestrate.sh status --dir <dir>  # 查看 Session 状态
scripts/orchestrate.sh init "需求" '[...]' # 初始化 Session
```

## 架构

```
编排层（只调度不执行）
├── SKILL.md                 → 编排主入口（LLM 执行指令）
├── phases/                  → Phase 0-5 执行步骤
├── .cursor/agents/          → 9 个 SubAgent 角色定义
├── references/              → 协议、清单、上下文策略
├── scripts/engine.py        → 状态引擎（$O CLI）
├── scripts/orchestrate.sh   → 编排入口
└── packages/generator/      → 声明式 Skill 生成器
```

### Phase 流水线

| Phase | 名称 | 职责 | 小 | 中 | 大 |
|-------|------|------|-----|-----|-----|
| 0 | Bootstrap | 前置检查 + 规模判定 | ✓ | ✓ | ✓ |
| 1 | Propose | 需求拆解 + 提案 + 质量门 A | 跳过 | ✓ | ✓ |
| 2 | Session | 创建 Session + 上下文注入 | ✓ | ✓ | ✓ |
| 3 | Execute | 逐 Task 执行 + 测试门 + 质量门 B | ✓ | ✓ | ✓ |
| 4 | Complete | 全局审查 + 质量门 C + 归档 | ✓ | ✓ | ✓ |
| 5 | Feedback | 经验反哺 + 改进建议 | 跳过 | 5a | 5a+5b |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PIPELINE_ORCHESTRATOR_HOME` | 自动探测 | Skill 根目录 |
| `PIPELINE_SESSIONS_DIR` | `/opt/pipeline-orchestrator/sessions` | Session 数据目录 |
| `PIPELINE_API_BASE` | `http://localhost:18000/api` | 管理台 API（可选，不可用时自动降级） |
| `PIPELINE_PROJECT` | `_default` | 当前项目 ID |

## 目录结构

```
├── SKILL.md                    # 编排主入口
├── AGENTS.md                   # Agent 全局指令
├── .cursor/
│   ├── agents/                 # 9 个 SubAgent 角色定义
│   ├── skills/                 # OpenSpec Skill + Setup Skill
│   └── commands/               # Cursor 命令快捷入口
├── phases/                     # 6 个 Phase 执行步骤
├── references/                 # 协议、清单、上下文策略
│   └── output-schemas/         # SubAgent 输出格式定义
├── scripts/
│   ├── engine.py               # 状态引擎（$O CLI）
│   ├── orchestrate.sh          # 编排入口脚本
│   └── topology.py             # 拓扑分析
├── packages/generator/         # 声明式 Skill 生成器
├── templates/                  # 项目配置模板
├── docs/                       # 文档
├── requirements.txt
├── install.sh
└── .env.example
```

## 管理台（可选增强）

管理台提供 RAG 搜索、趋势统计、Session 可视化等增强功能。不安装时所有功能自动降级，不影响核心编排。详见 `server/` 目录。

## 常见问题

**Q: 编排中断了怎么办？**
再次触发 `/pipeline`，引擎自动检测未完成 Session，从断点续传。

**Q: 小需求也要走全流程吗？**
不用。Phase 0 自动判定规模，小需求跳过 Phase 1/5。

**Q: 管理台不启动会影响编排吗？**
不影响。RAG 注入和趋势统计功能降级（静默失败），核心编排不受影响。

**Q: 如何自定义 SubAgent 行为？**
编辑 `.cursor/agents/<role>.md`，每个文件定义一个 SubAgent 的职责和约束。

## License

[MIT](LICENSE)
