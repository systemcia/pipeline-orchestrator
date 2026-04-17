---
name: pipeline-setup
description: >
  一键安装 Pipeline Orchestrator：检测环境、安装依赖、构建项目、配置环境变量、启动管理台。
  触发："帮我安装"、"安装 pipeline"、"setup"、"一键安装"、"初始化环境"。
---

# Pipeline Orchestrator — 一键安装 Skill

自动完成从环境检测到管理台启动的全部安装步骤。

---

## 执行步骤

### Step 1: 定位仓库根目录

```
[Shell] REPO=""
for candidate in \
  "${PIPELINE_ORCHESTRATOR_HOME:-}" \
  "$(pwd)" \
; do
  if [ -n "$candidate" ] && [ -f "$candidate/SKILL.md" ] && [ -f "$candidate/scripts/orchestrate.sh" ]; then
    REPO="$(cd "$candidate" && pwd)"
    break
  fi
done
if [ -z "$REPO" ]; then
  echo "FAIL: 无法定位 pipeline-orchestrator 仓库根目录"
else
  echo "OK: $REPO"
fi
```

如果失败，用 AskQuestion 询问用户仓库路径。

### Step 2: 检测 Python 3.10+

```
[Shell] PY=""
for v in python3.14 python3.13 python3.12 python3.11 python3.10; do
  if command -v "$v" &>/dev/null; then PY="$v"; break; fi
done
if [ -z "$PY" ] && command -v python3 &>/dev/null; then
  if python3 -c 'import sys; exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PY="python3"
  fi
fi
if [ -z "$PY" ]; then
  echo "FAIL: 未找到 Python 3.10+"
  echo "  Ubuntu/Debian: sudo apt install python3.12"
  echo "  macOS: brew install python@3.12"
else
  echo "OK: $($PY --version)"
fi
```

失败则展示安装命令，等用户操作后重试。

### Step 3: 检测 Node.js 22+

```
[Shell] if ! command -v node &>/dev/null; then
  echo "FAIL: 未找到 Node.js，安装: https://nodejs.org/ 或 nvm install 22"
else
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "FAIL: Node.js $(node --version) 过低，需要 22+（node:sqlite API）"
    echo "  升级: nvm install 22 && nvm use 22"
  else
    echo "OK: Node.js $(node --version)"
  fi
fi
```

### Step 4: 安装 Python 依赖

```
[Shell] cd "$REPO"
if [ -f requirements.txt ]; then
  $PY -m pip install -r requirements.txt --quiet 2>&1 || echo "WARN: pip install 失败（PyYAML 为可选依赖，YAML 功能降级）"
else
  echo "SKIP: requirements.txt 不存在"
fi
```

### Step 5: 安装 Node.js 依赖并构建

```
[Shell] cd "$REPO" && npm install --no-audit --no-fund && npm run build
```

构建失败则检查错误输出尝试修复。

### Step 6: 创建 Session 数据目录

```
[Shell] SESSIONS_DIR="${PIPELINE_SESSIONS_DIR:-/opt/pipeline-orchestrator/sessions}"
mkdir -p "$SESSIONS_DIR"
echo "OK: Session 目录 → $SESSIONS_DIR"
```

### Step 6.5: 数据库初始化

`PIPELINE_DATA_DB` 默认路径与 `$PIPELINE_SESSIONS_DIR/pipeline.db` 一致（Step 6 中即 `$SESSIONS_DIR/pipeline.db`）。先解析路径并检测文件：

```
[Shell] PIPELINE_DATA_DB="${PIPELINE_DATA_DB:-$SESSIONS_DIR/pipeline.db}"
if [ -f "$PIPELINE_DATA_DB" ]; then
  echo "OK: 数据库已存在 → $PIPELINE_DATA_DB"
else
  echo "INFO: 目标数据库不存在 → $PIPELINE_DATA_DB"
fi
```

1. **若 `$PIPELINE_DATA_DB` 已存在**：本步结束。

2. **若不存在**：提示 sync 脚本首次运行会自动创建数据库（`[Shell] echo "INFO: 数据库文件不存在，sync 首次运行将创建 → $PIPELINE_DATA_DB"`）。

### Step 6.6: 安装同步定时任务

用 AskQuestion 询问：

> 是否安装 sync 定时任务（Linux: systemd timer / macOS: launchd plist）？
> - 安装
> - 跳过，稍后手动安装

用户选择「安装」：

```
[Shell] bash "$REPO/scripts/sync/install-timer.sh"
```

用户选择「跳过」：跳过安装，并提示可手动执行 `bash "$REPO/scripts/sync/install-timer.sh"`。

### Step 7: 写入环境变量

向用户展示探测结果摘要：

```
╔═══════════════════════════════════════════════╗
║   Pipeline Orchestrator — 安装结果             ║
╠═══════════════════════════════════════════════╣
║ 仓库根目录:   /path/to/pipeline-orchestrator   ║
║ Session 目录: /path/to/sessions                ║
║ 数据文件:     /path/to/sessions/pipeline.db    ║
║ Python:       3.12.x ✓                         ║
║ Node.js:      v22.x.x ✓                        ║
║ 构建状态:     成功 ✓                            ║
╚═══════════════════════════════════════════════╝
```

用 AskQuestion 询问：

> 是否将环境变量写入 shell 配置文件？
> - 写入 ~/.bashrc
> - 写入 ~/.zshrc
> - 两个都写
> - 不写入，我自己配置

如果用户同意写入：

```
[Shell] CONFIG_FILE="$HOME/.bashrc"  # 根据用户选择

# 清理旧配置
sed -i '/# >>> pipeline-orchestrator >>>/,/# <<< pipeline-orchestrator <<</d' "$CONFIG_FILE" 2>/dev/null

cat >> "$CONFIG_FILE" << EOF

# >>> pipeline-orchestrator >>>
export PIPELINE_ORCHESTRATOR_HOME="$REPO"
export PIPELINE_SESSIONS_DIR="$SESSIONS_DIR"
export PIPELINE_DATA_DB="${PIPELINE_DATA_DB:-$SESSIONS_DIR/pipeline.db}"
# <<< pipeline-orchestrator <<<
EOF

echo "OK: 已写入 $CONFIG_FILE"
echo "执行 source $CONFIG_FILE 使其生效"
```

### Step 7.5: 注册 Skill 到 Cursor 全局目录

将 `skill/` 目录链接到 Cursor 全局 Skill 目录，使用户在**任意项目**中都能触发 `/pipeline`：

```
[Shell] ln -sfn "$REPO/skill" "$HOME/.cursor/skills/pipeline-orchestrator"
echo "OK: Skill 已注册 → ~/.cursor/skills/pipeline-orchestrator"
```

> `skill/` 目录只包含编排运行时文件（SKILL.md、phases、agents、references、scripts），不包含管理台代码，避免上下文污染。

### Step 8: 启动管理台

用 AskQuestion 询问：

> 是否立即启动管理台？
> - 启动（开发模式 18000+18001）
> - 启动（生产模式 18000）
> - 不启动

开发模式：
```
[Shell] cd "$REPO" && npm run dev
```

生产模式：
```
[Shell] cd "$REPO" && NODE_ENV=production node packages/server/dist/main.js
```

启动后验证：
```
[Shell] sleep 3 && curl -sf http://localhost:18000/api/sessions 2>/dev/null | head -c 100 && echo " ✓ 管理台已就绪" || echo "管理台尚未就绪，请稍等"
```

### Step 9: 完成提示

向用户展示：

```
✅ 安装完成！

使用方式:
  1. 用 Cursor 打开你的目标项目
  2. 输入 /pipeline 或「帮我编排」
  3. 描述需求，开始编排

管理台: http://localhost:18000（如已启动）
CLI:    $PIPELINE_ORCHESTRATOR_HOME/scripts/orchestrate.sh list
文档:   docs/getting-started.md
```

---

## 错误恢复

| 错误 | 处理 |
|------|------|
| Python 版本不够 | 展示安装命令，等用户操作后从 Step 2 重试 |
| Node.js 版本不够 | 展示升级命令，等用户操作后从 Step 3 重试 |
| npm install 失败 | 检查网络，建议 `npm config set registry https://registry.npmmirror.com` |
| 构建失败 | 读取错误输出尝试诊断 |
| 端口 18000 占用 | `lsof -i :18000`，提示用 `PIPELINE_SERVER_PORT` 换端口 |
