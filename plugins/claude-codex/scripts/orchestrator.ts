#!/usr/bin/env bun
/**
 * Pipeline orchestrator — TypeScript port of orchestrator.sh
 *
 * Commands:
 *   bun orchestrator.ts run       Show current pipeline status (default)
 *   bun orchestrator.ts status    Show current pipeline status
 *   bun orchestrator.ts reset     Reset pipeline (remove all artifacts)
 *   bun orchestrator.ts dry-run   Validate setup without running
 *   bun orchestrator.ts phase     Output current phase token (for scripting/testing)
 */

import fs from 'fs';
import path from 'path';
import {
  computeTaskDir,
  determinePhase,
  getProgress,
  type PhaseToken,
  type PhaseResult,
} from './pipeline-utils.ts';

// ─── Paths ──────────────────────────────────────────────────────────

const SCRIPT_DIR = import.meta.dir;
const PLUGIN_ROOT = path.dirname(SCRIPT_DIR);
const TASK_DIR = computeTaskDir();

// ─── ANSI colours ───────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m'; // No Color

function logInfo(msg: string): void { console.log(`${BLUE}[INFO]${NC} ${msg}`); }
function logSuccess(msg: string): void { console.log(`${GREEN}[SUCCESS]${NC} ${msg}`); }
function logWarn(msg: string): void { console.log(`${YELLOW}[WARN]${NC} ${msg}`); }
function logError(msg: string): void { console.error(`${RED}[ERROR]${NC} ${msg}`); }

// ─── Locking ────────────────────────────────────────────────────────

const LOCK_FILE = path.join(TASK_DIR, '.orchestrator.lock');

function getLockPid(): number | null {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0: test if process exists, don't kill
    return true;
  } catch (e: unknown) {
    // EPERM = process exists but we lack permission
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function acquireLock(): boolean {
  const existingPid = getLockPid();
  if (existingPid !== null) {
    if (isPidAlive(existingPid)) {
      logError(`Another orchestrator is running (PID: ${existingPid})`);
      logError(`If this is incorrect, manually remove ${LOCK_FILE}`);
      return false;
    }
    // Stale lock — remove it
    logWarn(`Removing stale lock (PID ${existingPid} no longer exists)`);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ }
  }

  fs.mkdirSync(TASK_DIR, { recursive: true });
  try {
    // wx flag = exclusive create, fails atomically if file exists (equivalent to bash set -C)
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    logError('Failed to acquire lock (race condition)');
    return false;
  }
}

export function releaseLock(): void {
  const lockPid = getLockPid();
  if (lockPid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ }
  }
}

// Trap equivalents
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

// ─── Show Status ────────────────────────────────────────────────────

function showStatus(): void {
  if (!fs.existsSync(TASK_DIR)) {
    logInfo('No .task directory found. Pipeline not started.');
    console.log('');
    console.log('To start, invoke /multi-ai with your request.');
    return;
  }

  const progress = getProgress(TASK_DIR);
  const { phase } = determinePhase(progress);
  logInfo(`Current phase: ${phase}`);
  console.log('');

  switch (phase) {
    case 'requirements_gathering':
      console.log('Phase: Requirements Gathering');
      console.log('Use requirements-gatherer agent (opus) to create user-story.json');
      console.log('Note: If teams are available, create agent team for specialist exploration first.');
      break;
    case 'requirements_team_pending':
      console.log('Phase: Requirements Gathering (Team Pending)');
      console.log('Pipeline initialized. Spawn specialist teammates into the pipeline team.');
      break;
    case 'requirements_team_exploring':
      console.log('Phase: Requirements Gathering (Team Exploring)');
      console.log('Specialist teammates are exploring codebase and domain in parallel.');
      console.log('Wait for ALL specialists to finish before synthesizing.');
      break;
    case 'plan_drafting':
      console.log('Phase: Planning');
      console.log('Use planner agent (opus) to create plan-refined.json');
      break;
    case 'plan_review_sonnet':
    case 'plan_review_opus':
    case 'plan_review_codex':
      console.log('Phase: Plan Review');
      console.log('Run sequential plan reviews: sonnet -> opus -> codex');
      break;
    case 'fix_plan_sonnet':
    case 'fix_plan_opus':
    case 'fix_plan_codex':
      console.log('Phase: Fix Plan');
      console.log('Address reviewer feedback, create fix + re-review tasks');
      break;
    case 'implementation':
      console.log('Phase: Implementation');
      console.log('Use implementer agent (sonnet) to implement plan-refined.json');
      break;
    case 'code_review_sonnet':
    case 'code_review_opus':
    case 'code_review_codex':
      console.log('Phase: Code Review');
      console.log('Run sequential code reviews: sonnet -> opus -> codex');
      break;
    case 'fix_code_sonnet':
    case 'fix_code_opus':
    case 'fix_code_codex':
      console.log('Phase: Fix Code');
      console.log('Address reviewer feedback, create fix + re-review tasks');
      break;
    case 'clarification_plan_sonnet':
    case 'clarification_plan_opus':
    case 'clarification_plan_codex':
    case 'clarification_code_sonnet':
    case 'clarification_code_opus':
    case 'clarification_code_codex':
      console.log('Phase: Clarification Needed');
      console.log('Reviewer has questions. Read clarification_questions from review file.');
      console.log('If you can answer directly, do so. Otherwise use AskUserQuestion.');
      console.log('After answering, re-run the same reviewer.');
      break;
    case 'complete':
      logSuccess('Pipeline complete! All reviews approved.');
      console.log('');
      console.log('To reset for next task:');
      console.log(`  bun "${PLUGIN_ROOT}/scripts/orchestrator.ts" reset`);
      break;
    case 'plan_rejected':
    case 'implementation_failed':
    case 'code_rejected':
      logError(`Pipeline stopped: ${phase}`);
      console.log('');
      console.log('Review the feedback files and decide how to proceed.');
      break;
  }
}

// ─── Dry-run ────────────────────────────────────────────────────────

function runDryRun(): void {
  let errors = 0;
  let warnings = 0;

  console.log('Running dry-run validation...');
  console.log('');

  // 1. Check .task/ directory
  if (fs.existsSync(TASK_DIR)) {
    console.log(`Task directory: OK (${TASK_DIR})`);
  } else {
    console.log(`Task directory: MISSING (${TASK_DIR})`);
    errors++;
  }

  // 2. Check required scripts
  const requiredScripts = ['orchestrator.ts'];
  let scriptsOk = true;
  for (const script of requiredScripts) {
    if (!fs.existsSync(path.join(SCRIPT_DIR, script))) {
      console.log(`Script missing: ${script}`);
      scriptsOk = false;
      errors++;
    }
  }
  if (scriptsOk) console.log(`Scripts: OK (${requiredScripts.length} scripts)`);

  // 3. Check skills
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  const requiredSkills = ['multi-ai/SKILL.md'];
  let skillsOk = true;
  if (fs.existsSync(skillsDir)) {
    for (const skill of requiredSkills) {
      if (!fs.existsSync(path.join(skillsDir, skill))) {
        console.log(`Skill missing: ${skill}`);
        skillsOk = false;
        errors++;
      }
    }
    if (skillsOk) console.log(`Skills: OK (${requiredSkills.length} skills)`);
  } else {
    console.log('Skills directory: MISSING (skills/)');
    errors++;
  }

  // 4. Check custom agents
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const requiredAgents = [
    'requirements-gatherer.md',
    'planner.md',
    'plan-reviewer.md',
    'implementer.md',
    'code-reviewer.md',
    'codex-reviewer.md',
  ];
  let agentsOk = true;
  if (fs.existsSync(agentsDir)) {
    for (const agent of requiredAgents) {
      if (!fs.existsSync(path.join(agentsDir, agent))) {
        console.log(`Agent missing: ${agent}`);
        agentsOk = false;
        errors++;
      }
    }
    if (agentsOk) console.log(`Agents: OK (${requiredAgents.length} agents)`);
  } else {
    console.log('Agents directory: MISSING (agents/)');
    errors++;
  }

  // 5. Check required docs
  if (fs.existsSync(path.join(PLUGIN_ROOT, 'docs', 'standards.md'))) {
    console.log('docs/standards.md: OK');
  } else {
    console.log('docs/standards.md: MISSING');
    errors++;
  }

  if (fs.existsSync(path.join(PLUGIN_ROOT, 'docs', 'workflow.md'))) {
    console.log('docs/workflow.md: OK');
  } else {
    console.log('docs/workflow.md: MISSING');
    errors++;
  }

  // 6. Check CLI tools
  if (Bun.which('bun')) {
    console.log('CLI bun: OK');
  } else {
    console.log('CLI bun: MISSING (required for JSON processing)');
    errors++;
  }

  if (Bun.which('claude')) {
    console.log('CLI claude: OK');
  } else {
    console.log('CLI claude: WARNING - not found');
    warnings++;
  }

  if (Bun.which('codex')) {
    console.log('CLI codex: OK');
  } else {
    console.log('CLI codex: WARNING - not found');
    warnings++;
  }

  // Summary
  console.log('');
  if (errors === 0) {
    if (warnings > 0) {
      console.log(`Dry run: PASSED (${warnings} warnings)`);
    } else {
      console.log('Dry run: PASSED');
    }
    process.exit(0);
  } else {
    console.log(`Dry run: FAILED (${errors} errors, ${warnings} warnings)`);
    process.exit(1);
  }
}

// ─── Reset ──────────────────────────────────────────────────────────

function resetPipeline(): void {
  if (!acquireLock()) {
    logError('Cannot reset while another orchestrator is running');
    process.exit(1);
  }

  logWarn('Resetting pipeline...');

  // Release lock before nuking the directory (lock file is inside .task)
  releaseLock();

  // Remove entire .task directory and recreate clean
  fs.rmSync(TASK_DIR, { recursive: true, force: true });
  fs.mkdirSync(TASK_DIR, { recursive: true });

  logSuccess('Pipeline reset complete');
}

// ─── Entry Point ────────────────────────────────────────────────────

const command = process.argv[2] || 'run';

switch (command) {
  case 'run':
  case 'status':
    showStatus();
    break;
  case 'reset':
    resetPipeline();
    break;
  case 'dry-run':
  case '--dry-run':
    runDryRun();
    break;
  case 'phase':
    if (!fs.existsSync(TASK_DIR)) {
      console.log('idle');
    } else {
      const progress = getProgress(TASK_DIR);
      const { phase } = determinePhase(progress);
      console.log(phase);
    }
    break;
  default:
    console.log('Usage: bun orchestrator.ts {run|status|reset|dry-run|phase}');
    console.log('');
    console.log('Commands:');
    console.log('  run       Show current pipeline status (default)');
    console.log('  status    Show current pipeline status');
    console.log('  reset     Reset pipeline (remove all artifacts)');
    console.log('  dry-run   Validate setup without running');
    console.log('  phase     Output current phase token (for scripting/testing)');
    process.exit(1);
}
