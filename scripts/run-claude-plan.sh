#!/bin/bash
set -e

# Read model from config
# Merge local config if it exists
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.coder.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.coder.model' pipeline.config.json)
fi

# Load standards and plan
STANDARDS=$(cat docs/standards.md)
WORKFLOW=$(cat docs/workflow.md)
PLAN=$(cat .task/plan.json)

# Check if there's previous review feedback
FEEDBACK=""
if [[ -f .task/plan-review.json ]]; then
  FEEDBACK=$(cat .task/plan-review.json)
fi

# Build prompt with context injection
PROMPT="## Project Standards

$STANDARDS

---

## Workflow Documentation

$WORKFLOW

---

## Initial Plan to Refine

$PLAN"

# Add review feedback if refining based on feedback
if [[ -n "$FEEDBACK" ]]; then
  PROMPT="$PROMPT

---

## Previous Review Feedback to Address

$FEEDBACK"
fi

PROMPT="$PROMPT

---

## Your Task

You are refining this plan before implementation begins.

1. Analyze the plan for feasibility and clarity
2. Add technical details:
   - Specific files to modify or create
   - Technical approach and architecture decisions
   - Dependencies needed
   - Estimated complexity (low/medium/high)
3. Identify potential challenges and how to address them
4. If there was review feedback, address all concerns

Write your refined plan to .task/plan-refined.json using this format:
{
  \"id\": \"<same as original>\",
  \"title\": \"<title>\",
  \"description\": \"<description>\",
  \"requirements\": [\"req1\", \"req2\"],
  \"technical_approach\": \"Detailed description of how to implement\",
  \"files_to_modify\": [\"path/to/file.ts\"],
  \"files_to_create\": [\"path/to/new.ts\"],
  \"dependencies\": [],
  \"estimated_complexity\": \"low|medium|high\",
  \"potential_challenges\": [\"challenge and mitigation\"],
  \"refined_by\": \"claude\",
  \"refined_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
}

**IMPORTANT**: If the plan is too ambiguous or you need critical information from the user to proceed, add these fields:
{
  \"needs_clarification\": true,
  \"questions\": [
    \"Question 1 for the user?\",
    \"Question 2 for the user?\"
  ],
  ... (include other fields with what you know so far)
}

Only use needs_clarification for blocking questions that prevent you from creating a sensible plan."

# Check for interactive mode (running inside Claude Code session)
if [[ "${CLAUDE_INTERACTIVE:-}" == "1" ]]; then
  echo "=== INTERACTIVE MODE ==="
  echo "Execute the following task in your current session:"
  echo ""
  echo "$PROMPT"
  echo ""

  # Remove stale output file to ensure fresh output
  rm -f .task/plan-refined.json

  echo "Waiting for .task/plan-refined.json to be created..."
  echo "(Press Ctrl+C to abort)"

  # Wait for output file to exist
  while [[ ! -f .task/plan-refined.json ]]; do
    sleep 2
  done

  # Verify it's valid JSON
  if ! jq empty .task/plan-refined.json 2>/dev/null; then
    echo "ERROR: .task/plan-refined.json is not valid JSON" >&2
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

# Verify output file was created and is valid JSON
if [[ ! -f .task/plan-refined.json ]]; then
  echo "ERROR: Claude did not create .task/plan-refined.json" >&2
  exit 1
fi

if ! jq empty .task/plan-refined.json 2>/dev/null; then
  echo "ERROR: .task/plan-refined.json is not valid JSON" >&2
  exit 1
fi

echo "Plan refinement complete: .task/plan-refined.json"
