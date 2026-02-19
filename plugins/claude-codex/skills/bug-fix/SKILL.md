---
name: bug-fix
description: Bug-fix pipeline. Dual RCA (Sonnet+Opus) -> Consolidation -> Codex Validation -> Implementation -> Code Review.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
---

# Bug-Fix Pipeline Orchestrator

You coordinate worker agents using Task tools to diagnose and fix a bug. The pipeline uses dual Root Cause Analysis (Sonnet + Opus in parallel), orchestrator-driven consolidation, Codex validation, implementation, and the standard code review chain.

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
| **Main Thread** (orchestrator) | Handles consolidation, user input, creates dynamic tasks |

**Key insight:** `blockedBy` is *data*, not an instruction. `TaskList()` shows all tasks with their `blockedBy` fields — only claim tasks where blockedBy is empty or all dependencies are completed.

**Bug-fix differentiator:** Unlike `/multi-ai`, this pipeline does NOT use requirements-gatherer, planner, or plan-reviewer agents. The orchestrator itself consolidates dual RCA findings and writes `user-story.json` + `plan-refined.json` directly.

---

## Pipeline Initialization

### Step 1: Reset Pipeline

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset
```

### Step 1.5: Create Pipeline Team (Idempotent)

Create the pipeline team so that TaskCreate/TaskUpdate/TaskList tools become available.

**Derive team name:** Use `pipeline-{BASENAME}-{HASH}` where:
- `{BASENAME}` = last directory component of project path, sanitized
- `{HASH}` = first 6 characters of SHA-256 hash of canonicalized project path

**Path canonicalization (before hashing):**
1. Resolve to absolute path
2. Resolve symlinks to their targets
3. Normalize path separators to `/` (convert `\` on Windows)
4. Normalize Windows drive letter to lowercase (e.g., `D:\` → `d:/`)
5. Remove trailing slash if present

**Sanitization algorithm (for basename):**
1. Take basename of project directory (e.g., `/home/user/My App!` → `My App!`)
2. Lowercase all characters
3. Replace any character NOT in `[a-z0-9-]` with `-`
4. Collapse consecutive `-` into single `-`
5. Trim leading/trailing `-`
6. Truncate to 20 characters max
7. **If result is empty, use `project` as default**

**Idempotent startup:** Always attempt `TeamDelete` first (ignore errors), then create fresh:

```
TeamDelete(team_name: "pipeline-{BASENAME}-{HASH}")   ← ignore errors (team may not exist)
TeamCreate(team_name: "pipeline-{BASENAME}-{HASH}", description: "Bug-fix pipeline orchestration and task management")
```

Store the computed team name in `.task/pipeline-tasks.json` as the `team_name` field.

### Step 1.6: Verify Task Tools Available

After creating the team, call the **TaskList tool** directly (do NOT use Bash or Task agents):

```
result = TaskList()
```

**Success:** TaskList() returns an empty array `[]`. Proceed to Step 2.
**Stale tasks detected:** TaskList() returns a non-empty list — stop and report to user.
**Tool error:** TaskList() fails or returns an error. Stop and report to user.

### Step 2: Create 7-Task Chain

**The FIRST action after team verification is creating the full task chain. No agents are spawned before the task chain exists.**

**CRITICAL: Call the TaskCreate and TaskUpdate tools directly.** Do NOT use Bash, Task (subagent), Write, or any other tool as a substitute.

**TaskCreate API:**
- Parameters: `subject` (required string), `description` (optional string), `activeForm` (optional string)
- Returns: task object with `id` field
- **TaskCreate does NOT accept `blockedBy`.** Set dependencies via TaskUpdate after creation.

Create all 7 tasks, then chain them with addBlockedBy:

```
T1 = TaskCreate(
  subject: "RCA - Sonnet",
  activeForm: "Analyzing root cause (Sonnet)...",
  description: "PHASE: Root Cause Analysis (parallel - Sonnet)\nAGENT: claude-codex:root-cause-analyst (model: sonnet)\nINPUT: Bug description from conversation context\nOUTPUT: .task/rca-sonnet.json\nPROMPT MUST INCLUDE: Full bug description, 'You are analyzing as Sonnet. Write output to .task/rca-sonnet.json. Set reviewer field to sonnet.'\nCOMPLETION: .task/rca-sonnet.json exists with root_cause.summary and root_cause.root_file populated"
)

T2 = TaskCreate(
  subject: "RCA - Opus",
  activeForm: "Analyzing root cause (Opus)...",
  description: "PHASE: Root Cause Analysis (parallel - Opus)\nAGENT: claude-codex:root-cause-analyst (model: opus)\nINPUT: Bug description from conversation context\nOUTPUT: .task/rca-opus.json\nPROMPT MUST INCLUDE: Full bug description, 'You are analyzing as Opus. Write output to .task/rca-opus.json. Set reviewer field to opus.'\nCOMPLETION: .task/rca-opus.json exists with root_cause.summary and root_cause.root_file populated"
)

T3 = TaskCreate(
  subject: "RCA + Plan Validation - Codex",
  activeForm: "Validating RCA and plan (Codex)...",
  description: "PHASE: RCA + Plan Validation (Codex gate)\nAGENT: claude-codex:codex-reviewer (external — do NOT pass model parameter)\nINPUT: .task/rca-sonnet.json, .task/rca-opus.json, .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/review-codex.json\nNOTE: Codex validates the consolidated RCA diagnosis and fix plan. Challenges whether root cause is correct, plan is sound, nothing missed.\nRESULT HANDLING: if rejected → ask user to re-examine bug or provide more context\nCOMPLETION: .task/review-codex.json exists with status field"
)

T4 = TaskCreate(
  subject: "Implementation",
  activeForm: "Implementing fix...",
  description: "PHASE: Implementation\nAGENT: claude-codex:implementer (model: sonnet)\nINPUT: .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/impl-result.json\nPROMPT MUST INCLUDE: Reference to approved plan and all acceptance criteria. This is a bug fix — make the smallest possible change that addresses the root cause.\nNOTE: Implementer creates its own subtasks internally.\nRESULT HANDLING: Read .task/impl-result.json → check status (complete/partial/failed)\nCOMPLETION: .task/impl-result.json exists with status='complete'"
)

T5 = TaskCreate(
  subject: "Code Review - Sonnet",
  activeForm: "Reviewing code (Sonnet)...",
  description: "PHASE: Code Review (first reviewer)\nAGENT: claude-codex:code-reviewer (model: sonnet)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-sonnet.json\nPROMPT MUST INCLUDE: 'You are reviewing as Sonnet. Write output to .task/code-review-sonnet.json.'\nRESULT HANDLING: Read .task/code-review-sonnet.json → check status → handle per Result Handling rules\nCOMPLETION: .task/code-review-sonnet.json exists with status and acceptance_criteria_verification fields"
)

T6 = TaskCreate(
  subject: "Code Review - Opus",
  activeForm: "Reviewing code (Opus)...",
  description: "PHASE: Code Review (second reviewer)\nAGENT: claude-codex:code-reviewer (model: opus)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-opus.json\nPROMPT MUST INCLUDE: 'You are reviewing as Opus. Write output to .task/code-review-opus.json.'\nRESULT HANDLING: Read .task/code-review-opus.json → check status → handle per Result Handling rules\nCOMPLETION: .task/code-review-opus.json exists with status and acceptance_criteria_verification fields"
)

T7 = TaskCreate(
  subject: "Code Review - Codex",
  activeForm: "Reviewing code (Codex)...",
  description: "PHASE: Code Review (final gate)\nAGENT: claude-codex:codex-reviewer (external — do NOT pass model parameter)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-codex.json\nNOTE: Codex reviewer is a thin wrapper — runs codex-review.ts. Do NOT pass model parameter.\nRESULT HANDLING: if rejected → terminal state code_rejected (ask user)\nCOMPLETION: .task/code-review-codex.json exists with status field"
)

// T1 and T2 are parallel — no blockedBy
// T3 blocks on BOTH T1 and T2
TaskUpdate(T3.id, addBlockedBy: [T1.id, T2.id])
TaskUpdate(T4.id, addBlockedBy: [T3.id])
TaskUpdate(T5.id, addBlockedBy: [T4.id])
TaskUpdate(T6.id, addBlockedBy: [T5.id])
TaskUpdate(T7.id, addBlockedBy: [T6.id])
```

Save to `.task/pipeline-tasks.json` using the **actual returned IDs**:
```json
{
  "team_name": "pipeline-myproject-a1b2c3",
  "pipeline_type": "bug-fix",
  "rca_sonnet": "4",
  "rca_opus": "5",
  "rca_plan_validation": "6",
  "implementation": "7",
  "code_review_sonnet": "8",
  "code_review_opus": "9",
  "code_review_codex": "10"
}
```

**Verify:** After creating all tasks, call `TaskList()`. You should see 7 tasks: T1 and T2 with status `pending` and empty `blockedBy`, T3-T7 with `blockedBy` referencing correct predecessors.

---

## Main Loop

Execute this data-driven loop until all tasks are completed:

```
while pipeline not complete:
    1. Call TaskList() — returns array of all tasks with current status and blockedBy
    2. Find the next task(s) where: status == "pending" AND all blockedBy tasks have status == "completed"
       - SPECIAL: T1 and T2 can BOTH be ready simultaneously (parallel RCA)
       - If both T1 and T2 are ready, spawn BOTH in parallel using two Task() calls
       - If no such task exists and tasks remain, check for consolidation step (see below)
    3. Call TaskGet(task.id) — read full description with AGENT, MODEL, INPUT, OUTPUT
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task using description as execution context:
       - Parse AGENT, MODEL, INPUT, OUTPUT from description
       - If AGENT contains "external" or "do NOT pass model": spawn via Task() WITHOUT model parameter
       - Otherwise: spawn via Task() with model from description
    6. Check output file (from description's OUTPUT field) for result
    7. Handle result (see Result Handling below)
    8. SPECIAL CONSOLIDATION CHECK: After marking T1 and T2 completed, BEFORE proceeding to T3:
       - Execute the Orchestrator Consolidation step (see below)
       - This writes user-story.json and plan-refined.json
       - Only then proceed to T3
    9. Enrich next task (BEFORE marking completed):
       - Read output file, extract key context per Progressive Enrichment table
       - Find next task via TaskList(), find the task whose blockedBy includes current task ID
       - Call TaskUpdate(next_task_id, description: <enriched>) per Enrichment Update Rule
       - Enrichment is best-effort — failure does not block the pipeline
   10. Call TaskUpdate(task.id, status: "completed")
```

**IMPORTANT:** Steps 1, 3, 4, 9, and 10 are **TaskList, TaskGet, and TaskUpdate tool calls**, not file reads or Bash commands.

### Parallel RCA Spawning

When both T1 and T2 are available (both pending, no blockedBy), spawn them simultaneously:

```
// Mark both in_progress
TaskUpdate(T1.id, status: "in_progress")
TaskUpdate(T2.id, status: "in_progress")

// Spawn both in parallel (two Task() calls in the same message)
Task(
  subagent_type: "claude-codex:root-cause-analyst",
  model: "sonnet",
  prompt: "[Bug description] You are analyzing as Sonnet. Write output to .task/rca-sonnet.json. Set reviewer to sonnet."
)
Task(
  subagent_type: "claude-codex:root-cause-analyst",
  model: "opus",
  prompt: "[Bug description] You are analyzing as Opus. Write output to .task/rca-opus.json. Set reviewer to opus."
)
```

After both return, proceed to consolidation.

---

## Orchestrator Consolidation (Between T2 Completion and T3 Start)

**This is the key differentiator from `/multi-ai`.** The orchestrator does this work itself — it is NOT a task, NOT delegated to an agent.

When both T1 and T2 are completed (detected via TaskList), the orchestrator:

### Step 1: Read Both RCA Outputs

```
Read(".task/rca-sonnet.json")
Read(".task/rca-opus.json")
```

### Step 2: Consolidate Findings

**If both agree on root cause** (same file, same general diagnosis):
- Use the shared diagnosis — high confidence
- Take the more detailed explanation
- Merge affected files, fix constraints, and impact analysis from both

**If they disagree** (different root files, different categories):
- Present both diagnoses to the user via AskUserQuestion:
  ```
  AskUserQuestion:
    "The two RCA analyses disagree on the root cause:

    Sonnet says: [summary] in [file]:[line]
    Opus says: [summary] in [file]:[line]

    Which diagnosis is more likely correct?"
    Option 1: "Sonnet's diagnosis"
    Option 2: "Opus's diagnosis"
    Option 3: "Both may be contributing factors"
  ```
- Use the user's chosen diagnosis to proceed
- If "both contributing", merge both into the fix plan

### Step 3: Write user-story.json

Write `.task/user-story.json` with bug-fix acceptance criteria:

```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title from RCA]",
  "pipeline_type": "bug-fix",
  "requirements": {
    "root_cause": "[Consolidated root cause summary]",
    "root_file": "[path/to/file.ts]",
    "root_line": 42
  },
  "acceptance_criteria": [
    { "id": "AC1", "description": "Bug is resolved — expected behavior is restored" },
    { "id": "AC2", "description": "Regression test covers the exact bug scenario" },
    { "id": "AC3", "description": "No existing tests are broken by the fix" },
    { "id": "AC4", "description": "Root cause is addressed, not just symptoms patched" }
  ],
  "scope": {
    "affected_files": ["[merged from both RCAs]"],
    "blast_radius": "[from RCA impact analysis]",
    "fix_constraints": {
      "must_preserve": ["[merged from both RCAs]"],
      "safe_to_change": ["[merged from both RCAs]"]
    }
  },
  "implementation": { "max_iterations": 10 }
}
```

**Additional ACs:** Add specific ACs from the RCA findings if warranted (e.g., "AC5: Input validation added for [specific case]").

### Step 4: Write plan-refined.json

Write `.task/plan-refined.json` with a minimal fix plan:

```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: [Bug title]",
  "pipeline_type": "bug-fix",
  "technical_approach": {
    "root_cause": "[Consolidated root cause]",
    "fix_strategy": "[From recommended_approach of chosen RCA]",
    "complexity": "[From estimated_complexity]"
  },
  "steps": [
    {
      "description": "Write regression test that reproduces the bug (must fail before fix)",
      "files": ["path/to/test-file.ts"]
    },
    {
      "description": "Apply minimal fix to [root_file] at line [root_line]: [specific change]",
      "files": ["path/to/root-file.ts"]
    },
    {
      "description": "Verify regression test passes and all existing tests still pass",
      "files": []
    }
  ],
  "test_plan": {
    "commands": ["npm test", "npm run lint"],
    "regression_test": "Description of the specific regression test to write",
    "success_pattern": "All tests pass",
    "failure_pattern": "FAIL|ERROR"
  },
  "risk_assessment": {
    "blast_radius": "[from RCA]",
    "regression_risk": "[from RCA]",
    "mitigation": "Regression test ensures the exact bug scenario is covered"
  },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

**Key principle:** The fix plan should be the **smallest possible change** that addresses the root cause. No refactoring, no improvements, no cleanup beyond the fix itself.

### Step 5: Proceed to T3

After writing both files, the consolidation is complete. T3 (Codex validation) is now unblocked (T1 and T2 are completed). Continue the main loop.

---

## Progressive Enrichment

Before marking each task completed, read its output file, extract key context (≤ 500 chars), and update the next task's description via TaskUpdate.

**Enrichment Update Rule:** Read the next task's current description via TaskGet(). If it already contains a "CONTEXT FROM PRIOR TASK:" block, *replace* that block. If not, *append*. Each task only ever has one context block.

| Completed Task | Enrich | Extract From Output |
|---------------|--------|---------------------|
| T1 RCA Sonnet | T3 Codex Validation | root cause summary, confidence, affected files |
| T2 RCA Opus | T3 Codex Validation | root cause summary, confidence, affected files |
| T3 Codex Validation | T4 Implementation | validation status, concerns, AC count |
| T4 Implementation | T5 Code Review Sonnet | files modified/created, test results |
| T5 Review Sonnet | T6 Review Opus | status, findings, AC verified/total |
| T6 Review Opus | T7 Review Codex | status, findings, + Sonnet status |

**Note on T1/T2 → T3:** Both T1 and T2 enrich T3. The second enrichment appends to the first (since T3 won't have been started yet). Use separate `CONTEXT FROM RCA SONNET:` and `CONTEXT FROM RCA OPUS:` blocks for clarity.

---

## Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Create fix task + re-review task for SAME reviewer |
| `rejected` (Codex RCA validation) | Ask user to provide more context or re-examine the bug |
| `rejected` (Codex code review) | Terminal state `code_rejected` - ask user |
| `rejected` (Sonnet/Opus code review) | Create REWORK task + re-review for SAME reviewer |
| `needs_clarification` | Read `clarification_questions`, answer directly if possible, otherwise use AskUserQuestion. After clarification, re-run SAME reviewer. |
| Codex error (not installed/auth/timeout) | AskUserQuestion: "Codex CLI unavailable: {error}. Skip Codex gate or install?" |

**Implementation results:**

| Result | Action |
|--------|--------|
| `complete` | Continue to code review |
| `partial` | Continue implementation (resume implementer agent) |
| `partial` + true blocker | Ask user |
| `failed` | Terminal state `implementation_failed` - ask user |

**Severity:**
- `needs_changes` = minor issues, fixable
- `rejected` = fundamental problems, requires rework or user decision
- `failed` = blocked, requires user intervention

---

## Dynamic Tasks (Same-Reviewer Re-Review)

When a review returns `needs_changes` or `rejected`, the **same reviewer** must validate before proceeding.

**Exception:** Codex RCA validation `rejected` is NOT a terminal pipeline state — ask the user for more bug context and potentially re-run RCA. Codex code `rejected` IS terminal.

### needs_changes → Fix Task

**Key rules:**
- Use `current_task_id` from the main loop (the review that just completed), NOT the base ID from pipeline-tasks.json.
- Track `iteration_count` per reviewer via TaskList.
- **Final reviewer (Codex) has no next_reviewer_id** — skip the `TaskUpdate(next_reviewer_id, ...)` call.

```
Any reviewer returns needs_changes:
  issues = read review_file → extract blockers + critical/high findings (≤ 500 chars)

  fix = TaskCreate(
    subject: "Fix [Phase] - [Reviewer] v{iteration}",
    activeForm: "Fixing [phase] issues...",
    description: "PHASE: Fix {phase} issues from {reviewer} review\n\
AGENT: claude-codex:implementer (model: sonnet)\n\
INPUT: {review_file} (issues to fix), {source_file} (current artifact)\n\
OUTPUT: {source_file} (updated)\n\
ISSUES TO FIX:\n{issues summary}\n\
COMPLETION: All critical/high issues from {reviewer} review addressed"
  )
  TaskUpdate(fix.id, addBlockedBy: [current_task_id])

  rerev = TaskCreate(
    subject: "[Phase] Review - [Reviewer] v{iteration+1}",
    activeForm: "Re-reviewing [phase]...",
    description: "PHASE: {Phase} Re-review (iteration {iteration+1})\n\
AGENT: claude-codex:{code-reviewer} (model: {model})\n\
INPUT: {same INPUT files as original review task}\n\
OUTPUT: {same OUTPUT file as original review — overwrite}\n\
NOTE: Re-review after fix. Same reviewer, same output file.\n\
RESULT HANDLING: Same as original review task\n\
COMPLETION: {output_file} exists with updated status"
  )
  TaskUpdate(rerev.id, addBlockedBy: [fix.id])
  if next_reviewer_id is not null:
    TaskUpdate(next_reviewer_id, addBlockedBy: [rerev.id])
```

### rejected → Rework Task (Sonnet/Opus Code Reviews Only)

```
Sonnet or Opus code reviewer returns rejected:
  issues = read review file → extract rejection reasons (≤ 500 chars)

  rework = TaskCreate(
    subject: "Rework Code - [Reviewer] v{iteration}",
    activeForm: "Reworking code...",
    description: "PHASE: Rework code — {reviewer} rejected\n\
AGENT: claude-codex:implementer (model: sonnet)\n\
INPUT: {review_file}, .task/user-story.json, .task/plan-refined.json\n\
OUTPUT: .task/impl-result.json (updated)\n\
REJECTION REASONS:\n{issues summary}\n\
COMPLETION: .task/impl-result.json updated with status='complete'"
  )
  TaskUpdate(rework.id, addBlockedBy: [current_task_id])

  rerev = TaskCreate(
    subject: "Code Review - [Reviewer] v{iteration+1}",
    activeForm: "Re-reviewing code...",
    description: "PHASE: Code Re-review (iteration {iteration+1})\n\
AGENT: claude-codex:code-reviewer (model: {model})\n\
INPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\n\
OUTPUT: .task/code-review-{reviewer}.json\n\
NOTE: Re-review after rework. Same reviewer validates fixes.\n\
RESULT HANDLING: Same as original code review task\n\
COMPLETION: .task/code-review-{reviewer}.json exists with updated status"
  )
  TaskUpdate(rerev.id, addBlockedBy: [rework.id])
  if next_reviewer_id is not null:
    TaskUpdate(next_reviewer_id, addBlockedBy: [rerev.id])
```

### rejected → Terminal (Codex Code Review)

```
Codex code review returns rejected:
  → Terminal state: code_rejected
  → Ask user: rework, restart from RCA, or abort
```

### Iteration Tracking

Derive iteration count from TaskList (count existing matching tasks). After **10 re-reviews** for any single reviewer, escalate to user.

---

## Agent Reference

| Task | Agent | Model | Output File |
|------|-------|-------|-------------|
| RCA - Sonnet | root-cause-analyst | sonnet | rca-sonnet.json |
| RCA - Opus | root-cause-analyst | opus | rca-opus.json |
| RCA + Plan Validation | codex-reviewer | external | review-codex.json |
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

If user adds context mid-pipeline:

1. **During RCA:** Relay additional context to running RCA agents if possible
2. **During consolidation:** Incorporate into diagnosis
3. **After implementation started:** Ask user if they want to continue or restart from RCA

### Suggesting Restart

When significant issues arise:

```
AskUserQuestion:
  "The bug fix has fundamental issues. Options:"
  1. "Restart from RCA" - Re-analyze the bug
  2. "Revise fix plan" - Keep RCA, re-plan fix
  3. "Continue anyway" - Proceed with current approach
```

---

## Hook Behavior

### UserPromptSubmit Hook (Guidance)

The `guidance-hook.ts` runs on every prompt and:

1. **Reads artifact files** — Checks `.task/*.json` to determine current phase
2. **Injects guidance** — Reminds you what to do next (detects RCA phase via `rca-*.json` files)
3. **No state tracking** — Phase is implicit from which files exist

### SubagentStop Hook (Enforcement)

The `review-validator.ts` runs when reviewer agents finish and:

1. **Validates AC coverage** — Checks `acceptance_criteria_verification` (code reviews)
2. **Blocks invalid reviews** — Returns `{"decision": "block", "reason": "..."}` if review doesn't verify all ACs
3. **Allows valid reviews** — Proceeds normally when validation passes

---

## Output File Formats

### user-story.json (Bug-Fix)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Fix: Bug title",
  "pipeline_type": "bug-fix",
  "requirements": {
    "root_cause": "Consolidated root cause summary",
    "root_file": "path/to/file.ts",
    "root_line": 42
  },
  "acceptance_criteria": [
    { "id": "AC1", "description": "Bug is resolved — expected behavior restored" },
    { "id": "AC2", "description": "Regression test covers the bug scenario" },
    { "id": "AC3", "description": "No existing tests broken" },
    { "id": "AC4", "description": "Root cause addressed, not just symptoms" }
  ],
  "scope": { "affected_files": [], "blast_radius": "isolated|module|cross-module" },
  "implementation": { "max_iterations": 10 }
}
```

### plan-refined.json (Bug-Fix)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Fix: Bug title",
  "pipeline_type": "bug-fix",
  "technical_approach": { "root_cause": "...", "fix_strategy": "...", "complexity": "..." },
  "steps": [
    { "description": "Write regression test", "files": [] },
    { "description": "Apply minimal fix", "files": [] },
    { "description": "Verify all tests pass", "files": [] }
  ],
  "test_plan": { "commands": [], "regression_test": "...", "success_pattern": "...", "failure_pattern": "..." },
  "risk_assessment": { "blast_radius": "...", "regression_risk": "...", "mitigation": "..." },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

### rca-*.json
```json
{
  "id": "rca-YYYYMMDD-HHMMSS",
  "reviewer": "sonnet|opus",
  "bug_report": { "title": "...", "reported_behavior": "...", "expected_behavior": "...", "reproduction_steps": [], "reproduction_result": "pass|fail|inconclusive", "reproduction_output": "..." },
  "root_cause": { "summary": "...", "detailed_explanation": "...", "category": "...", "root_file": "...", "root_line": 0, "confidence": "high|medium|low" },
  "impact_analysis": { "affected_files": [], "affected_functions": [], "blast_radius": "...", "regression_risk": "..." },
  "fix_constraints": { "must_preserve": [], "safe_to_change": [], "existing_tests": [] },
  "recommended_approach": { "strategy": "...", "estimated_complexity": "..." }
}
```

### code-review-*.json
```json
{
  "status": "approved|needs_changes|needs_clarification|rejected",
  "needs_clarification": false,
  "clarification_questions": [],
  "summary": "...",
  "acceptance_criteria_verification": {
    "total": 4,
    "verified": 4,
    "missing": [],
    "details": [
      { "ac_id": "AC1", "status": "IMPLEMENTED", "evidence": "...", "notes": "" }
    ]
  }
}
```

### impl-result.json
```json
{
  "status": "complete|partial|failed",
  "files_changed": [],
  "blocked_reason": "..."
}
```

---

## Terminal States

| State | Meaning | Action |
|-------|---------|--------|
| `complete` | All reviews approved | Report success |
| `max_iterations_reached` | 10+ fix iterations | Escalate to user |
| `code_rejected` | Codex rejected code | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Pipeline Completion

When all reviews are approved (or a terminal state is reached):

1. Report results to the user
2. Read `team_name` from `.task/pipeline-tasks.json` and use `TeamDelete` to clean up
3. Pipeline team cleanup is best-effort — if TeamDelete fails, the next pipeline run's idempotent Step 1.5 will handle it

---

## Important Rules

1. **Pipeline team first, then task chain** — After reset, create the pipeline team (Step 1.5), verify task tools (Step 1.6), then create the full 7-task chain. No agents are spawned before the task chain exists.
2. **Tasks are primary** — Create tasks with `blockedBy` for structural enforcement
3. **Parallel RCA** — T1 and T2 have no blockedBy — spawn both simultaneously
4. **Orchestrator consolidation** — The orchestrator (main thread) reads both RCA outputs, consolidates, and writes user-story.json + plan-refined.json directly. This is NOT a task.
5. **No pipeline-tasks.json for task IDs beyond tracking** — This pipeline does NOT use `pipeline-tasks.json` for phase detection. Task IDs are tracked via TaskList().
6. **SubagentStop enforces** — Hook validates reviewer outputs and can block
7. **AC verification required** — All code reviews MUST verify acceptance criteria from user-story.json
8. **Same-reviewer re-review** — After fix/rework, SAME reviewer validates before next
9. **Codex is mandatory** — Pipeline NOT complete without Codex approval (both RCA validation and code review)
10. **Max 10 iterations** — Per reviewer, then escalate to user
11. **Accept all feedback** — No debate with reviewers, just fix
12. **User can interrupt** — Handle additional input, offer restart/kick back
13. **Task descriptions are execution context** — Every TaskCreate includes AGENT, MODEL, INPUT, OUTPUT. Main loop calls TaskGet() before spawning. Never derive execution context from hardcoded prose.
14. **Progressive enrichment before completion** — Before marking a task completed, read output, extract key context (≤ 500 chars), and TaskUpdate the next task. Best-effort.
15. **Minimal fix principle** — The fix should be the smallest possible change that addresses the root cause. No refactoring, no improvements, no cleanup beyond the fix.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset`
4. **Check pipeline team:** Read `team_name` from `.task/pipeline-tasks.json`, verify team exists
