#!/usr/bin/env bun
/**
 * Worker Protocol - Signal management for multi-session orchestrator
 *
 * Handles communication between orchestrator and worker agents via signal files.
 *
 * Usage:
 *   bun worker-protocol.ts signal <action> [args]  - Manage worker signals
 *   bun worker-protocol.ts loop <action> [args]    - Manage ralph loop state
 *   bun worker-protocol.ts agent <action> [args]   - Load agent definitions
 *
 * Signal commands:
 *   signal write <phase> <status> [--agent-id=ID] [questions...]  - Write worker signal
 *   signal read                                    - Read current signal
 *   signal clear                                   - Clear signal file
 *   signal status                                  - Get signal status
 *
 * Loop commands:
 *   loop init <max_iterations>                     - Initialize loop state
 *   loop increment                                 - Increment iteration
 *   loop get <field>                               - Get loop field value
 *   loop set-agent <agent_id>                      - Set implementer agent ID
 *   loop complete                                  - Mark loop as complete
 *
 * Agent commands:
 *   agent load <name>                              - Load agent definition
 *   agent list                                     - List available agents
 */

import * as fs from "fs";
import * as path from "path";

// Paths
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.dirname(path.dirname(path.resolve(__filename)));
const taskDir = path.join(projectDir, ".task");
const signalFile = path.join(taskDir, "worker-signal.json");
const loopStateFile = path.join(taskDir, "loop-state.json");
const agentsDir = path.join(pluginRoot, "agents");

// Interfaces
interface WorkerSignal {
  worker_id: string;
  phase: "requirements" | "planning" | "implementation";
  status: "needs_input" | "completed" | "error" | "in_progress";
  progress: { step: string; percent: number };
  questions: Array<{
    id: string;
    question: string;
    options?: string[];
    context?: string;
  }>;
  partial_output: Record<string, unknown>;
  agent_id: string;
  timestamp: string;
}

interface LoopState {
  active: boolean;
  iteration: number;
  max_iterations: number;
  completion_promise: string;
  plan_path: string;
  implementer_agent_id: string | null;
  started_at: string;
  last_failure?: string;
}

interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools: string;
  disallowedTools?: string;
  content: string;
}

// Utilities
function ensureTaskDir(): void {
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureTaskDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function generateId(prefix: string): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

// Signal Commands
function signalWrite(
  phase: string,
  status: string,
  questions: string[] = [],
  agentId?: string
): void {
  // Preserve existing signal values if file exists (for resume flow)
  let existingSignal: Partial<WorkerSignal> = {};
  if (fs.existsSync(signalFile)) {
    try {
      existingSignal = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const signal: WorkerSignal = {
    worker_id: existingSignal.worker_id || generateId(phase),
    phase: phase as WorkerSignal["phase"],
    status: status as WorkerSignal["status"],
    progress: { step: "initializing", percent: 0 },
    questions: questions.map((q, i) => ({
      id: `q${i + 1}`,
      question: q,
    })),
    partial_output: {},
    agent_id: agentId || existingSignal.agent_id || "",
    timestamp: new Date().toISOString(),
  };
  writeJsonFile(signalFile, signal);
  console.log(JSON.stringify(signal, null, 2));
}

function signalRead(): void {
  const signal = readJsonFile<WorkerSignal>(signalFile);
  if (!signal) {
    console.log("{}");
    return;
  }
  console.log(JSON.stringify(signal, null, 2));
}

function signalClear(): void {
  if (fs.existsSync(signalFile)) {
    fs.unlinkSync(signalFile);
    console.log("Signal cleared");
  } else {
    console.log("No signal to clear");
  }
}

function signalStatus(): void {
  const signal = readJsonFile<WorkerSignal>(signalFile);
  if (!signal) {
    console.log("none");
    return;
  }
  console.log(signal.status);
}

// Loop Commands
function loopInit(maxIterations: number): void {
  const loopState: LoopState = {
    active: true,
    iteration: 0,
    max_iterations: maxIterations,
    completion_promise: "<promise>IMPLEMENTATION_COMPLETE</promise>",
    plan_path: ".task/plan-refined.json",
    implementer_agent_id: null,
    started_at: new Date().toISOString(),
  };
  writeJsonFile(loopStateFile, loopState);
  console.log(JSON.stringify(loopState, null, 2));
}

function loopIncrement(): void {
  const state = readJsonFile<LoopState>(loopStateFile);
  if (!state) {
    console.error("Error: Loop state not initialized");
    process.exit(1);
  }
  state.iteration++;
  writeJsonFile(loopStateFile, state);
  console.log(state.iteration);
}

function loopGet(field: string): void {
  const state = readJsonFile<LoopState>(loopStateFile);
  if (!state) {
    console.log("");
    return;
  }
  const value = (state as Record<string, unknown>)[field];
  if (value === undefined || value === null) {
    console.log("");
    return;
  }
  console.log(String(value));
}

function loopSetAgent(agentId: string): void {
  const state = readJsonFile<LoopState>(loopStateFile);
  if (!state) {
    console.error("Error: Loop state not initialized");
    process.exit(1);
  }
  state.implementer_agent_id = agentId;
  writeJsonFile(loopStateFile, state);
  console.log(`Agent ID set: ${agentId}`);
}

function loopComplete(): void {
  const state = readJsonFile<LoopState>(loopStateFile);
  if (!state) {
    console.error("Error: Loop state not initialized");
    process.exit(1);
  }
  state.active = false;
  writeJsonFile(loopStateFile, state);
  console.log("Loop marked complete");
}

function loopSetFailure(message: string): void {
  const state = readJsonFile<LoopState>(loopStateFile);
  if (!state) {
    console.error("Error: Loop state not initialized");
    process.exit(1);
  }
  state.last_failure = message;
  writeJsonFile(loopStateFile, state);
  console.log(`Failure recorded: ${message}`);
}

// Agent Commands
function parseAgentFrontmatter(
  content: string
): { frontmatter: Record<string, string>; body: string } | null {
  // Normalize line endings to LF for cross-platform compatibility (Windows CRLF support)
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalizedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2] };
}

function agentLoad(name: string): void {
  const agentFile = path.join(agentsDir, `${name}.md`);

  if (!fs.existsSync(agentFile)) {
    console.error(`Error: Agent not found: ${name}`);
    console.error(`Available agents: ${agentList().join(", ")}`);
    process.exit(1);
  }

  const content = fs.readFileSync(agentFile, "utf-8");
  const parsed = parseAgentFrontmatter(content);

  if (!parsed) {
    console.error(`Error: Invalid agent format: ${name}`);
    process.exit(1);
  }

  const agent: AgentDefinition = {
    name: parsed.frontmatter.name || name,
    description: parsed.frontmatter.description || "",
    model: parsed.frontmatter.model,  // Optional - orchestrator controls via Task tool
    tools: parsed.frontmatter.tools || "",
    disallowedTools: parsed.frontmatter.disallowedTools,
    content: parsed.body.trim(),
  };

  console.log(JSON.stringify(agent, null, 2));
}

function agentList(): string[] {
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

function agentListCmd(): void {
  const agents = agentList();
  if (agents.length === 0) {
    console.log("No agents found");
    return;
  }
  console.log("Available agents:");
  for (const agent of agents) {
    console.log(`  - ${agent}`);
  }
}

function agentPrompt(name: string): void {
  const agentFile = path.join(agentsDir, `${name}.md`);

  if (!fs.existsSync(agentFile)) {
    console.error(`Error: Agent not found: ${name}`);
    process.exit(1);
  }

  const content = fs.readFileSync(agentFile, "utf-8");
  const parsed = parseAgentFrontmatter(content);

  if (!parsed) {
    console.error(`Error: Invalid agent format: ${name}`);
    process.exit(1);
  }

  // Output just the prompt body for inclusion in Task tool
  console.log(parsed.body.trim());
}

// Main
const args = process.argv.slice(2);
const category = args[0];
const action = args[1];

switch (category) {
  case "signal":
    switch (action) {
      case "write": {
        // Parse optional --agent-id flag from remaining args
        const writeArgs = args.slice(4);
        let agentId: string | undefined;
        const questions: string[] = [];
        for (const arg of writeArgs) {
          if (arg.startsWith("--agent-id=")) {
            agentId = arg.slice("--agent-id=".length);
          } else {
            questions.push(arg);
          }
        }
        signalWrite(args[2] || "unknown", args[3] || "in_progress", questions, agentId);
        break;
      }
      case "read":
        signalRead();
        break;
      case "clear":
        signalClear();
        break;
      case "status":
        signalStatus();
        break;
      default:
        console.error("Usage: worker-protocol.ts signal <write|read|clear|status>");
        process.exit(1);
    }
    break;

  case "loop":
    switch (action) {
      case "init":
        loopInit(parseInt(args[2]) || 10);
        break;
      case "increment":
        loopIncrement();
        break;
      case "get":
        loopGet(args[2] || "iteration");
        break;
      case "set-agent":
        loopSetAgent(args[2] || "");
        break;
      case "complete":
        loopComplete();
        break;
      case "set-failure":
        loopSetFailure(args.slice(2).join(" "));
        break;
      default:
        console.error(
          "Usage: worker-protocol.ts loop <init|increment|get|set-agent|complete|set-failure>"
        );
        process.exit(1);
    }
    break;

  case "agent":
    switch (action) {
      case "load":
        agentLoad(args[2] || "");
        break;
      case "list":
        agentListCmd();
        break;
      case "prompt":
        agentPrompt(args[2] || "");
        break;
      default:
        console.error("Usage: worker-protocol.ts agent <load|list|prompt>");
        process.exit(1);
    }
    break;

  default:
    console.error("Worker Protocol - Signal management for multi-session orchestrator");
    console.error("");
    console.error("Usage: worker-protocol.ts <category> <action> [args...]");
    console.error("");
    console.error("Categories:");
    console.error("  signal   - Manage worker signals");
    console.error("  loop     - Manage ralph loop state");
    console.error("  agent    - Load agent definitions");
    console.error("");
    console.error("Examples:");
    console.error('  worker-protocol.ts signal write requirements needs_input "What auth method?"');
    console.error("  worker-protocol.ts loop init 10");
    console.error("  worker-protocol.ts agent load planner");
    process.exit(1);
}
