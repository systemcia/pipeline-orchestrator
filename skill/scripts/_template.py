"""模板推断与 YAML 生成：gen-template 命令的核心逻辑。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_VALID_STEP_IDS = frozenset([
    "rag-inject", "compile", "unit-test", "regression-test",
    "ccc-2", "quality-gate-a", "quality-gate-a-lite",
    "quality-gate-b", "snapshot", "e2e-test",
])
_VALID_GATE_IDS = frozenset(["after-propose", "after-implement", "after-review"])

_KEYWORD_RULES: list[tuple[list[str], dict]] = [
    (["后端", "backend", "api", "服务端", "server"],
     {"_backend": True}),
    (["前端", "frontend", "react", "vue", "next.js", "nuxt"],
     {"_frontend": True}),
    (["全栈", "fullstack", "前后端"],
     {"_frontend": True, "_parallel": True}),
    (["不需要测试", "跳过测试", "no test", "skip test"],
     {"_skip_test": True}),
    (["严格", "高质量", "thorough", "strict"],
     {"_strict": True}),
    (["轻量", "快速", "minimal", "lightweight", "精简"],
     {"_minimal": True}),
    (["紧急", "hotfix", "urgent", "线上问题"],
     {"_hotfix": True}),
    (["串行", "serial", "顺序执行"],
     {"force_serial": True}),
    (["不需要反哺", "跳过反哺", "skip feedback", "no feedback"],
     {"_skip_feedback": True}),
    (["go", "golang"],
     {"_tags_add": ["go"]}),
    (["python", "fastapi", "django", "flask"],
     {"_tags_add": ["python"]}),
    (["java", "spring", "springboot"],
     {"_tags_add": ["java"]}),
    (["rust", "cargo"],
     {"_tags_add": ["rust"]}),
    (["typescript", "ts", "node", "express", "nestjs"],
     {"_tags_add": ["typescript"]}),
]

_NEGATION_PREFIXES = ["不需要", "不用", "跳过", "没有", "无需", "no ", "skip ", "without "]


def infer_template_fields(desc: str) -> dict:
    """从描述文本推断模板字段。"""
    desc_lower = desc.lower()
    flags: dict = {}
    tags: list[str] = []

    for keywords, patch in _KEYWORD_RULES:
        matched = False
        for kw in keywords:
            pos = desc_lower.find(kw)
            if pos < 0:
                continue
            negated = any(
                desc_lower[max(0, pos - len(neg)):pos] == neg
                for neg in _NEGATION_PREFIXES
            )
            if negated:
                continue
            matched = True
            break
        if not matched:
            continue
        for k, v in patch.items():
            if k == "_tags_add":
                tags.extend(v)
            else:
                flags[k] = v

    has_frontend = flags.get("_frontend", False)
    is_parallel = flags.get("_parallel", False)
    is_strict = flags.get("_strict", False)
    is_minimal = flags.get("_minimal", False)
    is_hotfix = flags.get("_hotfix", False)
    skip_test = flags.get("_skip_test", False)
    skip_feedback = flags.get("_skip_feedback", False)
    force_serial = flags.get("force_serial", False) or is_hotfix

    if has_frontend and is_parallel:
        be_tags = [t for t in tags if t not in ("react", "vue")]
        fe_tags = ["frontend"] + [t for t in tags if t in ("react", "vue", "typescript")]
        agents = {
            "implement": {
                "parallel": [
                    {"agent": "executor", "scope": "## Backend Tasks",
                     "tags": (be_tags or ["backend"])},
                    {"agent": "executor", "scope": "## Frontend Tasks",
                     "tags": fe_tags or ["frontend"]},
                ]
            },
            "review": {"agent": "quality-reviewer"},
        }
    else:
        agents = {
            "implement": [{"agent": "executor"}],
            "review": [{"agent": "quality-reviewer"}],
        }

    skip_steps: list[str] = []
    if not has_frontend:
        skip_steps.append("e2e-test")
    if skip_test:
        skip_steps.extend(["unit-test", "e2e-test"])
    if is_minimal or is_hotfix:
        skip_steps.extend(["ccc-2", "quality-gate-b", "regression-test"])
    if is_hotfix:
        skip_steps.extend(["rag-inject", "quality-gate-a", "snapshot"])
    skip_steps = sorted(set(s for s in skip_steps if s in _VALID_STEP_IDS))

    if is_strict:
        gates = ["after-propose", "after-implement", "after-review"]
    elif is_hotfix or is_minimal:
        gates = []
    else:
        gates = ["after-propose"]

    phases = [0, 1, 2, 3, 4, 5]
    if is_hotfix:
        phases = [0, 2, 3, 4]
    elif skip_feedback:
        phases = [0, 1, 2, 3, 4]

    result: dict = {
        "agents": agents,
        "phases": phases,
        "skip_steps": skip_steps,
        "gates": gates,
    }
    if force_serial:
        result["force_serial"] = True
    return result


def render_yaml_value(val, indent: int = 0) -> str:
    """简易 YAML 渲染（模板结构固定，不需要通用序列化）。"""
    prefix = "  " * indent
    child_prefix = "  " * (indent + 1)
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        if any(c in val for c in ":#{}[]&*!|>'\"%@`"):
            return f'"{val}"'
        return val
    if isinstance(val, list):
        if not val:
            return "[]"
        if all(isinstance(v, (str, int, float, bool)) for v in val):
            inner = ", ".join(render_yaml_value(v) for v in val)
            return f"[{inner}]"
        lines = []
        for item in val:
            if isinstance(item, dict):
                first = True
                for k, v in item.items():
                    rendered = render_yaml_value(v, indent + 2)
                    if first:
                        lines.append(f"{child_prefix}- {k}: {rendered}")
                        first = False
                    else:
                        lines.append(f"{child_prefix}  {k}: {rendered}")
            else:
                lines.append(f"{child_prefix}- {render_yaml_value(item)}")
        return "\n" + "\n".join(lines)
    if isinstance(val, dict):
        lines = []
        for k, v in val.items():
            rendered = render_yaml_value(v, indent + 1)
            if rendered.startswith("\n"):
                lines.append(f"{child_prefix}{k}:{rendered}")
            else:
                lines.append(f"{child_prefix}{k}: {rendered}")
        return "\n" + "\n".join(lines)
    return str(val)


def render_template_yaml(name: str, description: str, fields: dict) -> str:
    """渲染完整模板 YAML 字符串。"""
    lines = [
        f"# 预制编排模板 — {description}",
        f"# 由 $O gen-template 自动生成",
        f"# 用途: $O init --template {name}",
        "",
        f"name: {name}",
        f"description: {description}",
    ]
    for key in ("agents", "phases", "skip_steps", "gates", "force_serial"):
        val = fields.get(key)
        if val is None:
            continue
        rendered = render_yaml_value(val, 0)
        if rendered.startswith("\n"):
            lines.append(f"\n{key}:{rendered}")
        else:
            lines.append(f"\n{key}: {rendered}")
    return "\n".join(lines) + "\n"


def load_base_template(from_name: str, orchestrator_home: Path, yaml_module) -> dict:
    """加载已有模板作为基础。"""
    if yaml_module is None:
        print("ERROR: --from 需要安装 PyYAML", file=sys.stderr)
        sys.exit(1)
    tpl_path = orchestrator_home / "templates" / f"{from_name}.yaml"
    if not tpl_path.is_file():
        tpl_path = orchestrator_home / "templates" / from_name
    if not tpl_path.is_file():
        print(f"ERROR: 基础模板未找到: {from_name}", file=sys.stderr)
        sys.exit(1)
    with open(tpl_path) as f:
        base = yaml_module.safe_load(f) or {}
    return {k: v for k, v in base.items() if k in ("agents", "phases", "skip_steps", "gates", "force_serial")}
