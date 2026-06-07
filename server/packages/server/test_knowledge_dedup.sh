#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:18000}"
API_URL="${BASE_URL}/api/knowledge/chunks"
HEALTH_URL="${BASE_URL}/health"

PASS=0
FAIL=0
CREATED_IDS=()

log_pass() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}

log_fail() {
  echo "FAIL: $1"
  FAIL=$((FAIL + 1))
}

json_get() {
  local json="$1"
  local expr="$2"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r "$expr"
  else
    python3 -c 'import json,sys; d=json.load(sys.stdin); expr=sys.argv[1]; parts=expr.lstrip(".").split("."); v=d
for p in parts:
    if p=="": continue
    if isinstance(v,dict): v=v.get(p)
    else: v=None; break
if v is None: print("null")
elif isinstance(v,bool): print("true" if v else "false")
else: print(v)' "$expr" <<<"$json"
  fi
}

cleanup() {
  if [[ ${#CREATED_IDS[@]} -eq 0 ]]; then
    return
  fi
  echo "--- cleanup ---"
  for id in "${CREATED_IDS[@]}"; do
    if [[ -z "$id" || "$id" == "null" ]]; then
      continue
    fi
    local resp
    resp=$(curl -s -X DELETE "${API_URL}/${id}" || true)
    local deleted
    deleted=$(json_get "$resp" '.dat.deleted' 2>/dev/null || echo "")
    if [[ "$deleted" == "$id" ]]; then
      echo "  deleted: $id"
    else
      echo "  warn: failed to delete $id (response: $resp)"
    fi
  done
}

trap cleanup EXIT

echo "=== knowledge API dedup test ==="
echo "base: $BASE_URL"

# 1. health check
health_code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo "000")
if [[ "$health_code" == "200" ]]; then
  log_pass "API health check ($HEALTH_URL -> 200)"
else
  log_fail "API health check ($HEALTH_URL -> $health_code)"
  echo "=== summary: $PASS passed, $FAIL failed ==="
  exit 1
fi

# 2. unique test data
TS=$(date +%s)
TEST_QUERY="dedup-test-query-${TS}"
TEST_CORE="dedup-test-core-${TS}"
DIFF_CORE="dedup-test-core-diff-${TS}"
TEST_PROJECT="_dedup_test"

payload_same=$(cat <<EOF
{"user_query":"${TEST_QUERY}","ai_response_core":"${TEST_CORE}","project_name":"${TEST_PROJECT}","main_topic":"dedup-test","tags":"dedup,test"}
EOF
)

payload_diff=$(cat <<EOF
{"user_query":"${TEST_QUERY}","ai_response_core":"${DIFF_CORE}","project_name":"${TEST_PROJECT}","main_topic":"dedup-test","tags":"dedup,test"}
EOF
)

post_chunk() {
  curl -s -X POST "$API_URL" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

# 3. first POST: create
resp1=$(post_chunk "$payload_same")
id1=$(json_get "$resp1" '.dat.id')
dedup1=$(json_get "$resp1" '.dat.deduplicated')

if [[ -n "$id1" && "$id1" != "null" ]]; then
  log_pass "first POST returned id=$id1"
  CREATED_IDS+=("$id1")
else
  log_fail "first POST missing id (response: $resp1)"
fi

if [[ "$dedup1" == "null" || -z "$dedup1" ]]; then
  log_pass "first POST has no deduplicated flag"
else
  log_fail "first POST should not contain deduplicated (got: $dedup1)"
fi

# 4. second POST: same content -> deduplicated
resp2=$(post_chunk "$payload_same")
id2=$(json_get "$resp2" '.dat.id')
dedup2=$(json_get "$resp2" '.dat.deduplicated')

if [[ "$id2" == "$id1" ]]; then
  log_pass "second POST returned same id=$id2"
else
  log_fail "second POST id mismatch (expected $id1, got $id2; response: $resp2)"
fi

if [[ "$dedup2" == "true" ]]; then
  log_pass "second POST returned deduplicated=true"
else
  log_fail "second POST missing deduplicated=true (got: $dedup2; response: $resp2)"
fi

# 5. third POST: different content -> new id
resp3=$(post_chunk "$payload_diff")
id3=$(json_get "$resp3" '.dat.id')
dedup3=$(json_get "$resp3" '.dat.deduplicated')

if [[ -n "$id3" && "$id3" != "null" && "$id3" != "$id1" ]]; then
  log_pass "third POST returned new id=$id3"
  CREATED_IDS+=("$id3")
else
  log_fail "third POST should return new id (got: $id3; response: $resp3)"
fi

if [[ "$dedup3" == "null" || -z "$dedup3" ]]; then
  log_pass "third POST has no deduplicated flag"
else
  log_fail "third POST should not contain deduplicated (got: $dedup3)"
fi

echo "=== summary: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
