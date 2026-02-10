---
name: multi-ai
description: Start the multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Codex final gate.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete, SendMessage
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

## Specialist Catalog (Team-Based Requirements)

The orchestrator spawns specialist teammates for parallel exploration during requirements gathering.

| Specialist | Spawn When | Focus | Output File |
|-----------|-----------|-------|-------------|
| **Technical Analyst** | Always | Existing code, patterns, constraints, dependencies, files to change | `.task/analysis-technical.json` |
| **UX/Domain Analyst** | Always | User workflows, edge cases, industry patterns, accessibility | `.task/analysis-ux-domain.json` |
| **Security Analyst** | Always | OWASP relevance, threat model, non-functional requirements | `.task/analysis-security.json` |
| **Performance Analyst** | Always | Load impact, scalability, resource usage, bottlenecks, caching | `.task/analysis-performance.json` |
| **Architecture Analyst** | Always | Design patterns, SOLID principles, code organization, maintainability, best practices | `.task/analysis-architecture.json` |

All 5 core specialists are **always spawned** for every request. This ensures comprehensive coverage from multiple expert perspectives.

Beyond the 5 core specialists, the AI may spawn **additional specialists** if the request warrants deeper exploration in a specific domain (e.g., a Data Analyst for migration tasks, an Accessibility Analyst for UI-heavy features, a Compliance Analyst for regulatory work).

Additional specialists should write their analysis to `.task/analysis-<type>.json` following the same output format.

### Specialist Analysis Output Format

Each specialist writes a structured JSON file to `.task/`:

```json
{
  "specialist": "technical|ux-domain|security|performance|architecture",
  "summary": "Brief summary of findings",
  "findings": [
    {
      "category": "Finding category",
      "detail": "Detailed finding",
      "relevance": "How this affects requirements",
      "files": ["relevant/file/paths"]
    }
  ],
  "recommendations": ["Actionable recommendations for requirements"],
  "constraints": ["Constraints discovered during analysis"],
  "questions_for_user": ["Questions the user should answer"]
}
```

---

## Pipeline Initialization

**CRITICAL: No phase skipping.** Every pipeline run starts from scratch with a full reset. Even if the user has an existing plan, approved design doc, or prior conversation context — the pipeline ALWAYS executes all phases in order: Requirements (team-based) → Planning → Reviews → Implementation → Code Reviews. Pre-existing plans or context from plan mode are **input to the specialists**, not a substitute for the pipeline. Never directly create a user-story.json from an existing plan — always run the team-based requirements gathering phase first.

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

**Example:** Project at `/home/user/vibe-pipe`:
- Basename: `vibe-pipe` (already clean)
- Canonicalized path: `/home/user/vibe-pipe`
- Hash: `sha256("/home/user/vibe-pipe")` → first 6 chars = `a1b2c3`
- Team name: `pipeline-vibe-pipe-a1b2c3`

**Idempotent startup:** Always attempt `TeamDelete` first (ignore errors), then create fresh:

```
TeamDelete(team_name: "pipeline-{BASENAME}-{HASH}")   ← ignore errors (team may not exist)
TeamCreate(team_name: "pipeline-{BASENAME}-{HASH}", description: "Pipeline orchestration and task management")
```

Store the computed team name in `.task/pipeline-tasks.json` as the `team_name` field.

This team persists for the entire pipeline lifecycle. Requirements specialists join this team as teammates. The team is only deleted at pipeline completion.

**Concurrency:** The hash ensures different projects (even with same basename) get unique teams. **Same-project concurrent runs are still unsupported** — two runs in the same project would race on the idempotent `TeamDelete` at startup.

### Step 1.6: Verify Task Tools Available

After creating the team, call the **TaskList tool** directly (do NOT use Bash or Task agents):

```
result = TaskList()
```

`TaskList` takes no parameters.

**Success:** TaskList() returns an empty array `[]`. Proceed to Step 2.
**Stale tasks detected:** TaskList() returns a non-empty list — stale tasks from a crashed/abandoned run survived the TeamDelete+TeamCreate cycle. Stop and report to user. Do NOT proceed with stale tasks as they will break ordering.
**Tool error:** TaskList() fails or returns an error. Stop and report to user.

**IMPORTANT:** Do NOT substitute `echo`, `Bash`, or any other tool for `TaskList()`. You must call the actual `TaskList` tool.

### Step 2: Create Task Chain

**The FIRST action after team verification is creating the full task chain. No agents are spawned before the task chain exists.**

**CRITICAL: Call the TaskCreate and TaskUpdate tools directly.** Do NOT use Bash, Task (subagent), Write, or any other tool as a substitute. TaskCreate and TaskUpdate are real tools available after TeamCreate.

**TaskCreate API:**
- Parameters: `subject` (required string), `description` (optional string), `activeForm` (optional string — present continuous form for display)
- Returns: task object with `id` field (a string like `"4"`, `"5"`, etc.)
- **TaskCreate does NOT accept `blockedBy`.** Set dependencies via TaskUpdate after creation.

**TaskUpdate API:**
- Parameters: `id` (required), `status` (optional: "pending"/"in_progress"/"completed"), `description` (optional: string — replace task description), `addBlockedBy` (optional: array of task ID strings)

Create all 9 tasks, then chain them with addBlockedBy:

```
T1 = TaskCreate(
  subject: "Gather requirements",
  activeForm: "Gathering requirements...",
  description: "PHASE: Requirements Gathering (team-based)\nAGENT: Special — spawn 5+ specialist teammates (subagent_type: general-purpose, model: opus) into pipeline team, then synthesize via requirements-gatherer (subagent_type: claude-codex:requirements-gatherer, model: opus)\nINPUT: User's initial request (from conversation context)\nOUTPUT: .task/user-story.json\nPROCEDURE: 1) Spawn all 5 core specialists as teammates 2) Interactive loop: receive specialist messages, AskUserQuestion, relay answers 3) Wait for all analysis files 4) Spawn requirements-gatherer in synthesis mode (one-shot Task) 5) shutdown_request to ALL specialists, wait for confirmations 6) Only then mark completed\nNOTE: Synthesis step is interactive — requirements-gatherer will AskUserQuestion to validate scope/assumptions and get explicit user approval before finalizing.\nCOMPLETION: .task/user-story.json exists with acceptance_criteria array"
)

T2 = TaskCreate(
  subject: "Create implementation plan",
  activeForm: "Creating implementation plan...",
  description: "PHASE: Planning\nAGENT: claude-codex:planner (model: opus)\nINPUT: .task/user-story.json\nOUTPUT: .task/plan-refined.json\nPROMPT MUST INCLUDE: Full user story context — title, all acceptance criteria IDs and descriptions, scope, constraints\nCOMPLETION: .task/plan-refined.json exists with steps array, test_plan, and completion_promise"
)

T3 = TaskCreate(
  subject: "Plan Review - Sonnet",
  activeForm: "Reviewing plan (Sonnet)...",
  description: "PHASE: Plan Review (first reviewer)\nAGENT: claude-codex:plan-reviewer (model: sonnet)\nINPUT: .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/review-sonnet.json\nPROMPT MUST INCLUDE: 'You are reviewing as Sonnet. Write output to .task/review-sonnet.json.'\nRESULT HANDLING: Read .task/review-sonnet.json → check status → handle per Result Handling rules\nCOMPLETION: .task/review-sonnet.json exists with status and requirements_coverage fields"
)

T4 = TaskCreate(
  subject: "Plan Review - Opus",
  activeForm: "Reviewing plan (Opus)...",
  description: "PHASE: Plan Review (second reviewer)\nAGENT: claude-codex:plan-reviewer (model: opus)\nINPUT: .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/review-opus.json\nPROMPT MUST INCLUDE: 'You are reviewing as Opus. Write output to .task/review-opus.json.'\nRESULT HANDLING: Read .task/review-opus.json → check status → handle per Result Handling rules\nCOMPLETION: .task/review-opus.json exists with status and requirements_coverage fields"
)

T5 = TaskCreate(
  subject: "Plan Review - Codex",
  activeForm: "Reviewing plan (Codex)...",
  description: "PHASE: Plan Review (final gate)\nAGENT: claude-codex:codex-reviewer (external — do NOT pass model parameter)\nINPUT: .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/review-codex.json\nNOTE: Codex reviewer is a thin wrapper — runs codex-review.ts. Do NOT pass model parameter.\nRESULT HANDLING: if rejected → terminal state plan_rejected (ask user)\nCOMPLETION: .task/review-codex.json exists with status field"
)

T6 = TaskCreate(
  subject: "Implementation",
  activeForm: "Implementing...",
  description: "PHASE: Implementation\nAGENT: claude-codex:implementer (model: sonnet)\nINPUT: .task/user-story.json, .task/plan-refined.json\nOUTPUT: .task/impl-result.json\nPROMPT MUST INCLUDE: Reference to approved plan and all acceptance criteria\nNOTE: Implementer creates its own subtasks internally. It uses its own TaskGet()-driven execution loop.\nRESULT HANDLING: Read .task/impl-result.json → check status (complete/partial/failed)\nCOMPLETION: .task/impl-result.json exists with status='complete'"
)

T7 = TaskCreate(
  subject: "Code Review - Sonnet",
  activeForm: "Reviewing code (Sonnet)...",
  description: "PHASE: Code Review (first reviewer)\nAGENT: claude-codex:code-reviewer (model: sonnet)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-sonnet.json\nPROMPT MUST INCLUDE: 'You are reviewing as Sonnet. Write output to .task/code-review-sonnet.json.'\nRESULT HANDLING: Read .task/code-review-sonnet.json → check status → handle per Result Handling rules\nCOMPLETION: .task/code-review-sonnet.json exists with status and acceptance_criteria_verification fields"
)

T8 = TaskCreate(
  subject: "Code Review - Opus",
  activeForm: "Reviewing code (Opus)...",
  description: "PHASE: Code Review (second reviewer)\nAGENT: claude-codex:code-reviewer (model: opus)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-opus.json\nPROMPT MUST INCLUDE: 'You are reviewing as Opus. Write output to .task/code-review-opus.json.'\nRESULT HANDLING: Read .task/code-review-opus.json → check status → handle per Result Handling rules\nCOMPLETION: .task/code-review-opus.json exists with status and acceptance_criteria_verification fields"
)

T9 = TaskCreate(
  subject: "Code Review - Codex",
  activeForm: "Reviewing code (Codex)...",
  description: "PHASE: Code Review (final gate)\nAGENT: claude-codex:codex-reviewer (external — do NOT pass model parameter)\nINPUT: .task/user-story.json, .task/plan-refined.json, .task/impl-result.json\nOUTPUT: .task/code-review-codex.json\nNOTE: Codex reviewer is a thin wrapper — runs codex-review.ts. Do NOT pass model parameter.\nRESULT HANDLING: if rejected → terminal state code_rejected (ask user)\nCOMPLETION: .task/code-review-codex.json exists with status field"
)

// Now set blockedBy dependencies using the RETURNED IDs:
TaskUpdate(T2.id, addBlockedBy: [T1.id])
TaskUpdate(T3.id, addBlockedBy: [T2.id])
TaskUpdate(T4.id, addBlockedBy: [T3.id])
TaskUpdate(T5.id, addBlockedBy: [T4.id])
TaskUpdate(T6.id, addBlockedBy: [T5.id])
TaskUpdate(T7.id, addBlockedBy: [T6.id])
TaskUpdate(T8.id, addBlockedBy: [T7.id])
TaskUpdate(T9.id, addBlockedBy: [T8.id])
```

Each `TaskCreate` call returns a task object. Extract the `id` field from each return value and use those real IDs in the `addBlockedBy` arrays.

Save to `.task/pipeline-tasks.json` using the **actual returned IDs** (not placeholder strings):
```json
{
  "team_name": "pipeline-vibe-pipe-a1b2c3",
  "requirements": "4",
  "plan": "5",
  "plan_review_sonnet": "6",
  "plan_review_opus": "7",
  "plan_review_codex": "8",
  "implementation": "9",
  "code_review_sonnet": "10",
  "code_review_opus": "11",
  "code_review_codex": "12"
}
```

**Partial failure:** If any TaskCreate or TaskUpdate call fails mid-chain (returns an error or no `id`), stop immediately. Report the error to the user. The next pipeline run's idempotent Step 1.5 (TeamDelete + TeamCreate) will clean up the partial state.

**Verify:** After creating all tasks, call `TaskList()`. You should see 9 tasks: T1 with status `pending` and empty `blockedBy`, T2-T9 with `blockedBy` referencing the correct predecessor. If the count or chain is wrong, stop and report.

---

## Main Loop

Execute this data-driven loop until all tasks are completed:

```
while pipeline not complete:
    1. Call TaskList() — returns array of all tasks with current status and blockedBy
    2. Find the next task where: status == "pending" AND all blockedBy tasks have status == "completed"
       (If no such task exists and tasks remain, the pipeline is stuck — report to user)
    3. Call TaskGet(task.id) — read full description with AGENT, MODEL, INPUT, OUTPUT, and any
       enrichment context added after previous task completed
    4. Call TaskUpdate(task.id, status: "in_progress")
    5. Execute task using description as execution context:
       - Parse AGENT, MODEL, INPUT, OUTPUT from description
       - If AGENT contains "external" or "do NOT pass model": spawn via Task() WITHOUT model parameter
       - Otherwise: spawn via Task() with model from description
    6. Check output file (from description's OUTPUT field) for result
    7. Handle result (see Result Handling below)
    8. Enrich next task (BEFORE marking completed):
       - Read output file, extract key context per Progressive Enrichment table
       - Find next task: call TaskList(), find the task whose blockedBy includes the current
         task's ID and is still "pending". This works for both base tasks (T1-T9) and dynamically
         created fix/rework/re-review tasks.
       - Call TaskGet(next_task_id) to read its current description
       - Call TaskUpdate(next_task_id, description: <see Enrichment Update Rule below>)
       - If enrichment fails (no next task, or TaskUpdate error), log and continue — enrichment
         is best-effort, the next task's base description is always sufficient to execute standalone
    9. Call TaskUpdate(task.id, status: "completed")
    # Note: SubagentStop hook validates reviewer outputs and can block if invalid
```

**IMPORTANT:** Steps 1, 3, 4, 8, and 9 are **TaskList, TaskGet, and TaskUpdate tool calls**, not file reads or Bash commands. The task state lives in `~/.claude/tasks/{team_name}/`, managed entirely by these tools.

### Progressive Enrichment

Before marking each task completed (step 8 of main loop), read its output file, extract key
context, and update the next task's description via TaskUpdate.

**Enrichment Update Rule (canonical):** Read the next task's current description via TaskGet().
If it already contains a "CONTEXT FROM PRIOR TASK:" block, *replace* that block with the new
one. If it does not, *append* the new block. This means each task only ever has one context
block — the most recent — preventing unbounded growth over fix iterations.

Enrichment is best-effort: if it fails (no next task, TaskUpdate error), log and continue.
The next task's base description is always sufficient to execute standalone.

**Size cap:** Each CONTEXT FROM PRIOR TASK block must be ≤ 500 characters. Summarize — do not
paste raw JSON.

| Completed Task | Enrich | Extract From Output |
|---------------|--------|---------------------|
| T1 Requirements | T2 Planning | title, AC count + IDs, key requirements, constraints, scope |
| T2 Planning | T3 Plan Review Sonnet | title, step count, pattern, file counts |
| T3 Review Sonnet | T4 Review Opus | status, summary, score, finding counts, missing coverage |
| T4 Review Opus | T5 Review Codex | status, summary, score, findings, + Sonnet status |
| T5 Review Codex | T6 Implementation | status, summary, + all prior review statuses |
| T6 Implementation | T7 Code Review Sonnet | status, files modified/created, test results, deviation count |
| T7 Review Sonnet | T8 Review Opus | status, summary, score, AC verified/total, findings |
| T8 Review Opus | T9 Review Codex | status, summary, score, AC verified/total, + Sonnet status |

### Phase Cleanup Gate

**CRITICAL: Specialist shutdown is REQUIRED before T2 can start.**

**After synthesis completes (requirements-gatherer returns):**
1. Send `shutdown_request` to ALL specialist teammates via `SendMessage`
2. Wait for shutdown confirmations from ALL specialists
3. Verify all specialists have confirmed shutdown (check for acknowledgment messages)
4. **Only after all confirmations received:** Mark T1 (requirements task) as completed
5. Proceed to T2 (planning phase)

**Do NOT call TeamDelete** — the pipeline team persists for task management.

**Explicit rule:** Do NOT start T2 until all specialists have confirmed shutdown (or explicit user override). If any specialist fails to respond to shutdown request, escalate to user before proceeding.

Only specialist teammates are shut down after requirements. The pipeline team persists for the entire lifecycle, providing TaskCreate/TaskUpdate/TaskList access through all subsequent phases.

---

## Requirements Gathering (Team-Based, Default)

Requirements gathering uses the pipeline team's specialist teammates for parallel exploration, producing richer, more informed user stories.

**Fallback:** If specialist spawning fails, skip Steps 2-6 below and spawn the `requirements-gatherer` agent directly as a one-shot `Task()` in Standard Mode (no synthesis).

### Step 1: Analyze the Request

Read the user's initial description. Always spawn all 5 core specialists (Technical, UX/Domain, Security, Performance, Architecture). Determine if any additional specialists beyond the core 5 are needed based on the request.

### Step 2: Spawn Specialist Teammates

The pipeline team already exists (created in Step 1.5). Read `team_name` from `.task/pipeline-tasks.json` and spawn specialist teammates using `Task` with that team name and `subagent_type: "general-purpose"`. Each teammate gets a natural language prompt describing their specialist role, what to explore, and what output file to write.

```
Task(
  name: "technical-analyst",
  team_name: <team_name from .task/pipeline-tasks.json>,
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "You are a Technical Analyst. Explore the codebase for: existing implementations related to [feature], architectural patterns, constraints, dependencies, and files that would need changes. Message key findings to the lead as you discover them. When done, write your analysis to .task/analysis-technical.json using the specialist analysis format."
)
```

**Required elements in every specialist prompt:**
1. **Role** — "You are a [Type] Analyst on a requirements exploration team"
2. **Messaging** — "Use SendMessage to report key findings to the lead as you discover them. Do not wait until the end to communicate."
3. **Output file** — "Write your final analysis to .task/analysis-<type>.json using the specialist analysis format"

Always spawn all 5 core specialists. Spawn additional specialists beyond the core 5 if the request warrants it.

### Step 3: Interactive Loop

While teammates explore:
1. **Receive messages** from specialists (auto-delivered as they discover findings)
2. **Use AskUserQuestion** to ask informed questions based on specialist findings
3. **Send user answers** back to relevant specialists via `SendMessage`

This is the key advantage: the lead asks **better questions** because specialists are providing real-time codebase and domain context.

### Step 4: Wait for Completion

Wait for all spawned specialists to complete their analysis files. Monitor via messages — specialists message when done.

### Step 5: Synthesize via Requirements Gatherer

Once all specialists complete, spawn the existing requirements-gatherer agent as a **one-shot Task** (NOT a teammate):

```
Task(
  subagent_type: "claude-codex:requirements-gatherer",
  model: "opus",
  prompt: "Synthesis mode: Read ALL specialist analysis files in .task/ (any file matching analysis-*.json) and the user's answers from the interactive Q&A. Merge findings, then VALIDATE scope, assumptions, and remaining specialist questions with the user via AskUserQuestion. Get explicit user approval before writing the final user-story.json. [Include user's original request and Q&A context]"
)
```

### Step 6: Shut Down Specialist Teammates

**CRITICAL: Complete ALL steps before marking T1 complete.**

After synthesis is complete:
1. Send `shutdown_request` to ALL specialist teammates via `SendMessage`
2. Wait for shutdown confirmations from ALL specialists
3. Verify all specialists have confirmed shutdown (check for acknowledgment messages)
4. **Do NOT call TeamDelete** — the pipeline team persists for task management
5. **Only after all confirmations received:** Mark the requirements task (T1) as completed
6. Proceed to T2 (Planning phase)

**Explicit rule:** Do NOT start T2 until all specialists have confirmed shutdown (or explicit user override). If any specialist fails to respond to shutdown request, escalate to user before proceeding.

**Delegate mode tip:** When the team is active, use delegate mode (Shift+Tab) to stay focused on coordination and user questions rather than doing implementation work yourself.

---

## Result Handling

**Review results:**

| Result | Action |
|--------|--------|
| `approved` | Continue to next task |
| `needs_changes` | Create fix task + re-review task for SAME reviewer |
| `rejected` (Codex plan) | Terminal state `plan_rejected` - ask user |
| `rejected` (Codex code review) | Terminal state `code_rejected` - ask user |
| `rejected` (Sonnet/Opus code review) | Create REWORK task + re-review for SAME reviewer |
| `needs_clarification` | Read `clarification_questions`, answer directly if possible, otherwise use AskUserQuestion. After clarification, update review file and re-run SAME reviewer. |
| Codex error (not installed/auth/timeout) | AskUserQuestion: "Codex CLI unavailable: {error}. Skip Codex gate or install?" → Skip: mark task completed, proceed. Retry: re-run same task. |

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

**Key rules:**
- Use `current_task_id` from the main loop (the review that just completed), NOT the base ID from pipeline-tasks.json. On v2+, the current task is a dynamically created re-review.
- Track `iteration_count` per reviewer to generate unique subjects (v1, v2, v3...).
- **Final reviewer (Codex) has no next_reviewer_id** — skip the `TaskUpdate(next_reviewer_id, ...)` call for Codex reviews.

```
// current_task_id = from main loop step 2 (the task that returned needs_changes)
// iteration = derive from TaskList: count existing tasks matching "Fix [Phase] - [Reviewer] v*" + 1
//            (resilient to interruption — TaskList always shows actual state)
// next_reviewer_id = next reviewer from pipeline-tasks.json, OR null for final reviewer (Codex)

**Iteration count derivation example:**
tasks = TaskList()
sonnet_fix_count = tasks.filter(t => t.subject.matches("Fix Plan - Sonnet v\\d+")).length
iteration = sonnet_fix_count + 1  // If 1 existing "v1" task, next is v2

Any reviewer returns needs_changes:
  // Extract issues from the review output file
  review_file = TaskGet(current_task_id).description  // parse OUTPUT field
  issues = read review_file → extract blockers + critical/high findings (≤ 500 chars summary)

  fix = TaskCreate(
    subject: "Fix [Phase] - [Reviewer] v{iteration}",
    activeForm: "Fixing [phase] issues...",
    description: "PHASE: Fix {phase} issues from {reviewer} review\n\
AGENT: claude-codex:{planner|implementer} (model: {opus|sonnet})\n\
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
AGENT: claude-codex:{plan-reviewer|code-reviewer} (model: {model})\n\
INPUT: {same INPUT files as original review task}\n\
OUTPUT: {same OUTPUT file as original review — overwrite}\n\
NOTE: Re-review after fix. Same reviewer, same output file.\n\
RESULT HANDLING: Same as original review task\n\
COMPLETION: {output_file} exists with updated status"
  )
  TaskUpdate(rerev.id, addBlockedBy: [fix.id])
  if next_reviewer_id is not null:
    TaskUpdate(next_reviewer_id, addBlockedBy: [rerev.id])
  // Next iteration: current_task_id = rerev.id, iteration += 1

Example (Sonnet plan review, first cycle):
  fix = TaskCreate(subject: "Fix Plan - Sonnet v1", activeForm: "Fixing plan issues...", description: "...")  // description omitted for brevity — see full pattern above
  TaskUpdate(fix.id, addBlockedBy: [current_task_id])
  rerev = TaskCreate(subject: "Plan Review - Sonnet v2", activeForm: "Re-reviewing plan (Sonnet)...", description: "...")  // description omitted for brevity — see full pattern above
  TaskUpdate(rerev.id, addBlockedBy: [fix.id])
  TaskUpdate(pipeline_tasks["plan_review_opus"], addBlockedBy: [rerev.id])

Example (Codex plan review — final reviewer, no next):
  fix = TaskCreate(subject: "Fix Plan - Codex v1", activeForm: "Fixing plan issues...", description: "...")  // description omitted for brevity — see full pattern above
  TaskUpdate(fix.id, addBlockedBy: [current_task_id])
  rerev = TaskCreate(subject: "Plan Review - Codex v2", activeForm: "Re-reviewing plan (Codex)...", description: "...")  // description omitted for brevity — see full pattern above
  TaskUpdate(rerev.id, addBlockedBy: [fix.id])
  // No TaskUpdate for next reviewer — Codex IS the final reviewer.
  // After rerev completes with "approved", proceed to next pipeline phase.
```

### rejected → Rework Task (Sonnet/Opus Code Reviews Only)

Fundamental issues requiring significant changes. **Codex code rejected is terminal** (see below).

```
Sonnet or Opus code reviewer returns rejected:
  issues = read review file → extract rejection reasons (≤ 500 chars summary)

  rework = TaskCreate(
    subject: "Rework Code - [Reviewer] v{iteration}",
    activeForm: "Reworking code...",
    description: "PHASE: Rework code — {reviewer} rejected\n\
AGENT: claude-codex:implementer (model: sonnet)\n\
INPUT: {review_file} (rejection details), .task/user-story.json, .task/plan-refined.json\n\
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

### rejected → Terminal (Codex Reviews)

Codex rejecting plan or code = fundamental approach issue:

```
Codex plan review returns rejected:
  → Terminal state: plan_rejected
  → Ask user: restart requirements, revise plan, or abort

Codex code review returns rejected:
  → Terminal state: code_rejected
  → Ask user: rework via planner, restart requirements, or abort
  → No rework/re-review tasks created — Codex is the final gate
```

### Iteration Tracking

Track iterations via dynamic task naming (v1, v2, v3...). Derive iteration count from TaskList (count existing matching tasks) to handle interruptions. After **10 re-reviews** for any single reviewer, escalate to user.

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
4. Use `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset` to reset pipeline (emergency only)

---

## Hook Behavior

### UserPromptSubmit Hook (Guidance)

The `guidance-hook.ts` runs on every prompt and:

1. **Reads artifact files** - Checks `.task/*.json` to determine current phase
2. **Injects guidance** - Reminds you what to do next
3. **No state tracking** - Phase is implicit from which files exist

### SubagentStop Hook (Enforcement)

The `review-validator.ts` runs when reviewer agents finish and:

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
| `code_rejected` | Codex rejected code | User decision needed |
| `implementation_failed` | Implementation blocked | User decision needed |

---

## Pipeline Completion

When all reviews are approved (or a terminal state is reached):

1. Report results to the user
2. Read `team_name` from `.task/pipeline-tasks.json` and use `TeamDelete` with it to clean up the pipeline team and its task list
3. Pipeline team cleanup is best-effort — if TeamDelete fails, the next pipeline run's idempotent Step 1.5 will handle it

---

## Important Rules

1. **Pipeline team first, then task chain** - After reset, create the pipeline team (Step 1.5), verify task tools (Step 1.6), then create the full task chain with `blockedBy` dependencies. No agents are spawned before the task chain exists.
2. **Tasks are primary** - Create tasks with `blockedBy` for structural enforcement
3. **No phase skipping** - Every phase executes in order. Pre-existing plans, design docs, or prior conversation context are INPUT to specialists, never a substitute for running the full pipeline. Always run team-based requirements gathering even if you think you already know the answer.
4. **Pipeline team lifecycle** - The pipeline team persists for the entire pipeline. Only specialist teammates are shut down after requirements. `TeamDelete` is called only at pipeline completion (or by the next run's idempotent Step 1.5). All phases other than requirements use one-shot `Task()` calls for workers.
5. **SubagentStop enforces** - Hook validates reviewer outputs and can block
6. **AC verification required** - All reviews MUST verify acceptance criteria from user-story.json
7. **Same-reviewer re-review** - After fix/rework, SAME reviewer validates before next
8. **Codex is mandatory** - Pipeline NOT complete without Codex approval
9. **Max 10 iterations** - Per reviewer, then escalate to user
10. **Accept all feedback** - No debate with reviewers, just fix
11. **User can interrupt** - Handle additional input, offer restart/kick back
12. **Task descriptions are execution context** — Every TaskCreate includes a description with AGENT, MODEL, INPUT, OUTPUT, and key instructions. The main loop calls TaskGet() to read the description before spawning any agent. Never derive execution context from hardcoded prose or task subject matching. Dynamic fix/rework/re-review tasks follow the same contract.
13. **Progressive enrichment before completion** — Before marking a task completed, read its output file, extract key context (≤ 500 chars), and call TaskUpdate on the next task to set a CONTEXT FROM PRIOR TASK block. If a block already exists, replace it (don't accumulate). Enrichment is best-effort — failure does not block the pipeline.

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset`
4. **Check pipeline team:** Read `team_name` from `.task/pipeline-tasks.json`, verify team exists — Step 1.5 may need to be re-run
