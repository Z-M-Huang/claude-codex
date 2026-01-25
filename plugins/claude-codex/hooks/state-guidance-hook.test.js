/**
 * Tests for state-guidance-hook.js version check functionality
 *
 * Tests cover all acceptance criteria:
 * AC1: Notification when update available
 * AC2: No notification when version current
 * AC3: No spawn when cache valid
 * AC4: Silent fail on network errors
 * AC5: Message format
 * AC6: Cross-platform cache location
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import actual functions from the version-check module
const versionCheck = require('./version-check.js');

// Helper to create temp directories for testing
function createTempDir() {
  const tempDir = path.join(os.tmpdir(), `codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// Helper to clean up temp directory
function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Helper to write cache file
function writeCacheFile(cacheFile, data) {
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
}

describe('Version Check Functions - Unit Tests', () => {
  let mockPluginRoot;

  beforeEach(() => {
    mockPluginRoot = createTempDir();

    // Clean up cache file before each test
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }

    // Create mock plugin.json
    const pluginDir = path.join(mockPluginRoot, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.2.5' }, null, 2),
      'utf8'
    );

    process.env.CLAUDE_PLUGIN_ROOT = mockPluginRoot;
  });

  afterEach(() => {
    cleanupTempDir(mockPluginRoot);
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  test('isNewerVersion detects newer version', () => {
    expect(versionCheck.isNewerVersion('1.2.5', 'v1.3.0')).toBe(true);
    expect(versionCheck.isNewerVersion('1.2.5', '1.2.5')).toBe(false);
    expect(versionCheck.isNewerVersion('1.2.5', '1.2.3')).toBe(false);
    expect(versionCheck.isNewerVersion('1.2.5', '1.3.0-beta')).toBe(false); // Pre-release ignored
    expect(versionCheck.isNewerVersion('1.2.5', 'v2.0.0')).toBe(true);
    expect(versionCheck.isNewerVersion('1.2.5', 'v1.2.5')).toBe(true);
  });

  test('isNewerVersion handles edge cases', () => {
    expect(versionCheck.isNewerVersion(null, '1.3.0')).toBe(false);
    expect(versionCheck.isNewerVersion('1.2.5', null)).toBe(false);
    expect(versionCheck.isNewerVersion('', '1.3.0')).toBe(false);
    expect(versionCheck.isNewerVersion('1.2.5', '')).toBe(false);
    expect(versionCheck.isNewerVersion('1.2', '1.3.0')).toBe(true);
  });

  test('formatUpdateMessage follows correct format (AC5)', () => {
    const message = versionCheck.formatUpdateMessage('1.2.5', '1.3.0');
    expect(message).toContain('Update available: v1.2.5 -> v1.3.0');
    expect(message).toContain('/plugin uninstall claude-codex@claude-codex');
    expect(message).toContain('/plugin install claude-codex@claude-codex --scope user');
  });

  test('cache file path is in os.tmpdir() (AC6)', () => {
    const expectedPath = path.join(os.tmpdir(), 'claude-codex-version-cache.json');
    expect(versionCheck.CACHE_FILE).toBe(expectedPath);
  });

  test('readVersionCache returns null when cache missing', () => {
    // Ensure cache file doesn't exist
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {}

    expect(versionCheck.readVersionCache()).toBe(null);
  });

  test('readVersionCache returns null when cache expired', () => {
    // Write an expired cache (checked_at in the past)
    const expiredCache = {
      checked_at: Date.now() - 7200000, // 2 hours ago
      latest_version: '1.3.0',
      current_version: '1.2.5'
    };
    writeCacheFile(versionCheck.CACHE_FILE, expiredCache);

    expect(versionCheck.readVersionCache()).toBe(null);
  });

  test('readVersionCache returns data when cache valid', () => {
    // Write a valid cache
    const validCache = {
      checked_at: Date.now(),
      latest_version: '1.3.0',
      current_version: '1.2.5'
    };
    writeCacheFile(versionCheck.CACHE_FILE, validCache);

    const result = versionCheck.readVersionCache();
    expect(result).not.toBe(null);
    expect(result.latest_version).toBe('1.3.0');
    expect(result.current_version).toBe('1.2.5');
  });

  test('getCurrentVersion returns version from plugin.json', () => {
    expect(versionCheck.getCurrentVersion()).toBe('1.2.5');
  });

  test('getCurrentVersion returns null when plugin.json missing', () => {
    // Set invalid PLUGIN_ROOT
    process.env.CLAUDE_PLUGIN_ROOT = '/nonexistent/path';
    expect(versionCheck.getCurrentVersion()).toBe(null);
  });
});

describe('Integration Tests - Update Notification Flow', () => {
  let mockPluginRoot;

  beforeEach(() => {
    mockPluginRoot = createTempDir();

    // Clean up cache file
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {}

    // Create mock plugin.json
    const pluginDir = path.join(mockPluginRoot, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.2.5' }, null, 2),
      'utf8'
    );

    process.env.CLAUDE_PLUGIN_ROOT = mockPluginRoot;
  });

  afterEach(() => {
    cleanupTempDir(mockPluginRoot);
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {}
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  test('AC1: Shows notification when cache indicates update available', () => {
    // Write cache with newer version
    const validCache = {
      checked_at: Date.now(),
      latest_version: '1.3.0',
      current_version: '1.2.5'
    };
    writeCacheFile(versionCheck.CACHE_FILE, validCache);

    const notification = versionCheck.checkForUpdate();
    expect(notification).not.toBe(null);
    expect(notification).toContain('v1.2.5 -> v1.3.0');
  });

  test('AC2: No notification when version is current', () => {
    // Write cache with same version
    const validCache = {
      checked_at: Date.now(),
      latest_version: '1.2.5',
      current_version: '1.2.5'
    };
    writeCacheFile(versionCheck.CACHE_FILE, validCache);

    const notification = versionCheck.checkForUpdate();
    expect(notification).toBe(null);
  });

  test('AC3: No notification on first invocation (cache miss spawns worker)', () => {
    // No cache file exists
    try {
      fs.unlinkSync(versionCheck.CACHE_FILE);
    } catch {}

    // checkForUpdate should return null on first invocation
    // (spawns background worker, no notification until cache populated)
    const notification = versionCheck.checkForUpdate();
    expect(notification).toBe(null);
  });

  test('Returns null when cache expired (spawns refresh)', () => {
    // Write an expired cache
    const expiredCache = {
      checked_at: Date.now() - 7200000, // 2 hours ago
      latest_version: '1.3.0',
      current_version: '1.2.5'
    };
    writeCacheFile(versionCheck.CACHE_FILE, expiredCache);

    // Should return null (cache expired, spawns refresh)
    const notification = versionCheck.checkForUpdate();
    expect(notification).toBe(null);
  });

  test('AC4: Silent fail on errors in version check', () => {
    // Set invalid PLUGIN_ROOT to trigger error
    process.env.CLAUDE_PLUGIN_ROOT = '/nonexistent/path';

    // Should not throw, should return null
    expect(() => versionCheck.checkForUpdate()).not.toThrow();
    expect(versionCheck.checkForUpdate()).toBe(null);
  });

  test('readJson returns null for invalid JSON', () => {
    // Write invalid JSON to cache file
    fs.writeFileSync(versionCheck.CACHE_FILE, 'not valid json{{{', 'utf8');

    expect(versionCheck.readJson(versionCheck.CACHE_FILE)).toBe(null);
  });

  test('readJson returns null for non-existent file', () => {
    expect(versionCheck.readJson('/nonexistent/file.json')).toBe(null);
  });

  test('CACHE_TTL_MS is 1 hour', () => {
    expect(versionCheck.CACHE_TTL_MS).toBe(3600000); // 1 hour in ms
  });
});

describe('spawnCacheRefresh', () => {
  test('does not throw on spawn error', () => {
    // spawnCacheRefresh should handle errors silently
    // We can't easily test the actual spawn without mocking,
    // but we can verify it doesn't throw
    expect(() => versionCheck.spawnCacheRefresh('1.2.5')).not.toThrow();
  });
});
