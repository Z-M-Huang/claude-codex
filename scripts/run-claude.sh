#!/bin/bash
set -e

# Read model from config
# Merge local config if it exists
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.coder.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.coder.model' pipeline.config.json)
fi

# Load standards and task
STANDARDS=$(cat docs/standards.md)
TASK=$(cat .task/current-task.json)

# Check if this is a fix iteration (review feedback exists)
FEEDBACK=""
if [[ -f .task/review-result.json ]]; then
  FEEDBACK=$(cat .task/review-result.json)
fi

# Build prompt with context injection
PROMPT="## Project Standards

$STANDARDS

---

## Your Task

$TASK"

# Add review feedback if fixing
if [[ -n "$FEEDBACK" ]]; then
  PROMPT="$PROMPT

---

## Review Feedback to Address

$FEEDBACK"
fi

PROMPT="$PROMPT

Implement the task following the standards above. Write your output to .task/impl-result.json."

# Check for interactive mode (running inside Claude Code session)
if [[ "${CLAUDE_INTERACTIVE:-}" == "1" ]]; then
  echo "=== INTERACTIVE MODE ==="
  echo "Execute the following task in your current session:"
  echo ""
  echo "$PROMPT"
  echo ""

  # Remove stale output file to ensure fresh output
  rm -f .task/impl-result.json

  echo "Waiting for .task/impl-result.json to be created..."
  echo "(Press Ctrl+C to abort)"

  # Wait for output file to exist
  while [[ ! -f .task/impl-result.json ]]; do
    sleep 2
  done

  # Verify it's valid JSON
  if ! jq empty .task/impl-result.json 2>/dev/null; then
    echo "ERROR: .task/impl-result.json is not valid JSON" >&2
    exit 1
  fi

  echo "Output file detected. Continuing..."
  exit 0
fi

# Headless mode: Execute Claude subprocess
claude -p "$PROMPT" \
  --model "$MODEL" \
  --output-format json \
  --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
  --permission-mode acceptEdits

# Verify output file was created and is valid JSON
if [[ ! -f .task/impl-result.json ]]; then
  echo "ERROR: Claude did not create .task/impl-result.json" >&2
  exit 1
fi

if ! jq empty .task/impl-result.json 2>/dev/null; then
  echo "ERROR: .task/impl-result.json is not valid JSON" >&2
  exit 1
fi

echo "Implementation complete: .task/impl-result.json"
