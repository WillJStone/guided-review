import { afterEach, describe, expect, test } from "bun:test";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { presentationDiff } from "../src/render";
import { buildWorkflow, refreshWorkflow, snapshotWorkflow } from "../src/workflow";
import { cleanup, createFixtureRepo, embeddedReviewData, makeStory, runGit } from "./helpers";

const garbage: string[] = [];
afterEach(async () => cleanup(...garbage.splice(0)));

describe("review workflow", () => {
  test("removes mechanical Git headers from the presented diff", () => {
    const raw = [
      "diff --git a/src/types.ts b/src/types.ts",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/src/types.ts",
      "@@ -0,0 +1,2 @@",
      "+export interface Example {",
      "+}",
      "",
    ].join("\n");

    expect(presentationDiff(raw)).toBe("@@ -0,0 +1,2 @@\n+export interface Example {\n+}\n");
  });

  test("refuses unignored persistent output inside the reviewed repository", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "changed\n", "utf8");
    await expect(
      snapshotWorkflow({
        repo,
        committedOnly: false,
        includeUntracked: true,
        excludes: [],
        allowSensitive: false,
        allowUnignoredOutput: false,
        outputDirectory: path.join(repo, ".guided-review"),
      }),
    ).rejects.toThrow("is not ignored");
  });

  test("refuses unignored output when the repository path uses a filesystem alias", async () => {
    const repo = await createFixtureRepo();
    const alias = `${repo}-alias`;
    garbage.push(repo, alias);
    await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(alias, "alpha.txt"), "changed\n", "utf8");
    await expect(
      snapshotWorkflow({
        repo: alias,
        committedOnly: false,
        includeUntracked: true,
        excludes: [],
        allowSensitive: false,
        allowUnignoredOutput: false,
        outputDirectory: path.join(alias, ".guided-review"),
      }),
    ).rejects.toThrow("is not ignored");
  });

  test("builds a complete offline review and marks refreshed prose stale", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "changed once\n", "utf8");
    const created = await snapshotWorkflow({
      repo,
      committedOnly: false,
      includeUntracked: true,
      excludes: [],
      allowSensitive: false,
      allowUnignoredOutput: false,
    });
    garbage.push(created.session.directory);
    const story = makeStory(created.snapshot);
    story.introduction = "A safe string containing </script><script>alert('nope')</script> markup.";
    story.headline = "Replacement tokens stay literal: $` $& $'";
    await writeFile(created.paths.story, `${JSON.stringify(story, null, 2)}\n`, "utf8");
    const built = await buildWorkflow(created.session.directory, created.paths.story);
    const initialHtml = await readFile(built.htmlPath, "utf8");
    const initial = embeddedReviewData(initialHtml);
    expect(initial.totals).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(initial.staleness).toEqual({ stale: false, changedFiles: [], newFiles: [], revertedFiles: [] });
    const initialFile = (initial.files as Record<string, { diff: string; displayDiff: string; native: unknown }>)["alpha.txt"]!;
    expect(initialFile.native).toMatchObject({
      origin: "after",
      kind: "text",
      text: "changed once\n",
    });
    expect(initialFile.diff).toContain("diff --git a/alpha.txt b/alpha.txt");
    expect(initialFile.displayDiff.startsWith("@@ ")).toBe(true);
    expect(initialFile.displayDiff).not.toContain("diff --git ");
    expect(initialFile.displayDiff).not.toContain("index ");
    expect(initialFile.displayDiff).not.toContain("--- a/");
    expect(initialFile.displayDiff).not.toContain("+++ b/");
    expect(initialHtml).not.toContain("</script><script>alert(");
    expect(initialHtml).toContain("\\u003c/script\\u003e");
    expect(initialHtml).not.toContain("\\u2192");
    expect(initialHtml).not.toContain("\\u2026");
    expect((initial as { headline: string }).headline).toBe("Replacement tokens stay literal: $` $& $'");

    await writeFile(path.join(repo, "alpha.txt"), "changed twice\n", "utf8");
    await writeFile(path.join(repo, "new.ts"), "export const newValue = true;\n", "utf8");
    const refreshed = await refreshWorkflow(created.session.directory);
    const refreshedData = embeddedReviewData(await readFile(refreshed.htmlPath!, "utf8"));
    expect(refreshedData.staleness).toEqual({ stale: true, changedFiles: ["alpha.txt"], newFiles: ["new.ts"], revertedFiles: [] });
    expect(refreshedData.unreviewedFiles).toEqual(["new.ts"]);
    expect(refreshedData.reviewId).toBe(initial.reviewId);

    await writeFile(path.join(repo, "alpha.txt"), "alpha\n", "utf8");
    await unlink(path.join(repo, "new.ts"));
    const reverted = await refreshWorkflow(created.session.directory);
    const revertedData = embeddedReviewData(await readFile(reverted.htmlPath!, "utf8"));
    expect(revertedData.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(revertedData.staleness).toEqual({ stale: true, changedFiles: [], newFiles: [], revertedFiles: ["alpha.txt"] });
  });

  test("refresh keeps the original base after HEAD advances", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "committed after snapshot\n", "utf8");
    const created = await snapshotWorkflow({
      repo,
      committedOnly: false,
      includeUntracked: true,
      excludes: [],
      allowSensitive: false,
      allowUnignoredOutput: false,
    });
    garbage.push(created.session.directory);
    const originalBase = created.snapshot.scope.baseOid;

    runGit(repo, "add", "alpha.txt");
    runGit(repo, "commit", "-m", "advance HEAD");
    const refreshed = await refreshWorkflow(created.session.directory);

    expect(refreshed.snapshot.scope.baseOid).toBe(originalBase);
    expect(refreshed.snapshot.scope.headOid).not.toBe(originalBase);
    expect(refreshed.snapshot.files.map((file) => file.path)).toEqual(["alpha.txt"]);
  });
});
