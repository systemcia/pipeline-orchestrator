#!/bin/bash
# pipeline-orchestrator CLI — 薄壳入口
# 所有业务逻辑在 engine.py，本脚本只做参数转发
#
# 用法:
#   orchestrate.sh init    <name> <tasks_json> [profile] [--project <id>] [--template <name|path>]
#   orchestrate.sh list    [--project …] [--all]
#   orchestrate.sh next    <session_dir>
#   orchestrate.sh start   <session_dir> <task_id> <agent_type> [skill]
#   orchestrate.sh done    <session_dir> <task_id>              (stdin=日志)
#   orchestrate.sh fail    <session_dir> <task_id> <error>      (stdin=日志)
#   orchestrate.sh status  <session_dir>
#   orchestrate.sh validate <session_dir>
#   orchestrate.sh complete <session_dir>
#   orchestrate.sh update-session <session_dir> <section> <content>
#   orchestrate.sh test-gate …  若 PIPELINE_STRICT_TEST_EVIDENCE=1，JSON 中 passed:true 须含 shell_exit_code:0
#   orchestrate.sh trend   [--project …]
#   orchestrate.sh rollback --dir <session_dir> --tid <task_id>
#   orchestrate.sh skill-route <session_dir> <task_id> [--config path]
#   orchestrate.sh validate-topology [config_file]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/engine.py"

# Python ≥ 3.10 required (type union syntax: str | None)
if command -v python3.14 &>/dev/null; then
  PY=python3.14
elif command -v python3.13 &>/dev/null; then
  PY=python3.13
elif command -v python3.12 &>/dev/null; then
  PY=python3.12
elif command -v python3.11 &>/dev/null; then
  PY=python3.11
elif command -v python3.10 &>/dev/null; then
  PY=python3.10
else
  PY=python3
fi
CMD="${1:?用法: orchestrate.sh <command> ...}"
shift

case "$CMD" in
  init)
    NAME="${1:?需要 session 名称}"; TASKS="${2:?需要 tasks JSON}"
    shift 2
    _EXTRA=()
    [ -n "${PIPELINE_OPENSPEC_CHANGE:-}" ] && _EXTRA+=(--openspec-change "$PIPELINE_OPENSPEC_CHANGE")
    [ -n "${PIPELINE_OPENSPEC_REPO_ROOT:-}" ] && _EXTRA+=(--openspec-repo-root "$PIPELINE_OPENSPEC_REPO_ROOT")
    if [ -n "${PIPELINE_PARALLEL_STRATEGY:-}" ]; then
      _EXTRA+=(--parallel-strategy "$PIPELINE_PARALLEL_STRATEGY")
    fi
    PROFILE_ARGS=()
    PROJECT_ARGS=()
    TEMPLATE_ARGS=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --project)
          [ -n "${2:-}" ] || { echo "init: --project 需要值" >&2; exit 1; }
          PROJECT_ARGS+=(--project "$2")
          shift 2
          ;;
        --template)
          [ -n "${2:-}" ] || { echo "init: --template 需要值" >&2; exit 1; }
          TEMPLATE_ARGS+=(--template "$2")
          shift 2
          ;;
        *)
          if [ ${#PROFILE_ARGS[@]} -eq 0 ] && [[ "$1" != --* ]]; then
            PROFILE_ARGS+=(--profile "$1")
            shift
          else
            echo "init: 未知参数: $1" >&2
            exit 1
          fi
          ;;
      esac
    done
    $PY "$ENGINE" init --name "$NAME" --tasks "$TASKS" "${PROFILE_ARGS[@]}" "${PROJECT_ARGS[@]}" "${TEMPLATE_ARGS[@]}" "${_EXTRA[@]}"
    ;;
  list)
    $PY "$ENGINE" list "$@"
    ;;
  next)
    $PY "$ENGINE" next --dir "${1:?需要 session 目录}"
    ;;
  start)
    DIR="${1:?需要 session 目录}"; TID="${2:?需要 task_id}"; AGENT="${3:?需要 agent_type}"
    if [ -n "${4:-}" ]; then
      $PY "$ENGINE" start --dir "$DIR" --tid "$TID" --agent "$AGENT" --skill "$4"
    else
      $PY "$ENGINE" start --dir "$DIR" --tid "$TID" --agent "$AGENT"
    fi
    ;;
  done)
    $PY "$ENGINE" done --dir "${1:?需要 session 目录}" --tid "${2:?需要 task_id}"
    ;;
  fail)
    $PY "$ENGINE" fail --dir "${1:?需要 session 目录}" --tid "${2:?需要 task_id}" --error "${3:?需要错误描述}"
    ;;
  retry)
    $PY "$ENGINE" retry --dir "${1:?需要 session 目录}" --tid "${2:?需要 task_id}"
    ;;
  status)
    $PY "$ENGINE" status --dir "${1:?需要 session 目录}"
    ;;
  validate)
    DIR="${1:?需要 session 目录}"
    shift
    $PY "$ENGINE" validate --dir "$DIR" "$@"
    ;;
  complete)
    $PY "$ENGINE" complete --dir "${1:?需要 session 目录}"
    ;;
  update-session)
    DIR="${1:?需要 session 目录}"; SECTION="${2:?需要 section}"; CONTENT="${3:?需要 content}"
    MODE="${4:-append}"
    $PY "$ENGINE" update-session --dir "$DIR" --section "$SECTION" --content "$CONTENT" --mode "$MODE"
    ;;
  inject-rag)
    DIR="${1:?需要 session 目录}"; QUERY="${2:?需要搜索关键词}"
    shift 2
    $PY "$ENGINE" inject-rag --dir "$DIR" --query "$QUERY" "$@"
    ;;
  consistency-check)
    DIR="${1:?需要 session 目录}"; TYPE="${2:?需要类型 proposal|task}"; TID="${3:-}"
    if [ $# -ge 4 ]; then
      RESULT="$4"
    else
      RESULT="$3"; TID=""
    fi
    if [ -n "$TID" ]; then
      $PY "$ENGINE" consistency-check --dir "$DIR" --type "$TYPE" --tid "$TID" --result "$RESULT"
    else
      $PY "$ENGINE" consistency-check --dir "$DIR" --type "$TYPE" --result "$RESULT"
    fi
    ;;
  test-gate)
    $PY "$ENGINE" test-gate --dir "${1:?需要 session 目录}" --type "${2:?需要类型 compile|unit|integration|e2e|regression}" --result "${3:?需要 JSON 结果}"
    ;;
  snapshot)
    $PY "$ENGINE" snapshot --dir "${1:?需要 session 目录}" --tid "${2:?需要 task_id}"
    ;;
  trend)
    $PY "$ENGINE" trend "$@"
    ;;
  rollback)
    $PY "$ENGINE" rollback "$@"
    ;;
  skill-route)
    DIR="${1:?需要 session 目录}"; TID="${2:?需要 task_id}"
    shift 2
    $PY "$ENGINE" skill-route --dir "$DIR" --tid "$TID" "$@"
    ;;
  advance-phase)
    $PY "$ENGINE" advance-phase "$@"
    ;;
  gate)
    $PY "$ENGINE" gate "$@"
    ;;
  validate-topology)
    TOPO="$(cd "$(dirname "$0")" && pwd)/topology.py"
    CONFIG="${1:-.pipeline-orchestrator.yaml}"
    $PY "$TOPO" "$CONFIG"
    ;;
  gen-template)
    $PY "$ENGINE" gen-template "$@"
    ;;
  generate-skill)
    # 声明式编排生成器 — 调用 Node.js
    GENERATOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/generator"
    ENTRY="$GENERATOR_DIR/dist/generate-orchestrator.js"
    if [ ! -f "$ENTRY" ]; then
      echo "generate-skill: 生成器未编译，请先执行 npm run build -w packages/generator" >&2
      exit 1
    fi
    node "$ENTRY" "$@"
    ;;
  *)
    echo "未知命令: $CMD"
    cat << 'USAGE'
用法:
  orchestrate.sh init              <name> <tasks_json> [profile] [--project id] [--template name|path] 创建 session
  orchestrate.sh list              [--project …] [--all]       列出 session
  orchestrate.sh next              <session_dir>               查询可执行 task
  orchestrate.sh start             <dir> <tid> <agent> [skill] 标记开始
  orchestrate.sh done              <dir> <tid>                 标记完成 (stdin=日志)
  orchestrate.sh fail              <dir> <tid> <error>         标记失败 (stdin=日志)
  orchestrate.sh retry             <dir> <tid>                 将 FAILED task 重置为 PENDING（用于 error-fixer 修复后重试）
  orchestrate.sh status            <dir>                       session 概览
  orchestrate.sh validate          <dir> [engine validate 额外参数…]  数据校验（可接 --openspec-change / --openspec-repo-root）
  orchestrate.sh complete          <dir>                       完成 session
  orchestrate.sh update-session    <dir> <section> <content>   更新 session.md
  orchestrate.sh inject-rag        <dir> <query> [--cross-project]  RAG 注入历史经验
  orchestrate.sh consistency-check <dir> <type> [tid] <result> 上下文一致性校验
  orchestrate.sh test-gate         <dir> <type> <result>       测试质量门（严格证据模式见 PIPELINE_STRICT_TEST_EVIDENCE）
  orchestrate.sh snapshot          <dir> <tid>                 创建 git 快照
  orchestrate.sh trend              [--project …]              编排趋势统计
  orchestrate.sh rollback           [--dir … --tid …]          回滚到指定 task 之后重做后续任务
  orchestrate.sh skill-route        <dir> <tid> [--config …]   根据 YAML 配置解析 Skill 路由
  orchestrate.sh advance-phase      --dir <dir> [--to <id>]    推进 Phase 状态机
  orchestrate.sh gate               --dir <dir> --gate-id <id> --decision <pass|fail|fix> [--reason <text>]  Gate 决策
  orchestrate.sh validate-topology  [config_file]              校验编排拓扑声明合法性
  orchestrate.sh gen-template       --name <n> [--desc <d>] [--from <base>] [--force]  根据描述生成编排模板
  orchestrate.sh generate-skill     …                          声明式生成 Skill Markdown（需先 npm run build -w packages/generator）
USAGE
    exit 1
    ;;
esac
