import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { cleanup, createFixtureRepo, makeStory } from "./helpers";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const garbage: string[] = [];
afterEach(async () => cleanup(...garbage.splice(0)));

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("CLI", () => {
  test("emits agent-readable snapshot and build output", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "CLI changed\n", "utf8");
    const snapshotResult = run("snapshot", "--repo", repo, "--json");
    expect(snapshotResult.status).toBe(0);
    const snapshotOutput = JSON.parse(snapshotResult.stdout);
    garbage.push(snapshotOutput.sessionDir);
    const snapshot = JSON.parse(await Bun.file(snapshotOutput.paths.snapshot).text());
    await writeFile(snapshotOutput.paths.story, JSON.stringify(makeStory(snapshot)), "utf8");

    const buildResult = run("build", "--session", snapshotOutput.sessionDir, "--story", snapshotOutput.paths.story, "--json");
    expect(buildResult.status).toBe(0);
    expect(JSON.parse(buildResult.stdout)).toMatchObject({ ok: true, snapshotId: snapshot.id });
  });

  test("emits structured errors for agents", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    const result = run("snapshot", "--repo", repo, "--json");
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: 2, error: "the selected diff contains no reviewable files" });
  });
});
