# Pipeline Workflow (Task + Resume Architecture)

## Architecture Overview

This pipeline uses a **Task + Resume architecture** with custom agents:

- **Orchestrator (Main Session)** = Coordinates worker agents via Task tool
- **Worker Agents** = Specialized agents defined in `agents/` directory
- **Resume Capability** = Workers can be resumed with preserved context
- **Codex** = Final review via `/review-codex` skill (invokes Codex CLI)

### Key Principle: Autonomous After Requirements

Once the user approves requirements:
- Pipeline runs **autonomously** without pauses
- Issues found by reviewers are **auto-fixed** by resuming workers
- Only pause for: `needs_clarification`, exceeded limits, or unrecoverable errors

### Custom Agents

| Agent | Model | Purpose | Phase |
|-------|-------|---------|-------|
| `requirements-gatherer` | opus | Business Analyst + PM hybrid | Requirements |
| `planner` | opus | Architect + Fullstack hybrid | Planning |
| `plan-reviewer` | sonnet/opus | Architecture + Security + QA | Plan Review |
| `implementer` | sonnet | Fullstack + TDD + Quality | Implementation |
| `code-reviewer` | sonnet/opus | Security + Performance + QA | Code Review |

### Skills

| Skill | Purpose | Phase |
|-------|---------|-------|
| `/multi-ai` | Pipeline entry point | All |
| `/review-codex` | Final review (Codex CLI) | Review |
| `/cancel-loop` | Cancel active ralph loop | Emergency |

---

## Quick Start with `/multi-ai`

```
/multi-ai Add user authentication with JWT tokens
```

This command handles the entire workflow:

1. **Requirements gathering** (interactive) - requirements-gatherer agent
2. **Planning** (semi-interactive) - planner agent
3. **Plan reviews** (autonomous) - plan-reviewer agents + Codex gate
4. **Implementation** (ralph loop) - implementer agent
5. **Code reviews** (autonomous) - code-reviewer agents + Codex gate
6. **Completion** - Report results

---

## Workflow Phases

### Phase 1: Requirements Gathering (INTERACTIVE)

```
idle
  |
requirements_gathering (requirements-gatherer agent via Task)
  |  - Analyze request
  |  - Ask clarifying questions (via worker signal)
  |  - Get user approval
  | [approved]
plan_drafting
```

The orchestrator spawns the **requirements-gatherer** agent using Task tool:
- Agent writes questions to `.task/worker-signal.json` with `status: needs_input`
- Orchestrator uses AskUserQuestion to get answers
- Orchestrator resumes agent with answers
- Agent writes approved requirements

**Output:** `.task/user-story.json` (approved requirements)

### Phase 2: Planning (SEMI-INTERACTIVE)

```
plan_drafting
  | (planner agent via Task)
plan_refining
  | (planner agent researches and refines)
  | [plan complete]
plan_reviewing
```

**Flow:**
1. Orchestrator spawns **planner** agent via Task tool
2. Agent researches codebase using read-only tools
3. Agent writes implementation plan
4. If risks require user decision, orchestrator asks user

**Output:** `.task/plan-refined.json` (refined plan)

### Phase 3: Plan Reviews (AUTONOMOUS)

```
plan_reviewing
  | AUTOMATED review loop:
  |   1. Task(plan-reviewer, sonnet) -> review-sonnet.json
  |   2. Task(plan-reviewer, opus)   -> review-opus.json
  |   3. Skill(review-codex)         -> review-codex.json <- GATE
  |   Loop until all approved (resume planner for fixes)
  | [all approved]
implementing
```

**Flow:**
1. **Sonnet review** - Task(plan-reviewer, model: sonnet)
   - If needs_changes: resume planner to fix, continue
2. **Opus review** - Task(plan-reviewer, model: opus)
   - If needs_changes: resume planner to fix, continue
3. **Codex review** - Skill(review-codex) - FINAL GATE
   - If approved: proceed to implementation
   - If needs_changes: resume planner, restart from sonnet

### Phase 4: Implementation (RALPH LOOP)

```
implementing
  | (implementer agent via Task, resumable)
implementing_loop
  | AUTOMATED loop:
  |   1. Implement/fix code (resume implementer)
  |   2. Task(code-reviewer, sonnet) -> review-sonnet.json
  |   3. Task(code-reviewer, opus)   -> review-opus.json
  |   4. Skill(review-codex)         -> review-codex.json <- GATE
  |   5. Run tests from plan
  |   Loop until all approved + tests pass
  | [complete]
complete
```

**Flow:**
1. Orchestrator spawns **implementer** agent via Task tool
2. Agent implements code following TDD approach
3. **Automated Review + Test Loop** (no user pauses):
   - Task(code-reviewer, sonnet) -> If issues, resume implementer
   - Task(code-reviewer, opus) -> If issues, resume implementer
   - Skill(review-codex) -> Final gate
   - Run test commands from plan
   - Loop until all pass

The **stop hook** enforces completion criteria:
- All reviews have status: "approved"
- All test commands pass

---

## Task + Resume Pattern

### Spawning Workers

```javascript
// First invocation - spawn new agent
Task(
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "[Agent prompt from requirements-gatherer.md]..."
)
// Returns: agentId

// Resume with preserved context
Task(
  resume: agentId,
  prompt: "User answered: [answers]. Continue from where you left off."
)
```

### When to Resume vs Fresh Spawn

| Situation | Action |
|-----------|--------|
| Continue requirements Q&A | Resume |
| Planner fixing review feedback | Resume |
| Implementer fixing issues | Resume |
| Reviews (independent analysis) | Fresh spawn |

### Worker Signal Protocol

Workers communicate via `.task/worker-signal.json`:

```json
{
  "worker_id": "requirements-gatherer-abc123",
  "phase": "requirements",
  "status": "needs_input|completed|error|in_progress",
  "questions": [
    {
      "id": "q1",
      "question": "Which authentication method?",
      "options": ["JWT", "Session cookies"],
      "context": "Plan requires auth but method unspecified"
    }
  ],
  "agent_id": "abc123",
  "timestamp": "ISO8601"
}
```

---

## Automated Review Loop

This is the core automation. No user pauses between reviews:

```
LOOP_COUNT = 0
MAX_LOOPS = <from pipeline.config.json>
  - Plan reviews: autonomy.planReviewLoopLimit (default: 10)
  - Code reviews: autonomy.codeReviewLoopLimit (default: 15)

WHILE LOOP_COUNT < MAX_LOOPS:

    1. SPAWN Task(plan-reviewer OR code-reviewer, model: sonnet)
       READ .task/review-sonnet.json
       IF needs_changes: RESUME worker to FIX

    2. SPAWN Task(plan-reviewer OR code-reviewer, model: opus)
       READ .task/review-opus.json
       IF needs_changes: RESUME worker to FIX

    3. INVOKE Skill(review-codex)
       READ .task/review-codex.json
       IF approved: EXIT loop
       IF needs_changes: RESUME worker, INCREMENT LOOP_COUNT, RESTART

    IF needs_clarification in any review:
        PAUSE - ask user (AskUserQuestion)
        After response, resume and continue

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

ACTION: Implement the approved plan (implementer agent)

Task: Implement the approved plan using Task tool with implementer agent
Agent: implementer (sonnet model)
Input: .task/plan-refined.json

After implementation, run SEQUENTIAL reviews using Task tool:
  1. Task(code-reviewer, sonnet) -> review-sonnet.json
  2. Task(code-reviewer, opus)   -> review-opus.json
  3. /review-codex (Codex final gate)
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
| `requirements_gathering` | requirements-gatherer agent | **YES** |
| `plan_drafting` | Creating initial plan | No |
| `plan_refining` | Refining plan + reviews | No |
| `plan_reviewing` | Plan review loop | No |
| `implementing` | Simple implementation | No |
| `implementing_loop` | Ralph loop implementation | No |
| `complete` | Task finished | No |
| `error` | Pipeline error | No |
| `needs_user_input` | Paused for clarification | **YES** |

### Full Flow

```
idle
  |
requirements_gathering (requirements-gatherer agent - INTERACTIVE)
  |  Resume for Q&A iterations
  | [approved]
plan_drafting
  |
plan_refining (planner agent)
  |
plan_reviewing (AUTOMATED review loop)
  |   Task(plan-reviewer, sonnet) -> resume planner
  |   Task(plan-reviewer, opus)   -> resume planner
  |   Skill(review-codex)         -> resume planner if needed
  |   Loop until approved (no user pauses)
  | [all approved]
implementing / implementing_loop (implementer agent)
  |   Task(code-reviewer, sonnet) -> resume implementer
  |   Task(code-reviewer, opus)   -> resume implementer
  |   Skill(review-codex)         -> resume implementer if needed
  |   Run tests
  |   Loop until approved + tests pass (no user pauses)
  | [all approved + tests pass]
complete
```

---

## Output Formats

### user-story.json (Approved requirements)
```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Short descriptive title",
  "requirements": {
    "functional": ["req1", "req2"],
    "non_functional": ["perf1", "security1"],
    "constraints": ["constraint1"]
  },
  "acceptance_criteria": [
    {
      "id": "AC1",
      "scenario": "User logs in",
      "given": "User is on login page",
      "when": "User enters valid credentials",
      "then": "User is redirected to dashboard"
    }
  ],
  "scope": {
    "in_scope": ["item1"],
    "out_of_scope": ["item1"]
  },
  "test_criteria": {
    "commands": ["npm test"],
    "success_pattern": "All tests passed",
    "failure_pattern": "FAILED"
  },
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10
  },
  "approved_at": "ISO8601",
  "approved_by": "user"
}
```

### plan-refined.json (Refined plan)
```json
{
  "id": "plan-YYYYMMDD-HHMMSS",
  "title": "Feature title",
  "technical_approach": {
    "pattern": "Repository pattern",
    "rationale": "Existing codebase uses this"
  },
  "steps": [
    {
      "id": 1,
      "phase": "implementation",
      "file": "path/to/file.ts",
      "action": "modify",
      "description": "Add user service"
    }
  ],
  "files_to_modify": ["path/to/file.ts"],
  "files_to_create": ["path/to/new.ts"],
  "test_plan": {
    "commands": ["npm test", "npm run lint"],
    "success_pattern": "All tests passed",
    "failure_pattern": "FAILED"
  },
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10
  },
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>"
}
```

### Review outputs

Each reviewer outputs to its designated file:

| File | Reviewer | Model |
|------|----------|-------|
| `.task/review-sonnet.json` | plan-reviewer/code-reviewer | sonnet |
| `.task/review-opus.json` | plan-reviewer/code-reviewer | opus |
| `.task/review-codex.json` | /review-codex skill | codex |

Format:
```json
{
  "id": "review-YYYYMMDD-HHMMSS",
  "reviewer": "plan-reviewer|code-reviewer",
  "model": "sonnet|opus",
  "status": "approved|needs_changes|needs_clarification",
  "summary": "Review summary",
  "scores": {
    "security": 8,
    "quality": 9,
    "overall": 8
  },
  "findings": [
    {
      "id": "F1",
      "category": "security",
      "severity": "high",
      "title": "Missing input validation",
      "recommendation": "Add validation"
    }
  ],
  "blockers": ["Critical issues"],
  "reviewed_at": "ISO8601"
}
```

### impl-result.json (Implementation result)
```json
{
  "id": "impl-YYYYMMDD-HHMMSS",
  "plan_implemented": "plan-YYYYMMDD-HHMMSS",
  "status": "complete|partial|failed",
  "files_modified": ["path/to/file.ts"],
  "files_created": ["path/to/new.ts"],
  "tests": {
    "written": 5,
    "passing": 5,
    "failing": 0
  },
  "completed_at": "ISO8601"
}
```

### loop-state.json (Ralph Loop state)
```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 10,
  "implementer_agent_id": "abc123",
  "completion_promise": "<promise>IMPLEMENTATION_COMPLETE</promise>",
  "started_at": "ISO8601"
}
```

---

## Configuration

### Autonomy Settings

In `pipeline.config.json`:

```json
{
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
- Required scripts executable
- Required skills exist (multi-ai, review-codex, cancel-loop)
- Required agents exist (5 agents)
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

---

## Emergency Controls

If the loop is stuck:

1. **Cancel command:** `/cancel-loop`
2. **Delete state file:** `rm .task/loop-state.json`
3. **Max iterations:** Loop auto-stops at limit
