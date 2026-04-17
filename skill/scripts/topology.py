"""topology 声明式拓扑校验模块。

读取 pipeline-orchestrator.yaml 中的 topology 块，
对 Phase/Step/Agent/Gate/Transition 做结构完整性校验。

用法：
    python3 topology.py [--config path/to/.pipeline-orchestrator.yaml]
    # 或通过 engine.py validate-topology --config ...
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "templates" / "pipeline-orchestrator.yaml"


def _load_yaml(path: Path) -> dict:
    if yaml is None:
        print(
            "ERROR: PyYAML 未安装。"
            "请执行 pip install pyyaml 或 pip3 install pyyaml",
            file=sys.stderr,
        )
        sys.exit(1)
    if not path.is_file():
        print(f"ERROR: 配置文件不存在: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f) or {}


def validate_topology(config_path: str | Path | None = None) -> list[str]:
    """校验 topology 声明，返回错误列表（空=通过）。"""
    path = Path(config_path).resolve() if config_path else TEMPLATE_PATH
    cfg = _load_yaml(path)
    # 项目根 = 配置文件所在目录（若是模板则向上一级到仓库根）
    if path == TEMPLATE_PATH:
        project_root = TEMPLATE_PATH.parent.parent
    else:
        project_root = path.parent
    topo = cfg.get("topology")
    if not topo:
        return ["topology 块不存在或为空"]

    errors: list[str] = []
    phases = topo.get("phases")
    if not isinstance(phases, list) or not phases:
        return ["topology.phases 必须是非空列表"]

    phase_ids: set[int] = set()
    all_step_ids: set[str] = set()
    agent_ids_in_phases: set[str] = set()
    gate_steps_in_phases: dict[str, int] = {}

    # 先收集所有 phase id，再做 transition 校验
    for p in phases:
        pid = p.get("id")
        if pid is not None:
            phase_ids.add(pid)

    for p in phases:
        pid = p.get("id")
        if pid is None:
            errors.append("phase 缺少 id 字段")
            continue

        if not p.get("name"):
            errors.append(f"phase {pid}: 缺少 name")
        pfile = p.get("file")
        if pfile:
            fp = Path(pfile) if Path(pfile).is_absolute() else project_root / pfile
            if not fp.is_file():
                errors.append(f"phase {pid}: file 不存在 → {fp}")

        steps = p.get("steps", [])
        step_ids_in_phase: set[str] = set()
        for s in steps:
            sid = s.get("id")
            if not sid:
                errors.append(f"phase {pid}: step 缺少 id")
                continue
            if sid in step_ids_in_phase:
                errors.append(f"phase {pid}: step '{sid}' 重复")
            step_ids_in_phase.add(sid)
            all_step_ids.add(sid)

            stype = s.get("type")
            if stype not in ("shell", "task", "decision", "gate"):
                errors.append(
                    f"phase {pid}.step '{sid}': type '{stype}' "
                    "不在合法值 [shell, task, decision, gate] 中"
                )

            if stype == "task" and s.get("agent"):
                agent_ids_in_phases.add(s["agent"])

            if stype == "gate":
                gid = s.get("gate_id")
                if gid:
                    gate_steps_in_phases[gid] = pid

        for tr in p.get("transitions", []):
            to_id = tr.get("to")
            if to_id is not None and to_id not in phase_ids:
                errors.append(
                    f"phase {pid}: transition.to={to_id} 不在已声明的 phase id 集合中"
                )

    agents_section = topo.get("agents", [])
    declared_agent_ids: set[str] = set()
    for a in agents_section:
        aid = a.get("id")
        if not aid:
            errors.append("agents 条目缺少 id")
            continue
        declared_agent_ids.add(aid)
        afile = a.get("file")
        if afile:
            fp = Path(afile) if Path(afile).is_absolute() else project_root / afile
            if not fp.is_file():
                errors.append(f"agent '{aid}': file 不存在 → {fp}")
        for ap in a.get("phases", []):
            if ap not in phase_ids:
                errors.append(f"agent '{aid}': phases 含未知 phase id {ap}")

    orphan_agents = agent_ids_in_phases - declared_agent_ids
    if orphan_agents:
        errors.append(
            f"steps 中引用了未在 agents 注册的 agent: {sorted(orphan_agents)}"
        )

    on_demand_agents = {a["id"] for a in agents_section if a.get("on_demand")}
    unused_agents = declared_agent_ids - agent_ids_in_phases - on_demand_agents
    if unused_agents:
        errors.append(
            f"agents 中声明了但 steps 未引用且非 on_demand 的 agent: {sorted(unused_agents)}"
        )

    gates_section = topo.get("gates", [])
    profiles = cfg.get("profiles", {})
    all_profile_gates: set[str] = set()
    for prof in profiles.values():
        if isinstance(prof, dict):
            for g in prof.get("gates", []):
                all_profile_gates.add(g)

    declared_gate_ids: set[str] = set()
    for g in gates_section:
        gid = g.get("id")
        if not gid:
            errors.append("gates 条目缺少 id")
            continue
        declared_gate_ids.add(gid)
        gphase = g.get("phase")
        if gphase is not None and gphase not in phase_ids:
            errors.append(f"gate '{gid}': phase {gphase} 不在已声明的 phase id 中")

    orphan_gates = all_profile_gates - declared_gate_ids
    if orphan_gates:
        errors.append(
            f"profiles.gates 引用了未在 topology.gates 注册的 gate: {sorted(orphan_gates)}"
        )

    # Phase 文档 ↔ YAML 交叉校验
    import re as _re
    for p in phases:
        pid = p.get("id")
        pfile = p.get("file")
        if not pfile or pid is None:
            continue
        fp = Path(pfile) if Path(pfile).is_absolute() else project_root / pfile
        if not fp.is_file():
            continue
        try:
            md_text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        yaml_step_ids = {s.get("step_id") or s.get("id") for s in p.get("steps", []) if s.get("id")}
        yaml_agents = {s["agent"] for s in p.get("steps", []) if s.get("agent")}

        # 检查文档中引用的 agent 名
        doc_agents = set(_re.findall(r"agent[s]?/(\w[\w-]+)\.md", md_text))
        undeclared = doc_agents - declared_agent_ids
        if undeclared:
            errors.append(
                f"phase {pid} 文档 ({pfile}) 引用了未注册的 agent: {sorted(undeclared)}"
            )

        # 检查文档中引用的 $O 子命令
        doc_cmds = set(_re.findall(r"\$O\s+([\w-]+)", md_text))
        known_cmds = {
            "init", "list", "next", "start", "done", "fail", "status",
            "validate", "complete", "update-session", "inject-rag",
            "consistency-check", "test-gate", "snapshot", "trend",
            "rollback", "skill-route", "advance-phase", "gate",
            "validate-topology",
        }
        unknown_cmds = doc_cmds - known_cmds
        if unknown_cmds:
            errors.append(
                f"phase {pid} 文档 ({pfile}) 引用了未知 $O 命令: {sorted(unknown_cmds)}"
            )

    return errors


def cmd_validate_topology(args) -> None:
    """CLI 入口。"""
    errs = validate_topology(args.config)
    if errs:
        print("TOPOLOGY ERRORS:")
        for e in errs:
            print(f"  ✗ {e}")
        sys.exit(1)
    else:
        print("✓ Topology validation passed")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Validate topology declaration")
    parser.add_argument(
        "config",
        nargs="?",
        default=None,
        help="配置文件路径（默认: templates/pipeline-orchestrator.yaml）",
    )
    args = parser.parse_args()
    cmd_validate_topology(args)


if __name__ == "__main__":
    main()
