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

// ================== Codex Execution Proof Helpers ==================

/**
 * Tokenize a shell command, respecting single/double quotes.
 * Returns null on unbalanced quotes (conservative reject).
 */
function shellTokenize(cmd: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;
    let token = '';
    while (i < len && !/\s/.test(cmd[i])) {
      if (cmd[i] === '"') {
        i++;
        while (i < len && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < len) { token += cmd[i + 1]; i += 2; }
          else { token += cmd[i]; i++; }
        }
        if (i >= len) return null;
        i++;
      } else if (cmd[i] === "'") {
        i++;
        while (i < len && cmd[i] !== "'") { token += cmd[i]; i++; }
        if (i >= len) return null;
        i++;
      } else { token += cmd[i]; i++; }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Cross-platform bun executable check (bun, bun.exe, /path/to/bun) */
function isBunExecutable(token: string): boolean {
  const basename = token.replace(/\\/g, '/').split('/').pop() || '';
  return basename === 'bun' || basename === 'bun.exe';
}

// Bun flags that consume the next token as a value (not a script path)
const BUN_VALUE_FLAGS = new Set(['-e', '--eval', '-r', '--require', '--config', '--cwd', '--preload', '--define']);

/** Normalize path for cross-platform comparison (\ → /, strip trailing /) */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Derive the expected plugin root from this hook's own filesystem location.
 * Hook is at {plugin-root}/hooks/review-validator.ts.
 * import.meta.dir is bun-specific: directory of the current file.
 */
const EXPECTED_PLUGIN_ROOT = normalizePath(path.resolve(path.join(import.meta.dir, '..')));

/**
 * Check if tokenized command is a codex-review.ts invocation:
 *   1. First token is bun executable
 *   2. First positional token is ${EXPECTED_PLUGIN_ROOT}/scripts/codex-review.ts
 *   3. --type flag is present after the script
 *   4. --plugin-root value equals EXPECTED_PLUGIN_ROOT
 */
function isCodexScriptCall(tokens: string[]): boolean {
  if (tokens.length < 4) return false;
  if (!isBunExecutable(tokens[0])) return false;

  let scriptToken: string | null = null;
  let scriptIndex = -1;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (BUN_VALUE_FLAGS.has(tok)) { i++; continue; }
    if (tok.startsWith('-')) continue;
    scriptToken = tok;
    scriptIndex = i;
    break;
  }
  if (!scriptToken) return false;

  // Script path must be exactly ${pluginRoot}/scripts/codex-review.ts
  const normScript = normalizePath(scriptToken);
  if (normScript !== EXPECTED_PLUGIN_ROOT + '/scripts/codex-review.ts') return false;

  // Extract --type and --plugin-root from script args
  let foundType = false;
  let pluginRootValue: string | null = null;
  for (let j = scriptIndex + 1; j < tokens.length; j++) {
    if (tokens[j] === '--type' || tokens[j].startsWith('--type=')) foundType = true;
    if (tokens[j] === '--plugin-root' && j + 1 < tokens.length) {
      pluginRootValue = tokens[j + 1]; j++;
    } else if (tokens[j].startsWith('--plugin-root=')) {
      pluginRootValue = tokens[j].slice('--plugin-root='.length);
    }
  }

  if (!foundType || !pluginRootValue) return false;

  // --plugin-root value must match the expected root
  return normalizePath(pluginRootValue) === EXPECTED_PLUGIN_ROOT;
}

/**
 * Scan transcript JSONL for a Bash tool_use that invokes codex-review.ts.
 * Splits commands on shell separators (&&, ||, ;, |, &, \n) and checks each
 * segment independently. Only matches actual tool_use entries, not static text
 * in agent definitions or conversation content.
 */
function verifyCodexScriptExecution(transcriptPath: string): boolean {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const contentBlocks = entry?.message?.content || entry?.content || [];
        const blocks = Array.isArray(contentBlocks) ? contentBlocks : [contentBlocks];
        for (const block of blocks) {
          if (block?.type === 'tool_use' && block?.name === 'Bash' && typeof block?.input?.command === 'string') {
            const segments = block.input.command.split(/\s*(?:&&|\|\||[;|&\n])\s*/);
            for (const seg of segments) {
              const tokens = shellTokenize(seg.trim());
              if (tokens && isCodexScriptCall(tokens)) return true;
            }
          }
        }
      } catch { continue; }
    }
    return false;
  } catch { return false; }
}

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
  if (!userStory) {
    return { decision: 'block', reason: 'user-story.json missing or unreadable. Cannot validate AC coverage.' };
  }
  const acIds = (userStory.acceptance_criteria || []).map(ac => ac.id);
  if (acIds.length === 0) {
    return { decision: 'block', reason: 'user-story.json has zero acceptance criteria. Cannot validate review.' };
  }

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
  if (!userStory) {
    return { decision: 'block', reason: 'user-story.json missing or unreadable. Cannot validate AC coverage.' };
  }
  const acIds = (userStory.acceptance_criteria || []).map(ac => ac.id);
  if (acIds.length === 0) {
    return { decision: 'block', reason: 'user-story.json has zero acceptance criteria. Cannot validate review.' };
  }

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
    console.log(JSON.stringify({ decision: 'block', reason: 'No review output file found. Reviewer must write output.' }));
    process.exit(0);
  }

  const review = readJson(recentFile.path) as PlanReview | CodeReview | null;
  if (!review) {
    console.log(JSON.stringify({ decision: 'block', reason: `Review file ${recentFile.path} exists but is unreadable or invalid JSON.` }));
    process.exit(0);
  }

  const userStory = readJson(path.join(TASK_DIR, 'user-story.json')) as UserStory | null;

  // Codex-specific enforcement: execution proof, error passthrough, verification stamp
  if (isCodexReviewer) {
    // 1. Execution proof — verify the agent actually ran codex-review.ts
    if (!verifyCodexScriptExecution(transcriptPath)) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'Codex reviewer did not execute codex-review.ts. Transcript shows no Bash invocation of the script. Agent must run the script, not fabricate output.'
      }));
      process.exit(0);
    }

    // 2. Error passthrough — when Codex CLI fails, let orchestrator handle it
    if ((review as Record<string, unknown>).status === 'error') {
      process.exit(0);
    }

    // 3. Sanity check — non-error Codex outputs must have _codex_verification
    const verification = (review as Record<string, unknown>)._codex_verification;
    if (!verification || typeof verification !== 'object') {
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'Codex review output missing _codex_verification stamp. Output was not produced by codex-review.ts.'
      }));
      process.exit(0);
    }
  }

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
