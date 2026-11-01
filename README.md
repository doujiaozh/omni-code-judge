# Omni-Code-Judge

> **Omni-Code-Judge: in the age of AI, code must not only run — it must survive the scrutiny of a senior architect.**

An AI-powered code architecture & security evaluator. Pure TypeScript + Node.js, zero native C++ modules (Windows 7 / 8 GB friendly). It scores any file, directory or Git diff across **five dimensions** — complexity, security, maintainability, test coverage, design patterns — then produces a hardcore architecture review report with a pure-CSS radar chart.

## How it works

```
source / diff ──▶ judge_core (AST static analysis, @babel/parser)
                     │  complexity · security · maintainability · coverage · patterns
                     ▼
                 judge_ai (LLM senior architect via aether-llm, offline fallback)
                     ▼
                 judge_report (markdown battle report + pure-CSS radar)
                     ▼
                 judge_cli (colored terminal verdict, CI-ready exit codes)
```

- **judge_core** — deterministic AST analysis. No LLM, no network: cyclomatic complexity, loop nesting, injection red lines (`eval`, `innerHTML`, hardcoded credentials, concatenated shell commands), function length / naming / comment ratio / `any` abuse, sibling-test discovery + assertion density + function purity, and GoF pattern / anti-pattern detection (god class, global mutable state, import explosion...).
- **judge_ai** — feeds the code plus static signals to a cloud LLM through the `aether-llm` gateway (OpenAI-compatible, rate limited, retrying). The prompt is a chief architect that must return strictly-typed JSON. No API key? An offline heuristic architect takes over automatically — nothing breaks.
- **judge_report** — a markdown "battle report": five-dimension scorecard, red/yellow card warnings, metric dashboard, detected patterns, AI business-risk list, and a **pure-CSS radar chart** (no SVG, no JS, no images).
- **judge_cli** — `node bin/judge.js <target>` prints a colored verdict; `--output` writes the report; `--json` is machine-readable; **exit code 1 when any red card fires** so it can gate CI.

## Quick start

```bash
npm install
npm run build

# Judge one file
node bin/judge.js examples/bad-code.ts --no-ai

# Judge a whole directory (static only)
node bin/judge.js src --no-ai

# With the AI architect (needs AETHER_INKSTONE_API_KEY or OPENAI_API_KEY;
# falls back to the offline heuristic architect without one)
node bin/judge.js examples/bad-code.ts --ai

# Write the markdown battle report
node bin/judge.js examples/good-code.ts --no-ai --output reports/good.md

# Machine-readable result
node bin/judge.js src --no-ai --json

# Run the test suite (13 tests, zero extra dependencies)
npm test
```

## CLI reference

```
node bin/judge.js <target> [options]

target            a file, a directory, a git diff, "-" for stdin, or inline code

  --ai            enable the LLM architect (default when a key is present)
  --no-ai         static analysis only
  --diff          treat the target as a unified diff
  --model <name>  override the routed model
  --context <txt> business context fed to the AI architect
  --output <path> write the markdown report to a file
  --json          emit machine-readable JSON
  --no-color      disable ANSI colors
  --cwd <path>    working directory for sibling-test discovery
```

## The five dimensions

| Dimension    | Weight | What it measures |
| --- | --- | --- |
| Complexity 复杂度 | 25% | cyclomatic complexity, loop/branch nesting depth, function length, parameter count |
| Security 安全性 | 30% | eval family, `innerHTML`/`document.write`, hardcoded credentials, shell concatenation, weak hashes, SQL stitching |
| Maintainability 可维护性 | 20% | function length, naming conventions, comment ratio, `any` abuse, TODO rot, dead exports |
| Test coverage 测试覆盖 | 15% | sibling test files, assertion density, function purity, export ratio (no instrumentation) |
| Design patterns 设计模式 | 10% | singleton / DI / observer / factory / strategy detection; god class, global mutable state, import explosion |

Total = weighted sum, blended 70/30 with the AI score when the live LLM is available. Grades: **S ≥ 95 · A ≥ 85 · B ≥ 70 · C ≥ 60 · D ≥ 40 · F < 40**.

## Scoring rules

- **Red card 🔴 (critical)** — `eval`, `new Function`, `innerHTML` assignment, hardcoded credentials, concatenated shell commands. Any red card caps security at 45 and the CLI exits 1.
- **Yellow card 🟠 (major)** — weak hashes, `document.write`, SQL stitching, god classes, missing tests, decision-point explosions.
- **Minor 🟡 / info 🔵** — TODO markers, snake_case in JS, `any` spread, long files.

## Project layout

```
omni-code-judge/
├── bin/judge.js            # CLI entry (auto-builds dist if missing)
├── src/
│   ├── core/               # judge_core: parser, complexity, security,
│   │                       #   maintainability, coverage, design, orchestration
│   ├── ai/                 # judge_ai: aether gateway, architect prompt, judge
│   ├── report/             # judge_report: markdown + pure-CSS radar
│   ├── cli/                # judge_cli: args, colors, output
│   ├── judge.ts            # top-level orchestration (static × AI blending)
│   └── types.ts            # shared contracts
├── tests/smoke.test.ts     # 13 tests on node:test
├── examples/               # bad-code.ts (F, 6 red cards) & good-code.ts (B+)
└── reports/                # generated reports land here
```

## AI gateway

The LLM layer reuses **aether-llm** — a zero-dependency OpenAI-compatible client with sliding-window rate limiting, 429/5xx exponential backoff and fast/strong model routing.

```bash
# InkStone fleet (default): fast=atriadawn, strong=deepseek-v4.1
export AETHER_INKSTONE_API_KEY=sk-...

# or a plain OpenAI key
export OPENAI_API_KEY=sk-...

# or point at any OpenAI-compatible endpoint
export AETHER_LLM_BASE_URL=https://your-host/v1
```

No key → the **offline heuristic architect** derives the AI scores from static signals, so reports stay complete on air-gapped machines.

## Constraints honored

- Pure TypeScript + Node.js — no native C++ addons, runs on Windows 7 / 8 GB hosts.
- Only one runtime dependency (`@babel/parser`) plus the optional `aether-llm` gateway.
- Tests use the built-in `node:test` runner.

## License

MIT — see [LICENSE](LICENSE). 中文说明见 [README.zh-CN.md](README.zh-CN.md).
