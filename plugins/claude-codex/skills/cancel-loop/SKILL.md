---
name: cancel-loop
description: Cancel the active Ralph implementation loop. Use when you want to stop the iterative process.
plugin-scoped: true
allowed-tools: Read, Write, Bash
---

# Cancel Implementation Loop

This skill cancels an active Ralph implementation loop, allowing the session to exit normally.

## When to Use

- The loop is stuck or making no progress
- You want to manually intervene
- You've decided to take a different approach
- Max iterations warning appeared and you want to stop

## What It Does

1. Reads the current loop state from `.task/loop-state.json`
2. Sets `active: false` to deactivate the loop
3. Reports the final state (iterations completed, last status)

## Usage

Simply invoke:
```
/cancel-loop
```

## Process

### Step 1: Check Loop State

Read `.task/loop-state.json` to see current state:

```bash
cat "${CLAUDE_PROJECT_DIR}/.task/loop-state.json" 2>/dev/null || echo "No active loop found"
```

### Step 2: Deactivate Loop

If loop is active, update the state file:

```bash
if [[ -f "${CLAUDE_PROJECT_DIR}/.task/loop-state.json" ]]; then
    # Use bun/node to update JSON
    bun -e "
        const fs = require('fs');
        const path = '${CLAUDE_PROJECT_DIR}/.task/loop-state.json';
        const state = JSON.parse(fs.readFileSync(path, 'utf8'));
        state.active = false;
        state.cancelled_at = new Date().toISOString();
        state.cancelled_by = 'user';
        fs.writeFileSync(path, JSON.stringify(state, null, 2));
        console.log('Loop cancelled at iteration', state.iteration);
    "
fi
```

### Step 3: Report Status

Tell the user:
- How many iterations were completed
- Last review status
- Last test status
- What files were changed

### Step 4: Clean Exit

The session can now exit normally since the loop is deactivated.

## Alternative: Manual Cancellation

You can also cancel the loop manually by:

1. **Delete the state file:**
   ```bash
   rm "${CLAUDE_PROJECT_DIR}/.task/loop-state.json"
   ```

2. **Or edit it directly:**
   ```bash
   # Set active to false
   bun -e "
       const fs = require('fs');
       const state = JSON.parse(fs.readFileSync('.task/loop-state.json'));
       state.active = false;
       fs.writeFileSync('.task/loop-state.json', JSON.stringify(state, null, 2));
   "
   ```

## Output

After cancellation, report:

```
Loop cancelled.

Status:
- Iterations completed: 3 of 10
- Last review: Sonnet approved, Opus needs_changes, Codex not run
- Last tests: 2 passed, 1 failed

The session will now exit normally.
To resume, run /multi-ai with your request again.
```
