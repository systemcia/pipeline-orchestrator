#!/usr/bin/env bash
set -euo pipefail

# Pipeline Orchestrator Skill — 安装脚本
# 仅安装 AI 编排 Skill，不需要 Node.js 管理台

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSIONS_DIR="${PIPELINE_SESSIONS_DIR:-/opt/pipeline-orchestrator/sessions}"

show_help() {
  echo "用法: bash install.sh [选项]"
  echo ""
  echo "选项:"
  echo "  --sessions-dir <path>    Session 数据目录（默认 /opt/pipeline-orchestrator/sessions）"
  echo "  -h, --help               显示此帮助信息"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) show_help ;;
    --sessions-dir) SESSIONS_DIR="$2"; shift 2 ;;
    *) error "未知参数: $1（使用 --help 查看帮助）"; exit 1 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Pipeline Orchestrator Skill — 安装向导     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. 检测 Python ──────────────────────────────────────────
info "检测 Python 版本..."
PY=""
for v in python3.14 python3.13 python3.12 python3.11 python3.10; do
  if command -v "$v" &>/dev/null; then PY="$v"; break; fi
done
if [[ -z "$PY" ]] && command -v python3 &>/dev/null; then
  if python3 -c 'import sys; exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PY="python3"
  fi
fi

if [[ -z "$PY" ]]; then
  error "未找到 Python 3.10+，请先安装"
  exit 1
fi
info "Python: $($PY --version)"

# ── 2. 安装 Python 依赖（可选）──────────────────────────────
if [[ -f "$SKILL_DIR/requirements.txt" ]]; then
  info "安装 Python 依赖..."
  $PY -m pip install -r "$SKILL_DIR/requirements.txt" --quiet 2>/dev/null || \
    warn "pip install 失败（PyYAML 为可选依赖，不影响核心功能）"
fi

# ── 3. 创建 Session 目录 ────────────────────────────────────
info "创建 Session 目录: $SESSIONS_DIR"
mkdir -p "$SESSIONS_DIR"

# ── 4. 注册 Skill 到 Cursor 全局目录 ─────────────────────────
info "注册编排 Skill 到 Cursor..."
mkdir -p "$HOME/.cursor/skills"
ln -sfn "$SKILL_DIR" "$HOME/.cursor/skills/pipeline-orchestrator"
info "Skill 已注册 → ~/.cursor/skills/pipeline-orchestrator"

# ── 5. 写入环境变量 ──────────────────────────────────────────
ENV_BLOCK="
# >>> pipeline-orchestrator >>>
export PIPELINE_ORCHESTRATOR_HOME=\"$SKILL_DIR\"
export PIPELINE_SESSIONS_DIR=\"$SESSIONS_DIR\"
# <<< pipeline-orchestrator <<<"

write_env_to() {
  local f="$1"
  if [[ ! -f "$f" ]]; then touch "$f"; fi
  if grep -q '# >>> pipeline-orchestrator >>>' "$f" 2>/dev/null; then
    sed -i '/# >>> pipeline-orchestrator >>>/,/# <<< pipeline-orchestrator <<</d' "$f" 2>/dev/null
  fi
  echo "$ENV_BLOCK" >> "$f"
  info "环境变量已写入 $f"
}

if [[ "$SHELL" == */zsh ]] && [[ -f "$HOME/.zshrc" ]]; then
  write_env_to "$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
  write_env_to "$HOME/.bashrc"
else
  echo ""
  echo "请将以下内容添加到你的 shell 配置文件："
  echo "$ENV_BLOCK"
fi

# ── 6. 完成 ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
info "Skill 安装完成！"
echo ""
echo "在 Cursor 中任意项目输入 /pipeline 或「帮我编排」即可触发"
echo ""
echo "可选：安装 server 侧管理台获得 RAG 搜索、趋势统计等增强功能"
echo "════════════════════════════════════════════════"
