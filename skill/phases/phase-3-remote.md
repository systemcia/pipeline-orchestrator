# Phase 3: 远程 Task Dispatch (c-remote)

> 当 `task.type == "remote"` 时执行本流程，跳过 c) / c-TDD) 及本地后置检查 d-0.5~d-4/e/f。
> 字段来源：从 `state.json` 当前 task 读取 `type` / `remote_project` / `remote_port`。

远程 task 通过 cursor-cdp MCP 工具在独立 Cursor 窗口中执行。不同项目 MUST 使用独立窗口（独立 CDP 端口 `task.remote_port`）。

## Step 1: PRE-CHECK

```
[Shell] CallMcpTool("cursor-cdp", "status", { "port": task.remote_port })
```

- 连接失败 → 提示用户启动远程窗口（含 `--remote-debugging-port={task.remote_port}`）
- 已连接但项目名不匹配 → 提示 reload/重启

```
[Shell] CallMcpTool("cursor-cdp", "run_skill", {
  "port": task.remote_port,
  "project": task.remote_project,
  "prompt": "执行以下命令并返回原始输出:\n  git status --porcelain\n  echo '---SEPARATOR---'\n  git rev-parse HEAD",
  "timeout": 30
})
```

- 返回异常/超时 → 提示 reload
- `git status` 非空 → interactive 暂停确认 / auto 记 WARN 到 pending.md
- `git rev-parse` → 记录为 `PRE_SHA`（写入 `remote/{tid}/pre-sha.txt`）

## Step 2: BASELINE

```
[Shell] mkdir -p $DIR/remote/{tid}/ && echo "$PRE_SHA" > $DIR/remote/{tid}/pre-sha.txt && echo '{"status":"dispatching"}' > $DIR/remote/{tid}/status.json
```

## Step 3-4: DISPATCH

```
[Shell] CallMcpTool("cursor-cdp", "run_skill", {
  "port": task.remote_port,
  "project": task.remote_project,
  "prompt": "{task.description}\n\n验收标准: {task 验收标准}",
  "timeout": 600
})
```

- 完整 response 写入 `$DIR/remote/{tid}/response.md`
- `run_skill` 返回 `blocked`（AskQuestion 阻塞）→ 跳到步骤 h 标记 FAILED

## Step 5: VERIFY

```
[Shell] CallMcpTool("cursor-cdp", "run_skill", {
  "port": task.remote_port,
  "project": task.remote_project,
  "prompt": "执行以下命令并返回每条命令的完整输出:\n  1. git diff --name-only {PRE_SHA} HEAD\n  2. 根据变更文件类型自动选择编译命令\n  3. 根据项目类型执行单元测试（有测试框架时）\n  4. git rev-parse HEAD",
  "timeout": 120
})
```

- 输出写入 `$DIR/remote/{tid}/verify-output.txt`
- 解析：变更文件列表、`POST_SHA`、编译/单测结果
- VERIFY 失败 → **HARD_FAIL**；可构造修复 prompt 再次 `run_skill`（timeout 300）后重跑 VERIFY，最多 1 轮；仍失败 → 步骤 h 标记 FAILED

## Step 6: COLLECT

更新 `$DIR/remote/{tid}/status.json`：
```json
{"status":"completed","post_sha":"{POST_SHA}","changed_files":["file1.ts"],"verify_result":"PASS"}
```

## Step 7: RECORD

写入 `logs/{tid}.md` 摘要（远程项目、变更文件、验证结果、PRE_SHA→POST_SHA）。

## 后置检查适配

| 本地步骤 | remote 行为 |
|---------|------------|
| d-0 产出校验 | 改为检查 `remote/{tid}/` 目录（status.json 有 post_sha + changed_files 非空） |
| d-0.5 ~ d-4/e/f | **全部 SKIP**（远程 VERIFY 已覆盖编译+单测） |
| g 快照 | 正常执行（本地 session 记录） |
| h 标记状态 | 正常执行 |
| i 更新上下文 | 正常执行 |
| j 计划偏离 | 正常执行 |
