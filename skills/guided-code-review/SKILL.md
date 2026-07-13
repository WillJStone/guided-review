---
name: guided-code-review
description: Turn a local Git working-tree, branch, or PR diff into a complete, logically ordered HTML review authored by the current agent. Use when a user asks to explain changes, create or open a guided review, present a structured diff tour, organize a large implementation for review, or replace filename-ordered GitHub diffs with an intent-first narrative.
---

<!-- managed-by-guided-review:0.1.0 -->

# Guided Code Review

Use the `guided-review` CLI for Git capture, completeness checks, rendering, and serving. Author the story yourself; never ask the CLI to call a model.

## Workflow

1. Read the target repository instructions and determine scope.
   - Use the default `HEAD` base for uncommitted work.
   - Use `--target <ref>` for a branch review; the CLI resolves the merge base without fetching.
   - Use `--committed-only` only when the user excludes working-tree changes.
2. Capture a snapshot:

   ```bash
   guided-review snapshot --repo /absolute/repo/path --json
   ```

   Read the returned snapshot and story-template paths. If sensitive-content detection blocks capture, stop and ask before using `--allow-sensitive`.
3. Decide authorship honestly.
   - Set `originating` only when this active agent context performed the implementation being explained.
   - Otherwise set `reconstructed` and state that the narrative was inferred from code and Git history.
4. Inspect every changed file plus enough nearby architecture to understand intent, runtime flow, tradeoffs, and verification. Use implementation context as evidence, but reconcile it against the actual snapshot.
5. Populate the returned `story.json` path using the template.
   - Order 5–9 stages by system story, not filename.
   - Assign every changed file to exactly one stage and preserve meaningful order inside each stage.
   - Ground every hotspot and callout with one or more changed-file `evidence` paths.
   - Separate strengths, attention points, risks, and genuine questions.
   - Include only decisions the reviewer actually needs to make.
6. Build and validate:

   ```bash
   guided-review build --session /absolute/session/path --story /absolute/session/path/story.json --json
   ```

   Do not weaken coverage validation or exclude substantive files to make the build pass.
7. Serve and open the result when the user asks to see it:

   ```bash
   guided-review serve --session /absolute/session/path --open
   ```

8. If code changes afterward, use `guided-review refresh --session ...`. Treat the resulting stale badge as a requirement to inspect the new snapshot and rewrite the story before approval.

Do not modify reviewed source merely to produce the review. The generated session belongs in the OS temporary directory unless the user explicitly requests persistent output.

## Story shape

Follow the generated template and the bundled schema. The essential structure is:

```json
{
  "schemaVersion": 1,
  "snapshotId": "snapshot-id",
  "authorship": {"mode": "originating", "agent": "codex", "disclosure": "Authored from the implementation context and verified against the snapshot."},
  "title": "Feature · Guided review",
  "kicker": "A reviewer-first tour of the change",
  "headline": "Read the change in the order it was designed.",
  "introduction": "One compact paragraph describing the journey.",
  "flow": [{"label": "Input", "detail": "What enters", "evidence": ["path/to/file.ts"]}],
  "hotspots": [{"tone": "attention", "label": "Boundary", "text": "Why to slow down here.", "evidence": ["path/to/file.ts"]}],
  "stages": [{"id": "intent", "eyebrow": "Start with why", "title": "Product contract", "summary": "Why this comes first.", "reviewLens": ["The concrete question to answer."], "callouts": [], "files": ["path/to/file.ts"]}],
  "decisions": [{"label": "Compatibility", "question": "The explicit choice to make.", "evidence": ["path/to/file.ts"]}]
}
```

Allowed tones are `good`, `attention`, `risk`, and `question`.
