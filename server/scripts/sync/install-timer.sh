#!/bin/sh
# 安装/更新 pipeline 聊天记录同步定时任务（systemd user timer 或 launchd）。
# 需要 PIPELINE_ORCHESTRATOR_HOME；未设置时从本脚本路径推导为 ../../

set -e

# 推导本脚本所在目录的绝对路径（POSIX）
_script=$0
case $_script in
  /*) ;;
  *) _script=$PWD/$_script ;;
esac
_script_dir=$(dirname "$_script")
SCRIPT_DIR=$(CDPATH= cd -- "$_script_dir" && pwd) || exit 1

if [ -n "${PIPELINE_ORCHESTRATOR_HOME:-}" ]; then
  PIPELINE_ORCHESTRATOR_HOME=$(CDPATH= cd -- "$PIPELINE_ORCHESTRATOR_HOME" && pwd) || {
    echo "error: PIPELINE_ORCHESTRATOR_HOME is not a valid directory: $PIPELINE_ORCHESTRATOR_HOME" >&2
    exit 1
  }
else
  PIPELINE_ORCHESTRATOR_HOME=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd) || {
    echo "error: cannot resolve repo root from script location" >&2
    exit 1
  }
fi

SYNC_PY="$PIPELINE_ORCHESTRATOR_HOME/scripts/sync/sync_chats.py"
if [ ! -f "$SYNC_PY" ]; then
  echo "error: sync script not found: $SYNC_PY" >&2
  exit 1
fi

PYTHON3=$(command -v python3 2>/dev/null) || true
if [ -z "$PYTHON3" ]; then
  echo "error: python3 not found in PATH" >&2
  exit 1
fi

_os=$(uname -s 2>/dev/null) || _os=unknown

# --- Linux / WSL2: systemd user units ---
_install_systemd_user() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemctl not found; cannot install user timer on this system" >&2
    exit 1
  fi

  udir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if ! mkdir -p "$udir"; then
    echo "error: cannot create $udir" >&2
    exit 1
  fi

  # 清理旧单元（可能残留于用户配置目录）
  for _old in sync-chats.timer sync-chats.service; do
    if [ -f "$udir/$_old" ]; then
      systemctl --user disable --now "$_old" 2>/dev/null || true
      systemctl --user stop "$_old" 2>/dev/null || true
      rm -f "$udir/$_old" || true
    fi
  done

  # 若旧单元曾装在其他路径，仍尝试 disable（忽略失败）
  systemctl --user disable --now sync-chats.timer 2>/dev/null || true
  systemctl --user disable sync-chats.service 2>/dev/null || true

  systemctl --user daemon-reload 2>/dev/null || true

  _svc="$udir/pipeline-sync.service"
  _tmr="$udir/pipeline-sync.timer"

  cat > "$_svc" <<EOF
[Unit]
Description=Pipeline Orchestrator chat sync (sync_chats.py)

[Service]
Type=oneshot
ExecStart=$PYTHON3 $SYNC_PY
WorkingDirectory=$PIPELINE_ORCHESTRATOR_HOME/scripts/sync
EOF

  cat > "$_tmr" <<EOF
[Unit]
Description=Daily timer for pipeline chat sync

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
Unit=pipeline-sync.service

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now pipeline-sync.timer

  echo "Installed systemd user units:"
  echo "  $_svc"
  echo "  $_tmr"
  echo "Timer status:"
  systemctl --user status pipeline-sync.timer --no-pager || true
}

# --- macOS: LaunchAgent ---
_install_launchd() {
  agents_dir="$HOME/Library/LaunchAgents"
  if ! mkdir -p "$agents_dir"; then
    echo "error: cannot create $agents_dir" >&2
    exit 1
  fi

  plist="$agents_dir/com.pipeline-orchestrator.sync.plist"
  _uid=$(id -u)

  # 常见旧 plist 名称尝试卸载并删除
  for _old_plist in \
    "$agents_dir/sync-chats.plist" \
    "$agents_dir/com.sync-chats.plist"; do
    if [ -f "$_old_plist" ]; then
      launchctl bootout "gui/$_uid" "$_old_plist" 2>/dev/null || \
        launchctl unload "$_old_plist" 2>/dev/null || true
      rm -f "$_old_plist" || true
    fi
  done

  # 若旧 Label 已加载但文件已删，bootout 会失败，忽略
  launchctl bootout "gui/$_uid" "$plist" 2>/dev/null || true

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pipeline-orchestrator.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON3</string>
    <string>$SYNC_PY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PIPELINE_ORCHESTRATOR_HOME/scripts/sync</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/pipeline-orchestrator-sync.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/pipeline-orchestrator-sync.err</string>
</dict>
</plist>
EOF

  mkdir -p "$HOME/Library/Logs" 2>/dev/null || true

  if launchctl bootstrap "gui/$_uid" "$plist" 2>/dev/null; then
    :
  else
    launchctl load "$plist" || {
      echo "error: failed to load LaunchAgent: $plist" >&2
      exit 1
    }
  fi

  echo "Installed launchd agent: $plist"
  (launchctl list 2>/dev/null | grep -F com.pipeline-orchestrator.sync) || true
}

case "$_os" in
  Darwin)
    _install_launchd
    ;;
  Linux)
    _install_systemd_user
    ;;
  *)
    echo "error: unsupported OS: $_os (expected Darwin or Linux)" >&2
    exit 1
    ;;
esac
