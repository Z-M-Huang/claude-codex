/**
 * Version Check Module - Pure helper functions for update notification
 *
 * This module exports testable pure functions for version checking.
 * Used by guidance-hook.ts and imported by tests.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { readJson } from '../scripts/pipeline-utils.ts';

// Constants
export const CACHE_FILE = path.join(os.tmpdir(), 'claude-codex-version-cache.json');
export const CACHE_TTL_MS = 3600000; // 1 hour

interface VersionCache {
  checked_at: number;
  latest_version: string;
  current_version: string;
}

/**
 * Get current plugin version from plugin.json
 */
export function getCurrentVersion(): string | null {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(import.meta.dir);
    const pluginJson = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const data = readJson(pluginJson) as Record<string, unknown> | null;
    return (data?.version as string) || null;
  } catch {
    return null;
  }
}

/**
 * Read version cache synchronously
 * Returns {latest_version, current_version} or null if expired/missing
 */
export function readVersionCache(): { latest_version: string; current_version: string } | null {
  try {
    const cache = readJson(CACHE_FILE) as VersionCache | null;
    if (!cache || !cache.checked_at || !cache.latest_version) {
      return null;
    }

    // Check if cache is still valid (within TTL)
    if (cache.checked_at + CACHE_TTL_MS <= Date.now()) {
      return null; // Expired
    }

    return {
      latest_version: cache.latest_version,
      current_version: cache.current_version
    };
  } catch {
    return null;
  }
}

/**
 * Compare version strings to check if latest is newer than current
 * Returns true if latest > current
 * Handles 'v' prefix and treats pre-release versions (with '-') as not newer
 */
export function isNewerVersion(current: string | null, latest: string | null): boolean {
  try {
    // Return false if either version is missing
    if (!current || !latest) {
      return false;
    }

    // Strip 'v' prefix
    const cleanCurrent = current.replace(/^v/, '');
    const cleanLatest = latest.replace(/^v/, '');

    // Return false if either version is empty after stripping
    if (!cleanCurrent || !cleanLatest) {
      return false;
    }

    // Ignore pre-release versions (contain '-')
    if (cleanLatest.includes('-')) {
      return false;
    }

    // Split into parts
    const currentParts = cleanCurrent.split('.').map(p => parseInt(p, 10) || 0);
    const latestParts = cleanLatest.split('.').map(p => parseInt(p, 10) || 0);

    // Compare major, minor, patch
    for (let i = 0; i < 3; i++) {
      const c = currentParts[i] || 0;
      const l = latestParts[i] || 0;

      if (l > c) return true;
      if (l < c) return false;
    }

    // Versions are equal
    return false;
  } catch {
    return false;
  }
}

/**
 * Format update notification message
 */
export function formatUpdateMessage(current: string, latest: string): string {
  return `Update available: v${current} -> v${latest}. Run \`/plugin uninstall claude-codex@claude-codex && /plugin install claude-codex@claude-codex --scope user\` to update.`;
}

/**
 * Spawn background worker to refresh version cache (fire-and-forget)
 */
export function spawnCacheRefresh(currentVersion: string): void {
  try {
    const workerPath = path.join(import.meta.dir, 'version-check-worker.ts');
    const child = spawn('bun', [workerPath, currentVersion], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch {
    // Silent fail - version check is not critical
  }
}

/**
 * Check for plugin updates (synchronous orchestration)
 * Returns formatted update message or null
 */
export function checkForUpdate(): string | null {
  try {
    const currentVersion = getCurrentVersion();
    if (!currentVersion) {
      return null;
    }

    const cached = readVersionCache();
    if (!cached) {
      // Cache expired or missing - spawn background refresh
      spawnCacheRefresh(currentVersion);
      return null; // No notification yet - will show on next invocation
    }

    // Cache is valid - check if update is available
    if (isNewerVersion(currentVersion, cached.latest_version)) {
      return formatUpdateMessage(currentVersion, cached.latest_version);
    }

    return null;
  } catch {
    return null;
  }
}
