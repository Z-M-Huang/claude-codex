# Claude Codex Marketplace

A Claude Code plugin marketplace providing multi-AI orchestration tools for planning, implementing, and reviewing code changes.

**Supported Platforms:** Windows, macOS, Linux

> **New to Claude Codex?** Check out our [comprehensive Wiki](https://github.com/Z-M-Huang/claude-codex/wiki) for beginner-friendly guides and tutorials.

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

# Or run individual skills
/claude-codex:review-sonnet
/claude-codex:review-opus
/claude-codex:review-codex
/claude-codex:implement-sonnet
```

## Available Plugins

### claude-codex

Multi-AI orchestration pipeline with sequential review workflow (sonnet → opus → codex).

**Skills included:**

| Skill              | Model             | Purpose                                     |
| ------------------ | ----------------- | ------------------------------------------- |
| `multi-ai`         | -                 | Pipeline entry point (starts full workflow) |
| `implement-sonnet` | Claude Sonnet 4.5 | Code implementation with main context       |
| `review-sonnet`    | Claude Sonnet 4.5 | Fast review (code + security + tests)       |
| `review-opus`      | Claude Opus 4.5   | Deep review (architecture + subtle issues)  |
| `review-codex`     | Codex CLI         | Final review via OpenAI Codex               |

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

This command:

1. Cleans up previous task files
2. Creates and refines a plan
3. Runs sequential reviews (sonnet → opus → codex)
4. Implements the code
5. Runs sequential reviews (sonnet → opus → codex)
6. Marks complete

### Sequential Review Flow

Reviews run **sequentially** - each model reviews only ONCE per cycle:

```
Plan/Code → review-sonnet → fix → review-opus → fix → review-codex → fix (restart)
```

**Key benefits:**

- Each model provides unique perspective without re-reviewing
- Progressive refinement (fast → deep → final)
- Token-efficient (forked context isolation)

## Marketplace Structure

```
claude-codex/
├── .claude-plugin/
│   └── marketplace.json          # Marketplace catalog
├── plugins/
│   └── claude-codex/             # Multi-AI plugin
│       ├── .claude-plugin/
│       │   └── plugin.json       # Plugin manifest
│       ├── skills/               # Pipeline skills
│       │   ├── multi-ai/
│       │   ├── implement-sonnet/
│       │   ├── review-sonnet/
│       │   ├── review-opus/
│       │   └── review-codex/
│       ├── scripts/              # Orchestration scripts
│       ├── docs/                 # Standards and workflow
│       ├── .task.template/       # Task directory template
│       ├── pipeline.config.json
│       ├── CLAUDE.md
│       └── AGENTS.md
└── README.md
```

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (for review-codex skill)
- [Bun](https://bun.sh/) installed (required by Claude Code, also used for cross-platform JSON processing)

> **Note:** This plugin works on Windows, macOS, and Linux. All shell scripts use Bun for JSON processing instead of `jq`, ensuring cross-platform compatibility out of the box.

## Configuration

The plugin includes `pipeline.config.json` with these settings:

| Setting                             | Description                                   | Default           |
| ----------------------------------- | --------------------------------------------- | ----------------- |
| `autonomy.mode`                     | `autonomous`, `semi-autonomous`, `supervised` | `semi-autonomous` |
| `autonomy.planReviewLoopLimit`      | Max plan review iterations                    | `10`              |
| `autonomy.codeReviewLoopLimit`      | Max code review iterations                    | `15`              |
| `errorHandling.autoResolveAttempts` | Retries before pausing                        | `3`               |

### Per-Project Overrides

Create `pipeline.config.local.json` in your project directory to override settings:

```json
{
  "autonomy": {
    "codeReviewLoopLimit": 20
  }
}
```

Config priority: project-local > plugin-local > plugin-base

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
  "version": "1.0.4",
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

- [Why Claude Codex?](https://github.com/Z-M-Huang/claude-codex/wiki/Why-Claude-Codex) - Benefits of multi-AI review
- [Getting Started](https://github.com/Z-M-Huang/claude-codex/wiki/Getting-Started) - Step-by-step installation for beginners
- [Understanding the Pipeline](https://github.com/Z-M-Huang/claude-codex/wiki/Understanding-the-Pipeline) - How the review process works
- [How to Use](https://github.com/Z-M-Huang/claude-codex/wiki/How-to-Use) - Commands and usage examples
- [Configuration](https://github.com/Z-M-Huang/claude-codex/wiki/Configuration) - Customization options
- [Troubleshooting](https://github.com/Z-M-Huang/claude-codex/wiki/Troubleshooting) - Common issues and solutions

## Related Projects

- [claude-codex-gemini](https://github.com/Z-M-Huang/claude-codex-gemini) - Adds Gemini as a dedicated orchestrator

## License

GPL-3.0 license
