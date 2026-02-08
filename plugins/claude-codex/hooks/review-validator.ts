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

import fs from 'fs';
import path from 'path';
import { readJson, computeTaskDir } from '../scripts/pipeline-utils.ts';

const TASK_DIR = computeTaskDir();

// Actual file names used by the pipeline (per SKILL.md Agent Reference)
const PLAN_REVIEW_FILES = ['review-sonnet.json', 'review-opus.json', 'review-codex.json'];
const CODE_REVIEW_FILES = ['code-review-sonnet.json', 'code-review-opus.json', 'code-review-codex.json'];

interface ReviewBlockResult {
  decision: 'block';
  reason: string;
}

interface UserStory {
  acceptance_criteria?: Array<{ id: string }>;
}

interface PlanReview {
  status?: string;
  requirements_coverage?: {
    mapping?: Array<{ ac_id: string; steps?: string[] }>;
    missing?: string[];
  };
}

interface CodeReview {
  status?: string;
  acceptance_criteria_verification?: {
    details?: Array<{ ac_id: string; status: string; evidence?: string; notes?: string }>;
  };
}

function getAgentTypeFromTranscript(transcriptPath: string): string | null {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
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
function findMostRecentFile(files: string[]): { path: string; filename: string } | null {
  let mostRecent: { path: string; filename: string } | null = null;
  let mostRecentTime = 0;

  for (const filename of files) {
    const filepath = path.join(TASK_DIR, filename);
    if (!fs.existsSync(filepath)) continue;

    try {
      const stat = fs.statSync(filepath);
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

export function validatePlanReview(review: PlanReview, userStory: UserStory | null): ReviewBlockResult | null {
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

  if (review.status === 'approved' && (coverage.missing?.length ?? 0) > 0) {
    return {
      decision: 'block',
      reason: `Cannot approve with missing requirements: ${coverage.missing!.join(', ')}. Status must be needs_changes.`
    };
  }

  return null; // Valid
}

export function validateCodeReview(review: CodeReview, userStory: UserStory | null): ReviewBlockResult | null {
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

async function main(): Promise<void> {
  // Read input from stdin (per official docs)
  let input: { agent_transcript_path?: string };
  try {
    const stdin = fs.readFileSync(0, 'utf-8');
    input = JSON.parse(stdin);
  } catch {
    process.exit(0); // No valid input, allow
  }

  const transcriptPath = input!.agent_transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
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
  let reviewFiles: string[];
  let isPlanReview: boolean;

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
    const hasImplResult = fs.existsSync(path.join(TASK_DIR, 'impl-result.json'));
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

  const review = readJson(recentFile.path) as PlanReview | CodeReview | null;
  if (!review) {
    process.exit(0); // Can't read review, allow
  }

  const userStory = readJson(path.join(TASK_DIR, 'user-story.json')) as UserStory | null;

  // Validate AC coverage
  const error = isPlanReview
    ? validatePlanReview(review as PlanReview, userStory)
    : validateCodeReview(review as CodeReview, userStory);

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
