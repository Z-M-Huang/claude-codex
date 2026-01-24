---
name: multi-ai
description: Start the multi-AI pipeline with TDD-driven ralph loop. Plan -> Review -> Implement (loop until tests pass + reviews approve).
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Multi-AI Pipeline Orchestrator

You coordinate worker agents using Task + Resume, handle their questions, and drive the pipeline to completion with Codex as final gate.

**Scripts location:** `${CLAUDE_PLUGIN_ROOT}/scripts/`
**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`
**Agents location:** `${CLAUDE_PLUGIN_ROOT}/agents/`

---

## Architecture Overview

```
ORCHESTRATOR (This Session)
    |
    +-- Phase 1: Requirements [Task + Resume]
    |       +-- requirements-gatherer agent (opus)
    |       +-- Resume for user Q&A iterations
    |       -> Output: .task/user-story.json
    |
    +-- Phase 2: Planning [Task + Resume]
    |       +-- planner agent (opus)
    |       +-- Resume if reviews request changes
    |       -> Output: .task/plan-refined.json
    |
    +-- Phase 3: Plan Reviews [Task-Based Sequential]
    |       +-- TaskCreate with blockedBy dependencies
    |       +-- Task(plan-reviewer, sonnet)  -> review-sonnet.json
    |       +-- Task(plan-reviewer, opus)    -> review-opus.json
    |       +-- Skill(review-codex)          -> review-codex.json  <- FINAL GATE
    |
    +-- Phase 4: Implementation [Task + Resume]
    |       +-- implementer agent (sonnet)
    |       +-- Resume for iterative fixes (Ralph Loop)
    |       -> Output: .task/impl-result.json
    |
    +-- Phase 5: Code Reviews [Task-Based Sequential]
            +-- TaskCreate with blockedBy dependencies
            +-- Task(code-reviewer, sonnet)  -> review-sonnet.json
            +-- Task(code-reviewer, opus)    -> review-opus.json
            +-- Skill(review-codex)          -> review-codex.json  <- FINAL GATE
```

---

## Your Responsibilities

1. **Create task chain** at pipeline start with proper `blockedBy` dependencies
2. **Execute task loop** - find next unblocked task, execute, validate, complete
3. **Spawn workers** for each phase using the Task tool
4. **Resume workers** when they need continued context
5. **Monitor signals** by reading `.task/worker-signal.json`
6. **Handle questions** via AskUserQuestion, then resume workers
7. **Invoke Codex** via `/review-codex` skill for final approvals
8. **Handle review failures** by creating fix tasks dynamically

---

## Phase 1: Pipeline Initialization

### Step 1: Reset and Create Task Chain

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set requirements_gathering ""
```

**CRITICAL: Create the full pipeline task chain with dependencies:**

```
# Create tasks in order - each returns a task ID
# Store the user's original request for task descriptions

TaskCreate(
  subject: "Gather requirements",
  description: "Use requirements-gatherer agent to clarify and document user requirements. Output: .task/user-story.json",
  activeForm: "Gathering requirements"
)
# Store this ID as T_REQ

TaskCreate(
  subject: "Create implementation plan",
  description: "Use planner agent to create detailed implementation plan. Input: .task/user-story.json. Output: .task/plan-refined.json",
  activeForm: "Creating plan"
)
# Store this ID as T_PLAN
# Then: TaskUpdate(T_PLAN, addBlockedBy: [T_REQ])

TaskCreate(
  subject: "Plan Review - Sonnet",
  description: "Run Sonnet model review of the plan. Input: .task/plan-refined.json. Output: .task/review-sonnet.json",
  activeForm: "Running Sonnet plan review"
)
# Store this ID as T_PLAN_SONNET
# Then: TaskUpdate(T_PLAN_SONNET, addBlockedBy: [T_PLAN])

TaskCreate(
  subject: "Plan Review - Opus",
  description: "Run Opus model review of the plan. Input: .task/plan-refined.json. Output: .task/review-opus.json",
  activeForm: "Running Opus plan review"
)
# Store this ID as T_PLAN_OPUS
# Then: TaskUpdate(T_PLAN_OPUS, addBlockedBy: [T_PLAN_SONNET])

TaskCreate(
  subject: "Plan Review - Codex",
  description: "Run Codex final gate review of the plan. Input: .task/plan-refined.json. Output: .task/review-codex.json. MANDATORY GATE.",
  activeForm: "Running Codex plan review"
)
# Store this ID as T_PLAN_CODEX
# Then: TaskUpdate(T_PLAN_CODEX, addBlockedBy: [T_PLAN_OPUS])

TaskCreate(
  subject: "Implementation",
  description: "Use implementer agent to implement the approved plan. Input: .task/plan-refined.json. Output: .task/impl-result.json",
  activeForm: "Implementing"
)
# Store this ID as T_IMPL
# Then: TaskUpdate(T_IMPL, addBlockedBy: [T_PLAN_CODEX])

TaskCreate(
  subject: "Code Review - Sonnet",
  description: "Run Sonnet model review of the implementation. Input: .task/impl-result.json. Output: .task/review-sonnet.json",
  activeForm: "Running Sonnet code review"
)
# Store this ID as T_CODE_SONNET
# Then: TaskUpdate(T_CODE_SONNET, addBlockedBy: [T_IMPL])

TaskCreate(
  subject: "Code Review - Opus",
  description: "Run Opus model review of the implementation. Input: .task/impl-result.json. Output: .task/review-opus.json",
  activeForm: "Running Opus code review"
)
# Store this ID as T_CODE_OPUS
# Then: TaskUpdate(T_CODE_OPUS, addBlockedBy: [T_CODE_SONNET])

TaskCreate(
  subject: "Code Review - Codex",
  description: "Run Codex final gate review of the implementation. Input: .task/impl-result.json. Output: .task/review-codex.json. MANDATORY GATE.",
  activeForm: "Running Codex code review"
)
# Store this ID as T_CODE_CODEX
# Then: TaskUpdate(T_CODE_CODEX, addBlockedBy: [T_CODE_OPUS])
```

**Store task IDs mapping in `.task/pipeline-tasks.json`:**
```json
{
  "requirements": "T_REQ_ID",
  "plan": "T_PLAN_ID",
  "plan_review_sonnet": "T_PLAN_SONNET_ID",
  "plan_review_opus": "T_PLAN_OPUS_ID",
  "plan_review_codex": "T_PLAN_CODEX_ID",
  "implementation": "T_IMPL_ID",
  "code_review_sonnet": "T_CODE_SONNET_ID",
  "code_review_opus": "T_CODE_OPUS_ID",
  "code_review_codex": "T_CODE_CODEX_ID"
}
```

---

## Phase 2: Main Execution Loop

**CRITICAL: This is a DATA-DRIVEN loop. You MUST query TaskList() to find the next task.**

```
MAIN_LOOP:
    # Step 1: Query task list for current state
    tasks = TaskList()

    # Step 2: Find next executable task
    next_task = find task where:
      - status == "pending"
      - blockedBy is empty OR all blockedBy tasks have status == "completed"

    # Step 3: Check termination conditions
    IF no next_task AND all tasks completed:
        -> Pipeline COMPLETE, go to Phase 5
    IF no next_task AND some tasks pending:
        -> ERROR: Pipeline blocked (circular dependency or missing completion)

    # Step 4: Mark task in progress
    TaskUpdate(next_task.id, status: "in_progress")

    # Step 5: Execute task based on subject
    EXECUTE_TASK(next_task)

    # Step 6: Validate output and handle result
    VALIDATE_AND_COMPLETE(next_task)

    # Step 7: Loop back
    GOTO MAIN_LOOP
```

---

## Task Execution Reference

### EXECUTE_TASK(task)

Based on `task.subject`, execute the appropriate action.

**IMPORTANT: Update state before executing each task type:**

#### "Gather requirements"
```bash
# Update state FIRST
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set requirements_gathering ""
```
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/requirements-gatherer.md
Task(
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "[Paste agent prompt] + User request: [original request]"
)
# Handle worker signals (needs_input -> AskUserQuestion -> Resume)
```
**Expected output:** `.task/user-story.json`

#### "Create implementation plan"
```bash
# Update state FIRST
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting ""
```
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/planner.md
Task(
  subagent_type: "Plan",
  model: "opus",
  prompt: "[Paste agent prompt] + Context: .task/user-story.json"
)
# Handle risk assessment if needed
```
**Expected output:** `.task/plan-refined.json`

#### "Plan Review - Sonnet"
```bash
# Update state FIRST (only on first plan review)
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_reviewing ""
```
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/plan-reviewer.md
Task(
  subagent_type: "claude-codex:plan-reviewer",
  model: "sonnet",
  prompt: "[Paste agent prompt] + Review .task/plan-refined.json against .task/user-story.json"
)
```
**Expected output:** `.task/review-sonnet.json`

#### "Plan Review - Opus"
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/plan-reviewer.md
Task(
  subagent_type: "claude-codex:plan-reviewer",
  model: "opus",
  prompt: "[Paste agent prompt] + Review .task/plan-refined.json against .task/user-story.json"
)
```
**Expected output:** `.task/review-opus.json`

#### "Plan Review - Codex"
```
Skill(review-codex)
```
**Expected output:** `.task/review-codex.json`

#### "Implementation"
```bash
# Update state FIRST
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing_loop ""
```
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/implementer.md
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: "[Paste agent prompt] + Implement .task/plan-refined.json"
)
```
**Expected output:** `.task/impl-result.json`

#### "Code Review - Sonnet"
```
# State remains implementing_loop during code reviews
Read: ${CLAUDE_PLUGIN_ROOT}/agents/code-reviewer.md
Task(
  subagent_type: "claude-codex:code-reviewer",
  model: "sonnet",
  prompt: "[Paste agent prompt] + Review implementation against .task/plan-refined.json"
)
```
**Expected output:** `.task/review-sonnet.json`

#### "Code Review - Opus"
```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/code-reviewer.md
Task(
  subagent_type: "claude-codex:code-reviewer",
  model: "opus",
  prompt: "[Paste agent prompt] + Review implementation against .task/plan-refined.json"
)
```
**Expected output:** `.task/review-opus.json`

#### "Code Review - Codex"
```
Skill(review-codex)
```
**Expected output:** `.task/review-codex.json`

#### "Fix [Phase] Issues - Iteration N" (Dynamic Fix Tasks)
```
# Resume the appropriate agent with feedback
# IMPORTANT: Specify the correct model for each agent type
IF plan fix:
  Task(
    resume: planner_agent_id,
    model: "opus",  # Planner uses Opus for deep analysis
    prompt: "Fix issues: [feedback]. Update .task/plan-refined.json"
  )
IF code fix:
  Task(
    resume: implementer_agent_id,
    model: "sonnet",  # Implementer uses Sonnet for balanced speed/quality
    prompt: "Fix issues: [feedback]. Update implementation."
  )
```

---

## VALIDATE_AND_COMPLETE(task)

### For Non-Review Tasks
```
# Verify expected output file exists
IF output file missing:
    -> ERROR: Task did not produce expected output
ELSE:
    TaskUpdate(task.id, status: "completed")
```

### For Review Tasks (CRITICAL: Handle needs_changes)

```
# Read the review output file
review = Read(.task/review-*.json based on task)

IF review.status == "approved":
    TaskUpdate(task.id, status: "completed", metadata: {result: "approved"})

ELSE IF review.status == "needs_changes":
    # GRANULAR FIX: Create fix task immediately

    # 1. Determine phase and iteration
    iteration = count existing "Fix" tasks for this phase + 1

    # 2. Create fix task
    fix_task_id = TaskCreate(
      subject: "Fix [Phase] Issues - Iteration {iteration}",
      description: "Address feedback: {review.feedback}. Fix the issues identified by {reviewer}.",
      activeForm: "Fixing {phase} issues"
    )

    # 3. Update fix task to be blocked by current review
    TaskUpdate(fix_task_id, addBlockedBy: [task.id])

    # 4. Find the NEXT reviewer in sequence and update its blockedBy
    #    This ensures the next reviewer waits for the fix
    IF task is "Plan Review - Sonnet":
        # Find Opus review task, add fix_task_id to its blockedBy
        TaskUpdate(plan_review_opus_id, addBlockedBy: [fix_task_id])
    ELSE IF task is "Plan Review - Opus":
        # Find Codex review task, add fix_task_id to its blockedBy
        TaskUpdate(plan_review_codex_id, addBlockedBy: [fix_task_id])
    ELSE IF task is "Plan Review - Codex":
        # Final gate needs changes - create re-review task
        re_review_id = TaskCreate(
          subject: "Plan Review - Codex v{iteration+1}",
          description: "Re-review plan after fixes",
          activeForm: "Re-running Codex plan review"
        )
        TaskUpdate(re_review_id, addBlockedBy: [fix_task_id])
        # Update implementation to wait for re-review
        TaskUpdate(implementation_id, addBlockedBy: [re_review_id])
    # Same pattern for Code Reviews...
    ELSE IF task is "Code Review - Sonnet":
        TaskUpdate(code_review_opus_id, addBlockedBy: [fix_task_id])
    ELSE IF task is "Code Review - Opus":
        TaskUpdate(code_review_codex_id, addBlockedBy: [fix_task_id])
    ELSE IF task is "Code Review - Codex":
        re_review_id = TaskCreate(
          subject: "Code Review - Codex v{iteration+1}",
          description: "Re-review code after fixes",
          activeForm: "Re-running Codex code review"
        )
        TaskUpdate(re_review_id, addBlockedBy: [fix_task_id])
        # This becomes the new final task

    # 5. Mark current review as completed (with needs_changes metadata)
    TaskUpdate(task.id, status: "completed", metadata: {result: "needs_changes", iteration: iteration})

ELSE IF review.status == "needs_clarification":
    # Ask user, then resume the agent
    AskUserQuestion(review.questions)
    # Resume appropriate agent with answers
    # DO NOT mark task complete yet - wait for re-review
```

---

## Worker Signal Protocol

Workers communicate via `.task/worker-signal.json`:

```json
{
  "worker_id": "requirements-gatherer-abc123",
  "phase": "requirements|planning|implementation",
  "status": "needs_input|completed|error|in_progress",
  "questions": [...],
  "agent_id": "abc123",
  "timestamp": "ISO8601"
}
```

### Handling Signals (within EXECUTE_TASK)

```
CHECK_SIGNAL:
    Read .task/worker-signal.json

    IF status == "completed":
        Return (task execution done)

    IF status == "needs_input":
        questions = signal.questions
        answers = AskUserQuestion(questions)
        # Resume with same model as original task:
        # - requirements/planning phases: model: "opus"
        # - implementation phase: model: "sonnet"
        Task(
          resume: signal.agent_id,
          model: [match original task model],
          prompt: "Answers: [answers]"
        )
        GOTO CHECK_SIGNAL

    IF status == "error":
        Log error, decide: retry or abort

    IF status == "in_progress":
        Wait and check again
```

---

## Phase 5: Completion

After all tasks are completed:

### Step 1: Final Validation

```
# Verify all required files exist with approved status
CHECKLIST (all must be true):
[ ] .task/user-story.json exists
[ ] .task/plan-refined.json exists
[ ] Final plan review has status == "approved"
[ ] .task/impl-result.json exists AND status == "completed"
[ ] Final code review has status == "approved"
[ ] All test commands passed
```

### Step 2: Clean Up

```bash
rm -f .task/loop-state.json
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set complete "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

### Step 3: Report Results

Report to user:
- What was implemented
- Files changed
- Tests added/modified
- Review iterations taken (visible in task history)
- Final test results

---

## Why Task-Based Enforcement Works

| Instruction-Based (Old) | Task-Based (New) |
|-------------------------|------------------|
| "Run Sonnet → Opus → Codex" | `blockedBy` prevents Codex until Opus completes |
| LLM can skip "redundant" steps | LLM queries TaskList() for next available task |
| No audit trail | Complete task history with metadata |
| Hidden progress | User sees real-time task progress |
| Relies on instruction-following | Relies on data queries |

**Key Insight:** `blockedBy` is **data**, not an instruction. When you call `TaskList()`, blocked tasks cannot be claimed. The prompt becomes "find next unblocked task" - a data query, not instruction following.

---

## Important Rules

1. **ALWAYS query TaskList()** to find the next task - do NOT skip ahead
2. **NEVER mark a task complete** without executing it and validating output
3. **Create fix tasks dynamically** when reviews return `needs_changes`
4. **Update blockedBy** when creating fix tasks to maintain sequence
5. **Semi-interactive planning**: Only ask user when genuinely needed
6. **Autonomous after plan approval**: Once all plan reviews pass, proceed to implementation
7. **Ralph Loop is default**: Use `ralph-loop` mode unless plan explicitly specifies `simple` mode
8. **Review before test**: Always run reviews first, then tests
9. **Accept all feedback**: No debate with reviewers, just fix
10. **Resume for context**: Use resume to preserve worker memory across iterations
11. **NEVER run Codex via Bash**: Always use `Skill(review-codex)`
12. **MANDATORY Codex gate**: Pipeline is NOT complete without Codex approval

---

## Progress Reporting

The task system provides automatic progress visibility. Report inline but DO NOT STOP after plan reviews pass:

```
Pipeline initialized with 9 tasks.

[1/9] Gather requirements - in_progress
Requirements approved.

[2/9] Create implementation plan - in_progress
Plan created. Risk assessment: No conflicts.

[3/9] Plan Review - Sonnet - in_progress
Sonnet: needs_changes (2 issues)
-> Created: Fix Plan Issues - Iteration 1

[Fix task] Fix Plan Issues - Iteration 1 - in_progress
Fixes applied.

[3/9] Plan Review - Sonnet - completed (was needs_changes, now proceeding)
[4/9] Plan Review - Opus - in_progress
Opus: approved

[5/9] Plan Review - Codex - in_progress
Codex: approved

[6/9] Implementation - in_progress
Implementation complete.

[7/9] Code Review - Sonnet - in_progress
Sonnet: approved

[8/9] Code Review - Opus - in_progress
Opus: approved

[9/9] Code Review - Codex - in_progress
Codex: approved

All tasks completed. Pipeline finished successfully.

<promise>IMPLEMENTATION_COMPLETE</promise>
```

---

## Emergency Controls

If stuck:
1. **Cancel command:** `/cancel-loop`
2. **Check task state:** `TaskList()` to see blocked tasks
3. **Delete state file:** `rm .task/loop-state.json`
4. **Max iterations:** Loop auto-stops at limit

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
