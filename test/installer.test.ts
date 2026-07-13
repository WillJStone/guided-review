import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { installCodexSkill } from "../src/installer";
import { cleanup } from "./helpers";

const garbage: string[] = [];
afterEach(async () => cleanup(...garbage.splice(0)));

describe("installCodexSkill", () => {
  test("installs and updates a managed skill", async () => {
    const codexHome = path.join(process.env.TMPDIR ?? "/tmp", `guided-review-codex-${crypto.randomUUID()}`);
    garbage.push(codexHome);
    const installed = await installCodexSkill({ codexHome, force: false, dryRun: false });
    expect(await readFile(path.join(installed.destination, "SKILL.md"), "utf8")).toContain("managed-by-guided-review");
    const updated = await installCodexSkill({ codexHome, force: false, dryRun: false });
    expect(updated.action).toBe("update");
    expect(updated.backup).toBeUndefined();
  });

  test("refuses unknown collisions and preserves them when forced", async () => {
    const codexHome = path.join(process.env.TMPDIR ?? "/tmp", `guided-review-codex-${crypto.randomUUID()}`);
    garbage.push(codexHome);
    const destination = path.join(codexHome, "skills", "guided-code-review");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), "unmanaged\n", "utf8");
    await expect(installCodexSkill({ codexHome, force: false, dryRun: false })).rejects.toThrow("unmanaged skill");
    const forced = await installCodexSkill({ codexHome, force: true, dryRun: false });
    expect(forced.backup).toBeDefined();
    expect(await readFile(path.join(forced.backup!, "SKILL.md"), "utf8")).toBe("unmanaged\n");
  });
});
