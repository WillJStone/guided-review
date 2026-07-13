import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { GuidedReviewError, SensitiveDiffError } from "./errors";
import { scanSnapshotForSecrets } from "./secrets";
import type { FileStatus, SnapshotFile, SnapshotOptions, SnapshotV1 } from "./types";
import { SNAPSHOT_SCHEMA_VERSION } from "./types";
import { matchesAnyGlob, normalizeRepoPath, sha256 } from "./util";

const MAX_GIT_BUFFER = 512 * 1024 * 1024;
const MAX_NATIVE_BYTES = 2 * 1024 * 1024;

interface ChangedEntry {
  path: string;
  previousPath?: string;
  status: FileStatus;
  untracked: boolean;
}

function gitBytes(repo: string, args: string[], check = true): Buffer {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "buffer",
    maxBuffer: MAX_GIT_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new GuidedReviewError(`failed to run git ${args.join(" ")}: ${result.error.message}`);
  if (check && result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new GuidedReviewError(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function gitText(repo: string, args: string[], check = true): string {
  return gitBytes(repo, args, check).toString("utf8").trim();
}

function splitZero(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath);
}

function statusFromCode(code: string): FileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

function trackedEntries(repo: string, baseOid: string, committedOnly: boolean): ChangedEntry[] {
  const args = ["diff", "--name-status", "-z", "--find-renames", baseOid];
  if (committedOnly) args.push("HEAD");
  args.push("--");
  const tokens = splitZero(gitBytes(repo, args));
  const result: ChangedEntry[] = [];
  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index++];
    if (!code) break;
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = tokens[index++];
      const currentPath = tokens[index++];
      if (!previousPath || !currentPath) throw new GuidedReviewError("git returned an incomplete rename record");
      result.push({ path: currentPath, previousPath, status: statusFromCode(code), untracked: false });
    } else {
      const currentPath = tokens[index++];
      if (!currentPath) throw new GuidedReviewError("git returned an incomplete changed-file record");
      result.push({ path: currentPath, status: statusFromCode(code), untracked: false });
    }
  }
  return result;
}

function untrackedEntries(repo: string): ChangedEntry[] {
  return splitZero(gitBytes(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({ path: file, status: "added", untracked: true }));
}

async function syntheticDiff(repo: string, relative: string): Promise<string> {
  const absolute = path.join(repo, relative);
  const metadata = await lstat(absolute);
  const mode = metadata.isSymbolicLink() ? "120000" : metadata.mode & 0o111 ? "100755" : "100644";
  const raw = metadata.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
  const header = [
    `diff --git a/${relative} b/${relative}`,
    `new file mode ${mode}`,
    "index 0000000..0000000",
  ];
  if (raw.includes(0)) return [...header, `Binary files /dev/null and b/${relative} differ`, ""].join("\n");
  const content = raw.toString("utf8");
  if (Buffer.from(content, "utf8").compare(raw) !== 0) {
    return [...header, `Binary files /dev/null and b/${relative} differ`, ""].join("\n");
  }
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = withoutTrailingNewline === "" ? [] : withoutTrailingNewline.split("\n");
  const body = ["--- /dev/null", `+++ b/${relative}`];
  if (lines.length > 0) body.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`));
  return [...header, ...body, ""].join("\n");
}

function nativeFromBytes(raw: Buffer, origin: "before" | "after"): NonNullable<SnapshotFile["native"]> {
  if (raw.byteLength > MAX_NATIVE_BYTES) return { origin, kind: "too-large", bytes: raw.byteLength };
  if (raw.includes(0)) return { origin, kind: "binary", bytes: raw.byteLength };
  const text = raw.toString("utf8");
  if (Buffer.from(text, "utf8").compare(raw) !== 0) return { origin, kind: "binary", bytes: raw.byteLength };
  return { origin, kind: "text", bytes: raw.byteLength, text };
}

function gitBlob(repo: string, revision: string, relative: string): Buffer | null {
  const result = spawnSync("git", ["show", `${revision}:${relative}`], {
    cwd: repo,
    encoding: "buffer",
    maxBuffer: MAX_GIT_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

async function nativeContent(
  repo: string,
  baseOid: string,
  entry: ChangedEntry,
  committedOnly: boolean,
): Promise<NonNullable<SnapshotFile["native"]>> {
  if (entry.status === "deleted") {
    const raw = gitBlob(repo, baseOid, entry.previousPath ?? entry.path);
    return raw ? nativeFromBytes(raw, "before") : { origin: "before", kind: "unavailable", reason: "base content is unavailable" };
  }
  if (committedOnly) {
    const raw = gitBlob(repo, "HEAD", entry.path);
    return raw ? nativeFromBytes(raw, "after") : { origin: "after", kind: "unavailable", reason: "HEAD content is unavailable" };
  }
  try {
    const absolute = path.join(repo, entry.path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) return nativeFromBytes(Buffer.from(await readlink(absolute)), "after");
    if (!metadata.isFile()) return { origin: "after", kind: "unavailable", reason: "native view is unavailable for this file type" };
    return nativeFromBytes(await readFile(absolute), "after");
  } catch {
    return { origin: "after", kind: "unavailable", reason: "working-tree content is unavailable" };
  }
}

function trackedDiff(repo: string, baseOid: string, relative: string, committedOnly: boolean): string {
  const args = ["diff", "--no-ext-diff", "--find-renames", "--unified=3", baseOid];
  if (committedOnly) args.push("HEAD");
  args.push("--", relative);
  return gitBytes(repo, args).toString("utf8");
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

async function stateFingerprint(repo: string, baseOid: string, committedOnly: boolean, includeUntracked: boolean): Promise<string> {
  const args = ["diff", "--binary", "--no-ext-diff", baseOid];
  if (committedOnly) args.push("HEAD");
  args.push("--");
  const chunks: Array<string | Uint8Array> = [gitBytes(repo, args)];
  if (includeUntracked && !committedOnly) {
    for (const entry of untrackedEntries(repo)) {
      const absolute = path.join(repo, entry.path);
      const metadata = await lstat(absolute);
      chunks.push(entry.path);
      chunks.push(metadata.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
    }
  }
  const encoded = chunks.map((chunk) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("base64"))).join("\0");
  return sha256(encoded);
}

export function resolveRepository(input: string): string {
  return path.resolve(gitText(path.resolve(input), ["rev-parse", "--show-toplevel"]));
}

export async function captureSnapshot(options: SnapshotOptions): Promise<SnapshotV1> {
  const repo = resolveRepository(options.repo);
  if (options.base && options.target) throw new GuidedReviewError("--base and --target cannot be used together");
  const headOid = gitText(repo, ["rev-parse", "HEAD"]);
  const requestedBase = options.target
    ? gitText(repo, ["merge-base", options.target, "HEAD"])
    : options.base ?? "HEAD";
  gitText(repo, ["rev-parse", "--verify", requestedBase]);
  const baseOid = gitText(repo, ["rev-parse", requestedBase]);
  const includeUntracked = options.includeUntracked && !options.committedOnly;
  const before = await stateFingerprint(repo, baseOid, options.committedOnly, includeUntracked);

  const allEntries = [
    ...trackedEntries(repo, baseOid, options.committedOnly),
    ...(includeUntracked ? untrackedEntries(repo) : []),
  ];
  const seen = new Set<string>();
  const excludedFiles: string[] = [];
  const entries = allEntries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    if (matchesAnyGlob(entry.path, options.excludes)) {
      excludedFiles.push(entry.path);
      return false;
    }
    return true;
  });
  if (entries.length === 0 && !options.allowEmpty) throw new GuidedReviewError("the selected diff contains no reviewable files");

  const files: SnapshotFile[] = [];
  for (const entry of entries) {
    const diff = entry.untracked
      ? await syntheticDiff(repo, entry.path)
      : trackedDiff(repo, baseOid, entry.path, options.committedOnly);
    const counts = diffCounts(diff);
    const native = await nativeContent(repo, baseOid, entry, options.committedOnly);
    files.push({
      path: entry.path,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      status: entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      diff,
      diffHash: sha256(diff),
      binary: diff.includes("Binary files ") || diff.includes("GIT binary patch"),
      native,
    });
  }
  const after = await stateFingerprint(repo, baseOid, options.committedOnly, includeUntracked);
  if (before !== after) throw new GuidedReviewError("the working tree changed while it was being captured; retry the snapshot");

  const branch = gitText(repo, ["branch", "--show-current"]) || "detached HEAD";
  const identity = {
    repository: repo,
    branch,
    baseOid,
    headOid,
    committedOnly: options.committedOnly,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      diffHash: file.diffHash,
      nativeHash: file.native?.kind === "text" ? sha256(file.native.text ?? "") : `${file.native?.kind}:${file.native?.bytes ?? ""}`,
    })),
  };
  const id = sha256(JSON.stringify(identity)).slice(0, 24);
  const snapshot: SnapshotV1 = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id,
    createdAt: new Date().toISOString(),
    repository: { root: repo, name: path.basename(repo), branch },
    scope: {
      requestedBase: options.target ? `merge-base(${options.target}, HEAD)` : requestedBase,
      baseOid,
      ...(options.target ? { target: options.target } : {}),
      headOid,
      committedOnly: options.committedOnly,
      includeUntracked,
      excludes: [...options.excludes],
      excludedFiles,
    },
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    fingerprint: after,
    sensitiveOverride: options.allowSensitive,
  };
  const findings = scanSnapshotForSecrets(snapshot);
  if (findings.length > 0 && !options.allowSensitive) throw new SensitiveDiffError(findings);
  return snapshot;
}
