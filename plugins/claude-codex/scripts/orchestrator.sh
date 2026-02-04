#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
TASK_DIR="${CLAUDE_PROJECT_DIR:-.}/.task"

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

# Check if a JSON file exists and has valid content
check_json_exists() {
  local file="$1"
  [[ -f "$file" ]] && [[ -s "$file" ]]
}

# Get status from a JSON file
get_json_status() {
  local file="$1"
  if check_json_exists "$file"; then
    bun -e "const f = Bun.file('$file'); const d = await f.json(); console.log(d.status || '')" 2>/dev/null || echo ""
  fi
}

# Determine current phase from artifact files
determine_phase() {
  # No user story yet
  if ! check_json_exists "$TASK_DIR/user-story.json"; then
    echo "requirements_gathering"
    return
  fi

  # No plan yet
  if ! check_json_exists "$TASK_DIR/plan-refined.json"; then
    echo "plan_drafting"
    return
  fi

  # Plan review chain
  local sonnet_status opus_status codex_status
  sonnet_status=$(get_json_status "$TASK_DIR/review-sonnet.json")
  opus_status=$(get_json_status "$TASK_DIR/review-opus.json")
  codex_status=$(get_json_status "$TASK_DIR/review-codex.json")

  if [[ -z "$sonnet_status" ]]; then
    echo "plan_review_sonnet"
    return
  fi
  if [[ "$sonnet_status" == "needs_clarification" ]]; then
    echo "clarification_plan_sonnet"
    return
  fi
  if [[ "$sonnet_status" == "needs_changes" ]]; then
    echo "fix_plan_sonnet"
    return
  fi

  if [[ -z "$opus_status" ]]; then
    echo "plan_review_opus"
    return
  fi
  if [[ "$opus_status" == "needs_clarification" ]]; then
    echo "clarification_plan_opus"
    return
  fi
  if [[ "$opus_status" == "needs_changes" ]]; then
    echo "fix_plan_opus"
    return
  fi

  if [[ -z "$codex_status" ]]; then
    echo "plan_review_codex"
    return
  fi
  if [[ "$codex_status" == "needs_clarification" ]]; then
    echo "clarification_plan_codex"
    return
  fi
  if [[ "$codex_status" == "needs_changes" ]]; then
    echo "fix_plan_codex"
    return
  fi
  if [[ "$codex_status" == "rejected" ]]; then
    echo "plan_rejected"
    return
  fi

  # Implementation
  local impl_status
  impl_status=$(get_json_status "$TASK_DIR/impl-result.json")
  if [[ -z "$impl_status" ]] || [[ "$impl_status" == "partial" ]]; then
    echo "implementation"
    return
  fi
  if [[ "$impl_status" == "failed" ]]; then
    echo "implementation_failed"
    return
  fi

  # Code review chain
  sonnet_status=$(get_json_status "$TASK_DIR/code-review-sonnet.json")
  opus_status=$(get_json_status "$TASK_DIR/code-review-opus.json")
  codex_status=$(get_json_status "$TASK_DIR/code-review-codex.json")

  if [[ -z "$sonnet_status" ]]; then
    echo "code_review_sonnet"
    return
  fi
  if [[ "$sonnet_status" == "needs_clarification" ]]; then
    echo "clarification_code_sonnet"
    return
  fi
  if [[ "$sonnet_status" == "needs_changes" ]]; then
    echo "fix_code_sonnet"
    return
  fi

  if [[ -z "$opus_status" ]]; then
    echo "code_review_opus"
    return
  fi
  if [[ "$opus_status" == "needs_clarification" ]]; then
    echo "clarification_code_opus"
    return
  fi
  if [[ "$opus_status" == "needs_changes" ]]; then
    echo "fix_code_opus"
    return
  fi

  if [[ -z "$codex_status" ]]; then
    echo "code_review_codex"
    return
  fi
  if [[ "$codex_status" == "needs_clarification" ]]; then
    echo "clarification_code_codex"
    return
  fi
  if [[ "$codex_status" == "needs_changes" ]]; then
    echo "fix_code_codex"
    return
  fi
  if [[ "$codex_status" == "rejected" ]]; then
    echo "code_rejected"
    return
  fi

  # All reviews approved
  echo "complete"
}

# Show current status
show_status() {
  if [[ ! -d "$TASK_DIR" ]]; then
    log_info "No .task directory found. Pipeline not started."
    echo ""
    echo "To start, invoke /multi-ai with your request."
    return
  fi

  local phase
  phase=$(determine_phase)
  log_info "Current phase: $phase"
  echo ""

  case "$phase" in
    requirements_gathering)
      echo "Phase: Requirements Gathering"
      echo "Use requirements-gatherer agent (opus) to create user-story.json"
      ;;
    plan_drafting)
      echo "Phase: Planning"
      echo "Use planner agent (opus) to create plan-refined.json"
      ;;
    plan_review_*)
      echo "Phase: Plan Review"
      echo "Run sequential plan reviews: sonnet -> opus -> codex"
      ;;
    fix_plan_*)
      echo "Phase: Fix Plan"
      echo "Address reviewer feedback, create fix + re-review tasks"
      ;;
    implementation)
      echo "Phase: Implementation"
      echo "Use implementer agent (sonnet) to implement plan-refined.json"
      ;;
    code_review_*)
      echo "Phase: Code Review"
      echo "Run sequential code reviews: sonnet -> opus -> codex"
      ;;
    fix_code_*)
      echo "Phase: Fix Code"
      echo "Address reviewer feedback, create fix + re-review tasks"
      ;;
    clarification_plan_*|clarification_code_*)
      echo "Phase: Clarification Needed"
      echo "Reviewer has questions. Read clarification_questions from review file."
      echo "If you can answer directly, do so. Otherwise use AskUserQuestion."
      echo "After answering, re-run the same reviewer."
      ;;
    complete)
      log_success "Pipeline complete! All reviews approved."
      echo ""
      echo "To reset for next task:"
      echo "  $PLUGIN_ROOT/scripts/orchestrator.sh reset"
      ;;
    plan_rejected|implementation_failed|code_rejected)
      log_error "Pipeline stopped: $phase"
      echo ""
      echo "Review the feedback files and decide how to proceed."
      ;;
  esac
}

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

  # 2. Check required scripts
  local required_scripts=(
    "orchestrator.sh"
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

  # 3. Check skills
  local skills_dir="$PLUGIN_ROOT/skills"
  local required_skills=(
    "multi-ai/SKILL.md"
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

  # 4. Check custom agents
  local agents_dir="$PLUGIN_ROOT/agents"
  local required_agents=(
    "requirements-gatherer.md"
    "planner.md"
    "plan-reviewer.md"
    "implementer.md"
    "code-reviewer.md"
    "codex-reviewer.md"
  )
  local agents_ok=1
  if [[ -d "$agents_dir" ]]; then
    for agent in "${required_agents[@]}"; do
      if [[ ! -f "$agents_dir/$agent" ]]; then
        echo "Agent missing: $agent"
        agents_ok=0
        ((errors++)) || true
      fi
    done
    [[ $agents_ok -eq 1 ]] && echo "Agents: OK (${#required_agents[@]} agents)"
  else
    echo "Agents directory: MISSING (agents/)"
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

  # 6. Check CLI tools
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

# Reset pipeline
reset_pipeline() {
  if ! acquire_lock; then
    log_error "Cannot reset while another orchestrator is running"
    exit 1
  fi
  setup_traps

  log_warn "Resetting pipeline..."

  # Release lock before nuking the directory (lock file is inside .task)
  release_lock

  # Remove entire .task directory and recreate clean
  rm -rf "$TASK_DIR"
  mkdir -p "$TASK_DIR"

  # Initialize with template state
  if [[ -f "$PLUGIN_ROOT/.task.template/state.json" ]]; then
    cp "$PLUGIN_ROOT/.task.template/state.json" "$TASK_DIR/state.json"
  fi

  log_success "Pipeline reset complete"
}

# Entry point
case "${1:-run}" in
  run|"")
    show_status
    ;;
  status)
    show_status
    ;;
  reset)
    reset_pipeline
    ;;
  dry-run|--dry-run)
    run_dry_run
    ;;
  *)
    echo "Usage: $0 {run|status|reset|dry-run}"
    echo ""
    echo "Commands:"
    echo "  run       Show current pipeline status (default)"
    echo "  status    Show current pipeline status"
    echo "  reset     Reset pipeline (remove all artifacts)"
    echo "  dry-run   Validate setup without running"
    exit 1
    ;;
esac
