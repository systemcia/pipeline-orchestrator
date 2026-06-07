#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/cursor-cdp@.service"
SERVICE_NAME="cursor-cdp@${USER}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--uninstall]

  (default)  Build package, install user-level systemd unit, enable and start service.
  --uninstall  Stop, disable, and remove the systemd unit.
EOF
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js is not installed or not in PATH." >&2
    exit 1
  fi
  echo "Node.js: $(node --version)"
}

install_service() {
  check_node

  echo "Installing dependencies and building in ${PKG_DIR}..."
  cd "$PKG_DIR"
  npm install
  npm run build

  mkdir -p "$UNIT_DIR"
  sed "s|@INSTALL_DIR@|${PKG_DIR}|g" "${SCRIPT_DIR}/cursor-cdp@.service" >"$UNIT_FILE"
  echo "Installed unit file: ${UNIT_FILE}"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"

  echo ""
  echo "Service status:"
  systemctl --user status "$SERVICE_NAME" --no-pager || true
}

uninstall_service() {
  if systemctl --user is-active "$SERVICE_NAME" >/dev/null 2>&1; then
    systemctl --user stop "$SERVICE_NAME"
    echo "Stopped ${SERVICE_NAME}"
  else
    echo "Service ${SERVICE_NAME} is not running."
  fi

  if systemctl --user is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
    systemctl --user disable "$SERVICE_NAME"
    echo "Disabled ${SERVICE_NAME}"
  else
    echo "Service ${SERVICE_NAME} is not enabled."
  fi

  if [[ -f "$UNIT_FILE" ]]; then
    rm -f "$UNIT_FILE"
    echo "Removed unit file: ${UNIT_FILE}"
  else
    echo "Unit file not found: ${UNIT_FILE}"
  fi

  systemctl --user daemon-reload
  echo "Uninstall complete."
}

main() {
  case "${1:-}" in
    --uninstall)
      uninstall_service
      ;;
    -h | --help)
      usage
      ;;
    "")
      install_service
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
