#!/usr/bin/env bun
/**
 * Simplified Guidance Hook - Advisory Mode Orchestration
 *
 * This UserPromptSubmit hook provides guidance based on .task/*.json files.
 * State is implicit from which files exist.
 * Enforcement is handled by SubagentStop hook (review-validator.ts).
 *
 * Provides:
 * 1. Current phase detection from artifact files
 * 2. Advisory guidance for next task
 * 3. AC count reminder for reviews
 */

import fs from 'fs';
import path from 'path';
import { checkForUpdate } from './version-check.ts';
import {
  computeTaskDir,
  determinePhase,
  getProgress,
  discoverAnalysisFiles,
  type PhaseResult,
  type PipelineProgress,
} from '../scripts/pipeline-utils.ts';

// Get task directory from shared utility
export const TASK_DIR = computeTaskDir();

/**
 * Compute guidance message based on current progress
 */
export function computeGuidance(): { message: string; phase: string; isEmpty?: boolean; isComplete?: boolean } {
  // Check if .task directory exists
  if (!fs.existsSync(TASK_DIR)) {
    return {
      message: '',
      phase: 'idle',
      isEmpty: true
    };
  }

  const progress = getProgress(TASK_DIR);
  const { phase, message } = determinePhase(progress);
  const lines = [message];

  // Add AC reminder if user story exists with ACs
  const ac = progress.userStory?.acceptance_criteria;
  if (Array.isArray(ac) && ac.length > 0) {
    const acCount = ac.length;
    lines.push('');
    lines.push(`**Reminder**: ${acCount} acceptance criteria must be verified in all reviews.`);
    lines.push('Reviews MUST include acceptance_criteria_verification (code) or requirements_coverage (plan).');
  }

  return {
    message: lines.join('\n'),
    phase,
    isComplete: phase === 'complete'
  };
}

/**
 * Emit system message to stdout as JSON
 */
function emitSystemMessage(updateNotification: string | null, guidance: { message: string; phase: string }): void {
  let additionalContext = '';

  if (updateNotification) {
    additionalContext += `${updateNotification}\n\n`;
  }

  if (guidance && guidance.message) {
    additionalContext += guidance.message;
  }

  if (additionalContext) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext
      }
    }));
  }
}

/**
 * Main hook logic
 */
function main(): void {
  // Check for plugin updates (synchronous, non-blocking)
  let updateNotification: string | null = null;
  try {
    updateNotification = checkForUpdate();
  } catch {
    // Silent fail - version check is not critical
  }

  // Compute guidance based on current progress
  const guidance = computeGuidance();

  // Emit combined message
  emitSystemMessage(updateNotification, guidance);

  // Always allow the prompt to proceed
  process.exit(0);
}

// Re-export for test compatibility
export { determinePhase, discoverAnalysisFiles };

// Import-safe guard - only run main() when executed directly
if (import.meta.main) {
  main();
}
