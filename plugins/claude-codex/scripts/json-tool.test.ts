import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(import.meta.dir, 'json-tool.ts');
const TEST_DIR = join(import.meta.dir, '.test-json-tool');

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
    cwd: TEST_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode ?? 1,
  };
}

function writeTestJson(filename: string, data: unknown): string {
  const filepath = join(TEST_DIR, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

function readTestJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(TEST_DIR, filename), 'utf-8'));
}

describe('json-tool.ts', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ─── get ──────────────────────────────────────────────────────────

  describe('get', () => {
    test('basic field', () => {
      const file = writeTestJson('data.json', { name: 'alice', age: 30 });
      const { stdout, exitCode } = run('get', file, '.name');
      expect(exitCode).toBe(0);
      expect(stdout).toBe('alice');
    });

    test('nested path', () => {
      const file = writeTestJson('data.json', { a: { b: { c: 'deep' } } });
      const { stdout, exitCode } = run('get', file, '.a.b.c');
      expect(exitCode).toBe(0);
      expect(stdout).toBe('deep');
    });

    test('default value when field missing', () => {
      const file = writeTestJson('data.json', { name: 'alice' });
      const { stdout, exitCode } = run('get', file, '.missing // fallback');
      expect(exitCode).toBe(0);
      expect(stdout).toBe('fallback');
    });

    test('returns whole object with no path', () => {
      const file = writeTestJson('data.json', { x: 1 });
      const { stdout, exitCode } = run('get', file, '.');
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ x: 1 });
    });

    test('missing file exits with error', () => {
      const { exitCode, stderr } = run('get', join(TEST_DIR, 'nope.json'), '.key');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });

    test('invalid JSON exits with error', () => {
      const file = join(TEST_DIR, 'bad.json');
      writeFileSync(file, '{not valid json');
      const { exitCode, stderr } = run('get', file, '.key');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid JSON');
    });

    test('numeric and boolean values', () => {
      const file = writeTestJson('data.json', { count: 42, active: true });
      expect(run('get', file, '.count').stdout).toBe('42');
      expect(run('get', file, '.active').stdout).toBe('true');
    });
  });

  // ─── set ──────────────────────────────────────────────────────────

  describe('set', () => {
    test('string value with =', () => {
      const file = writeTestJson('data.json', { name: 'alice' });
      const { exitCode } = run('set', file, 'name=bob');
      expect(exitCode).toBe(0);
      expect(readTestJson('data.json')).toEqual({ name: 'bob' });
    });

    test('JSON value with :=', () => {
      const file = writeTestJson('data.json', { count: 0 });
      run('set', file, 'count:=42');
      expect(readTestJson('data.json')).toEqual({ count: 42 });
    });

    test('boolean JSON value with :=', () => {
      const file = writeTestJson('data.json', { active: false });
      run('set', file, 'active:=true');
      expect(readTestJson('data.json')).toEqual({ active: true });
    });

    test('timestamp with @=', () => {
      const file = writeTestJson('data.json', {});
      const before = new Date().toISOString().slice(0, 10);
      run('set', file, 'ts@=now');
      const result = readTestJson('data.json') as Record<string, string>;
      // Timestamp should start with today's date
      expect(result.ts.slice(0, 10)).toBe(before);
    });

    test('increment with +', () => {
      const file = writeTestJson('data.json', { count: 5 });
      run('set', file, '+count');
      expect(readTestJson('data.json')).toEqual({ count: 6 });
    });

    test('increment missing field starts from 0', () => {
      const file = writeTestJson('data.json', {});
      run('set', file, '+counter');
      expect(readTestJson('data.json')).toEqual({ counter: 1 });
    });

    test('delete with -', () => {
      const file = writeTestJson('data.json', { keep: 1, remove: 2 });
      run('set', file, '-remove');
      expect(readTestJson('data.json')).toEqual({ keep: 1 });
    });

    test('multiple updates in one call', () => {
      const file = writeTestJson('data.json', { a: 1, b: 2 });
      run('set', file, 'a=hello', 'b:=99', '-nonexistent');
      expect(readTestJson('data.json')).toEqual({ a: 'hello', b: 99 });
    });

    test('nested path creation', () => {
      const file = writeTestJson('data.json', {});
      run('set', file, 'a.b.c=deep');
      expect(readTestJson('data.json')).toEqual({ a: { b: { c: 'deep' } } });
    });
  });

  // ─── valid ────────────────────────────────────────────────────────

  describe('valid', () => {
    test('valid JSON returns exit code 0', () => {
      const file = writeTestJson('good.json', { valid: true });
      const { exitCode } = run('valid', file);
      expect(exitCode).toBe(0);
    });

    test('invalid JSON returns exit code 1', () => {
      const file = join(TEST_DIR, 'bad.json');
      writeFileSync(file, 'not json at all');
      const { exitCode } = run('valid', file);
      expect(exitCode).toBe(1);
    });
  });

  // ─── merge ────────────────────────────────────────────────────────

  describe('merge', () => {
    test('single file outputs itself', () => {
      const file = writeTestJson('a.json', { x: 1 });
      const { stdout, exitCode } = run('merge', file);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ x: 1 });
    });

    test('later file overrides earlier', () => {
      const f1 = writeTestJson('a.json', { x: 1, y: 2 });
      const f2 = writeTestJson('b.json', { y: 99, z: 3 });
      const { stdout } = run('merge', f1, f2);
      expect(JSON.parse(stdout)).toEqual({ x: 1, y: 99, z: 3 });
    });

    test('deep merge of nested objects', () => {
      const f1 = writeTestJson('a.json', { config: { a: 1, b: 2 } });
      const f2 = writeTestJson('b.json', { config: { b: 99, c: 3 } });
      const { stdout } = run('merge', f1, f2);
      expect(JSON.parse(stdout)).toEqual({ config: { a: 1, b: 99, c: 3 } });
    });

    test('arrays are replaced not merged', () => {
      const f1 = writeTestJson('a.json', { items: [1, 2] });
      const f2 = writeTestJson('b.json', { items: [3] });
      const { stdout } = run('merge', f1, f2);
      expect(JSON.parse(stdout)).toEqual({ items: [3] });
    });
  });

  // ─── merge-get ────────────────────────────────────────────────────

  describe('merge-get', () => {
    test('merges and extracts path', () => {
      const f1 = writeTestJson('a.json', { server: { host: 'localhost', port: 3000 } });
      const f2 = writeTestJson('b.json', { server: { port: 8080 } });
      const { stdout, exitCode } = run('merge-get', '.server.port', f1, f2);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('8080');
    });

    test('returns default for missing path', () => {
      const f1 = writeTestJson('a.json', { x: 1 });
      const { stdout } = run('merge-get', '.missing // default_val', f1);
      expect(stdout).toBe('default_val');
    });
  });
});
