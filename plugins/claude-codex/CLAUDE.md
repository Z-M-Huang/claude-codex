# Claude Code - Multi-AI Pipeline with Ralph Loop

> **IMPORTANT**: This project uses a **TDD-driven Ralph Loop** for implementation. User interaction happens during requirements gathering and optionally during planning. The implementation phase uses the Ralph Wiggum technique - iterating automatically until tests pass AND all reviews approve.

## Path Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory | `~/.claude/plugins/claude-codex/` |
| `${CLAUDE_PROJECT_DIR}` | Your project directory | `/path/to/your/project/` |

**Important:** The `.task/` directory is created in your **project directory**, not the plugin directory.

## Architecture Overview

```
Multi-AI Pipeline with Ralph Loop
  │
  ├── Phase 1: Requirements (INTERACTIVE)
  │     └── /user-story → Gather requirements + TDD criteria
  │
  ├── Phase 2: Planning (SEMI-INTERACTIVE)
  │     ├── Create plan with test commands & risk assessment
  │     ├── Review loop (autonomous)
  │     └── Prompt user ONLY if conflicts detected
  │
  ├── Phase 3: Implementation (RALPH LOOP)
  │     ├── IF simple mode → single implementation cycle
  │     └── IF ralph-loop mode:
  │           ┌─────────────────────────────────┐
  │           │  LOOP until max iterations:     │
  │           │  1. Implement/fix code          │
  │           │  2. Review (sonnet→opus→codex)  │
  │           │  3. Run tests                   │
  │           │  IF all pass → EXIT             │
  │           │  ELSE → continue loop           │
  │           └─────────────────────────────────┘
  │
  └── Phase 4: Completion
        └── Report results
```

---

## Quick Start

```
/multi-ai [description of what you want]
```

The pipeline will:
1. **Gather requirements** (interactive) - Including TDD criteria
2. **Plan** (semi-interactive) - Only asks if conflicts detected
3. **Implement** (ralph loop) - Iterates until tests pass + reviews approve
4. **Complete** - Report results

---

## Skills

| Skill | Purpose | Model | Phase |
|-------|---------|-------|-------|
| `/multi-ai` | Start pipeline (entry point) | - | All |
| `/user-story` | Gather requirements + TDD criteria | - | Requirements |
| `/implement-sonnet` | Code implementation | sonnet | Implementation |
| `/review-sonnet` | Fast review | sonnet | Review |
| `/review-opus` | Deep review | opus | Review |
| `/review-codex` | Final review (Codex CLI) | codex | Review |
| `/cancel-loop` | Cancel active ralph loop | - | Emergency |

---

## Implementation Modes

### Simple Mode
For small, straightforward changes:
- Single implementation pass
- One review cycle
- Tests run once
- No looping

### Ralph Loop Mode (Default for complex features)
For features requiring iteration:
- Stop hook intercepts session exit
- Reviews + tests run each iteration
- Loops until ALL pass:
  - Sonnet review: approved
  - Opus review: approved
  - Codex review: approved
  - All test commands: exit code 0
- Max iterations safety limit (default: 10)

---

## TDD Criteria

During requirements gathering, define:

```json
{
  "test_criteria": {
    "commands": ["npm test", "npm run lint"],
    "success_pattern": "passed|✓",
    "failure_pattern": "FAILED|Error"
  },
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10
  }
}
```

---

## Risk Assessment

Planning phase detects potential infinite loop risks:

1. **Test vs Review conflicts** - Test requires something reviews might reject
2. **Linter vs Style conflicts** - Auto-fixes conflict with coding standards
3. **Missing infrastructure** - Test dependencies not available
4. **Circular dependencies** - Fixes create new review issues

If risks detected → prompt user for decision.

---

## State Machine

```
idle
  ↓
requirements_gathering (/user-story - INTERACTIVE)
  ↓ [approved]
plan_drafting
  ↓
plan_refining (+ risk assessment)
  ↓ [conflicts? → ask user]
plan_reviewing (review loop)
  ↓ [all approved]
implementing (simple) OR implementing_loop (ralph)
  │
  │ [ralph loop mode]
  │  ┌──────────────────────────┐
  │  │ implement → review → test│
  │  │ IF all pass → exit       │
  │  │ ELSE → loop              │
  │  └──────────────────────────┘
  ↓
complete
```

---

## Loop State File

During ralph loop, `.task/loop-state.json` tracks progress:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 10,
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
  "plan_path": ".task/plan-refined.json",
  "started_at": "2026-01-22T10:00:00Z"
}
```

To cancel loop manually: `rm .task/loop-state.json` or `/cancel-loop`

---

## Output Formats

### User Story (`.task/user-story.json`)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "requirements": {
    "functional": ["req1"],
    "technical": ["tech1"],
    "acceptance_criteria": ["criterion1"]
  },
  "test_criteria": {
    "commands": ["npm test"],
    "success_pattern": "passed"
  },
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10
  },
  "approved_at": "ISO8601",
  "approved_by": "user"
}
```

### Plan Refined (`.task/plan-refined.json`)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "technical_approach": "How to implement",
  "files_to_modify": ["path/to/file.ts"],
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10,
    "skill": "implement-sonnet"
  },
  "test_plan": {
    "commands": ["npm test", "npm run lint"],
    "success_pattern": "passed|✓",
    "run_after_review": true
  },
  "risk_assessment": {
    "infinite_loop_risks": [],
    "conflicts_detected": [],
    "requires_user_decision": false
  },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

---

## Hooks

The plugin uses a Stop hook for the ralph loop:

**`hooks/hooks.json`:**
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bun ${CLAUDE_PLUGIN_ROOT}/hooks/implementation-stop-hook.js"
      }]
    }]
  }
}
```

The hook:
1. Checks if loop is active (`.task/loop-state.json`)
2. **Reads** existing review files (does NOT run review skills)
3. **Runs** test commands from plan (in project directory)
4. Checks success/failure patterns from plan
5. Blocks exit if criteria not met, re-feeds prompt
6. Allows exit when all criteria pass

**IMPORTANT:** You must run `/review-sonnet`, `/review-opus`, `/review-codex` yourself before attempting to exit. The hook only verifies the review file contents.

---

## Configuration

`pipeline.config.json`:

```json
{
  "version": "1.1.1",
  "autonomy": {
    "mode": "ralph-loop",
    "approvalPoints": {
      "userStory": true,
      "planning": false,
      "implementation": false
    },
    "pauseOnlyOn": ["needs_clarification", "review_loop_exceeded", "conflicts_detected"],
    "planReviewLoopLimit": 10,
    "codeReviewLoopLimit": 15
  },
  "ralphLoop": {
    "defaultMode": "ralph-loop",
    "defaultMaxIterations": 10,
    "completionPromise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
    "testSuccessExitCode": 0
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

## Completion Criteria

All must be true to exit ralph loop:

1. ✓ `.task/review-sonnet.json` → status: "approved"
2. ✓ `.task/review-opus.json` → status: "approved"
3. ✓ `.task/review-codex.json` → status: "approved"
4. ✓ All test commands → exit code 0
5. ✓ Output contains completion promise
