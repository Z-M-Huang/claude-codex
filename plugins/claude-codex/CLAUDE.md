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
Multi-Session Orchestrator Pipeline
  |
  +-- Orchestrator (Main Session)
  |     +-- Coordinates worker agents via Task tool
  |     +-- Handles decision escalation from workers
  |     +-- Manages state and resume contexts
  |
  +-- Phase 1: Requirements (INTERACTIVE)
  |     +-- requirements-gatherer agent (opus)
  |     +-- Resume for user Q&A iterations
  |     -> .task/user-story.json
  |
  +-- Phase 2: Planning (SEMI-INTERACTIVE)
  |     +-- planner agent (opus)
  |     +-- Resume if reviews request changes
  |     -> .task/plan-refined.json
  |
  +-- Phase 3: Plan Reviews
  |     +-- plan-reviewer agent (sonnet -> opus)
  |     +-- Codex final gate
  |     -> .task/review-*.json
  |
  +-- Phase 4: Implementation (RALPH LOOP)
  |     +-- implementer agent (sonnet)
  |     +-- Resume for iterative fixes
  |     -> .task/impl-result.json
  |
  +-- Phase 5: Code Reviews
  |     +-- code-reviewer agent (sonnet -> opus)
  |     +-- Codex final gate
  |     -> .task/review-*.json
  |
  +-- Phase 6: Completion
        +-- Report results
```

---

## Quick Start

```
/multi-ai [description of what you want]
```

The pipeline will:
1. **Gather requirements** (interactive) - Custom agent with Business Analyst + PM expertise
2. **Plan** (semi-interactive) - Custom agent with Architect expertise
3. **Review plan** (autonomous) - Sequential reviews: sonnet -> opus -> Codex gate
4. **Implement** (ralph loop) - Iterates until tests pass + reviews approve
5. **Review code** (autonomous) - Sequential reviews: sonnet -> opus -> Codex gate
6. **Complete** - Report results

---

## Custom Agents

The pipeline uses specialized agents defined in `agents/` directory. Model selection is controlled by the orchestrator via Task tool, not hardcoded in agent definitions.

| Agent | Recommended Model | Purpose |
|-------|-------------------|---------|
| **requirements-gatherer** | opus | Business Analyst + Product Manager hybrid |
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
- **Signal protocol** - Workers communicate needs via `.task/worker-signal.json`

### Codex as Final Gate

Codex (independent AI) provides final approval:
- Different AI family catches different issues
- Not "Claude reviewing Claude"
- Required before implementation can start

### Worker Signal Protocol

Workers communicate via `.task/worker-signal.json`:

```json
{
  "worker_id": "phase-timestamp-random",
  "phase": "requirements|planning|implementation",
  "status": "needs_input|completed|error|in_progress",
  "questions": [...],
  "agent_id": "for_resume"
}
```

---

## Skills

| Skill | Purpose | Phase |
|-------|---------|-------|
| `/multi-ai` | Start pipeline (entry point) | All |
| `/review-codex` | Final review (Codex CLI) | Review |
| `/cancel-loop` | Cancel active ralph loop | Emergency |

**Note:** Requirements gathering, planning, review (sonnet/opus), and implementation are handled by custom agents via Task tool. Codex review uses the `/review-codex` skill for proper CLI invocation.

---

## Implementation Modes

### Simple Mode
For small, straightforward changes:
- Single implementation pass
- One review cycle
- Tests run once

### Ralph Loop Mode (Default)
For features requiring iteration:
- Implementer agent resumed for fixes
- Reviews + tests run each iteration
- Loops until ALL pass:
  - Sonnet review: approved
  - Opus review: approved
  - Codex review: approved
  - All test commands: exit code 0

---

## State Machine

```
idle
  |
requirements_gathering (requirements-gatherer agent)
  | [approved]
plan_drafting
  |
plan_refining (planner agent)
  | [conflicts? -> ask user]
plan_reviewing (review loop: sonnet -> opus -> codex)
  | [all approved]
implementing (simple) OR implementing_loop (ralph)
  |
  | [ralph loop mode]
  |  +-- implement -> review -> test
  |  |   IF all pass -> exit
  |  |   ELSE -> resume implementer, loop
  |
complete
```

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
  "implementation": { "mode": "ralph-loop", "max_iterations": 10 }
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

### Loop State (`.task/loop-state.json`)
```json
{
  "active": true,
  "iteration": 0,
  "max_iterations": 10,
  "implementer_agent_id": "for-resume",
  "started_at": "ISO8601"
}
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `state-manager.sh` | Manage pipeline state |
| `orchestrator.sh` | Initialize/reset pipeline |
| `json-tool.ts` | Cross-platform JSON operations |
| `worker-protocol.ts` | Worker signal management |

---

## Configuration

`pipeline.config.json`:

```json
{
  "version": "1.2.0",
  "autonomy": {
    "mode": "ralph-loop",
    "planReviewLoopLimit": 10,
    "codeReviewLoopLimit": 15
  },
  "ralphLoop": {
    "defaultMode": "ralph-loop",
    "defaultMaxIterations": 10,
    "completionPromise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
  }
}
```

---

## Emergency Controls

If the loop is stuck:

1. **Cancel command:** `/cancel-loop`
2. **Delete state file:** `rm .task/loop-state.json`
3. **Max iterations:** Loop auto-stops at limit

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
