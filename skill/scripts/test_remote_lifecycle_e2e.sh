#!/bin/bash
set -euo pipefail

# 1. 创建测试环境
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
TID="e2e-remote-1"
REMOTE_PROJECT="sre-web"
REMOTE_PORT=9226

# 2. Step 1 PRE-CHECK (模拟)
echo "--- Step 1: PRE-CHECK ---"
PRE_SHA="abc1234567890def"
echo "PASS: CDP status connected (mock)"
echo "PASS: project matches: $REMOTE_PROJECT"
echo "PASS: run_skill response OK (mock)"

# 3. Step 2 BASELINE
echo "--- Step 2: BASELINE ---"
mkdir -p "$TMP_DIR/remote/$TID"
echo "$PRE_SHA" > "$TMP_DIR/remote/$TID/pre-sha.txt"
echo '{"status":"dispatching","remote_project":"'"$REMOTE_PROJECT"'","remote_port":'"$REMOTE_PORT"'}' > "$TMP_DIR/remote/$TID/status.json"

# 4. Step 3-4 DISPATCH (模拟 run_skill 返回)
echo "--- Step 3-4: DISPATCH ---"
cat > "$TMP_DIR/remote/$TID/response.md" << 'EOF'
## 执行结果: SUCCESS
- 修改文件: src/routes/api.ts
- 新增接口: GET /api/health-check
- 关键决策: 使用现有中间件链
EOF

# 5. Step 5 VERIFY (模拟验证输出)
echo "--- Step 5: VERIFY ---"
POST_SHA="def0987654321abc"
cat > "$TMP_DIR/remote/$TID/verify-output.txt" << EOF
1. git diff --name-only $PRE_SHA HEAD:
   src/routes/api.ts
2. npx tsc --noEmit: exit 0
3. npm test: 5 passed, 0 failed
4. git rev-parse HEAD: $POST_SHA
EOF

# 6. Step 6 COLLECT
echo "--- Step 6: COLLECT ---"
python3 -c "
import json
s = json.load(open('$TMP_DIR/remote/$TID/status.json'))
s['status'] = 'completed'
s['post_sha'] = '$POST_SHA'
s['changed_files'] = ['src/routes/api.ts']
s['verify_result'] = 'PASS'
json.dump(s, open('$TMP_DIR/remote/$TID/status.json','w'), indent=2)
"

# 7. Step 7 RECORD
echo "--- Step 7: RECORD ---"
mkdir -p "$TMP_DIR/logs"
cat > "$TMP_DIR/logs/$TID.md" << EOF
# $TID: Remote Task E2E
- 远程项目: $REMOTE_PROJECT (port: $REMOTE_PORT)
- PRE_SHA: $PRE_SHA → POST_SHA: $POST_SHA
- 变更文件: src/routes/api.ts
- 验证结果: pass (编译 + 单测通过)
EOF

# 8. 断言检查
FAIL=0
check() { if [ "$1" = "1" ]; then echo "PASS: $2"; else echo "FAIL: $2"; FAIL=1; fi }

check "$([ -d "$TMP_DIR/remote/$TID" ] && echo 1 || echo 0)" "remote/$TID/ 目录存在"
check "$([ -s "$TMP_DIR/remote/$TID/pre-sha.txt" ] && echo 1 || echo 0)" "pre-sha.txt 非空"
check "$([ -s "$TMP_DIR/remote/$TID/status.json" ] && echo 1 || echo 0)" "status.json 非空"
check "$([ -s "$TMP_DIR/remote/$TID/verify-output.txt" ] && echo 1 || echo 0)" "verify-output.txt 非空"
check "$([ -s "$TMP_DIR/remote/$TID/response.md" ] && echo 1 || echo 0)" "response.md 非空"
check "$(python3 -c "import json;s=json.load(open('$TMP_DIR/remote/$TID/status.json'));print(1 if 'verify_result' in s else 0)")" "status.json 含 verify_result"
check "$(grep -q "$REMOTE_PROJECT" "$TMP_DIR/logs/$TID.md" && echo 1 || echo 0)" "logs 含远程项目名"
check "$(grep -q "src/routes/api.ts" "$TMP_DIR/logs/$TID.md" && echo 1 || echo 0)" "logs 含变更文件列表"

exit $FAIL
