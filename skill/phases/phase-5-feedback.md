# Phase 5: 经验反哺（中/大规模）

## 5a. 会话总结与改进建议（中/大规模）

复盘前（可选、推荐）：对照 `$DIR/telemetry.jsonl` 与 `references/telemetry-anti-patterns-v2.md` 做事件链检查，将异常写入分析报告引用条目编号。

```
[Task] spawn generalPurpose SubAgent，指令：
  "按 .cursor/agents/session-analyst.md 执行会话总结与改进分析。
   读取 $DIR/ 下的 session.md、analysis-trace.md、pending.md、state.json 和 logs/*.md。
   analysis-trace.md 包含需求分析的完整推理链路（需求理解、RAG 检索、探索发现、拆解推理、质量门审查、用户审批），
   是复盘"需求怎么得出来的"的关键输入——重点关注拆解策略是否合理、备选方案的取舍是否正确。
   按角色文件定义的分析维度和输出契约，写入 $DIR/session-analysis.md（单文件合并报告）。"
```

管理台可用时上传分析报告：
```
[Shell] SID=$(python3 -c "import json;print(json.load(open('$DIR/state.json'))['id'])") && curl -sf -X POST "http://localhost:18000/api/sessions/$SID/lessons" -H "Content-Type: text/plain" -d @$DIR/session-analysis.md && echo "OK: session-analysis 已上传" || echo "WARN: 管理台不可用，session-analysis 仅本地"
```

## 5b. 趋势追踪（管理台可用时）

```
[Shell] $O trend
```

### Phase 状态机推进

```
[Shell] $O advance-phase --dir $DIR
```
