#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { GuidedReviewError, SensitiveDiffError } from "./errors";
import { installCodexSkill } from "./installer";
import { validateServeHost, startReviewServer } from "./server";
import { buildWorkflow, refreshWorkflow, snapshotWorkflow } from "./workflow";
import { VERSION } from "./version";

const HELP = `guided-review ${VERSION}

Turn a complete Git diff into an agent-authored guided review.

Commands:
  snapshot       Freeze a Git diff and create a review session
  build          Validate story.json and render a self-contained review
  refresh        Refresh Git facts and mark stale narrative explicitly
  serve          Serve a built review on a loopback address
  install-skill  Install the bundled Codex skill

Run guided-review <command> --help for command options.

The CLI never calls an AI model. Use the bundled guided-code-review skill so
the current agent authors the story before invoking build and serve.`;

const SNAPSHOT_HELP = `Usage: guided-review snapshot [options]

Options:
  --repo <path>                 Repository or worktree (default: current directory)
  --base <ref>                  Raw diff base (default: HEAD)
  --target <ref>                Use merge-base(target, HEAD)
  --committed-only              Diff base to HEAD; ignore working-tree changes
  --no-untracked                Omit untracked non-ignored files
  --exclude <glob>              Explicitly omit matching paths; repeatable
  --allow-sensitive             Permit suspected credentials in the artifact
  --output-dir <path>           Persistent session directory instead of OS temp
  --allow-unignored-output      Permit output inside a repository when not ignored
  --json                        Emit machine-readable output`;

const BUILD_HELP = `Usage: guided-review build --session <path> [--story <story.json>] [--json]`;
const REFRESH_HELP = `Usage: guided-review refresh --session <path> [--json]`;
const SERVE_HELP = `Usage: guided-review serve --session <path> [--host 127.0.0.1] [--port 0] [--open]`;
const INSTALL_HELP = `Usage: guided-review install-skill codex [--codex-home <path>] [--force] [--dry-run] [--json]`;

function emit(value: unknown, human: string, jsonRequested: boolean): void {
  if (jsonRequested || !process.stdout.isTTY) console.log(JSON.stringify(value, null, 2));
  else console.log(human);
}

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

async function snapshotCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) return void console.log(SNAPSHOT_HELP);
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      target: { type: "string" },
      "committed-only": { type: "boolean" },
      "no-untracked": { type: "boolean" },
      exclude: { type: "string", multiple: true },
      "allow-sensitive": { type: "boolean" },
      "output-dir": { type: "string" },
      "allow-unignored-output": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const result = await snapshotWorkflow({
    repo: parsed.values.repo ?? process.cwd(),
    ...(parsed.values.base ? { base: parsed.values.base } : {}),
    ...(parsed.values.target ? { target: parsed.values.target } : {}),
    committedOnly: parsed.values["committed-only"] ?? false,
    includeUntracked: !(parsed.values["no-untracked"] ?? false),
    excludes: parsed.values.exclude ?? [],
    allowSensitive: parsed.values["allow-sensitive"] ?? false,
    ...(parsed.values["output-dir"] ? { outputDirectory: parsed.values["output-dir"] } : {}),
    allowUnignoredOutput: parsed.values["allow-unignored-output"] ?? false,
  });
  const payload = {
    ok: true,
    sessionId: result.session.id,
    sessionDir: result.session.directory,
    snapshotId: result.snapshot.id,
    totals: result.snapshot.totals,
    files: result.snapshot.files.map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })),
    paths: result.paths,
  };
  emit(payload, `Snapshot ${result.snapshot.id}\nSession: ${result.session.directory}\nStory template: ${result.paths.storyTemplate}`, parsed.values.json ?? false);
}

async function buildCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) return void console.log(BUILD_HELP);
  const parsed = parseArgs({ args, strict: true, options: { session: { type: "string" }, story: { type: "string" }, json: { type: "boolean" } } });
  if (!parsed.values.session) throw new GuidedReviewError("build requires --session <path>");
  const result = await buildWorkflow(parsed.values.session, parsed.values.story);
  const payload = { ok: true, sessionDir: result.session.directory, html: result.htmlPath, snapshotId: result.currentSnapshot.id, storySnapshotId: result.story.snapshotId, totals: result.currentSnapshot.totals };
  emit(payload, `Review built: ${result.htmlPath}`, parsed.values.json ?? false);
}

async function refreshCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) return void console.log(REFRESH_HELP);
  const parsed = parseArgs({ args, strict: true, options: { session: { type: "string" }, json: { type: "boolean" } } });
  if (!parsed.values.session) throw new GuidedReviewError("refresh requires --session <path>");
  const result = await refreshWorkflow(parsed.values.session);
  const payload = { ok: true, sessionDir: result.session.directory, snapshotId: result.snapshot.id, html: result.htmlPath, totals: result.snapshot.totals };
  emit(payload, `Diff refreshed: ${result.snapshot.id}${result.htmlPath ? `\nReview: ${result.htmlPath}` : ""}`, parsed.values.json ?? false);
}

async function serveCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) return void console.log(SERVE_HELP);
  const parsed = parseArgs({
    args,
    strict: true,
    options: { session: { type: "string" }, host: { type: "string" }, port: { type: "string" }, open: { type: "boolean" } },
  });
  if (!parsed.values.session) throw new GuidedReviewError("serve requires --session <path>");
  const host = parsed.values.host ?? "127.0.0.1";
  validateServeHost(host);
  const port = Number(parsed.values.port ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new GuidedReviewError("--port must be an integer from 0 to 65535");
  const result = await startReviewServer(parsed.values.session, { host, port, open: parsed.values.open ?? false });
  console.log(`Guided review: ${result.address}`);
  console.log(`Session: ${result.session.directory}`);
}

async function installCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) return void console.log(INSTALL_HELP);
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { "codex-home": { type: "string" }, force: { type: "boolean" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
  });
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "codex") throw new GuidedReviewError("install-skill currently supports exactly one target: codex");
  const result = await installCodexSkill({ codexHome: parsed.values["codex-home"], force: parsed.values.force ?? false, dryRun: parsed.values["dry-run"] ?? false });
  emit({ ok: true, ...result }, `${result.action === "install" ? "Installed" : "Updated"} Codex skill: ${result.destination}${result.backup ? `\nBackup: ${result.backup}` : ""}`, parsed.values.json ?? false);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || wantsHelp(argv)) return void console.log(HELP);
  if (argv[0] === "--version" || argv[0] === "-v") return void console.log(VERSION);
  const [command, ...args] = argv;
  switch (command) {
    case "snapshot":
      return snapshotCommand(args);
    case "build":
      return buildCommand(args);
    case "refresh":
      return refreshCommand(args);
    case "serve":
      return serveCommand(args);
    case "install-skill":
      return installCommand(args);
    default:
      throw new GuidedReviewError(`unknown command: ${command}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const jsonRequested = process.argv.includes("--json") || !process.stderr.isTTY;
    if (error instanceof SensitiveDiffError) {
      if (jsonRequested) console.error(JSON.stringify({ ok: false, error: error.message, code: error.exitCode, findings: error.findings }, null, 2));
      else console.error(error.message);
      process.exit(error.exitCode);
    }
    if (error instanceof GuidedReviewError) {
      if (jsonRequested) console.error(JSON.stringify({ ok: false, error: error.message, code: error.exitCode }, null, 2));
      else console.error(`error: ${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(error);
    process.exit(1);
  });
}
