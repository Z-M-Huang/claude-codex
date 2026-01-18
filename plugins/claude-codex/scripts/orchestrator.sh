#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source state manager (sets PLUGIN_ROOT and TASK_DIR)
source "$SCRIPT_DIR/state-manager.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Locking functions
LOCK_FILE="$TASK_DIR/.orchestrator.lock"

get_lock_pid() {
  [[ ! -f "$LOCK_FILE" ]] && return
  local content
  content=$(cat "$LOCK_FILE" 2>/dev/null)
  [[ "$content" =~ ^[0-9]+$ ]] && echo "$content"
}

is_pid_alive() {
  local pid="$1"
  [[ -z "$pid" ]] && return 1
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  else
    if kill -0 "$pid" 2>&1 | grep -q "Operation not permitted"; then
      return 0
    fi
    return 1
  fi
}

acquire_lock() {
  local existing_pid
  existing_pid=$(get_lock_pid)

  if [[ -n "$existing_pid" ]]; then
    if is_pid_alive "$existing_pid"; then
      log_error "Another orchestrator is running (PID: $existing_pid)"
      log_error "If this is incorrect, manually remove $LOCK_FILE"
      return 1
    else
      log_warn "Removing stale lock (PID $existing_pid no longer exists)"
      rm -f "$LOCK_FILE"
    fi
  fi

  mkdir -p "$TASK_DIR"
  if ( set -C; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then
    return 0
  else
    log_error "Failed to acquire lock (race condition)"
    return 1
  fi
}

release_lock() {
  local lock_pid
  lock_pid=$(get_lock_pid)
  [[ "$lock_pid" == "$$" ]] && rm -f "$LOCK_FILE"
}

setup_traps() {
  trap 'release_lock' EXIT
  trap 'release_lock; exit 130' INT
  trap 'release_lock; exit 143' TERM
}

# Get max retries from config
get_max_retries() {
  if [[ -f "$PLUGIN_ROOT/pipeline.config.json" ]]; then
    $JSON_TOOL get "$PLUGIN_ROOT/pipeline.config.json" ".errorHandling.autoResolveAttempts // 3"
  else
    echo "3"
  fi
}

# Log error to file
log_error_to_file() {
  local stage="$1"
  local exit_code="$2"
  local message="$3"

  mkdir -p "$TASK_DIR/errors"
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local error_file="$TASK_DIR/errors/error-${timestamp}.json"

  cat > "$error_file" << EOF
{
  "id": "err-${timestamp}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stage": "$stage",
  "exit_code": $exit_code,
  "message": "$message",
  "task_id": "$(get_task_id)",
  "iteration": $(get_iteration)
}
EOF

  echo "$error_file"
}

# Note: Old run_* functions removed - main thread handles execution
# The orchestrator just shows status and next actions

# Dry-run validation mode
run_dry_run() {
  local errors=0
  local warnings=0

  echo "Running dry-run validation..."
  echo ""

  # 1. Check .task/ directory
  if [[ -d "$TASK_DIR" ]]; then
    echo "Task directory: OK ($TASK_DIR)"
  else
    echo "Task directory: MISSING ($TASK_DIR)"
    ((errors++)) || true
  fi

  # 2. Check state.json
  if [[ -f "$TASK_DIR/state.json" ]]; then
    if $JSON_TOOL valid "$TASK_DIR/state.json" 2>/dev/null; then
      local status
      status=$($JSON_TOOL get "$TASK_DIR/state.json" ".status // empty")
      local valid_states="idle requirements_gathering plan_drafting plan_refining plan_reviewing implementing reviewing fixing complete error needs_user_input"
      if [[ -n "$status" ]] && [[ " $valid_states " =~ " $status " ]]; then
        echo "State file: OK (status: $status)"
      else
        echo "State file: INVALID STATUS ($status)"
        ((errors++)) || true
      fi
    else
      echo "State file: INVALID JSON"
      ((errors++)) || true
    fi
  else
    echo "State file: MISSING (will be created on first run)"
  fi

  # 3. Check config file
  if [[ -f "$PLUGIN_ROOT/pipeline.config.json" ]]; then
    if $JSON_TOOL valid "$PLUGIN_ROOT/pipeline.config.json" 2>/dev/null; then
      echo "Config file: OK"
    else
      echo "Config file: INVALID JSON"
      ((errors++)) || true
    fi
  else
    echo "Config file: MISSING ($PLUGIN_ROOT/pipeline.config.json)"
    ((errors++)) || true
  fi

  # 4. Check required scripts
  local required_scripts=(
    "state-manager.sh"
    "orchestrator.sh"
    "recover.sh"
    "setup.sh"
  )
  local scripts_ok=1
  for script in "${required_scripts[@]}"; do
    if [[ ! -f "$SCRIPT_DIR/$script" ]]; then
      echo "Script missing: $script"
      scripts_ok=0
      ((errors++)) || true
    elif [[ ! -x "$SCRIPT_DIR/$script" ]]; then
      echo "Script not executable: $script"
      scripts_ok=0
      ((errors++)) || true
    fi
  done
  [[ $scripts_ok -eq 1 ]] && echo "Scripts: OK (${#required_scripts[@]} scripts)"

  # 5. Check skills
  local skills_dir="$PLUGIN_ROOT/skills"
  local required_skills=(
    "multi-ai/SKILL.md"
    "user-story/SKILL.md"
    "implement-sonnet/SKILL.md"
    "review-sonnet/SKILL.md"
    "review-opus/SKILL.md"
    "review-codex/SKILL.md"
  )
  local skills_ok=1
  if [[ -d "$skills_dir" ]]; then
    for skill in "${required_skills[@]}"; do
      if [[ ! -f "$skills_dir/$skill" ]]; then
        echo "Skill missing: $skill"
        skills_ok=0
        ((errors++)) || true
      fi
    done
    [[ $skills_ok -eq 1 ]] && echo "Skills: OK (${#required_skills[@]} skills)"
  else
    echo "Skills directory: MISSING (skills/)"
    ((errors++)) || true
  fi

  # 5. Check required docs
  if [[ -f "$PLUGIN_ROOT/docs/standards.md" ]]; then
    echo "docs/standards.md: OK"
  else
    echo "docs/standards.md: MISSING"
    ((errors++)) || true
  fi

  if [[ -f "$PLUGIN_ROOT/docs/workflow.md" ]]; then
    echo "docs/workflow.md: OK"
  else
    echo "docs/workflow.md: MISSING"
    ((errors++)) || true
  fi

  # 6. Check .gitignore for .task (in project directory)
  local project_gitignore="${CLAUDE_PROJECT_DIR:-.}/.gitignore"
  if [[ -f "$project_gitignore" ]] && grep -q "\.task" "$project_gitignore"; then
    echo ".gitignore (.task): OK"
  else
    echo ".gitignore (.task): WARNING - .task not in $project_gitignore"
    ((warnings++)) || true
  fi

  # 7. Check CLI tools
  if command -v bun >/dev/null 2>&1; then
    echo "CLI bun: OK"
  else
    echo "CLI bun: MISSING (required for JSON processing)"
    ((errors++)) || true
  fi

  if command -v claude >/dev/null 2>&1; then
    echo "CLI claude: OK"
  else
    echo "CLI claude: WARNING - not found"
    ((warnings++)) || true
  fi

  if command -v codex >/dev/null 2>&1; then
    echo "CLI codex: OK"
  else
    echo "CLI codex: WARNING - not found"
    ((warnings++)) || true
  fi

  # 8. Check for global CLAUDE.md conflict
  local global_claude="$HOME/.claude/CLAUDE.md"
  if [[ -f "$global_claude" ]]; then
    local workflow_mode
    workflow_mode=$($JSON_TOOL get "$TASK_DIR/preferences.json" ".workflow_mode // empty" 2>/dev/null)
    if [[ -n "$workflow_mode" ]]; then
      local mode
      mode="$workflow_mode"
      echo "Global CLAUDE.md: DETECTED (configured: $mode mode)"
    else
      echo "Global CLAUDE.md: WARNING - detected but setup not run"
      echo "  Run: $PLUGIN_ROOT/scripts/setup.sh"
      ((warnings++)) || true
    fi
  else
    echo "Global CLAUDE.md: OK (not detected)"
  fi

  # Summary
  echo ""
  if [[ $errors -eq 0 ]]; then
    if [[ $warnings -gt 0 ]]; then
      echo "Dry run: PASSED ($warnings warnings)"
    else
      echo "Dry run: PASSED"
    fi
    exit 0
  else
    echo "Dry run: FAILED ($errors errors, $warnings warnings)"
    exit 1
  fi
}

# Show next action based on current state
show_next_action() {
  local status
  status=$(get_status)

  log_info "Current state: $status"
  echo ""

  case "$status" in
    idle)
      echo "Pipeline idle. To start, invoke /multi-ai with your request."
      echo ""
      echo "The pipeline will:"
      echo "  1. Gather requirements (interactive - /user-story)"
      echo "  2. Plan autonomously (no user pauses)"
      echo "  3. Implement autonomously (no user pauses)"
      echo "  4. Report results"
      ;;
    requirements_gathering)
      echo "ACTION: Gather and clarify requirements (INTERACTIVE)"
      echo ""
      echo "The /user-story skill should be active, asking clarifying questions."
      echo "Once requirements are approved, the pipeline will proceed autonomously."
      echo ""
      echo "If stuck, manually transition:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set plan_drafting \"\""
      ;;
    plan_drafting)
      echo "ACTION: Create initial plan (main thread)"
      echo ""
      echo "Task: Create initial plan from approved user story"
      echo "Input: $TASK_DIR/user-story.json (authoritative requirements)"
      echo "Legacy: $TASK_DIR/user-request.txt (summary only)"
      echo "Output: $TASK_DIR/plan.json"
      echo ""
      echo "After completion, transition state:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set plan_refining \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan.json .id)\""
      ;;
    plan_refining)
      echo "ACTION: Refine plan with technical details (main thread)"
      echo ""
      echo "Task: Research codebase and refine plan"
      echo "Input: $TASK_DIR/plan.json"
      if [[ -f "$TASK_DIR/review-codex.json" ]]; then
        echo "Feedback: $TASK_DIR/review-codex.json (address all concerns - restart cycle)"
      elif [[ -f "$TASK_DIR/review-opus.json" ]]; then
        echo "Feedback: $TASK_DIR/review-opus.json (address concerns)"
      elif [[ -f "$TASK_DIR/review-sonnet.json" ]]; then
        echo "Feedback: $TASK_DIR/review-sonnet.json (address concerns)"
      fi
      echo "Output: $TASK_DIR/plan-refined.json"
      echo ""
      echo "After completion, run SEQUENTIAL reviews (each model reviews once):"
      echo "  1. Invoke /review-sonnet → $TASK_DIR/review-sonnet.json"
      echo "     If needs_changes: fix issues, then continue to step 2"
      echo "  2. Invoke /review-opus → $TASK_DIR/review-opus.json"
      echo "     If needs_changes: fix issues, then continue to step 3"
      echo "  3. Invoke /review-codex → $TASK_DIR/review-codex.json"
      echo "     If needs_changes: fix issues, restart from step 1"
      echo "     If approved: transition to implementing"
      echo ""
      echo "When all reviews pass:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set implementing \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan-refined.json .id)\""
      ;;
    plan_reviewing)
      echo "NOTE: This state is deprecated. Reviews now happen within plan_refining."
      echo ""
      echo "Use the sequential skill-based review flow in plan_refining state."
      echo "To return to plan_refining:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set plan_refining \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan-refined.json .id)\""
      ;;
    implementing)
      echo "ACTION: Invoke /implement-sonnet to implement the approved plan"
      echo ""
      echo "Task: Implement the approved plan"
      echo "Skill: /implement-sonnet"
      echo "Input: $TASK_DIR/plan-refined.json"
      echo "Standards: $PLUGIN_ROOT/docs/standards.md"
      if [[ -f "$TASK_DIR/review-codex.json" ]]; then
        echo "Feedback: $TASK_DIR/review-codex.json (address all concerns - restart cycle)"
      elif [[ -f "$TASK_DIR/review-opus.json" ]]; then
        echo "Feedback: $TASK_DIR/review-opus.json (address concerns)"
      elif [[ -f "$TASK_DIR/review-sonnet.json" ]]; then
        echo "Feedback: $TASK_DIR/review-sonnet.json (address concerns)"
      fi
      echo "Output: $TASK_DIR/impl-result.json"
      echo ""
      echo "After implementation, run SEQUENTIAL reviews (each model reviews once):"
      echo "  1. Invoke /review-sonnet → $TASK_DIR/review-sonnet.json"
      echo "     If needs_changes: fix issues, then continue to step 2"
      echo "  2. Invoke /review-opus → $TASK_DIR/review-opus.json"
      echo "     If needs_changes: fix issues, then continue to step 3"
      echo "  3. Invoke /review-codex → $TASK_DIR/review-codex.json"
      echo "     If needs_changes: fix issues, restart from step 1"
      echo "     If approved: transition to complete"
      echo ""
      echo "When all reviews pass:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set complete \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan-refined.json .id)\""
      ;;
    reviewing)
      echo "NOTE: This state is deprecated. Reviews now happen within implementing."
      echo ""
      echo "Use the sequential skill-based review flow in implementing state."
      echo "To return to implementing:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set implementing \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan-refined.json .id)\""
      ;;
    fixing)
      echo "NOTE: This state is deprecated. Fixes now happen within implementing."
      echo ""
      echo "The sequential review flow handles fixes inline:"
      echo "  sonnet → fix → opus → fix → codex → fix (restart from sonnet)"
      echo ""
      echo "To return to implementing:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set implementing \"\$(bun $PLUGIN_ROOT/scripts/json-tool.ts get $TASK_DIR/plan-refined.json .id)\""
      ;;
    complete)
      log_success "Task completed successfully!"
      echo ""
      echo "To reset for next task:"
      echo "  $PLUGIN_ROOT/scripts/orchestrator.sh reset"
      ;;
    needs_user_input)
      log_warn "Pipeline paused - user input required"
      echo ""
      echo "Check for questions in:"
      echo "  - $TASK_DIR/impl-result.json"
      echo "  - $TASK_DIR/plan-refined.json"
      echo ""
      echo "After providing answers, resume with:"
      echo "  $PLUGIN_ROOT/scripts/state-manager.sh set <plan_refining|implementing> <task_id>"
      ;;
    error)
      log_error "Pipeline in error state"
      echo ""
      echo "To recover:"
      echo "  $PLUGIN_ROOT/scripts/recover.sh"
      echo ""
      echo "Or reset:"
      echo "  $PLUGIN_ROOT/scripts/orchestrator.sh reset"
      ;;
    *)
      log_error "Unknown state: $status"
      exit 1
      ;;
  esac
}

# Entry point
case "${1:-run}" in
  run|"")
    # Show current state and next action
    init_state
    show_next_action
    ;;
  status)
    if ! check_state_readable; then exit 1; fi
    echo "Current state: $(get_status)"
    echo "Task ID: $(get_task_id)"
    echo "Iteration: $(get_iteration)"
    ;;
  reset)
    if ! acquire_lock; then
      log_error "Cannot reset while another orchestrator is running"
      exit 1
    fi
    setup_traps
    log_warn "Resetting pipeline state..."
    init_state
    set_state "idle" ""
    rm -f "$TASK_DIR/impl-result.json" "$TASK_DIR/review-result.json"
    rm -f "$TASK_DIR/plan.json" "$TASK_DIR/plan-refined.json" "$TASK_DIR/plan-review.json"
    rm -f "$TASK_DIR/current-task.json" "$TASK_DIR/user-request.txt" "$TASK_DIR/user-story.json"
    rm -f "$TASK_DIR/internal-review-sonnet.json" "$TASK_DIR/internal-review-opus.json"
    rm -f "$TASK_DIR/review-sonnet.json" "$TASK_DIR/review-opus.json" "$TASK_DIR/review-codex.json"
    rm -f "$TASK_DIR/.codex-session-active"  # Clear Codex session marker
    log_success "Pipeline reset to idle"
    ;;
  dry-run|--dry-run)
    run_dry_run
    ;;
  *)
    echo "Usage: $0 {run|status|reset|dry-run}"
    echo ""
    echo "Commands:"
    echo "  run       Run the orchestrator (default)"
    echo "  status    Show current pipeline state"
    echo "  reset     Reset pipeline to idle"
    echo "  dry-run   Validate setup without running"
    exit 1
    ;;
esac
