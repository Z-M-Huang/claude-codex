import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const SCRIPT_PATH = path.join(import.meta.dir, 'codex-review.ts');

/**
 * Run the codex-review script with given arguments
 */
function runScript(args: string[], cwd: string): Promise<{
  code: number | null;
  events: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn('bun', [SCRIPT_PATH, ...args], {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => stdout += data);
    proc.stderr!.on('data', (data: Buffer) => stderr += data);

    proc.on('close', (code) => {
      // Parse JSON lines from stdout
      const events = stdout.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
      resolve({ code, events, stdout, stderr });
    });
  });
}

describe('codex-review.ts', () => {
  let tempDir: string;
  let mockPluginRoot: string;

  beforeEach(() => {
    // Create temp project directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
    fs.mkdirSync(path.join(tempDir, '.task'), { recursive: true });

    // Create mock plugin root with required files
    mockPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-plugin-'));
    fs.mkdirSync(path.join(mockPluginRoot, 'docs', 'schemas'), { recursive: true });
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'schemas', 'plan-review.schema.json'),
      JSON.stringify({ type: 'object' })
    );
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'schemas', 'review-result.schema.json'),
      JSON.stringify({ type: 'object' })
    );
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'standards.md'),
      '# Standards\n\nReview standards here.'
    );
  });

  afterEach(async () => {
    // On Windows, spawned processes may hold file locks briefly after exit.
    // Retry cleanup with a small delay to avoid EBUSY errors.
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    fs.rmSync(mockPluginRoot, { recursive: true, force: true });
  });

  // ================== ARGUMENT VALIDATION ==================

  test('fails with missing --type argument', async () => {
    const result = await runScript(
      ['--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e => e.phase === 'input_validation')).toBe(true);
  });

  test('fails with invalid --type argument', async () => {
    const result = await runScript(
      ['--type', 'invalid', '--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('Invalid'))
    )).toBe(true);
  });

  test('fails with missing --plugin-root argument', async () => {
    const result = await runScript(
      ['--type', 'plan'],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e => e.phase === 'input_validation')).toBe(true);
  });

  // ================== INPUT FILE VALIDATION ==================

  test('fails when plan-refined.json missing for plan review', async () => {
    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('plan-refined.json'))
    )).toBe(true);
  });

  test('fails when impl-result.json missing for code review', async () => {
    const result = await runScript(
      ['--type', 'code', '--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('impl-result.json'))
    )).toBe(true);
  });

  // ================== SCHEMA VALIDATION ==================

  test('fails when schema file missing', async () => {
    // Create plan file
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    // Remove schema file
    fs.unlinkSync(path.join(mockPluginRoot, 'docs', 'schemas', 'plan-review.schema.json'));

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('schema'))
    )).toBe(true);
  });

  test('fails when standards.md missing', async () => {
    // Create plan file
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    // Remove standards file
    fs.unlinkSync(path.join(mockPluginRoot, 'docs', 'standards.md'));

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('standards'))
    )).toBe(true);
  });

  // ================== SESSION MANAGEMENT ==================

  test('detects first review when no session marker exists', async () => {
    // Create required files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // Check start event has correct session info
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.isResume).toBe(false);
    expect(startEvent!.sessionActive).toBe(false);
  });

  test('detects subsequent review when session marker exists', async () => {
    // Create required files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    // Create session marker (scoped by review type)
    fs.writeFileSync(
      path.join(tempDir, '.task', '.codex-session-plan'),
      new Date().toISOString()
    );

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // Check start event has correct session info
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.isResume).toBe(true);
    expect(startEvent!.sessionActive).toBe(true);
  }, 15000);

  test('--resume flag forces resume mode', async () => {
    // Create required files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    // No session marker, but --resume flag
    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot, '--resume'],
      tempDir
    );

    // Check start event has correct session info
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.isResume).toBe(true);
  }, 15000);

  // ================== CODEX CLI CHECK ==================

  test('fails when codex CLI not installed', async () => {
    // Create required files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // Should fail at input validation (codex not installed)
    // or at execution (codex not found)
    expect(result.code).toBeGreaterThan(0);
  });

  // ================== OUTPUT FILE ==================

  test('writes error to review-codex.json on validation failure', async () => {
    // Run without required files
    await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    const outputPath = path.join(tempDir, '.task', 'review-codex.json');
    expect(fs.existsSync(outputPath)).toBe(true);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(output.status).toBe('error');
    expect(output.phase).toBe('input_validation');
  });

  // ================== JSON OUTPUT FORMAT ==================

  test('outputs structured JSON events', async () => {
    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // First event should be 'start'
    expect(result.events[0].event).toBe('start');
    expect(result.events[0].type).toBe('plan');
    expect(result.events[0].platform).toBeDefined();
    expect(result.events[0].isResume).toBeDefined();
    expect(result.events[0].sessionActive).toBeDefined();

    // Should have an error event
    expect(result.events.some(e => e.event === 'error')).toBe(true);
  });

  test('start event includes session status', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent!.isResume).toBe(false);
    expect(startEvent!.sessionActive).toBe(false);
  });

  // ================== SCOPED SESSION MARKERS ==================

  test('plan session marker does not affect code review', async () => {
    // Create plan session marker
    fs.writeFileSync(
      path.join(tempDir, '.task', '.codex-session-plan'),
      new Date().toISOString()
    );

    // Create code review files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'impl-result.json'),
      JSON.stringify({ files: [] })
    );

    const result = await runScript(
      ['--type', 'code', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // Code review should NOT be in resume mode due to plan marker
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent!.isResume).toBe(false);
    expect(startEvent!.sessionActive).toBe(false);
  });

  test('code session marker triggers resume for code review', async () => {
    // Create code session marker
    fs.writeFileSync(
      path.join(tempDir, '.task', '.codex-session-code'),
      new Date().toISOString()
    );

    // Create code review files
    fs.writeFileSync(
      path.join(tempDir, '.task', 'impl-result.json'),
      JSON.stringify({ files: [] })
    );

    const result = await runScript(
      ['--type', 'code', '--plugin-root', mockPluginRoot],
      tempDir
    );

    // Code review SHOULD be in resume mode
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent!.isResume).toBe(true);
    expect(startEvent!.sessionActive).toBe(true);
  }, 15000);

  // ================== CHANGES SUMMARY ==================

  test('--changes-summary is parsed correctly', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot, '--changes-summary', 'Fixed SQL injection'],
      tempDir
    );

    // Should start with the changes summary parsed
    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
  });
});
