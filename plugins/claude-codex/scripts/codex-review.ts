#!/usr/bin/env bun
/**
 * Codex Review Wrapper Script
 *
 * Cross-platform script that invokes Codex CLI for plan/code reviews.
 * Handles platform detection, timeout, session management, validation, and structured output.
 *
 * Usage:
 *   bun codex-review.ts --type plan --plugin-root /path/to/plugin
 *   bun codex-review.ts --type code --plugin-root /path/to/plugin
 *   bun codex-review.ts --type plan --plugin-root /path/to/plugin --resume
 *
 * The script automatically checks for .task/.codex-session-active to determine
 * if this is a first review or subsequent review (resume).
 *
 * Exit codes:
 *   0 - Success (review completed)
 *   1 - Validation error (missing files, invalid output)
 *   2 - Codex CLI error (not installed, auth failure)
 *   3 - Timeout
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readJson as _readJsonBase, fileExists, writeJson } from './pipeline-utils.ts';

/** Typed wrapper — codex-review expects Record<string, unknown> | null */
function readJson(filePath: string): Record<string, unknown> | null {
  return _readJsonBase(filePath) as Record<string, unknown> | null;
}

// ================== CONFIGURATION ==================

const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const TASK_DIR = '.task';
const STDERR_FILE = path.join(TASK_DIR, 'codex_stderr.log');

// Output file depends on review type (plan vs code)
function getOutputFile(reviewType: string): string {
  // Plan reviews: review-codex.json
  // Code reviews: code-review-codex.json (to match pipeline conventions)
  return reviewType === 'code'
    ? path.join(TASK_DIR, 'code-review-codex.json')
    : path.join(TASK_DIR, 'review-codex.json');
}

// Session markers are scoped by review type to prevent cross-contamination
function getSessionMarker(reviewType: string): string {
  return path.join(TASK_DIR, `.codex-session-${reviewType}`);
}

// ================== ARGUMENT PARSING ==================

interface ParsedArgs {
  type: string | null;
  pluginRoot: string | null;
  forceResume: boolean;
  changesSummary: string | null;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = { type: null, pluginRoot: null, forceResume: false, changesSummary: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      result.type = args[i + 1];
      i++;
    } else if (args[i] === '--plugin-root' && args[i + 1]) {
      result.pluginRoot = args[i + 1];
      i++;
    } else if (args[i] === '--resume') {
      result.forceResume = true;
    } else if (args[i] === '--changes-summary' && args[i + 1]) {
      result.changesSummary = args[i + 1];
      i++;
    }
  }

  return result;
}

// ================== PLATFORM DETECTION ==================

function getPlatform(): string {
  const platform = os.platform();
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function isCodexInstalled(): boolean {
  try {
    execSync('codex --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ================== FILE HELPERS ==================

function writeError(error: string, phase: string, reviewType: string | null): void {
  const outputFile = getOutputFile(reviewType || 'plan');
  writeJson(outputFile, {
    status: 'error',
    error: error,
    phase: phase,
    timestamp: new Date().toISOString()
  });
}

// ================== SESSION MANAGEMENT ==================

function hasActiveSession(reviewType: string): boolean {
  return fileExists(getSessionMarker(reviewType));
}

function createSessionMarker(reviewType: string): void {
  try {
    fs.writeFileSync(getSessionMarker(reviewType), new Date().toISOString());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not create session marker: ${message}`);
  }
}

function removeSessionMarker(reviewType: string): void {
  try {
    const marker = getSessionMarker(reviewType);
    if (fileExists(marker)) {
      fs.unlinkSync(marker);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not remove session marker: ${message}`);
  }
}

// ================== INPUT VALIDATION ==================

function validateInputs(args: ParsedArgs): string[] {
  const errors: string[] = [];

  // Check review type
  if (!args.type || !['plan', 'code'].includes(args.type)) {
    errors.push('Invalid or missing --type (must be "plan" or "code")');
  }

  // Check plugin root
  if (!args.pluginRoot) {
    errors.push('Missing --plugin-root');
  } else if (!fileExists(args.pluginRoot)) {
    errors.push(`Plugin root not found: ${args.pluginRoot}`);
  }

  // Check task directory
  if (!fileExists(TASK_DIR)) {
    errors.push('.task directory not found');
  }

  // Check review-specific input files
  if (args.type === 'plan') {
    if (!fileExists(path.join(TASK_DIR, 'plan-refined.json'))) {
      errors.push('Missing .task/plan-refined.json for plan review');
    }
  } else if (args.type === 'code') {
    if (!fileExists(path.join(TASK_DIR, 'impl-result.json'))) {
      errors.push('Missing .task/impl-result.json for code review');
    }
  }

  // Check schema files
  if (args.pluginRoot) {
    const schemaFile = args.type === 'plan'
      ? 'plan-review.schema.json'
      : 'review-result.schema.json';
    const schemaPath = path.join(args.pluginRoot, 'docs', 'schemas', schemaFile);
    if (!fileExists(schemaPath)) {
      errors.push(`Missing schema file: ${schemaPath}`);
    }

    const standardsPath = path.join(args.pluginRoot, 'docs', 'standards.md');
    if (!fileExists(standardsPath)) {
      errors.push(`Missing standards file: ${standardsPath}`);
    }
  }

  // Check Codex CLI
  if (!isCodexInstalled()) {
    errors.push('Codex CLI not installed. Install from: https://codex.openai.com');
  }

  return errors;
}

// ================== CODEX EXECUTION ==================

interface CmdConfig {
  command: string;
  args: string[];
}

function buildCodexCommand(args: ParsedArgs, isResume: boolean): CmdConfig {
  const schemaFile = args.type === 'plan'
    ? 'plan-review.schema.json'
    : 'review-result.schema.json';
  const schemaPath = path.join(args.pluginRoot!, 'docs', 'schemas', schemaFile);
  const standardsPath = path.join(args.pluginRoot!, 'docs', 'standards.md');

  const inputFile = args.type === 'plan'
    ? '.task/plan-refined.json'
    : '.task/impl-result.json';

  // Build the review prompt
  let reviewPrompt: string;

  if (isResume && args.changesSummary) {
    // Resume with changes summary - focused re-review
    reviewPrompt = `Re-review after fixes. Changes made:\n${args.changesSummary}\n\nVerify fixes address previous concerns. Check against ${standardsPath}.`;
  } else if (isResume) {
    // Resume without summary - general re-review
    reviewPrompt = `Re-review ${inputFile}. Previous concerns should be addressed. Verify against ${standardsPath}.`;
  } else {
    // Initial review - point to files, criteria in standards.md
    reviewPrompt = `Review ${inputFile} against ${standardsPath}. Final gate review for ${args.type === 'plan' ? 'plan approval' : 'code quality'}. If unclear, set needs_clarification: true.`;
  }

  // Build command args - output file depends on review type
  const outputFile = getOutputFile(args.type!);
  const cmdArgs = [
    'exec',
    '--full-auto',
    '--skip-git-repo-check',
    '--output-schema', schemaPath,
    '-o', outputFile
  ];

  // Add resume flag if resuming
  if (isResume) {
    cmdArgs.push('resume', '--last');
  }

  // Add the prompt
  cmdArgs.push(reviewPrompt);

  return {
    command: 'codex',
    args: cmdArgs
  };
}

/**
 * Escape argument for Windows shell
 */
function escapeWinArg(arg: string): string {
  // If arg contains spaces or special chars, wrap in double quotes
  // Escape any existing double quotes
  if (/[\s"&|<>^]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

interface RunResult {
  success: boolean;
  error?: string;
  code: number;
  message?: string;
}

function runCodex(cmdConfig: CmdConfig): Promise<RunResult> {
  return new Promise((resolve) => {
    const stderrStream = fs.createWriteStream(STDERR_FILE);
    let timedOut = false;

    const isWindows = os.platform() === 'win32';
    let proc: ReturnType<typeof spawn>;

    if (isWindows) {
      // On Windows, npm global commands are .cmd files that require shell
      // Build command string with properly escaped args to avoid DEP0190 warning
      const escapedArgs = cmdConfig.args.map(escapeWinArg);
      const fullCommand = `${cmdConfig.command} ${escapedArgs.join(' ')}`;
      proc = spawn(fullCommand, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });
    } else {
      // On Unix, shell: false is safer and works directly
      proc = spawn(cmdConfig.command, cmdConfig.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
    }

    proc.stderr!.pipe(stderrStream);

    // Set timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      stderrStream.end();

      if (timedOut) {
        resolve({ success: false, error: 'timeout', code: 124 });
      } else if (code === 0) {
        resolve({ success: true, code: 0 });
      } else {
        // Check stderr for specific errors
        let errorType = 'execution_failed';
        try {
          const stderr = fs.readFileSync(STDERR_FILE, 'utf8');
          if (stderr.includes('authentication') || stderr.includes('auth')) {
            errorType = 'auth_required';
          } else if (stderr.includes('not found') || stderr.includes('command not found')) {
            errorType = 'not_installed';
          } else if (stderr.includes('session') || stderr.includes('expired')) {
            errorType = 'session_expired';
          }
        } catch { /* ignore */ }

        resolve({ success: false, error: errorType, code: code ?? 1 });
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);
      stderrStream.end();

      if (err.code === 'ENOENT') {
        resolve({ success: false, error: 'not_installed', code: 127 });
      } else {
        resolve({ success: false, error: 'spawn_error', code: 1, message: err.message });
      }
    });
  });
}

// ================== OUTPUT VALIDATION ==================

function validateOutput(reviewType: string): { valid: boolean; error?: string; output?: Record<string, unknown> } {
  const outputFile = getOutputFile(reviewType);
  if (!fileExists(outputFile)) {
    return { valid: false, error: 'Output file not created' };
  }

  const output = readJson(outputFile);
  if (!output) {
    return { valid: false, error: 'Output is not valid JSON' };
  }

  if (!output.status) {
    return { valid: false, error: 'Output missing "status" field' };
  }

  // Valid statuses (per updated schemas - both support all four)
  const validStatuses = ['approved', 'needs_changes', 'needs_clarification', 'rejected'];

  if (!validStatuses.includes(output.status as string)) {
    return { valid: false, error: `Invalid status "${output.status}". Must be one of: ${validStatuses.join(', ')}` };
  }

  // Fix: Properly check summary is a string (not just truthy)
  if (typeof output.summary !== 'string') {
    return { valid: false, error: 'Output missing "summary" field or summary is not a string' };
  }

  return { valid: true, output: output };
}

// ================== MAIN ==================

// Captured for error handling in catch block
let currentReviewType: string | null = null;

async function main(): Promise<void> {
  const args = parseArgs();
  currentReviewType = args.type; // Capture early for catch block
  const platform = getPlatform();

  // Determine if this is a resume (session active or --resume flag)
  // Session markers are scoped by review type to prevent cross-contamination
  const sessionActive = args.type ? hasActiveSession(args.type) : false;
  const isResume = args.forceResume || sessionActive;

  console.log(JSON.stringify({
    event: 'start',
    type: args.type,
    pluginRoot: args.pluginRoot,
    platform: platform,
    isResume: isResume,
    sessionActive: sessionActive,
    timestamp: new Date().toISOString()
  }));

  // Validate inputs
  const validationErrors = validateInputs(args);
  if (validationErrors.length > 0) {
    const errorMsg = validationErrors.join('; ');
    writeError(errorMsg, 'input_validation', args.type);
    console.log(JSON.stringify({
      event: 'error',
      phase: 'input_validation',
      errors: validationErrors
    }));
    process.exit(1);
  }

  // Build and run Codex command
  const cmdConfig = buildCodexCommand(args, isResume);
  console.log(JSON.stringify({
    event: 'invoking_codex',
    command: cmdConfig.command,
    isResume: isResume,
    timeout_ms: TIMEOUT_MS
  }));

  let result = await runCodex(cmdConfig);

  // Handle session expired - retry without resume
  if (!result.success && result.error === 'session_expired' && isResume) {
    console.log(JSON.stringify({
      event: 'session_expired',
      action: 'retrying_without_resume'
    }));

    // Remove stale session marker (scoped by type)
    removeSessionMarker(args.type!);

    // Retry without resume
    const freshCmdConfig = buildCodexCommand(args, false);
    result = await runCodex(freshCmdConfig);
  }

  if (!result.success) {
    let errorMsg: string;
    let exitCode = 2;

    switch (result.error) {
      case 'timeout':
        errorMsg = `Codex review timed out after ${TIMEOUT_MS / 1000} seconds`;
        exitCode = 3;
        break;
      case 'auth_required':
        errorMsg = 'Codex authentication required. Run: codex auth';
        break;
      case 'not_installed':
        errorMsg = 'Codex CLI not installed. Install from: https://codex.openai.com';
        break;
      case 'session_expired':
        errorMsg = 'Codex session expired and retry failed';
        removeSessionMarker(args.type!);
        break;
      default:
        errorMsg = `Codex execution failed with exit code ${result.code}`;
    }

    writeError(errorMsg, 'codex_execution', args.type);
    console.log(JSON.stringify({
      event: 'error',
      phase: 'codex_execution',
      error: result.error,
      code: result.code,
      message: errorMsg
    }));
    process.exit(exitCode);
  }

  // Validate output (pass review type for correct status validation)
  const validation = validateOutput(args.type!);
  if (!validation.valid) {
    writeError(validation.error!, 'output_validation', args.type);
    console.log(JSON.stringify({
      event: 'error',
      phase: 'output_validation',
      error: validation.error
    }));
    // Do NOT create session marker on validation failure
    process.exit(1);
  }

  // Success - create session marker for future resume (scoped by type)
  createSessionMarker(args.type!);

  console.log(JSON.stringify({
    event: 'complete',
    status: validation.output!.status,
    summary: validation.output!.summary,
    needs_clarification: validation.output!.needs_clarification || false,
    output_file: getOutputFile(args.type!),
    session_marker_created: true
  }));

  process.exit(0);
}

main().catch((err: Error) => {
  writeError(err.message, 'unexpected_error', currentReviewType);
  console.log(JSON.stringify({
    event: 'error',
    phase: 'unexpected_error',
    error: err.message
  }));
  process.exit(1);
});
