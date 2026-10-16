import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { VIRTUAL_MODULES } from "../virtual-modules";
import type { PayloadScanOptions } from "../payload-scan";
import type { PluginRuntime } from "./plugins";
import type { Shell } from "./shell";
import { createDevShell } from "./shell";
import { sendNodeResponse, toWebRequest } from "./node";

interface DevApp {
  handler: (request: Request) => Promise<Response>;
  plugins: PluginRuntime;
}

type DevServerEntry = {
  createDevApp: (
    shell: Shell,
    payloadScan?: import("../payload-scan").PayloadScanOptions,
  ) => DevApp;
};

/**
 * Middleware SSR dev: dipasang sebelum middleware internal Vite, menangani
 * request HTML dan RPC serverFn (`/_moons/fn/*`) — modul/aset tetap Vite.
 * Handler + lifecycle plugin (Addendum B.4) diinisialisasi sekali.
 */
export function installDevMiddleware(
  server: ViteDevServer,
  options: { templatePath: string; payloadScan?: PayloadScanOptions; apiPrefix?: string },
): void {
  let appPromise: Promise<DevApp> | null = null;

  const getApp = (): Promise<DevApp> => {
    if (appPromise === null) {
      appPromise = (async () => {
        const entry = (await server.ssrLoadModule(VIRTUAL_MODULES.serverEntry)) as DevServerEntry;
        const app = entry.createDevApp(createDevShell(server, options), options.payloadScan);
        await app.plugins.start();
        await app.plugins.ready();
        return app;
      })();
    }
    return appPromise;
  };

  server.httpServer?.once("close", () => {
    void appPromise?.then((app) => app.plugins.shutdown());
  });

  server.middlewares.use((req, res, next) => {
    if (!shouldHandle(req, options.apiPrefix)) {
      next();
      return;
    }
    void handleRequest(getApp, req, res).catch((error: unknown) => {
      next(error as Error);
    });
  });
}

async function handleRequest(
  getApp: () => Promise<DevApp>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getApp();
  const response = await app.handler(await toWebRequest(req));
  await sendNodeResponse(res, response);
}

function shouldHandle(req: IncomingMessage, apiPrefix: string | undefined): boolean {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // RPC serverFn (semua method): dulu hanya GET/HEAD HTML yang dirutekan,
  // sehingga `POST /_moons/fn/<hash>` jatuh ke Vite ("Cannot POST", 404) dan
  // serverFn tidak bisa dipakai di dev (temuan eval T2 ronde 2; decisions/0016).
  if (path.startsWith("/_moons/fn/")) {
    return true;
  }

  // Addendum D.1: endpoint `src/api` (semua method) dirutekan ke runtime.
  if (apiPrefix !== undefined && (path === apiPrefix || path.startsWith(`${apiPrefix}/`))) {
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  if (path.startsWith("/@") || path.startsWith("/node_modules/") || path.startsWith("/__")) {
    return false;
  }
  const lastSegment = path.split("/").pop() ?? "";
  if (lastSegment.includes(".")) {
    return false;
  }
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}
