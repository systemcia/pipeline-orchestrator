#!/bin/sh
# 安装/更新 pipeline 管理台常驻服务（systemd user service 或 launchd）。
# 需要 PIPELINE_ORCHESTRATOR_HOME；未设置时从本脚本路径推导。
#
# 用法:
#   bash scripts/install-server.sh              # 安装并启动
#   bash scripts/install-server.sh --uninstall   # 卸载
#
# 前置条件: 已执行 install.sh 完成构建（dist/main.js 存在）。

set -e

# ── 推导路径 ──────────────────────────────────────────────────
_script=$0
case $_script in
  /*) ;;
  *) _script=$PWD/$_script ;;
esac
_script_dir=$(dirname "$_script")
SCRIPT_DIR=$(CDPATH= cd -- "$_script_dir" && pwd) || exit 1

# server/ 根目录（scripts/ 的上一级）
SERVER_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1

if [ -n "${PIPELINE_ORCHESTRATOR_HOME:-}" ]; then
  PIPELINE_ORCHESTRATOR_HOME=$(CDPATH= cd -- "$PIPELINE_ORCHESTRATOR_HOME" && pwd) || {
    echo "error: PIPELINE_ORCHESTRATOR_HOME is not a valid directory" >&2
    exit 1
  }
else
  PIPELINE_ORCHESTRATOR_HOME="$SERVER_ROOT"
fi

# ── 检测 Node.js ─────────────────────────────────────────────
NODE_BIN=$(command -v node 2>/dev/null) || true
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi

MAIN_JS="$SERVER_ROOT/packages/server/dist/main.js"
if [ ! -f "$MAIN_JS" ]; then
  echo "error: $MAIN_JS not found, run install.sh first" >&2
  exit 1
fi

# ── 加载 .env（如存在）────────────────────────────────────────
ENV_FILE="$SERVER_ROOT/.env"

_ACTION="install"
for _arg in "$@"; do
  case "$_arg" in
    --uninstall) _ACTION="uninstall" ;;
  esac
done

_os=$(uname -s 2>/dev/null) || _os=unknown

_SVC_NAME="pipeline-server"

# === Linux / WSL2: systemd user service ===
_install_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemctl not found" >&2
    exit 1
  fi

  udir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$udir" || { echo "error: cannot create $udir" >&2; exit 1; }

  _svc="$udir/${_SVC_NAME}.service"

  # 构建 Environment 行
  _env_lines=""
  _env_lines="${_env_lines}Environment=NODE_ENV=production\n"
  _env_lines="${_env_lines}Environment=PIPELINE_ORCHESTRATOR_HOME=${PIPELINE_ORCHESTRATOR_HOME}\n"
  if [ -n "${PIPELINE_SESSIONS_DIR:-}" ]; then
    _env_lines="${_env_lines}Environment=PIPELINE_SESSIONS_DIR=${PIPELINE_SESSIONS_DIR}\n"
  fi
  if [ -n "${PIPELINE_DATA_DB:-}" ]; then
    _env_lines="${_env_lines}Environment=PIPELINE_DATA_DB=${PIPELINE_DATA_DB}\n"
  fi
  if [ -n "${PIPELINE_SERVER_PORT:-}" ]; then
    _env_lines="${_env_lines}Environment=PIPELINE_SERVER_PORT=${PIPELINE_SERVER_PORT}\n"
  fi

  _env_file_line=""
  if [ -f "$ENV_FILE" ]; then
    _env_file_line="EnvironmentFile=$ENV_FILE"
  fi

  cat > "$_svc" <<EOF
[Unit]
Description=Pipeline Orchestrator Server (Fastify :18000)
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $MAIN_JS
WorkingDirectory=$SERVER_ROOT
$(printf '%b' "$_env_lines")${_env_file_line}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$_SVC_NAME"

  echo "Installed systemd user service: $_svc"
  echo ""
  echo "常用命令:"
  echo "  systemctl --user status  $_SVC_NAME   # 查看状态"
  echo "  systemctl --user restart $_SVC_NAME   # 重启"
  echo "  systemctl --user stop    $_SVC_NAME   # 停止"
  echo "  journalctl --user -u $_SVC_NAME -f    # 查看日志"
  echo ""
  systemctl --user status "$_SVC_NAME" --no-pager || true
}

_uninstall_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemctl not found" >&2
    exit 1
  fi

  systemctl --user disable --now "$_SVC_NAME" 2>/dev/null || true
  systemctl --user stop "$_SVC_NAME" 2>/dev/null || true

  udir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  rm -f "$udir/${_SVC_NAME}.service"
  systemctl --user daemon-reload 2>/dev/null || true

  echo "Uninstalled: $_SVC_NAME"
}

# === macOS: LaunchAgent ===
_install_launchd() {
  agents_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$agents_dir" || { echo "error: cannot create $agents_dir" >&2; exit 1; }

  _label="com.pipeline-orchestrator.server"
  plist="$agents_dir/${_label}.plist"
  _uid=$(id -u)

  launchctl bootout "gui/$_uid" "$plist" 2>/dev/null || true

  # 构建环境变量 dict
  _env_dict="<key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key>
      <string>production</string>
      <key>PIPELINE_ORCHESTRATOR_HOME</key>
      <string>${PIPELINE_ORCHESTRATOR_HOME}</string>"

  if [ -n "${PIPELINE_SESSIONS_DIR:-}" ]; then
    _env_dict="${_env_dict}
      <key>PIPELINE_SESSIONS_DIR</key>
      <string>${PIPELINE_SESSIONS_DIR}</string>"
  fi
  if [ -n "${PIPELINE_DATA_DB:-}" ]; then
    _env_dict="${_env_dict}
      <key>PIPELINE_DATA_DB</key>
      <string>${PIPELINE_DATA_DB}</string>"
  fi

  _env_dict="${_env_dict}
    </dict>"

  _log_dir="$HOME/Library/Logs"
  mkdir -p "$_log_dir" 2>/dev/null || true

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$MAIN_JS</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_ROOT</string>
  ${_env_dict}
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${_log_dir}/pipeline-server.log</string>
  <key>StandardErrorPath</key>
  <string>${_log_dir}/pipeline-server.err</string>
</dict>
</plist>
EOF

  if launchctl bootstrap "gui/$_uid" "$plist" 2>/dev/null; then
    :
  else
    launchctl load "$plist" || { echo "error: failed to load LaunchAgent" >&2; exit 1; }
  fi

  echo "Installed launchd agent: $plist"
  echo ""
  echo "常用命令:"
  echo "  launchctl list | grep pipeline   # 查看状态"
  echo "  launchctl kickstart -k gui/$_uid/$_label  # 重启"
  echo "  launchctl bootout gui/$_uid/$_label        # 停止"
  echo ""
  (launchctl list 2>/dev/null | grep -F "$_label") || true
}

_uninstall_launchd() {
  _label="com.pipeline-orchestrator.server"
  plist="$HOME/Library/LaunchAgents/${_label}.plist"
  _uid=$(id -u)

  launchctl bootout "gui/$_uid" "$plist" 2>/dev/null || \
    launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"

  echo "Uninstalled: $_label"
}

# ── 主入口 ────────────────────────────────────────────────────
case "$_os" in
  Darwin)
    if [ "$_ACTION" = "uninstall" ]; then _uninstall_launchd; else _install_launchd; fi
    ;;
  Linux)
    if [ "$_ACTION" = "uninstall" ]; then _uninstall_systemd; else _install_systemd; fi
    ;;
  *)
    echo "error: unsupported OS: $_os" >&2
    exit 1
    ;;
esac
