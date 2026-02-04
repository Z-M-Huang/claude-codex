# Claude Codex Marketplace

![GitHub release](https://img.shields.io/github/v/release/Z-M-Huang/claude-codex?style=flat-square)
![GitHub license](https://img.shields.io/github/license/Z-M-Huang/claude-codex?style=flat-square)
![GitHub last commit](https://img.shields.io/github/last-commit/Z-M-Huang/claude-codex?style=flat-square)
![Windows](https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black)

A Claude Code plugin marketplace providing multi-AI orchestration tools for planning, implementing, and reviewing code changes.

> **New to Claude Codex?** Check out our [Wiki](https://github.com/Z-M-Huang/claude-codex/wiki) for beginner-friendly guides and tutorials. Available in [English](https://github.com/Z-M-Huang/claude-codex/wiki) and [中文](https://github.com/Z-M-Huang/claude-codex/wiki/Home-zh).

## Why Multi-AI Review?

**Would you deploy code that only one person looked at?**

In professional software development, code reviews are mandatory. Google requires review for every change. Microsoft uses multiple review stages. Claude Codex brings this professional standard to AI-assisted development.

Instead of trusting a single AI's output, your code goes through **three independent reviews**:

| Reviewer | What It Catches |
|----------|-----------------|
| **Claude Sonnet** | Obvious bugs, security basics, code style |
| **Claude Opus** | Architectural issues, subtle bugs, edge cases |
| **Codex** | Fresh perspective from a different AI |

**The result:** More bugs caught, better security, and production-ready code.

Each reviewer checks for OWASP Top 10 vulnerabilities, proper error handling, and code quality. If Sonnet misses something, Opus or Codex will likely catch it. The loop-until-approved model means code doesn't proceed until all three reviewers give the green light.

Learn more: [Why Claude Codex?](https://github.com/Z-M-Huang/claude-codex/wiki/Why-Claude-Codex)

## Installation

### Step 1: Add Marketplace

```bash
/plugin marketplace add Z-M-Huang/claude-codex
```

### Step 2: Install Plugin

```bash
# Install at user scope (available in all projects) - RECOMMENDED
/plugin install claude-codex@claude-codex --scope user

# OR install at project scope (this project only)
/plugin install claude-codex@claude-codex --scope project
```

### Step 3: Add .task to .gitignore

The plugin automatically creates `.task/` in your project directory. Add it to `.gitignore`:

```bash
echo ".task" >> .gitignore
```

> **Multi-Project Support:** When installed at user scope, you can run the pipeline in multiple projects simultaneously. Each project gets its own isolated `.task/` directory.

### Usage

After installation, use skills with the plugin namespace:

```bash
# Start the full pipeline
/claude-codex:multi-ai Add user authentication with JWT
```

## Available Plugins

### claude-codex

Multi-AI orchestration pipeline with **hook-based enforcement** using Task + Resume architecture.
**Skills:**

| Skill          | Purpose                                     |
| -------------- | ------------------------------------------- |
| `multi-ai`     | Pipeline entry point (orchestrates agents)  |

**Custom Agents:**

| Agent                   | Model  | Purpose                                  |
| ----------------------- | ------ | ---------------------------------------- |
| `requirements-gatherer` | Opus   | Business Analyst + PM hybrid             |
| `planner`               | Opus   | Architect + Fullstack hybrid             |
| `plan-reviewer`         | Both   | Architecture + Security + QA validation  |
| `implementer`           | Sonnet | Fullstack + TDD + Quality implementation |
| `code-reviewer`         | Both   | Security + Performance + QA validation   |

## Recommended Subscriptions

| Service         | Subscription | Purpose                                        |
| --------------- | ------------ | ---------------------------------------------- |
| **Claude Code** | MAX 20       | Main thread (planning, coding) + Review skills |
| **Codex CLI**   | Plus         | Final reviews (invoked via skill)              |

## How It Works

### Quick Start with `/multi-ai`

```bash
/claude-codex:multi-ai Add user authentication with JWT tokens
```

This command orchestrates specialized agents:

1. **Requirements** (interactive) - `requirements-gatherer` agent gathers requirements + TDD criteria
2. **Planning** (semi-interactive) - `planner` agent creates plan, asks user only if needed
3. **Plan Reviews** (autonomous) - `plan-reviewer` agents (sonnet, opus) + Codex gate
4. **Implementation** (Ralph Loop) - `implementer` agent iterates until tests pass + reviews approve
5. **Code Reviews** (autonomous) - `code-reviewer` agents (sonnet, opus) + Codex gate
6. **Complete** - Reports results

### Task-Based Pipeline Enforcement

The pipeline uses **task dependencies** and **hook validation** (v1.3.1):

```
┌────────────────────────────────────────────────────┐
│  SEQUENTIAL REVIEWS (enforced via blockedBy)        │
│  ┌──────────────────────────────────────────────┐  │
│  │ 1. Implement code (implementer agent)        │  │
│  │ 2. Code review (sonnet) - blocked until impl │  │
│  │ 3. Code review (opus) - blocked until sonnet │  │
│  │ 4. Code review (codex) - blocked until opus  │  │
│  │                                              │  │
│  │ IF review needs_changes                      │  │
│  │    → Create fix task + re-review task        │  │
│  │    → Same reviewer validates fixes           │  │
│  │                                              │  │
│  │ IF all reviews approved                      │  │
│  │    → Pipeline complete                       │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

**Key benefits:**

- **Hook enforcement** - SubagentStop validates acceptance criteria coverage
- **Task dependencies** - `blockedBy` prevents skipping reviews
- **Same-reviewer validation** - Fixes are validated by the reviewer who requested them
- **Clarification support** - Reviewers can request clarification via `needs_clarification` status

## Marketplace Structure

```
claude-codex/
├── .claude-plugin/
│   └── marketplace.json          # Marketplace catalog
├── plugins/
│   └── claude-codex/             # Multi-AI plugin
│       ├── .claude-plugin/
│       │   └── plugin.json       # Plugin manifest
│       ├── agents/               # Custom agent definitions
│       │   ├── requirements-gatherer.md
│       │   ├── planner.md
│       │   ├── plan-reviewer.md
│       │   ├── implementer.md
│       │   └── code-reviewer.md
│       ├── skills/               # Pipeline skills
│       │   └── multi-ai/         # Main orchestrator
│       ├── scripts/              # Orchestration scripts
│       ├── hooks/                # Pipeline enforcement hooks
│       ├── docs/                 # Standards and workflow
│       ├── .task.template/       # Task directory template
│       ├── CLAUDE.md
│       └── AGENTS.md
└── README.md
```

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (for review-codex skill)
- [Bun](https://bun.sh/) installed (required by Claude Code, also used for cross-platform JSON processing)

> **Note:** This plugin works on Windows, macOS, and Linux. All shell scripts use Bun for JSON processing instead of `jq`, ensuring cross-platform compatibility out of the box.

## Default Settings

The pipeline uses these hardcoded defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| Plan review loop limit | 10 | Max iterations for plan reviews |
| Code review loop limit | 15 | Max iterations for code reviews |
| Auto-resolve attempts | 3 | Retries before pausing on errors |

## Creating Your Own Plugin

To add a new plugin to this marketplace:

1. Create a directory under `plugins/your-plugin-name/`
2. Add `.claude-plugin/plugin.json` with your plugin manifest
3. Add your skills under `skills/`
4. Update `.claude-plugin/marketplace.json` to include your plugin

Example plugin.json:

```json
{
  "name": "your-plugin-name",
  "version": "1.0.9",
  "description": "What your plugin does",
  "author": { "name": "Your Name" },
  "skills": "./skills/"
}
```

## Troubleshooting

### Plugin not found

```bash
# Verify marketplace is added
/plugin marketplace list

# Re-add if needed
/plugin marketplace add Z-M-Huang/claude-codex
```

### Skills not loading

```bash
# Check plugin is installed
/plugin list

# Reinstall if needed
/plugin uninstall claude-codex@claude-codex
/plugin install claude-codex@claude-codex --scope user
```

### Validate plugin structure

```bash
/plugin validate .
```

### Skill not working with slash command

When invoking skills from external projects, you must use the full namespaced format:

```bash
# Correct - use the full namespace
/claude-codex:multi-ai Add user authentication

# Wrong - bare skill name doesn't work from external projects
/multi-ai Add user authentication
```

The bare skill name (e.g., `/multi-ai`) only works within the plugin's internal context. When using the plugin from your own project, always prefix with `claude-codex:`.

**Alternative:** You can also ask Claude naturally without using slash commands:

> "Use the multi-ai pipeline to add user authentication"

Claude will recognize this and invoke the appropriate skill.

## Documentation

For detailed guides, visit our [Wiki](https://github.com/Z-M-Huang/claude-codex/wiki):

### English

- [Why Claude Codex?](https://github.com/Z-M-Huang/claude-codex/wiki/Why-Claude-Codex) - Benefits of multi-AI review
- [Getting Started](https://github.com/Z-M-Huang/claude-codex/wiki/Getting-Started) - Step-by-step installation for beginners
- [Understanding the Pipeline](https://github.com/Z-M-Huang/claude-codex/wiki/Understanding-the-Pipeline) - How the review process works
- [How to Use](https://github.com/Z-M-Huang/claude-codex/wiki/How-to-Use) - Commands and usage examples
- [Configuration](https://github.com/Z-M-Huang/claude-codex/wiki/Configuration) - Customization options
- [Troubleshooting](https://github.com/Z-M-Huang/claude-codex/wiki/Troubleshooting) - Common issues and solutions

### 中文

- [为什么选择 Claude Codex？](https://github.com/Z-M-Huang/claude-codex/wiki/Why-Claude-Codex-zh) - 多 AI 审查的优势
- [快速开始](https://github.com/Z-M-Huang/claude-codex/wiki/Getting-Started-zh) - 零基础安装指南
- [流水线详解](https://github.com/Z-M-Huang/claude-codex/wiki/Understanding-the-Pipeline-zh) - 审查流程工作原理
- [使用方法](https://github.com/Z-M-Huang/claude-codex/wiki/How-to-Use-zh) - 命令和使用示例
- [配置说明](https://github.com/Z-M-Huang/claude-codex/wiki/Configuration-zh) - 自定义选项
- [常见问题](https://github.com/Z-M-Huang/claude-codex/wiki/Troubleshooting-zh) - 问题排查与解决

## Related Projects

- [claude-codex-gemini](https://github.com/Z-M-Huang/claude-codex-gemini) - Adds Gemini as a dedicated orchestrator

## License

GPL-3.0 with attribution requirement.

If you use, modify, or distribute this software, please provide attribution to:
- **Author:** Z-M-Huang
- **Project:** Claude Codex
- **Repository:** https://github.com/Z-M-Huang/claude-codex

See [LICENSE](LICENSE) for full terms.
