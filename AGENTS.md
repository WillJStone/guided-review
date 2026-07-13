# Guided Review

Dependency-free Bun/TypeScript CLI for turning complete Git diffs into agent-authored guided review tours.

## Rules

- Keep runtime dependencies at zero; use Bun and Node built-ins.
- The CLI owns Git facts, validation, rendering, and serving. It must never call an AI model.
- The agent-authored story is untrusted input: validate it strictly and escape it before rendering.
- A fresh review must cover every changed file exactly once. A live refresh may show explicit unreviewed changes, but must never present stale prose as current.
- Never mutate the repository being reviewed.
- Keep the bundled Codex skill concise and make the CLI the single deterministic implementation.

## Verification

```bash
bun test
bun run typecheck
bun run browser:smoke -- <review-html>
```
