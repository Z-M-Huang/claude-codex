/**
 * Version Check Module - Pure helper functions for update notification
 *
 * This module exports testable pure functions for version checking.
 * Used by state-guidance-hook.js and imported by tests.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Constants
const CACHE_FILE = path.join(os.tmpdir(), 'claude-codex-version-cache.json');
const CACHE_TTL_MS = 3600000; // 1 hour

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
 * Get current plugin version from plugin.json
 */
function getCurrentVersion() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(__dirname);
    const pluginJson = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const data = readJson(pluginJson);
    return data?.version || null;
  } catch {
    return null;
  }
}

/**
 * Read version cache synchronously
 * Returns {latest_version, current_version} or null if expired/missing
 */
function readVersionCache() {
  try {
    const cache = readJson(CACHE_FILE);
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
function isNewerVersion(current, latest) {
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
function formatUpdateMessage(current, latest) {
  return `Update available: v${current} -> v${latest}. Run \`/plugin uninstall claude-codex@claude-codex && /plugin install claude-codex@claude-codex --scope user\` to update.`;
}

/**
 * Spawn background worker to refresh version cache (fire-and-forget)
 */
function spawnCacheRefresh(currentVersion) {
  try {
    const workerPath = path.join(__dirname, 'version-check-worker.js');
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
function checkForUpdate() {
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

// Export all functions for testing
module.exports = {
  CACHE_FILE,
  CACHE_TTL_MS,
  readJson,
  getCurrentVersion,
  readVersionCache,
  isNewerVersion,
  formatUpdateMessage,
  spawnCacheRefresh,
  checkForUpdate
};
