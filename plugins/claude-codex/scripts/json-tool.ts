#!/usr/bin/env bun
/**
 * Cross-platform JSON tool to replace jq dependency.
 * Works on Windows, macOS, and Linux via Bun.
 *
 * Usage:
 *   bun json-tool.ts get <file> <path>           - Get value at JSON path (like jq -r)
 *   bun json-tool.ts set <file> <updates...>     - Update values (like jq --arg)
 *   bun json-tool.ts valid <file>                - Check if file is valid JSON
 *   bun json-tool.ts merge <file1> <file2> ...   - Merge JSON files (later overrides earlier)
 *
 * Path syntax:
 *   .field           - Get field value
 *   .field.nested    - Get nested field
 *   .field // default - Get field with default if null/missing
 *
 * Set syntax:
 *   field=value      - Set field to string value
 *   field:=value     - Set field to JSON value (number, bool, null)
 *   field@=now       - Set field to current ISO timestamp
 *   +field           - Increment numeric field
 *   -field           - Delete field
 */

import fs from 'fs';

const args = process.argv.slice(2);
const command = args[0];

function readJsonFile(path: string): unknown {
  try {
    const content = fs.readFileSync(path, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Error: File not found: ${path}`);
      process.exit(1);
    }
    console.error(`Error: Invalid JSON in ${path}`);
    process.exit(1);
  }
}

function writeJsonFile(path: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(path, content + "\n");
}

function getPath(obj: unknown, path: string): unknown {
  // Handle default value syntax: .field // default
  const defaultMatch = path.match(/^(.+?)\s*\/\/\s*(.+)$/);
  let defaultValue: string | undefined;
  if (defaultMatch) {
    path = defaultMatch[1].trim();
    defaultValue = defaultMatch[2].trim();
  }

  // Remove leading dot if present
  if (path.startsWith(".")) {
    path = path.slice(1);
  }

  // Empty path returns whole object
  if (!path) {
    return obj;
  }

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return defaultValue !== undefined ? defaultValue : null;
    }
    if (typeof current !== "object") {
      return defaultValue !== undefined ? defaultValue : null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === null || current === undefined) {
    return defaultValue !== undefined ? defaultValue : null;
  }

  return current;
}

function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  if (path.startsWith(".")) {
    path = path.slice(1);
  }

  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  current[lastPart] = value;
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  if (path.startsWith(".")) {
    path = path.slice(1);
  }

  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      return; // Path doesn't exist
    }
    current = current[part] as Record<string, unknown>;
  }

  delete current[parts[parts.length - 1]];
}

function formatOutput(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Commands
switch (command) {
  case "get": {
    const file = args[1];
    const path = args[2] || ".";

    if (!file) {
      console.error("Usage: json-tool.ts get <file> [path]");
      process.exit(1);
    }

    const data = readJsonFile(file);
    const value = getPath(data, path);
    console.log(formatOutput(value));
    break;
  }

  case "set": {
    const file = args[1];
    const updates = args.slice(2);

    if (!file || updates.length === 0) {
      console.error("Usage: json-tool.ts set <file> <updates...>");
      console.error("  field=value     - Set string value");
      console.error("  field:=value    - Set JSON value");
      console.error("  field@=now      - Set to current timestamp");
      console.error("  +field          - Increment field");
      console.error("  -field          - Delete field");
      process.exit(1);
    }

    const data = readJsonFile(file) as Record<string, unknown>;

    for (const update of updates) {
      // Increment: +field
      if (update.startsWith("+")) {
        const field = update.slice(1);
        const current = getPath(data, field);
        setPath(data, field, (typeof current === "number" ? current : 0) + 1);
        continue;
      }

      // Delete: -field
      if (update.startsWith("-")) {
        const field = update.slice(1);
        deletePath(data, field);
        continue;
      }

      // Timestamp: field@=now
      if (update.includes("@=")) {
        const [field, value] = update.split("@=", 2);
        if (value === "now") {
          setPath(data, field, new Date().toISOString());
        }
        continue;
      }

      // JSON value: field:=value
      if (update.includes(":=")) {
        const [field, value] = update.split(":=", 2);
        try {
          setPath(data, field, JSON.parse(value));
        } catch {
          setPath(data, field, value);
        }
        continue;
      }

      // String value: field=value
      if (update.includes("=")) {
        const eqIndex = update.indexOf("=");
        const field = update.slice(0, eqIndex);
        const value = update.slice(eqIndex + 1);
        setPath(data, field, value);
        continue;
      }

      console.error(`Invalid update syntax: ${update}`);
      process.exit(1);
    }

    writeJsonFile(file, data);
    break;
  }

  case "valid": {
    const file = args[1];

    if (!file) {
      console.error("Usage: json-tool.ts valid <file>");
      process.exit(1);
    }

    try {
      const content = fs.readFileSync(file, "utf-8");
      JSON.parse(content);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }

  case "merge": {
    const files = args.slice(1);

    if (files.length < 1) {
      console.error("Usage: json-tool.ts merge <file1> [file2] ...");
      process.exit(1);
    }

    let result: Record<string, unknown> = {};
    for (const file of files) {
      const data = readJsonFile(file) as Record<string, unknown>;
      result = deepMerge(result, data);
    }

    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "merge-get": {
    // Merge files and get a path - useful for config with overrides
    // Usage: json-tool.ts merge-get <path> <file1> [file2] ...
    const path = args[1];
    const files = args.slice(2);

    if (!path || files.length < 1) {
      console.error("Usage: json-tool.ts merge-get <path> <file1> [file2] ...");
      process.exit(1);
    }

    let result: Record<string, unknown> = {};
    for (const file of files) {
      try {
        const data = readJsonFile(file) as Record<string, unknown>;
        result = deepMerge(result, data);
      } catch {
        // Skip files that don't exist or aren't valid
      }
    }

    const value = getPath(result, path);
    console.log(formatOutput(value));
    break;
  }

  default:
    console.error("Usage: json-tool.ts <command> [args...]");
    console.error("");
    console.error("Commands:");
    console.error("  get <file> [path]         - Get value at path");
    console.error("  set <file> <updates...>   - Update values");
    console.error("  valid <file>              - Check if valid JSON");
    console.error("  merge <files...>          - Merge JSON files");
    console.error("  merge-get <path> <files...> - Merge files and get path");
    process.exit(1);
}
