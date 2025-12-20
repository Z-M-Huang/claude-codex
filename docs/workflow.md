# Pipeline Workflow

## Starting a New Task

1. Create `.task/user-request.txt` with your request
2. Set state: `./scripts/state-manager.sh set plan_drafting ""`
3. Run: `./scripts/orchestrator.sh` (or `./scripts/orchestrator.sh interactive`)

## Execution Modes

### Headless Mode (Default)
```bash
./scripts/orchestrator.sh run
```
- Spawns Claude and Codex as separate subprocesses
- Each subprocess runs with its model from `pipeline.config.json`
- Fully autonomous operation

### Interactive Mode
```bash
./scripts/orchestrator.sh interactive
```
- Sets `CLAUDE_INTERACTIVE=1` environment variable
- Claude scripts output prompts instead of spawning subprocesses
- User executes the prompts in their current Claude Code session
- Codex scripts still spawn subprocesses (for schema enforcement)
- Useful for debugging or controlled execution

---

The orchestrator will:
1. Read `.task/user-request.txt`
2. Run Claude to create initial plan → `.task/plan.json`
3. Transition to `plan_refining`
4. Claude refines plan → `.task/plan-refined.json`
5. Codex reviews → `.task/plan-review.json`
6. Loop until approved, then auto-convert to task
7. Claude implements → `.task/impl-result.json`
8. Codex reviews code → `.task/review-result.json`
9. Loop until approved
10. Complete

---

## Phase 1: Planning (Before Any Code)

### Claude (Plan Creator)
1. Read user request from `.task/user-request.txt`
2. Create initial plan in `.task/plan.json`

### Claude (Plan Refiner)
1. Read `.task/plan.json`
2. Analyze feasibility and clarity
3. Refine requirements, add technical details
4. Identify potential challenges
5. Write refined plan to `.task/plan-refined.json`

### Codex (Plan Reviewer)
1. Read `.task/plan-refined.json`
2. Review for:
   - Completeness (are all requirements clear?)
   - Feasibility (can this be implemented as described?)
   - Potential issues (security, performance, complexity)
   - Over-engineering risks
3. Write review to `.task/plan-review.json`
4. If `needs_changes`: Claude refines again (loop)
5. If `approved`: Proceed to implementation

### Plan Review Loop (Strict Loop-Until-Pass)
```
plan_drafting -> plan_refining -> plan_reviewing ->
                       ^                 |
                       +-- needs changes +
                                         |
                                   approved -> implementing
```

---

## Phase 2: Implementation (After Plan Approved)

### Claude (Coder)
1. Read `.task/current-task.json`
2. Read `docs/standards.md`
3. Implement following standards
4. Write output to `.task/impl-result.json`

### Codex (Code Reviewer)
1. Read `.task/impl-result.json`
2. Read `docs/standards.md`
3. Check against review checklist
4. Write output to `.task/review-result.json`

### Code Review Loop (Strict Loop-Until-Pass)
```
implementing -> reviewing -> complete
     ^              |
     +-- fixing <---+ (needs changes)
```

---

## Output Formats

### plan.json (Claude initial plan)
```json
{
  "id": "plan-001",
  "title": "Feature title",
  "description": "What the user wants",
  "requirements": ["req 1", "req 2"],
  "created_at": "ISO8601",
  "created_by": "claude"
}
```

### plan-refined.json (Claude refined plan)
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

### plan-review.json (Codex plan review)
```json
{
  "status": "approved|needs_changes",
  "summary": "Overall assessment",
  "concerns": [
    {
      "severity": "error|warning|suggestion",
      "area": "requirements|approach|complexity|risks|feasibility",
      "message": "Description of concern",
      "suggestion": "How to address"
    }
  ],
  "reviewed_by": "codex",
  "reviewed_at": "ISO8601"
}
```

### impl-result.json (Claude implementation)
```json
{
  "status": "completed|failed|needs_clarification",
  "summary": "What was implemented",
  "files_changed": ["path/to/file.ts"],
  "tests_added": ["path/to/test.ts"],
  "questions": []
}
```

### review-result.json (Codex code review)
Schema enforced via --output-schema.
See docs/schemas/review-result.schema.json

---

## State Machine

### States
`idle`, `plan_drafting`, `plan_refining`, `plan_reviewing`, `implementing`, `reviewing`, `fixing`, `complete`, `committing`, `error`, `needs_user_input`

### Full Flow
```
idle -> plan_drafting -> plan_refining -> plan_reviewing ->
                               ^                  |
                               +-- needs changes -+
                                                  |
                                            approved
                                                  |
                                                  v
         implementing -> reviewing -> complete -> committing -> idle
               ^              |
               +-- fixing <---+ (needs changes)
```

### State Transitions

| From | To | Trigger |
|------|----|---------|
| `idle` | `plan_drafting` | User sets state with user-request.txt |
| `plan_drafting` | `plan_refining` | Claude creates initial plan |
| `plan_refining` | `plan_reviewing` | Claude refines plan |
| `plan_reviewing` | `plan_refining` | Codex requests changes |
| `plan_reviewing` | `implementing` | Codex approves, auto-converts to task |
| `implementing` | `reviewing` | Claude completes |
| `reviewing` | `complete` | Codex approves |
| `reviewing` | `fixing` | Codex requests changes (needs_changes) |
| `reviewing` | `error` | Codex rejects (rejected) |
| `fixing` | `reviewing` | Claude fixes |
| `complete` | `committing` | Auto-commit enabled |
| `complete` | `idle` | Manual commit mode |
| `committing` | `idle` | Commit done |
| `plan_refining` | `error` | Failure after retries |
| `plan_reviewing` | `error` | Failure after retries |
| `plan_refining` | `needs_user_input` | Claude needs clarification |
| `implementing` | `error` | Failure after retries |
| `implementing` | `needs_user_input` | Claude needs clarification |
| `reviewing` | `error` | Failure after retries |
| `error` | `idle` | User skips task |
| `error` | `plan_drafting` | User retries (plan creation failed) |
| `error` | `plan_refining` | User retries (plan refinement/review failed) |
| `error` | `implementing` | User retries (impl phase) |
| `needs_user_input` | (previous state) | User provides input |

---

## Orchestrator Safety Features

### Atomic Locking

The orchestrator uses PID-based locking to prevent concurrent execution:

- Lock file: `.task/.orchestrator.lock`
- Contains PID of running orchestrator
- Stale locks (dead PID) are automatically cleaned up
- Both `run` and `reset` commands require the lock

```bash
# If you see "Another orchestrator is running" but it's stale:
rm .task/.orchestrator.lock
```

### Dry-Run Validation

Validate setup before running:

```bash
./scripts/validate-config.sh  # Strict config validation
./scripts/orchestrator.sh dry-run
```

Checks:
- `.task/` directory exists
- `state.json` valid (or will be created)
- `pipeline.config.json` valid
- Required scripts executable
- Required docs exist
- `.task` in `.gitignore`
- CLI tools available

### Phase-Aware Recovery

The recovery tool respects which phase failed:

- Errors in `plan_drafting` → retry from `plan_drafting` (re-creates plan from user-request.txt)
- Errors in `plan_refining`/`plan_reviewing` → retry from `plan_refining`
- Errors in `implementing`/`reviewing`/`fixing` → retry from `implementing`

```bash
# Interactive recovery
./scripts/recover.sh

# Check previous state
cat .task/state.json | jq '.previous_state'
```

### Local Config Overrides

Create `pipeline.config.local.json` for local overrides (gitignored):

```json
{
  "autonomy": {
    "planReviewLoopLimit": 15,
    "codeReviewLoopLimit": 20
  }
}
```

---

## Current Sprint Context

Add sprint-specific context here as needed. This section is referenced by the orchestrator when starting new features.
