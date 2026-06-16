#!/bin/bash
# engine.py [remote:xxx] 解析集成测试
set -euo pipefail

# ── 路径解析 ──
if [ -z "${PIPELINE_ORCHESTRATOR_HOME:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PIPELINE_ORCHESTRATOR_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
O="${PIPELINE_ORCHESTRATOR_HOME}/scripts/orchestrate.sh"

if [ ! -x "$O" ] && [ ! -f "$O" ]; then
  echo "FAIL: orchestrate.sh not found at $O" >&2
  exit 1
fi

# 隔离 session 目录
TEST_SESSIONS_ROOT="$(mktemp -d)"
export PIPELINE_SESSIONS_DIR="$TEST_SESSIONS_ROOT"
PROJECT="_test_parse"

cleanup() {
  rm -rf "$TEST_SESSIONS_ROOT"
}
trap cleanup EXIT

# ── 构造 tasks JSON ──
TASKS_JSON='[
  {"name":"local task","depends_on":[]},
  {"name":"remote test [remote:sre-web]","depends_on":[]},
  {"name":"port test [remote:knight:9333]","depends_on":[]},
  {"name":"no bracket task","depends_on":[]},
  {"name":"中文任务 [remote:告警平台:9227]","depends_on":[]}
]'

# ── 执行 init ──
INIT_OUT="$("$O" init "remote-parse-test" "$TASKS_JSON" --project "$PROJECT")"
SESSION_DIR="$(echo "$INIT_OUT" | python3 -c "import sys, json; print(json.load(sys.stdin)['session_dir'])")"
STATE_FILE="${SESSION_DIR}/state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "FAIL: state.json not found at $STATE_FILE" >&2
  exit 1
fi

# ── 解析 state.json 并断言 ──
python3 - "$STATE_FILE" <<'PYEOF'
import json
import sys

state_path = sys.argv[1]
with open(state_path) as f:
    state = json.load(f)

tasks = {t["id"]: t for t in state["tasks"]}

expected = {
    "t1": {"type": "local",  "remote_project": None, "remote_port": None, "name": "local task"},
    "t2": {"type": "remote", "remote_project": "sre-web", "remote_port": 12678, "name": "remote test"},
    "t3": {"type": "remote", "remote_project": "knight", "remote_port": 9333, "name": "port test"},
    "t4": {"type": "local",  "remote_project": None, "remote_port": None, "name": "no bracket task"},
    "t5": {"type": "remote", "remote_project": "告警平台", "remote_port": 9227, "name": "中文任务"},
}

failures = 0
for tid, exp in expected.items():
    if tid not in tasks:
        print(f"FAIL: task {tid} not found in state.json", file=sys.stderr)
        failures += 1
        continue
    actual = tasks[tid]
    for field in ("type", "remote_project", "remote_port", "name"):
        if actual.get(field) != exp[field]:
            print(
                f"FAIL: {tid}.{field}: expected {exp[field]!r}, got {actual.get(field)!r}",
                file=sys.stderr,
            )
            failures += 1

if failures:
    sys.exit(1)

print("PASS: all 5 tasks parsed correctly")
PYEOF

echo "OK: test_remote_parse.sh passed"
