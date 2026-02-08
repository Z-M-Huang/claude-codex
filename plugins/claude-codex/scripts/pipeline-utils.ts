/**
 * Shared pipeline utilities — single source of truth for phase detection.
 *
 * Both orchestrator.ts and guidance-hook.ts import from here,
 * eliminating the duplicated determinePhase logic.
 */

import fs from 'fs';
import path from 'path';

// ─── Phase Token Contract ───────────────────────────────────────────

/** Machine-readable phase identifier. Rules:
 *  - lowercase snake_case only
 *  - no spaces, parentheses, or embedded counts
 *  - used for routing/matching, never for display
 */
export type PhaseToken =
  | 'idle'
  | 'requirements_gathering'
  | 'requirements_team_pending'
  | 'requirements_team_exploring'
  | 'plan_drafting'
  | 'plan_review_sonnet'
  | 'clarification_plan_sonnet'
  | 'fix_plan_sonnet'
  | 'plan_review_opus'
  | 'clarification_plan_opus'
  | 'fix_plan_opus'
  | 'plan_review_codex'
  | 'clarification_plan_codex'
  | 'fix_plan_codex'
  | 'plan_rejected'
  | 'implementation'
  | 'implementation_failed'
  | 'code_review_sonnet'
  | 'clarification_code_sonnet'
  | 'fix_code_sonnet'
  | 'code_review_opus'
  | 'clarification_code_opus'
  | 'fix_code_opus'
  | 'code_review_codex'
  | 'clarification_code_codex'
  | 'fix_code_codex'
  | 'code_rejected'
  | 'complete';

/** Result from determinePhase — phase is machine token, message is human display text */
export interface PhaseResult {
  phase: PhaseToken;
  message: string;
}

export interface AnalysisFile {
  name: string;
  file: string;
  data: unknown;
}

export interface PipelineProgress {
  userStory: Record<string, unknown> | null;
  plan: unknown | null;
  pipelineTasks: unknown | null;
  analysisFiles: AnalysisFile[];
  planReviewSonnet: { status: string; clarification_questions?: string[] } | null;
  planReviewOpus: { status: string; clarification_questions?: string[] } | null;
  planReviewCodex: { status: string; clarification_questions?: string[] } | null;
  implResult: { status: string } | null;
  codeReviewSonnet: { status: string; clarification_questions?: string[] } | null;
  codeReviewOpus: { status: string; clarification_questions?: string[] } | null;
  codeReviewCodex: { status: string; clarification_questions?: string[] } | null;
}

// ─── Path Helpers ───────────────────────────────────────────────────

/** Compute the .task directory path. Resolves at call time from env/cwd. */
export function computeTaskDir(): string {
  return path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.task');
}

// ─── File Helpers ───────────────────────────────────────────────────

/** Check if a file exists */
export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Write JSON data to a file, creating parent directories as needed */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Safely read and parse JSON file */
export function readJson(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Check if a JSON file exists and has content */
export function checkJsonExists(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** Get status field from a JSON file */
export function getJsonStatus(filePath: string): string | null {
  if (!checkJsonExists(filePath)) return null;
  const data = readJson(filePath) as Record<string, unknown> | null;
  if (!data || typeof data.status !== 'string') return null;
  return data.status;
}

/** Discover all specialist analysis files dynamically */
export function discoverAnalysisFiles(taskDir: string): AnalysisFile[] {
  try {
    if (!fs.existsSync(taskDir)) return [];
    return fs.readdirSync(taskDir)
      .filter((f: string) => f.startsWith('analysis-') && f.endsWith('.json'))
      .map((f: string) => {
        const name = f.replace('analysis-', '').replace('.json', '');
        return { name, file: f, data: readJson(path.join(taskDir, f)) };
      })
      .filter((entry: AnalysisFile) => entry.data !== null);
  } catch {
    return [];
  }
}

/** Get progress from artifact files */
export function getProgress(taskDir: string): PipelineProgress {
  return {
    userStory: readJson(path.join(taskDir, 'user-story.json')) as Record<string, unknown> | null,
    plan: readJson(path.join(taskDir, 'plan-refined.json')),
    pipelineTasks: readJson(path.join(taskDir, 'pipeline-tasks.json')),
    implResult: readJson(path.join(taskDir, 'impl-result.json')) as { status: string } | null,
    planReviewSonnet: readJson(path.join(taskDir, 'review-sonnet.json')) as PipelineProgress['planReviewSonnet'],
    planReviewOpus: readJson(path.join(taskDir, 'review-opus.json')) as PipelineProgress['planReviewOpus'],
    planReviewCodex: readJson(path.join(taskDir, 'review-codex.json')) as PipelineProgress['planReviewCodex'],
    codeReviewSonnet: readJson(path.join(taskDir, 'code-review-sonnet.json')) as PipelineProgress['codeReviewSonnet'],
    codeReviewOpus: readJson(path.join(taskDir, 'code-review-opus.json')) as PipelineProgress['codeReviewOpus'],
    codeReviewCodex: readJson(path.join(taskDir, 'code-review-codex.json')) as PipelineProgress['codeReviewCodex'],
    analysisFiles: discoverAnalysisFiles(taskDir),
  };
}

// ─── Phase Detection ────────────────────────────────────────────────

/** Determine current phase from pipeline progress */
export function determinePhase(progress: PipelineProgress): PhaseResult {
  // No user story yet — check for team-based requirements sub-phases
  if (!progress.userStory) {
    const hasAnyAnalysis = progress.analysisFiles.length > 0;

    if (hasAnyAnalysis) {
      const completed = progress.analysisFiles.map(f =>
        f.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('/')
      );
      return {
        phase: 'requirements_team_exploring',
        message: `**Phase: Requirements Gathering (Team Exploring)**\n${completed.length} specialist analysis file(s) received: ${completed.join(', ')}.\n**Do NOT start synthesis yet.** Wait for ALL specialist teammates to complete and go idle before spawning requirements-gatherer.\nUse AskUserQuestion with findings as they arrive via messages.`
      };
    }

    // Check if pipeline-tasks.json exists (pipeline started) but no analyses yet
    if (progress.pipelineTasks) {
      return {
        phase: 'requirements_team_pending',
        message: '**Phase: Requirements Gathering (Team Pending)**\nPipeline initialized. Spawn specialist teammates into the pipeline team.\nIf spawning fails, fall back to spawning requirements-gatherer directly in Standard Mode.'
      };
    }

    return {
      phase: 'requirements_gathering',
      message: '**Phase: Requirements Gathering**\nUse requirements-gatherer agent (opus) to create user-story.json.\nIf teams are available, create agent team for specialist exploration first; otherwise use requirements-gatherer directly.'
    };
  }

  // No plan yet
  if (!progress.plan) {
    return {
      phase: 'plan_drafting',
      message: '**Phase: Planning**\nUse planner agent (opus) to create plan-refined.json'
    };
  }

  // Plan review chain
  if (!progress.planReviewSonnet?.status) {
    return {
      phase: 'plan_review_sonnet',
      message: '**Phase: Plan Review**\n→ Run Sonnet plan review (plan-reviewer agent, sonnet)'
    };
  }
  if (progress.planReviewSonnet.status === 'needs_clarification') {
    const questions = progress.planReviewSonnet.clarification_questions || [];
    return {
      phase: 'clarification_plan_sonnet',
      message: `**Phase: Clarification Needed**\nSonnet needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.planReviewSonnet.status === 'needs_changes') {
    return {
      phase: 'fix_plan_sonnet',
      message: '**Phase: Fix Plan**\nSonnet needs changes. Create fix + re-review tasks.'
    };
  }

  if (!progress.planReviewOpus?.status) {
    return {
      phase: 'plan_review_opus',
      message: '**Phase: Plan Review**\n→ Run Opus plan review (plan-reviewer agent, opus)'
    };
  }
  if (progress.planReviewOpus.status === 'needs_clarification') {
    const questions = progress.planReviewOpus.clarification_questions || [];
    return {
      phase: 'clarification_plan_opus',
      message: `**Phase: Clarification Needed**\nOpus needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.planReviewOpus.status === 'needs_changes') {
    return {
      phase: 'fix_plan_opus',
      message: '**Phase: Fix Plan**\nOpus needs changes. Create fix + re-review tasks.'
    };
  }

  if (!progress.planReviewCodex?.status) {
    return {
      phase: 'plan_review_codex',
      message: '**Phase: Plan Review**\n→ Run Codex plan review (FINAL GATE - codex-reviewer agent)'
    };
  }
  if (progress.planReviewCodex.status === 'needs_clarification') {
    const questions = progress.planReviewCodex.clarification_questions || [];
    return {
      phase: 'clarification_plan_codex',
      message: `**Phase: Clarification Needed**\nCodex needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.planReviewCodex.status === 'needs_changes') {
    return {
      phase: 'fix_plan_codex',
      message: '**Phase: Fix Plan**\nCodex needs changes. Create fix + re-review tasks.'
    };
  }
  if (progress.planReviewCodex.status === 'rejected') {
    return {
      phase: 'plan_rejected',
      message: '**Phase: Plan Rejected**\nCodex rejected the plan. Significant rework required.'
    };
  }

  // Implementation
  if (!progress.implResult?.status || progress.implResult.status === 'partial') {
    return {
      phase: 'implementation',
      message: '**Phase: Implementation**\nUse implementer agent (sonnet) to implement plan-refined.json'
    };
  }
  if (progress.implResult.status === 'failed') {
    return {
      phase: 'implementation_failed',
      message: '**Phase: Implementation Failed**\nCheck impl-result.json for failure details.'
    };
  }

  // Code review chain
  if (!progress.codeReviewSonnet?.status) {
    return {
      phase: 'code_review_sonnet',
      message: '**Phase: Code Review**\n→ Run Sonnet code review (code-reviewer agent, sonnet)'
    };
  }
  if (progress.codeReviewSonnet.status === 'needs_clarification') {
    const questions = progress.codeReviewSonnet.clarification_questions || [];
    return {
      phase: 'clarification_code_sonnet',
      message: `**Phase: Clarification Needed**\nSonnet needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.codeReviewSonnet.status === 'needs_changes') {
    return {
      phase: 'fix_code_sonnet',
      message: '**Phase: Fix Code**\nSonnet needs changes. Create fix + re-review tasks.'
    };
  }

  if (!progress.codeReviewOpus?.status) {
    return {
      phase: 'code_review_opus',
      message: '**Phase: Code Review**\n→ Run Opus code review (code-reviewer agent, opus)'
    };
  }
  if (progress.codeReviewOpus.status === 'needs_clarification') {
    const questions = progress.codeReviewOpus.clarification_questions || [];
    return {
      phase: 'clarification_code_opus',
      message: `**Phase: Clarification Needed**\nOpus needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.codeReviewOpus.status === 'needs_changes') {
    return {
      phase: 'fix_code_opus',
      message: '**Phase: Fix Code**\nOpus needs changes. Create fix + re-review tasks.'
    };
  }

  if (!progress.codeReviewCodex?.status) {
    return {
      phase: 'code_review_codex',
      message: '**Phase: Code Review**\n→ Run Codex code review (FINAL GATE - codex-reviewer agent)'
    };
  }
  if (progress.codeReviewCodex.status === 'needs_clarification') {
    const questions = progress.codeReviewCodex.clarification_questions || [];
    return {
      phase: 'clarification_code_codex',
      message: `**Phase: Clarification Needed**\nCodex needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
    };
  }
  if (progress.codeReviewCodex.status === 'needs_changes') {
    return {
      phase: 'fix_code_codex',
      message: '**Phase: Fix Code**\nCodex needs changes. Create fix + re-review tasks.'
    };
  }
  if (progress.codeReviewCodex.status === 'rejected') {
    return {
      phase: 'code_rejected',
      message: '**Phase: Code Rejected**\nCodex rejected implementation. Major rework required.'
    };
  }

  // All reviews approved
  return {
    phase: 'complete',
    message: '**Phase: Complete**\nAll reviews approved. Pipeline finished.'
  };
}
