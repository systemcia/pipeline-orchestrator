#!/bin/bash
# remote dispatch 7 步生命周期文件 I/O mock 验证
set -euo pipefail

# ── 常量 ──
TID="3.2"
REMOTE_PROJECT="sre-web"
PRE_SHA="abc123def456"
POST_SHA="fed654cba321"
CHANGED_FILES='["file1.ts"]'

# ── 隔离 session 目录 ──
DIR="$(mktemp -d)"
FAILURES=0

cleanup() {
  rm -rf "$DIR"
}
trap cleanup EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

# ── Step 2: BASELINE ──
mkdir -p "$DIR/remote/${TID}/"
echo "$PRE_SHA" > "$DIR/remote/${TID}/pre-sha.txt"
echo '{"status":"dispatching"}' > "$DIR/remote/${TID}/status.json"

# ── Step 5: VERIFY ──
cat > "$DIR/remote/${TID}/verify-output.txt" <<EOF
git diff --name-only ${PRE_SHA} HEAD
file1.ts

npx tsc --noEmit
(no errors)

git rev-parse HEAD
${POST_SHA}
EOF

# ── Step 6: COLLECT ──
cat > "$DIR/remote/${TID}/status.json" <<EOF
{"status":"completed","post_sha":"${POST_SHA}","changed_files":${CHANGED_FILES},"verify_result":"PASS"}
EOF

# ── Step 7: RECORD ──
mkdir -p "$DIR/logs"
cat > "$DIR/logs/${TID}.md" <<EOF
# Remote Task ${TID}

- **远程项目**: ${REMOTE_PROJECT}
- **变更文件**: file1.ts
- **验证结果**: pass
- **SHA**: ${PRE_SHA} → ${POST_SHA}
EOF

# ── 断言检查 ──
if [ -d "$DIR/remote/${TID}/" ]; then
  pass "remote/${TID}/ 目录存在"
else
  fail "remote/${TID}/ 目录不存在"
fi

if [ -s "$DIR/remote/${TID}/pre-sha.txt" ]; then
  pass "pre-sha.txt 存在且非空"
else
  fail "pre-sha.txt 缺失或为空"
fi

if [ -s "$DIR/remote/${TID}/verify-output.txt" ]; then
  pass "verify-output.txt 存在且非空"
else
  fail "verify-output.txt 缺失或为空"
fi

python3 - "$DIR/remote/${TID}/status.json" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
if "verify_result" not in data:
    print("FAIL: status.json 缺少 verify_result 字段", file=sys.stderr)
    sys.exit(1)
if data.get("verify_result") != "PASS":
    print(f"FAIL: verify_result 期望 PASS，实际 {data.get('verify_result')!r}", file=sys.stderr)
    sys.exit(1)
print("PASS: status.json 可解析且含 verify_result 字段")
PYEOF

LOG_FILE="$DIR/logs/${TID}.md"
if [ -f "$LOG_FILE" ]; then
  if grep -q "$REMOTE_PROJECT" "$LOG_FILE" && grep -q "file1.ts" "$LOG_FILE"; then
    pass "logs/${TID}.md 含远程项目名和变更文件列表"
  else
    fail "logs/${TID}.md 缺少远程项目名或变更文件列表"
  fi
else
  fail "logs/${TID}.md 不存在"
fi

# ── 汇总 ──
if [ "$FAILURES" -eq 0 ]; then
  echo "OK: test_remote_session.sh passed (remote/${TID}/ session I/O verified)"
  exit 0
else
  echo "FAIL: test_remote_session.sh failed ($FAILURES assertion(s) failed)" >&2
  exit 1
fi
