import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { startReviewServer } from "../src/server";
import { buildWorkflow, snapshotWorkflow } from "../src/workflow";
import { cleanup, createFixtureRepo, makeStory } from "./helpers";

const garbage: string[] = [];
afterEach(async () => cleanup(...garbage.splice(0)));

describe("review server", () => {
  test("serves health, HTML, and refresh on loopback", async () => {
    const repo = await createFixtureRepo();
    garbage.push(repo);
    await writeFile(path.join(repo, "alpha.txt"), "served\n", "utf8");
    const created = await snapshotWorkflow({ repo, committedOnly: false, includeUntracked: true, excludes: [], allowSensitive: false, allowUnignoredOutput: false });
    garbage.push(created.session.directory);
    await writeFile(created.paths.story, JSON.stringify(makeStory(created.snapshot)), "utf8");
    await buildWorkflow(created.session.directory, created.paths.story);
    const { server, address } = await startReviewServer(created.session.directory, { host: "127.0.0.1", port: 0, open: false });
    try {
      expect(await (await fetch(`${address}health`)).json()).toMatchObject({ ok: true, snapshotId: created.snapshot.id });
      expect(await (await fetch(address)).text()).toContain("Guided review");
      expect(await (await fetch(`${address}refresh`, { method: "POST" })).json()).toMatchObject({ ok: true, files: 1 });
    } finally {
      server.stop(true);
    }
  });
});
