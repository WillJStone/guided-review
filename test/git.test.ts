import { afterEach, describe, expect, test } from "bun:test";
import { rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { SensitiveDiffError } from "../src/errors";
import { captureSnapshot } from "../src/git";
import { cleanup, createFixtureRepo, runGit } from "./helpers";

const garbage: string[] = [];
afterEach(async () => cleanup(...garbage.splice(0)));

const defaults = (repo: string) => ({
  repo,
  committedOnly: false,
  includeUntracked: true,
  excludes: [] as string[],
  allowSensitive: false,
});

describe("captureSnapshot", () => {
  test("captures modified, deleted, renamed, untracked, and symlink files", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "alpha changed\n", "utf8");
    await rename(path.join(repo, "src", "core.ts"), path.join(repo, "src", "engine.ts"));
    runGit(repo, "rm", "--cached", "src/core.ts");
    runGit(repo, "add", "src/engine.ts");
    await writeFile(path.join(repo, "new file.txt"), "new\n", "utf8");
    await writeFile(path.join(repo, "føø.ts"), "export const unicode = true;\n", "utf8");
    await writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    runGit(repo, "rm", "obsolete.txt");
    if (process.platform !== "win32") await symlink("alpha.txt", path.join(repo, "alpha-link"));

    const snapshot = await captureSnapshot(defaults(repo));
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
    expect(byPath.get("alpha.txt")?.status).toBe("modified");
    expect(byPath.get("alpha.txt")?.native).toMatchObject({ origin: "after", kind: "text", text: "alpha changed\n" });
    expect(byPath.get("src/engine.ts")?.status).toBe("renamed");
    expect(byPath.get("src/engine.ts")?.previousPath).toBe("src/core.ts");
    expect(byPath.get("new file.txt")?.status).toBe("added");
    expect(byPath.get("føø.ts")?.status).toBe("added");
    expect(byPath.get("obsolete.txt")?.status).toBe("deleted");
    expect(byPath.get("obsolete.txt")?.native).toMatchObject({ origin: "before", kind: "text", text: "obsolete\n" });
    expect(byPath.get("blob.bin")?.binary).toBe(true);
    expect(byPath.get("blob.bin")?.native).toMatchObject({ origin: "after", kind: "binary", bytes: 4 });
    if (process.platform !== "win32") expect(byPath.get("alpha-link")?.diff).toContain("new file mode 120000");
    expect(snapshot.totals.files).toBe(process.platform === "win32" ? 6 : 7);
  });

  test("uses a target merge-base and can ignore working-tree changes", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    runGit(repo, "checkout", "-b", "feature");
    await writeFile(path.join(repo, "alpha.txt"), "committed feature\n", "utf8");
    runGit(repo, "add", "alpha.txt");
    runGit(repo, "commit", "-m", "feature");
    await writeFile(path.join(repo, "working.txt"), "not committed\n", "utf8");

    const snapshot = await captureSnapshot({ ...defaults(repo), target: "main", committedOnly: true });
    expect(snapshot.scope.target).toBe("main");
    expect(snapshot.files.map((file) => file.path)).toEqual(["alpha.txt"]);
    expect(snapshot.files[0]?.native).toMatchObject({ origin: "after", kind: "text", text: "committed feature\n" });
  });

  test("records explicit exclusions", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "changed\n", "utf8");
    await writeFile(path.join(repo, "generated.log"), "generated\n", "utf8");
    const snapshot = await captureSnapshot({ ...defaults(repo), excludes: ["*.log"] });
    expect(snapshot.files.map((file) => file.path)).toEqual(["alpha.txt"]);
    expect(snapshot.scope.excludedFiles).toEqual(["generated.log"]);
  });

  test("blocks high-confidence credentials without writing their values to the error", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    const token = `ghp_${"A1".repeat(12)}`;
    await writeFile(path.join(repo, "secret.txt"), `${token}\n`, "utf8");
    try {
      await captureSnapshot(defaults(repo));
      throw new Error("expected capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SensitiveDiffError);
      expect(String(error)).toContain("secret.txt:1");
      expect(String(error)).not.toContain(token);
    }
    const allowed = await captureSnapshot({ ...defaults(repo), allowSensitive: true });
    expect(allowed.sensitiveOverride).toBe(true);
  });

  test("scans unchanged lines that become embedded in the native view", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    const token = `ghp_${"Z9".repeat(12)}`;
    await writeFile(path.join(repo, "alpha.txt"), `${token}\noriginal\n`, "utf8");
    runGit(repo, "add", "alpha.txt");
    runGit(repo, "commit", "-m", "fixture with existing credential");
    await writeFile(path.join(repo, "alpha.txt"), `${token}\nchanged\n`, "utf8");

    try {
      await captureSnapshot(defaults(repo));
      throw new Error("expected capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SensitiveDiffError);
      expect(String(error)).toContain("alpha.txt:1");
      expect(String(error)).not.toContain(token);
    }
  });
});
