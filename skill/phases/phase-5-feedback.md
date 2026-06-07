# Phase 5: 经验反哺（中/大规模）

## 5a. 会话总结与改进建议（中/大规模）

复盘前（可选、推荐）：对照 `$DIR/telemetry.jsonl` 与 `references/telemetry-anti-patterns-v2.md` 做事件链检查，将异常写入分析报告引用条目编号。

```
[Task] spawn generalPurpose SubAgent，指令：
  "按 .cursor/agents/session-analyst.md 执行会话总结与改进分析。
   读取 $DIR/ 下的 session.md、analysis-trace.md、pending.md、state.json 和 logs/*.md。
   analysis-trace.md 包含需求分析的完整推理链路（需求理解、RAG 检索、探索发现、拆解推理、质量门审查、用户审批），
   是复盘"需求怎么得出来的"的关键输入——重点关注拆解策略是否合理、备选方案的取舍是否正确。
   按角色文件定义的分析维度和输出契约，分别写入 $DIR/lessons.md（经验总结）和 $DIR/improvements.md（改进建议）。
   可选保留 $DIR/session-analysis.md 作为完整合并报告（向后兼容）。"
```

管理台可用时触发回顾分析（异步 LLM 分析 + 入库）：
```
[Shell] SID=$(python3 -c "import json;print(json.load(open('$DIR/state.json'))['id'])") && curl -sf -X POST "http://localhost:18000/api/sessions/$SID/generate-review" -H "Content-Type: application/json" && echo "OK: generate-review 已触发" || echo "WARN: 管理台不可用，回顾仅本地"
```

## 5d. 知识库自动入库（cursor-cdp + 管理台 API）

> 依赖：5a 产出的 `$DIR/lessons.md` 和 `$DIR/improvements.md`
> 约束 D6：`run_skill` 在同窗口新开 chat tab，不干扰主 Agent；约束 D7：cursor-cdp 不可用时降级为手动提取

**检测可用性**（先 cursor-cdp，再管理台 API）：
```
[Shell] CallMcpTool("cursor-cdp", "status", {}) → 记录 connected 字段
[Shell] curl -sf http://localhost:18000/health >/dev/null 2>&1 && echo "API_OK" || echo "API_UNAVAILABLE"
```

**路径 A：cursor-cdp 可用 且 管理台 API 可用**

1. 读取 `state.json` 获取 `project_id`：
```
[Shell] PROJECT=$(python3 -c "import json;print(json.load(open('$DIR/state.json')).get('project_id',''))")
```

2. 构造提取 prompt：
```
[Shell] EXTRACT_PROMPT="读取以下文件内容，提取每条经验教训为结构化 JSON 数组：
文件: $DIR/lessons.md
格式: [{\"user_query\":\"问题描述\",\"ai_response_core\":\"解决方案\",\"main_topic\":\"主题\",\"tags\":\"标签1,标签2\"}]
只输出 JSON，不要其他文本。"
```

3. 通过 cursor-cdp 执行提取（`run_skill` 在同窗口新开 chat，不干扰主 Agent）：
```
[Shell] CallMcpTool("cursor-cdp", "run_skill", {
  "prompt": "$EXTRACT_PROMPT",
  "timeout": 60
})
```

4. 解析 `response` 中的 JSON 数组（`status` 为 `complete` 或 `timeout` 时尝试提取 partial 输出）

5. 逐条 POST 到管理台 API（API 层 `content_hash` 去重，响应含 `deduplicated` 标记）：
```
[Shell] for item in JSON_ARRAY:
  curl -s -X POST http://localhost:18000/api/knowledge/chunks \
    -H 'Content-Type: application/json' \
    -d '{"user_query":"<item.user_query>","ai_response_core":"<item.ai_response_core>","main_topic":"<item.main_topic>","tags":"<item.tags>","project_name":"'$PROJECT'"}'
```

6. 汇总结果：新增 N 条，去重 M 条（`deduplicated: true`）

7. 记录到 session 日志：
```
[Shell] $O update-session $DIR "知识库入库" "新增 N 条，去重 M 条"
```

**路径 B：cursor-cdp 不可用（降级 D7）**

1. 主 Agent 直接读取 `$DIR/lessons.md`
2. 若管理台可用，沿用 5a 已触发的 `generate-review` 异步入库；否则仅保留本地文件
3. 记录降级：
```
[Shell] $O update-session $DIR "知识库入库" "cursor-cdp 不可用，知识入库降级为手动"
```

**路径 C：管理台 API 不可用**

1. 跳过 POST `/knowledge/chunks`，不阻塞 Phase 5 完成
2. 记录跳过：
```
[Shell] $O update-session $DIR "知识库入库" "管理台不可达，跳过知识入库"
```

## 5b. 趋势追踪（管理台可用时）

```
[Shell] $O trend
```

### Phase 状态机推进

```
[Shell] $O advance-phase --dir $DIR
```
