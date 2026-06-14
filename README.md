# ☁️ cloudy

**Give an agent a goal. Watch it build.**

> `v0.2.0` · MIT · Node.js 18+ · Runs local agent CLIs and API-backed engines via `omnai`

Cloudy breaks a project goal into a dependency-ordered task graph, then works through each task using local agent CLIs or API-backed runtimes via `omnai` — with validation, automatic retry, and real-time feedback. Works with any language or stack.

## Scoped execution hardening

Cloudy now distinguishes bounded task shapes instead of treating every implementation task the same.

- `implement_ui_surface`: scoped UI work with exact write targets
- `verify_proof`: artifact and screenshot verification work
- `closeout_keel`: status, notes, and task-closeout work
- `refactor_bounded`: targeted refactors with explicit file scope
- `write_or_stop`: bounded implementation tasks that must produce an edit quickly or fail fast

For these modes, Cloudy now:

- tracks `timeToFirstWriteMs`, discovery ops before first write, subagent calls, write count, verification ops, risk level, and failure class
- shows those metrics in the dashboard task details
- enforces a stronger first-action policy for bounded implementation work
- disables exploratory subagents by default for scoped tasks
- supports `--strict-batch` so multi-task delivery runs stay deterministic and stop on terminal failures

Failure classes are now explicit:

- `executor_nonperformance`
- `task_spec_problem`
- `validation_problem`
- `implementation_failure`
- `acceptance_failure`
- `out_of_scope_drift`
- `already_satisfied`
- `environment_failure`
- `timeout`

## Runtime routing model

Cloudy routes every AI phase with four dimensions:

- `engine`: how the phase is executed
- `provider`: which backend or auth family is used
- `account`: which named identity inside that provider/runtime should be used
- `modelId`: which concrete provider-native model should be used

Use them for different decisions:

- pick `engine` when you care about the execution surface: `claude-code`, `codex`, `pi-mono`
- pick `provider` when you care about the backend family: `claude`, `codex`, `openai`, `dashscope`, `ollama`
- pick `account` when you care about the named quota or credential route: `claude-main`, `claude-backup`, `openai-main`
- pick `modelId` when you care about the exact model: `claude-sonnet-4-6`, `o3`, `gpt-5`

Example:

```bash
cloudy run \
  --build-engine claude-code \
  --build-provider claude \
  --build-account claude-main \
  --build-model-id claude-sonnet-4-6
```

For named local CLI accounts (e.g. the `claude` or `codex` subscription login on your machine), `account` assumes Sweech is installed and managing those identities. Without Sweech, Cloudy still works with `engine + provider + modelId`, but named local account routing is not supported. <!-- provider-lock:allow arch-comparison -->

```
☁️  cloudy  ·  10 tasks
    🤖 exec:sonnet  ·  validate:sonnet  ·  sequential

⚡  task-1  Ralph Loop backend
    📁 49 files in context
    ─── live output ───────────────────────────
  💭 Let me analyze the requirements and map out what needs to change...
    Now I'll implement execute_task_ralph_loop in orchestrator.py:
    Adding the ORIENT → VERIFY → IMPLEMENT → COMMIT → REPORT steps...
    ✓ done  ~$3.12

    🔍 checking acceptance criteria
    ✨ criteria met

✅  task-1  Ralph Loop backend  4m32s

   ████████░░░░░░░░░░░░░░░░░░░░  1 / 10  10%
```

---

## ⚡ Quick Start

```bash
# Install
npm install -g github:vykeai/cloudy

# Plan a goal
cloudy plan "add user authentication with JWT"

# Run it
cloudy run --verbose
```

Or plan + run in one shot:

```bash
cloudy run --goal "add user authentication with JWT"
```

---

## 🔗 Running from inside a nested agent-CLI session

If you invoke `cloudy` from within an active agent-CLI session (e.g. a Claude Code session via a Bash tool call), the nested subprocess will refuse to launch because it inherits parent-process env vars (e.g. `CLAUDECODE` for the Claude Code CLI) and detects a nested session. <!-- provider-lock:allow arch-comparison -->

**Fix — unset both vars before running:**

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT cloudy run --spec your-spec.md --model sonnet
```

Or unset them for the whole shell before running multiple commands:

```bash
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT
cloudy plan --spec your-spec.md --model haiku
cloudy run --model sonnet
```

**Other flags relevant to non-interactive / scripted use:**

| Flag | Notes |
|------|-------|
| `--model <m>` | Pre-selects model, skips interactive radio prompt |
| `--no-dashboard` | Don't open the web UI at `http://localhost:1510` |
| `--ni` / `--non-interactive` | Skip all TTY prompts |

The cloudy daemon already strips engine-specific nested-session env vars (e.g. `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) automatically when spawning subprocesses — this only affects manual `cloudy` CLI invocations from inside a nested agent-CLI session. <!-- provider-lock:allow arch-comparison -->

---

## 📦 Install

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/vykeai/cloudy/main/scripts/install.sh | bash
```

### npm (recommended)

```bash
npm install -g github:vykeai/cloudy
cloudy --version   # verify
```

npm clones from GitHub, builds from source, and links `cloudy` globally.

### Update / Uninstall

```bash
npm install -g github:vykeai/cloudy   # update
npm uninstall -g cloudy               # uninstall
```

### Local development

```bash
git clone https://github.com/vykeai/cloudy.git
cd cloudy
npm install
npm run build
npm link
```

**Requirements:** Node.js 18+ and at least one supported runtime route via `<supervisorSweechProfile>`.
Examples: a local agent-CLI binary on your PATH (e.g. `claude`, `codex`), or API credentials for supported `omnai` providers. <!-- provider-lock:allow arch-comparison -->

---

## 🗺️ Workflow

```bash
# 1. Plan — decompose a goal into tasks
cloudy plan "add user authentication with JWT"

# 2. Preview the task graph
cloudy tasks --graph

# 3. Execute
cloudy run --verbose
```

Point at a spec file:

```bash
cloudy plan --spec ./PRD.md && cloudy run --verbose
```

---

## 🧠 Plan — Decompose Your Goal

```bash
# From a plain-English goal
cloudy plan "build a payment integration"

# From a spec or PRD
cloudy plan --spec ./PRD.md

# Combine multiple specs into one plan
cloudy plan --spec ./phase1.md --spec ./phase2.md

# Skip interactive review
cloudy plan --spec ./PRD.md --no-review

# Control the plan model
cloudy plan --spec ./PRD.md --plan-model sonnet

# Override the plan runtime
cloudy plan --spec ./PRD.md --plan-engine codex --plan-provider codex --plan-account codex-luke --plan-model-id o3-mini
```

The planner uses the configured plan runtime to decompose your goal into concrete, ordered tasks — each with a title, description, acceptance criteria, context file patterns, expected output artifacts, and a time estimate. If you don't pass `--no-review`, you can approve the plan or describe changes in plain English and iterate before running.

---

## 🚀 Run

```bash
cloudy run

# Choose models per phase
cloudy run --build-model sonnet --task-review-model haiku --run-review-model opus

# Override planning / validation / review runtimes
cloudy run \
  --plan-engine codex --plan-provider codex --plan-account codex-luke --plan-model-id o3-mini \
  --task-review-engine codex --task-review-provider codex --task-review-account codex-luke --task-review-model-id o4-mini \
  --run-review-engine codex --run-review-provider codex --run-review-account codex-luke --run-review-model-id gpt-4.1

# Show live agent output as each task runs
cloudy run --verbose

# Re-run a failed task (full retry budget, plan continues after)
cloudy run --retry task-3

# Run one task and its dependencies only
cloudy run --only-task task-5

# Skip tasks before a given point
cloudy run --start-from task-4

# Parallel execution
cloudy run --parallel --max-parallel 4

# Deterministic batch execution
cloudy run --strict-batch

# No web dashboard
cloudy run --no-dashboard
```

| Flag | Description |
|------|-------------|
| `--goal <text>` | Plan + run in one shot |
| `--retry <id>` | Reset a failed task and re-run |
| `--only-task <id>` | Run only this task and its deps |
| `--start-from <id>` | Skip tasks before this point |
| `--resume` | Show completed tasks, confirm before continuing |
| `--max-retries <n>` | Override retry budget for this run |
| `--parallel` | Run independent tasks concurrently |
| `--max-parallel <n>` | Concurrency cap (default: 3) |
| `--strict-batch` | Deterministic execution: no creative recovery, stop on terminal failures, honor task-graph/risk guards |
| `--no-validate` | Skip all validation |
| `--no-dashboard` | Disable the web dashboard |
| `--verbose` | Stream live agent output per task |
| `--model <m>` | Model for all phases (`opus`, `sonnet`, `haiku`) |
| `--plan-model <m>` | Plan model (used for `cloudy plan` or `cloudy run --goal`) |
| `--build-model <m>` | Model for execution phase |
| `--task-review-model <m>` | Model for per-task validation |
| `--run-review-model <m>` | Model for holistic post-run review |
| `--plan-engine <e>` / `--plan-provider <p>` / `--plan-account <a>` / `--plan-model-id <id>` | Plan runtime override |
| `--non-interactive` | Skip all prompts, disable dashboard (also `--ni`) |
| `--model-auto` | Auto-route model by task complexity |
| `--build-engine <e>` / `--build-provider <p>` / `--build-account <a>` / `--build-model-id <id>` | Build runtime override |
| `--task-review-engine <e>` / `--task-review-provider <p>` / `--task-review-account <a>` / `--task-review-model-id <id>` | Per-task AI task-review runtime override |
| `--run-review-engine <e>` / `--run-review-provider <p>` / `--run-review-account <a>` / `--run-review-model-id <id>` | Run-review runtime override |

For batch delivery, prefer:

```bash
cloudy chain \
  --spec ./phase-1.md \
  --spec ./phase-2.md \
  --build-model sonnet \
  --task-review-model haiku \
  --run-review-model opus \
  --strict-batch
```

`--strict-batch` expects deterministic task graphs and exact validation commands. It disables creative repair passes and halts on terminal scoped-task failures.

---

## 🌳 Tasks — View the Plan

```bash
cloudy tasks                 # full task list
cloudy tasks --graph         # ASCII dependency tree
cloudy tasks --mermaid       # Mermaid diagram
cloudy tasks --json          # raw JSON
cloudy tasks edit            # edit pending tasks via the configured plan runtime
```

`cloudy tasks --graph`:

```
task-1  Set up database schema
  ├─ task-2  Auth routes (JWT)
  │    └─ task-4  User CRUD endpoints
  └─ task-3  File upload service
       └─ task-5  Integration tests
```

---

## ✅ Validation

After each task, cloudy runs a validation pipeline:

```
Phase 0  Artifact check    — required output files exist
Phase 1  Custom commands   — project-specific checks (exit 0 = pass)
Phase 2  AI review         — selected review runtime checks git diff vs acceptance criteria
```

Configure validation commands for your project:

```json
// .cloudy/config.json
{
  "validation": {
    "commands": [
      "cd web && bunx tsc --noEmit",
      "cd web && bun test",
      "swift build"
    ]
  }
}
```

If a task fails validation, the retry prompt includes the exact error. Context is expanded on each retry. After exhausting retries, the run halts — with a clear error and the task preserved in `failed` state for `--retry`.

---

## 🙋 Human-in-the-Loop

Pause for approval before tasks run, or escalate failures for guidance:

```bash
cloudy config --set approval.mode=always       # pause before every task
cloudy config --set approval.mode=on-failure   # only escalate on failure
cloudy config --set approval.timeoutSec=120    # auto-continue after 2 min
cloudy config --set approval.autoAction=halt   # auto-halt instead of continue
```

At each pause:

```
⏸  [task-3] JWT auth routes  — approval needed  (120s timeout)
  [a]pprove  [s]kip  [h]alt  [r <hint>] retry with hint:
  ❯ r store the token in httpOnly cookie, not localStorage
```

All decisions are logged to `.cloudy/logs/approvals.jsonl`.

---

## 🖥️ Dashboard

A real-time web UI starts automatically at `http://localhost:1510`. It shows live task status, streaming output, cost tracking, and approval cards.

```bash
cloudy run                # dashboard on by default, browser auto-opens
cloudy run --no-dashboard # disable
```

---

## 🌐 Daemon — Multi-Project Web Dashboard

The daemon runs a persistent background server at `http://localhost:1510` that aggregates all your registered projects into one web dashboard.

```bash
cloudy daemon start     # start the daemon (background, survives terminal close)
cloudy daemon stop      # stop it
cloudy daemon status    # running/stopped + registered projects
cloudy daemon register  # register the current project
cloudy daemon scan      # auto-discover projects under ~/dev and ~/projects
cloudy daemon open      # open http://localhost:1510 in browser
```

The dashboard has six tabs per project:

| Tab | What it does |
|-----|-------------|
| 📊 **Dashboard** | Project overview — cost, last activity, status |
| 💬 **Chat** | Chat with the configured engine · view agent-CLI session history |
| 📋 **Plan** | Pick spec files → `cloudy plan` → Q&A → approve plan |
| ▶️ **Run** | Launch `cloudy run` · live output streaming |
| 📜 **History** | Browse past runs, costs, task outcomes |
| 🧠 **Memory** | View `CLAUDE.md` and `.claude/MEMORY.md` for the project |

### Runtime controls in the dashboard

The dashboard exposes the same phase/runtime split as the CLI, including all four routing dimensions:

- **Plan tab**: `engine`, `provider`, `account`, `modelId`, and `effort` for the planning route
- **Run tab**: `engine`, `provider`, `account`, `modelId`, and `effort` for build, task-review, and run-review routes
- **Retry flow**: failed-task retries reuse the same build / task-review / run-review route settings

Use this when you want the web path to behave like:

```bash
cloudy plan --plan-engine codex --plan-provider codex --plan-account codex-luke --plan-model-id o3-mini

cloudy run \
  --build-engine codex --build-provider codex --build-account codex-luke --build-model-id o3 \
  --task-review-engine claude-code --task-review-provider claude --task-review-account claude-review --task-review-model-id claude-sonnet-4-6 \
  --run-review-engine pi-mono --run-review-provider openai --run-review-account openai-main --run-review-model-id gpt-5
```

### 💬 Chat tab

The Chat tab shows both Cloudy sessions (started from the web) and agent-CLI sessions (from your terminal). CLI sessions are read-only while the CLI is active. Once you close the terminal, inactive agent-CLI sessions unlock — type to resume the exact conversation via the engine's resume command (e.g. `claude --resume` for the Claude Code CLI). <!-- provider-lock:allow arch-comparison -->

**Slash commands** (type `/` to autocomplete):

| Command | Action |
|---------|--------|
| `/help` | Show all commands |
| `/clear` | New chat session |
| `/cost` | Token usage + cost for this session |
| `/model <haiku\|sonnet\|opus>` | Switch model |
| `/status` | Show project status |
| `/memory` | Open Memory tab |
| `/plan <file>` | Add spec to Plan tab |

### 🔗 URL routing

The dashboard uses hash-based routing — refresh always restores your position:

```
http://localhost:1510/#/myproject/chat/cc%3A1498d6da-...
                          ↑project  ↑tab  ↑session id
```

### HTTP API

The dashboard talks to a small local HTTP API. The runtime-routing endpoints are:

- `POST /api/projects/:id/plan`
- `POST /api/projects/:id/run`
- `POST /api/projects/:id/retry`

Planning example:

```json
{
  "specPaths": ["/workspace/myapp/specs/auth.md"],
  "planModel": "sonnet",
  "planEngine": "codex",
  "planProvider": "codex",
  "planModelId": "o3-mini"
}
```

Run example:

```json
{
  "buildModel": "sonnet",
  "taskReviewModel": "haiku",
  "runReviewModel": "sonnet",
  "buildEngine": "codex",
  "buildProvider": "codex",
  "buildModelId": "o3",
  "taskReviewEngine": "claude-code",
  "taskReviewProvider": "claude",
  "taskReviewModelId": "claude-sonnet-4-6",
  "runReviewEngine": "pi-mono",
  "runReviewProvider": "openai",
  "runReviewModelId": "gpt-5"
}
```

The daemon forwards these fields directly into spawned `cloudy plan` / `cloudy run` processes, so the browser path and CLI path stay aligned.

### Fed compatibility

When the daemon starts, it registers itself with `fed` and advertises project/run metadata to the rest of the local estate. When the daemon stops, it cleans up discovery and registration handles so tests, embedders, and local tooling do not leak background peer-discovery state.

---

## 🖱️ Terminal UI (TUI)

When running in a terminal, cloudy shows a two-panel TUI automatically:

```
┌─ Tasks ──────────────┐ ┌─ Output — task-2 ─────────────────────────────┐
│ ✅ task-1  Setup DB   │ │ Implementing JWT auth routes...               │
│ ⚡ task-2  Auth       │ │ Adding /api/auth/login endpoint               │
│ ○  task-3  Upload     │ │ Token stored in httpOnly cookie               │
│ ○  task-4  CRUD       │ │                                               │
│ ○  task-5  Tests      │ │                                               │
└───────────────────────┘ └────────────────────────────────────────────────┘
  ↑/↓ navigate · p pause · s skip · q quit
```

```bash
cloudy run --no-tui       # disable (useful for CI or piping output)
cloudy run --tui          # force on even in non-TTY contexts
```

---

## ⚙️ Engines And Providers

### Claude Code (default binding for the `claude-code` engine) <!-- provider-lock:allow arch-comparison -->

Uses your local Claude Code subscription/login.

```bash
cloudy run --build-engine claude-code --build-provider claude --build-model sonnet
```

### Codex CLI subscription

Uses your local Codex CLI login/subscription, separate from OpenAI API keys.

```bash
cloudy run --build-engine codex --build-provider codex --build-model-id o3
```

### OpenAI API route

Uses an API-backed engine such as `pi-mono`, separate from the Codex CLI path.

```bash
cloudy run --build-engine pi-mono --build-provider openai --build-model-id gpt-4.1-mini
```

Persist execution defaults in config:

```bash
cloudy config --set buildEngine=codex
cloudy config --set buildProvider=codex
cloudy config --set buildModelId=o3
```

Persist phase-specific runtimes:

```bash
cloudy config --set planRuntime.engine=codex
cloudy config --set planRuntime.provider=codex
cloudy config --set planRuntime.modelId=o3-mini
cloudy config --set taskReviewRuntime.engine=codex
cloudy config --set runReviewRuntime.engine=codex
```

---

## 🤖 Models

```bash
# Same model for everything
cloudy run --model opus

# Mix per phase — cheap task review, quality execution, deep holistic review
cloudy run --build-model sonnet --task-review-model haiku --run-review-model opus

# Auto-route by task complexity
cloudy run --model-auto

# Persist defaults
cloudy config --set models.build=sonnet
cloudy config --set models.taskReview=haiku
cloudy config --set models.runReview=opus
```

| Phase | Flag | Default | Notes |
|-------|------|---------|-------|
| 🧠 Plan | `--plan-model` | sonnet | Goal → task graph |
| 🔨 Build | `--build-model` | sonnet | Builds the code |
| 🔍 Task review | `--task-review-model` | haiku | Per-task diff review, runs every task |
| 🔭 Run review | `--run-review-model` | opus | Holistic post-run review, runs once at the end |

These abstract model flags (`opus`/`sonnet`/`haiku`) map cleanly to Anthropic-family runtimes. For other providers, use the phase runtime `*ModelId` flags/config keys instead to name the exact provider-native model. <!-- provider-lock:allow arch-comparison -->

With `--model-auto`, task complexity (acceptance criteria count, description length, dep count, context size) determines the build model automatically.

---

## 🌱 Dynamic Subtasks

If the runtime discovers unexpected work mid-task, it can extend the plan:

```
## SUBTASKS
- [task-2-a] Add OAuth provider config (depends: task-2)
- [task-2-b] Implement token refresh (depends: task-2-a)
```

Cloudy parses this, adds the subtasks to the live queue, and runs them in order.

---

## 🎁 Wrap-up

Add a `wrapUpPrompt` to your plan to run a final prompt after all tasks complete:

```json
// .cloudy/state.json  (or set via tasks edit)
{
  "wrapUpPrompt": "Run make smoke. If it passes, write a one-paragraph summary of what was built to SUMMARY.md."
}
```

---

## 🛠️ Other Commands

```bash
# ✅ Re-run acceptance checks on completed tasks
cloudy check
cloudy check task-3
cloudy check --no-ai-review
cloudy check --task-review-engine codex --task-review-provider codex --task-review-model-id o3

# ↩️ Roll back a task to its pre-execution git checkpoint
cloudy rollback task-3

# 📊 Show progress, cost, logs
cloudy status
cloudy status --watch
cloudy status --cost

# 📜 Run history
cloudy history
cloudy history --show run-2026-03-09-0727

# 🔁 Convergence loop: run until a condition passes
cloudy watch "make all tests pass" --until "npm test" --max-iterations 5

# 👁️ Preview what cloudy would do without executing
cloudy preview

# ⚙️ View/update config
cloudy config
cloudy config --set parallel=true

# 🗑️ Clear all state
cloudy reset --force
```

---

## 📝 Writing Good Specs

Cloudy is only as good as the specs you give it. The most common cause of incomplete implementations isn't a model failure — it's an incomplete spec. The runtime will implement exactly what you describe, no more. **The spec is the complete contract. The agent fills in the gaps with guesses.**

### 📁 Complete the Files list

Every file in the full data pipeline must be listed. The most common mistake is describing a feature at the UI or API layer without tracing where the data actually comes from.

❌ **Incomplete** — agent builds the UI correctly but field is always empty:
```markdown
**Files:**
- `web/src/components/SpecIngestionDialog.tsx`  (add checkbox)
- `api/routes.py`  (no changes needed)
```

✅ **Complete** — agent traces the full pipeline:
```markdown
**Files:**
- `api/planner/spec_parser.py`  (extract `requires` from **Dependencies:** lines)
- `api/routes.py`  (pass `requires` through to create_task; dep-zero status logic)
- `web/src/components/SpecIngestionDialog.tsx`  (checkbox + filter on requires)
```

**Rule:** trace the data from its source (parser, DB, external API) to where it's consumed. Every layer must be listed. Watch out for `(no changes needed)` — it's often wrong.

### 🎯 Write behaviour-based acceptance criteria

Every criterion should be falsifiable by running a command or making an API call.

❌ **Surface checks** — pass even when broken:
```markdown
- Checkbox is present in the dialog
- `requires` field added to Task model
```

✅ **Behaviour checks** — actually verify the feature works:
```markdown
- `POST /api/v1/spaces/{id}/ingest-spec` with a spec containing
  `**Dependencies:** TASK-2601` creates a task with `requires: ["TASK-2601"]`
  in the API response
- With autoQueue=true: dep-zero tasks created as `ready`, tasks with requires
  set as `backlog` — verified by `GET /api/v1/tasks` after import
```

### 📋 Quick checklist

Before running `cloudy plan`:

- [ ] Every integration type / enum value named in Steps has its own AC line
- [ ] Every model field is verified in an API `GET` response criterion
- [ ] Every threshold has a "fires" AND a "does NOT fire" criterion
- [ ] No criterion uses "renders", "exists", or "is created" without a data check
- [ ] A cross-task integration check covers the full data flow end-to-end
- [ ] Validation commands match the commands that will actually run
- [ ] No two tasks make contradictory assumptions about the same state
- [ ] Negative cases present: 404s, 422s, disabled items excluded, below-threshold no-ops

---

## 🔗 Keel Integration

Cloudy can write run outcomes back to a [keel](https://github.com/czaku/keel) project automatically — updating task status, appending a structured note, and drafting a decision record on failure.

### Flags

```bash
cloudy run spec.md --keel-slug myproject --keel-task T-007
```

| Flag | Description |
|------|-------------|
| `--keel-slug <slug>` | Keel project slug to write outcomes to |
| `--keel-task <id>` | Keel task ID to update on completion (e.g. `T-007`) |

### Config (persistent)

```json
// .cloudy/config.json
{
  "keel": {
    "slug": "myproject",
    "taskId": "T-007",
    "port": 7842
  }
}
```

```bash
cloudy config --set keel.slug=myproject
cloudy config --set keel.taskId=T-007
cloudy config --set keel.port=7842
```

### Task-level runtime defaults from Keel

You can also put Cloudy runtime preferences directly on a Keel task. When `--keel-task` is set, Cloudy reads `keel/tasks/<task>.json` from the project and uses its `cloudy` block as the default runtime for that task.

```json
{
  "id": "T-029",
  "title": "Notifications inbox + route correction",
  "cloudy": {
    "models": {
      "plan": "sonnet",
      "build": "sonnet",
      "taskReview": "haiku",
      "runReview": "sonnet",
      "qualityReview": "haiku"
    },
    "plan": { "engine": "codex", "provider": "codex", "account": "codex-luke", "modelId": "o3-mini" },
    "build": { "engine": "codex", "provider": "codex", "account": "codex-luke", "modelId": "o3" },
    "taskReview": { "engine": "codex", "provider": "codex", "account": "codex-luke", "modelId": "o4-mini" },
    "runReview": { "engine": "pi-mono", "provider": "openai", "account": "openai-main", "modelId": "gpt-5" }
  }
}
```

Precedence is:

1. CLI / daemon request flags
2. Keel task `cloudy` block
3. `.cloudy/config.json`

### What gets written

**On success** — sets keel task status to `done`, appends a note:
```
Cloudy run run-2026-03-15-1230-myproject completed successfully. 5 task(s) completed. 0 task(s) failed.
```

**On failure** — sets keel task status to `blocked`, appends a note with the top error, and drafts a `proposed` Decision record with the failure context for future reference. A run with failed tasks, an abort, or a blocked holistic review is written back as failure.

### Requirements

- Keel dashboard API running at `http://127.0.0.1:7842` by default
- Or set `keel.port` / `--keel-slug` / `--keel-task` to target a different local dashboard port

---

## ⚙️ Configuration

Full config reference (`.cloudy/config.json`):

```json
{
  "models": {
    "plan": "sonnet",
    "build": "sonnet",
    "taskReview": "haiku",
    "runReview": "opus"
  },
  "buildEngine": "claude-code",
  "buildProvider": "claude",
  "buildAccount": "claude-main",
  "buildModelId": "",
  "buildEffort": "high",
  "planRuntime": {
    "engine": "codex",
    "provider": "codex",
    "account": "codex-luke",
    "modelId": "o3-mini"
  },
  "taskReviewRuntime": {
    "engine": "claude-code",
    "provider": "claude",
    "account": "claude-review",
    "modelId": "claude-sonnet-4-6"
  },
  "runReviewRuntime": {
    "engine": "pi-mono",
    "provider": "openai",
    "account": "openai-main",
    "modelId": "gpt-5"
  },
  "piMono": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": ""
  },
  "parallel": false,
  "maxParallel": 3,
  "maxRetries": 2,
  "retryDelaySec": 30,
  "taskTimeoutMs": 3600000,
  "validation": {
    "aiReview": true,
    "commands": []
  },
  "review": {
    "enabled": true,
    "model": "opus"
  },
  "keel": {
    "slug": "myproject",
    "taskId": "T-001",
    "port": 7842
  },
  "dashboard": true,
  "dashboardPort": 1510,
  "approval": {
    "mode": "never",
    "timeoutSec": 300,
    "autoAction": "continue"
  }
}
```

---

## 📁 Project State

Everything lives in `.cloudy/` (gitignored by default):

```
.cloudy/
├── state.json        — tasks, status, cost data
├── config.json       — your overrides
├── logs/
│   ├── cloudy.log    — execution log
│   ├── tasks/        — per-task output
│   └── approvals.jsonl
├── checkpoints/      — git SHAs for rollback
└── handoffs/         — result summaries for downstream task context
```

---

## 📄 License

MIT
