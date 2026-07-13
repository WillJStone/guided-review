import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { GuidedReviewError } from "./errors";
import { VERSION } from "./version";

const MANAGED_MARKER = "managed-by-guided-review";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export interface InstallSkillOptions {
  codexHome?: string;
  force: boolean;
  dryRun: boolean;
}

export async function installCodexSkill(options: InstallSkillOptions) {
  const source = path.resolve(import.meta.dir, "../skills/guided-code-review");
  if (!(await pathExists(path.join(source, "SKILL.md")))) throw new GuidedReviewError(`bundled skill was not found at ${source}`);
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
  const skillsRoot = path.join(codexHome, "skills");
  const destination = path.join(skillsRoot, "guided-code-review");
  let backup: string | undefined;
  let action: "install" | "update" = "install";
  if (await pathExists(destination)) {
    const existingSkill = path.join(destination, "SKILL.md");
    const managed = (await pathExists(existingSkill)) && (await readFile(existingSkill, "utf8")).includes(MANAGED_MARKER);
    if (!managed && !options.force) {
      throw new GuidedReviewError(
        `an unmanaged skill already exists at ${destination}; re-run with --force to preserve it as a timestamped backup`,
      );
    }
    action = "update";
    backup = `${destination}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
  if (!options.dryRun) {
    await mkdir(skillsRoot, { recursive: true });
    if (backup) await rename(destination, backup);
    try {
      await cp(source, destination, { recursive: true, force: false });
      if (backup && (await readFile(path.join(backup, "SKILL.md"), "utf8")).includes(MANAGED_MARKER)) {
        await rm(backup, { recursive: true, force: true });
        backup = undefined;
      }
    } catch (error) {
      if (backup) {
        if (await pathExists(destination)) await rm(destination, { recursive: true, force: true });
        await rename(backup, destination);
      }
      throw error;
    }
  }
  return { action, version: VERSION, source, destination, ...(backup ? { backup } : {}), dryRun: options.dryRun };
}
