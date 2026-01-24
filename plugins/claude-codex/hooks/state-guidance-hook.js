#!/usr/bin/env bun
/**
 * State Guidance Hook - Injects state-aware instructions at turn start
 *
 * This UserPromptSubmit hook proactively reminds Claude about the current pipeline
 * state and what actions should be taken next. It helps prevent skipping steps
 * like plan reviews before implementation.
 *
 * In the multi-session orchestrator architecture:
 * - Reviews are done via Task tool with plan-reviewer/code-reviewer agents
 * - Codex review is done via /review-codex skill
 */

const fs = require('fs');
const path = require('path');

// Get directories from environment
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TASK_DIR = path.join(PROJECT_DIR, '.task');
const STATE_FILE = path.join(TASK_DIR, 'state.json');

/**
 * Safely read and parse JSON file
 */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check status of all plan review files
 */
function checkReviewStatus() {
  const reviews = ['review-sonnet.json', 'review-opus.json', 'review-codex.json'];
  const status = {};

  for (const r of reviews) {
    const file = path.join(TASK_DIR, r);
    const data = readJson(file);
    status[r.replace('.json', '')] = data?.status || 'missing';
  }

  return status;
}

/**
 * Format review status for display
 */
function formatReviewStatus(reviewStatus) {
  return Object.entries(reviewStatus)
    .map(([name, status]) => `${name}: ${status}`)
    .join(', ');
}

/**
 * Main hook logic
 */
function main() {
  // Check if state file exists
  const state = readJson(STATE_FILE);
  if (!state) {
    // No state file means no active pipeline - allow without guidance
    process.exit(0);
  }

  const reviewStatus = checkReviewStatus();
  const allApproved = Object.values(reviewStatus).every(s => s === 'approved');
  const currentStatus = state.status || 'idle';

  let guidance = '';

  // Provide state-specific guidance
  switch (currentStatus) {
    case 'plan_refining':
    case 'plan_reviewing':
      if (!allApproved) {
        const statusStr = formatReviewStatus(reviewStatus);
        guidance = [
          '',
          '**PIPELINE STATE: Plan Review Phase**',
          '',
          `Current review status: ${statusStr}`,
          '',
          'REQUIRED ACTIONS:',
          '1. Run plan review with sonnet (Task tool + plan-reviewer agent)',
          '2. Run plan review with opus (Task tool + plan-reviewer agent)',
          '3. Run /review-codex (Codex final gate)',
          '',
          'ALL reviews must return status: "approved" before you can start implementation.',
          'DO NOT attempt to transition to implementing state until all reviews pass.',
          ''
        ].join('\n');
      }
      break;

    case 'plan_drafting':
      // Just created plan, remind about review phase
      guidance = [
        '',
        '**PIPELINE STATE: Plan Drafting**',
        '',
        'After creating plan-refined.json, you must:',
        '1. Transition to plan_refining state',
        '2. Run all plan reviews (sonnet, opus, codex)',
        '3. Only start implementation after all reviews approve',
        ''
      ].join('\n');
      break;

    case 'implementing':
    case 'implementing_loop':
      // Already in implementation - check that reviews were done
      if (!allApproved) {
        const statusStr = formatReviewStatus(reviewStatus);
        guidance = [
          '',
          '**WARNING: Implementation started without approved reviews!**',
          '',
          `Current review status: ${statusStr}`,
          '',
          'This may indicate a pipeline issue. All plan reviews should be approved',
          'before implementation begins.',
          ''
        ].join('\n');
      }
      break;

    default:
      // Other states (idle, requirements_gathering, complete, etc.)
      // No special guidance needed
      break;
  }

  // If we have guidance, output it as a system message
  if (guidance) {
    // UserPromptSubmit hooks can modify the prompt by outputting to stdout
    // The guidance will be prepended to Claude's context
    console.log(JSON.stringify({
      systemMessage: guidance
    }));
  }

  // Always allow the prompt to proceed
  process.exit(0);
}

main();
