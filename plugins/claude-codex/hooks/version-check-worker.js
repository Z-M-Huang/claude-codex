#!/usr/bin/env bun
/**
 * Version Check Worker - Background process for fetching latest version from GitHub
 *
 * This script runs in the background (fire-and-forget) to update the version cache.
 * It fetches the latest release from GitHub API and writes to the cache file.
 *
 * Usage: bun version-check-worker.js <current_version>
 *
 * Exit behavior: Silent on all errors (no stdout/stderr output)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-codex-version-cache.json');
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Z-M-Huang/claude-codex/releases/latest';
const FETCH_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Main worker logic
 */
async function main() {
  try {
    // Get current version from command line argument
    const currentVersion = process.argv[2];
    if (!currentVersion) {
      // Silent exit on missing argument
      process.exit(0);
    }

    // Fetch latest release from GitHub with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'User-Agent': 'claude-codex-plugin'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Silent exit on HTTP error
      process.exit(0);
    }

    const data = await response.json();

    // Filter out pre-release versions
    if (data.prerelease) {
      // Silent exit on pre-release
      process.exit(0);
    }

    // Extract version from tag_name (strip 'v' prefix)
    const tagName = data.tag_name || '';
    const latestVersion = tagName.replace(/^v/, '');

    if (!latestVersion) {
      // Silent exit on missing version
      process.exit(0);
    }

    // Write cache file
    const cacheData = {
      checked_at: Date.now(),
      latest_version: latestVersion,
      current_version: currentVersion
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8');

    // Success - silent exit
    process.exit(0);
  } catch {
    // Silent exit on any error
    process.exit(0);
  }
}

main();
