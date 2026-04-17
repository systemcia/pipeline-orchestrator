---
name: pipeline-setup
description: >
  一键安装 Pipeline Orchestrator Skill：检测 Python 环境、安装依赖、创建 Session 目录、注册 Skill。
  触发："帮我安装"、"安装 pipeline"、"setup"、"一键安装"、"初始化环境"。
---

# Pipeline Orchestrator Skill — 一键安装

自动完成从环境检测到 Skill 注册的全部安装步骤（不含管理台，管理台需另行安装 `server/`）。

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

### Step 3: 安装 Python 依赖

```
[Shell] cd "$REPO"
if [ -f requirements.txt ]; then
  $PY -m pip install -r requirements.txt --quiet 2>&1 || echo "WARN: pip install 失败（PyYAML 为可选依赖，YAML 功能降级）"
else
  echo "SKIP: requirements.txt 不存在"
fi
```

### Step 4: 创建 Session 数据目录

```
[Shell] SESSIONS_DIR="${PIPELINE_SESSIONS_DIR:-/opt/pipeline-orchestrator/sessions}"
mkdir -p "$SESSIONS_DIR"
echo "OK: Session 目录 → $SESSIONS_DIR"
```

### Step 5: 写入环境变量

向用户展示探测结果摘要：

```
╔═══════════════════════════════════════════════╗
║   Pipeline Orchestrator Skill — 安装结果       ║
╠═══════════════════════════════════════════════╣
║ Skill 目录:   /path/to/skill                   ║
║ Session 目录: /path/to/sessions                ║
║ Python:       3.12.x ✓                         ║
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
# <<< pipeline-orchestrator <<<
EOF

echo "OK: 已写入 $CONFIG_FILE"
echo "执行 source $CONFIG_FILE 使其生效"
```

### Step 6: 注册 Skill 到 Cursor 全局目录

将 Skill 目录链接到 Cursor 全局目录，使用户在**任意项目**中都能触发 `/pipeline`：

```
[Shell] mkdir -p "$HOME/.cursor/skills"
ln -sfn "$REPO" "$HOME/.cursor/skills/pipeline-orchestrator"
echo "OK: Skill 已注册 → ~/.cursor/skills/pipeline-orchestrator"
```

### Step 7: 完成提示

向用户展示：

```
✅ Skill 安装完成！

使用方式:
  1. 用 Cursor 打开你的目标项目
  2. 输入 /pipeline 或「帮我编排」
  3. 描述需求，开始编排

CLI:    $PIPELINE_ORCHESTRATOR_HOME/scripts/orchestrate.sh list
文档:   docs/getting-started.md

可选：安装管理台获得 RAG 搜索、趋势统计、Session 可视化等增强功能
  cd $PIPELINE_ORCHESTRATOR_HOME/../server && bash install.sh
```

---

## 错误恢复

| 错误 | 处理 |
|------|------|
| Python 版本不够 | 展示安装命令，等用户操作后从 Step 2 重试 |
| pip install 失败 | PyYAML 为可选依赖，核心功能不受影响；检查网络或跳过 |
| Session 目录无权限 | `sudo mkdir -p /opt/pipeline-orchestrator/sessions && sudo chown $USER:$USER /opt/pipeline-orchestrator/sessions` |
| Skill 注册后无效 | 检查符号链接 `ls -la ~/.cursor/skills/pipeline-orchestrator/SKILL.md` |
