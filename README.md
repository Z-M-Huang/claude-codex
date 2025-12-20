# Multi-AI Orchestration Pipeline

A development pipeline that orchestrates multiple AI agents to plan, implement, review, and iterate on code changes.

- **Claude Code** - Orchestrator + Plan Creator + Plan Refiner + Implementation Coder
- **Codex CLI** - Plan Reviewer + Code Reviewer

> **Interested in running 3 AIs?** Check out [claude-codex-gemini](https://github.com/Z-M-Huang/claude-codex-gemini) which adds Gemini as a dedicated orchestrator.

## How It Works

### Phase 1: Planning

```
User Request → Claude (draft plan) → Claude (refine plan) → Codex (review plan)
                                           ↑                       ↓
                                           └──── needs changes ────┘
                                                                   ↓
                                                              approved
                                                                   ↓
                                                          auto-convert to task
```

### Phase 2: Implementation

```
Task → Claude (implement) → Codex (review code) → approved → commit
              ↑                     ↓
              └──── fix ←─── needs changes
```

1. User creates `.task/user-request.txt` with feature description
2. Set state to `plan_drafting` and run orchestrator
3. Claude creates an initial plan (`plan.json`)
4. Claude refines the plan with technical details (`plan-refined.json`)
5. Codex reviews the plan for completeness and feasibility
6. If plan needs changes, Claude refines again (loop until approved, max 10 iterations)
7. Once plan approved, automatically converts to task
8. Claude implements following project standards
9. Codex reviews code against the checklist
10. If code needs changes, Claude fixes and Codex re-reviews
11. Loop until approved (max 15 iterations)
12. Commit on approval

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) installed and authenticated
- `jq` for JSON processing

## Quick Start

### Option A: Use as Template (New Projects)

1. **Clone/copy this repository:**

   ```bash
   git clone https://github.com/Z-M-Huang/claude-codex.git my-project
   cd my-project
   rm -rf .git
   git init
   ```

2. **Customize for your project:**

   ```bash
   # Edit standards to match your project
   vim docs/standards.md

   # Update workflow documentation
   vim docs/workflow.md

   # Configure models and autonomy level
   vim pipeline.config.json
   ```

3. **Run setup (detects workflow conflicts):**

   ```bash
   ./scripts/setup.sh
   ```

   This checks for global `~/.claude/CLAUDE.md` that might conflict with the orchestrator workflow and lets you choose:
   - **Orchestrator Only**: Force all implementations through the multi-AI pipeline
   - **Hybrid Mode**: Allow both your normal workflow and the orchestrator

4. **Initialize the pipeline:**

   ```bash
   ./scripts/state-manager.sh init

   # Tell git to ignore local changes to state files
   git update-index --skip-worktree .task/state.json .task/tasks.json
   ```

5. **Create a user request:**

   ```bash
   cat > .task/user-request.txt << 'EOF'
   Add user authentication with JWT tokens.
   - POST /api/login endpoint
   - POST /api/logout endpoint
   - JWT token validation middleware
   - Unit tests for auth functions
   EOF
   ```

6. **Run the planning phase:**

   ```bash
   ./scripts/state-manager.sh set plan_drafting ""
   ./scripts/orchestrator.sh
   # Pipeline automatically:
   # 1. Creates plan from user request
   # 2. Refines the plan
   # 3. Reviews the plan (loops until approved)
   # 4. Converts to task when approved
   # 5. Continues to implementation
   ```

7. **Or run implementation only (if task exists):**
   ```bash
   ./scripts/orchestrator.sh
   ```

## Execution Modes

The orchestrator supports two execution modes:

### Headless Mode (Default)

Spawns Claude and Codex as subprocesses. Use when running the pipeline autonomously:

```bash
./scripts/orchestrator.sh run
# or just
./scripts/orchestrator.sh
```

### Interactive Mode

Outputs prompts for the current Claude Code session to execute instead of spawning subprocesses. Use when you want to run the pipeline within an existing Claude Code conversation:

```bash
./scripts/orchestrator.sh interactive
```

In interactive mode:
- Claude tasks output the full prompt for you to execute in your current session
- You manually run the task and ensure the output file is created
- Codex tasks still spawn subprocesses (for schema enforcement)
- Useful for debugging or when you want more control over execution

### Option B: Adopt for Existing Projects

1. **Copy the pipeline files to your project:**

   ```bash
   # From the claude-codex directory
   cp -r scripts/ /path/to/your/project/
   cp -r docs/ /path/to/your/project/
   cp pipeline.config.json /path/to/your/project/
   cp CLAUDE.md AGENTS.md /path/to/your/project/
   mkdir -p /path/to/your/project/.task
   ```

2. **Add to .gitignore:**

   ```bash
   echo ".task/*" >> /path/to/your/project/.gitignore
   echo "!.task/state.json" >> /path/to/your/project/.gitignore
   echo "!.task/tasks.json" >> /path/to/your/project/.gitignore
   ```

3. **Customize docs/standards.md for your project:**

   Update the coding standards to match your existing conventions:

   - Naming conventions (files, classes, functions)
   - Code style rules
   - Testing requirements
   - Security requirements

4. **Update the agent config files:**

   Edit `CLAUDE.md` and `AGENTS.md` to reference your project-specific context.

5. **Configure the pipeline:**

   Edit `pipeline.config.json`:

   ```json
   {
     "autonomy": {
       "mode": "semi-autonomous",
       "planReviewLoopLimit": 10,
       "codeReviewLoopLimit": 15
     },
     "models": {
       "coder": { "model": "claude-opus-4.5" },
       "reviewer": { "model": "gpt-5.2-codex" }
     }
   }
   ```

6. **Initialize and run:**
   ```bash
   cd /path/to/your/project
   ./scripts/state-manager.sh init
   ```

## After Cloning

The `.task/` folder contains initial state files that are tracked in git but should not have local changes committed. After cloning, run:

```bash
git update-index --skip-worktree .task/state.json .task/tasks.json
```

This tells git to ignore your local modifications to these files.

**To check skip-worktree status:**

```bash
git ls-files -v .task/ | grep '^S'  # S = skip-worktree is set
```

**To undo (if you need to commit changes):**

```bash
git update-index --no-skip-worktree .task/state.json
```

## Project Structure

```
your-project/
├── pipeline.config.json      # Pipeline configuration
├── CLAUDE.md                 # Claude coder/orchestrator instructions
├── AGENTS.md                 # Codex reviewer instructions
├── docs/
│   ├── standards.md          # Coding + review standards
│   ├── workflow.md           # Process documentation
│   └── schemas/
│       ├── review-result.schema.json   # Code review output schema
│       └── plan-review.schema.json     # Plan review output schema
├── scripts/
│   ├── orchestrator.sh       # Main pipeline loop (run/interactive/status/reset/dry-run)
│   ├── run-claude.sh         # Claude implementation executor
│   ├── run-claude-plan.sh    # Claude plan refinement executor
│   ├── run-claude-plan-create.sh  # Claude plan creation executor
│   ├── run-codex-review.sh   # Codex code review executor
│   ├── run-codex-plan-review.sh  # Codex plan review executor
│   ├── plan-to-task.sh       # Convert approved plan to task
│   ├── state-manager.sh      # State management
│   ├── validate-config.sh    # Config validation
│   ├── recover.sh            # Recovery tool
│   └── setup.sh              # Setup wizard (workflow conflict detection)
└── .task/                    # Runtime state (gitignored except state files)
    ├── state.json            # Pipeline state
    ├── tasks.json            # Task queue
    ├── user-request.txt      # User's feature request (input)
    ├── plan.json             # Initial plan (Claude creates)
    ├── plan-refined.json     # Refined plan (Claude creates)
    ├── plan-review.json      # Plan review (Codex creates)
    ├── current-task.json     # Active task
    ├── impl-result.json      # Implementation output
    └── review-result.json    # Code review output
```

## Usage

### Starting from a User Request

**Step 1: Create the user request file**

```bash
cat > .task/user-request.txt << 'EOF'
Add user authentication with JWT-based tokens.
Requirements:
- POST /api/login endpoint
- POST /api/logout endpoint
- JWT token validation middleware
- Unit tests for auth functions
EOF
```

**Step 2: Start the pipeline from plan drafting**

```bash
./scripts/state-manager.sh set plan_drafting ""
./scripts/orchestrator.sh
```

The pipeline will automatically:
1. Create initial plan from user request
2. Transition to plan refinement
3. Refine the plan
4. Review the plan (loop until approved)
5. Convert approved plan to task
6. Implement the task
7. Review implementation (loop until approved)
8. Complete (or commit if autoCommit enabled)

### Check Status

```bash
./scripts/orchestrator.sh status
```

### Run in Interactive Mode

```bash
./scripts/orchestrator.sh interactive
```

See [Execution Modes](#execution-modes) above for details.

### Dry Run (Validation)

Validate your pipeline setup without running it:

```bash
# Basic validation (JSON syntax, scripts, docs, CLI tools)
./scripts/orchestrator.sh dry-run

# Strict config validation (all required keys present)
./scripts/validate-config.sh
```

**dry-run** checks:
- `.task/` directory and state file validity
- `pipeline.config.json` valid JSON syntax
- Required scripts present and executable (all 11 scripts)
- Required docs (`standards.md`, `workflow.md`)
- `.task` in `.gitignore`
- CLI tools (`jq` required, `claude`/`codex` optional)
- Global CLAUDE.md conflict detection (warns if setup not run)

**validate-config.sh** checks:
- All required top-level keys present
- All required nested keys (autonomy, models, etc.)
- Correct value types (numbers, booleans)

### Recovery

```bash
# Interactive recovery menu
./scripts/recover.sh

# Or reset directly
./scripts/orchestrator.sh reset
```

### Handling User Input Requests

If Claude needs clarification, the pipeline pauses with `needs_user_input` state:

```bash
# Check what questions need answering
cat .task/state.json | jq '.previous_state'  # See which phase
cat .task/plan-refined.json | jq '.questions'  # Plan phase questions
cat .task/impl-result.json | jq '.questions'   # Implementation questions

# After providing answers, resume:
./scripts/state-manager.sh set plan_refining plan-001  # or implementing task-001
./scripts/orchestrator.sh
```

## Configuration

### pipeline.config.json

| Setting                             | Description                                   | Default           |
| ----------------------------------- | --------------------------------------------- | ----------------- |
| `autonomy.mode`                     | `autonomous`, `semi-autonomous`, `supervised` | `semi-autonomous` |
| `autonomy.reviewLoopLimit`          | Max review iterations (legacy, fallback)      | `10`              |
| `autonomy.planReviewLoopLimit`      | Max plan review iterations                    | `10`              |
| `autonomy.codeReviewLoopLimit`      | Max code review iterations                    | `15`              |
| `autonomy.autoCommit`               | Auto-commit on approval                       | `false`           |
| `errorHandling.autoResolveAttempts` | Retries before pausing                        | `3`               |
| `models.orchestrator.model`         | Claude orchestrator model                     | `claude-opus-4.5` |
| `models.coder.model`                | Claude coder model                            | `claude-opus-4.5` |
| `models.reviewer.model`             | Codex reviewer model                          | `gpt-5.2-codex`   |
| `debate.enabled`                    | Debate mechanism (disabled)                   | `false`           |

### Local Config Overrides

Create `pipeline.config.local.json` to override settings without modifying the tracked config:

```json
{
  "autonomy": {
    "planReviewLoopLimit": 5,
    "codeReviewLoopLimit": 10
  }
}
```

This file is gitignored and will be merged on top of `pipeline.config.json`.

### Autonomy Modes

| Mode              | Planning | Implementation | Review | Commit     |
| ----------------- | -------- | -------------- | ------ | ---------- |
| `autonomous`      | Auto     | Auto           | Auto   | Auto       |
| `semi-autonomous` | Auto     | Auto           | Auto   | **Manual** |
| `supervised`      | Manual   | Manual         | Manual | Manual     |

## Customization

### Adding Project-Specific Standards

Edit `docs/standards.md`:

```markdown
# Project Standards

## Coding Standards

- Use TypeScript strict mode
- All functions must have JSDoc comments
- No console.log in production code

## Review Checklist

### Must Check (severity: error)

- No hardcoded secrets
- All API endpoints have auth middleware
- Database queries use parameterized statements
```

### Modifying Review Schema

Edit `docs/schemas/review-result.schema.json` to add custom checklist items:

```json
{
  "checklist": {
    "properties": {
      "security": { "enum": ["PASS", "WARN", "FAIL"] },
      "performance": { "enum": ["PASS", "WARN", "FAIL"] },
      "your_custom_check": { "enum": ["PASS", "WARN", "FAIL"] }
    }
  }
}
```

## Troubleshooting

### Pipeline stuck in error state

```bash
./scripts/recover.sh
# Select option 1 to reset to idle
```

### Claude not creating output file

Check that Claude has the right permissions:

```bash
# Verify CLAUDE.md instructions mention the output file
grep "impl-result.json" CLAUDE.md
```

### Codex review failing

Verify the schema is valid:

```bash
jq empty docs/schemas/review-result.schema.json
```

### View error logs

```bash
ls -la .task/errors/
cat .task/errors/error-*.json | jq
```

## License

GPL-3.0 license
