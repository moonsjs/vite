import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { VIRTUAL_MODULES } from "../virtual-modules";
import type { PayloadScanOptions } from "../payload-scan";
import type { PluginRuntime } from "./plugins";
import type { Shell } from "./shell";
import { createDevShell } from "./shell";
import {
  BodyLimitError,
  InvalidRequestError,
  resolveRequestUrl,
  sendNodeResponse,
  toWebRequest,
} from "./node";
import { DEFAULT_BODY_LIMIT_BYTES } from "@moonsjs/core";
import {
  RequestTimeoutError,
  applyStaticHeaders,
  requestTimeoutText,
  runHandlerWithTimeout,
} from "./transport";
import { emptyDevtoolsData, renderDevtoolsHtml, type DevtoolsData } from "../devtools";

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
  options: {
    templatePath: string;
    payloadScan?: PayloadScanOptions;
    apiPrefix?: string;
    /** Addendum J.1: paritas dev dengan produksi (trustProxy/bodyLimitBytes). */
    trustProxy?: boolean;
    bodyLimitBytes?: number;
    /** Addendum R: batas waktu respons (ms); 0/undefined = tanpa batas. */
    requestTimeoutMs?: number;
    /** Addendum I.4: datasource devtools overlay (dipanggil per request). */
    devtools?: () => DevtoolsData;
  },
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
    // Addendum I.4 (W4): overlay dev-only — selalu data segar per request.
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      new URL(req.url ?? "/", "http://localhost").pathname === "/__moons/devtools"
    ) {
      try {
        const data = options.devtools?.() ?? emptyDevtoolsData();
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(req.method === "HEAD" ? undefined : renderDevtoolsHtml(data));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`[moons] devtools failed to render: ${String(error)}`);
      }
      return;
    }

    if (!shouldHandle(req, options.apiPrefix)) {
      next();
      return;
    }
    void handleRequest(getApp, req, res, options).catch((error: unknown) => {
      if (error instanceof InvalidRequestError) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Bad Request");
        return;
      }
      if (error instanceof BodyLimitError) {
        res.statusCode = 413;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Payload Too Large");
        res.once("finish", () => req.destroy());
        return;
      }
      next(error as Error);
    });
  });
}

async function handleRequest(
  getApp: () => Promise<DevApp>,
  req: IncomingMessage,
  res: ServerResponse,
  options: { trustProxy?: boolean; bodyLimitBytes?: number; requestTimeoutMs?: number },
): Promise<void> {
  const app = await getApp();
  const url = resolveRequestUrl(req, { trustProxy: options.trustProxy === true });
  const isRpc = url.pathname.startsWith("/_moons/fn/");
  const request = await toWebRequest(req, {
    trustProxy: options.trustProxy === true,
    ...(isRpc ? { maxBodyBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES } : {}),
  });
  // Addendum R: paritas dev — batas waktu eksplisit yang sama dengan produksi.
  let response: Response;
  try {
    response = await runHandlerWithTimeout(app.handler, request, options.requestTimeoutMs);
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      res.statusCode = 504;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      applyStaticHeaders(
        { has: (name) => res.hasHeader(name), set: (name, value) => res.setHeader(name, value) },
        "/",
        undefined,
      );
      res.end(requestTimeoutText(error.limit));
      return;
    }
    throw error;
  }
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

  // Addendum O: health check (semua method) — paritas 405 dengan produksi.
  if (path === "/_moons/health") {
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
