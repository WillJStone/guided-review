export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const STORY_SCHEMA_VERSION = 1 as const;
export const SESSION_SCHEMA_VERSION = 1 as const;

export type AuthorshipMode = "originating" | "reconstructed";
export type CalloutTone = "good" | "attention" | "risk" | "question";
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged";

export interface SnapshotNativeContent {
  origin: "before" | "after";
  kind: "text" | "binary" | "too-large" | "unavailable";
  bytes?: number;
  text?: string;
  reason?: string;
}

export interface SnapshotScope {
  requestedBase: string;
  baseOid: string;
  target?: string;
  headOid: string;
  committedOnly: boolean;
  includeUntracked: boolean;
  excludes: string[];
  excludedFiles: string[];
}

export interface SnapshotFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  diff: string;
  diffHash: string;
  binary: boolean;
  native?: SnapshotNativeContent;
}

export interface SnapshotV1 {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  repository: {
    root: string;
    name: string;
    branch: string;
  };
  scope: SnapshotScope;
  files: SnapshotFile[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
  };
  fingerprint: string;
  sensitiveOverride: boolean;
}

export interface EvidencePair {
  label: string;
  detail: string;
  evidence?: string[];
}

export interface StoryCallout {
  tone: CalloutTone;
  label: string;
  text: string;
  evidence: string[];
}

export interface StoryStage {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  reviewLens: string[];
  callouts: StoryCallout[];
  files: string[];
}

export interface StoryDecision {
  label: string;
  question: string;
  evidence?: string[];
}

export interface StoryV1 {
  schemaVersion: typeof STORY_SCHEMA_VERSION;
  snapshotId: string;
  authorship: {
    mode: AuthorshipMode;
    agent: string;
    disclosure?: string;
  };
  title: string;
  kicker: string;
  headline: string;
  introduction: string;
  flow: EvidencePair[];
  hotspots: StoryCallout[];
  stages: StoryStage[];
  decisions: StoryDecision[];
}

export interface ReviewSessionV1 {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  directory: string;
  repositoryRoot: string;
  snapshotOptions: {
    base?: string;
    target?: string;
    committedOnly: boolean;
    includeUntracked: boolean;
    excludes: string[];
    allowSensitive: boolean;
  };
  currentSnapshotId: string;
  storySnapshotId?: string;
  storyPath?: string;
  htmlPath?: string;
}

export interface Staleness {
  stale: boolean;
  changedFiles: string[];
  newFiles: string[];
  revertedFiles: string[];
}

export interface SensitiveFinding {
  path: string;
  line: number | null;
  kind: string;
}

export interface SnapshotOptions {
  repo: string;
  base?: string;
  target?: string;
  committedOnly: boolean;
  includeUntracked: boolean;
  excludes: string[];
  allowSensitive: boolean;
  allowEmpty?: boolean;
}
