#!/bin/bash
set -e

# Run Codex with --output-schema for guaranteed JSON format
# --full-auto: convenience alias for low-friction sandbox with on-request approvals
# --output-schema: enforce output matches our review schema
# -o: write output to file
# resume --last: carry forward context from previous sessions

# Read model from config
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.reviewer.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.reviewer.model' pipeline.config.json)
fi

codex exec resume --last \
  --full-auto \
  --model "$MODEL" \
  --output-schema docs/schemas/review-result.schema.json \
  -o .task/review-result.json \
  "Review the implementation in .task/impl-result.json.
   Check against docs/standards.md.
   Identify bugs, security issues, code style violations.
   Be specific with file paths and line numbers."

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
