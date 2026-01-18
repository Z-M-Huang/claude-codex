---
name: multi-ai
description: Start the multi-AI pipeline with a given request. Cleans up old task files and guides through plan → review → implement → review workflow.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, AskUserQuestion
---

# Multi-AI Pipeline Command (Autonomous Mode)

You are starting the multi-AI pipeline in **autonomous mode**. This means:

1. **User interaction happens FIRST** during requirements gathering
2. **Everything after is automated** - no pauses between reviews
3. **Only pause for**: `needs_clarification`, review loop exceeded, or unrecoverable errors

**Scripts location:** `${CLAUDE_PLUGIN_ROOT}/scripts/`
**Task directory:** `${CLAUDE_PROJECT_DIR}/.task/`

---

## Phase 1: Requirements Gathering (Interactive)

### Step 1: Clean Up Previous Task

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" reset
```

### Step 2: Set State and Gather Requirements

Set the state to requirements_gathering before invoking /user-story:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set requirements_gathering ""
```

**Invoke /user-story** to interactively gather and clarify requirements with the user.

This skill will:
- Ask clarifying questions
- Resolve ambiguities
- Get user approval on requirements
- Write `.task/user-story.json` and `.task/user-request.txt`

**WAIT** for user approval before continuing. This is the only interactive phase.

---

## Phase 2: Autonomous Planning

Once requirements are approved, proceed autonomously.

### Step 3: Set State and Create Plan

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting ""
```

Create `.task/plan.json` based on the approved user story:
- `id`: "plan-YYYYMMDD-HHMMSS"
- `title`: From user story
- `description`: From user story requirements
- `requirements`: From user story functional requirements
- `created_at`: ISO8601 timestamp
- `created_by`: "claude"

### Step 4: Refine Plan

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_refining "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan.json .id)"
```

Research the codebase and create `.task/plan-refined.json` with:
- Technical approach
- Files to modify/create
- Potential challenges

### Step 5: Automated Plan Review Loop

Run the automated review loop (see "Automated Review Loop" section below).

**DO NOT** wait for user confirmation between reviews. Fix issues automatically and continue.

---

## Phase 3: Autonomous Implementation

### Step 6: Implement

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set implementing "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

**Invoke /implement-sonnet** to implement the approved plan.

### Step 7: Automated Code Review Loop

Run the automated review loop (see "Automated Review Loop" section below).

**DO NOT** wait for user confirmation between reviews. Fix issues automatically and continue.

---

## Phase 4: Completion

### Step 8: Mark Complete

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set complete "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan-refined.json .id)"
```

Report success to the user with a summary of:
- What was implemented
- Files changed
- Tests added
- Any notes or follow-up items

---

## Automated Review Loop

This is the core automation. Execute reviews sequentially, fixing issues automatically.

**Read limits from `${CLAUDE_PLUGIN_ROOT}/pipeline.config.json`:**
- For **Plan Reviews**: use `autonomy.planReviewLoopLimit` (default: 10)
- For **Code Reviews**: use `autonomy.codeReviewLoopLimit` (default: 15)

```
LOOP_COUNT = 0
MAX_LOOPS = <phase-specific limit from config>

WHILE LOOP_COUNT < MAX_LOOPS:

    1. INVOKE /review-sonnet
       READ .task/review-sonnet.json
       IF status == "needs_changes":
           FIX all issues listed in the review
           (update plan or code as appropriate)

    2. INVOKE /review-opus
       READ .task/review-opus.json
       IF status == "needs_changes":
           FIX all issues listed in the review

    3. INVOKE /review-codex
       READ .task/review-codex.json
       IF status == "approved":
           BREAK (exit loop - all reviews passed)
       IF status == "needs_changes":
           FIX all issues listed in the review
           LOOP_COUNT += 1
           CONTINUE (restart from sonnet)

    IF any review has needs_clarification == true:
        PAUSE and ask user (use AskUserQuestion)
        After user responds, continue loop

IF LOOP_COUNT >= MAX_LOOPS:
    PAUSE - inform user review loop exceeded limit
    Ask if they want to continue or abort
```

### Key Rules for Automated Fixes

1. **Accept ALL reviewer feedback** - no debate, just fix
2. **Fix thoroughly** - address root causes, not just symptoms
3. **Don't introduce new issues** while fixing
4. **Run tests after code fixes** if tests exist
5. **Update plan documentation** if architecture changes

### When to Pause (Exceptions)

Only pause the autonomous flow when one of the conditions in `autonomy.pauseOnlyOn` from `pipeline.config.json` is met:

1. **needs_clarification**: A reviewer sets `needs_clarification: true` with questions that require user input
2. **review_loop_exceeded**: Exceeded the phase-specific loop limit without approval
3. **unrecoverable_error**: Build failures, missing dependencies, etc. that can't be auto-resolved

For these cases, use `AskUserQuestion` to get user input, then continue.

---

## Important Rules

- **Autonomous by default**: Don't ask for confirmation between steps
- **Fix and continue**: When reviewers find issues, fix them and keep going
- **Only pause when truly stuck**: Ambiguity, decisions, or exceeded limits
- **Inform, don't ask**: Tell the user what you're doing, don't ask if you should do it
- **Complete the full cycle**: Don't stop until complete or legitimately blocked

---

## Progress Reporting

While running autonomously, provide brief status updates:

```
Planning phase complete. Starting plan reviews...
✓ Sonnet review: approved
✓ Opus review: 2 issues found, fixing...
✓ Opus review: approved (after fixes)
✓ Codex review: approved
Plan approved. Starting implementation...
```

This keeps the user informed without requiring their input.
