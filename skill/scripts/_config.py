"""配置加载：项目 .pipeline-orchestrator.yaml、orchestrator home、模板路径解析。"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

try:
    import yaml as _yaml
except ImportError:
    _yaml = None

DEFAULT_PROJECT_ID = "_default"

CONFIG_FILENAME = ".pipeline-orchestrator.yaml"
CONFIG_DEFAULTS = {
    "max_parallel": 3,
    "timeout_minutes": 10,
    "gate_mode": "auto",
    "automation_tier": 2,
    "persist_small": False,
    "snapshot_medium": False,
    "dry_run": False,
    "observability": {
        "enabled": True,
        "log_status_on_start": True,
        "screenshot_on_fail": True,
        "screenshot_on_complete": False,
        "read_on_fail": True,
    },
}

_ORCH_MERGE_KEYS = ("agents", "skip_steps", "gates", "skip_phases", "force_serial", "phases")


def default_project() -> str:
    v = (os.environ.get("PIPELINE_PROJECT") or "").strip()
    return v if v else DEFAULT_PROJECT_ID


def state_project_id(state: dict) -> str:
    """state 中的 project_id；旧 session 无字段时视为 default。"""
    pid = state.get("project_id")
    if pid is not None and str(pid).strip():
        return str(pid).strip()
    return DEFAULT_PROJECT_ID


def strict_test_evidence_enabled() -> bool:
    v = (os.environ.get("PIPELINE_STRICT_TEST_EVIDENCE") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def orchestrator_home() -> Path:
    """仓库根目录：PIPELINE_ORCHESTRATOR_HOME 或 engine.py 所在仓库。"""
    env = (os.environ.get("PIPELINE_ORCHESTRATOR_HOME") or "").strip()
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parent.parent


def load_init_pipeline_yaml() -> dict:
    """项目根 .pipeline-orchestrator.yaml，否则 bundled templates/pipeline-orchestrator.yaml。"""
    root = os.environ.get("PIPELINE_PROJECT_ROOT", os.getcwd())
    p = Path(root).resolve()
    for d in [p, *p.parents]:
        cfg_file = d / CONFIG_FILENAME
        if cfg_file.is_file():
            if _yaml is None:
                return {}
            with open(cfg_file) as f:
                return _yaml.safe_load(f) or {}
    bundled = orchestrator_home() / "templates" / "pipeline-orchestrator.yaml"
    if bundled.is_file() and _yaml is not None:
        with open(bundled) as f:
            return _yaml.safe_load(f) or {}
    return {}


def resolve_init_template_path(spec: str) -> Path:
    """模板名 → templates/{name}.yaml；已是存在的文件路径则直接使用。"""
    s = (spec or "").strip()
    if not s:
        print("ERROR: --template 值为空", file=sys.stderr)
        sys.exit(1)
    cand = Path(s)
    if cand.is_file():
        return cand.resolve()
    home = orchestrator_home()
    yaml_name = s if s.endswith((".yaml", ".yml")) else f"{s}.yaml"
    rel = home / "templates" / yaml_name
    if rel.is_file():
        return rel.resolve()
    print(f"ERROR: 模板未找到: {spec}（已尝试路径与 {rel}）", file=sys.stderr)
    sys.exit(1)


def merge_orchestration_layers(
    cfg: dict,
    profile_name: str | None,
    template_path: Path | None,
) -> dict:
    """合并顺序：模板 > profile > 默认值（按字段覆盖）。"""
    out: dict = {"skip_steps": [], "gates": []}
    profiles = cfg.get("profiles") or {}
    pname = (profile_name or "").strip()
    if pname:
        prof = profiles.get(pname)
        if isinstance(prof, dict):
            for k in _ORCH_MERGE_KEYS:
                if k in prof and prof[k] is not None:
                    out[k] = copy.deepcopy(prof[k])
    tpl_raw: dict = {}
    if template_path is not None:
        if _yaml is None:
            print("ERROR: 使用 --template 需要安装 PyYAML", file=sys.stderr)
            sys.exit(1)
        with open(template_path) as f:
            tpl_raw = _yaml.safe_load(f) or {}
        if not isinstance(tpl_raw, dict):
            print("ERROR: 模板 YAML 根必须为 mapping", file=sys.stderr)
            sys.exit(1)
        for k in _ORCH_MERGE_KEYS:
            if k in tpl_raw and tpl_raw[k] is not None:
                out[k] = copy.deepcopy(tpl_raw[k])
        tid = tpl_raw.get("name")
        out["template"] = str(tid if tid is not None else template_path.stem)
    return out


def load_project_config() -> dict:
    """从当前工作目录或 PIPELINE_PROJECT_ROOT 向上搜索配置文件。"""
    root = os.environ.get("PIPELINE_PROJECT_ROOT", os.getcwd())
    p = Path(root).resolve()
    for d in [p, *p.parents]:
        cfg_file = d / CONFIG_FILENAME
        if cfg_file.is_file():
            if _yaml is None:
                print(f"WARN: found {cfg_file} but PyYAML not installed, using defaults", file=sys.stderr)
                return dict(CONFIG_DEFAULTS)
            with open(cfg_file) as f:
                raw = _yaml.safe_load(f) or {}
            merged = dict(CONFIG_DEFAULTS)
            for k in CONFIG_DEFAULTS:
                if k in raw:
                    if k == "observability" and isinstance(raw[k], dict):
                        merged[k] = {**CONFIG_DEFAULTS[k], **raw[k]}
                    else:
                        merged[k] = raw[k]
            return merged
    return dict(CONFIG_DEFAULTS)


def load_pipeline_config(config_path: str | None = None) -> dict:
    """加载 .pipeline-orchestrator.yaml（skill-route 用）。"""
    try:
        import yaml
    except ImportError:
        return {}
    candidates = []
    if config_path:
        candidates.append(Path(config_path))
    candidates.extend([
        Path(".pipeline-orchestrator.yaml"),
        Path("templates/pipeline-orchestrator.yaml"),
    ])
    for p in candidates:
        if p.is_file():
            try:
                with open(p) as f:
                    return yaml.safe_load(f) or {}
            except Exception:
                return {}
    return {}
