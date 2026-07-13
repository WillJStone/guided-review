import { describe, expect, test } from "bun:test";

import { compareSnapshots, validateStory } from "../src/story";
import type { SnapshotV1 } from "../src/types";
import { makeStory } from "./helpers";

const snapshot: SnapshotV1 = {
  schemaVersion: 1,
  id: "snapshot-1",
  createdAt: new Date(0).toISOString(),
  repository: { root: "/tmp/repo", name: "repo", branch: "feature" },
  scope: { requestedBase: "HEAD", baseOid: "a".repeat(40), headOid: "b".repeat(40), committedOnly: false, includeUntracked: true, excludes: [], excludedFiles: [] },
  files: [
    { path: "a.ts", status: "modified", additions: 1, deletions: 1, diff: "diff a", diffHash: "hash-a", binary: false },
    { path: "b.ts", status: "added", additions: 2, deletions: 0, diff: "diff b", diffHash: "hash-b", binary: false },
  ],
  totals: { files: 2, additions: 3, deletions: 1 },
  fingerprint: "fingerprint",
  sensitiveOverride: false,
};

describe("validateStory", () => {
  test("accepts exact file coverage", () => {
    expect(validateStory(makeStory(snapshot), snapshot).stages[0]?.files).toEqual(["a.ts", "b.ts"]);
  });

  test("rejects missing and duplicate assignments", () => {
    const missing = makeStory(snapshot);
    missing.stages[0]!.files = ["a.ts"];
    expect(() => validateStory(missing, snapshot)).toThrow("changed but unassigned: b.ts");

    const duplicate = makeStory(snapshot);
    duplicate.stages.push({ ...duplicate.stages[0]!, id: "second", files: ["a.ts"] });
    expect(() => validateStory(duplicate, snapshot)).toThrow("assigned more than once: a.ts");
  });

  test("rejects unknown evidence and unknown fields", () => {
    const badEvidence = makeStory(snapshot);
    badEvidence.hotspots[0]!.evidence = ["outside.ts"];
    expect(() => validateStory(badEvidence, snapshot)).toThrow("outside the snapshot");

    const extra = { ...makeStory(snapshot), invented: true };
    expect(() => validateStory(extra, snapshot)).toThrow("unknown fields: invented");
  });
});

describe("compareSnapshots", () => {
  test("does not mark identical diff content stale when snapshot identity changes", () => {
    const relocated = {
      ...snapshot,
      id: "snapshot-from-another-path",
      repository: { ...snapshot.repository, root: "/tmp/relocated-repo" },
    };

    expect(compareSnapshots(snapshot, relocated)).toEqual({
      stale: false,
      changedFiles: [],
      newFiles: [],
      revertedFiles: [],
    });
  });
});
