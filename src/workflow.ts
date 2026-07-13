import path from "node:path";

import { GuidedReviewError } from "./errors";
import { captureSnapshot } from "./git";
import { renderReview } from "./render";
import {
  createSession,
  loadSavedStory,
  loadSession,
  loadSnapshot,
  saveHtml,
  saveSession,
  saveSnapshot,
  saveStory,
  sessionPaths,
} from "./session";
import { validateStory } from "./story";
import type { ReviewSessionV1, SnapshotOptions, StoryV1 } from "./types";
import { assertRecord, readJson } from "./util";

export interface SnapshotCommandOptions extends SnapshotOptions {
  outputDirectory?: string;
  allowUnignoredOutput: boolean;
}

export async function snapshotWorkflow(options: SnapshotCommandOptions) {
  const snapshot = await captureSnapshot(options);
  const { session, paths } = await createSession(snapshot, options, options.outputDirectory, options.allowUnignoredOutput);
  return {
    session,
    snapshot,
    paths: {
      session: paths.session,
      snapshot: path.join(paths.snapshots, `${snapshot.id}.json`),
      storyTemplate: paths.storyTemplate,
      story: paths.story,
      html: paths.html,
    },
  };
}

async function storyFromFile(file: string): Promise<unknown> {
  return readJson(path.resolve(file));
}

async function resolveStorySnapshot(session: ReviewSessionV1, rawStory: unknown) {
  assertRecord(rawStory, "story");
  if (typeof rawStory.snapshotId !== "string") throw new GuidedReviewError("story.snapshotId must be a string");
  return loadSnapshot(session, rawStory.snapshotId);
}

export async function buildWorkflow(directory: string, storyFile?: string) {
  const session = await loadSession(directory);
  const rawStory = storyFile ? await storyFromFile(storyFile) : await loadSavedStory(session);
  if (rawStory === null) {
    throw new GuidedReviewError(`no story was provided; populate ${sessionPaths(session.directory).story} and pass it to build`);
  }
  const storySnapshot = await resolveStorySnapshot(session, rawStory);
  const story = validateStory(rawStory, storySnapshot);
  await saveStory(session, story);
  const currentSnapshot = await loadSnapshot(session);
  const html = renderReview(story, storySnapshot, currentSnapshot);
  const htmlPath = await saveHtml(session, html);
  return { session, story, storySnapshot, currentSnapshot, htmlPath };
}

export async function refreshWorkflow(directory: string) {
  const session = await loadSession(directory);
  const options: SnapshotOptions = {
    repo: session.repositoryRoot,
    ...(session.snapshotOptions.base ? { base: session.snapshotOptions.base } : {}),
    committedOnly: session.snapshotOptions.committedOnly,
    includeUntracked: session.snapshotOptions.includeUntracked,
    excludes: [...session.snapshotOptions.excludes],
    allowSensitive: session.snapshotOptions.allowSensitive,
    allowEmpty: true,
  };
  const snapshot = await captureSnapshot(options);
  await saveSnapshot(session, snapshot);
  session.currentSnapshotId = snapshot.id;
  await saveSession(session);
  const rawStory = await loadSavedStory(session);
  let htmlPath: string | undefined;
  let story: StoryV1 | undefined;
  if (rawStory !== null) {
    const storySnapshot = await resolveStorySnapshot(session, rawStory);
    story = validateStory(rawStory, storySnapshot);
    htmlPath = await saveHtml(session, renderReview(story, storySnapshot, snapshot));
  }
  return { session, snapshot, story, htmlPath };
}
