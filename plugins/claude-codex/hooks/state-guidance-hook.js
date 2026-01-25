#!/usr/bin/env bun
/**
 * State Guidance Hook - Injects state-aware instructions at turn start
 *
 * This UserPromptSubmit hook proactively reminds Claude about the current pipeline
 * state and what actions should be taken next. It helps prevent skipping steps
 * like plan reviews before implementation.
 *
 * In the multi-session orchestrator architecture with task-based enforcement:
 * - Pipeline tasks are tracked via TaskCreate/TaskUpdate/TaskList tools
 * - Reviews are enforced via blockedBy dependencies
 * - Codex review is done via codex-reviewer agent (Task-based)
 */

const fs = require('fs');
const path = require('path');

// Import version check module
const { checkForUpdate } = require('./version-check.js');

// Get directories from environment
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TASK_DIR = path.join(PROJECT_DIR, '.task');
const STATE_FILE = path.join(TASK_DIR, 'state.json');
const PIPELINE_TASKS_FILE = path.join(TASK_DIR, 'pipeline-tasks.json');

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
 * Check if pipeline tasks have been created
 */
function hasPipelineTasks() {
  return fs.existsSync(PIPELINE_TASKS_FILE);
}

/**
 * Compute guidance message based on current state
 */
function computeGuidance(state, reviewStatus, pipelineTasksExist) {
  const allApproved = Object.values(reviewStatus).every(s => s === 'approved');
  const currentStatus = state?.status || 'idle';

  switch (currentStatus) {
    case 'plan_refining':
    case 'plan_reviewing':
      if (!allApproved) {
        const statusStr = formatReviewStatus(reviewStatus);
        return [
          '',
          '**PIPELINE STATE: Plan Review Phase**',
          '',
          `Current review status: ${statusStr}`,
          '',
          'REQUIRED ACTIONS (task-enforced sequence):',
          '1. Query TaskList() to find next unblocked review task',
          '2. Execute the task (Sonnet → Opus → Codex)',
          '3. If needs_changes, create fix task before proceeding',
          '',
          'blockedBy dependencies prevent skipping. Use TaskList() to find the next task.',
          ''
        ].join('\n');
      }
      return '';

    case 'plan_drafting':
      if (allApproved) {
        return ''; // State is stale - reviews passed
      }
      if (pipelineTasksExist) {
        return [
          '',
          '**PIPELINE STATE: Plan Created**',
          '',
          'Pipeline tasks exist. Use the task-based execution loop:',
          '1. Query TaskList() to find next unblocked task',
          '2. Execute the task (plan reviews are blocked until plan task completes)',
          '3. Mark task completed, loop back to step 1',
          ''
        ].join('\n');
      }
      return [
        '',
        '**PIPELINE STATE: Plan Drafting**',
        '',
        'After creating plan-refined.json:',
        '1. Create pipeline task chain with TaskCreate (if not already done)',
        '2. Use TaskList() to find next task and execute it',
        '3. Reviews are enforced via blockedBy dependencies',
        ''
      ].join('\n');

    case 'implementing':
    case 'implementing_loop':
      if (!allApproved) {
        const statusStr = formatReviewStatus(reviewStatus);
        return [
          '',
          '**WARNING: Implementation started without approved reviews!**',
          '',
          `Current review status: ${statusStr}`,
          '',
          'This may indicate a pipeline issue. All plan reviews should be approved',
          'before implementation begins. blockedBy dependencies should prevent this.',
          ''
        ].join('\n');
      }
      return '';

    case 'idle':
      if (pipelineTasksExist) {
        return [
          '',
          '**PIPELINE STATE: Idle (with existing tasks)**',
          '',
          'Pipeline tasks exist but state is idle.',
          'Use TaskList() to check task status and continue execution.',
          ''
        ].join('\n');
      }
      return '';

    default:
      return '';
  }
}

/**
 * Emit system message to stdout as JSON
 */
function emitSystemMessage(updateNotification, guidance) {
  let message = '';
  if (updateNotification) {
    message += `\n${updateNotification}\n`;
  }
  if (guidance) {
    message += guidance;
  }

  if (message) {
    console.log(JSON.stringify({
      systemMessage: message
    }));
  }
}

/**
 * Main hook logic - orchestrates version check and state guidance
 */
function main() {
  // Check for plugin updates (synchronous, non-blocking)
  let updateNotification = null;
  try {
    updateNotification = checkForUpdate();
  } catch {
    // Silent fail - version check is not critical
  }

  // Check if state file exists
  const state = readJson(STATE_FILE);
  if (!state) {
    // No state file means no active pipeline
    // But still show update notification if available
    emitSystemMessage(updateNotification, '');
    process.exit(0);
  }

  // Compute guidance based on current state
  const reviewStatus = checkReviewStatus();
  const pipelineTasksExist = hasPipelineTasks();
  const guidance = computeGuidance(state, reviewStatus, pipelineTasksExist);

  // Emit combined message
  emitSystemMessage(updateNotification, guidance);

  // Always allow the prompt to proceed
  process.exit(0);
}

main();
