#!/bin/bash
# State manager using JSON files with atomic writes

# Determine plugin root (where configs live) - use CLAUDE_PLUGIN_ROOT or derive from script location
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
else
  # Fallback: derive from script location (for direct execution)
  _STATE_MGR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_ROOT="$(dirname "$_STATE_MGR_DIR")"
fi

# Use CLAUDE_PROJECT_DIR for task state (project-local), fall back to current dir
# This ensures each project has its own .task directory regardless of plugin installation scope
TASK_DIR="${CLAUDE_PROJECT_DIR:-.}/.task"
STATE_FILE="$TASK_DIR/state.json"

# JSON tool path (cross-platform jq replacement)
JSON_TOOL="bun $PLUGIN_ROOT/scripts/json-tool.ts"

# Check if .task is in .gitignore and prompt user if not (once per project)
check_gitignore_prompt() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local gitignore="$project_dir/.gitignore"
  local prompted_marker="$TASK_DIR/.gitignore-prompted"

  # Skip if we've already prompted
  [[ -f "$prompted_marker" ]] && return 0

  # Skip if .task is already in .gitignore
  if [[ -f "$gitignore" ]] && grep -q "\.task" "$gitignore"; then
    touch "$prompted_marker"
    return 0
  fi

  # Show prompt
  echo ""
  echo -e "\033[1;33m⚠ .task directory not in .gitignore\033[0m"
  echo ""
  echo "The .task/ directory contains pipeline state and should not be committed."
  echo "Add it to your .gitignore:"
  echo ""
  echo -e "  \033[1mecho '.task' >> $gitignore\033[0m"
  echo ""

  # Mark as prompted so we don't show again
  touch "$prompted_marker"
}

# Initialize state if not exists (with full schema)
init_state() {
  local first_init=false
  if [[ ! -f "$STATE_FILE" ]]; then
    first_init=true
    mkdir -p "$TASK_DIR"
    cat > "$STATE_FILE" << 'EOF'
{
  "status": "idle",
  "current_task_id": null,
  "iteration": 0,
  "previous_state": null,
  "updated_at": null,
  "started_at": null,
  "error_retry_count": 0
}
EOF
  fi

  # Check gitignore on first init
  if [[ "$first_init" == "true" ]]; then
    check_gitignore_prompt
  fi
}

# Get current state
get_state() {
  cat "$STATE_FILE"
}

# Get specific field
get_status() {
  $JSON_TOOL get "$STATE_FILE" ".status"
}

get_task_id() {
  $JSON_TOOL get "$STATE_FILE" ".current_task_id // empty"
}

get_iteration() {
  $JSON_TOOL get "$STATE_FILE" ".iteration"
}

# Update state atomically (write to tmp, then mv)
set_state() {
  local new_status="$1"
  local task_id="$2"

  # When starting a new task, clear the Codex session marker for fresh context
  if [[ "$new_status" == "plan_drafting" ]]; then
    rm -f "$TASK_DIR/.codex-session-active"
  fi

  local current_status
  current_status=$($JSON_TOOL get "$STATE_FILE" ".status")

  # Store previous state when transitioning to error or needs_user_input
  # But preserve existing previous_state if we're already in that state (avoid clobbering)
  local prev_state=""
  if [[ "$new_status" == "error" || "$new_status" == "needs_user_input" ]]; then
    if [[ "$current_status" == "$new_status" ]]; then
      # Already in this state - preserve existing previous_state
      prev_state=$($JSON_TOOL get "$STATE_FILE" ".previous_state // empty")
    else
      # Transitioning into this state - record where we came from
      prev_state="$current_status"
    fi
  fi

  # Copy to temp file and update
  cp "$STATE_FILE" "${STATE_FILE}.tmp"
  if [[ -n "$prev_state" ]]; then
    $JSON_TOOL set "${STATE_FILE}.tmp" \
      "status=$new_status" \
      "current_task_id=$task_id" \
      "previous_state=$prev_state" \
      "updated_at@=now"
  else
    $JSON_TOOL set "${STATE_FILE}.tmp" \
      "status=$new_status" \
      "current_task_id=$task_id" \
      "-previous_state" \
      "updated_at@=now"
  fi

  cp "${STATE_FILE}.tmp" "$STATE_FILE" && rm -f "${STATE_FILE}.tmp"
}

# Get previous state (used for error recovery)
get_previous_state() {
  $JSON_TOOL get "$STATE_FILE" ".previous_state // empty"
}

# Check if state file is readable (for non-mutating commands)
check_state_readable() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "State file missing. Run './scripts/orchestrator.sh' to initialize."
    return 1
  fi
  if ! $JSON_TOOL valid "$STATE_FILE"; then
    echo "State file invalid JSON. Run './scripts/orchestrator.sh reset' to fix."
    return 1
  fi
  return 0
}

# Increment iteration (for review loops)
increment_iteration() {
  cp "$STATE_FILE" "${STATE_FILE}.tmp"
  $JSON_TOOL set "${STATE_FILE}.tmp" "+iteration" "updated_at@=now"
  cp "${STATE_FILE}.tmp" "$STATE_FILE" && rm -f "${STATE_FILE}.tmp"
}

# Reset iteration (for new task)
reset_iteration() {
  cp "$STATE_FILE" "${STATE_FILE}.tmp"
  $JSON_TOOL set "${STATE_FILE}.tmp" "iteration:=0" "started_at@=now" "updated_at@=now"
  cp "${STATE_FILE}.tmp" "$STATE_FILE" && rm -f "${STATE_FILE}.tmp"
}

# Note: awaiting_output functions removed - no longer needed with subagent architecture

# Check if stuck (no update for N seconds)
is_stuck() {
  local timeout_seconds="${1:-600}"
  local updated_at
  updated_at=$($JSON_TOOL get "$STATE_FILE" ".updated_at // empty")

  if [[ -z "$updated_at" ]]; then
    echo "0"
    return
  fi

  local updated_epoch
  local now_epoch

  # Handle both GNU and BSD date
  if date --version >/dev/null 2>&1; then
    # GNU date
    updated_epoch=$(date -d "$updated_at" +%s 2>/dev/null || echo "0")
  else
    # BSD date
    updated_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$updated_at" +%s 2>/dev/null || echo "0")
  fi

  now_epoch=$(date +%s)
  local diff=$((now_epoch - updated_epoch))

  [[ $diff -gt $timeout_seconds ]] && echo "1" || echo "0"
}

# Get config value with local override support
# Priority: project-local > plugin-local > plugin-base
get_config_value() {
  local filter="$1"
  local base_cfg="$PLUGIN_ROOT/pipeline.config.json"
  local plugin_local_cfg="$PLUGIN_ROOT/pipeline.config.local.json"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local project_local_cfg="$project_dir/pipeline.config.local.json"

  # Build list of config files to merge (base first, overrides last)
  local configs=("$base_cfg")

  if [[ -f "$plugin_local_cfg" ]] && $JSON_TOOL valid "$plugin_local_cfg" 2>/dev/null; then
    configs+=("$plugin_local_cfg")
  fi

  if [[ -f "$project_local_cfg" ]] && $JSON_TOOL valid "$project_local_cfg" 2>/dev/null; then
    configs+=("$project_local_cfg")
  fi

  # Merge configs and get value (merge-get handles missing files gracefully)
  $JSON_TOOL merge-get "$filter" "${configs[@]}"
}

# Get review loop limit from config (legacy, for backward compat)
get_review_loop_limit() {
  get_config_value '.autonomy.reviewLoopLimit // 10'
}

# Get plan review limit (separate from code review)
get_plan_review_limit() {
  get_config_value '.autonomy.planReviewLoopLimit // .autonomy.reviewLoopLimit // 10'
}

# Get code review limit (separate from plan review)
get_code_review_limit() {
  get_config_value '.autonomy.codeReviewLoopLimit // .autonomy.reviewLoopLimit // 15'
}

# Check if we've exceeded review loop limit
# Usage: exceeded_review_limit [plan|code]
exceeded_review_limit() {
  local phase="${1:-code}"
  local iteration limit
  iteration=$(get_iteration)

  if [[ "$phase" == "plan" ]]; then
    limit=$(get_plan_review_limit)
  else
    limit=$(get_code_review_limit)
  fi

  [[ $iteration -ge $limit ]] && echo "1" || echo "0"
}

# Source this file to use functions, or run directly for testing
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    init)
      init_state
      echo "State initialized"
      ;;
    status)
      get_status
      ;;
    state)
      get_state
      ;;
    set)
      set_state "$2" "$3"
      echo "State updated"
      ;;
    *)
      echo "Usage: $0 {init|status|state|set <status> <task_id>}"
      exit 1
      ;;
  esac
fi
