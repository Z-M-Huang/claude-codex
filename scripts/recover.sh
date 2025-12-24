#!/bin/bash
# Recovery script for stuck or errored pipeline states

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/state-manager.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_status() {
  echo -e "${BLUE}Current Pipeline Status:${NC}"
  echo "  State: $(get_status)"
  echo "  Task ID: $(get_task_id)"
  echo "  Iteration: $(get_iteration)"
  echo ""

  if [[ -f .task/current-task.json ]]; then
    echo -e "${BLUE}Current Task:${NC}"
    jq -r '.title // "No title"' .task/current-task.json
    echo ""
  fi

  local error_count
  error_count=$(ls -1 .task/errors/*.json 2>/dev/null | wc -l)
  if [[ $error_count -gt 0 ]]; then
    echo -e "${YELLOW}Errors: $error_count${NC}"
    echo "  Latest: $(ls -t .task/errors/*.json 2>/dev/null | head -1)"
  fi
}

reset_to_idle() {
  echo -e "${YELLOW}Resetting pipeline to idle...${NC}"
  set_state "idle" ""
  rm -f .task/impl-result.json .task/review-result.json
  rm -f .task/plan.json .task/plan-refined.json .task/plan-review.json
  rm -f .task/current-task.json .task/user-request.txt
  rm -f .task/internal-review-sonnet.json .task/internal-review-opus.json
  rm -f .task/security-review-sonnet.json .task/security-review-opus.json
  rm -f .task/test-review-sonnet.json .task/test-review-opus.json
  rm -f .task/.codex-session-active  # Clear Codex session marker for fresh start
  echo -e "${GREEN}Pipeline reset to idle${NC}"
}

retry_current() {
  local status
  status=$(get_status)
  local task_id
  task_id=$(get_task_id)
  local previous_state
  previous_state=$(get_previous_state)

  case "$status" in
    error)
      case "$previous_state" in
        plan_drafting)
          echo -e "${YELLOW}Retrying from plan creation (failed in: $previous_state)...${NC}"
          set_state "plan_drafting" ""
          rm -f .task/plan.json
          ;;
        plan_refining|plan_reviewing)
          echo -e "${YELLOW}Retrying from plan refinement (failed in: $previous_state)...${NC}"
          set_state "plan_refining" "$task_id"
          rm -f .task/plan-refined.json .task/plan-review.json
          ;;
        implementing|reviewing|fixing|"")
          echo -e "${YELLOW}Retrying from implementing (failed in: ${previous_state:-unknown})...${NC}"
          set_state "implementing" "$task_id"
          rm -f .task/impl-result.json .task/review-result.json
          ;;
        *)
          echo -e "${YELLOW}Unknown previous state ($previous_state), defaulting to implementing...${NC}"
          set_state "implementing" "$task_id"
          rm -f .task/impl-result.json .task/review-result.json
          ;;
      esac
      ;;
    fixing)
      echo -e "${YELLOW}Retrying fix...${NC}"
      rm -f .task/impl-result.json
      ;;
    *)
      echo -e "${RED}Cannot retry from state: $status${NC}"
      exit 1
      ;;
  esac

  echo -e "${GREEN}Ready to retry. Run: ./scripts/orchestrator.sh${NC}"
}

skip_task() {
  local task_id
  task_id=$(get_task_id)

  echo -e "${YELLOW}Skipping task: $task_id${NC}"

  if [[ -f .task/current-task.json ]]; then
    mkdir -p .task/archive
    mv .task/current-task.json ".task/archive/skipped-${task_id}-$(date +%Y%m%d-%H%M%S).json"
  fi

  reset_to_idle
  echo -e "${GREEN}Task skipped. Pipeline ready for next task.${NC}"
}

rollback_files() {
  echo -e "${YELLOW}Rolling back file changes via git...${NC}"

  if git status --porcelain | grep -q .; then
    echo "Modified files:"
    git status --porcelain

    read -p "Rollback these changes? (y/N) " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      git checkout -- .
      echo -e "${GREEN}Files rolled back${NC}"
    else
      echo "Rollback cancelled"
    fi
  else
    echo "No modified files to rollback"
  fi
}

clear_errors() {
  if [[ -d .task/errors ]] && ls .task/errors/*.json >/dev/null 2>&1; then
    local count
    count=$(ls -1 .task/errors/*.json | wc -l)
    rm -f .task/errors/*.json
    echo -e "${GREEN}Cleared $count error logs${NC}"
  else
    echo "No error logs to clear"
  fi
}

# Main menu
main() {
  echo ""
  echo "========================================="
  echo "   Pipeline Recovery Tool"
  echo "========================================="
  echo ""

  show_status

  echo ""
  echo "Options:"
  echo "  1) Reset to idle (clear current task state)"
  echo "  2) Retry current task"
  echo "  3) Skip current task"
  echo "  4) Rollback file changes (git checkout)"
  echo "  5) Clear error logs"
  echo "  6) Exit"
  echo ""

  read -p "Select option: " choice

  case "$choice" in
    1) reset_to_idle ;;
    2) retry_current ;;
    3) skip_task ;;
    4) rollback_files ;;
    5) clear_errors ;;
    6) exit 0 ;;
    *) echo -e "${RED}Invalid option${NC}"; exit 1 ;;
  esac
}

# Entry point
if [[ "${1:-}" == "--non-interactive" ]]; then
  show_status
else
  main
fi
