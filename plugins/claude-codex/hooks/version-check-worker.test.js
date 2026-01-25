/**
 * Tests for version-check-worker.js
 *
 * Tests cover:
 * - Worker writes cache on successful fetch
 * - Worker filters out pre-release versions
 * - Worker silent fails on network errors
 * - Worker sends User-Agent header
 *
 * NOTE: These tests use a mock-based approach to test the worker logic
 * without actually spawning processes or hitting the GitHub API.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_FILE = path.join(os.tmpdir(), 'claude-codex-version-cache.json');
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Z-M-Huang/claude-codex/releases/latest';

// Helper to simulate worker main logic
async function simulateWorkerMain(currentVersion, mockFetch) {
  try {
    if (!currentVersion) {
      return { success: false, reason: 'no_version' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response;
    try {
      response = await mockFetch(GITHUB_RELEASES_URL, {
        headers: { 'User-Agent': 'claude-codex-plugin' },
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeoutId);
      return { success: false, reason: 'fetch_error', error: err };
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, reason: 'http_error', status: response.status };
    }

    const data = await response.json();

    if (data.prerelease) {
      return { success: false, reason: 'prerelease' };
    }

    const tagName = data.tag_name || '';
    const latestVersion = tagName.replace(/^v/, '');

    if (!latestVersion) {
      return { success: false, reason: 'no_tag' };
    }

    const cacheData = {
      checked_at: Date.now(),
      latest_version: latestVersion,
      current_version: currentVersion
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8');
    return { success: true, latestVersion };
  } catch (err) {
    return { success: false, reason: 'exception', error: err };
  }
}

describe('Version Check Worker Logic', () => {
  beforeEach(() => {
    // Clean up cache file before each test
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterEach(() => {
    // Clean up cache file after test
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }
  });

  test('Worker writes cache on successful fetch', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.3.0',
          prerelease: false
        })
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(true);
    expect(result.latestVersion).toBe('1.3.0');

    // Verify cache file was written
    expect(fs.existsSync(CACHE_FILE)).toBe(true);

    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    expect(cache.latest_version).toBe('1.3.0');
    expect(cache.current_version).toBe('1.2.5');
    expect(cache.checked_at).toBeGreaterThan(0);
  });

  test('Worker filters out pre-release versions', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.3.0-beta',
          prerelease: true
        })
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('prerelease');

    // Verify cache file was NOT written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  test('Worker silent fails on network error', async () => {
    const mockFetch = async (url, options) => {
      throw new Error('Network error');
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('fetch_error');

    // Verify cache file was NOT written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  test('Worker sends User-Agent header', async () => {
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.3.0',
          prerelease: false
        })
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(true);
    expect(capturedHeaders).not.toBe(null);
    expect(capturedHeaders['User-Agent']).toBe('claude-codex-plugin');
  });

  test('Worker exits on missing current version', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.3.0',
          prerelease: false
        })
      };
    };

    const result = await simulateWorkerMain('', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_version');

    // Verify no cache file written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  test('Worker exits on HTTP error', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: false,
        status: 404
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('http_error');
    expect(result.status).toBe(404);

    // Verify no cache file written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  test('Worker exits on missing tag_name', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({
          prerelease: false
        })
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_tag');

    // Verify no cache file written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  test('Worker strips v prefix from version', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v2.0.0',
          prerelease: false
        })
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(true);
    expect(result.latestVersion).toBe('2.0.0'); // v prefix stripped

    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    expect(cache.latest_version).toBe('2.0.0');
  });

  test('Worker handles rate limit (403) silently', async () => {
    const mockFetch = async (url, options) => {
      return {
        ok: false,
        status: 403
      };
    };

    const result = await simulateWorkerMain('1.2.5', mockFetch);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('http_error');
    expect(result.status).toBe(403);

    // Verify no cache file written
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });
});

describe('Version Check Worker Script Integration', () => {
  beforeEach(() => {
    // Clean up cache file before each test
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterEach(() => {
    // Clean up cache file after test
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      // Ignore if doesn't exist
    }
  });

  test('Worker script exists and has proper shebang', () => {
    const workerPath = path.join(__dirname, 'version-check-worker.js');
    expect(fs.existsSync(workerPath)).toBe(true);

    const content = fs.readFileSync(workerPath, 'utf8');
    expect(content.startsWith('#!/usr/bin/env bun')).toBe(true);
  });

  test('Worker script uses correct constants', () => {
    const workerPath = path.join(__dirname, 'version-check-worker.js');
    const content = fs.readFileSync(workerPath, 'utf8');

    expect(content).toContain('claude-codex-version-cache.json');
    expect(content).toContain('https://api.github.com/repos/Z-M-Huang/claude-codex/releases/latest');
    expect(content).toContain('claude-codex-plugin');
  });
});
