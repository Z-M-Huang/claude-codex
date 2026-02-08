# Pipeline Workflow (Task + Hook Architecture)

## Architecture Overview

This pipeline uses a **Task + Hook architecture** with a persistent pipeline team:

- **Team (Lifecycle)** - Persistent pipeline team provides TaskCreate/TaskUpdate/TaskList access
- **Tasks (Primary)** - Structural enforcement via `blockedBy` dependencies
- **Hook (Guidance)** - Validates output, transitions state, injects reminders
- **Main Thread** - Orchestrator that handles user input and creates dynamic tasks
- **Codex** - Final review gate via `codex-reviewer` agent

### Custom Agents

| Agent | Model | Purpose | Phase |
|-------|-------|---------|-------|
| `requirements-gatherer` | opus | Business Analyst + PM hybrid | Requirements |
| `planner` | opus | Architect + Fullstack hybrid | Planning |
| `plan-reviewer` | sonnet/opus | Architecture + Security + QA | Plan Review |
| `implementer` | sonnet | Fullstack + TDD + Quality | Implementation |
| `code-reviewer` | sonnet/opus | Security + Performance + QA | Code Review |
| `codex-reviewer` | external | Final gate (invokes Codex CLI) | Final Review |

---

## Quick Start

```
/multi-ai Add user authentication with JWT tokens
```

This command handles the entire workflow:

1. **Requirements gathering** (interactive) - requirements-gatherer agent
2. **Planning** (semi-interactive) - planner agent
3. **Plan reviews** (sequential) - plan-reviewer agents + Codex gate
4. **Implementation** - implementer agent
5. **Code reviews** (sequential) - code-reviewer agents + Codex gate
6. **Completion** - Report results

---

## State Flow

```
idle → requirements_gathering → plan_drafting
  → plan_review_sonnet ↔ fix_plan_sonnet
  → plan_review_opus ↔ fix_plan_opus
  → plan_review_codex ↔ fix_plan_codex
  → implementation
  → code_review_sonnet ↔ fix_code_sonnet
  → code_review_opus ↔ fix_code_opus
  → code_review_codex ↔ fix_code_codex
  → complete
```

Max 10 re-reviews per reviewer before escalating to user.

---

## Task Chain

After creating the pipeline team (Step 1.5) and verifying task tools (Step 1.6), create 9 tasks via `TaskCreate`, then chain via `TaskUpdate(addBlockedBy)`:

```
T1 = TaskCreate(subject: "Gather requirements")
T2 = TaskCreate(subject: "Create implementation plan")    → TaskUpdate(T2.id, addBlockedBy: [T1.id])
T3 = TaskCreate(subject: "Plan Review - Sonnet")          → TaskUpdate(T3.id, addBlockedBy: [T2.id])
T4 = TaskCreate(subject: "Plan Review - Opus")            → TaskUpdate(T4.id, addBlockedBy: [T3.id])
T5 = TaskCreate(subject: "Plan Review - Codex")           → TaskUpdate(T5.id, addBlockedBy: [T4.id])  <- GATE
T6 = TaskCreate(subject: "Implementation")                → TaskUpdate(T6.id, addBlockedBy: [T5.id])
T7 = TaskCreate(subject: "Code Review - Sonnet")          → TaskUpdate(T7.id, addBlockedBy: [T6.id])
T8 = TaskCreate(subject: "Code Review - Opus")            → TaskUpdate(T8.id, addBlockedBy: [T7.id])
T9 = TaskCreate(subject: "Code Review - Codex")           → TaskUpdate(T9.id, addBlockedBy: [T8.id])  <- GATE
```

Store returned IDs in `.task/pipeline-tasks.json`. See SKILL.md Step 2 for full details.

### Dynamic Fix Tasks

When a review returns `needs_changes`:

1. `fix = TaskCreate(...)` then `TaskUpdate(fix.id, addBlockedBy: [review_id])`
2. `rerev = TaskCreate(...)` then `TaskUpdate(rerev.id, addBlockedBy: [fix.id])`
3. `if next_reviewer_id is not null: TaskUpdate(next_reviewer_id, addBlockedBy: [rerev.id])` — skip for Codex (final reviewer)

**Note:** Codex has no next reviewer. When Codex needs_changes, fix + re-review tasks are created, but no downstream blocker is updated.

---

## Output Files

| File | Description |
|------|-------------|
| `.task/user-story.json` | Approved requirements |
| `.task/plan-refined.json` | Implementation plan |
| `.task/review-sonnet.json` | Sonnet plan review |
| `.task/review-opus.json` | Opus plan review |
| `.task/review-codex.json` | Codex plan review |
| `.task/impl-result.json` | Implementation result |
| `.task/code-review-sonnet.json` | Sonnet code review |
| `.task/code-review-opus.json` | Opus code review |
| `.task/code-review-codex.json` | Codex code review |
| `.task/state.json` | Pipeline state |
| `.task/pipeline-tasks.json` | Team name + Task ID mapping |

---

## Review Statuses

**Plan reviews:**
- `approved` - Proceed to next reviewer
- `needs_changes` - Fix and re-review (same reviewer)
- `needs_clarification` - Ask user

**Code reviews:**
- `approved` - Proceed to next reviewer
- `needs_changes` - Fix and re-review (same reviewer)
- `rejected` - Major rework required

**Codex plan `rejected`** is terminal - escalate to user.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `bun orchestrator.ts` | Show current state and next action |
| `bun orchestrator.ts status` | Show current state details |
| `bun orchestrator.ts reset` | Reset pipeline to idle |
| `bun orchestrator.ts dry-run` | Validate setup |
| `bun orchestrator.ts phase` | Output current phase token |

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset`
4. **Check phase:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" phase`

---

## Default Settings

| Setting | Value |
|---------|-------|
| Max iterations per reviewer | 10 |
| Plan review limit | 10 |
| Code review limit | 15 |
