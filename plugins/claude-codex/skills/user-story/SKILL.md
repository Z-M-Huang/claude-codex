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
- Explore alternative approaches with the user
- Validate requirements in digestible chunks
- Get user approval on the finalized requirements
- Write approved requirements for autonomous processing

## Key Principles

### Multiple-Choice Preference

When using `AskUserQuestion`, **prefer multiple-choice options** over open-ended questions:
- Easier and faster for users to respond
- Reduces ambiguity in answers
- Use 2-4 concrete options when possible
- Always allow "Other" for custom responses (built into the tool)

**Good example:**
```
Question: "How should authentication be handled?"
Options:
- JWT tokens (stateless, good for APIs)
- Session-based (traditional, server-side state)
- OAuth integration (delegate to external provider)
```

**Avoid:** "What authentication approach do you prefer?" (open-ended)

### Iterative Questioning

Questions can be asked at **any point** before final approval:
- During initial analysis
- While exploring alternatives
- During chunked validation
- Whenever something is unclear

Don't feel constrained to ask all questions upfront. Ask as needed throughout the process.

### YAGNI (You Aren't Gonna Need It)

Actively identify and cut non-essential features:
- Focus on minimum viable requirements
- Push back gently on scope creep
- Ask "Is this essential for the first version?"

---

## Process

### Step 1: Analyze the Request

Read the user's initial request and identify:
- Core functionality requested
- Potential ambiguities or unclear requirements
- Missing information needed for implementation
- Technical decisions that need user input

Review existing project context if relevant:
- Current codebase structure and patterns
- Existing similar functionality
- Technical constraints

### Step 2: Initial Clarifying Questions

Use `AskUserQuestion` with **multiple-choice options** to gather missing information:

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

Multiple rounds of questions are fine - ask until you have enough clarity.

### Step 3: Explore Alternative Approaches

Before committing to a single approach, **present 2-3 alternatives** with trade-offs:

```
## Possible Approaches

### Option A: [Name] (Recommended)
- **How it works:** Brief description
- **Pros:** List benefits
- **Cons:** List drawbacks
- **Best for:** When this approach shines

### Option B: [Name]
- **How it works:** Brief description
- **Pros:** List benefits
- **Cons:** List drawbacks
- **Best for:** When this approach shines

### Option C: [Name] (if applicable)
- ...

Which approach would you prefer?
```

**Guidelines:**
- Lead with your recommended option and explain why
- Be honest about trade-offs for each option
- If one approach is clearly superior, say so - don't artificially balance
- Ask follow-up questions if needed to refine the chosen approach

### Step 4: Chunked Validation

Instead of presenting one large requirements summary, **validate in chunks**. Present each section and get confirmation before moving to the next:

**Chunk 1: Architecture/Approach**
```
## Architecture

Based on your choice of [Option X], here's how the implementation will be structured:

- [Key architectural decision 1]
- [Key architectural decision 2]
- [Integration points]

Does this architecture make sense? Any concerns?
```

**Chunk 2: Core Requirements**
```
## Core Requirements

1. [Requirement 1 - specific and testable]
2. [Requirement 2 - specific and testable]
3. [Requirement 3 - specific and testable]

Are these the core requirements? Anything missing or incorrect?
```

**Chunk 3: Scope Boundaries**
```
## Scope

**In scope:**
- [Item 1]
- [Item 2]

**Explicitly out of scope:**
- [Item 1]
- [Item 2]

Does this scope look right?
```

**Chunk 4: Acceptance Criteria**
```
## Acceptance Criteria

The feature will be complete when:
1. [Criterion 1 - verifiable]
2. [Criterion 2 - verifiable]
3. [Criterion 3 - verifiable]

Are these the right success criteria?
```

**Chunk 5: Test-Driven Completion (TDD Criteria)**
```
## Test Plan

To verify the implementation is complete, we'll run:

**Test Commands:**
- `[test command 1]` - [what it verifies]
- `[test command 2]` - [what it verifies]

**Success Indicators:**
- All tests pass (exit code 0)
- [Additional success criteria like coverage threshold]

**Implementation Mode:**
- [ ] Simple (single implementation + review cycle)
- [x] Ralph Loop (iterative until tests pass + reviews approve)

**Max Iterations:** 10 (safety limit for ralph loop)

Does this test plan look right? Any commands to add or remove?
```

**Ask clarifying questions** during any chunk if something is unclear. You can loop back to previous chunks if needed.

### Step 5: Final Approval

Once all chunks are validated, present a brief summary and get final approval:

```
## Ready to Proceed

All requirements have been validated:
- Architecture: [chosen approach]
- Core requirements: [count] items
- Scope: defined
- Acceptance criteria: [count] items

Shall I proceed with the autonomous pipeline?
1. Planning phase (with automated reviews)
2. Implementation phase (with automated reviews)
3. Final report

You won't need to intervene unless there's an unresolvable issue.
```

### Step 6: Write Approved Requirements

Once approved, write to `.task/user-story.json`:

```json
{
  "id": "story-YYYYMMDD-HHMMSS",
  "title": "Short descriptive title",
  "original_request": "The user's original request text",
  "chosen_approach": {
    "name": "Option name",
    "description": "Brief description of chosen approach",
    "rationale": "Why this approach was selected"
  },
  "requirements": {
    "functional": ["req1", "req2"],
    "technical": ["tech1", "tech2"],
    "acceptance_criteria": ["criterion1", "criterion2"]
  },
  "scope": {
    "in_scope": ["item1", "item2"],
    "out_of_scope": ["item1", "item2"]
  },
  "test_criteria": {
    "commands": ["npm test", "npm run lint"],
    "success_pattern": "passed|✓|All tests passed",
    "failure_pattern": "FAILED|Error|failed"
  },
  "implementation": {
    "mode": "ralph-loop",
    "max_iterations": 10,
    "skill": "implement-sonnet"
  },
  "clarifications": [
    {"question": "Q1?", "answer": "A1"},
    {"question": "Q2?", "answer": "A2"}
  ],
  "alternatives_considered": [
    {"name": "Option B", "reason_not_chosen": "Why it wasn't selected"}
  ],
  "approved_at": "ISO8601",
  "approved_by": "user"
}
```

Also write the original request to `.task/user-request.txt`.

### Step 7: Signal Ready for Autonomous Processing

After writing the approved requirements, output:

```
Requirements approved and saved. Starting autonomous pipeline...
```

The multi-ai skill will then take over and run autonomously.

---

## Important Notes

- This is the ONLY phase where back-and-forth with the user is expected
- Questions can be asked at ANY point before final approval - don't front-load everything
- Prefer multiple-choice questions for faster, clearer responses
- Always explore alternatives before committing to an approach
- Validate in chunks to catch misunderstandings early
- Once approved, the pipeline should run autonomously
- If you truly cannot determine something, mark it in requirements as TBD and note it will be decided during planning
