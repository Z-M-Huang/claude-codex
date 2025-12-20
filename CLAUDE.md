# Claude Code - Multi-AI Pipeline Project

> **IMPORTANT**: This project uses a multi-AI orchestrator workflow, NOT the standard PLAN.md workflow from global CLAUDE.md. The instructions below override global settings for this project.

## When User Asks to Implement Something

If a user directly asks you to implement a feature or make changes in this project, guide them to use the orchestrator workflow:

```
This project uses a multi-AI orchestrator (Claude + Codex) for implementations.

To implement your request:

1. Create your request:
   echo "Your feature description here" > .task/user-request.txt

2. Start the pipeline:
   ./scripts/state-manager.sh set plan_drafting ""
   ./scripts/orchestrator.sh

The pipeline will:
- Create and refine a plan (Claude)
- Review the plan (Codex) - loops until approved
- Implement the code (Claude)
- Review the code (Codex) - loops until approved

For quick status: ./scripts/orchestrator.sh status
For recovery: ./scripts/recover.sh

For interactive mode (outputs prompts instead of spawning subprocesses):
   ./scripts/orchestrator.sh interactive
```

Do NOT use the PLAN.md workflow for this project. The orchestrator handles planning, implementation, and review automatically.

### Execution Modes

**Headless mode** (`./scripts/orchestrator.sh run`): Spawns Claude/Codex subprocesses autonomously.

**Interactive mode** (`./scripts/orchestrator.sh interactive`): When `CLAUDE_INTERACTIVE=1` is set, Claude scripts output prompts for you to execute in the current session instead of spawning subprocesses.

---

## Agent Instructions (When Invoked by Orchestrator)

You are the **implementation agent** in a two-AI development pipeline.

## Your Three Roles

### Role 1: Plan Creator
When invoked via `run-claude-plan-create.sh`:
- Read user request from script argument
- Create initial plan in `.task/plan.json`
- Exit (orchestrator handles state transition)

### Role 2: Plan Refiner
When invoked via `run-claude-plan.sh` (state is `plan_refining`):
- Read initial plan from `.task/plan.json`
- Read any previous review feedback from `.task/plan-review.json`
- Add technical details
- Write to `.task/plan-refined.json`
- Exit (orchestrator handles state transition)

### Role 3: Code Implementer
When invoked via `run-claude.sh` (state is `implementing` or `fixing`):
- Read task from `.task/current-task.json`
- Read any previous review feedback from `.task/review-result.json`
- Implement following standards
- Write to `.task/impl-result.json`
- Exit (orchestrator handles state transition)

## Important: Orchestrator Controls State
- You do NOT modify `.task/state.json`
- The orchestrator script handles all state transitions
- Your job is to complete the task and write output files

## Shared Knowledge
Read these docs before any work:
- `docs/standards.md` - Coding standards and review criteria
- `docs/workflow.md` - Pipeline process and output formats

## Strict Loop-Until-Pass Model
- Reviews loop until Codex approves
- No debate mechanism - accept all review feedback
- Fix ALL issues raised by reviewer
- Loop limits: planReviewLoopLimit (10), codeReviewLoopLimit (15)

## Pipeline Integration

### Plan Creation Output
Write to: `.task/plan.json`

Format:
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

Format:
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

Format:
```json
{
  "status": "completed|failed|needs_clarification",
  "summary": "What was implemented",
  "files_changed": ["path/to/file.ts"],
  "tests_added": ["path/to/test.ts"],
  "questions": []
}
```

## Handling Review Feedback

### On Plan Review Feedback
If invoked after plan review feedback:
1. Read `.task/plan-review.json`
2. Address ALL concerns raised by Codex
3. Update `.task/plan-refined.json` with improvements

### On Code Review Feedback
If invoked after code review feedback:
1. Read `.task/review-result.json`
2. Address ALL `error` severity issues
3. Address ALL `warning` severity issues
4. Consider `suggestion` severity issues

## Asking for Clarification

If the plan or task is too ambiguous, add to your output:
```json
{
  "needs_clarification": true,
  "questions": [
    "Question 1 for the user?",
    "Question 2 for the user?"
  ]
}
```

Only use this for truly blocking questions.
