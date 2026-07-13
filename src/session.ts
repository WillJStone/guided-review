import { access, chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GuidedReviewError } from "./errors";
import { storyTemplate } from "./story";
import type { ReviewSessionV1, SnapshotOptions, SnapshotV1, StoryV1 } from "./types";
import { SESSION_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./types";
import { assertRecord, readJson, safeSlug, writePrivateJson, writePrivateText } from "./util";

export interface SessionPaths {
  session: string;
  snapshots: string;
  storyTemplate: string;
  story: string;
  html: string;
}

export function sessionPaths(directory: string): SessionPaths {
  return {
    session: path.join(directory, "session.json"),
    snapshots: path.join(directory, "snapshots"),
    storyTemplate: path.join(directory, "story.template.json"),
    story: path.join(directory, "story.json"),
    html: path.join(directory, "review.html"),
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function pathInside(parent: string, candidate: string): string | null {
  const relative = path.relative(parent, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return relative || ".";
  return null;
}

async function canonicalPath(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  while (!(await exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.resolve(candidate);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(await realpath(existing), ...suffix);
}

async function assertOutputSafe(repo: string, outputDirectory: string, allowUnignored: boolean): Promise<void> {
  const [canonicalRepo, canonicalOutput] = await Promise.all([realpath(repo), canonicalPath(outputDirectory)]);
  const relative = pathInside(canonicalRepo, canonicalOutput);
  if (relative === null || allowUnignored) return;
  const status = Bun.spawnSync(["git", "check-ignore", "--quiet", "--", relative], { cwd: canonicalRepo }).exitCode;
  if (status !== 0) {
    throw new GuidedReviewError(
      `output is inside the reviewed repository but is not ignored: ${outputDirectory}\nUse an ignored path or pass --allow-unignored-output explicitly.`,
    );
  }
}

export async function createSession(
  snapshot: SnapshotV1,
  options: SnapshotOptions,
  outputDirectory?: string,
  allowUnignoredOutput = false,
): Promise<{ session: ReviewSessionV1; paths: SessionPaths }> {
  const id = `${safeSlug(snapshot.repository.name)}-${snapshot.id.slice(0, 10)}-${Date.now().toString(36)}`;
  const directory = path.resolve(outputDirectory ?? path.join(tmpdir(), "guided-review-sessions", id));
  await assertOutputSafe(snapshot.repository.root, directory, allowUnignoredOutput);
  if (await exists(path.join(directory, "session.json"))) {
    throw new GuidedReviewError(`a guided-review session already exists at ${directory}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const paths = sessionPaths(directory);
  await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
  const session: ReviewSessionV1 = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: new Date().toISOString(),
    directory,
    repositoryRoot: snapshot.repository.root,
    snapshotOptions: {
      base: snapshot.scope.baseOid,
      ...(options.target ? { target: options.target } : {}),
      committedOnly: options.committedOnly,
      includeUntracked: options.includeUntracked,
      excludes: [...options.excludes],
      allowSensitive: options.allowSensitive,
    },
    currentSnapshotId: snapshot.id,
  };
  await saveSnapshot(session, snapshot);
  await writePrivateJson(paths.storyTemplate, storyTemplate(snapshot));
  await writePrivateJson(paths.session, session);
  return { session, paths };
}

export async function loadSession(directory: string): Promise<ReviewSessionV1> {
  const resolved = path.resolve(directory);
  const raw = await readJson(sessionPaths(resolved).session);
  assertRecord(raw, "session");
  if (raw.schemaVersion !== SESSION_SCHEMA_VERSION) throw new GuidedReviewError(`unsupported session schema: ${String(raw.schemaVersion)}`);
  if (typeof raw.id !== "string" || typeof raw.currentSnapshotId !== "string" || typeof raw.repositoryRoot !== "string") {
    throw new GuidedReviewError("session metadata is incomplete");
  }
  assertRecord(raw.snapshotOptions, "session.snapshotOptions");
  return raw as unknown as ReviewSessionV1;
}

export async function saveSession(session: ReviewSessionV1): Promise<void> {
  await writePrivateJson(sessionPaths(session.directory).session, session);
}

export async function saveSnapshot(session: ReviewSessionV1, snapshot: SnapshotV1): Promise<string> {
  const destination = path.join(sessionPaths(session.directory).snapshots, `${snapshot.id}.json`);
  if (!(await exists(destination))) await writePrivateJson(destination, snapshot);
  return destination;
}

export async function loadSnapshot(session: ReviewSessionV1, id = session.currentSnapshotId): Promise<SnapshotV1> {
  const file = path.join(sessionPaths(session.directory).snapshots, `${id}.json`);
  const raw = await readJson(file);
  assertRecord(raw, "snapshot");
  if (raw.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || typeof raw.id !== "string" || !Array.isArray(raw.files)) {
    throw new GuidedReviewError(`invalid snapshot at ${file}`);
  }
  return raw as unknown as SnapshotV1;
}

export async function saveStory(session: ReviewSessionV1, story: StoryV1): Promise<string> {
  const destination = sessionPaths(session.directory).story;
  await writePrivateJson(destination, story);
  session.storyPath = destination;
  session.storySnapshotId = story.snapshotId;
  await saveSession(session);
  return destination;
}

export async function loadSavedStory(session: ReviewSessionV1): Promise<unknown | null> {
  const storyFile = session.storyPath ?? sessionPaths(session.directory).story;
  if (!(await exists(storyFile))) return null;
  return readJson(storyFile);
}

export async function saveHtml(session: ReviewSessionV1, html: string): Promise<string> {
  const destination = sessionPaths(session.directory).html;
  await writePrivateText(destination, html);
  session.htmlPath = destination;
  await saveSession(session);
  return destination;
}

export async function readHtml(session: ReviewSessionV1): Promise<string> {
  const file = session.htmlPath ?? sessionPaths(session.directory).html;
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new GuidedReviewError(`review HTML has not been built for session ${session.directory}`);
  }
}
