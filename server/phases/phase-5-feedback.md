# Phase 5: 经验反哺（中/大规模）

## 5a. 会话总结与改进建议（中/大规模）

复盘前（可选、推荐）：对照 `$DIR/telemetry.jsonl` 与 `references/telemetry-anti-patterns-v2.md` 做事件链检查，将异常写入 `lessons.md` 引用条目编号。

```
[Task] spawn generalPurpose SubAgent，指令：
  "按 .cursor/agents/session-analyst.md 执行会话总结与改进分析。
   读取 $DIR/ 下的 session.md、pending.md、state.json 和 logs/*.md。
   按角色文件定义的分析维度和输出契约，写入 $DIR/lessons.md。
   如识别出可操作的改进建议，同时写入 $DIR/improvements.md。"
```

管理台可用时上传：
```
[Shell] SID=$(python3 -c "import json;print(json.load(open('$DIR/state.json'))['id'])") && curl -sf -X POST "http://localhost:18000/api/sessions/$SID/lessons" -H "Content-Type: text/plain" -d @$DIR/lessons.md && echo "OK: lessons 已上传" || echo "WARN: 管理台不可用，lessons 仅本地"
```

管理台可用时上传 improvements（如有）：
```
[Shell] [ -f $DIR/improvements.md ] && SID=$(python3 -c "import json;print(json.load(open('$DIR/state.json'))['id'])") && curl -sf -X POST "http://localhost:18000/api/sessions/$SID/improvements" -H "Content-Type: text/plain" -d @$DIR/improvements.md && echo "OK: improvements 已上传" || true
```

## 5b. 趋势追踪（管理台可用时）

```
[Shell] $O trend
```

### Phase 状态机推进

```
[Shell] $O advance-phase --dir $DIR
```
