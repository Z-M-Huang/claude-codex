#!/bin/bash
# Setup script for multi-AI pipeline
# Detects global CLAUDE.md conflicts and configures workflow preferences

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source state manager for PLUGIN_ROOT and TASK_DIR
source "$SCRIPT_DIR/state-manager.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
PREFERENCES_FILE="$TASK_DIR/preferences.json"

# Check for global CLAUDE.md
check_global_claude_md() {
  if [[ -f "$GLOBAL_CLAUDE_MD" ]]; then
    echo -e "${YELLOW}⚠ Detected global CLAUDE.md at:${NC}"
    echo -e "  $GLOBAL_CLAUDE_MD"
    echo ""
    echo -e "${CYAN}This project uses a multi-AI orchestrator workflow (Claude + Codex)${NC}"
    echo -e "${CYAN}which differs from the standard PLAN.md workflow.${NC}"
    echo ""
    echo -e "Your global CLAUDE.md may instruct Claude Code to use a different"
    echo -e "workflow (like PLAN.md), which could conflict with this project."
    echo ""
    return 0  # Found
  else
    echo -e "${GREEN}✓ No global CLAUDE.md detected${NC}"
    echo ""
    return 1  # Not found
  fi
}

# JSON tool path (cross-platform jq replacement)
JSON_TOOL="bun $PLUGIN_ROOT/scripts/json-tool.ts"

# Get existing preference
get_existing_preference() {
  if [[ -f "$PREFERENCES_FILE" ]]; then
    $JSON_TOOL get "$PREFERENCES_FILE" ".workflow_mode // empty" 2>/dev/null
  fi
}

# Save preference
save_preference() {
  local mode="$1"
  mkdir -p "$TASK_DIR"

  if [[ -f "$PREFERENCES_FILE" ]]; then
    cp "$PREFERENCES_FILE" "$PREFERENCES_FILE.tmp"
    $JSON_TOOL set "$PREFERENCES_FILE.tmp" "workflow_mode=$mode" "configured_at@=now"
    cp "$PREFERENCES_FILE.tmp" "$PREFERENCES_FILE" && rm -f "$PREFERENCES_FILE.tmp"
  else
    cat > "$PREFERENCES_FILE" << EOF
{
  "workflow_mode": "$mode",
  "configured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  fi
}

# Update CLAUDE.md based on preference
update_claude_md() {
  local mode="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"

  case "$mode" in
    orchestrator)
      cat > "$project_dir/CLAUDE.md" << 'CLAUDE_EOF'
# Claude Code - Multi-AI Pipeline Project

> **IMPORTANT**: This project uses a subagent-based orchestrator workflow. The main Claude Code thread coordinates subagents for planning, implementation, and internal reviews. Codex is called only at key checkpoints.

## Architecture Overview

```
Main Claude Code Thread (Orchestrator)
  │
  ├── Subagents (do the work):
  │     ├── planner (opus)      → Drafts and refines plans
  │     ├── researcher (opus)   → Gathers codebase context
  │     ├── implementer (opus)  → Writes code
  │     ├── code-reviewer-sonnet + code-reviewer-opus     → Internal code quality (parallel)
  │     ├── security-reviewer-sonnet + security-reviewer-opus → Security assessment (parallel)
  │     └── test-reviewer-sonnet + test-reviewer-opus     → Test coverage (parallel)
  │
  └── Codex (final reviews only):
        ├── End of planning phase (after 2 code reviewers approve)
        └── End of implementation phase (after all 6 reviewers approve)
```

---

## Path Reference

Scripts and configs are in the plugin directory, task state is in your project:
- Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/`
- Docs: `${CLAUDE_PLUGIN_ROOT}/docs/`
- Task state: `.task/` (in this project directory)

---

## When User Asks to Implement Something

Guide users to use the orchestrator workflow:

```
This project uses a subagent-based orchestrator (Claude subagents + Codex reviews).

To implement your request:

1. Create your request:
   echo "Your feature description here" > .task/user-request.txt

2. Start the pipeline:
   "${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting ""
   "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh"

The pipeline will:
- Create and refine a plan (planner + researcher subagents)
- Run internal plan reviews (code-reviewer-sonnet + code-reviewer-opus in parallel)
- Final plan review (Codex)
- Implement the code (implementer subagent)
- Run internal code reviews (6 reviewers in parallel: code/security/test × sonnet/opus)
- Final code review (Codex)

For status: "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh" status
For recovery: "${CLAUDE_PLUGIN_ROOT}/scripts/recover.sh"
```

---

## How the Orchestrator Works

The orchestrator displays the current state and what action to take:

```bash
$ "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh"
[INFO] Current state: plan_drafting

ACTION: Invoke 'planner' subagent

Task: Create initial plan from user request
Input: .task/user-request.txt
Output: .task/plan.json

After completion, transition state:
  "${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_refining "$(bun ${CLAUDE_PLUGIN_ROOT}/scripts/json-tool.ts get .task/plan.json .id)"
```

### Workflow Steps

1. **Read the ACTION** - See which subagent to invoke
2. **Invoke the subagent** - Use Task tool with the specified agent
3. **Write output file** - Subagent writes to the specified output location
4. **Transition state** - Run the shown state-manager command
5. **Run orchestrator again** - See the next action

---

## Subagents

Located in `.claude/agents/`:

| Subagent | Purpose | When Invoked |
|----------|---------|--------------|
| `planner` | Drafts and refines plans | `plan_drafting`, `plan_refining` |
| `researcher` | Gathers codebase context | `plan_refining` |
| `implementer` | Writes code | `implementing`, `fixing` |
| `code-reviewer-sonnet` | Quick code/plan review | After plan refinement, after implementation |
| `code-reviewer-opus` | Deep code/plan review | After plan refinement, after implementation |
| `security-reviewer-sonnet` | Quick security scan | After implementation |
| `security-reviewer-opus` | Deep security analysis | After implementation |
| `test-reviewer-sonnet` | Quick test check | After implementation |
| `test-reviewer-opus` | Deep test review | After implementation |

---

## Shared Knowledge

Read these docs before any work:
- `${CLAUDE_PLUGIN_ROOT}/docs/standards.md` - Coding standards and review criteria
- `${CLAUDE_PLUGIN_ROOT}/docs/workflow.md` - Pipeline process and output formats

---

## Asking for Clarification

If a plan or task is too ambiguous, add to your output:

```json
{
  "needs_clarification": true,
  "questions": [
    "Question 1 for the user?",
    "Question 2 for the user?"
  ]
}
```

The orchestrator will transition to `needs_user_input` state.
CLAUDE_EOF
      ;;

    hybrid)
      cat > "$project_dir/CLAUDE.md" << 'CLAUDE_EOF'
# Claude Code - Multi-AI Pipeline Project (Hybrid Mode)

This project supports two workflows. Choose based on task complexity:

## Quick Tasks → Use Your Normal Workflow
For simple changes, bug fixes, or small features, you can use your normal workflow (e.g., PLAN.md if configured globally).

## Complex Tasks → Use the Subagent Orchestrator
For larger features requiring multiple review cycles, use the subagent-based orchestrator:

```bash
# 1. Create your request
echo "Your feature description" > .task/user-request.txt

# 2. Run the pipeline
"${CLAUDE_PLUGIN_ROOT}/scripts/state-manager.sh" set plan_drafting ""
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.sh"
```

The orchestrator coordinates:
- **Subagents** for planning, implementation, and internal reviews (dual-model: sonnet + opus)
- **Codex** for final reviews (end of planning, end of implementation)

---

## Subagents

Located in `.claude/agents/`:

| Subagent | Purpose |
|----------|---------|
| `planner` | Drafts and refines plans (opus) |
| `researcher` | Gathers codebase context (opus) |
| `implementer` | Writes code (opus) |
| `code-reviewer-sonnet` / `code-reviewer-opus` | Internal code/plan quality review (parallel) |
| `security-reviewer-sonnet` / `security-reviewer-opus` | Security assessment (parallel) |
| `test-reviewer-sonnet` / `test-reviewer-opus` | Test coverage review (parallel) |

## Shared Knowledge

Read these docs before any work:
- `${CLAUDE_PLUGIN_ROOT}/docs/standards.md` - Coding standards and review criteria
- `${CLAUDE_PLUGIN_ROOT}/docs/workflow.md` - Pipeline process and output formats

## Asking for Clarification

If a plan or task is too ambiguous, add to your output:
```json
{
  "needs_clarification": true,
  "questions": [
    "Question 1 for the user?",
    "Question 2 for the user?"
  ]
}
```
CLAUDE_EOF
      ;;
  esac

  echo -e "${GREEN}✓ Updated CLAUDE.md for $mode mode${NC}"
}

# Show current preference
show_current_preference() {
  local current
  current=$(get_existing_preference)

  if [[ -n "$current" ]]; then
    echo -e "${BLUE}Current workflow mode: ${BOLD}$current${NC}"
    echo ""
  fi
}

# Main setup flow
main() {
  show_current_preference

  if check_global_claude_md; then
    echo -e "${BOLD}How would you like to handle this?${NC}"
    echo ""
    echo "  1) ${BOLD}Orchestrator Only${NC} (Recommended)"
    echo "     Force all implementations to use the multi-AI pipeline."
    echo "     Claude will guide users to use the orchestrator workflow."
    echo ""
    echo "  2) ${BOLD}Hybrid Mode${NC}"
    echo "     Allow both workflows - use your normal workflow for quick tasks,"
    echo "     orchestrator for complex tasks requiring multiple reviews."
    echo ""
    echo "  3) ${BOLD}Skip${NC}"
    echo "     Keep current settings, don't change anything."
    echo ""

    read -p "Select option (1-3): " choice

    case "$choice" in
      1)
        save_preference "orchestrator"
        update_claude_md "orchestrator"
        echo ""
        echo -e "${GREEN}✓ Configured for orchestrator-only mode${NC}"
        echo -e "  Claude will guide users to use the orchestrator workflow."
        ;;
      2)
        save_preference "hybrid"
        update_claude_md "hybrid"
        echo ""
        echo -e "${GREEN}✓ Configured for hybrid mode${NC}"
        echo -e "  Users can choose between normal workflow and orchestrator."
        ;;
      3)
        echo ""
        echo -e "${YELLOW}Skipped - no changes made${NC}"
        ;;
      *)
        echo -e "${RED}Invalid option${NC}"
        exit 1
        ;;
    esac
  else
    echo -e "No global CLAUDE.md conflict detected."
    echo -e "The orchestrator workflow will be used by default."
    echo ""

    # Still save preference for consistency
    if [[ -z "$(get_existing_preference)" ]]; then
      save_preference "orchestrator"
      echo -e "${GREEN}✓ Default preference saved: orchestrator${NC}"
    fi
  fi

  echo ""
  echo -e "${BOLD}Next steps:${NC}"
  echo "  1. Run: $PLUGIN_ROOT/scripts/state-manager.sh init"
  echo "  2. Run: $PLUGIN_ROOT/scripts/orchestrator.sh dry-run"
  echo ""
}

# Show header (only for interactive modes)
show_header() {
  echo ""
  echo -e "${BOLD}=========================================${NC}"
  echo -e "${BOLD}   Multi-AI Pipeline Setup${NC}"
  echo -e "${BOLD}=========================================${NC}"
  echo ""
}

# Entry point
case "${1:-}" in
  --check)
    # Silent check mode - just detect and report (no header)
    if [[ -f "$GLOBAL_CLAUDE_MD" ]]; then
      echo "global_claude_md=true"
      echo "path=$GLOBAL_CLAUDE_MD"
    else
      echo "global_claude_md=false"
    fi

    current=$(get_existing_preference)
    if [[ -n "$current" ]]; then
      echo "workflow_mode=$current"
    else
      echo "workflow_mode=not_configured"
    fi
    ;;
  --reconfigure)
    # Force reconfiguration
    show_header
    main
    ;;
  *)
    # Normal interactive setup
    show_header
    main
    ;;
esac
