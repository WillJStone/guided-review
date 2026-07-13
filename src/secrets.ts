import path from "node:path";

import type { SensitiveFinding, SnapshotV1 } from "./types";

interface SecretPattern {
  kind: string;
  expression: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { kind: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { kind: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", expression: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "OpenAI-style API key", expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { kind: "Slack token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    kind: "credential assignment",
    expression: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{24,}/i,
  },
];

function isSensitiveFilename(file: string): boolean {
  const name = path.posix.basename(file).toLowerCase();
  if ([".env.example", ".env.sample", ".env.template"].includes(name)) return false;
  return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".pypirc";
}

function addedLines(diff: string): Array<{ line: number | null; text: string }> {
  const result: Array<{ line: number | null; text: string }> = [];
  let newLine: number | null = null;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) {
      result.push({ line: newLine, text: raw.slice(1) });
      if (newLine !== null) newLine += 1;
    } else if (!raw.startsWith("-") && newLine !== null) {
      newLine += 1;
    }
  }
  return result;
}

function nativeLines(text: string): Array<{ line: number; text: string }> {
  return text.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line }));
}

export function scanSnapshotForSecrets(snapshot: SnapshotV1): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const file of snapshot.files) {
    if (isSensitiveFilename(file.path)) findings.push({ path: file.path, line: null, kind: "sensitive filename" });
    const lines = file.native?.kind === "text" && file.native.text !== undefined ? nativeLines(file.native.text) : addedLines(file.diff);
    for (const added of lines) {
      for (const pattern of PATTERNS) {
        pattern.expression.lastIndex = 0;
        if (pattern.expression.test(added.text)) {
          findings.push({ path: file.path, line: added.line, kind: pattern.kind });
          break;
        }
      }
    }
  }
  const unique = new Map(findings.map((finding) => [`${finding.path}:${finding.line}:${finding.kind}`, finding]));
  return [...unique.values()];
}
