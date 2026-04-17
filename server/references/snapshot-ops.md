# 快照操作指南

## 与规模矩阵 / YAML 的关系

**语义源**：`SKILL.md`「规模裁剪矩阵」规定 **中规模不执行** `snapshot` step（仅大规模打 tag）。`templates/pipeline-orchestrator.yaml` 的 `snapshot_medium` 须与此一致；若改 YAML，必须同步改矩阵与本文件。

**并行 owns_globs（可选静态检查）**：`python3 scripts/check_owns_globs_overlap.py <session_dir>/state.json` — 启发式检测不同 task 的 `owns_globs` 是否可能指向重叠路径；用于 Phase 3 并行资格自检，非强制 gate。

## Git Tag 命名规则

格式：`pipeline/<session-id>/after-<tid>`

| 步骤 | Tag 示例 | .ref 文件 |
|------|---------|----------|
| Task t1 完成 | `pipeline/pipe-20260407-143022/after-t1` | `snapshots/after-t1.ref` |
| Task t2 完成 | `pipeline/pipe-20260407-143022/after-t2` | `snapshots/after-t2.ref` |

## 快照创建

仅大规模编排时创建（见 SKILL.md 规模裁剪矩阵）。

```bash
git tag "pipeline/<session-id>/after-<tid>"
echo "pipeline/<session-id>/after-<tid>" > $DIR/snapshots/after-<tid>.ref
```

**git tag 失败时**（如非 git 仓库）：输出 WARN 日志，跳过快照，不阻塞编排。

## 回溯操作

用户说"回溯到 task N"时：

```bash
# 0. 安全检查 — 保存当前工作区
git stash --include-untracked -m "pipeline-rollback-before-$(date +%s)"

# 1. 读取快照引用
TAG=$(cat $DIR/snapshots/after-tN.ref)

# 2. 创建回溯分支（避免 detached HEAD）
git checkout -b "pipeline-rollback-$(date +%Y%m%d-%H%M%S)" "$TAG"
```

回溯后更新状态：
- task N 之后的所有任务 status 重置为 PENDING
- task N 之后的 started_at / completed_at 清空
- session status 改为 APPLYING
- 从 task N+1 重新开始执行

**回滚后编译验证**：大规模 tag 回溯在上述 git 步骤（stash、读 `.ref`、`checkout` 到新分支）**全部成功后**，**必须**按「回滚后编译验证」一节内联执行编译类检查；失败则向 `$DIR/pending.md` 追加 `soft:` 行（见该节），再更新状态。

## 回滚后编译验证

下列任一 **rollback** 完成之后，主 Agent **MUST** 内联执行与本工作区技术栈一致的**确定性编译类检查**，以确认回滚后的树可构建；**不得**依赖 Telemetry 或 SubAgent 自然语言结论作为通过依据。

适用场景：

- 大规模：**回溯操作**（`stash` + 读 `.ref` + `checkout` 到 tag）完成后
- 中规模：`git stash pop` 回退到 `pre-{tid}` 完成后
- 中规模并行：`git checkout $PRE_SHA_{tid} -- .` 工作区回退完成后

**命令选取**（与 `phases/phase-3-execute.md` **d-1 编译检查**同源；差异为回滚后按**当前工作区与元数据存在性**判定范围，而非仅本轮 diff）：

- 某目录存在 `go.mod` → 在该目录执行 `go vet ./...`（多模块则对每个模块根各执行一次）
- 某目录存在 `tsconfig.json` 且可用 Node → 在该目录执行 `npx tsc --noEmit`；若 `package.json` 含 `build` 且编排要求产物校验，则改用 `npm run build`（或项目锁定的包管理器等价命令）
- 工作区存在需字节码校验的 `*.py` → `python3 -m py_compile` 作用于**回滚所覆盖路径下的** Python 文件（若无法枚举则跳过本项并打日志，不冒充通过）
- 以上均无 → 跳过本验证（不记 pending）

**失败时**（任一命令非 0 退出）：向 `$DIR/pending.md` **追加一行**（勿覆盖文件），前缀必须为 `soft:`，并含命令摘要与退出码，例如：

```text
soft: rollback-verify: 回滚后 go vet ./... 失败 exit=1（或 npm run build / tsc / py_compile 摘要）
```

随后主 Agent 在 session 或本轮说明中引用 `logs/` 下已有输出；**不得**在验证未通过时声称 rollback 已「编译确认」。`soft:` 表示可恢复风险项，与 `references/protocols.md` 中 SOFT_FAIL / pending 语义一致；是否暂停编排由 session / `gate_mode` 决定，本文件仅强制**记录**。

**可执行示例**（单仓库根一个 `go.mod` + 可选 `web/` 前端；路径按实际仓库调整）：

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT="$PWD"
rv_ok=0
if [ -f "$ROOT/go.mod" ]; then (cd "$ROOT" && go vet ./...) || rv_ok=1; fi
if [ -f "$ROOT/web/package.json" ] && [ -f "$ROOT/web/tsconfig.json" ]; then
  (cd "$ROOT/web" && npm run build) || rv_ok=1
fi
if [ "$rv_ok" -ne 0 ]; then
  printf '%s\n' "soft: rollback-verify: 回滚后编译/类型检查未通过，exit非0，需人工核对快照与依赖环境" >> "$DIR/pending.md"
fi
```

## 快照清理

```bash
# 清理指定 session 的所有 tag
git tag -l "pipeline/<session-id>/*" | xargs git tag -d

# 清理所有 pipeline tag
git tag -l "pipeline/*" | xargs git tag -d
```

清理时机：用户显式要求时。归档时不自动清理。

## 中规模 stash 策略

中规模编排不使用 git tag（矩阵规定 snapshot 跳过），改用**轻量 git stash**：

### 创建时机

Phase 3 每个 task `$O start` 后、spawn SubAgent 前（step b-2）。

### 命令

```bash
git stash push -m "pre-{tid}" --include-untracked
```

- 非 git 仓库或无本地变更时静默跳过（不阻塞）
- stash 消息包含 tid 用于定位

### 回退

task 失败且需要回退代码时：

```bash
git stash list | grep "pre-{tid}" | head -1 | cut -d: -f1 | xargs git stash pop
```

`stash pop` 完成后执行 **回滚后编译验证**（见上文专节）；失败则向 `$DIR/pending.md` 追加 `soft:` 行。

### 清理

task 成功完成后（step h done 后）：

```bash
git stash list | grep "pre-{tid}" | head -1 | cut -d: -f1 | xargs git stash drop 2>/dev/null || true
```

### 并行场景

`git stash` 是全局栈，不支持并行 task 并发 push/pop。并行执行时：

- **跳过 stash**，改用 Phase 3 步骤 b 记录的 `PRE_SHA_{tid}` 基线
- 回退方式：`git checkout $PRE_SHA_{tid} -- .`
- `git checkout $PRE_SHA_{tid} -- .` 完成后执行 **回滚后编译验证**（见上文专节）；失败则向 `$DIR/pending.md` 追加 `soft:` 行
- 大规模并行仍使用 git tag（每个 task 独立 tag，无栈冲突）

### 与大规模快照的区别

| 维度 | 中规模 stash（串行） | 中规模 PRE_SHA（并行） | 大规模 tag |
|------|-------------|-----------|-----------|
| 持久性 | 临时（成功后清理） | 无持久化（SHA 在变量中） | 永久（手动清理） |
| 粒度 | 工作区变更 | commit 级回退 | 完整提交 |
| 成本 | 低（无历史污染） | 最低 | 中（留 tag） |
| 回溯能力 | 仅回退到 task 开始前 | 仅回退到 task 开始前 | 可回溯到任意 task 完成后 |
