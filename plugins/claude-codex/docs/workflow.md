# Pipeline Workflow (Autonomous Mode)

## Architecture Overview

This pipeline uses a **skill-based autonomous architecture**:

- **User Story Phase** = Interactive requirements gathering (only interactive phase)
- **Main Claude Code thread** = Does planning, research, implementation, and auto-fixes
- **Reviewer Skills** = Sequential reviews with forked context isolation
- **Codex** = Final review via skill (invokes Codex CLI)

### Key Principle: Autonomous After Requirements

Once the user approves requirements:
- Pipeline runs **autonomously** without pauses
- Issues found by reviewers are **auto-fixed**
- Only pause for: `needs_clarification`, exceeded limits, or unrecoverable errors

### Skills

| Skill | Purpose | Model | Phase |
|-------|---------|-------|-------|
| `multi-ai` | Pipeline entry point | - | All |
| `user-story` | Requirements gathering (interactive) | - | Requirements |
| `implement-sonnet` | Code implementation | sonnet | Implementation |
| `review-sonnet` | Fast review | sonnet | Review |
| `review-opus` | Deep review | opus | Review |
| `review-codex` | Final review | codex | Review |

---

## Quick Start with `/multi-ai`

```
/multi-ai Add user authentication with JWT tokens
```

This command handles the entire workflow:

1. **Requirements gathering** (interactive) - Clarify what you want
2. **Planning** (autonomous) - Create and refine plan
3. **Implementation** (autonomous) - Write code
4. **Completion** - Report results

---

## Workflow Phases

### Phase 1: Requirements Gathering (INTERACTIVE)

```
idle
  ↓
requirements_gathering (/user-story)
  │  - Analyze request
  │  - Ask clarifying questions
  │  - Get user approval
  ↓ [approved]
plan_drafting
```

This is the **ONLY interactive phase**. The /user-story skill will:
- Ask clarifying questions using AskUserQuestion
- Summarize requirements
- Get explicit user approval before proceeding

**Output:** `.task/user-story.json` (approved requirements)

### Phase 2: Planning (AUTONOMOUS)

```
plan_drafting
  ↓ (main thread creates initial plan)
plan_refining
  ↓ (main thread researches and refines)
  ↓ AUTOMATED review loop:
  │   1. /review-sonnet → auto-fix issues
  │   2. /review-opus → auto-fix issues
  │   3. /review-codex → if issues, auto-fix and restart
  ↓ [all approved]
implementing
```

**Flow:**
1. Main thread → Creates initial plan from approved requirements
2. Main thread → Researches codebase and refines plan
3. **Automated Review Loop** (no user pauses):
   - `/review-sonnet` → If issues, fix automatically, continue
   - `/review-opus` → If issues, fix automatically, continue
   - `/review-codex` → If approved, proceed; if issues, fix and restart from sonnet

### Phase 3: Implementation (AUTONOMOUS)

```
implementing
  ↓ (/implement-sonnet writes code)
  ↓ AUTOMATED review loop:
  │   1. /review-sonnet → auto-fix issues
  │   2. /review-opus → auto-fix issues
  │   3. /review-codex → if issues, auto-fix and restart
  ↓ [all approved]
complete
```

**Flow:**
1. **Invoke /implement-sonnet** → Writes code following standards
2. **Automated Review Loop** (no user pauses):
   - `/review-sonnet` → Code quality + security + tests
   - `/review-opus` → Architecture + subtle bugs + test quality
   - `/review-codex` → Final approval

---

## Automated Review Loop

This is the core automation. No user pauses between reviews:

```
LOOP_COUNT = 0
MAX_LOOPS = <from pipeline.config.json>
  - Plan reviews: autonomy.planReviewLoopLimit (default: 10)
  - Code reviews: autonomy.codeReviewLoopLimit (default: 15)

WHILE LOOP_COUNT < MAX_LOOPS:

    1. INVOKE /review-sonnet
       READ .task/review-sonnet.json
       IF needs_changes: FIX automatically

    2. INVOKE /review-opus
       READ .task/review-opus.json
       IF needs_changes: FIX automatically

    3. INVOKE /review-codex
       READ .task/review-codex.json
       IF approved: EXIT loop
       IF needs_changes: FIX, INCREMENT LOOP_COUNT, RESTART

    IF needs_clarification in any review:
        PAUSE - ask user (AskUserQuestion)
        After response, continue

IF LOOP_COUNT >= MAX_LOOPS:
    PAUSE - inform user, ask to continue or abort
```

### Auto-Fix Rules

When fixing reviewer feedback:
- Accept ALL feedback without debate
- Fix root causes, not symptoms
- Run tests after code changes
- Update plan docs if architecture changes
- Don't introduce new issues while fixing

---

## When Pipeline Pauses

The pipeline ONLY pauses for these exceptions:

1. **needs_clarification** - Reviewer or plan indicates missing information
2. **review_loop_exceeded** - Exceeded MAX_LOOPS without approval
3. **unrecoverable_error** - Build failures, missing deps that can't be auto-resolved

For these cases, use `AskUserQuestion` to get user input, then continue.

---

## Using the Orchestrator

```bash
./scripts/orchestrator.sh
```

Example output:
```
[INFO] Current state: implementing

ACTION: Invoke /implement-sonnet to implement the approved plan

Task: Implement the approved plan
Skill: /implement-sonnet
Input: .task/plan-refined.json

After implementation, reviews run AUTOMATICALLY (no pauses):
  1. /review-sonnet → auto-fix if issues
  2. /review-opus → auto-fix if issues
  3. /review-codex → auto-fix and restart if issues

Pipeline will proceed autonomously until complete.
```

### Commands

| Command | Purpose |
|---------|---------|
| `./scripts/orchestrator.sh` | Show current state and next action |
| `./scripts/orchestrator.sh status` | Show current state details |
| `./scripts/orchestrator.sh reset` | Reset pipeline to idle |
| `./scripts/orchestrator.sh dry-run` | Validate setup |

---

## State Machine

### States

| State | Description | Interactive? |
|-------|-------------|--------------|
| `idle` | No active task | No |
| `requirements_gathering` | /user-story gathering requirements | **YES** |
| `plan_drafting` | Creating initial plan | No |
| `plan_refining` | Refining plan + automated reviews | No |
| `implementing` | /implement-sonnet + automated reviews | No |
| `complete` | Task finished | No |
| `error` | Pipeline error | No |
| `needs_user_input` | Paused for clarification | **YES** |

### Full Flow

```
idle
  ↓
requirements_gathering (/user-story - INTERACTIVE)
  │  Ask questions, get user approval
  ↓ [approved]
plan_drafting (main thread creates plan)
  ↓
plan_refining (refine + AUTOMATED review loop)
  │   sonnet → fix → opus → fix → codex
  │   Loop until approved (no user pauses)
  ↓ [all approved]
implementing (/implement-sonnet + AUTOMATED review loop)
  │   sonnet → fix → opus → fix → codex
  │   Loop until approved (no user pauses)
  ↓ [all approved]
complete
```

---

## Output Formats

### user-story.json (Approved requirements)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Short descriptive title",
  "original_request": "The user's original request text",
  "requirements": {
    "functional": ["req1", "req2"],
    "technical": ["tech1", "tech2"],
    "acceptance_criteria": ["criterion1", "criterion2"]
  },
  "scope": {
    "in_scope": ["item1", "item2"],
    "out_of_scope": ["item1", "item2"]
  },
  "clarifications": [
    {"question": "Q1?", "answer": "A1"}
  ],
  "approved_at": "ISO8601",
  "approved_by": "user"
}
```

### plan.json (Initial plan)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Short descriptive title",
  "description": "What the user wants to achieve",
  "requirements": ["req1", "req2"],
  "created_at": "ISO8601",
  "created_by": "claude"
}
```

### plan-refined.json (Refined plan)
```json
{
  "id": "plan-001",
  "title": "Feature title",
  "description": "What the user wants",
  "requirements": ["req 1", "req 2"],
  "technical_approach": "How to implement",
  "files_to_modify": ["path/to/file.ts"],
  "files_to_create": ["path/to/new.ts"],
  "dependencies": [],
  "estimated_complexity": "low|medium|high",
  "potential_challenges": ["challenge 1"],
  "refined_by": "claude",
  "refined_at": "ISO8601"
}
```

### Review outputs (automated)

Each skill outputs to its own file:

| File | Skill | Model |
|------|-------|-------|
| `.task/review-sonnet.json` | /review-sonnet | sonnet |
| `.task/review-opus.json` | /review-opus | opus |
| `.task/review-codex.json` | /review-codex | codex |

Format:
```json
{
  "status": "approved|needs_changes",
  "review_type": "plan|code",
  "reviewer": "review-sonnet",
  "model": "sonnet",
  "reviewed_at": "ISO8601",
  "summary": "Review summary",
  "needs_clarification": false,
  "clarification_questions": [],
  "issues": [
    {
      "severity": "error|warning|suggestion",
      "category": "code|security|test|plan",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Issue description",
      "suggestion": "How to fix"
    }
  ]
}
```

When `needs_clarification: true`, the pipeline pauses and asks the user the questions in `clarification_questions`.

### impl-result.json (Implementation result)
```json
{
  "status": "completed|failed|needs_clarification",
  "summary": "What was implemented",
  "files_changed": ["path/to/file.ts"],
  "tests_added": ["path/to/test.ts"],
  "questions": []
}
```

---

## Configuration

### Autonomy Settings

In `pipeline.config.json`:

```json
{
  "autonomy": {
    "mode": "autonomous",
    "approvalPoints": {
      "userStory": true,
      "planning": false,
      "implementation": false,
      "review": false,
      "commit": true
    },
    "pauseOnlyOn": ["needs_clarification", "review_loop_exceeded", "unrecoverable_error"],
    "reviewLoopLimit": 10,
    "planReviewLoopLimit": 10,
    "codeReviewLoopLimit": 15
  }
}
```

### Local Config Overrides

Create `pipeline.config.local.json` for local overrides (gitignored):

```json
{
  "autonomy": {
    "planReviewLoopLimit": 5,
    "codeReviewLoopLimit": 10
  }
}
```

---

## Safety Features

### Atomic Locking

The orchestrator uses PID-based locking for destructive operations:

- Lock file: `.task/.orchestrator.lock`
- Only used by `reset` command
- Stale locks automatically cleaned up

### Dry-Run Validation

```bash
./scripts/orchestrator.sh dry-run
```

Checks:
- `.task/` directory exists
- `state.json` valid
- `pipeline.config.json` valid
- Required scripts executable (4 scripts)
- Required skills exist (6 skills)
- Required docs exist
- `.task` in `.gitignore`
- CLI tools available

### Phase-Aware Recovery

```bash
./scripts/recover.sh
```

Respects which phase failed for proper retry.

---

## Codex Session Resume

Codex reviews use `resume --last` for subsequent reviews to save tokens.

- **First review** (new task): Full prompt with all context
- **Subsequent reviews**: Uses `resume --last` + changes summary
- **Session tracking**: `.task/.codex-session-active` marker file
