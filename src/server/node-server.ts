import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { revalidatePrerendered, shouldRevalidate } from "./isr";
import { sendNodeResponse, toWebRequest } from "./node";
import type { PluginRuntime } from "./plugins";
import { installGracefulShutdown } from "./shutdown";

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export interface NodeServerOptions {
  port?: number;
  clientDir?: string;
  /** Pasang handler SIGTERM/SIGINT (default true). */
  handleSignals?: boolean;
  /** Batas drain shutdown (default 10_000 ms). */
  shutdownTimeoutMs?: number;
  /** Lifecycle plugin (Addendum B.4) — onStart/onReady/onShutdown. */
  plugins?: PluginRuntime;
  /** Canary `leakTest.canary` untuk guard ISR (Addendum E.1). */
  canary?: string;
  /**
   * Header statis dari config (Addendum H). Diterapkan juga pada file
   * prerender yang disajikan langsung (static host memakai `_headers`).
   */
  headers?: Record<string, string>;
}

/**
 * Serve produksi (M1 §19.2, §18): static dari `dist/client` + handler SSR.
 * Berjalan di Bun dan Node (hanya API `node:*`).
 */
export function startNodeServer(
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions = {},
): Server {
  const clientDir = resolve(options.clientDir ?? join(process.cwd(), "dist/client"));
  const port = options.port ?? Number(process.env["PORT"] ?? 3000);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        if (req.method === "GET" || req.method === "HEAD") {
          const staticFile = resolveStaticFile(clientDir, url.pathname);
          if (staticFile !== null) {
            scheduleRevalidation(staticFile, url.pathname, handler, options, clientDir);
            const body = readFileSync(staticFile);
            res.statusCode = 200;
            res.setHeader("content-type", MIME_TYPES[extname(staticFile).toLowerCase()] ?? "application/octet-stream");
            for (const [name, value] of Object.entries(options.headers ?? {})) {
              if (!res.hasHeader(name)) {
                res.setHeader(name, value);
              }
            }
            res.end(req.method === "HEAD" ? undefined : body);
            return;
          }
        }

        const response = await handler(await toWebRequest(req));
        await sendNodeResponse(res, response);
      } catch (error) {
        console.error("[moons] server error:", error);
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      }
    })();
  });

  // Addendum B.4: onStart sebelum listen, onReady setelah listen.
  const listenAfterStart = (): void => {
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      console.log(`[moons] server listening on http://localhost:${boundPort}`);
      void options.plugins?.ready();
    });
  };
  if (options.plugins !== undefined) {
    void options.plugins.start().then(listenAfterStart);
  } else {
    listenAfterStart();
  }

  if (options.handleSignals !== false) {
    const shutdown = installGracefulShutdown(server, {
      ...(options.shutdownTimeoutMs === undefined ? {} : { timeoutMs: options.shutdownTimeoutMs }),
      ...(options.plugins === undefined
        ? {}
        : { onShutdown: () => options.plugins?.shutdown() }),
    });
    // `once`: sinyal kedua memakai perilaku default (proses langsung berhenti).
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }

  return server;
}

/** Resolve file static dengan proteksi path traversal (+ manifest prerender D.5). */
export function resolveStaticFile(clientDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // 1) File persis (aset: js/css/png/…, atau HTML yang diminta eksplisit).
  const exact = safeWithin(clientDir, `.${decoded}`);
  if (exact !== null && isFile(exact)) {
    return exact;
  }

  // 2) Hasil prerender: hanya path yang tercatat di manifest yang dilayani
  //    statis — bukan shell `index.html` biasa (yang berarti bypass SSR).
  const normalized = decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
  const manifest = readPrerenderManifest(clientDir);
  if (manifest.paths.has(normalized)) {
    const target = normalized === "/" ? "index.html" : `${normalized.slice(1)}/index.html`;
    const candidate = safeWithin(clientDir, `./${target}`);
    if (candidate !== null && isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function safeWithin(clientDir: string, relative: string): string | null {
  const candidate = resolve(clientDir, relative);
  if (candidate !== clientDir && !candidate.startsWith(clientDir + sep)) {
    return null;
  }
  return candidate;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export interface PrerenderManifestInfo {
  paths: Set<string>;
  revalidate: Map<string, number>;
}

let prerenderManifestCache:
  | { file: string; mtimeMs: number; info: PrerenderManifestInfo }
  | null = null;

function readPrerenderManifest(clientDir: string): PrerenderManifestInfo {
  const file = join(clientDir, "_moons_prerender.json");
  const empty: PrerenderManifestInfo = { paths: new Set(), revalidate: new Map() };
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (
      prerenderManifestCache !== null &&
      prerenderManifestCache.file === file &&
      prerenderManifestCache.mtimeMs === mtimeMs
    ) {
      return prerenderManifestCache.info;
    }
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      paths?: unknown;
      version?: unknown;
      entries?: unknown;
    };
    const paths = new Set<string>();
    const revalidate = new Map<string, number>();
    if (Array.isArray(json.paths)) {
      // Manifest v1 (D.5) — tanpa revalidate.
      for (const path of json.paths) {
        if (typeof path === "string") {
          paths.add(path);
        }
      }
    }
    if (Array.isArray(json.entries)) {
      // Manifest v2 (E.1).
      for (const entry of json.entries as Array<Record<string, unknown>>) {
        if (entry === null || typeof entry !== "object" || typeof entry["path"] !== "string") {
          continue;
        }
        const path = entry["path"] as string;
        paths.add(path);
        const seconds = entry["revalidate"];
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
          revalidate.set(path, seconds);
        }
      }
    }
    const info = { paths, revalidate };
    prerenderManifestCache = { file, mtimeMs, info };
    return info;
  } catch {
    return empty;
  }
}

/** ISR: jika file prerender kedaluwarsa, regenerasi background (SWR). */
function scheduleRevalidation(
  staticFile: string,
  pathname: string,
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions,
  clientDir: string,
): void {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const seconds = readPrerenderManifest(clientDir).revalidate.get(normalized);
  if (seconds === undefined || seconds < 0) {
    return;
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(staticFile).mtimeMs;
  } catch {
    return;
  }
  if (!shouldRevalidate({ mtimeMs, revalidateSeconds: seconds })) {
    return;
  }
  void revalidatePrerendered({
    pathname: normalized,
    file: staticFile,
    handler,
    ...(options.canary === undefined ? {} : { canary: options.canary }),
  });
}

