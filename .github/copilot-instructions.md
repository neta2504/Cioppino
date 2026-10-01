# GitHub Copilot CLI Instructions
These instructions guide GitHub Copilot CLI when working in this repository.
They define coding standards, security requirements, and safe CLI behavior.
The focus is on secure, production-grade code and reproducible CLI operations.

## Core Principles
- Always prioritize **security, correctness, and clarity** over brevity
- Prefer **explicit commands** over implicit or ambiguous behavior
- Generate **production-ready code**, not prototypes
- Minimize unnecessary file changes
- Always explain what a suggested command does before running it.
- Never run destructive commands without explicit confirmation.
- Avoid exposing secrets, tokens, private keys, or credentials.
- Test everything and make sure it is working.

## Project Structure

<!-- Describe the layout of the repo so Copilot can place new files correctly -->

```
src/         # Application source
tests/       # Test files
docs/        # Documentation
scripts/     # Build / dev scripts
```

## Testing

- Add tests for new functionality and bug fixes.
- Run tests before declaring a task complete

## Security

- Never log secrets, tokens, or PII.
- Sanitize all user-supplied input before using it in queries, shell commands, or HTML.
- Follow the OWASP Top 10 avoid SQL injection, XSS, command injection, and insecure deserialization.

## Communication

- When making non-trivial changes, summarize what changed and why.
- If a request is ambiguous, ask one clarifying question rather than guessing.
- Flag assumptions explicitly so the user can correct them.
