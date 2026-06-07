#!/bin/bash
# E2E: lessons.md → Step 5d 路径 B（降级）→ POST /api/knowledge/chunks → 查重 → rag-search
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:18000}"
CHUNKS_URL="${BASE_URL}/api/knowledge/chunks"
RAG_URL="${BASE_URL}/api/knowledge/rag-search"
# /api/health 未注册，实际健康检查在 /health
HEALTH_URL="${BASE_URL}/health"

PASS=0
FAIL=0
CREATED_IDS=()
TMP_DIR=""

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
  python3 -c 'import json,sys; d=json.load(sys.stdin); expr=sys.argv[1]; parts=expr.lstrip(".").split("."); v=d
for p in parts:
    if p=="": continue
    if isinstance(v,dict): v=v.get(p)
    else: v=None; break
if v is None: print("null")
elif isinstance(v,bool): print("true" if v else "false")
else: print(v)' "$expr" <<<"$json"
}

cleanup() {
  if [[ ${#CREATED_IDS[@]} -gt 0 ]]; then
    echo "--- cleanup chunks ---"
    for id in "${CREATED_IDS[@]}"; do
      if [[ -z "$id" || "$id" == "null" ]]; then
        continue
      fi
      local resp deleted
      resp=$(curl -s -X DELETE "${CHUNKS_URL}/${id}" || true)
      deleted=$(json_get "$resp" '.dat.deleted' 2>/dev/null || echo "")
      if [[ "$deleted" == "$id" ]]; then
        echo "  deleted: $id"
      else
        echo "  warn: failed to delete $id (response: $resp)"
      fi
    done
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    echo "--- cleanup temp dir ---"
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT

echo "=== knowledge ingest E2E (Step 5d path B) ==="
echo "base: $BASE_URL"

# ── 1. health check ──
health_code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo "000")
if [[ "$health_code" == "200" ]]; then
  log_pass "API health check ($HEALTH_URL -> 200)"
else
  log_fail "API health check ($HEALTH_URL -> $health_code)"
  echo "=== summary: $PASS passed, $FAIL failed ==="
  exit 1
fi

# ── 2. 创建临时 session 目录 + lessons.md ──
TS=$(date +%s)
TMP_DIR=$(mktemp -d)
PROJECT="_e2e_ingest_${TS}"

cat > "${TMP_DIR}/state.json" <<EOF
{"id":"pipe-e2e-${TS}","project_id":"${PROJECT}"}
EOF

cat > "${TMP_DIR}/lessons.md" <<'EOF'
# Lessons Learned

## 1. cursor-cdp 连接管理
- **问题**: status 工具首次调用返回 connected:false
- **解决**: 在 statusToolInner 开头主动调用 getClient 探测
- **经验**: MCP 工具应在首次调用时主动建立连接

## 2. content_hash 去重策略
- **问题**: 知识库可能重复入库相同内容
- **解决**: INSERT 前 SELECT content_hash 查重
- **经验**: 幂等性是 API 设计的基本要求
EOF

log_pass "created temp session at $TMP_DIR"

# ── 3. 提取 lessons.md 结构化条目（模拟 cursor-cdp run_skill 输出）──
ENTRIES_JSON=$(python3 - "${TMP_DIR}/lessons.md" "${PROJECT}" <<'PYEOF'
import json
import re
import sys

lessons_path, project = sys.argv[1], sys.argv[2]
text = open(lessons_path, encoding="utf-8").read()

section_re = re.compile(
    r"^##\s+\d+\.\s+(.+?)\s*\n(.*?)(?=^##\s+\d+\.|\Z)",
    re.MULTILINE | re.DOTALL,
)
field_re = re.compile(r"^\s*-\s*\*\*(问题|解决|经验)\*\*:\s*(.+)$", re.MULTILINE)

entries = []
for m in section_re.finditer(text):
    topic = m.group(1).strip()
    body = m.group(2)
    fields = {k: v.strip() for k, v in field_re.findall(body)}
    if "问题" not in fields:
        continue
    core_parts = []
    if fields.get("解决"):
        core_parts.append(f"解决: {fields['解决']}")
    if fields.get("经验"):
        core_parts.append(f"经验: {fields['经验']}")
    tags = []
    if "cursor-cdp" in topic.lower() or "mcp" in topic.lower():
        tags.extend(["cursor-cdp", "mcp"])
    if "去重" in topic or "content_hash" in topic.lower():
        tags.extend(["dedup", "content_hash"])
    # user_query 含主题关键词，确保 rag-search 可命中 main_topic 相关词
    entries.append({
        "user_query": f"[{topic}] {fields['问题']}",
        "ai_response_core": "\n".join(core_parts),
        "main_topic": topic,
        "tags": ",".join(tags) if tags else "lessons",
        "project_name": project,
    })

if len(entries) < 2:
    print("expected >=2 entries from lessons.md", file=sys.stderr)
    sys.exit(1)

print(json.dumps(entries, ensure_ascii=False))
PYEOF
)

ENTRY_COUNT=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"$ENTRIES_JSON")
log_pass "extracted $ENTRY_COUNT entries from lessons.md"

post_entries() {
  local expect_dedup="$1"  # "false" | "true"
  local idx=0
  local ok_count=0
  local dedup_count=0

  while IFS= read -r item; do
    idx=$((idx + 1))
    local resp id dedup
    resp=$(curl -s -X POST "$CHUNKS_URL" \
      -H 'Content-Type: application/json' \
      -d "$item")
    id=$(json_get "$resp" '.dat.id')
    dedup=$(json_get "$resp" '.dat.deduplicated')

    if [[ -z "$id" || "$id" == "null" ]]; then
      log_fail "POST #$idx missing id (response: $resp)"
      continue
    fi

    if [[ "$expect_dedup" == "false" ]]; then
      if [[ "$dedup" == "null" || -z "$dedup" ]]; then
        log_pass "first-run POST #$idx created id=$id"
        CREATED_IDS+=("$id")
        ok_count=$((ok_count + 1))
      else
        log_fail "first-run POST #$idx should not be deduplicated (got: $dedup)"
      fi
    else
      if [[ "$dedup" == "true" ]]; then
        log_pass "second-run POST #$idx deduplicated id=$id"
        dedup_count=$((dedup_count + 1))
      else
        log_fail "second-run POST #$idx expected deduplicated=true (response: $resp)"
      fi
    fi
  done < <(python3 -c 'import json,sys; [print(json.dumps(x,ensure_ascii=False)) for x in json.load(sys.stdin)]' <<<"$ENTRIES_JSON")

  if [[ "$expect_dedup" == "false" && "$ok_count" -eq "$ENTRY_COUNT" ]]; then
    log_pass "first-run: all $ENTRY_COUNT entries ingested"
  elif [[ "$expect_dedup" == "true" && "$dedup_count" -eq "$ENTRY_COUNT" ]]; then
    log_pass "second-run: all $ENTRY_COUNT entries deduplicated"
  fi
}

# ── 4-5. 第一次入库 + 第二次查重验证 ──
echo "--- first ingest ---"
post_entries "false"

echo "--- second ingest (dedup) ---"
post_entries "true"

# ── 6. rag-search 验证 ──
rag_resp=$(curl -s "${RAG_URL}?q=cursor-cdp&limit=10&project=${PROJECT}")
rag_hits=$(python3 -c '
import json, sys
data = json.load(sys.stdin)
items = data.get("dat") or []
needle = "cursor-cdp"
for it in items:
    blob = " ".join(str(it.get(k, "")) for k in ("query", "answer_core", "topic", "tags")).lower()
    if needle in blob:
        print("found")
        break
else:
    print("missing")
' <<<"$rag_resp")

if [[ "$rag_hits" == "found" ]]; then
  log_pass "rag-search found cursor-cdp entry (project=$PROJECT)"
else
  log_fail "rag-search missing cursor-cdp entry (response: $rag_resp)"
fi

# ── 7-8. cleanup 由 trap EXIT 执行 ──

echo "=== summary: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
