# Claude Code - Multi-Session Orchestrator Pipeline

> **IMPORTANT**: This project uses a **Multi-Session Orchestrator Architecture** with Task + Resume pattern. The orchestrator coordinates specialized worker agents, handles decision escalation, and uses Codex as an independent final gate.

## Path Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory | `~/.claude/plugins/claude-codex/` |
| `${CLAUDE_PROJECT_DIR}` | Your project directory | `/path/to/your/project/` |

**Important:** The `.task/` directory is created in your **project directory**, not the plugin directory.

## Architecture Overview

```
Multi-Session Orchestrator Pipeline (Task-Based Enforcement)
  |
  +-- Orchestrator (Main Session)
  |     +-- Step 1.5: Create Pipeline Team (TeamCreate)
  |     |     +-- Idempotent: TeamDelete + TeamCreate("pipeline-{BASENAME}-{HASH}")
  |     |     +-- Verify: TaskList() probe
  |     |     +-- Fails fast if task tools unavailable
  |     +-- Creates pipeline task chain with blockedBy dependencies
  |     +-- Executes data-driven main loop (TaskList → Execute → Complete)
  |     +-- Handles decision escalation from workers
  |     +-- Creates dynamic fix tasks on review failures
  |
  +-- Phase 1: Requirements (INTERACTIVE)
  |     +-- Task: "Gather requirements"
  |     +-- requirements-gatherer agent (opus)
  |     +-- Resume for user Q&A iterations
  |     -> .task/user-story.json
  |
  +-- Phase 2: Planning (SEMI-INTERACTIVE)
  |     +-- Task: "Create implementation plan"
  |     +-- planner agent (opus)
  |     +-- Resume if reviews request changes
  |     -> .task/plan-refined.json
  |
  +-- Phase 3: Plan Reviews (TASK-ENFORCED SEQUENTIAL)
  |     +-- TaskCreate + TaskUpdate(addBlockedBy) chains reviews
  |     +-- Sonnet → Opus → Codex (each blocked by predecessor)
  |     -> .task/review-*.json
  |
  +-- Phase 4: Implementation
  |     +-- TaskUpdate(addBlockedBy) blocks until Codex plan review completes
  |     +-- implementer agent (sonnet)
  |     +-- Resume for iterative fixes
  |     -> .task/impl-result.json
  |
  +-- Phase 5: Code Reviews (TASK-ENFORCED SEQUENTIAL)
  |     +-- TaskCreate + TaskUpdate(addBlockedBy) chains reviews
  |     +-- Sonnet → Opus → Codex (each blocked by predecessor)
  |     -> .task/review-*.json
  |
  +-- Phase 6: Completion
  |     +-- Report results
  |     +-- TeamDelete (read team_name from .task/pipeline-tasks.json)
  ```

---

## Team-Based Requirements Gathering (v1.4.3)

Requirements gathering uses Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) to explore from multiple perspectives in parallel, producing richer user stories from the start.

### How It Works

```
User provides initial description via /multi-ai
         |
         v
    Lead (orchestrator/main session)
    ├── Spawns 5 core specialists + additional as needed
    ├── Specialists join the pipeline team as teammates
    │    ├── Technical Analyst     (always) → explores codebase
    │    ├── UX/Domain Analyst     (always) → user workflows, best practices
    │    ├── Security Analyst      (always) → security analysis
    │    ├── Performance Analyst   (always) → load, scalability, resources
    │    ├── Architecture Analyst  (always) → design patterns, SOLID, maintainability
    │    └── [Additional specialists as needed]
    ├── Receives specialist messages (auto-delivered)
    ├── Uses findings to AskUserQuestion (informed questions)
    ├── Waits for specialists to complete analysis files
    ├── Spawns requirements-gatherer in synthesis mode (one-shot Task)
    │    └── Reads analysis files → writes user-story.json
    └── Shuts down specialist teammates (pipeline team persists), continues pipeline
```

### Specialist Analysis Files

| Specialist | Output File |
|-----------|------------|
| Technical Analyst | `.task/analysis-technical.json` |
| UX/Domain Analyst | `.task/analysis-ux-domain.json` |
| Security Analyst | `.task/analysis-security.json` |
| Performance Analyst | `.task/analysis-performance.json` |
| Architecture Analyst | `.task/analysis-architecture.json` |

### Sub-Phases

| Phase | Description |
|-------|------------|
| `requirements_team_pending` | Pipeline initialized, specialists not yet spawned. Spawn specialist teammates into pipeline team. |
| `requirements_team_exploring` | Team active: specialists exploring, lead asking questions. Do NOT synthesize until ALL specialists complete. |
| `requirements_gathering` | Fallback: no team, direct requirements-gatherer (when teams unavailable) |

### Windows Compatibility

In-process mode works on any terminal (Windows Terminal, VS Code, etc.). Use Shift+Up/Down to cycle between teammates. Split-pane mode requires tmux/iTerm2 (macOS/Linux only) but is not required.

---

## Task-Based Pipeline Enforcement

### Why Task-Based?

The pipeline uses Claude Code's TaskCreate/TaskUpdate/TaskList tools to create **structural enforcement** via explicit task dependencies, rather than relying on instruction-following.

| Instruction-Based (Old) | Task-Based (New) |
|-------------------------|------------------|
| "Run Sonnet → Opus → Codex" | `blockedBy` prevents Codex until Opus completes |
| LLM can skip "redundant" steps | LLM queries TaskList() for next available task |
| No audit trail | Complete task history with metadata |
| Hidden progress | User sees real-time task progress |

**Key Insight:** `blockedBy` is **data**, not an instruction. When the orchestrator calls `TaskList()`, blocked tasks cannot be claimed. The prompt becomes "find next unblocked task" - a data query, not instruction following.

**Task API:** TaskCreate returns a task object with an `id` field. Dependencies are set via `TaskUpdate(id, addBlockedBy: [...])` — TaskCreate itself does NOT accept a blockedBy parameter.

**Team Context Required:** TaskCreate/TaskUpdate/TaskList require a team context (via `TeamCreate`) to become available. The pipeline creates a persistent `pipeline-{BASENAME}-{HASH}` team at startup (Step 1.5) that provides these tools for the entire pipeline lifecycle. The team name is unique per project via path hash. Same-project concurrent runs are unsupported.

### Pipeline Task Chain

After creating the pipeline team (Step 1.5) and verifying task tools (Step 1.6), these tasks are created with dependencies. Every `TaskCreate` includes a rich `description` with AGENT, MODEL, INPUT, OUTPUT, and key instructions. The main loop calls `TaskGet()` to read the full description before spawning each agent — execution context is always data-driven, never derived from hardcoded prose.

```
T1 = TaskCreate(subject: "Gather requirements", description: "AGENT: ... INPUT: ... OUTPUT: ...")
T2 = TaskCreate(subject: "Create implementation plan", description: "...")  → TaskUpdate(T2.id, addBlockedBy: [T1.id])
T3 = TaskCreate(subject: "Plan Review - Sonnet", description: "...")        → TaskUpdate(T3.id, addBlockedBy: [T2.id])
T4 = TaskCreate(subject: "Plan Review - Opus", description: "...")          → TaskUpdate(T4.id, addBlockedBy: [T3.id])
T5 = TaskCreate(subject: "Plan Review - Codex", description: "...")         → TaskUpdate(T5.id, addBlockedBy: [T4.id])   <- GATE
T6 = TaskCreate(subject: "Implementation", description: "...")              → TaskUpdate(T6.id, addBlockedBy: [T5.id])
T7 = TaskCreate(subject: "Code Review - Sonnet", description: "...")        → TaskUpdate(T7.id, addBlockedBy: [T6.id])
T8 = TaskCreate(subject: "Code Review - Opus", description: "...")          → TaskUpdate(T8.id, addBlockedBy: [T7.id])
T9 = TaskCreate(subject: "Code Review - Codex", description: "...")         → TaskUpdate(T9.id, addBlockedBy: [T8.id])   <- GATE
```

Returned IDs are stored in `.task/pipeline-tasks.json`.

**Progressive enrichment:** Before marking each task completed, the orchestrator reads its output file, extracts key context (≤ 500 chars), and appends a `CONTEXT FROM PRIOR TASK` block to the next task's description via `TaskUpdate`. This gives each agent relevant context from the previous phase without re-reading full artifacts. Enrichment is best-effort — failure does not block the pipeline.

### Dynamic Fix Tasks

When a review returns `needs_changes`, the orchestrator creates fix + re-review tasks with the same rich `description` contract (AGENT/MODEL/INPUT/OUTPUT/ISSUES):

1. `fix = TaskCreate(subject: "Fix [Phase] - [Reviewer] vN", description: "AGENT: ... ISSUES TO FIX: ...")`
2. `TaskUpdate(fix.id, addBlockedBy: [current_review_id])`
3. `rerev = TaskCreate(subject: "[Phase] Review - [Reviewer] vN+1", description: "AGENT: ... NOTE: Re-review after fix...")`
4. `TaskUpdate(rerev.id, addBlockedBy: [fix.id])`
5. `if next_reviewer_id is not null: TaskUpdate(next_reviewer_id, addBlockedBy: [rerev.id])`
   - Skip for Codex (final reviewer, no next reviewer)
6. `TaskUpdate(current_review_id, status: "completed")`
7. After max 10 re-reviews per reviewer, escalates to user

This maintains the sequential requirement and ensures the same reviewer validates fixes before proceeding.

---

## Quick Start

```
/multi-ai [description of what you want]
```

The pipeline will:
1. **Reset, create pipeline team & task chain** with dependencies
2. **Gather requirements** (team-based) - Specialist teammates explore in parallel, lead asks informed questions, then synthesize
3. **Plan** (semi-interactive) - Custom agent with Architect expertise
4. **Review plan** (task-enforced) - Sequential: Sonnet → Opus → Codex gate
5. **Implement** - Iterates until reviews approve
6. **Review code** (task-enforced) - Sequential: Sonnet → Opus → Codex gate
7. **Complete** - Report results

**No phase skipping:** Every pipeline run executes ALL phases in order. Pre-existing plans or context from plan mode are input to the specialists, not a substitute for the pipeline. Never skip team-based requirements gathering.

---

## Custom Agents

The pipeline uses specialized agents defined in `agents/` directory. Model selection is controlled by the orchestrator via Task tool, not hardcoded in agent definitions.

| Agent | Recommended Model | Purpose |
|-------|-------------------|---------|
| **requirements-gatherer** | opus | Business Analyst + Product Manager hybrid (supports synthesis mode with specialist analyses) |
| **planner** | opus | Architect + Fullstack Developer hybrid |
| **plan-reviewer** | sonnet/opus | Architect + Security + QA hybrid |
| **implementer** | sonnet | Fullstack + TDD + Quality hybrid |
| **code-reviewer** | sonnet/opus | Security + Performance + QA hybrid |

See `AGENTS.md` for detailed agent specifications.

---

## Key Features

### Task + Resume Architecture

Workers can be resumed with preserved context:
- **Resume for context** - Maintains conversation history across iterations
- **Fresh analysis** - Reviews start fresh for unbiased perspective

### Task-Based Sequential Enforcement

Reviews are enforced via `blockedBy` dependencies:
- Codex review **cannot start** until Opus review completes
- Opus review **cannot start** until Sonnet review completes
- This is data-driven, not instruction-driven

### Codex as Final Gate

Codex (independent AI) provides final approval:
- Different AI family catches different issues
- Not "Claude reviewing Claude"
- Required before implementation can start

---

## Skills

| Skill | Purpose | Phase |
|-------|---------|-------|
| `/multi-ai` | Start pipeline (entry point) | All |

**Note:** Requirements gathering, planning, review (sonnet/opus), and implementation are handled by custom agents via Task tool. Codex final gate review uses the `codex-reviewer` agent via `Task(subagent_type: "claude-codex:codex-reviewer", model: "external")`.

---

## Hook Enforcement

Pipeline enforcement uses two hooks:

### UserPromptSubmit Hook (Guidance)
- **File:** `hooks/guidance-hook.ts`
- **Purpose:** Reads `.task/*.json` files to determine phase, injects advisory guidance
- **No state tracking:** Phase is implicit from which artifact files exist

### SubagentStop Hook (Enforcement)
- **File:** `hooks/review-validator.ts`
- **Purpose:** Validates reviewer outputs when agents finish
- **Can block:** Returns `{"decision": "block", "reason": "..."}` if:
  - Review doesn't verify all acceptance criteria
  - Review approves with unimplemented ACs

Max 10 re-reviews per reviewer before escalating to user.

---

## Output Formats

### User Story (`.task/user-story.json`)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "requirements": {...},
  "acceptance_criteria": [...],
  "scope": {...},
  "test_criteria": {...},
  "implementation": { "max_iterations": 10 }
}
```

### Plan Refined (`.task/plan-refined.json`)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Plan title",
  "technical_approach": {...},
  "steps": [...],
  "test_plan": {...},
  "risk_assessment": {...},
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

### Pipeline Tasks (`.task/pipeline-tasks.json`)
```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "requirements": "task-id-1",
  "plan": "task-id-2",
  "plan_review_sonnet": "task-id-3",
  "plan_review_opus": "task-id-4",
  "plan_review_codex": "task-id-5",
  "implementation": "task-id-6",
  "code_review_sonnet": "task-id-7",
  "code_review_opus": "task-id-8",
  "code_review_codex": "task-id-9"
}
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `orchestrator.ts` | Initialize/reset pipeline, show status (`bun orchestrator.ts [cmd]`) |
| `json-tool.ts` | Cross-platform JSON operations (`bun json-tool.ts [cmd]`) |

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset`
4. **If TaskList() doesn't work:** Check that the pipeline team exists — Step 1.5 may need to be re-run

---

## Model Assignment Summary

| Phase | Agent | Model | Reason |
|-------|-------|-------|--------|
| Requirements | requirements-gatherer | **opus** | Deep understanding + user interaction |
| Planning | planner | **opus** | Comprehensive codebase research |
| Plan Review #1 | plan-reviewer | sonnet | Quick quality check |
| Plan Review #2 | plan-reviewer | opus | Deep architectural analysis |
| Plan Review #3 | **Codex** | external | Independent final gate |
| Implementation | implementer | sonnet | Balanced speed/quality |
| Code Review #1 | code-reviewer | sonnet | Quick code check |
| Code Review #2 | code-reviewer | opus | Deep code analysis |
| Code Review #3 | **Codex** | external | Independent final gate |
