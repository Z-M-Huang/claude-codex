# Claude Code - Multi-AI Pipeline Project

> **IMPORTANT**: This project uses an **autonomous pipeline** with skill-based sequential reviews. User interaction happens ONLY during the initial requirements gathering phase. After that, the pipeline runs autonomously, fixing reviewer issues automatically.

## Path Reference

When this plugin is installed, paths are resolved as follows:

| Variable | Purpose | Example |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory (scripts, docs, configs) | `~/.claude/plugins/claude-codex/` |
| `${CLAUDE_PROJECT_DIR}` | Your project directory (task state files) | `/path/to/your/project/` |

**Important:** The `.task/` directory is always created in your **project directory**, not the plugin directory. This allows the plugin to work across multiple projects without conflicts.

## Architecture Overview

```
Multi-AI Pipeline (Autonomous Mode)
  │
  ├── Phase 1: Requirements Gathering (INTERACTIVE)
  │     └── /user-story → Clarify requirements, get user approval
  │
  ├── Phase 2: Planning (AUTONOMOUS)
  │     ├── Create initial plan
  │     ├── Refine with technical details
  │     └── Automated review loop (fix issues, no user pauses)
  │
  ├── Phase 3: Implementation (AUTONOMOUS)
  │     ├── /implement-sonnet → Write code
  │     └── Automated review loop (fix issues, no user pauses)
  │
  └── Phase 4: Completion
        └── Report results to user
```

---

## When User Asks to Implement Something

Start with `/multi-ai`:

```
/multi-ai [description of what you want]
```

The pipeline will:
1. **Gather requirements** (interactive) - Ask clarifying questions, get approval
2. **Plan autonomously** - Create and refine plan, auto-fix review issues
3. **Implement autonomously** - Write code, auto-fix review issues
4. **Report results** - Summary of what was done

**The user only interacts during step 1.** Everything after runs automatically.

---

## Skills

Located in `skills/` (plugin root level for `/plugin install` support):

| Skill | Purpose | Model | Phase |
|-------|---------|-------|-------|
| `/multi-ai` | Start pipeline (entry point) | - | All |
| `/user-story` | Gather requirements (interactive) | - | Requirements |
| `/implement-sonnet` | Code implementation | sonnet | Implementation |
| `/review-sonnet` | Fast review | sonnet | Review |
| `/review-opus` | Deep review | opus | Review |
| `/review-codex` | Final review | codex | Review |

### Automated Review Loop

Reviews run **automatically** without user pauses:

```
LOOP until all reviews pass (or max loops reached):
  │
  ├── /review-sonnet → If issues, FIX them automatically
  ├── /review-opus   → If issues, FIX them automatically
  └── /review-codex  → If approved: DONE
                       If issues: FIX and restart loop
```

**Key change from semi-autonomous mode:**
- NO user confirmation between reviews
- Issues are fixed automatically
- Only pause when truly stuck (ambiguity, exceeded limits, unrecoverable errors)

### When Pipeline Pauses

The pipeline ONLY pauses for user input when:

1. **needs_clarification** - Missing information that requires user decision
2. **review_loop_exceeded** - Exceeded max review cycles (configurable)
3. **unrecoverable_error** - Build failures, missing deps that can't be auto-resolved

---

## State Machine

```
idle
  ↓
requirements_gathering (/user-story - INTERACTIVE)
  │  Ask questions, get user approval
  ↓ [approved]
plan_drafting (create initial plan)
  ↓
plan_refining (refine + AUTOMATED review loop)
  │  sonnet → fix → opus → fix → codex
  │  Loop until approved (no user pauses)
  ↓ [all approved]
implementing (/implement-sonnet + AUTOMATED review loop)
  │  sonnet → fix → opus → fix → codex
  │  Loop until approved (no user pauses)
  ↓ [all approved]
complete
```

---

## Shared Knowledge

Read these docs before any work:
- `${CLAUDE_PLUGIN_ROOT}/docs/standards.md` - Coding standards and review criteria
- `${CLAUDE_PLUGIN_ROOT}/docs/workflow.md` - Pipeline process and output formats

---

## Output Formats

### User Story Output
Write to: `.task/user-story.json`

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

### Plan Creation Output
Write to: `.task/plan.json`

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

### Plan Refinement Output
Write to: `.task/plan-refined.json`

```json
{
  "id": "plan-001",
  "title": "Feature title",
  "description": "What the user wants",
  "requirements": ["req 1", "req 2"],
  "technical_approach": "Detailed description of how to implement",
  "files_to_modify": ["path/to/existing/file.ts"],
  "files_to_create": ["path/to/new/file.ts"],
  "dependencies": ["any new packages needed"],
  "estimated_complexity": "low|medium|high",
  "potential_challenges": [
    "Challenge 1 and how to address it",
    "Challenge 2 and how to address it"
  ],
  "refined_by": "claude",
  "refined_at": "ISO8601"
}
```

### Implementation Output
Write to: `.task/impl-result.json`

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

## Review Handling (Autonomous)

### Automated Review Process

For both planning and implementation phases, the review loop runs **automatically**:

1. **Invoke /review-sonnet**
   - If `needs_changes`: FIX issues automatically, continue to step 2
   - If `approved`: continue to step 2

2. **Invoke /review-opus**
   - If `needs_changes`: FIX issues automatically, continue to step 3
   - If `approved`: continue to step 3

3. **Invoke /review-codex**
   - If `approved`: proceed to next phase
   - If `needs_changes`: FIX issues automatically, **restart from step 1**

### Auto-Fix Rules

When fixing reviewer feedback:
- Accept ALL feedback without debate
- Fix root causes, not symptoms
- Run tests after code changes
- Update documentation if architecture changes
- Don't introduce new issues while fixing

---

## Strict Loop-Until-Pass Model

- Reviews loop until all three approve (or max loops reached)
- No debate mechanism - accept all review feedback
- Fix ALL issues raised by any reviewer
- Codex rejection restarts the full review cycle
- **No user pauses** - only pause for genuine blockers

---

## Configuration

See `pipeline.config.json` for settings:

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

**Config field usage:**
- `approvalPoints` - Documents which phases require user approval (enforced by skill instructions)
- `pauseOnlyOn` - Lists conditions that pause autonomous execution (checked in multi-ai skill)
- `planReviewLoopLimit` / `codeReviewLoopLimit` - Phase-specific loop limits (read by multi-ai skill)
