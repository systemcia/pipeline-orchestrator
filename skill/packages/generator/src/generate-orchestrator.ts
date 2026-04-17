/**
 * 从 YAML topology 确定性生成 Orchestrator Skill Markdown（无时间戳/随机数）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface GenerateOptions {
  configPath: string;
  outputPath?: string | undefined;
  /** 用于替换模板中的 `{project_name}` */
  projectName: string;
  /** 若设置则替换 `{scale}`，否则保留占位符 */
  scale?: string | undefined;
  /** 若设置则替换 `{profile}`，否则保留占位符 */
  profile?: string | undefined;
}

interface YamlDoc {
  max_parallel?: number;
  parallel_atomicity?: string;
  timeout_minutes?: number;
  gate_mode?: string;
  automation_tier?: number;
  dry_run?: boolean;
  profiles?: Record<string, unknown>;
  topology?: {
    phases?: PhaseYaml[];
    agents?: AgentYaml[];
    gates?: GateYaml[];
  };
}

interface PhaseYaml {
  id: number;
  name: string;
  file: string;
  required?: boolean;
  skip_when?: string;
  steps?: StepYaml[];
  transitions?: TransitionYaml[];
}

interface StepYaml {
  id: string;
  step_id?: string;
  type: string;
  description?: string;
  agent?: string;
  optional?: boolean;
  loop?: boolean;
  parallel_eligible?: boolean;
  gate_type?: string;
  gate_id?: string;
  required?: boolean;
  outputs?: string[];
  skip_when?: string;
}

interface TransitionYaml {
  to: number;
  condition?: string;
}

interface AgentYaml {
  id: string;
  file: string;
  phases?: number[];
  tools_budget?: number;
  on_demand?: boolean;
}

interface GateYaml {
  id: string;
  phase: number;
  step: string;
  description?: string;
  required_modes?: string[];
}

function parseArgs(argv: string[]): GenerateOptions {
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let projectName = "orchestrator";
  let scale: string | undefined;
  let profile: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1]) {
      configPath = argv[++i]!;
    } else if (a === "--output" && argv[i + 1]) {
      outputPath = argv[++i]!;
    } else if (a === "--project" && argv[i + 1]) {
      projectName = argv[++i]!;
    } else if (a === "--scale" && argv[i + 1]) {
      scale = argv[++i]!;
    } else if (a === "--profile" && argv[i + 1]) {
      profile = argv[++i]!;
    }
  }
  const cfg = configPath;
  if (!cfg) {
    console.error(
      "Usage: generate-orchestrator --config <yaml> [--output <md>] [--project <name>] [--scale <s>] [--profile <p>]",
    );
    process.exit(1);
  }
  return {
    configPath: cfg,
    projectName,
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(profile !== undefined ? { profile } : {}),
  };
}

function substituteTemplate(s: string, vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort((x, y) => y.length - x.length || x.localeCompare(y, "en"));
  let out = s;
  for (const k of keys) {
    out = out.split(`{${k}}`).join(vars[k]);
  }
  return out;
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function loadDoc(configPath: string): YamlDoc {
  const raw = fs.readFileSync(configPath, "utf8");
  const doc = yaml.load(raw) as YamlDoc | null | undefined;
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML: ${configPath}`);
  }
  return doc;
}

function sortPhases(phases: PhaseYaml[]): PhaseYaml[] {
  return [...phases].sort((a, b) => Number(a.id) - Number(b.id));
}

function sortAgents(agents: AgentYaml[]): AgentYaml[] {
  return [...agents].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function sortGates(gates: GateYaml[]): GateYaml[] {
  return [...gates].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function profileRows(profiles: Record<string, unknown> | undefined): string {
  if (!profiles || typeof profiles !== "object") return "| (无) |\n";
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b, "en"));
  const lines: string[] = ["| Profile | skip_phases | skip_steps | gates | force_serial |", "|---|---|---|---|---|"];
  for (const n of names) {
    const p = profiles[n] as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") continue;
    const sp = Array.isArray(p["skip_phases"]) ? (p["skip_phases"] as unknown[]).join(", ") : "";
    const ss = Array.isArray(p["skip_steps"]) ? (p["skip_steps"] as unknown[]).join(", ") : "";
    const g = Array.isArray(p["gates"]) ? (p["gates"] as unknown[]).join(", ") : "";
    const fs = p["force_serial"] === true ? "true" : "";
    lines.push(`| ${escCell(n)} | ${escCell(sp)} | ${escCell(ss)} | ${escCell(g)} | ${escCell(fs)} |`);
  }
  return lines.join("\n") + "\n";
}

function formatSteps(steps: StepYaml[] | undefined): string {
  if (!steps?.length) return "_（无步骤）_\n";
  const hdr = "| Step ID | type | agent | 说明 | optional | loop | parallel | gate | gate_id | skip_when |\n|---|---|---|---|---|---|---|---|---|---|";
  const rows = steps.map((st) => {
    const sid = st.step_id ?? st.id ?? "";
    return `| ${escCell(sid)} | ${escCell(st.type)} | ${escCell(st.agent ?? "")} | ${escCell(st.description ?? "")} | ${st.optional === true ? "yes" : ""} | ${st.loop === true ? "yes" : ""} | ${st.parallel_eligible === true ? "yes" : ""} | ${escCell(st.gate_type ?? "")} | ${escCell(st.gate_id ?? "")} | ${escCell(st.skip_when ?? "")} |`;
  });
  return [hdr, ...rows].join("\n") + "\n";
}

function formatTransitions(tr: TransitionYaml[] | undefined): string {
  if (!tr?.length) return "";
  const hdr = "| to Phase | condition |\n|---|---|";
  const rows = tr.map((t) => `| ${t.to} | ${escCell(t.condition ?? "—")} |`);
  return ["**Transitions**", hdr, ...rows].join("\n") + "\n";
}

/** 由 YAML 与模板变量生成完整 Skill Markdown（已做模板替换）。 */
export function generateOrchestratorMarkdown(doc: YamlDoc, opts: GenerateOptions): string {
  const top = doc.topology;
  if (!top?.phases?.length) {
    throw new Error("YAML missing topology.phases");
  }
  const phases = sortPhases(top.phases);
  const agents = sortAgents(top.agents ?? []);
  const gates = sortGates(top.gates ?? []);

  const slug = opts.projectName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "orchestrator";

  /** `{scale}` / `{profile}` 仅当 CLI 传入 `--scale` / `--profile` 时替换，否则保留占位符。 */
  const vars: Record<string, string> = { project_name: opts.projectName };
  if (opts.scale !== undefined) vars["scale"] = opts.scale;
  if (opts.profile !== undefined) vars["profile"] = opts.profile;

  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  push(
    "---",
    `name: ${slug}`,
    "description: >",
    `  声明式编排 Skill（项目 {project_name}）。由 topology 确定性生成；规模 {scale}；Profile {profile}。`,
    "  执行时以 Phase 文件为准，本页为骨架与调度约束摘要。",
    "---",
    "",
    `# {project_name} — Orchestrator Skill（生成稿）`,
    "",
    "## 强制约束（MUST）",
    "",
    "1. **MUST** 所有 spawn SubAgent **禁止指定 `model` 参数**，继承主 Agent 模型",
    "2. **MUST** Phase 2 之后每次 spawn 前**重新读取** `$DIR/session.md`",
    "3. **MUST** 每个 `[Shell]`/`[Task]` 步骤执行后**检查返回值**，非 0 进入错误恢复",
    "4. **NEVER** 凭记忆假设文件存在性、CLI 可用性——**必须用命令检测**",
    "5. **NEVER** 跳过落盘（state.json / session.md / pending.md）",
    "",
    "## 编排参数（来自配置）",
    "",
    "| 键 | 值 |",
    "|---|---|",
    `| max_parallel | ${doc.max_parallel ?? "—"} |`,
    `| parallel_atomicity | ${escCell(String(doc.parallel_atomicity ?? "—"))} |`,
    `| timeout_minutes | ${doc.timeout_minutes ?? "—"} |`,
    `| gate_mode | ${escCell(String(doc.gate_mode ?? "—"))} |`,
    `| automation_tier | ${doc.automation_tier ?? "—"} |`,
    `| dry_run | ${doc.dry_run === true ? "true" : "false"} |`,
    "",
    "## 并行策略",
    "",
    `- **同批 READY task** 并行度上限：**max_parallel**（上表）。`,
    `- **parallel_atomicity**：\`best-effort\` 时各 task 独立成败；\`all-or-nothing\` 时同批任一失败则整批回退语义由引擎实现。`,
    `- Phase 3 中带 **parallel_eligible** 的步骤可与 max_parallel 组合；若 Profile **force_serial: true** 则禁用并行 spawn。`,
    "",
    "## Phase 路由",
    "",
    "| Phase | 文件 | required | skip_when |",
    "|---|---|---|---|",
  );

  for (const ph of phases) {
    push(
      `| ${ph.id} | \`${escCell(ph.file)}\` | ${ph.required !== false ? "true" : "false"} | ${escCell(ph.skip_when ?? "—")} |`,
    );
  }
  push("");

  for (const ph of phases) {
    push(`## Phase ${ph.id}: ${ph.name}`, "", `**Phase 文件**: \`${ph.file}\``, "");
    if (ph.skip_when) push(`**skip_when**: \`${escCell(ph.skip_when)}\``, "");
    push("### Steps", "", formatSteps(ph.steps));
    const tr = formatTransitions(ph.transitions);
    if (tr) push(tr);
    push("");
  }

  push("## Gate 注册表", "", "| Gate ID | Phase | Step | required_modes | 说明 |", "|---|---|---|---|---|");
  for (const g of gates) {
    const rm = g.required_modes?.length ? g.required_modes.join(", ") : "—";
    push(`| ${escCell(g.id)} | ${g.phase} | ${escCell(g.step)} | ${escCell(rm)} | ${escCell(g.description ?? "—")} |`);
  }
  push("");

  push("## SubAgent 注册表", "", "| Agent | 文件 | Phases | tools_budget | on_demand |", "|---|---|---|---|---|");
  for (const ag of agents) {
    const phs = ag.phases?.length ? ag.phases.join(", ") : "—";
    push(
      `| ${escCell(ag.id)} | \`${escCell(ag.file)}\` | ${escCell(phs)} | ${ag.tools_budget ?? "—"} | ${ag.on_demand === true ? "yes" : ""} |`,
    );
  }
  push("");

  push("## Profile 摘要", "", profileRows(doc.profiles));
  push(
    "## 模板变量",
    "",
    "- `{project_name}`：生成时由 CLI `--project` 替换（默认 `orchestrator`）。",
    "- `{scale}`、`{profile}`：默认保留占位符；可用 `--scale` / `--profile` 在生成时写入固定值。",
    "",
    "## Agent 调度要点",
    "",
    "- **task 步骤**：按表格中的 **agent** 列 spawn；缺省 agent 的步骤为 shell/decision/gate，由主 Agent 或引擎直接执行。",
    "- **gate 步骤**：在标注 **gate_id** 处停顿，与 Gate 注册表及 `gate_mode` 对齐。",
    "- **条件跳转**：遵循各 Phase **Transitions**；未列条件表示无条件进入 **to** Phase。",
    "",
  );

  return substituteTemplate(lines.join("\n"), vars);
}

function main(): void {
  const opts = parseArgs(process.argv);
  const doc = loadDoc(opts.configPath);
  const md = generateOrchestratorMarkdown(doc, opts);
  if (opts.outputPath) {
    const dir = path.dirname(opts.outputPath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.outputPath, md, "utf8");
  } else {
    process.stdout.write(md);
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main();
}
