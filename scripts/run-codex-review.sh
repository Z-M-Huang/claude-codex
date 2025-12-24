#!/bin/bash
set -e

# Run Codex with --output-schema for guaranteed JSON format
# --full-auto: convenience alias for low-friction sandbox with on-request approvals
# --output-schema: enforce output matches our review schema
# -o: write output to file
# resume --last: used for subsequent reviews to carry context forward

# Session marker file - tracks if Codex has been called for this task
SESSION_MARKER=".task/.codex-session-active"

# Read model from config
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.reviewer.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.reviewer.model' pipeline.config.json)
fi

# Determine if this is the first Codex call for this task
# Implementation review always follows plan review, so session should already be active
USE_RESUME=""
if [[ -f "$SESSION_MARKER" ]]; then
  USE_RESUME="resume --last"
  echo "[INFO] Resuming Codex session from previous review"
else
  echo "[INFO] Starting fresh Codex session (first review for this task)"
fi

# shellcheck disable=SC2086
codex exec \
  --full-auto \
  --model "$MODEL" \
  --output-schema docs/schemas/review-result.schema.json \
  -o .task/review-result.json \
  $USE_RESUME \
  "Review the implementation in .task/impl-result.json.
   Check against docs/standards.md.
   Identify bugs, security issues, code style violations.
   Be specific with file paths and line numbers."

# Mark session as active after successful Codex call
touch "$SESSION_MARKER"

# Verify output file was created and is valid JSON
if [[ ! -f .task/review-result.json ]]; then
  echo "ERROR: Codex did not create .task/review-result.json" >&2
  exit 1
fi

if ! jq empty .task/review-result.json 2>/dev/null; then
  echo "ERROR: .task/review-result.json is not valid JSON" >&2
  exit 1
fi

echo "Review complete: .task/review-result.json"
