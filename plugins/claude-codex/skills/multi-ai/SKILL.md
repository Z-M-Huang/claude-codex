---
name: multi-ai
description: Start the multi-AI pipeline with TDD-driven ralph loop. Plan → Review → Implement (loop until tests pass + reviews approve).
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, AskUserQuestion
---

# Multi-AI Pipeline with Ralph Loop

This pipeline combines human-guided planning with autonomous TDD-driven implementation using the Ralph Wiggum technique.

**Scripts location:** `${CLAUDE_PLUGIN_ROOT}/scripts/`
**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`

---

## Pipeline Overview

```
Phase 1: Requirements (INTERACTIVE)
├── /user-story gathers requirements + TDD criteria
└── User approves

Phase 2: Planning (SEMI-INTERACTIVE)
├── Create plan with test commands, mode, risk assessment
├── Review loop for plan (autonomous)
└── Prompt user ONLY if clarification needed or conflicts detected

Phase 3: Implementation
├── IF simple mode → implement + single review cycle
└── IF ralph-loop mode → iterate until tests pass + reviews approve

Phase 4: Complete
```

---

## Phase 1: Requirements Gathering (Interactive)

### Step 1: Clean Up Previous Task

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset
```

### Step 2: Set State and Gather Requirements

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set requirements_gathering ""
```

**Invoke /user-story** to interactively gather:
- Functional requirements
- Technical requirements
- Acceptance criteria
- **TDD criteria** (test commands, success patterns)
- **Implementation mode** (simple or ralph-loop)
- **Max iterations** (default 10)

**WAIT** for user approval before continuing.

---

## Phase 2: Planning (Semi-Interactive)

### Step 3: Create Initial Plan

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting ""
```

Create `.task/plan.json` based on the approved user story.

### Step 4: Refine Plan with Risk Assessment

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_refining "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan.json .id)"
```

Research the codebase and create `.task/plan-refined.json` with:

```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "description": "What the user wants",
  "requirements": ["req 1", "req 2"],
  "technical_approach": "How to implement",
  "files_to_modify": ["path/to/file.ts"],
  "files_to_create": ["path/to/new.ts"],
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
    "infinite_loop_risks": [
      "Risk: Linter auto-fix may conflict with reviewer style preferences"
    ],
    "conflicts_detected": [],
    "requires_user_decision": false
  },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
  "refined_by": "claude",
  "refined_at": "ISO8601"
}
```

### Step 5: Risk Assessment Check

Before proceeding, analyze for potential infinite loop risks:

**Check for conflicts:**
1. **Test vs Review conflicts**: Does the test require something reviews might reject?
2. **Linter vs Style conflicts**: Do auto-fixes conflict with coding standards?
3. **Missing infrastructure**: Are test dependencies available?
4. **Circular dependencies**: Could fixes create new review issues?

**IF `risk_assessment.requires_user_decision` is true:**
- Use `AskUserQuestion` to present the risks
- Get user decision on how to proceed
- Update plan based on user input

**OTHERWISE:** Proceed autonomously.

### Step 6: Plan Review Loop (Autonomous)

Run the review loop for the plan:

```
LOOP_COUNT = 0
MAX_LOOPS = planReviewLoopLimit from config (default: 10)

WHILE LOOP_COUNT < MAX_LOOPS:
    1. INVOKE /review-sonnet (plan mode)
    2. INVOKE /review-opus (plan mode)
    3. INVOKE /review-codex (plan mode)

    IF all approved → BREAK
    IF needs_changes → FIX and continue
    IF needs_clarification → ASK user, then continue

    LOOP_COUNT += 1
```

---

## Phase 3: Implementation

### Step 7: Check Implementation Mode

Read the implementation mode from `.task/plan-refined.json`:

```bash
MODE=$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .implementation.mode)
```

### IF mode == "simple": Single Implementation Cycle

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

1. **Invoke /implement-sonnet**
2. Run single review cycle (sonnet → opus → codex)
3. Run tests
4. If all pass → complete
5. If issues → fix once, then complete (no loop)

### IF mode == "ralph-loop": TDD Ralph Loop

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing_loop "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

**Initialize loop state:**

Write `.task/loop-state.json`:
```json
{
  "active": true,
  "iteration": 0,
  "max_iterations": 10,
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
  "plan_path": ".task/plan-refined.json",
  "started_at": "ISO8601"
}
```

**Execute the Ralph Loop:**

The stop hook (`hooks/implementation-stop-hook.js`) will intercept exit attempts and verify:

1. **Check review files**: Read existing `.task/review-*.json` files for status
2. **Run test commands** from plan (in project directory)
3. **Verify completion criteria**:
   - All review files have status == "approved"
   - All test commands pass (exit code from config, default 0)
   - Success/failure patterns match (if defined in plan)

**IMPORTANT:** The hook READS review files - it does NOT run the review skills.
You must invoke `/review-sonnet`, `/review-opus`, `/review-codex` yourself before attempting to exit.

**IF criteria met:**
- Output: `<promise>IMPLEMENTATION_COMPLETE</promise>`
- Hook allows exit

**IF criteria NOT met:**
- Hook blocks exit
- Re-feeds the implementation prompt:
  ```
  Continue implementing based on the plan at .task/plan-refined.json

  Previous iteration: [N] of [MAX]
  Review status: [summary of issues]
  Test status: [pass/fail summary]

  Fix the issues and try again.
  Output <promise>IMPLEMENTATION_COMPLETE</promise> when:
  - All reviews pass (sonnet, opus, codex approve)
  - All tests pass (exit code 0)
  ```

**Loop continues until:**
- Completion promise detected AND tests pass AND reviews pass
- OR max iterations reached (pause and ask user)

---

## Phase 4: Completion

### Step 8: Clean Up Loop State

```bash
rm -f .task/loop-state.json
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set complete "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

### Step 9: Report Results

Report to user:
- What was implemented
- Files changed
- Tests added/modified
- Review iterations taken
- Final test results

---

## Ralph Loop Details

### How the Stop Hook Works

When Claude tries to exit during `implementing_loop` state:

1. Hook reads `.task/loop-state.json`
2. If `active: false` or missing → allow exit
3. If `iteration >= max_iterations` → allow exit, warn user
4. Otherwise:
   - **Read** existing review files (`.task/review-*.json`)
   - **Run** test commands from plan (changes to project directory first)
   - Check success/failure patterns from plan config
   - Check if completion criteria met
   - If met → allow exit
   - If not → increment iteration, block exit, return prompt

**Note:** The hook does NOT invoke review skills - it only reads the review result files. You must run the reviews yourself before attempting to exit.

### Completion Criteria

All must be true:
1. `.task/review-sonnet.json` status == "approved"
2. `.task/review-opus.json` status == "approved"
3. `.task/review-codex.json` status == "approved"
4. All test commands from plan exit with code 0

### Safety Mechanisms

1. **Max iterations**: Hard limit (default 10, user configurable)
2. **Conflict detection**: Planning phase flags potential infinite loops
3. **Cancel command**: `/cancel-loop` to abort at any time
4. **State file**: Remove `.task/loop-state.json` to stop loop

---

## Important Rules

1. **Semi-interactive planning**: Only ask user when genuinely needed
2. **Autonomous implementation**: Ralph loop handles iteration automatically
3. **Review before test**: Always run reviews first, then tests
4. **Accept all feedback**: No debate with reviewers, just fix
5. **Clear completion criteria**: Tests pass + reviews approve

---

## Progress Reporting

```
Requirements approved. Starting planning...
✓ Plan created
✓ Risk assessment: No conflicts detected
✓ Plan reviews: approved (2 iterations)

Starting implementation (ralph-loop mode, max 10 iterations)...
Iteration 1:
  ✓ Implementation complete
  ✗ Sonnet review: 2 issues
  - Fixing issues...
Iteration 2:
  ✓ Fixes applied
  ✓ Sonnet review: approved
  ✓ Opus review: approved
  ✓ Codex review: approved
  ✓ Tests: 5 passed, 0 failed

<promise>IMPLEMENTATION_COMPLETE</promise>

✓ Complete! Feature implemented in 2 iterations.
```
