# Project Standards

## Coding Standards

### General Principles
- Write self-documenting code
- Keep functions small and focused (< 50 lines)
- No `any` types - use `unknown` if truly unknown
- Handle errors explicitly

### Naming Conventions
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`

---

## Review Checklist

This checklist defines all review categories. Each reviewer checks categories at different depths based on their role (see Reviewer Focus Areas below). Severity levels determine whether issues block approval.

### Security - OWASP Top 10 2021 (severity: error)

**Critical security items - checked by all reviewers at appropriate depth:**

1. **A01:2021 - Broken Access Control**
   - Authorization checks on all protected resources
   - No IDOR vulnerabilities
2. **A02:2021 - Cryptographic Failures**
   - No secrets/credentials in code
   - Encryption for sensitive data at rest and in transit
3. **A03:2021 - Injection** (SQL, NoSQL, Command, LDAP, XSS)
   - Parameterized queries, no string concatenation
   - Command execution with proper escaping
   - Output encoding, Content Security Policy
4. **A04:2021 - Insecure Design**
   - Security built-in, not bolted on
   - Threat modeling for new features
5. **A05:2021 - Security Misconfiguration**
   - Secure defaults, no debug in production
   - Disable unnecessary features/DTD processing
6. **A06:2021 - Vulnerable and Outdated Components**
   - Check dependencies for CVEs
7. **A07:2021 - Identification and Authentication Failures**
   - Secure session management
   - Strong password policies
8. **A08:2021 - Software and Data Integrity Failures**
   - Validate and sanitize serialized data
   - Verify CI/CD pipeline integrity
9. **A09:2021 - Security Logging and Monitoring Failures**
   - Security events logged (without sensitive data)
10. **A10:2021 - Server-Side Request Forgery (SSRF)**
    - Validate and sanitize URLs for server-side requests

### Error Handling (severity: error/warning)

- **error**: Unhandled exceptions that could crash the application
- **error**: Sensitive data exposed in error messages
- **warning**: Missing error handling for failure paths
- **warning**: Generic error messages that don't help debugging
- **suggestion**: Error recovery mechanisms

### Resource Management (severity: error/warning)

- **error**: Memory leaks (unclosed streams, listeners not removed)
- **error**: Connection leaks (database, HTTP, sockets)
- **warning**: Missing timeouts on external calls
- **warning**: File handles not properly closed
- **suggestion**: Connection pooling for repeated operations

### Configuration (severity: error/warning)

- **error**: Hardcoded secrets or credentials
- **error**: Sensitive config not environment-based
- **warning**: Hardcoded values that should be configurable
- **warning**: Missing validation for config values
- **suggestion**: Document required environment variables

### Code Quality (severity: warning/suggestion)

#### Readability
- **warning**: Unclear or misleading variable/function names
- **warning**: Functions doing too many things (> 50 lines)
- **warning**: Deep nesting (> 3 levels)
- **suggestion**: Complex logic without explanatory comments
- **suggestion**: Inconsistent formatting

#### Simplification (KISS)
- **warning**: Over-complicated solutions for simple problems
- **warning**: Unnecessary abstraction layers
- **warning**: Premature optimization
- **suggestion**: Could be simplified without losing functionality

#### Comments & Documentation
- **warning**: Public APIs without documentation
- **warning**: Complex algorithms without explanation
- **suggestion**: Self-documenting code preferred over comments
- **suggestion**: Outdated comments that don't match code

#### Reusability & DRY
- **warning**: Significant code duplication (> 10 lines repeated)
- **warning**: Copy-paste with minor modifications
- **suggestion**: Opportunity for shared utility/helper
- **suggestion**: Consistent patterns across similar code

### Concurrency (severity: error/warning)

- **error**: Race conditions (TOCTOU - time of check to time of use)
- **error**: Deadlock potential
- **warning**: Shared mutable state without synchronization
- **warning**: Missing thread safety documentation
- **suggestion**: Consider async/await over callbacks

### Logging & Observability (severity: error/warning/suggestion)

- **error**: Secrets or PII in log output
- **warning**: Missing logging for critical operations
- **warning**: Inappropriate log levels (errors logged as info)
- **suggestion**: Correlation IDs for request tracing
- **suggestion**: Structured logging format

### Dependency Management (severity: warning/suggestion)

- **warning**: Known vulnerabilities in dependencies (CVEs)
- **warning**: Unnecessary dependencies (bloat)
- **warning**: Unpinned versions that could break
- **suggestion**: Prefer well-maintained, popular packages

### API Design (severity: warning/suggestion)

- **warning**: Missing input validation
- **warning**: Inconsistent response formats
- **warning**: Missing error responses for edge cases
- **suggestion**: Proper HTTP status codes
- **suggestion**: Consistent naming conventions

### Backward Compatibility (severity: warning/suggestion)

- **warning**: Breaking changes to public APIs without versioning
- **warning**: Database schema changes without migration
- **suggestion**: Deprecation warnings before removal
- **suggestion**: Document breaking changes

### Over-Engineering Detection (severity: warning)

- Abstractions without multiple use cases
- Premature optimization
- Unnecessary configuration/flexibility
- Complex patterns for simple problems
- Excessive layers of indirection

### Testing (severity: warning/suggestion)

- **warning**: No tests for new functionality
- **warning**: Tests don't cover failure paths
- **suggestion**: Edge cases not tested
- **suggestion**: Test names don't describe behavior

---

## Reviewer Focus Areas

Each reviewer has primary focus areas while still checking all items:

| Aspect | Sonnet (fast) | Opus (deep) | Codex (final) |
|--------|---------------|-------------|---------------|
| OWASP Security | Quick scan | Deep analysis | Final gate |
| Error Handling | Obvious gaps | Edge cases | Completeness |
| Resource Management | Obvious leaks | Subtle issues | Verification |
| Configuration | Hardcoded secrets | All hardcoded values | Overall |
| Readability | Naming, structure | Cognitive complexity | Clarity |
| Simplification | Obvious complexity | KISS violations | Balance |
| Comments | Missing critical | Quality check | Documentation |
| Reusability | DRY violations | Abstraction quality | Consistency |
| Concurrency | - | Race conditions, deadlocks | Verification |
| Logging | Secrets in logs | Log quality | Completeness |
| Dependencies | - | CVE check | Final check |
| API Design | Input validation | Response consistency | Overall |
| Backward Compat | - | Breaking changes | Migration |
| Testing | Tests exist | Test quality | Coverage |

---

## Decision Rules

- Any `error` → status: `needs_changes`
- 2+ `warning` → status: `needs_changes`
- Only `suggestion` → status: `approved`
