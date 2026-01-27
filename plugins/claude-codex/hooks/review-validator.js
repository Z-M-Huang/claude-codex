#!/usr/bin/env bun
/**
 * SubagentStop hook that validates reviewer outputs.
 * Runs when ANY subagent finishes (SubagentStop doesn't support matchers).
 * Filters to only validate reviewer agents.
 *
 * Input (via stdin JSON):
 * {
 *   "agent_id": "def456",
 *   "agent_transcript_path": "~/.claude/projects/.../subagents/agent-def456.jsonl"
 * }
 *
 * Output (to block):
 * {"decision": "block", "reason": "explanation"}
 *
 * Validates:
 * 1. Review has acceptance_criteria_verification (code) or requirements_coverage (plan)
 * 2. All ACs from user-story.json are verified
 * 3. If status=approved but ACs missing -> block
 *
 * Note: Task creation validation removed - that's the orchestrator's responsibility
 * and happens AFTER the review, not during SubagentStop.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const TASK_DIR = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.task');

// Actual file names used by the pipeline (per SKILL.md Agent Reference)
const PLAN_REVIEW_FILES = ['review-sonnet.json', 'review-opus.json', 'review-codex.json'];
const CODE_REVIEW_FILES = ['code-review-sonnet.json', 'code-review-opus.json', 'code-review-codex.json'];

function readJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function getAgentTypeFromTranscript(transcriptPath) {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const match = content.match(/subagent_type['":\s]+['"]?(claude-codex:[^'"}\s,]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Find the most recently modified review file.
 * SubagentStop fires immediately after agent finishes, so the most recent file
 * is the one just written by the agent.
 */
function findMostRecentFile(files) {
  let mostRecent = null;
  let mostRecentTime = 0;

  for (const filename of files) {
    const filepath = join(TASK_DIR, filename);
    if (!existsSync(filepath)) continue;

    try {
      const stat = statSync(filepath);
      const mtime = stat.mtimeMs;

      if (mtime > mostRecentTime) {
        mostRecentTime = mtime;
        mostRecent = { path: filepath, filename };
      }
    } catch {
      continue;
    }
  }

  return mostRecent;
}

export function validatePlanReview(review, userStory) {
  const acIds = (userStory?.acceptance_criteria || []).map(ac => ac.id);
  if (acIds.length === 0) return null; // Skip validation if no ACs

  const coverage = review.requirements_coverage;
  if (!coverage) {
    return {
      decision: 'block',
      reason: 'Review missing requirements_coverage field. Must verify all acceptance criteria from user-story.json.'
    };
  }

  // mapping is now an array of {ac_id, steps}
  const coveredACs = (coverage.mapping || []).map(m => m.ac_id);
  const missingACs = acIds.filter(id => !coveredACs.includes(id));

  if (missingACs.length > 0) {
    return {
      decision: 'block',
      reason: `Review did not verify these ACs: ${missingACs.join(', ')}. Re-run review with complete verification.`
    };
  }

  if (review.status === 'approved' && (coverage.missing?.length > 0)) {
    return {
      decision: 'block',
      reason: `Cannot approve with missing requirements: ${coverage.missing.join(', ')}. Status must be needs_changes.`
    };
  }

  return null; // Valid
}

export function validateCodeReview(review, userStory) {
  const acIds = (userStory?.acceptance_criteria || []).map(ac => ac.id);
  if (acIds.length === 0) return null; // Skip validation if no ACs

  const verification = review.acceptance_criteria_verification;
  if (!verification) {
    return {
      decision: 'block',
      reason: 'Review missing acceptance_criteria_verification field. Must verify all acceptance criteria from user-story.json.'
    };
  }

  // details is now an array of {ac_id, status, evidence, notes}
  const verifiedACs = (verification.details || []).map(d => d.ac_id);
  const missingACs = acIds.filter(id => !verifiedACs.includes(id));

  if (missingACs.length > 0) {
    return {
      decision: 'block',
      reason: `Review did not verify these ACs: ${missingACs.join(', ')}. Re-run review with complete verification.`
    };
  }

  const notFullyImplemented = (verification.details || [])
    .filter(d => d.status === 'NOT_IMPLEMENTED' || d.status === 'PARTIAL')
    .map(d => d.ac_id);

  if (review.status === 'approved' && notFullyImplemented.length > 0) {
    return {
      decision: 'block',
      reason: `Cannot approve with incomplete ACs: ${notFullyImplemented.join(', ')}. All ACs must be IMPLEMENTED. Status must be needs_changes.`
    };
  }

  return null; // Valid
}

async function main() {
  // Read input from stdin (per official docs)
  let input;
  try {
    const stdin = readFileSync(0, 'utf-8');
    input = JSON.parse(stdin);
  } catch {
    process.exit(0); // No valid input, allow
  }

  const transcriptPath = input.agent_transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    process.exit(0); // No transcript, allow
  }

  // Determine agent type from transcript
  const agentType = getAgentTypeFromTranscript(transcriptPath);

  // Only validate our reviewer agents
  const isPlanReviewer = agentType === 'claude-codex:plan-reviewer';
  const isCodeReviewer = agentType === 'claude-codex:code-reviewer';
  const isCodexReviewer = agentType === 'claude-codex:codex-reviewer';

  if (!isPlanReviewer && !isCodeReviewer && !isCodexReviewer) {
    process.exit(0); // Not a reviewer, allow
  }

  // Determine which files to check based on agent type
  let reviewFiles;
  let isPlanReview;

  if (isPlanReviewer) {
    // plan-reviewer handles sonnet/opus plan reviews
    reviewFiles = PLAN_REVIEW_FILES.filter(f => f !== 'review-codex.json');
    isPlanReview = true;
  } else if (isCodeReviewer) {
    // code-reviewer handles sonnet/opus code reviews
    reviewFiles = CODE_REVIEW_FILES.filter(f => f !== 'code-review-codex.json');
    isPlanReview = false;
  } else {
    // codex-reviewer handles both plan and code final reviews
    // Check which phase we're in by looking at what files exist
    const hasImplResult = existsSync(join(TASK_DIR, 'impl-result.json'));
    if (hasImplResult) {
      reviewFiles = ['code-review-codex.json'];
      isPlanReview = false;
    } else {
      reviewFiles = ['review-codex.json'];
      isPlanReview = true;
    }
  }

  // Find the most recently modified review file (just written by agent)
  const recentFile = findMostRecentFile(reviewFiles);
  if (!recentFile) {
    process.exit(0); // No review file found, allow
  }

  const review = readJson(recentFile.path);
  if (!review) {
    process.exit(0); // Can't read review, allow
  }

  const userStory = readJson(join(TASK_DIR, 'user-story.json'));

  // Validate AC coverage
  const error = isPlanReview
    ? validatePlanReview(review, userStory)
    : validateCodeReview(review, userStory);

  if (error) {
    console.log(JSON.stringify(error));
  }

  process.exit(0);
}

// Only run main when executed directly (not imported for testing)
if (import.meta.main) {
  main().catch(() => {
    process.exit(0); // Fail open on errors
  });
}
