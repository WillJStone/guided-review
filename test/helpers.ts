import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SnapshotV1, StoryV1 } from "../src/types";

export function runGit(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function createFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "guided-review-test-repo-"));
  runGit(repo, "init", "-b", "main");
  runGit(repo, "config", "user.name", "Guided Review Test");
  runGit(repo, "config", "user.email", "guided-review@example.test");
  await writeFile(path.join(repo, "alpha.txt"), "alpha\n", "utf8");
  await writeFile(path.join(repo, "obsolete.txt"), "obsolete\n", "utf8");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "core.ts"), "export const value = 1;\n", "utf8");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "initial");
  return repo;
}

export async function cleanup(...directories: string[]): Promise<void> {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

export function makeStory(snapshot: SnapshotV1, mode: "originating" | "reconstructed" = "originating"): StoryV1 {
  const paths = snapshot.files.map((file) => file.path);
  return {
    schemaVersion: 1,
    snapshotId: snapshot.id,
    authorship: {
      mode,
      agent: "codex",
      disclosure: mode === "originating" ? "Authored by the implementing agent." : "Reconstructed from code and Git.",
    },
    title: "Fixture · Guided review",
    kicker: "A reviewer-first tour",
    headline: "Read the fixture in design order.",
    introduction: "The fixture proves snapshot, story, and render behavior together.",
    flow: [{ label: "Input", detail: "Changed files enter the review.", evidence: [paths[0]!] }],
    hotspots: [{ tone: "attention", label: "Fixture", text: "Check complete coverage.", evidence: [paths[0]!] }],
    stages: [
      {
        id: "implementation",
        eyebrow: "Core change",
        title: "Implementation",
        summary: "All changed files are grouped for this compact fixture.",
        reviewLens: ["Confirm the complete diff is present."],
        callouts: [{ tone: "good", label: "Coverage", text: "Every file is assigned once.", evidence: [paths[0]!] }],
        files: paths,
      },
    ],
    decisions: [{ label: "Approval", question: "Does the fixture prove the contract?", evidence: [paths[0]!] }],
  };
}

export function embeddedReviewData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("review data not found");
  return JSON.parse(match[1]);
}
