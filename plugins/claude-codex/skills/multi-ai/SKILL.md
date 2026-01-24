---
name: multi-ai
description: Start the multi-AI pipeline with TDD-driven ralph loop. Plan -> Review -> Implement (loop until tests pass + reviews approve).
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, Skill
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
    +-- Phase 3: Plan Reviews [Sequential]
    |       +-- Task(plan-reviewer, sonnet)  -> review-sonnet.json
    |       +-- Task(plan-reviewer, opus)    -> review-opus.json
    |       +-- Skill(review-codex)          -> review-codex.json  <- FINAL GATE
    |
    +-- Phase 4: Implementation [Task + Resume]
    |       +-- implementer agent (sonnet)
    |       +-- Resume for iterative fixes (Ralph Loop)
    |       -> Output: .task/impl-result.json
    |
    +-- Phase 5: Code Reviews [Sequential]
            +-- Task(code-reviewer, sonnet)  -> review-sonnet.json
            +-- Task(code-reviewer, opus)    -> review-opus.json
            +-- Skill(review-codex)          -> review-codex.json  <- FINAL GATE
```

---

## Your Responsibilities

1. **Spawn workers** for each phase using the Task tool
2. **Resume workers** when they need continued context
3. **Monitor signals** by reading `.task/worker-signal.json`
4. **Handle questions** via AskUserQuestion, then resume workers
5. **Invoke Codex** via `/review-codex` skill for final approvals
6. **Track state** in `.task/state.json`

---

## Phase 1: Requirements Gathering (Interactive)

### Step 1: Initialize

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set requirements_gathering ""
```

### Step 2: Spawn Requirements Gatherer

Load the agent prompt and spawn:

```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/requirements-gatherer.md
```

Then use Task tool:
```
Task(
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "
    [Paste agent prompt from requirements-gatherer.md]

    ## Current Task
    User request: [paste user's original request]

    ## Output
    Write approved requirements to .task/user-story.json
    If you need user input, write to .task/worker-signal.json with status: needs_input
  "
)
```

### Step 3: Handle Worker Signals

After spawning, check for signals:

```
Read: .task/worker-signal.json
```

**IF `status: "needs_input"`:**
1. Read the questions from the signal file
2. Use `AskUserQuestion` to get user answers
3. Resume the worker with the answers:
   ```
   Task(
     resume: [agent_id from previous spawn],
     prompt: "User provided answers: [answers]. Continue from where you left off."
   )
   ```

**IF `status: "completed"`:**
- Verify `.task/user-story.json` exists and is valid
- Proceed to Phase 2

---

## Phase 2: Planning (Semi-Interactive)

### Step 4: Update State

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/user-story.json .id)"
```

### Step 5: Spawn Planner

Load and spawn the planner agent:

```
Read: ${CLAUDE_PLUGIN_ROOT}/agents/planner.md
```

```
Task(
  subagent_type: "Plan",
  model: "opus",
  prompt: "
    [Paste agent prompt from planner.md]

    ## Context
    User story at: .task/user-story.json

    ## Output
    Write implementation plan to .task/plan-refined.json
  "
)
```

### Step 6: Risk Assessment Check

After planning completes, read the plan and check for risks:

```
Read: .task/plan-refined.json
```

**IF `risk_assessment.requires_user_decision` is true:**
- Use `AskUserQuestion` to present risks and get user decision
- Update plan based on user input

---

## Phase 3: Plan Reviews (Autonomous)

### Step 7: Initialize Plan Review

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" init-plan-review
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_reviewing "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

### Step 8: Review Loop

```
PLAN_ITERATION = 0
MAX_PLAN_ITERATIONS = get from config (default: 10)

WHILE PLAN_ITERATION < MAX_PLAN_ITERATIONS:

    # Increment at start of each cycle
    "${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" increment-plan-review

    1. SONNET REVIEW
       Load: ${CLAUDE_PLUGIN_ROOT}/agents/plan-reviewer.md
       Task(subagent_type: "Plan", model: "sonnet", prompt: "[agent prompt] Review .task/plan-refined.json")
       -> Writes .task/review-sonnet.json

       IF needs_changes -> Resume planner to fix, restart loop
       IF needs_clarification -> AskUserQuestion, resume planner

    2. OPUS REVIEW
       Task(subagent_type: "Plan", model: "opus", prompt: "[agent prompt] Review .task/plan-refined.json")
       -> Writes .task/review-opus.json

       IF needs_changes -> Resume planner to fix, restart loop
       IF needs_clarification -> AskUserQuestion, resume planner

    3. CODEX REVIEW (FINAL GATE)
       Skill(review-codex)
       -> Writes .task/review-codex.json

       IF approved -> EXIT loop, proceed to implementation
       IF needs_changes -> Resume planner to fix, go back to step 1
       IF needs_clarification -> AskUserQuestion, then continue

    PLAN_ITERATION++
```

### Step 9: Validate Before Implementation

**CRITICAL:** You CANNOT proceed to implementation until ALL reviews approve.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" validate-plan-reviews
```

This command will fail with detailed error if any reviews are incomplete.

**IMPORTANT:** Once validation passes, IMMEDIATELY proceed to Phase 4 - do NOT stop to report or wait for user input. The pipeline is autonomous after requirements approval.

---

## Phase 4: Implementation (Ralph Loop)

**AUTO-PROCEED:** When plan reviews pass, automatically start implementation using the Ralph Loop (default) or simple mode based on `plan-refined.json`.

### Step 10: Check Implementation Mode

```bash
MODE=$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .implementation.mode)
```

### IF mode == "simple": Single Implementation Cycle

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

1. Load and spawn implementer agent
2. Run single review cycle
3. Run tests
4. If all pass -> complete
5. If issues -> fix once, then complete

### IF mode == "ralph-loop": TDD Ralph Loop

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing_loop "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

### Step 11: Initialize Loop State

Write `.task/loop-state.json`:
```json
{
  "active": true,
  "iteration": 0,
  "max_iterations": 10,
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
  "plan_path": ".task/plan-refined.json",
  "implementer_agent_id": null,
  "started_at": "ISO8601"
}
```

### Step 12: Execute Ralph Loop

```
WHILE iteration < max_iterations:

    1. SPAWN/RESUME IMPLEMENTER
       Load: ${CLAUDE_PLUGIN_ROOT}/agents/implementer.md

       IF first iteration:
         Task(subagent_type: "general-purpose", model: "sonnet", prompt: "[agent prompt]")
         Save agent_id to loop-state.json
       ELSE:
         Task(resume: agent_id, prompt: "Fix issues: [feedback from reviews]. Continue implementing.")

    2. READ IMPLEMENTATION RESULT
       Read: .task/impl-result.json

       IF status == "failed" -> Continue loop with error feedback

    3. CODE REVIEWS (sequential, NOT resumable - each is fresh analysis)

       a. Sonnet Review:
          Load: ${CLAUDE_PLUGIN_ROOT}/agents/code-reviewer.md
          Task(subagent_type: "Explore", model: "sonnet", prompt: "[agent prompt]")
          -> Writes .task/review-sonnet.json

       b. Opus Review:
          Task(subagent_type: "Explore", model: "opus", prompt: "[agent prompt]")
          -> Writes .task/review-opus.json

       c. Codex Review (FINAL GATE):
          Skill(review-codex)
          -> Writes .task/review-codex.json

    4. RUN TESTS
       Bash: [test commands from plan.test_plan.commands]
       Check success/failure patterns

    5. CHECK COMPLETION CRITERIA
       - All reviews have status: "approved"
       - All tests pass

       IF all criteria met:
         Output: <promise>IMPLEMENTATION_COMPLETE</promise>
         BREAK
       ELSE:
         Collect feedback from review files
         iteration++
         Continue loop

END WHILE
```

---

## Phase 5: Completion

### Step 13: Clean Up

```bash
rm -f .task/loop-state.json
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set complete "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

### Step 14: Report Results

Report to user:
- What was implemented
- Files changed
- Tests added/modified
- Review iterations taken
- Final test results

---

## Worker Signal Protocol

Workers communicate via `.task/worker-signal.json`:

```json
{
  "worker_id": "requirements-gatherer-abc123",
  "phase": "requirements|planning|implementation",
  "status": "needs_input|completed|error|in_progress",
  "progress": { "step": "current_step", "percent": 75 },
  "questions": [
    {
      "id": "q1",
      "question": "Which authentication method should we use?",
      "options": ["JWT", "Session cookies", "OAuth2"],
      "context": "The plan requires auth but method wasn't specified"
    }
  ],
  "partial_output": {},
  "agent_id": "abc123",
  "timestamp": "ISO8601"
}
```

### Handling Signals

```
CHECK_SIGNAL:
    Read .task/worker-signal.json

    IF status == "completed":
        Proceed to next phase

    IF status == "needs_input":
        questions = signal.questions
        Use AskUserQuestion(questions)
        Resume worker: Task(resume: signal.agent_id, prompt: "Answers: [answers]")
        GOTO CHECK_SIGNAL

    IF status == "error":
        Log error
        Decide: retry or abort

    IF status == "in_progress":
        Wait and check again
```

---

## Codex Integration

Codex is invoked via the `/review-codex` skill as the final gate:

```
Skill(review-codex)
```

The skill handles:
- Determining review type (plan vs code) based on existing files
- Proper `--output-schema` for valid JSON output
- Session management (`resume --last` for subsequent reviews)
- Detailed prompts ensuring comprehensive review
- Writing output to `.task/review-codex.json`

---

## Important Rules

1. **Semi-interactive planning**: Only ask user when genuinely needed
2. **Autonomous after plan approval**: Once all 3 plan reviews pass, IMMEDIATELY proceed to implementation - do NOT stop, report, or wait for user confirmation
3. **Ralph Loop is default**: Use `ralph-loop` mode unless plan explicitly specifies `simple` mode
4. **Review before test**: Always run reviews first, then tests
5. **Accept all feedback**: No debate with reviewers, just fix
6. **Clear completion criteria**: Tests pass + reviews approve
7. **Resume for context**: Use resume to preserve worker memory across iterations
8. **NEVER run Codex via Bash**: Always use `Skill(review-codex)` - the skill handles all Codex CLI invocation, schema paths, and session management. Do NOT run `codex exec` directly.

---

## Progress Reporting

Report progress inline but DO NOT STOP after plan reviews pass. Continue immediately to implementation.

```
Requirements approved. Starting planning...
- Plan created
- Risk assessment: No conflicts detected
- Plan reviews: approved (2 iterations)
- Proceeding to implementation... [DO NOT STOP HERE]

Starting implementation (ralph-loop mode, max 10 iterations)...
Iteration 1:
  - Implementation complete
  - Sonnet review: 2 issues
  - Fixing issues...
Iteration 2:
  - Fixes applied
  - Sonnet review: approved
  - Opus review: approved
  - Codex review: approved
  - Tests: 5 passed, 0 failed

<promise>IMPLEMENTATION_COMPLETE</promise>

Complete! Feature implemented in 2 iterations.
```

---

## Emergency Controls

If stuck:
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
