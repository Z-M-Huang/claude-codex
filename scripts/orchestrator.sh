#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Source state manager
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
LOCK_FILE=".task/.orchestrator.lock"

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

  mkdir -p .task
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

# Check if auto-commit is enabled (with legacy fallback)
should_auto_commit() {
  local auto_commit
  auto_commit=$(get_config_value '.autonomy.autoCommit')

  if [[ "$auto_commit" != "null" && -n "$auto_commit" ]]; then
    [[ "$auto_commit" == "true" ]] && echo "1" || echo "0"
    return
  fi

  local legacy
  legacy=$(get_config_value '.autonomy.approvalPoints.commit')
  [[ "$legacy" == "false" ]] && echo "1" || echo "0"
}

# Get max retries from config
get_max_retries() {
  if [[ -f "pipeline.config.json" ]]; then
    jq -r '.errorHandling.autoResolveAttempts // 3' pipeline.config.json
  else
    echo "3"
  fi
}

# Log error to file
log_error_to_file() {
  local stage="$1"
  local exit_code="$2"
  local message="$3"

  mkdir -p .task/errors
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local error_file=".task/errors/error-${timestamp}.json"

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

# Run plan creation phase (NEW - replaces Gemini)
run_plan_creation() {
  log_info "Creating initial plan (Claude)..."

  if [[ ! -f .task/user-request.txt ]]; then
    log_error "No user request found. Create .task/user-request.txt first."
    return 1
  fi

  local user_request
  user_request=$(cat .task/user-request.txt)

  if "$SCRIPT_DIR/run-claude-plan-create.sh" "$user_request"; then
    local plan_id
    plan_id=$(jq -r '.id' .task/plan.json)
    log_success "Plan created: $plan_id"
    set_state "plan_refining" "$plan_id"
    reset_iteration
    return 0
  else
    local exit_code=$?
    log_error "Plan creation failed with exit code $exit_code"
    log_error_to_file "plan_drafting" "$exit_code" "Claude plan creation failed"
    return 1
  fi
}

# Run implementation phase
run_implementation() {
  log_info "Running implementation (Claude)..."
  local task_id
  task_id=$(get_task_id)

  if "$SCRIPT_DIR/run-claude.sh"; then
    if [[ -f .task/impl-result.json ]]; then
      local status
      status=$(jq -r '.status' .task/impl-result.json)

      if [[ "$status" == "needs_clarification" ]]; then
        log_warn "Claude needs clarification from user"
        log_info "Questions saved to .task/impl-result.json"
        set_state "needs_user_input" "$task_id"
        return 0
      fi
    fi

    log_success "Implementation completed"
    set_state "reviewing" "$task_id"
    return 0
  else
    local exit_code=$?
    log_error "Implementation failed with exit code $exit_code"
    log_error_to_file "implementing" "$exit_code" "Claude implementation failed"
    return 1
  fi
}

# Run review phase
run_review() {
  log_info "Running review (Codex)..."
  local task_id
  task_id=$(get_task_id)

  if "$SCRIPT_DIR/run-codex-review.sh"; then
    log_success "Review completed"

    local status
    status=$(jq -r '.status' .task/review-result.json)

    case "$status" in
      approved)
        log_success "Review approved!"
        set_state "complete" "$task_id"
        ;;
      needs_changes)
        log_warn "Review requires changes"
        increment_iteration

        if [[ $(exceeded_review_limit) == "1" ]]; then
          log_error "Exceeded review loop limit"
          set_state "error" "$task_id"
          return 1
        fi

        set_state "fixing" "$task_id"
        ;;
      rejected)
        log_error "Review rejected"
        set_state "error" "$task_id"
        return 1
        ;;
    esac
    return 0
  else
    local exit_code=$?
    log_error "Review failed with exit code $exit_code"
    log_error_to_file "reviewing" "$exit_code" "Codex review failed"
    return 1
  fi
}

# Run fix phase
run_fix() {
  log_info "Running fix iteration $(get_iteration)..."
  local task_id
  task_id=$(get_task_id)

  if "$SCRIPT_DIR/run-claude.sh"; then
    log_success "Fix completed"
    set_state "reviewing" "$task_id"
    return 0
  else
    local exit_code=$?
    log_error "Fix failed with exit code $exit_code"
    log_error_to_file "fixing" "$exit_code" "Claude fix failed"
    return 1
  fi
}

# Run plan refinement phase
run_plan_refinement() {
  log_info "Running plan refinement (Claude)..."
  local plan_id
  plan_id=$(jq -r '.id // "unknown"' .task/plan.json 2>/dev/null || echo "unknown")

  if "$SCRIPT_DIR/run-claude-plan.sh"; then
    if [[ -f .task/plan-refined.json ]]; then
      local needs_input
      needs_input=$(jq -r '.needs_clarification // false' .task/plan-refined.json)

      if [[ "$needs_input" == "true" ]]; then
        log_warn "Claude needs clarification on the plan"
        log_info "Questions saved to .task/plan-refined.json"
        set_state "needs_user_input" "$plan_id"
        return 0
      fi
    fi

    log_success "Plan refinement completed"
    set_state "plan_reviewing" "$plan_id"
    return 0
  else
    local exit_code=$?
    log_error "Plan refinement failed with exit code $exit_code"
    log_error_to_file "plan_refining" "$exit_code" "Claude plan refinement failed"
    return 1
  fi
}

# Run plan review phase
run_plan_review() {
  log_info "Running plan review (Codex)..."
  local plan_id
  plan_id=$(jq -r '.id // "unknown"' .task/plan-refined.json 2>/dev/null || echo "unknown")

  if "$SCRIPT_DIR/run-codex-plan-review.sh"; then
    log_success "Plan review completed"

    local status
    status=$(jq -r '.status' .task/plan-review.json)

    case "$status" in
      approved)
        log_success "Plan approved! Converting to task..."
        # Auto-convert to task (strict loop-until-pass)
        if "$SCRIPT_DIR/plan-to-task.sh"; then
          log_success "Task created, proceeding to implementation"
        else
          log_error "Failed to convert plan to task"
          set_state "error" "$plan_id"
          return 1
        fi
        ;;
      needs_changes)
        log_warn "Plan needs changes"
        increment_iteration

        if [[ $(exceeded_review_limit "plan") == "1" ]]; then
          log_error "Exceeded plan review loop limit"
          set_state "error" "$plan_id"
          return 1
        fi

        set_state "plan_refining" "$plan_id"
        ;;
    esac
    return 0
  else
    local exit_code=$?
    log_error "Plan review failed with exit code $exit_code"
    log_error_to_file "plan_reviewing" "$exit_code" "Codex plan review failed"
    return 1
  fi
}

# Track retry attempts
get_error_retry_count() {
  jq -r '.error_retry_count // 0' .task/state.json
}

increment_error_retry() {
  jq '.error_retry_count = ((.error_retry_count // 0) + 1) | .updated_at = (now | todate)' \
    .task/state.json > .task/state.json.tmp
  mv .task/state.json.tmp .task/state.json
}

reset_error_retry() {
  jq 'del(.error_retry_count) | .updated_at = (now | todate)' \
    .task/state.json > .task/state.json.tmp
  mv .task/state.json.tmp .task/state.json
}

# Handle error state with auto-resolve retry loop
handle_error() {
  local task_id
  task_id=$(get_task_id)
  local retry_count
  retry_count=$(get_error_retry_count)
  local max_retries
  max_retries=$(get_max_retries)
  local previous_state
  previous_state=$(get_previous_state)

  log_error "Pipeline in error state for task: $task_id"
  log_info "Failed in state: $previous_state"
  log_info "Auto-resolve attempt: $((retry_count + 1)) / $max_retries"

  local is_plan_phase=0
  local is_plan_drafting=0
  case "$previous_state" in
    plan_drafting)
      is_plan_phase=1
      is_plan_drafting=1
      ;;
    plan_refining|plan_reviewing)
      is_plan_phase=1
      ;;
  esac

  if [[ $retry_count -lt $max_retries ]]; then
    increment_error_retry

    if [[ $is_plan_drafting -eq 1 ]]; then
      # plan_drafting failed - retry plan creation (plan.json doesn't exist yet)
      case $retry_count in
        0)
          log_info "Strategy: Retry plan creation..."
          ;;
        1)
          log_info "Strategy: Retry plan creation (attempt 2)..."
          ;;
        2)
          log_info "Strategy: Final plan creation attempt..."
          ;;
      esac
      set_state "plan_drafting" ""
      log_info "Retrying plan creation from user-request.txt..."
    elif [[ $is_plan_phase -eq 1 ]]; then
      case $retry_count in
        0)
          log_info "Strategy: Retry plan refinement..."
          ;;
        1)
          log_info "Strategy: Clear refined plan and retry..."
          rm -f .task/plan-refined.json
          ;;
        2)
          log_info "Strategy: Full plan reset and retry..."
          rm -f .task/plan-refined.json .task/plan-review.json
          ;;
      esac
      set_state "plan_refining" "$task_id"
      log_info "Retrying plan refinement..."
    else
      case $retry_count in
        0)
          log_info "Strategy: Retry with same approach..."
          ;;
        1)
          log_info "Strategy: Clear intermediate files and retry..."
          rm -f .task/impl-result.json
          ;;
        2)
          log_info "Strategy: Full reset and retry..."
          rm -f .task/impl-result.json .task/review-result.json
          ;;
      esac
      set_state "implementing" "$task_id"
      log_info "Retrying implementation..."
    fi
  else
    log_error "Exhausted all $max_retries auto-resolve attempts"
    log_warn "Manual intervention required. Options:"
    log_warn "  1. Run: ./scripts/recover.sh"
    log_warn "  2. Check errors: ls -la .task/errors/"
    log_warn "  3. Reset: ./scripts/orchestrator.sh reset"

    reset_error_retry

    exit 1
  fi
}

# Dry-run validation mode
run_dry_run() {
  local errors=0
  local warnings=0

  echo "Running dry-run validation..."
  echo ""

  # 1. Check .task/ directory
  if [[ -d .task ]]; then
    echo "Task directory: OK"
  else
    echo "Task directory: MISSING"
    ((errors++)) || true
  fi

  # 2. Check state.json
  if [[ -f .task/state.json ]]; then
    if jq empty .task/state.json 2>/dev/null; then
      local status
      status=$(jq -r '.status // empty' .task/state.json)
      local valid_states="idle plan_drafting plan_refining plan_reviewing implementing reviewing fixing complete committing error needs_user_input"
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
  if [[ -f pipeline.config.json ]]; then
    if jq empty pipeline.config.json 2>/dev/null; then
      echo "Config file: OK"
    else
      echo "Config file: INVALID JSON"
      ((errors++)) || true
    fi
  else
    echo "Config file: MISSING"
    ((errors++)) || true
  fi

  # 4. Check required scripts (all 11)
  local required_scripts=(
    "state-manager.sh"
    "run-claude.sh"
    "run-claude-plan.sh"
    "run-claude-plan-create.sh"
    "run-codex-review.sh"
    "run-codex-plan-review.sh"
    "plan-to-task.sh"
    "orchestrator.sh"
    "recover.sh"
    "validate-config.sh"
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

  # 5. Check required docs
  if [[ -f docs/standards.md ]]; then
    echo "docs/standards.md: OK"
  else
    echo "docs/standards.md: MISSING"
    ((errors++)) || true
  fi

  if [[ -f docs/workflow.md ]]; then
    echo "docs/workflow.md: OK"
  else
    echo "docs/workflow.md: MISSING"
    ((errors++)) || true
  fi

  # 6. Check .gitignore for .task
  if [[ -f .gitignore ]] && grep -q "\.task" .gitignore; then
    echo ".gitignore (.task): OK"
  else
    echo ".gitignore (.task): WARNING - .task not in .gitignore"
    ((warnings++)) || true
  fi

  # 7. Check CLI tools
  if command -v jq >/dev/null 2>&1; then
    echo "CLI jq: OK"
  else
    echo "CLI jq: MISSING (required)"
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
    if [[ -f .task/preferences.json ]] && jq -e '.workflow_mode' .task/preferences.json >/dev/null 2>&1; then
      local mode
      mode=$(jq -r '.workflow_mode' .task/preferences.json)
      echo "Global CLAUDE.md: DETECTED (configured: $mode mode)"
    else
      echo "Global CLAUDE.md: WARNING - detected but setup not run"
      echo "  Run: ./scripts/setup.sh"
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

# Complete task
complete_task() {
  local task_id
  task_id=$(get_task_id)

  log_success "Task $task_id completed successfully!"

  reset_error_retry

  if [[ $(should_auto_commit) == "1" ]]; then
    log_info "Auto-commit enabled, committing changes..."
    set_state "committing" "$task_id"
    log_warn "Git commit skipped in MVP - implement when ready"
    set_state "idle" ""
  else
    log_info "Waiting for manual commit approval"
    set_state "idle" ""
  fi

  rm -f .task/review-result.json
}

# Main orchestration loop
main_loop() {
  while true; do
    local status
    status=$(get_status)

    log_info "Current state: $status"

    case "$status" in
      idle)
        log_info "Pipeline idle. Waiting for task..."
        exit 0
        ;;
      plan_drafting)
        if ! run_plan_creation; then
          set_state "error" ""
        fi
        ;;
      plan_refining)
        if ! run_plan_refinement; then
          set_state "error" "$(jq -r '.id // ""' .task/plan.json 2>/dev/null)"
        fi
        ;;
      plan_reviewing)
        if ! run_plan_review; then
          set_state "error" "$(jq -r '.id // ""' .task/plan-refined.json 2>/dev/null)"
        fi
        ;;
      needs_user_input)
        log_warn "Pipeline paused - user input required"
        log_info "Claude needs clarification. Check:"
        log_info "  - .task/impl-result.json (for implementation questions)"
        log_info "  - .task/plan-refined.json (for plan questions)"
        log_info ""
        log_info "To resume after providing answers:"
        log_info "  ./scripts/state-manager.sh set <plan_refining|implementing> <task_id>"
        exit 0
        ;;
      implementing)
        if ! run_implementation; then
          set_state "error" "$(get_task_id)"
        fi
        ;;
      reviewing)
        if ! run_review; then
          set_state "error" "$(get_task_id)"
        fi
        ;;
      fixing)
        if ! run_fix; then
          set_state "error" "$(get_task_id)"
        fi
        ;;
      complete)
        complete_task
        ;;
      committing)
        log_info "Committing..."
        set_state "idle" ""
        ;;
      error)
        handle_error
        ;;
      *)
        log_error "Unknown state: $status"
        exit 1
        ;;
    esac

    sleep 1
  done
}

# Entry point
case "${1:-run}" in
  run)
    if ! acquire_lock; then exit 1; fi
    setup_traps
    init_state
    log_info "Starting orchestrator (headless mode)..."
    main_loop
    ;;
  interactive)
    # Interactive mode: export flag so scripts output prompts instead of spawning Claude
    export CLAUDE_INTERACTIVE=1
    if ! acquire_lock; then exit 1; fi
    setup_traps
    init_state
    log_info "Starting orchestrator (interactive mode)..."
    log_info "Claude tasks will output prompts for current session to execute."
    main_loop
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
    rm -f .task/impl-result.json .task/review-result.json
    rm -f .task/plan.json .task/plan-refined.json .task/plan-review.json
    rm -f .task/current-task.json .task/user-request.txt
    log_success "Pipeline reset to idle"
    ;;
  dry-run|--dry-run)
    run_dry_run
    ;;
  *)
    echo "Usage: $0 {run|interactive|status|reset|dry-run}"
    echo ""
    echo "Commands:"
    echo "  run          Run in headless mode (spawns Claude/Codex subprocesses)"
    echo "  interactive  Run in interactive mode (outputs prompts for current Claude session)"
    echo "  status       Show current pipeline state"
    echo "  reset        Reset pipeline to idle"
    echo "  dry-run      Validate setup without running"
    exit 1
    ;;
esac
