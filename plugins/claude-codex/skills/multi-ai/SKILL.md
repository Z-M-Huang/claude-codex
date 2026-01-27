---
name: multi-ai
description: Start the multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Codex final gate.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Multi-AI Pipeline Orchestrator

You coordinate worker agents using Task tools, handle user questions, and drive the pipeline to completion with Codex as final gate.

**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`
**Agents location:** `${CLAUDE_PLUGIN_ROOT}/agents/`

---

## Architecture: Tasks + Hook Enforcement

This pipeline uses a **task-based approach with hook enforcement**:

| Component | Role |
|-----------|------|
| **Tasks** (primary) | Structural enforcement via `blockedBy`, user visibility, audit trail |
| **UserPromptSubmit Hook** (guidance) | Reads artifact files, injects phase guidance |
| **SubagentStop Hook** (enforcement) | Validates reviewer outputs, can BLOCK until requirements met |
| **Main Thread** (orchestrator) | Handles user input, creates dynamic tasks, can restart/kick back |

**Key insight:** `blockedBy` is *data*, not an instruction. `TaskList()` shows all tasks with their `blockedBy` fields - only claim tasks where blockedBy is empty or all dependencies are completed.

**Enforcement insight:** SubagentStop hook validates reviews and can return `{"decision": "block", "reason": "..."}` to prevent invalid reviews from proceeding.

---

## Pipeline Initialization

### Step 1: Reset Pipeline

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset
```

### Step 2: Create Task Chain

Create all pipeline tasks with dependencies. Store task IDs in `.task/pipeline-tasks.json`.

```
TaskCreate: "Gather requirements"                    → T1 (blockedBy: [])
TaskCreate: "Create implementation plan"            → T2 (blockedBy: [T1])
TaskCreate: "Plan Review - Sonnet"                  → T3 (blockedBy: [T2])
TaskCreate: "Plan Review - Opus"                    → T4 (blockedBy: [T3])
TaskCreate: "Plan Review - Codex"                   → T5 (blockedBy: [T4])
TaskCreate: "Implementation"                        → T6 (blockedBy: [T5])
TaskCreate: "Code Review - Sonnet"                  → T7 (blockedBy: [T6])
TaskCreate: "Code Review - Opus"                    → T8 (blockedBy: [T7])
TaskCreate: "Code Review - Codex"                   → T9 (blockedBy: [T8])
```

Save to `.task/pipeline-tasks.json`:
```json
{
  "requirements": "T1-id",
  "plan": "T2-id",
  "plan_review_sonnet": "T3-id",
  "plan_review_opus": "T4-id",
  "plan_review_codex": "T5-id",
  "implementation": "T6-id",
  "code_review_sonnet": "T7-id",
  "code_review_opus": "T8-id",
  "code_review_codex": "T9-id"
}
```

---

## Main Loop

Execute this data-driven loop until complete:

```
while pipeline not complete:
    1. TaskList() → find task where blockedBy is empty/resolved AND status is pending
    2. TaskUpdate(task_id, status: "in_progress")
    3. Execute task using appropriate agent (Task tool)
    4. Check output file for result
    5. Handle result (see Result Handling below)
    6. TaskUpdate(task_id, status: "completed")
    # Note: SubagentStop hook validates reviewer outputs and can block if invalid
```

### Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Create fix task + re-review task for SAME reviewer |
| `rejected` (Codex plan) | Terminal state `plan_rejected` - ask user |
| `rejected` (code review) | Create REWORK task + re-review for SAME reviewer |
| `needs_clarification` | Read `clarification_questions`, answer directly if possible, otherwise use AskUserQuestion. After clarification, update review file and re-run SAME reviewer. |

**Implementation results:**

| Result | Action |
|--------|--------|
| `complete` | Continue to code review |
| `partial` | Continue implementation (resume implementer agent) |
| `partial` + true blocker | State `awaiting_user_decision` - ask user |
| `failed` | Terminal state `implementation_failed` - ask user |

**True blockers** (require user input, cannot auto-continue):
- Missing credentials/secrets/API keys
- Conflicting requirements
- External dependency unavailable
- Security decision or authorization required

**Severity:**
- `needs_changes` = minor issues, fixable
- `rejected` = fundamental problems, requires rework or user decision
- `failed` = blocked, requires user intervention

---

## Dynamic Tasks (Same-Reviewer Re-Review)

When a review returns `needs_changes` or `rejected`, the **same reviewer** must validate before proceeding.

**Exception:** Codex plan `rejected` is terminal - no re-review, escalate to user immediately.

### needs_changes → Fix Task

Minor issues that can be addressed without major rework:

```
T3 (Sonnet) returns needs_changes:
  Create: T3.1 "Fix Plan - Sonnet v1" (blockedBy: T3)
  Create: T3.2 "Plan Review - Sonnet v2" (blockedBy: T3.1)
  Update: T4 addBlockedBy: [T3.2]
```

### rejected → Rework Task (Code Reviews Only)

Fundamental issues requiring significant changes:

```
T7 (Sonnet code review) returns rejected:
  Create: T7.1 "Rework Code - Sonnet v1" (blockedBy: T7)
  Create: T7.2 "Code Review - Sonnet v2" (blockedBy: T7.1)
  Update: T8 addBlockedBy: [T7.2]
```

### rejected → Terminal (Codex Plan Review)

Codex rejecting plan = fundamental approach issue:

```
T5 (Codex plan review) returns rejected:
  → Terminal state: plan_rejected
  → Ask user: restart requirements, revise plan, or abort
```

### Iteration Tracking

Track iterations via dynamic task naming (v1, v2, v3...). After **10 re-reviews**, escalate to user.

```
fix_plan_sonnet_v1 → plan_review_sonnet_v2
fix_plan_sonnet_v2 → plan_review_sonnet_v3
...
```

---

## Agent Reference

| Task | Agent | Model | Output File |
|------|-------|-------|-------------|
| Gather requirements | requirements-gatherer | opus | user-story.json |
| Create plan | planner | opus | plan-refined.json |
| Plan Review - Sonnet | plan-reviewer | sonnet | review-sonnet.json |
| Plan Review - Opus | plan-reviewer | opus | review-opus.json |
| Plan Review - Codex | codex-reviewer | external | review-codex.json |
| Implementation | implementer | sonnet | impl-result.json |
| Code Review - Sonnet | code-reviewer | sonnet | code-review-sonnet.json |
| Code Review - Opus | code-reviewer | opus | code-review-opus.json |
| Code Review - Codex | codex-reviewer | external | code-review-codex.json |

### Spawning Workers

```
Task(
  subagent_type: "claude-codex:<agent-name>",
  model: "<model>",
  prompt: "[Agent instructions] + [Context from .task/ files]"
)
```

For Codex reviews:
```
Task(
  subagent_type: "claude-codex:codex-reviewer",
  prompt: "[Agent instructions] + Review [plan/code]"
)
```

---

## User Interaction

The main thread handles user input throughout the pipeline:

### User Provides Additional Info

If user adds requirements mid-pipeline:

1. **During requirements/planning:** Incorporate and continue
2. **After plan review started:** Ask user if they want to:
   - Continue with current plan
   - Kick back to planning phase
   - Restart from requirements

### Suggesting Restart

When significant issues arise, suggest options:

```
AskUserQuestion:
  "The plan has fundamental issues. Options:"
  1. "Restart from requirements" - Gather new requirements
  2. "Revise plan" - Keep requirements, re-plan
  3. "Continue anyway" - Proceed with current plan
```

### Kick Back Pattern

To kick back to an earlier phase:

1. Mark current tasks as completed (with metadata noting "superseded")
2. Create new tasks for the phase to restart
3. Update blockedBy chains accordingly
4. Use `state-manager.sh set <phase> ""` to reset state (emergency only)

---

## Hook Behavior

### UserPromptSubmit Hook (Guidance)

The `guidance-hook.js` runs on every prompt and:

1. **Reads artifact files** - Checks `.task/*.json` to determine current phase
2. **Injects guidance** - Reminds you what to do next
3. **No state tracking** - Phase is implicit from which files exist

### SubagentStop Hook (Enforcement)

The `review-validator.js` runs when reviewer agents finish and:

1. **Validates AC coverage** - Checks `acceptance_criteria_verification` (code) or `requirements_coverage` (plan)
2. **Blocks invalid reviews** - Returns `{"decision": "block", "reason": "..."}` if:
   - Review doesn't verify all ACs from user-story.json
   - Review approves with incomplete ACs (NOT_IMPLEMENTED or PARTIAL)
3. **Allows valid reviews** - Proceeds normally when validation passes

### Guidance Examples

Current phase guidance:
```
**Phase: Code Review**
→ Run Sonnet code review (code-reviewer agent, sonnet)

**Reminder**: 5 acceptance criteria must be verified in all reviews.
Reviews MUST include acceptance_criteria_verification (code) or requirements_coverage (plan).
```

### Enforcement Examples

SubagentStop blocking:
```json
{
  "decision": "block",
  "reason": "Review missing acceptance_criteria_verification. Must verify all acceptance criteria from user-story.json."
}
```

**Important:** SubagentStop enforcement is mandatory. Tasks with `blockedBy` are the primary structural enforcement.

---

## Output File Formats

### user-story.json
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "acceptance_criteria": [
    { "id": "AC1", "description": "..." }
  ]
}
```

### plan-refined.json
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Plan title",
  "steps": [
    { "description": "Step 1", "files": [...] }
  ]
}
```

### review-*.json (plan reviews)
```json
{
  "status": "approved" | "needs_changes" | "needs_clarification" | "rejected",
  "needs_clarification": false,
  "clarification_questions": [],
  "summary": "...",
  "feedback": "...",
  "requirements_coverage": {
    "mapping": [
      { "ac_id": "AC1", "steps": ["Step 1: Setup authentication..."] },
      { "ac_id": "AC2", "steps": ["Step 3: Add validation...", "Step 4: Error handling"] }
    ],
    "missing": []
  }
}
```

**Required fields:** `needs_clarification` (boolean), `clarification_questions` (array), `requirements_coverage`.
**Note:** Set `needs_clarification: true` and populate `clarification_questions` when status is `needs_clarification`.

### code-review-*.json (code reviews)
```json
{
  "status": "approved" | "needs_changes" | "needs_clarification" | "rejected",
  "needs_clarification": false,
  "clarification_questions": [],
  "summary": "...",
  "feedback": "...",
  "acceptance_criteria_verification": {
    "total": 2,
    "verified": 1,
    "missing": ["AC2"],
    "details": [
      { "ac_id": "AC1", "status": "IMPLEMENTED", "evidence": "src/auth.ts:45", "notes": "" },
      { "ac_id": "AC2", "status": "NOT_IMPLEMENTED", "evidence": "", "notes": "Missing validation" }
    ]
  }
}
```

**Required fields:** `needs_clarification` (boolean), `clarification_questions` (array), `acceptance_criteria_verification`.
**Note:** Set `needs_clarification: true` and populate `clarification_questions` when status is `needs_clarification`.
**Important:** Status must be `IMPLEMENTED` for all ACs to approve. `NOT_IMPLEMENTED` or `PARTIAL` blocks approval.

### impl-result.json
```json
{
  "status": "complete" | "partial" | "failed",
  "files_changed": [...],
  "blocked_reason": "..."
}
```

---

## Terminal States

| State | Meaning | Action |
|-------|---------|--------|
| `complete` | All reviews approved | Report success |
| `max_iterations_reached` | 10+ fix iterations | Escalate to user |
| `plan_rejected` | Codex rejected plan | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Important Rules

1. **Tasks are primary** - Create tasks with `blockedBy` for structural enforcement
2. **SubagentStop enforces** - Hook validates reviewer outputs and can block
3. **AC verification required** - All reviews MUST verify acceptance criteria from user-story.json
4. **Same-reviewer re-review** - After fix/rework, SAME reviewer validates before next
5. **Codex is mandatory** - Pipeline NOT complete without Codex approval
6. **Max 10 iterations** - Per reviewer, then escalate to user
7. **Accept all feedback** - No debate with reviewers, just fix
8. **User can interrupt** - Handle additional input, offer restart/kick back

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Reset pipeline:** `"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset`
