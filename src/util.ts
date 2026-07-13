import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { GuidedReviewError } from "./errors";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeRepoPath(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

export function globMatches(value: string, pattern: string): boolean {
  const normalized = normalizeRepoPath(value);
  const source = normalizeRepoPath(pattern);
  let regex = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        regex += source[index + 1] === "/" ? "(?:.*/)?" : ".*";
        if (source[index + 1] === "/") index += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (character === "?") {
      regex += "[^/]";
    } else {
      regex += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`).test(normalized);
}

export function matchesAnyGlob(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatches(value, pattern));
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function writePrivateText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GuidedReviewError(`failed to read JSON from ${file}: ${detail}`);
  }
}

export function assertRecord(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GuidedReviewError(`${where} must be an object`);
  }
}

export function requireString(container: Record<string, unknown>, key: string, where: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GuidedReviewError(`${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

export function requireStringArray(value: unknown, where: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new GuidedReviewError(`${where} must be a list of non-empty strings`);
  }
  if (nonempty && value.length === 0) throw new GuidedReviewError(`${where} must not be empty`);
  return value.map((item) => (item as string).trim());
}

export function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "review";
}
