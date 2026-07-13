import type { SensitiveFinding } from "./types";

export class GuidedReviewError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = "GuidedReviewError";
  }
}

export class SensitiveDiffError extends GuidedReviewError {
  constructor(readonly findings: SensitiveFinding[]) {
    const locations = findings
      .map((finding) => `  ${finding.path}${finding.line === null ? "" : `:${finding.line}`} (${finding.kind})`)
      .join("\n");
    super(
      `suspected sensitive values were found; no review artifact was written:\n${locations}\nRe-run with --allow-sensitive only if embedding these values is intentional.`,
      3,
    );
    this.name = "SensitiveDiffError";
  }
}
