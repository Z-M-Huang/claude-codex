---
name: user-story
description: Gather and clarify requirements before autonomous pipeline execution. Interactive phase for user input.
plugin-scoped: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# User Story Gathering Phase

This skill handles the **interactive requirements gathering phase** before the autonomous pipeline runs. This is the ONLY phase where user interaction is expected.

## Purpose

- Gather complete requirements from the user
- Ask clarifying questions to resolve ambiguity
- Get user approval on the finalized requirements
- Write approved requirements for autonomous processing

## Process

### Step 1: Analyze the Request

Read the user's initial request and identify:
- Core functionality requested
- Potential ambiguities or unclear requirements
- Missing information needed for implementation
- Technical decisions that need user input

### Step 2: Ask Clarifying Questions

Use the `AskUserQuestion` tool to gather any missing information. Focus on:

1. **Functional Requirements**
   - What should the feature do?
   - What are the expected inputs/outputs?
   - What are the edge cases to handle?

2. **Technical Preferences**
   - Any preferred libraries or approaches?
   - Compatibility requirements?
   - Performance expectations?

3. **Scope Boundaries**
   - What is explicitly OUT of scope?
   - Minimum viable vs. nice-to-have features?

### Step 3: Summarize Requirements

Create a clear requirements summary and present it to the user:

```
## Requirements Summary

### Core Requirements
- [List main features/functionality]

### Technical Approach
- [Preferred technologies/patterns]

### Scope
- In scope: [what will be implemented]
- Out of scope: [what won't be implemented]

### Acceptance Criteria
- [How to verify the feature works]
```

### Step 4: Get User Approval

Ask the user to confirm the requirements are correct:

```
Does this requirements summary accurately capture what you want?

If yes, I'll proceed with the autonomous pipeline:
1. Planning phase (with automated reviews)
2. Implementation phase (with automated reviews)
3. Final report

You won't need to intervene unless there's an unresolvable issue.
```

### Step 5: Write Approved Requirements

Once approved, write to `.task/user-story.json`:

```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Short descriptive title",
  "original_request": "The user's original request text",
  "requirements": {
    "functional": ["req1", "req2"],
    "technical": ["tech1", "tech2"],
    "acceptance_criteria": ["criterion1", "criterion2"]
  },
  "scope": {
    "in_scope": ["item1", "item2"],
    "out_of_scope": ["item1", "item2"]
  },
  "clarifications": [
    {"question": "Q1?", "answer": "A1"},
    {"question": "Q2?", "answer": "A2"}
  ],
  "approved_at": "ISO8601",
  "approved_by": "user"
}
```

Also write the original request to `.task/user-request.txt`.

### Step 6: Signal Ready for Autonomous Processing

After writing the approved requirements, output:

```
Requirements approved and saved. Starting autonomous pipeline...
```

The multi-ai skill will then take over and run autonomously.

---

## Important Notes

- This is the ONLY phase where back-and-forth with the user is expected
- Ask all necessary questions BEFORE getting approval
- Once approved, the pipeline should run autonomously
- If you truly cannot determine something, mark it in requirements as TBD and note it will be decided during planning
