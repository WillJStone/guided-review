# guided-review

`guided-review` turns a complete local Git diff into a reviewer-first HTML tour. Git supplies the facts; the agent that implemented the change supplies the story.

The CLI is deterministic and local. It does not call a model, upload code, or mutate the repository being reviewed. A bundled Codex skill asks the current agent to order the change, explain intent and runtime flow, identify risks and decisions, and prove that every changed file is represented.

## Requirements and setup

- [Bun](https://bun.sh/) 1.2 or newer
- Git
- Optional: Codex for the bundled authoring workflow

```bash
git clone https://github.com/WillJStone/guided-review.git
cd guided-review
bun link
guided-review --help
```

Install the Codex skill after reviewing any existing skill at the destination:

```bash
guided-review install-skill codex
```

The installer updates skills previously managed by this CLI. It refuses to replace an unrelated `guided-code-review` skill unless `--force` is supplied, in which case the original is preserved as a timestamped backup.

## Agent-authored workflow

Ask Codex to “create a guided review of my current changes,” or invoke `$guided-code-review` explicitly. The skill performs this lifecycle:

1. `guided-review snapshot --repo . --json` freezes the complete working-tree diff in a private OS-temporary session.
2. The current agent inspects the snapshot and nearby code, then populates the generated `story.json` using the versioned schema.
3. `guided-review build` validates exact file coverage and emits one self-contained HTML file.
4. `guided-review serve --open` starts a loopback-only viewer with live diff refresh.

The story is labelled **originating** only when the current agent actually performed the implementation. Otherwise it is labelled **reconstructed** so the reviewer knows the rationale was inferred afterward.

The browser may refresh current Git facts, but it never silently regenerates prose. If the diff changes, the page marks the narrative stale, highlights changed files, and places new files in an explicit unreviewed section until an agent rewrites the story.

Each file card offers three complementary views:

- **Diff** preserves the complete Git patch.
- **Source** shows the full captured file with lightweight syntax highlighting. Deleted files show their pre-change source.
- **Preview** renders Markdown files as reviewer-friendly documents.

Native views are embedded from the same frozen snapshot as the diff, never read live by the browser. Binary files and text files larger than 2 MiB keep their diff but omit the native source view.

## CLI

```text
guided-review snapshot [--repo .] [--base HEAD | --target main]
                       [--committed-only] [--no-untracked]
                       [--exclude <glob>] [--allow-sensitive]
                       [--output-dir <path>] [--json]

guided-review build --session <path> --story <story.json> [--json]
guided-review refresh --session <path> [--json]
guided-review serve --session <path> [--host 127.0.0.1] [--port 0] [--open]
guided-review install-skill codex [--codex-home <path>] [--force] [--dry-run]
```

`snapshot` defaults to `HEAD` and includes staged, unstaged, and untracked non-ignored files. `--target` resolves the merge base locally and never fetches. Explicit exclusions remain visible in snapshot metadata.

Sessions use the OS temporary directory by default and receive private permissions. A persistent `--output-dir` inside the reviewed repository must already be Git-ignored unless `--allow-unignored-output` is explicit.

## Safety

High-confidence credential signatures and sensitive filenames block artifact creation before a full diff is written. Because native views embed complete files, scanning covers the full embedded source, including unchanged lines. Findings report only path, line, and category. `--allow-sensitive` is an explicit override and appears in the rendered review.

The HTML embeds the complete reviewed diff, so treat a saved review with the same sensitivity as the source code it contains.

## Optional repository policy

Add this to a repository’s `AGENTS.md` when substantial changes should always receive an authored handoff:

```markdown
After substantial implementation work, use the `guided-code-review` skill to create and open a complete guided review before handoff. The implementing agent should author the story from its active context and verify it against the captured diff.
```

## Development

The runtime intentionally has no package dependencies.

```bash
bun test
bun run typecheck
```

The public story contract lives at `schemas/story.schema.json`. Generated sessions and review artifacts are local data and are not part of this repository.
