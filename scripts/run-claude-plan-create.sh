#!/bin/bash
set -e

# This script allows Claude to create initial plans
# Previously done by Gemini orchestrator

# Read model from config (uses orchestrator model for plan creation)
# Merge local config if it exists
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.orchestrator.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.orchestrator.model' pipeline.config.json)
fi

STANDARDS=$(cat docs/standards.md)
WORKFLOW=$(cat docs/workflow.md)

# Read user request from argument (argv only, no stdin)
USER_REQUEST="${1:-}"
if [[ -z "$USER_REQUEST" ]]; then
  echo "Usage: $0 'description of what you want to build'" >&2
  echo "Example: $0 'Add user authentication with JWT tokens'" >&2
  exit 1
fi

# Generate plan ID
PLAN_ID="plan-$(date +%Y%m%d-%H%M%S)"

PROMPT="## Project Standards

$STANDARDS

---

## Workflow Documentation

$WORKFLOW

---

## User Request

$USER_REQUEST

---

## Your Task

Create an initial plan for this request. Write to .task/plan.json using this format:

{
  \"id\": \"$PLAN_ID\",
  \"title\": \"Short descriptive title\",
  \"description\": \"What the user wants to achieve\",
  \"requirements\": [
    \"Requirement 1\",
    \"Requirement 2\"
  ],
  \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
  \"created_by\": \"claude\"
}

Be specific about requirements. Break down the request into clear, actionable items."

# Check for interactive mode (running inside Claude Code session)
if [[ "${CLAUDE_INTERACTIVE:-}" == "1" ]]; then
  echo "=== INTERACTIVE MODE ==="
  echo "Execute the following task in your current session:"
  echo ""
  echo "$PROMPT"
  echo ""

  # Remove stale output file to ensure fresh output
  rm -f .task/plan.json

  echo "Waiting for .task/plan.json to be created..."
  echo "(Press Ctrl+C to abort)"

  # Wait for output file to exist
  while [[ ! -f .task/plan.json ]]; do
    sleep 2
  done

  # Verify it's valid JSON
  if ! jq empty .task/plan.json 2>/dev/null; then
    echo "ERROR: .task/plan.json is not valid JSON" >&2
    exit 1
  fi

  echo "Output file detected. Continuing..."
  exit 0
fi

# Headless mode: Execute Claude subprocess
claude -p "$PROMPT" \
  --model "$MODEL" \
  --output-format json \
  --allowedTools "Read,Write,Edit,Glob,Grep" \
  --permission-mode acceptEdits

# Verify output
if [[ ! -f .task/plan.json ]]; then
  echo "ERROR: Claude did not create .task/plan.json" >&2
  exit 1
fi

if ! jq empty .task/plan.json 2>/dev/null; then
  echo "ERROR: .task/plan.json is not valid JSON" >&2
  exit 1
fi

echo "Plan created: .task/plan.json"
cat .task/plan.json | jq '{id, title}'
