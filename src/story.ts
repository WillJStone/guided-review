import { GuidedReviewError } from "./errors";
import type {
  CalloutTone,
  EvidencePair,
  SnapshotV1,
  Staleness,
  StoryCallout,
  StoryDecision,
  StoryStage,
  StoryV1,
} from "./types";
import { STORY_SCHEMA_VERSION } from "./types";
import { assertRecord, normalizeRepoPath, requireString, requireStringArray } from "./util";

const VALID_TONES = new Set<CalloutTone>(["good", "attention", "risk", "question"]);
const VALID_MODES = new Set(["originating", "reconstructed"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function rejectUnknownKeys(container: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(container).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new GuidedReviewError(`${where} contains unknown fields: ${unknown.join(", ")}`);
}

function validateEvidence(value: unknown, where: string, known: Set<string>, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  const evidence = requireStringArray(value, where, required);
  if (new Set(evidence).size !== evidence.length) throw new GuidedReviewError(`${where} must not contain duplicate paths`);
  const unknown = evidence.map(normalizeRepoPath).filter((file) => !known.has(file));
  if (unknown.length > 0) throw new GuidedReviewError(`${where} references files outside the snapshot: ${unknown.join(", ")}`);
  return evidence.map(normalizeRepoPath);
}

function validateFlow(value: unknown, known: Set<string>): EvidencePair[] {
  if (!Array.isArray(value)) throw new GuidedReviewError("story.flow must be a list");
  return value.map((raw, index) => {
    const where = `story.flow[${index}]`;
    assertRecord(raw, where);
    rejectUnknownKeys(raw, ["label", "detail", "evidence"], where);
    const evidence = validateEvidence(raw.evidence, `${where}.evidence`, known);
    return {
      label: requireString(raw, "label", where),
      detail: requireString(raw, "detail", where),
      ...(evidence ? { evidence } : {}),
    };
  });
}

function validateCallouts(value: unknown, where: string, known: Set<string>): StoryCallout[] {
  if (!Array.isArray(value)) throw new GuidedReviewError(`${where} must be a list`);
  return value.map((raw, index) => {
    const location = `${where}[${index}]`;
    assertRecord(raw, location);
    rejectUnknownKeys(raw, ["tone", "label", "text", "evidence"], location);
    const tone = requireString(raw, "tone", location) as CalloutTone;
    if (!VALID_TONES.has(tone)) throw new GuidedReviewError(`${location}.tone must be one of ${[...VALID_TONES].join(", ")}`);
    return {
      tone,
      label: requireString(raw, "label", location),
      text: requireString(raw, "text", location),
      evidence: validateEvidence(raw.evidence, `${location}.evidence`, known, true)!,
    };
  });
}

function validateStages(value: unknown, known: Set<string>): StoryStage[] {
  if (!Array.isArray(value) || value.length === 0) throw new GuidedReviewError("story.stages must be a non-empty list");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const where = `story.stages[${index}]`;
    assertRecord(raw, where);
    rejectUnknownKeys(raw, ["id", "eyebrow", "title", "summary", "reviewLens", "callouts", "files"], where);
    const id = requireString(raw, "id", where);
    if (!ID_PATTERN.test(id)) throw new GuidedReviewError(`${where}.id must use lowercase letters, digits, and hyphens`);
    if (ids.has(id)) throw new GuidedReviewError(`duplicate stage id: ${id}`);
    ids.add(id);
    return {
      id,
      eyebrow: requireString(raw, "eyebrow", where),
      title: requireString(raw, "title", where),
      summary: requireString(raw, "summary", where),
      reviewLens: requireStringArray(raw.reviewLens, `${where}.reviewLens`, true),
      callouts: validateCallouts(raw.callouts, `${where}.callouts`, known),
      files: requireStringArray(raw.files, `${where}.files`, true).map(normalizeRepoPath),
    };
  });
}

function validateDecisions(value: unknown, known: Set<string>): StoryDecision[] {
  if (!Array.isArray(value)) throw new GuidedReviewError("story.decisions must be a list");
  return value.map((raw, index) => {
    const where = `story.decisions[${index}]`;
    assertRecord(raw, where);
    rejectUnknownKeys(raw, ["label", "question", "evidence"], where);
    const evidence = validateEvidence(raw.evidence, `${where}.evidence`, known);
    return {
      label: requireString(raw, "label", where),
      question: requireString(raw, "question", where),
      ...(evidence ? { evidence } : {}),
    };
  });
}

export function validateStory(value: unknown, snapshot: SnapshotV1): StoryV1 {
  assertRecord(value, "story");
  rejectUnknownKeys(
    value,
    ["schemaVersion", "snapshotId", "authorship", "title", "kicker", "headline", "introduction", "flow", "hotspots", "stages", "decisions"],
    "story",
  );
  if (value.schemaVersion !== STORY_SCHEMA_VERSION) throw new GuidedReviewError(`story.schemaVersion must be ${STORY_SCHEMA_VERSION}`);
  if (value.snapshotId !== snapshot.id) {
    throw new GuidedReviewError(`story.snapshotId ${String(value.snapshotId)} does not match snapshot ${snapshot.id}`);
  }
  assertRecord(value.authorship, "story.authorship");
  rejectUnknownKeys(value.authorship, ["mode", "agent", "disclosure"], "story.authorship");
  const mode = requireString(value.authorship, "mode", "story.authorship");
  if (!VALID_MODES.has(mode)) throw new GuidedReviewError("story.authorship.mode must be originating or reconstructed");
  const disclosure = value.authorship.disclosure;
  if (disclosure !== undefined && (typeof disclosure !== "string" || disclosure.trim() === "")) {
    throw new GuidedReviewError("story.authorship.disclosure must be a non-empty string when provided");
  }
  const known = new Set(snapshot.files.map((file) => file.path));
  const stages = validateStages(value.stages, known);
  const assigned = stages.flatMap((stage) => stage.files);
  const duplicates = [...new Set(assigned.filter((file, index) => assigned.indexOf(file) !== index))].sort();
  const missing = [...known].filter((file) => !assigned.includes(file)).sort();
  const unknown = [...new Set(assigned.filter((file) => !known.has(file)))].sort();
  if (duplicates.length || missing.length || unknown.length) {
    const details = [
      ...(duplicates.length ? [`assigned more than once: ${duplicates.join(", ")}`] : []),
      ...(missing.length ? [`changed but unassigned: ${missing.join(", ")}`] : []),
      ...(unknown.length ? [`assigned outside the snapshot: ${unknown.join(", ")}`] : []),
    ];
    throw new GuidedReviewError(`story does not exactly cover the snapshot:\n${details.join("\n")}`);
  }
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    snapshotId: snapshot.id,
    authorship: {
      mode: mode as StoryV1["authorship"]["mode"],
      agent: requireString(value.authorship, "agent", "story.authorship"),
      ...(typeof disclosure === "string" ? { disclosure: disclosure.trim() } : {}),
    },
    title: requireString(value, "title", "story"),
    kicker: requireString(value, "kicker", "story"),
    headline: requireString(value, "headline", "story"),
    introduction: requireString(value, "introduction", "story"),
    flow: validateFlow(value.flow, known),
    hotspots: validateCallouts(value.hotspots, "story.hotspots", known),
    stages,
    decisions: validateDecisions(value.decisions, known),
  };
}

export function storyTemplate(snapshot: SnapshotV1): Record<string, unknown> {
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    snapshotId: snapshot.id,
    authorship: {
      mode: "originating",
      agent: "codex",
      disclosure: "Replace with an honest description of how this story was authored.",
    },
    title: "",
    kicker: "A reviewer-first tour of the change",
    headline: "",
    introduction: "",
    flow: [],
    hotspots: [],
    stages: [],
    decisions: [],
  };
}

export function compareSnapshots(storySnapshot: SnapshotV1, currentSnapshot: SnapshotV1): Staleness {
  const original = new Map(storySnapshot.files.map((file) => [file.path, file]));
  const current = new Map(currentSnapshot.files.map((file) => [file.path, file]));
  const newFiles = [...current.keys()].filter((file) => !original.has(file)).sort();
  const revertedFiles = [...original.keys()].filter((file) => !current.has(file)).sort();
  const changedFiles = [...current.keys()]
    .filter((file) => original.has(file) && original.get(file)!.diffHash !== current.get(file)!.diffHash)
    .sort();
  return {
    stale: changedFiles.length > 0 || newFiles.length > 0 || revertedFiles.length > 0,
    changedFiles,
    newFiles,
    revertedFiles,
  };
}
