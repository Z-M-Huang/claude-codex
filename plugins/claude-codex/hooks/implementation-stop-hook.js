#!/usr/bin/env bun
/**
 * Implementation Stop Hook for Claude Codex Ralph Loop
 *
 * This hook intercepts session exit during the implementation loop phase.
 * It checks if all completion criteria are met (reviews pass + tests pass).
 * If not, it blocks exit and re-feeds the implementation prompt.
 *
 * IMPORTANT: This hook READS existing review files - it does NOT run the reviews.
 * The multi-ai orchestrator is responsible for invoking reviews before attempting to exit:
 * - Sonnet/Opus reviews: Task tool with code-reviewer agent
 * - Codex review: /review-codex skill
 *
 * Based on the Ralph Wiggum technique from Anthropic's official plugins.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get directories from environment
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(__dirname);
const TASK_DIR = path.join(PROJECT_DIR, '.task');
const LOOP_STATE_FILE = path.join(TASK_DIR, 'loop-state.json');
const PLAN_FILE = path.join(TASK_DIR, 'plan-refined.json');
const CONFIG_FILE = path.join(PLUGIN_ROOT, 'pipeline.config.json');

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
 * Write JSON file
 */
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Run a command and return { exitCode, output }
 */
function runCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 minute timeout
    });
    return { exitCode: 0, output };
  } catch (error) {
    return {
      exitCode: error.status || 1,
      output: error.stdout || error.stderr || error.message,
    };
  }
}

/**
 * Main hook logic
 */
function main() {
  // Check if loop state file exists
  const loopState = readJson(LOOP_STATE_FILE);
  if (!loopState) {
    // No active loop, allow exit
    process.exit(0);
  }

  // Check if loop is active
  if (loopState.active !== true) {
    // Loop not active, allow exit
    process.exit(0);
  }

  // Read iteration info
  const iteration = loopState.iteration || 0;
  const maxIterations = loopState.max_iterations || 10;
  const completionPromise = loopState.completion_promise || '<promise>IMPLEMENTATION_COMPLETE</promise>';

  // Read config settings
  const config = readJson(CONFIG_FILE);
  const testSuccessExitCode = config?.ralphLoop?.testSuccessExitCode ?? 0;

  // Check if max iterations reached
  if (iteration >= maxIterations) {
    console.log(JSON.stringify({
      decision: 'allow',
      systemMessage: `Max iterations reached (${iteration}/${maxIterations}). Loop terminated.`
    }));
    // Deactivate the loop
    loopState.active = false;
    writeJson(LOOP_STATE_FILE, loopState);
    process.exit(0);
  }

  // Check completion criteria
  let reviewsPassed = true;
  let testsPassed = false; // Default to false - must have tests to pass
  let reviewStatus = '';
  let testStatus = '';

  // Check review files
  const reviewFiles = ['review-sonnet.json', 'review-opus.json', 'review-codex.json'];
  for (const reviewFile of reviewFiles) {
    const reviewPath = path.join(TASK_DIR, reviewFile);
    const review = readJson(reviewPath);
    if (review) {
      const status = review.status || 'unknown';
      if (status !== 'approved') {
        reviewsPassed = false;
        reviewStatus += `${reviewFile.replace('.json', '')}: ${status}; `;
      }
    } else {
      reviewsPassed = false;
      reviewStatus += `${reviewFile.replace('.json', '')}: not run; `;
    }
  }

  // Check test results if plan exists
  const plan = readJson(PLAN_FILE);
  if (plan) {
    const testCommands = plan.test_plan?.commands || [];
    const successPattern = plan.test_plan?.success_pattern || '';
    const failurePattern = plan.test_plan?.failure_pattern || '';

    if (testCommands.length > 0) {
      testsPassed = true; // Assume pass, flip on failure

      for (const cmd of testCommands) {
        if (!cmd) continue;

        // Run test command in project directory
        const result = runCommand(cmd, PROJECT_DIR);

        // Check exit code
        if (result.exitCode !== testSuccessExitCode) {
          testsPassed = false;
          testStatus += `${cmd}: failed (exit code ${result.exitCode}); `;
          continue;
        }

        // Check failure pattern if defined
        if (failurePattern && new RegExp(failurePattern).test(result.output)) {
          testsPassed = false;
          testStatus += `${cmd}: failure pattern detected; `;
          continue;
        }

        // Check success pattern if defined
        if (successPattern && !new RegExp(successPattern).test(result.output)) {
          testsPassed = false;
          testStatus += `${cmd}: success pattern not found; `;
        }
      }
    } else {
      // No test commands defined - TDD violation
      testsPassed = false;
      testStatus = 'No test commands defined in plan (TDD required); ';
    }
  } else {
    // No plan file
    testsPassed = false;
    testStatus = 'Plan file missing - cannot verify tests; ';
  }

  // Check if completion criteria met
  if (reviewsPassed && testsPassed) {
    // All criteria met, allow exit
    loopState.active = false;
    writeJson(LOOP_STATE_FILE, loopState);
    process.exit(0);
  }

  // Increment iteration
  const newIteration = iteration + 1;
  loopState.iteration = newIteration;
  writeJson(LOOP_STATE_FILE, loopState);

  // Build continuation prompt
  const prompt = `Continue implementing based on the plan at .task/plan-refined.json

**Iteration:** ${newIteration} of ${maxIterations}

**Review Status:** (checked existing review files)
${reviewStatus || 'All reviews approved'}

**Test Status:** (run from project directory)
${testStatus || 'All tests passed'}

**What to do:**
1. Fix all issues identified above
2. Run code reviews using Task tool with code-reviewer agent (sonnet then opus)
3. Run /review-codex for final Codex gate
4. Run the test commands from the plan
5. Attempt to exit - the hook will check criteria again

**Review Commands:**
- Sonnet: Task(subagent_type: "Explore", model: "sonnet", prompt: "[code-reviewer agent] Write to review-sonnet.json")
- Opus: Task(subagent_type: "Explore", model: "opus", prompt: "[code-reviewer agent] Write to review-opus.json")
- Codex: Skill(review-codex)

**Completion Criteria:**
- All review files must have status: "approved"
- All test commands must pass (exit code ${testSuccessExitCode})

When complete, output: ${completionPromise}`;

  // Block exit and re-feed the prompt
  console.log(JSON.stringify({
    decision: 'block',
    reason: prompt,
    systemMessage: `Ralph loop iteration ${newIteration}/${maxIterations}: Reviews passed: ${reviewsPassed}, Tests passed: ${testsPassed}`
  }));

  process.exit(2); // Exit code 2 = blocking error
}

main();
