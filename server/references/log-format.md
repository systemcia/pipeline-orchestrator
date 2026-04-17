# 执行日志格式

## 文件命名

格式：`<三位序号>-<tid>-<任务名>.md`

序号全局递增，不按 task 重置。特殊后缀：
- `-FAILED` — 失败的 task
- `-ccc-<type>` — CCC 校验记录
- `-test-<type>` — 测试门记录

## 日志内容

日志由 `echo "..." | $O done/fail` 生成，包含：

```markdown
# {tid}: {task_name}
- 变更文件: file1.go, file2.ts
- 产出摘要: 实现了 XXX 接口
- 新增接口: GET /api/v1/xxx
```

失败时：
```markdown
# {tid}: {task_name}
- 错误: 编译失败，XXX 类型不匹配
```

## 日志用途

| 场景 | 读取方式 |
|------|----------|
| 用户审查决策 | 读日志内容 |
| 错误排查 | 读失败日志的错误描述 |
| Phase 5 经验分析 | 读取所有日志聚合统计 |
