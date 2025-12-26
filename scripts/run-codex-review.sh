#!/bin/bash
set -e

# Run Codex with --output-schema for guaranteed JSON format
# --full-auto: convenience alias for low-friction sandbox with on-request approvals
# --output-schema: enforce output matches our review schema
# -o: write output to file
# Uses resume --last for subsequent reviews to save tokens

# Session marker file - tracks if Codex has been called for this task
SESSION_MARKER=".task/.codex-session-active"

# Read model from config
if [[ -f pipeline.config.local.json ]]; then
  MODEL=$(jq -rs '.[0] * .[1] | .models.reviewer.model' pipeline.config.json pipeline.config.local.json)
else
  MODEL=$(jq -r '.models.reviewer.model' pipeline.config.json)
fi

# Determine if this is a subsequent review (resume session)
if [[ -f "$SESSION_MARKER" ]]; then
  IS_RESUME=true
  echo "[INFO] Resuming Codex session - will include changes summary"
else
  IS_RESUME=false
  echo "[INFO] Starting fresh Codex session (first review for this task)"
fi

# Get list of changed files for resume prompt
CHANGED_FILES=""
if [[ "$IS_RESUME" == true ]]; then
  # Get modified files from git (unstaged and staged) AND untracked files
  MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null || echo "")
  UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null || echo "")
  CHANGED_FILES=$(echo -e "${MODIFIED_FILES}\n${UNTRACKED_FILES}" | grep -v '^$' | sort -u | tr '\n' '\n')
  if [[ -z "$CHANGED_FILES" ]]; then
    # If no uncommitted changes, get files from impl-result.json
    if [[ -f .task/impl-result.json ]]; then
      CHANGED_FILES=$(jq -r '.files_changed[]? // empty' .task/impl-result.json 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
    fi
  fi
fi

# Build the prompt based on whether this is a resume or fresh start
if [[ "$IS_RESUME" == true ]]; then
  # For resume: shorter prompt focusing on what changed
  PROMPT="## IMPORTANT: This is a follow-up review

The implementation has been UPDATED based on your previous feedback.

### Files Changed Since Last Review:
${CHANGED_FILES:-"(Unable to determine - please re-check all files in impl-result.json)"}

---

Please re-review the implementation focusing on:
1. Whether previous issues were properly addressed
2. Any new issues introduced by the changes
3. The files listed above

Check against docs/standards.md.
Identify bugs, security issues, code style violations.
Be specific with file paths and line numbers."

else
  # First review: full prompt
  PROMPT="Review the implementation in .task/impl-result.json.
Check against docs/standards.md.
Identify bugs, security issues, code style violations.
Be specific with file paths and line numbers."
fi

# Execute Codex with schema enforcement
if [[ "$IS_RESUME" == true ]]; then
  codex exec \
    --full-auto \
    --model "$MODEL" \
    --output-schema docs/schemas/review-result.schema.json \
    -o .task/review-result.json \
    resume --last \
    "$PROMPT"
else
  codex exec \
    --full-auto \
    --model "$MODEL" \
    --output-schema docs/schemas/review-result.schema.json \
    -o .task/review-result.json \
    "$PROMPT"
fi

# Verify output file was created and is valid JSON
if [[ ! -f .task/review-result.json ]]; then
  echo "ERROR: Codex did not create .task/review-result.json" >&2
  exit 1
fi

if ! jq empty .task/review-result.json 2>/dev/null; then
  echo "ERROR: .task/review-result.json is not valid JSON" >&2
  exit 1
fi

# Mark session as active only after successful validation
touch "$SESSION_MARKER"

echo "Review complete: .task/review-result.json"
