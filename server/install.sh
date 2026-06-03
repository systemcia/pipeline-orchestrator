#!/usr/bin/env bash
set -euo pipefail

# Pipeline Orchestrator Server — 管理台安装脚本

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
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
echo "║   Pipeline Orchestrator Server — 安装向导    ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. 检测 Node.js ─────────────────────────────────────────
info "检测 Node.js 版本..."
if ! command -v node &>/dev/null; then
  error "未找到 Node.js，请先安装 Node.js 22+"
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  error "Node.js 版本过低: $(node --version)，需要 22+（node:sqlite 内置 API）"
  exit 1
fi
info "Node.js: $(node --version)"

# ── 2. 检测 npm ──────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  error "未找到 npm"
  exit 1
fi
info "npm: $(npm --version)"

# ── 3. 检测 Python（引擎脚本需要）──────────────────────────
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
  warn "未找到 Python 3.10+，引擎脚本将不可用（管理台本身不受影响）"
else
  info "Python: $($PY --version)"
  if [[ -f "$REPO_DIR/requirements.txt" ]]; then
    $PY -m pip install -r "$REPO_DIR/requirements.txt" --quiet 2>/dev/null || \
      warn "pip install 失败（PyYAML 为可选依赖）"
  fi
fi

# ── 4. 安装 Node.js 依赖并构建 ──────────────────────────────
info "安装 Node.js 依赖..."
cd "$REPO_DIR"
npm install --no-audit --no-fund

info "构建项目..."
npm run build

# ── 5. 创建 Session 目录 ────────────────────────────────────
info "创建 Session 目录: $SESSIONS_DIR"
mkdir -p "$SESSIONS_DIR"

# ── 6. 写入环境变量 ──────────────────────────────────────────
SKILL_DIR="$(cd "$REPO_DIR/../skill" 2>/dev/null && pwd || echo "")"

ENV_BLOCK="
# >>> pipeline-orchestrator-server >>>
export PIPELINE_ORCHESTRATOR_HOME=\"${SKILL_DIR:-$REPO_DIR}\"
export PIPELINE_SESSIONS_DIR=\"$SESSIONS_DIR\"
export PIPELINE_DATA_DB=\"$SESSIONS_DIR/pipeline.db\"
# <<< pipeline-orchestrator-server <<<"

write_env_to() {
  local f="$1"
  if [[ ! -f "$f" ]]; then touch "$f"; fi
  if grep -q '# >>> pipeline-orchestrator-server >>>' "$f" 2>/dev/null; then
    sed -i '/# >>> pipeline-orchestrator-server >>>/,/# <<< pipeline-orchestrator-server <<</d' "$f" 2>/dev/null
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

# ── 7. 完成 ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
info "管理台安装完成！"
echo ""
echo "启动管理台（手动）："
echo "  cd $REPO_DIR && npm run dev"
echo ""
echo "安装为常驻服务（开机自启 + 失败自动重启）："
echo "  bash $REPO_DIR/scripts/install-server.sh"
echo ""
echo "后端: http://localhost:18000"
echo "前端: http://localhost:18001"
echo "════════════════════════════════════════════════"
