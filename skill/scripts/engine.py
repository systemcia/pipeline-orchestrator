#!/usr/bin/env python3
"""pipeline-orchestrator 编排引擎核心。

所有 session/task 状态操作集中在此，orchestrate.sh 只做薄壳调度。
通过 argparse 传参，彻底消除 shell 字符串注入风险。

用法:
    python3 engine.py init     --name <name> --tasks <json> [--project …] [--profile …] [--template …] [--openspec-change … --openspec-repo-root …]
    python3 engine.py list     [--project …] [--all]
    python3 engine.py next     --dir <session_dir>
    python3 engine.py start    --dir <dir> --tid <id> --agent <type> [--skill <s>]
    python3 engine.py done     --dir <dir> --tid <id>              (stdin=日志)
    python3 engine.py fail     --dir <dir> --tid <id> --error <msg> [--error-class …] (stdin=日志)
    python3 engine.py retry    --dir <dir> --tid <id>              将 FAILED task 重置为 PENDING（保留 corrections）
    python3 engine.py status   --dir <dir>
    python3 engine.py validate --dir <dir> [--openspec-change … --openspec-repo-root …]
    python3 engine.py complete --dir <dir>
    python3 engine.py update-session --dir <dir> --section <s> --content <c>
    python3 engine.py inject-rag --dir <dir> --query <q> [--cross-project]
    python3 engine.py trend      [--project …]
    python3 engine.py rollback   --dir <session_dir> --tid <task_id>
    python3 engine.py skill-route --dir <dir> --tid <id> [--config path]

环境变量:
    PIPELINE_PROJECT — list/trend/inject-rag 未显式指定项目时的当前项目 id（默认 _default）
    PIPELINE_STRICT_TEST_EVIDENCE=1 — test-gate 在 passed=true 时强制要求 JSON 含 shell_exit_code==0（见 references/protocols.md「确定性证据」）
"""

from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import re
import subprocess
import sys

try:
    import fcntl
except ImportError:
    if os.name == "nt":
        print("ERROR: Windows 原生不支持 fcntl 文件锁，请使用 WSL2", file=sys.stderr)
        sys.exit(1)
    raise
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import yaml as _yaml
except ImportError:
    _yaml = None

# ── 模块化拆分：导入子模块并建立兼容别名 ──────────────────────
from _state import (
    now as _now, state_path as _state_path, lock_path as _lock_path,
    StateLock as _StateLock, read_state as _read_state, write_state as _write_state,
    find_task as _find_task, duration_ms_since as _duration_ms_since,
    duration_ms_between as _duration_ms_between, next_log_seq as _next_log_seq,
    write_log as _write_log,
)
from _config import (
    default_project as _default_project, state_project_id as _state_project_id,
    strict_test_evidence_enabled as _strict_test_evidence_enabled,
    orchestrator_home as _orchestrator_home, load_init_pipeline_yaml as _load_init_pipeline_yaml,
    resolve_init_template_path as _resolve_init_template_path,
    merge_orchestration_layers as _merge_orchestration_layers,
    load_project_config as _load_project_config, load_pipeline_config as _load_pipeline_config,
    CONFIG_FILENAME as _CONFIG_FILENAME, CONFIG_DEFAULTS as _CONFIG_DEFAULTS,
    DEFAULT_PROJECT_ID,
)
from _session import (
    count_section_entries as _count_section_entries,
    archive_oldest_entry as _archive_oldest_entry,
    split_stage_detail_task_entries as _split_stage_detail_task_entries,
    compact_session_md_current_stage as _compact_session_md_current_stage,
    compress_rag_section as _compress_rag_section,
    update_session_section as _update_session_section,
    rebuild_context_md as _rebuild_context_md,
)
from _telemetry import (
    append_telemetry as _append_telemetry, notify_event as _notify_event,
    audit_write as _audit_write, api_get as _api_get, API_BASE,
)
from _template import (
    infer_template_fields as _infer_template_fields,
    render_yaml_value as _render_yaml_value,
    render_template_yaml as _render_template_yaml,
    load_base_template as _load_base_template,
)
# ── 模块化拆分结束 ────────────────────────────────────────────

SESSIONS_ROOT = Path(
    os.environ.get("PIPELINE_SESSIONS_DIR")
    or os.environ.get("PIPELINE_SESSIONS_ROOT")
    or "/opt/pipeline-orchestrator/sessions"
)


# OpenSpec tasks.md 中行级 checkbox 任务 ID（支持 N.M 和 N.M.K 格式，如 1.1、2.3.1）
_OPENSPEC_TASK_LINE = re.compile(r"^\s*-\s+\[[ xX]\]\s+(\d+(?:\.\d+)+)\b")



# ── 子命令实现 ──────────────────────────────────────────────


def cmd_init(args):
    try:
        tasks_raw = json.loads(args.tasks)
    except json.JSONDecodeError as e:
        print(f"ERROR: tasks JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(tasks_raw, list) or not tasks_raw:
        print("ERROR: tasks 必须是非空 JSON 数组", file=sys.stderr)
        sys.exit(1)
    seen_ids: set[str] = set()
    for i, t in enumerate(tasks_raw):
        if not t.get("name"):
            print(f"ERROR: tasks[{i}] 缺少 name 字段", file=sys.stderr)
            sys.exit(1)
        tid = t.get("id", f"t{i + 1}")
        if tid in seen_ids:
            print(f"ERROR: tasks[{i}] id '{tid}' 重复", file=sys.stderr)
            sys.exit(1)
        seen_ids.add(tid)
    project = (args.project or DEFAULT_PROJECT_ID).strip() or DEFAULT_PROJECT_ID
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    project_root = SESSIONS_ROOT / project
    session_dir = project_root / f"pipe-{ts}"
    seq = 0
    while session_dir.exists():
        seq += 1
        session_dir = project_root / f"pipe-{ts}-{seq}"
    session_id = session_dir.name
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "logs").mkdir(exist_ok=True)
    (session_dir / "snapshots").mkdir(exist_ok=True)

    # 第一遍：构建 name→id 映射（用于 depends_on 规范化）
    name_to_id: dict[str, str] = {}
    for i, t in enumerate(tasks_raw):
        tid = t.get("id", f"t{i + 1}")
        name_to_id[t["name"]] = tid

    tasks = []
    for i, t in enumerate(tasks_raw):
        tid = t.get("id", f"t{i + 1}")
        name = t["name"]
        remote_match = re.search(r'\[remote:([^:\]]+)(?::(\d+))?\]$', name)
        if remote_match:
            task_type = "remote"
            remote_project = remote_match.group(1)
            remote_port = int(remote_match.group(2)) if remote_match.group(2) else 9226
            name = name[:remote_match.start()].rstrip()
        else:
            task_type = "local"
            remote_project = None
            remote_port = None
        if "depends_on" in t and t["depends_on"] is not None:
            deps = [name_to_id.get(d, d) for d in t["depends_on"]]
        elif i > 0:
            deps = [tasks[i - 1]["id"]]
        else:
            deps = []
        tasks.append({
            "id": tid,
            "name": name,
            "description": t.get("description", ""),
            "status": "PENDING",
            "tier": t.get("tier", f"tier-{i + 1}"),
            "skill": t.get("skill"),
            "agent_type": t.get("agent_type", ""),
            "depends_on": deps,
            "type": task_type,
            "remote_project": remote_project,
            "remote_port": remote_port,
            "started_at": None,
            "completed_at": None,
            "error": None,
            "log_file": None,
            "corrections": 0,
            "openspec_task_id": t.get("openspec_task_id"),
            "owns_globs": t.get("owns_globs"),
        })

    # Phase 初始化：从 topology 读取或使用默认 6 phases
    cfg_full = _load_init_pipeline_yaml()
    topo = cfg_full.get("topology") or {}
    topo_phases = topo.get("phases") or []
    if topo_phases:
        phases = [
            {
                "id": p["id"], "name": p["name"],
                "status": "ACTIVE" if p["id"] == 0 else "PENDING",
                "entered_at": _now() if p["id"] == 0 else None,
                "completed_at": None,
            }
            for p in topo_phases
        ]
    else:
        _DEFAULT_PHASE_NAMES = ["bootstrap", "propose", "session", "execute", "complete", "feedback"]
        phases = [
            {
                "id": i, "name": name,
                "status": "ACTIVE" if i == 0 else "PENDING",
                "entered_at": _now() if i == 0 else None,
                "completed_at": None,
            }
            for i, name in enumerate(_DEFAULT_PHASE_NAMES)
        ]

    # Gate 初始化：从 topology.gates 读取，按 profile.gates 过滤
    topo_gates = topo.get("gates") or []
    profile_name = (args.profile or "").strip()
    profiles_cfg = cfg_full.get("profiles") or {}
    prof_cfg = profiles_cfg.get(profile_name) if profile_name else None
    if prof_cfg and isinstance(prof_cfg, dict) and "gates" in prof_cfg:
        allowed_gate_ids = set(prof_cfg["gates"])
        filtered_gates = [g for g in topo_gates if g.get("id") in allowed_gate_ids]
    else:
        filtered_gates = list(topo_gates)
    gate_results = [
        {
            "gate_id": g["id"], "phase": g.get("phase"),
            "decision": None, "decided_at": None, "reason": None,
        }
        for g in filtered_gates
    ]

    state = {
        "id": session_id,
        "project_id": project,
        "name": args.name,
        "status": "APPLYING",
        "scale": "large" if len(tasks) >= 4 else ("medium" if len(tasks) >= 2 else "small"),
        "mode": "normal",
        "profile": args.profile,
        "current_phase": 0,
        "phases": phases,
        "gate_results": gate_results,
        "openspec_change": (
            args.openspec_change
            or os.environ.get("PIPELINE_OPENSPEC_CHANGE")
            or None
        ),
        "openspec_repo_root": (
            args.openspec_repo_root
            or os.environ.get("PIPELINE_OPENSPEC_REPO_ROOT")
            or None
        ),
        "parallel_strategy": args.parallel_strategy or os.environ.get("PIPELINE_PARALLEL_STRATEGY"),
        "created_at": _now(),
        "updated_at": _now(),
        "config": _load_project_config(),
        "cwd": os.getcwd(),
        "tasks": tasks,
        "rag_queries": [],
        "consistency_checks": [],
        "test_results": [],
        "session_md_lines": 0,
    }

    if getattr(args, "template", None):
        tpl_path = _resolve_init_template_path(args.template)
        state.update(_merge_orchestration_layers(cfg_full, args.profile, tpl_path))

    _write_state(str(session_dir), state)

    # session.md
    with open(session_dir / "session.md", "w") as f:
        f.write(f"# Pipeline Session: {args.name}\n\n")
        f.write("## 用户原始需求\n（由 orchestrator 填充）\n\n")
        f.write("## 关键约束和决策\n（执行过程中积累）\n\n")
        f.write("## 历史经验\n（RAG 搜索结果自动追加）\n\n")
        f.write("## 当前阶段详情\n\n")
        f.write("## 待确认事项\n→ 详见 pending.md\n")

    # pending.md
    with open(session_dir / "pending.md", "w") as f:
        f.write("# 待确认事项\n\n")
        f.write("| # | 阶段 | 时间 | 决策点 | 自动选择 | 风险 |\n")
        f.write("|---|------|------|--------|----------|------|\n")

    print(json.dumps({
        "session_id": session_id,
        "session_dir": str(session_dir),
        "tasks": len(tasks),
    }, ensure_ascii=False))


def _iter_legacy_pipe_session_dirs():
    """旧版布局：SESSIONS_ROOT 下直接的 pipe-* 目录。"""
    if not SESSIONS_ROOT.is_dir():
        return
    for d in sorted(SESSIONS_ROOT.iterdir(), reverse=True):
        if not d.is_dir() or not d.name.startswith("pipe-"):
            continue
        if (d / "state.json").is_file():
            yield d


def _iter_nested_pipe_session_dirs(project_root: Path):
    """SESSIONS_ROOT/<project_id>/pipe-* 目录。"""
    if not project_root.is_dir():
        return
    for d in sorted(project_root.iterdir(), reverse=True):
        if not d.is_dir() or not d.name.startswith("pipe-"):
            continue
        if (d / "state.json").is_file():
            yield d


def _collect_list_candidates(all_projects: bool, target_project: str | None) -> list[tuple[Path, str]]:
    """返回 (session_dir, path_project) path_project 为目录归属的项目 id（用于 _default 双路径）。"""
    out: list[tuple[Path, str]] = []
    if all_projects:
        for d in _iter_legacy_pipe_session_dirs():
            out.append((d, DEFAULT_PROJECT_ID))
        for proj_dir in sorted(SESSIONS_ROOT.iterdir()):
            if not proj_dir.is_dir() or proj_dir.name.startswith("pipe-"):
                continue
            for d in _iter_nested_pipe_session_dirs(proj_dir):
                out.append((d, proj_dir.name))
        return out

    assert target_project is not None
    if target_project == DEFAULT_PROJECT_ID:
        for d in _iter_legacy_pipe_session_dirs():
            out.append((d, DEFAULT_PROJECT_ID))
    for d in _iter_nested_pipe_session_dirs(SESSIONS_ROOT / target_project):
        out.append((d, target_project))
    return out


def cmd_list(args):
    if not SESSIONS_ROOT.is_dir():
        print(json.dumps({"sessions": []}, ensure_ascii=False))
        return

    all_projects = bool(getattr(args, "all", False))
    project_opt = getattr(args, "project", None)
    target_project = None if all_projects else (
        (project_opt.strip() if project_opt else None) or _default_project()
    )

    candidates = _collect_list_candidates(all_projects, target_project)
    seen: set[str] = set()
    sessions = []
    for d, _path_proj in candidates:
        key = str(d.resolve())
        if key in seen:
            continue
        seen.add(key)
        sf = d / "state.json"
        try:
            with open(sf) as f:
                state = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"WARN: 跳过损坏 session {d.name}: {e}", file=sys.stderr)
            continue
        if not all_projects:
            eff = _state_project_id(state)
            # _default 含旧版根目录与 SESSIONS_ROOT/_default/，仅收录 state 归属 _default 的
            if target_project == DEFAULT_PROJECT_ID and eff != DEFAULT_PROJECT_ID:
                continue
            # 非 _default 仅遍历对应子目录，路径为准，不按 eff 过滤
        total = len(state.get("tasks", []))
        done = sum(1 for t in state.get("tasks", []) if t["status"] in ("COMPLETED", "SKIPPED"))
        sessions.append({
            "id": state.get("id", d.name),
            "project_id": _state_project_id(state),
            "dir": str(d),
            "name": state.get("name", ""),
            "status": state.get("status", ""),
            "progress": f"{done}/{total}",
            "created_at": state.get("created_at", ""),
        })

    print(json.dumps({"sessions": sessions}, ensure_ascii=False, indent=2))


def _compute_parallel_groups(ready: list[dict], state: dict) -> list[list[str]]:
    """根据 owns_globs 和依赖关系判定并行分组。
    
    规则：同组内的 task 互不依赖 + owns_globs 无交集。
    输出：[[tid1, tid2], [tid3]]，单 task 组不输出。
    """
    if len(ready) <= 1:
        return []
    max_parallel = (state.get("config") or {}).get("max_parallel", 3)

    def _globs_overlap(a: list[str] | None, b: list[str] | None) -> bool:
        if not a or not b:
            return False
        for ga in a:
            for gb in b:
                prefix_a = ga.replace("*", "").replace("?", "").rstrip("/")
                prefix_b = gb.replace("*", "").replace("?", "").rstrip("/")
                if not prefix_a or not prefix_b:
                    return True
                if prefix_a.startswith(prefix_b) or prefix_b.startswith(prefix_a):
                    return True
        return False

    groups: list[list[str]] = []
    for t in ready:
        placed = False
        for g in groups:
            if len(g) >= max_parallel:
                continue
            conflict = False
            for existing_id in g:
                et = next((x for x in ready if x["id"] == existing_id), None)
                if not et:
                    continue
                if _globs_overlap(t.get("owns_globs"), et.get("owns_globs")):
                    conflict = True
                    break
            if not conflict:
                g.append(t["id"])
                placed = True
                break
        if not placed:
            groups.append([t["id"]])
    return [g for g in groups if len(g) > 0]


def cmd_next(args):
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        task_map = {t["id"]: t for t in state["tasks"]}

        any_skipped = False
        propagating = True
        while propagating:
            propagating = False
            for t in state["tasks"]:
                if t["status"] != "PENDING":
                    continue
                deps = t.get("depends_on") or []
                if any(task_map.get(d, {}).get("status") in ("FAILED", "SKIPPED") for d in deps):
                    t["status"] = "SKIPPED"
                    t["error"] = "dependency failed"
                    propagating = True
                    any_skipped = True

        if any_skipped:
            _write_state(args.dir, state)

        ready = []
        for t in state["tasks"]:
            if t["status"] != "PENDING":
                continue
            deps = t.get("depends_on") or []
            if all(task_map.get(d, {}).get("status") in ("COMPLETED", "SKIPPED") for d in deps):
                ready.append(t)

    if ready:
        parallel_groups = _compute_parallel_groups(ready, state)
        out: dict = {
            "status": "READY",
            "tasks": [{
                "id": t["id"], "name": t["name"],
                "description": t.get("description", ""),
                "tier": t["tier"], "skill": t.get("skill"),
                "depends_on": t.get("depends_on", []),
            } for t in ready],
        }
        if parallel_groups:
            out["parallel_groups"] = parallel_groups
        print(json.dumps(out, ensure_ascii=False))
    elif all(t["status"] in ("COMPLETED", "SKIPPED", "FAILED") for t in state["tasks"]):
        pending_path = Path(args.dir) / "pending.md"
        pending_count = 0
        if pending_path.is_file():
            pending_text = pending_path.read_text(encoding="utf-8", errors="replace")
            pending_count = max(0, pending_text.count("\n|") - 1)
        failed_count = sum(1 for t in state["tasks"] if t["status"] == "FAILED")
        print(json.dumps({
            "status": "ALL_DONE", "tasks": [],
            "pending_count": pending_count,
            "failed_count": failed_count,
        }, ensure_ascii=False))
    else:
        running = [t["id"] for t in state["tasks"] if t["status"] == "RUNNING"]
        blocked = [t["id"] for t in state["tasks"] if t["status"] == "PENDING"]
        print(json.dumps({"status": "WAITING", "running": running, "blocked": blocked}, ensure_ascii=False))


def cmd_start(args):
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        task = _find_task(state, args.tid)
        if task["status"] != "PENDING":
            print(f"ERROR: {args.tid} is {task['status']}, expected PENDING", file=sys.stderr)
            sys.exit(1)
        corrections = task.get("corrections", 0)
        task["status"] = "RUNNING"
        task["started_at"] = _now()
        task["agent_type"] = args.agent
        task["skill"] = args.skill
        sid = state["id"]
        session_md_lines = state.get("session_md_lines", 0)
        _write_state(args.dir, state)

    ctx_path = Path(args.dir) / "context.md"
    context_chars = 0
    if ctx_path.is_file():
        try:
            context_chars = len(ctx_path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass

    _append_telemetry(
        args.dir,
        {"event": "start", "tid": args.tid, "session_id": sid},
    )
    msg = f"OK: {args.tid} -> RUNNING (context_chars: {context_chars}, session_md_lines: {session_md_lines})"
    if corrections >= 2:
        msg += f" WARN: 已修复 {corrections} 次，建议标记 FAILED 或人工介入"
    elif corrections == 1:
        msg += " (retry #1)"
    print(msg)
    _notify_event(args.dir, "task_start", task_id=args.tid)


def _try_auto_advance_phase(session_dir: str, state: dict) -> str | None:
    """所有 task 终结时自动推进 execute Phase。返回推进结果描述或 None。"""
    phases = state.get("phases")
    if not phases:
        return None
    all_done = all(t["status"] in ("COMPLETED", "SKIPPED", "FAILED") for t in state["tasks"])
    if not all_done:
        return None
    cur = state.get("current_phase", 0)
    phase_map = {p["id"]: p for p in phases}
    cur_phase = phase_map.get(cur)
    if not cur_phase or cur_phase["name"] != "execute" or cur_phase["status"] != "ACTIVE":
        return None
    from_name = cur_phase["name"]
    cur_phase["status"] = "COMPLETED"
    cur_phase["completed_at"] = _now()
    next_phase = phase_map.get(cur + 1)
    if next_phase and next_phase["status"] == "PENDING":
        next_phase["status"] = "ACTIVE"
        next_phase["entered_at"] = _now()
        state["current_phase"] = next_phase["id"]
        to_name = next_phase["name"]
    else:
        to_name = "?"
    _write_state(session_dir, state)
    _notify_event(session_dir, "phase_advance", data={"from": from_name, "to": to_name, "auto": True})
    return f"phase auto-advanced: {from_name} -> {to_name}"


def _quality_hint(state: dict, tid: str) -> str:
    """根据 task 历史和 session 检查拦截率判断质量门策略。
    
    subagent 条件（任一）：有修复记录、大规模、历史检查有拦截。
    inline 条件：无修复、小/中规模、session 内所有检查均 PASS。
    """
    task = None
    for t in state["tasks"]:
        if t["id"] == tid:
            task = t
            break
    if not task:
        return "subagent"
    if task.get("corrections", 0) > 0:
        return "subagent"
    scale = state.get("scale", "medium")
    if scale == "large":
        return "subagent"
    any_caught = any(
        tr.get("was_useful") for tr in state.get("test_results", [])
    ) or any(
        cc.get("was_useful") for cc in state.get("consistency_checks", [])
    )
    if any_caught:
        return "subagent"
    return "inline"


def _resolve_git_cwd(session_dir: str, state: dict) -> str | None:
    """从 state.json 的 cwd 字段获取项目 git 仓库路径，回退到 session_dir。"""
    candidate = state.get("cwd") or session_dir
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, cwd=candidate)
    if r.returncode == 0:
        return r.stdout.strip()
    print(f"WARN: snapshot skipped — '{candidate}' is not inside a git repo", file=sys.stderr)
    return None


def _auto_snapshot(session_dir: str, tid: str, state: dict) -> str | None:
    """task 完成后自动创建 git 快照，返回 tag 名或 None。"""
    if "snapshot" in (state.get("skip_steps") or []):
        return None
    git_cwd = _resolve_git_cwd(session_dir, state)
    if git_cwd is None:
        return None
    session_id = state.get("id", "unknown")
    tag_name = f"pipeline/{session_id}/after-{tid}"
    subprocess.run(["git", "tag", "-f", tag_name], capture_output=True, text=True, cwd=git_cwd)
    task = _find_task(state, tid)
    task["snapshot_ref"] = tag_name
    ref_path = Path(session_dir) / "snapshots" / f"after-{tid}.ref"
    ref_path.parent.mkdir(parents=True, exist_ok=True)
    ref_path.write_text(tag_name)
    return tag_name


def cmd_done(args):
    log_rel = _write_log(args.dir, args.tid)
    snap_ref = None
    auto_completed = False
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        task = _find_task(state, args.tid)
        if task["status"] != "RUNNING":
            print(f"ERROR: {args.tid} is {task['status']}, expected RUNNING", file=sys.stderr)
            sys.exit(1)
        sid = state["id"]
        duration_ms = _duration_ms_since(task.get("started_at"))
        task["status"] = "COMPLETED"
        task["completed_at"] = _now()
        task["log_file"] = log_rel

        snap_ref = _auto_snapshot(args.dir, args.tid, state)

        hint = _quality_hint(state, args.tid)
        phase_msg = _try_auto_advance_phase(args.dir, state)

        if (
            state["status"] == "APPLYING"
            and all(t["status"] in ("COMPLETED", "SKIPPED", "FAILED") for t in state["tasks"])
        ):
            state["status"] = "COMPLETED"
            auto_completed = True

        if not phase_msg:
            _write_state(args.dir, state)
    _append_telemetry(
        args.dir,
        {
            "event": "done",
            "tid": args.tid,
            "session_id": sid,
            "duration_ms": duration_ms,
            "outcome": "COMPLETED",
        },
    )
    msg = f"OK: {args.tid} -> COMPLETED (log: {log_rel}, quality_hint: {hint})"
    if snap_ref:
        msg += f" [snapshot: {snap_ref}]"
    if phase_msg:
        msg += f" [{phase_msg}]"
    if auto_completed:
        msg += " [session auto-completed: all tasks terminal]"
    print(msg)
    _notify_event(args.dir, "task_done", task_id=args.tid)


def cmd_fail(args):
    log_rel = _write_log(args.dir, args.tid, suffix="-FAILED")
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        task = _find_task(state, args.tid)
        if task["status"] != "RUNNING":
            print(f"ERROR: {args.tid} is {task['status']}, expected RUNNING", file=sys.stderr)
            sys.exit(1)
        sid = state["id"]
        duration_ms = _duration_ms_since(task.get("started_at"))
        task["status"] = "FAILED"
        task["completed_at"] = _now()
        task["log_file"] = log_rel
        task["error"] = args.error
        task["corrections"] = task.get("corrections", 0) + 1
        _write_state(args.dir, state)
    err_snip = (args.error or "")[:500]
    err_low = (args.error or "").lower()
    if args.error_class:
        err_cls = args.error_class
    elif "mcp" in err_low or "model context protocol" in err_low:
        err_cls = "mcp_tool_failed"
    elif "tool" in err_low and any(x in err_low for x in ("invoke", "call", "timeout", "rpc")):
        err_cls = "tool_invoke_failed"
    else:
        err_cls = "task_failed"
    _append_telemetry(
        args.dir,
        {
            "event": "fail",
            "tid": args.tid,
            "session_id": sid,
            "duration_ms": duration_ms,
            "error_class": err_cls,
            "error": err_snip,
        },
    )
    print(f"OK: {args.tid} -> FAILED (log: {log_rel})")
    _notify_event(args.dir, "task_fail", task_id=args.tid, data={"error": args.error})


def cmd_retry(args):
    """将 FAILED task 重置为 PENDING（保留 corrections 计数），用于 error-fixer 修复后重试。"""
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        task = _find_task(state, args.tid)
        if task["status"] != "FAILED":
            print(f"ERROR: {args.tid} is {task['status']}, expected FAILED", file=sys.stderr)
            sys.exit(1)
        corrections = task.get("corrections", 0)
        task["status"] = "PENDING"
        task["started_at"] = None
        task["completed_at"] = None
        task["error"] = None
        if state.get("status") == "FAILED":
            state["status"] = "APPLYING"
        _write_state(args.dir, state)
    msg = f"OK: {args.tid} -> PENDING (corrections: {corrections})"
    if corrections >= 2:
        msg += " WARN: 已修复多次，建议人工介入而非继续重试"
    print(msg)
    _notify_event(args.dir, "task_retry", task_id=args.tid)


def cmd_status(args):
    state = _read_state(args.dir)
    counts = {}
    for t in state["tasks"]:
        s = t["status"]
        counts[s] = counts.get(s, 0) + 1

    total = len(state["tasks"])
    done = counts.get("COMPLETED", 0) + counts.get("SKIPPED", 0)
    pct = round(done / total * 100) if total > 0 else 0

    elapsed_ms = _duration_ms_since(state.get("created_at"))
    completed_tasks = [t for t in state["tasks"] if t["status"] == "COMPLETED" and t.get("started_at") and t.get("completed_at")]
    avg_task_ms = None
    if completed_tasks:
        durations = [d for t in completed_tasks if (d := _duration_ms_between(t["started_at"], t["completed_at"])) is not None]
        if durations:
            avg_task_ms = sum(durations) // len(durations)

    result = {
        "id": state.get("id", "unknown"),
        "name": state.get("name", ""),
        "session_status": state.get("status", "UNKNOWN"),
        "progress": f"{pct}% ({done}/{total})",
        "task_counts": counts,
    }
    if elapsed_ms is not None:
        result["elapsed_minutes"] = round(elapsed_ms / 60000, 1)
    if avg_task_ms is not None:
        result["avg_task_minutes"] = round(avg_task_ms / 60000, 1)

    phases = state.get("phases")
    if phases:
        cur = state.get("current_phase", 0)
        phase_map = {p["id"]: p for p in phases}
        cur_name = phase_map[cur]["name"] if cur in phase_map else "unknown"
        phase_done = sum(1 for p in phases if p["status"] in ("COMPLETED", "SKIPPED"))
        result["current_phase"] = cur
        result["phase_name"] = cur_name
        result["phase_progress"] = f"{phase_done}/{len(phases)} completed (current: {cur_name})"

    print(json.dumps(result, ensure_ascii=False, indent=2))


def _parse_openspec_task_ids_from_md(path: Path) -> set[str]:
    """从 OpenSpec change 的 tasks.md 解析 `- [ ] N.M[.K]` 任务 ID 集合。"""
    if not path.is_file():
        return set()
    ids: set[str] = set()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    has_checkbox = False
    for line in text.splitlines():
        if re.match(r"^\s*-\s+\[[ xX]\]", line):
            has_checkbox = True
        m = _OPENSPEC_TASK_LINE.match(line)
        if m:
            ids.add(m.group(1))
    if has_checkbox and not ids:
        print(
            f"WARN: {path} 含 checkbox 行但未解析到 N.M 格式任务 ID，"
            "请确认 tasks.md 格式为 '- [ ] 1.1 描述'",
            file=sys.stderr,
        )
    return ids


def _openspec_alignment_errors(
    state: dict,
    cli_change: str | None,
    cli_root: str | None,
) -> list[str]:
    """OpenSpec tasks.md 与 session.tasks.openspec_task_id 集合比对；未配置则跳过。"""
    change = (cli_change or "").strip() or (state.get("openspec_change") or "")
    root = (cli_root or "").strip() or (state.get("openspec_repo_root") or "")
    if not change or not root:
        return []
    tasks_md = Path(root) / "openspec" / "changes" / change / "tasks.md"
    if not tasks_md.is_file():
        return [f"openspec: tasks.md 不存在: {tasks_md}"]
    spec_ids = _parse_openspec_task_ids_from_md(tasks_md)
    if not spec_ids:
        return [f"openspec: 未从 {tasks_md} 解析到任何 N.M 格式任务行（期望 - [ ] 1.1 样式）"]
    sess_ids = {t.get("openspec_task_id") for t in state.get("tasks", []) if t.get("openspec_task_id")}
    if not sess_ids:
        return [
            "openspec: state.tasks 缺少 openspec_task_id，无法与 tasks.md 比对；"
            "请在 $O init 的 JSON 各 task 增加 openspec_task_id（与 OpenSpec tasks.md 的 N.M 对应）"
        ]
    errors = []
    only_spec = sorted(spec_ids - sess_ids)
    only_sess = sorted(sess_ids - spec_ids)
    if only_spec:
        errors.append(f"openspec 漂移: tasks.md 有、session 无 openspec_task_id: {only_spec}")
    if only_sess:
        errors.append(f"openspec 漂移: session 有、tasks.md 无对应行: {only_sess}")
    return errors


def _validate_state(session_dir: str) -> list[str]:
    """校验 session 数据完整性，返回错误列表（空=通过）。"""
    state = _read_state(session_dir)
    errors = []
    tasks = state.get("tasks", [])
    all_ids = {t["id"] for t in tasks}

    seen_ids: set[str] = set()
    for t in tasks:
        tid = t["id"]
        if tid in seen_ids:
            errors.append(f"{tid}: duplicate task id")
        seen_ids.add(tid)

        deps = t.get("depends_on")
        if deps is None:
            errors.append(f"{tid}: depends_on is null (should be [])")
        else:
            for dep in deps:
                if dep not in all_ids:
                    errors.append(f"{tid}: depends_on references unknown task '{dep}'")

        if t["status"] in ("COMPLETED", "FAILED"):
            if not t.get("started_at"):
                errors.append(f"{tid}: {t['status']} but no started_at")
            if not t.get("completed_at"):
                errors.append(f"{tid}: {t['status']} but no completed_at")
            if not t.get("log_file"):
                errors.append(f"{tid}: {t['status']} but no log_file")
        if t["status"] == "FAILED" and not t.get("error"):
            errors.append(f"{tid}: FAILED but no error message")
        if t["status"] == "RUNNING" and not t.get("started_at"):
            errors.append(f"{tid}: RUNNING but no started_at")

    if not state.get("name"):
        errors.append("session: no name")

    logs_dir = Path(session_dir) / "logs"
    log_count = len([f for f in logs_dir.iterdir() if f.suffix == ".md"]) if logs_dir.is_dir() else 0
    done_count = sum(1 for t in tasks if t["status"] in ("COMPLETED", "FAILED"))
    if done_count > 0 and log_count == 0:
        errors.append(f"session: {done_count} tasks done but logs/ is empty")

    return errors


def cmd_validate(args):
    errors = _validate_state(args.dir)
    state = _read_state(args.dir)
    errors.extend(
        _openspec_alignment_errors(
            state,
            getattr(args, "openspec_change", None),
            getattr(args, "openspec_repo_root", None),
        )
    )

    warns: list[str] = []
    tasks = state.get("tasks", [])
    id_to_deps = {t["id"]: t.get("depends_on") or [] for t in tasks}
    all_ids = set(id_to_deps.keys())
    children: dict[str, set[str]] = {tid: set() for tid in all_ids}
    for tid, deps in id_to_deps.items():
        for dep in deps:
            if dep in all_ids:
                children[dep].add(tid)

    def _reachable(start: str, end: str) -> bool:
        visited: set[str] = set()
        stack = [start]
        while stack:
            node = stack.pop()
            if node in visited:
                continue
            visited.add(node)
            for child in children.get(node, ()):
                if child == end:
                    return True
                if child not in visited:
                    stack.append(child)
        return False

    def _has_dependency_chain(a: str, b: str) -> bool:
        return _reachable(a, b) or _reachable(b, a)

    by_project: dict[str, list[str]] = {}
    for t in tasks:
        if t.get("type") == "remote" and t.get("remote_project"):
            by_project.setdefault(t["remote_project"], []).append(t["id"])

    for project, tids in by_project.items():
        if len(tids) < 2:
            continue
        for i in range(len(tids)):
            for j in range(i + 1, len(tids)):
                if not _has_dependency_chain(tids[i], tids[j]):
                    warns.append(
                        f"remote_project '{project}' 的 task [{tids[i]}, {tids[j]}] "
                        "无依赖链，可能导致并行冲突"
                    )

    if errors:
        print("ERRORS:")
        for e in errors:
            print(f"  ✗ {e}")
    for w in warns:
        print(f"WARN: {w}")
    if not errors:
        print("✓ Session data integrity OK")
    sys.exit(1 if errors else 0)


def cmd_complete(args):
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        unfinished = [t["id"] for t in state["tasks"]
                      if t["status"] in ("PENDING", "RUNNING")]
        if unfinished:
            print(f"ERROR: 以下 task 尚未终止: {', '.join(unfinished)}",
                  file=sys.stderr)
            sys.exit(1)
        state["status"] = "COMPLETED"
        _write_state(args.dir, state)

    errors = _validate_state(args.dir)
    if errors:
        print("WARN: 数据完整性检查有问题，但 session 已标记 COMPLETED")
        for e in errors:
            print(f"  ✗ {e}")
    else:
        print("OK: session -> COMPLETED ✓")


def cmd_update_session(args):
    """更新 session.md 的指定 section，同步 session_md_lines，并自动重建 context.md。"""
    mode = getattr(args, "mode", "append")
    _update_session_section(args.dir, args.section, args.content, mode)

    compacted = _compact_session_md_current_stage(args.dir)
    if compacted:
        old_l, new_l = compacted
        print(
            f"OK: session.md compacted from {old_l} to {new_l} lines "
            "(archived to archive-session.md)"
        )

    sm = Path(args.dir) / "session.md"
    line_count = sm.read_text(encoding="utf-8", errors="replace").count("\n") + 1

    ctx_chars = _rebuild_context_md(args.dir)

    with _StateLock(args.dir):
        state = _read_state(args.dir)
        state["session_md_lines"] = line_count
        _write_state(args.dir, state)

    print(f"OK: session.md [{args.section}] {mode}d ({line_count} lines), context.md rebuilt ({ctx_chars} chars)")
    _notify_event(args.dir, "session_update", data={"section": args.section})


def cmd_inject_rag(args):
    """从管理台 RAG 搜索历史经验，追加到 session.md。"""
    cross = bool(getattr(args, "cross_project", False))
    params: dict[str, str] = {"q": args.query, "limit": "5"}
    if not cross:
        params["project_id"] = _default_project()
    qs = urllib.parse.urlencode(params)
    raw = _api_get(f"/knowledge/rag-search?{qs}")
    results = raw if isinstance(raw, list) else []
    if not results:
        print("INFO: no RAG results found")
        return

    ts = _now()
    lines = [f"### [{ts}] 查询: {args.query}", ""]
    for i, r in enumerate(results):
        lines.append(f"**[{i+1}] {r.get('topic', 'N/A')}** (来源: {r.get('source', '?')})")
        lines.append(f"- 问题: {r.get('query', '')[:200]}")
        lines.append(f"- 经验: {r.get('answer_core', '')[:300]}")
        lines.append("")
    content = "\n".join(lines)

    _update_session_section(args.dir, "历史经验", content)

    with _StateLock(args.dir):
        state = _read_state(args.dir)
        if "rag_queries" not in state:
            state["rag_queries"] = []
        state["rag_queries"].append({
            "query": args.query,
            "results_count": len(results),
            "timestamp": ts,
        })
        _write_state(args.dir, state)
    print(f"OK: RAG injected ({len(results)} results)")


def cmd_consistency_check(args):
    """记录上下文一致性校验结果。"""
    try:
        result = json.loads(args.result)
    except json.JSONDecodeError as e:
        print(f"ERROR: result JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    aligned = result.get("aligned", True)
    was_useful = not aligned

    ts = _now()
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        if "consistency_checks" not in state:
            state["consistency_checks"] = []
        state["consistency_checks"].append({
            "type": args.type,
            "tid": args.tid or "",
            "result": result,
            "was_useful": was_useful,
            "timestamp": ts,
        })
        _write_state(args.dir, state)

    log_seq = _next_log_seq(args.dir)
    suffix = f"-ccc-{args.type}"
    if args.tid:
        suffix += f"-{args.tid}"
    log_name = f"{log_seq}{suffix}.md"
    log_path = Path(args.dir) / "logs" / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as f:
        f.write(f"# 上下文一致性校验 ({args.type})\n\n")
        f.write(f"- 时间: {ts}\n")
        if args.tid:
            f.write(f"- Task: {args.tid}\n")
        f.write(f"\n## 结果\n\n```json\n{json.dumps(result, indent=2, ensure_ascii=False)}\n```\n")

    print(f"OK: CCC {args.type} recorded ({'CAUGHT' if was_useful else 'PASS'}, log: logs/{log_name})")


def cmd_test_gate(args):
    """记录测试质量门结果。"""
    try:
        result = json.loads(args.result)
    except json.JSONDecodeError as e:
        print(f"ERROR: result JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    passed = bool(result.get("passed", result.get("ok", False)))
    if passed and _strict_test_evidence_enabled():
        code = result.get("shell_exit_code")
        if code is None:
            print(
                "ERROR: PIPELINE_STRICT_TEST_EVIDENCE=1 时，passed=true 的 test-gate JSON "
                "必须包含整数字段 shell_exit_code=0（须在对应编译/测试 Shell 已成功 exit 0 之后立即调用）。"
                '示例: {"passed":true,"shell_exit_code":0,"output":"..."}',
                file=sys.stderr,
            )
            sys.exit(1)
        try:
            code_i = int(code)
        except (TypeError, ValueError):
            print("ERROR: shell_exit_code 必须为整数", file=sys.stderr)
            sys.exit(1)
        if code_i != 0:
            print(
                f"ERROR: PIPELINE_STRICT_TEST_EVIDENCE=1 时 passed=true 要求 shell_exit_code==0，当前为 {code!r}",
                file=sys.stderr,
            )
            sys.exit(1)

    was_useful = not passed

    ts = _now()
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        if "test_results" not in state:
            state["test_results"] = []
        state["test_results"].append({
            "type": args.type,
            "result": result,
            "was_useful": was_useful,
            "timestamp": ts,
        })
        _write_state(args.dir, state)

    log_seq = _next_log_seq(args.dir)
    log_name = f"{log_seq}-test-{args.type}.md"
    log_path = Path(args.dir) / "logs" / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as f:
        f.write(f"# 测试质量门 ({args.type})\n\n")
        f.write(f"- 时间: {ts}\n")
        f.write(f"- 通过: {'YES' if passed else 'NO'}\n")
        f.write(f"\n## 详情\n\n```json\n{json.dumps(result, indent=2, ensure_ascii=False)}\n```\n")

    print(f"OK: test-gate {args.type} recorded ({'PASS' if passed else 'FAIL'}, log: logs/{log_name})")


def cmd_snapshot(args):
    """创建 git 快照并记录到 state.json。"""
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        git_cwd = _resolve_git_cwd(args.dir, state)
        if git_cwd is None:
            print("WARN: snapshot skipped — not inside a git repo", file=sys.stderr)
            return
        session_id = state.get("id", "unknown")
        tag_name = f"pipeline/{session_id}/after-{args.tid}"

        subprocess.run(
            ["git", "tag", "-f", tag_name], capture_output=True, text=True, cwd=git_cwd)

        task = _find_task(state, args.tid)
        task["snapshot_ref"] = tag_name
        _write_state(args.dir, state)

    ref_path = Path(args.dir) / "snapshots" / f"after-{args.tid}.ref"
    ref_path.parent.mkdir(parents=True, exist_ok=True)
    ref_path.write_text(tag_name)

    print(f"OK: snapshot {tag_name}")


def _local_intercept_stats(project: str) -> dict:
    """遍历本地 session state.json，统计检查步骤拦截率。"""
    root = SESSIONS_ROOT / project
    if not root.is_dir():
        return {}
    stats: dict[str, dict[str, int]] = {}
    for sf in root.rglob("state.json"):
        try:
            state = json.loads(sf.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for tr in state.get("test_results", []):
            key = f"test-gate:{tr.get('type', '?')}"
            stats.setdefault(key, {"total": 0, "caught": 0})
            stats[key]["total"] += 1
            if tr.get("was_useful"):
                stats[key]["caught"] += 1
        for cc in state.get("consistency_checks", []):
            key = f"ccc:{cc.get('type', '?')}"
            stats.setdefault(key, {"total": 0, "caught": 0})
            stats[key]["total"] += 1
            if cc.get("was_useful"):
                stats[key]["caught"] += 1
    result = {}
    for k, v in sorted(stats.items()):
        rate = round(v["caught"] / v["total"] * 100, 1) if v["total"] > 0 else 0.0
        result[k] = {"total": v["total"], "caught": v["caught"], "intercept_rate": f"{rate}%"}
    return result


def cmd_trend(args):
    """从管理台获取编排趋势统计，叠加本地拦截率。"""
    project = getattr(args, "project", None)
    pid = (project.strip() if project else None) or _default_project()
    qs = urllib.parse.urlencode({"project_id": pid})
    trend = _api_get(f"/analytics/pipeline-trend?{qs}")
    if trend is None:
        trend = {"warn": "管理台不可用，仅展示本地统计"}

    intercept = _local_intercept_stats(pid)
    if intercept:
        trend["intercept_stats"] = intercept

    print(json.dumps(trend, indent=2, ensure_ascii=False))


def cmd_rollback(args):
    """将指定 task 之后的任务重置为 PENDING，session 回到 APPLYING。"""
    tid = (args.tid or "").strip()
    if not tid:
        print("ERROR: --tid 不能为空", file=sys.stderr)
        sys.exit(1)
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        tasks = state.get("tasks", [])
        idx = next((i for i, t in enumerate(tasks) if t.get("id") == tid), None)
        if idx is None:
            print(f"ERROR: task {tid} not found", file=sys.stderr)
            sys.exit(1)
        reset_ids: list[str] = []
        for t in tasks[idx + 1:]:
            reset_ids.append(t["id"])
            t["status"] = "PENDING"
            t["started_at"] = None
            t["completed_at"] = None
            t["agent_type"] = ""
            t["skill"] = None
        state["status"] = "APPLYING"
        _write_state(args.dir, state)
    out = {"reset_tasks": reset_ids, "session_status": "APPLYING"}
    print(json.dumps(out, ensure_ascii=False))


def cmd_advance_phase(args):
    """推进 Phase 状态机：当前 Phase → COMPLETED，下一个 → ACTIVE。"""
    with _StateLock(args.dir):
        state = _read_state(args.dir)
        phases = state.get("phases")
        if not phases:
            print("WARN: session 无 phases 字段（旧 session），跳过", file=sys.stderr)
            return

        cur = state.get("current_phase", 0)
        target = getattr(args, "to", None)
        if target is not None:
            target = int(target)

        phase_map = {p["id"]: p for p in phases}
        cur_phase = phase_map.get(cur)
        if not cur_phase:
            print(f"ERROR: current_phase={cur} 不在 phases 中", file=sys.stderr)
            sys.exit(1)

        from_name = cur_phase["name"]
        cur_phase["status"] = "COMPLETED"
        cur_phase["completed_at"] = _now()

        if target is not None:
            # 跳转模式：中间 Phase SKIPPED
            for p in phases:
                if cur < p["id"] < target:
                    p["status"] = "SKIPPED"
                    p["entered_at"] = p["entered_at"] or _now()
                    p["completed_at"] = _now()
            next_phase = phase_map.get(target)
        else:
            next_phase = phase_map.get(cur + 1)

        if next_phase and next_phase["status"] == "PENDING":
            next_phase["status"] = "ACTIVE"
            next_phase["entered_at"] = _now()
            state["current_phase"] = next_phase["id"]
            to_name = next_phase["name"]
        elif next_phase is None or all(p["status"] in ("COMPLETED", "SKIPPED") for p in phases):
            state["current_phase"] = cur
            state["status"] = "COMPLETED"
            to_name = "(session completed)"
        else:
            state["current_phase"] = next_phase["id"] if next_phase else cur
            to_name = next_phase["name"] if next_phase else "?"

        _write_state(args.dir, state)

    _notify_event(args.dir, "phase_advance", data={"from": from_name, "to": to_name})
    print(f"OK: phase {from_name} -> COMPLETED, now: {to_name}")


def cmd_gate(args):
    """Gate 决策持久化，支持可选的结构化质量报告。"""
    report = None
    report_raw = getattr(args, "report", None)
    if report_raw:
        try:
            report = json.loads(report_raw)
        except json.JSONDecodeError as e:
            print(f"ERROR: --report JSON 解析失败: {e}", file=sys.stderr)
            sys.exit(1)

    with _StateLock(args.dir):
        state = _read_state(args.dir)
        gate_results = state.get("gate_results")
        if gate_results is None:
            state["gate_results"] = []
            gate_results = state["gate_results"]

        gate_id = args.gate_id
        decision = args.decision
        reason = getattr(args, "reason", None) or ""
        ts = _now()

        entry = {
            "gate_id": gate_id,
            "phase": state.get("current_phase"),
            "decision": decision,
            "decided_at": ts,
            "reason": reason,
        }
        if report:
            entry["report"] = report

        found = False
        for i, g in enumerate(gate_results):
            if g["gate_id"] == gate_id:
                gate_results[i] = entry
                found = True
                break

        if not found:
            gate_results.append(entry)

        if decision == "fail":
            state["status"] = "FAILED"

        _write_state(args.dir, state)

    _notify_event(args.dir, "gate_decision", data={
        "gate_id": gate_id, "decision": decision, "reason": reason,
    })
    report_hint = f" (report: {len(report.get('items', []))} items)" if report and isinstance(report, dict) else ""
    print(f"OK: gate {gate_id} -> {decision}{report_hint}")



_BUILTIN_SKILL_KEYWORDS: list[tuple[list[str], str]] = [
    (["优化", "review", "帮我改进"], "optimization-master"),
    (["提交代码", "git push"], "smart-code-push"),
    (["SQL", "DDL", "DML", "建表"], "sql-audit-guide"),
]


def cmd_skill_route(args):
    """根据 YAML 配置和内置关键词表解析 Skill 路由，输出 skill 名或空串。"""
    state = _read_state(args.dir)
    task = _find_task(state, args.tid)

    existing = task.get("skill")
    if existing:
        print(existing)
        return

    config = _load_pipeline_config(getattr(args, "config", None))

    desc = (task.get("description") or task.get("name") or "").lower()
    tid = task.get("id", "")
    ospec_tid = task.get("openspec_task_id") or ""

    for route in config.get("skill_routes") or []:
        if not isinstance(route, dict) or not route.get("skill"):
            continue
        if route.get("task_id_prefix") and tid.startswith(route["task_id_prefix"]):
            print(route["skill"])
            return
        if route.get("openspec_task_id_prefix") and ospec_tid.startswith(route["openspec_task_id_prefix"]):
            print(route["skill"])
            return
        regex = route.get("description_regex")
        if regex:
            try:
                if re.search(regex, desc, re.IGNORECASE):
                    print(route["skill"])
                    return
            except re.error:
                pass

    for keyword, skill in (config.get("custom_routes") or {}).items():
        if keyword.lower() in desc:
            print(skill)
            return

    for keywords, skill in _BUILTIN_SKILL_KEYWORDS:
        if any(kw.lower() in desc for kw in keywords):
            print(skill)
            return

    print("")


def cmd_validate_topology(args):
    """委托 topology 模块做声明式拓扑校验。"""
    from topology import cmd_validate_topology as _impl
    _impl(args)



def cmd_gen_template(args):
    """根据描述文本推断并生成编排模板 YAML（委托 _template 模块）。"""
    name: str = args.name
    desc: str = args.desc or ""
    from_tpl: str | None = getattr(args, "from_template", None)

    if not re.match(r"^[a-z][a-z0-9-]*$", name):
        print(f"ERROR: 模板名必须为 kebab-case: {name}", file=sys.stderr)
        sys.exit(1)

    out_dir = _orchestrator_home() / "templates"
    out_path = out_dir / f"{name}.yaml"
    if out_path.is_file() and not getattr(args, "force", False):
        print(f"ERROR: 模板已存在: {out_path}（使用 --force 覆盖）", file=sys.stderr)
        sys.exit(1)

    if from_tpl:
        fields = _load_base_template(from_tpl, _orchestrator_home(), _yaml)
        if desc:
            overrides = _infer_template_fields(desc)
            for k, v in overrides.items():
                if k == "skip_steps":
                    fields["skip_steps"] = sorted(set(fields.get("skip_steps", []) + v))
                elif k == "gates" and not v:
                    pass
                else:
                    fields[k] = v
    elif desc:
        fields = _infer_template_fields(desc)
    else:
        fields = _infer_template_fields("")

    description = desc if desc else name
    content = _render_template_yaml(name, description, fields)
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        f.write(content)
    print(f"OK: 模板已生成 → {out_path}")
    print(f"使用方式:")
    print(f"  1. $O init <name> <tasks> --template {name}")
    print(f"  2. 项目根目录 .pipeline-orchestrator.yaml 中: template: {name}")


# ── CLI 入口 ────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Pipeline Orchestrator Engine")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--name", required=True)
    p_init.add_argument("--tasks", required=True, help="JSON array of tasks")
    p_init.add_argument("--profile", default=None, help="编排 profile 名称（default/small/hotfix/thorough）")
    p_init.add_argument(
        "--template",
        default=None,
        help="编排模板：短名在 $PIPELINE_ORCHESTRATOR_HOME/templates/{name}.yaml 查找，或传 YAML 文件路径",
    )
    p_init.add_argument(
        "--openspec-change",
        default=None,
        help="OpenSpec change 名；可与环境变量 PIPELINE_OPENSPEC_CHANGE 互斥覆盖（后者优先由代码顺序决定，显式 CLI 优先）",
    )
    p_init.add_argument(
        "--openspec-repo-root",
        default=None,
        help="含 openspec/changes 的仓库根路径；或设 PIPELINE_OPENSPEC_REPO_ROOT",
    )
    p_init.add_argument(
        "--parallel-strategy",
        default=None,
        choices=["ownership", "integrator"],
        help="并行策略摘要写入 state；或设 PIPELINE_PARALLEL_STRATEGY",
    )
    p_init.add_argument(
        "--project",
        default=None,
        help=f"session 归属项目 id，默认 {DEFAULT_PROJECT_ID}；目录为 SESSIONS_ROOT/<project>/pipe-*",
    )

    p_list = sub.add_parser("list")
    p_list.add_argument(
        "--project",
        default=None,
        help="只列出该项目下 session；默认当前项目（PIPELINE_PROJECT 或 _default）",
    )
    p_list.add_argument(
        "--all",
        action="store_true",
        help="列出所有项目下的 session（忽略 --project）",
    )

    p_next = sub.add_parser("next")
    p_next.add_argument("--dir", required=True)

    p_start = sub.add_parser("start")
    p_start.add_argument("--dir", required=True)
    p_start.add_argument("--tid", required=True)
    p_start.add_argument("--agent", required=True)
    p_start.add_argument("--skill", default=None)

    p_done = sub.add_parser("done")
    p_done.add_argument("--dir", required=True)
    p_done.add_argument("--tid", required=True)

    p_fail = sub.add_parser("fail")
    p_fail.add_argument("--dir", required=True)
    p_fail.add_argument("--tid", required=True)
    p_fail.add_argument("--error", required=True)
    p_fail.add_argument(
        "--error-class",
        default=None,
        help="telemetry error_class；省略时按 error 文本启发式推断（task_failed / mcp_tool_failed 等）",
    )

    p_retry = sub.add_parser("retry")
    p_retry.add_argument("--dir", required=True)
    p_retry.add_argument("--tid", required=True, help="要重试的 FAILED task id")

    p_status = sub.add_parser("status")
    p_status.add_argument("--dir", required=True)

    p_validate = sub.add_parser("validate")
    p_validate.add_argument("--dir", required=True)
    p_validate.add_argument(
        "--openspec-change",
        default=None,
        help="覆盖 state 中的 OpenSpec change 名，用于漂移比对",
    )
    p_validate.add_argument(
        "--openspec-repo-root",
        default=None,
        help="覆盖 state 中的仓库根路径（含 openspec/changes）",
    )

    p_complete = sub.add_parser("complete")
    p_complete.add_argument("--dir", required=True)

    p_update = sub.add_parser("update-session")
    p_update.add_argument("--dir", required=True)
    p_update.add_argument("--section", required=True)
    p_update.add_argument("--content", required=True)
    p_update.add_argument("--mode", default="append", choices=["append", "replace"])

    p_rag = sub.add_parser("inject-rag")
    p_rag.add_argument("--dir", required=True)
    p_rag.add_argument("--query", required=True)
    p_rag.add_argument(
        "--cross-project",
        action="store_true",
        help="RAG 不按当前项目过滤（默认带 project_id=PIPELINE_PROJECT 或 _default）",
    )

    p_ccc = sub.add_parser("consistency-check")
    p_ccc.add_argument("--dir", required=True)
    p_ccc.add_argument("--type", required=True, choices=["proposal", "task", "merge"])
    p_ccc.add_argument("--tid", default=None)
    p_ccc.add_argument("--result", required=True, help="JSON string")

    p_tg = sub.add_parser("test-gate")
    p_tg.add_argument("--dir", required=True)
    p_tg.add_argument("--type", required=True, choices=["compile", "unit", "integration", "e2e", "regression"])
    p_tg.add_argument("--result", required=True, help="JSON string")

    p_snap = sub.add_parser("snapshot")
    p_snap.add_argument("--dir", required=True)
    p_snap.add_argument("--tid", required=True)

    p_trend = sub.add_parser("trend")
    p_trend.add_argument(
        "--project",
        default=None,
        help="趋势按项目过滤；默认当前项目（PIPELINE_PROJECT 或 _default）",
    )

    p_rollback = sub.add_parser("rollback")
    p_rollback.add_argument("--dir", required=True, help="session 目录")
    p_rollback.add_argument("--tid", required=True, help="回滚锚点 task id（其后任务重置为 PENDING，如 t2）")

    p_sr = sub.add_parser("skill-route")
    p_sr.add_argument("--dir", required=True)
    p_sr.add_argument("--tid", required=True)
    p_sr.add_argument("--config", default=None, help="配置文件路径（覆盖默认搜索）")

    p_ap = sub.add_parser("advance-phase")
    p_ap.add_argument("--dir", required=True)
    p_ap.add_argument("--to", default=None, type=int, help="跳转到指定 Phase ID（跳过中间 Phase）")

    p_gate = sub.add_parser("gate")
    p_gate.add_argument("--dir", required=True)
    p_gate.add_argument("--gate-id", required=True, help="Gate 标识符（如 after-propose）")
    p_gate.add_argument("--decision", required=True, choices=["pass", "fail", "fix"], help="Gate 决策")
    p_gate.add_argument("--reason", default=None, help="决策原因")
    p_gate.add_argument("--report", default=None, help="结构化质量报告 JSON（如 {\"items\":[{\"id\":\"...\",\"status\":\"pass\",\"detail\":\"...\"}]}）")

    p_vtopo = sub.add_parser("validate-topology")
    p_vtopo.add_argument(
        "--config", default=None,
        help="配置文件路径（默认: templates/pipeline-orchestrator.yaml）",
    )

    p_gen = sub.add_parser("gen-template", help="根据描述自动生成编排模板 YAML")
    p_gen.add_argument("--name", required=True, help="模板名称（kebab-case，如 python-fastapi）")
    p_gen.add_argument("--desc", default=None, help="项目描述，用于推断模板字段")
    p_gen.add_argument("--from", dest="from_template", default=None, help="基于已有模板扩展（模板名）")
    p_gen.add_argument("--force", action="store_true", help="覆盖已存在的同名模板")

    args = parser.parse_args()

    cmds = {
        "init": cmd_init, "list": cmd_list, "next": cmd_next,
        "start": cmd_start, "done": cmd_done, "fail": cmd_fail,
        "retry": cmd_retry, "status": cmd_status, "validate": cmd_validate,
        "complete": cmd_complete, "update-session": cmd_update_session,
        "inject-rag": cmd_inject_rag, "consistency-check": cmd_consistency_check,
        "test-gate": cmd_test_gate, "snapshot": cmd_snapshot, "trend": cmd_trend,
        "rollback": cmd_rollback, "skill-route": cmd_skill_route,
        "advance-phase": cmd_advance_phase, "gate": cmd_gate,
        "validate-topology": cmd_validate_topology,
        "gen-template": cmd_gen_template,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
