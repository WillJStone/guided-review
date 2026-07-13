#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run scripts/browser-smoke.ts <review.html>");
  process.exit(2);
}
const htmlPath = path.resolve(input);
await access(htmlPath);
const sourceHtml = await Bun.file(htmlPath).text();
const reviewMatch = sourceHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/);
if (!reviewMatch?.[1]) throw new Error("review data was not found in the HTML artifact");
const reviewData = JSON.parse(reviewMatch[1]) as {
  files: Record<string, { native?: { kind: string } }>;
};
const expectsMarkdown = Object.entries(reviewData.files).some(
  ([file, value]) => /\.(?:md|mdx)$/i.test(file) && value.native?.kind === "text",
);

const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean) as string[];
let chrome: string | undefined;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    chrome = candidate;
    break;
  }
}
if (!chrome) throw new Error("Chrome or Chromium is required for the browser smoke test");

for (const viewport of ["1440,1000", "390,844"]) {
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--window-size=${viewport}`,
      "--virtual-time-budget=1500",
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`browser failed at ${viewport}: ${result.stderr}`);
  const dom = result.stdout;
  if (!dom.includes('data-render-ready="true"')) {
    throw new Error(`review did not finish rendering at ${viewport}\n${result.stderr.slice(-4000)}\n${dom.slice(0, 1200)}`);
  }
  if (!dom.includes('data-horizontal-overflow="false"')) throw new Error(`review overflowed horizontally at ${viewport}`);
  if (!dom.includes('data-render-errors="0"')) throw new Error(`review raised a page error at ${viewport}`);
  if (!dom.includes('data-theme-switch="true"')) throw new Error(`theme switching failed at ${viewport}`);
  if (!dom.includes('data-section-collapse="true"')) throw new Error(`section collapsing failed at ${viewport}`);
  if (!dom.includes('data-reviewed-collapse="true"')) throw new Error(`reviewed sections did not collapse and reopen at ${viewport}`);
  if (!dom.includes('data-unicode-artifacts="0"')) throw new Error(`review displayed a Unicode escape artifact at ${viewport}`);
  if (!dom.includes('class="step"')) throw new Error(`review rendered no guided stages at ${viewport}`);
  if (!dom.includes('class="file-card')) throw new Error(`review rendered no file diffs at ${viewport}`);
  const nativeViews = Number(dom.match(/data-native-views="(\d+)"/)?.[1] ?? "0");
  if (nativeViews < 1) throw new Error(`review rendered no native source views at ${viewport}`);
  if (!dom.includes('data-native-switch="true"')) throw new Error(`native source switching failed at ${viewport}`);
  const markdownPreviews = Number(dom.match(/data-markdown-previews="(\d+)"/)?.[1] ?? "0");
  if (expectsMarkdown && markdownPreviews < 1) throw new Error(`review rendered no Markdown preview at ${viewport}`);
  if (expectsMarkdown && !dom.includes('data-preview-switch="true"')) throw new Error(`Markdown preview switching failed at ${viewport}`);
  if (!dom.includes('data-unsafe-preview-elements="0"')) throw new Error(`Markdown preview produced an unsafe element at ${viewport}`);
}

console.log(JSON.stringify({ ok: true, html: htmlPath, viewports: ["1440x1000", "390x844"] }));
