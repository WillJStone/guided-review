import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { GuidedReviewError } from "./errors";
import { loadSession, readHtml } from "./session";
import { buildWorkflow, refreshWorkflow } from "./workflow";

export interface ServeOptions {
  host: string;
  port: number;
  open: boolean;
}

async function ephemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close();
        reject(new GuidedReviewError("failed to reserve a loopback port"));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function startReviewServer(directory: string, options: ServeOptions) {
  let session = await loadSession(directory);
  if (!session.htmlPath) {
    const built = await buildWorkflow(directory);
    session = built.session;
  }
  let refreshInFlight: Promise<unknown> | null = null;
  const port = options.port === 0 ? await ephemeralPort(options.host) : options.port;
  const server = Bun.serve({
    hostname: options.host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, session: session.id, snapshotId: session.currentSnapshotId });
      }
      if (request.method === "POST" && url.pathname === "/refresh") {
        try {
          refreshInFlight ??= refreshWorkflow(directory).finally(() => {
            refreshInFlight = null;
          });
          const result = await refreshInFlight;
          session = await loadSession(directory);
          const snapshot = (result as Awaited<ReturnType<typeof refreshWorkflow>>).snapshot;
          return json({ ok: true, snapshotId: snapshot.id, ...snapshot.totals });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: detail }, 500);
        }
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/review.html")) {
        try {
          session = await loadSession(directory);
          return new Response(await readHtml(session), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return new Response(detail, { status: 500 });
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const address = `http://${options.host}:${server.port}/`;
  if (options.open) openBrowser(address);
  return { server, address, session };
}

export function validateServeHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new GuidedReviewError("guided-review only serves on a loopback host");
  }
}
