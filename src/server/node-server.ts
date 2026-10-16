import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_BODY_LIMIT_BYTES, MoonsError, type PrerenderStorage } from "@moonsjs/core";
import { revalidatePrerendered, shouldRevalidate } from "./isr";
import { contentTypeForPathname } from "./storage";
import {
  BodyLimitError,
  DEFAULT_SECURITY_HEADERS,
  InvalidRequestError,
  resolveRequestUrl,
  sendNodeResponse,
  toWebRequest,
} from "./node";
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
  /**
   * Storage bersama untuk file prerender (Addendum I, ISR multi-instance).
   * Bila diisi, penyajian file prerender dan penulisan hasil regenerasi
   * memakai storage ini; default: file sistem lokal.
   */
  storage?: PrerenderStorage;
  /** Addendum J.1: percayai `x-forwarded-proto`/`x-forwarded-host` (default false). */
  trustProxy?: boolean;
  /** Addendum J.2: batas body RPC di transport (default `DEFAULT_BODY_LIMIT_BYTES`). */
  bodyLimitBytes?: number;
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
      let url: URL;
      try {
        // Addendum J.1: URL/Origin mengikuti `x-forwarded-*` bila trustProxy aktif;
        // request malformed → 400 (bukan 500 + stack).
        url = resolveRequestUrl(req, { trustProxy: options.trustProxy === true });
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          console.warn(`[moons] ${error.message} — 400`);
          respondBadRequest(res);
          return;
        }
        throw error;
      }

      try {
        if (req.method === "GET" || req.method === "HEAD") {
          // Addendum I: storage bersama (bila dikonfigurasi) menggantikan file lokal.
          if (options.storage !== undefined) {
            const entry = await options.storage.read(url.pathname);
            if (entry !== null) {
              scheduleRevalidation({
                pathname: url.pathname,
                mtimeMs: entry.mtimeMs,
                storage: options.storage,
                handler,
                options,
                clientDir,
              });
              res.statusCode = 200;
              res.setHeader("content-type", contentTypeForPathname(url.pathname));
              applyStaticHeaders(res, url.pathname, options.headers);
              res.end(req.method === "HEAD" ? undefined : Buffer.from(entry.body));
              return;
            }
          } else {
            const staticFile = resolveStaticFile(clientDir, url.pathname);
            if (staticFile !== null) {
              scheduleRevalidation({
                pathname: url.pathname,
                mtimeMs: statSync(staticFile).mtimeMs,
                file: staticFile,
                handler,
                options,
                clientDir,
              });
              const body = readFileSync(staticFile);
              res.statusCode = 200;
              res.setHeader("content-type", MIME_TYPES[extname(staticFile).toLowerCase()] ?? "application/octet-stream");
              applyStaticHeaders(res, url.pathname, options.headers);
              res.end(req.method === "HEAD" ? undefined : body);
              return;
            }
          }
        }

        // Addendum J.2: batas body RPC ditegakkan di transport — lebih awal dari
        // pipeline, tanpa membaca penuh; `content-length` diperiksa lebih dulu.
        const isRpc = url.pathname.startsWith("/_moons/fn/");
        const rpcLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
        if (isRpc) {
          const contentLength = Number(req.headers["content-length"] ?? "0");
          if (Number.isFinite(contentLength) && contentLength > rpcLimit) {
            res.statusCode = 413;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end(rpcBodyTooLargeText(rpcLimit, contentLength));
            res.once("finish", () => req.destroy());
            return;
          }
        }

        const request = await toWebRequest(req, {
          trustProxy: options.trustProxy === true,
          ...(isRpc ? { maxBodyBytes: rpcLimit } : {}),
        });
        const response = await handler(request);
        await sendNodeResponse(res, response);
      } catch (error) {
        if (error instanceof BodyLimitError) {
          const isRpc = url.pathname.startsWith("/_moons/fn/");
          res.statusCode = 413;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(isRpc ? rpcBodyTooLargeText(error.limit, null) : "Payload Too Large");
          // Sisa body tidak perlu dibaca — putuskan setelah respons terkirim.
          res.once("finish", () => req.destroy());
          return;
        }
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

/**
 * Addendum J.7: header konfigurasi (menang), default aman, dan
 * `Cache-Control: immutable` untuk aset ber-hash di `/assets/*`.
 */
function applyStaticHeaders(
  res: import("node:http").ServerResponse,
  pathname: string,
  configured: Record<string, string> | undefined,
): void {
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!res.hasHeader(name)) {
      res.setHeader(name, value);
    }
  }
  for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!res.hasHeader(name)) {
      res.setHeader(name, value);
    }
  }
  if (pathname.startsWith("/assets/") && !res.hasHeader("cache-control")) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  }
}

function respondBadRequest(res: import("node:http").ServerResponse): void {
  res.statusCode = 400;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Bad Request");
}

/** 413 transport dengan format §15 yang sama seperti `rpc.ts` (Addendum J.2). */
function rpcBodyTooLargeText(limit: number, size: number | null): string {
  const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);
  return new MoonsError({
    code: "E_RPC_BODY_TOO_LARGE",
    message:
      size === null
        ? `body melebihi limit ${megabytes(limit)} MB`
        : `body ${megabytes(size)} MB melebihi limit ${megabytes(limit)} MB`,
    details:
      "Body melebihi `security.bodyLimitBytes`; pembacaan dihentikan di transport sebelum penuh.",
    suggestions: [
      "Kurangi ukuran payload, atau",
      "Naikkan security.bodyLimitBytes jika memang perlu",
    ],
  }).format();
}

/** Resolve file static dengan proteksi path traversal (+ manifest prerender D.5). */
export function resolveStaticFile(clientDir: string, pathname: string): string | null {
  const target = staticFileTarget(clientDir, pathname);
  return target !== null && isFile(target) ? target : null;
}

/**
 * Target file untuk `pathname` (tanpa cek keberadaan) — dipakai penyajian,
 * `createFileStorage().write`, dan test. Proteksi path traversal tetap.
 */
export function staticFileTarget(clientDir: string, pathname: string): string | null {
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
    return safeWithin(clientDir, `./${target}`);
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
function scheduleRevalidation(input: {
  pathname: string;
  mtimeMs: number;
  file?: string;
  storage?: PrerenderStorage;
  handler: (request: Request) => Promise<Response>;
  options: NodeServerOptions;
  clientDir: string;
}): void {
  const normalized = input.pathname.length > 1 ? input.pathname.replace(/\/+$/, "") : input.pathname;
  const seconds = readPrerenderManifest(input.clientDir).revalidate.get(normalized);
  if (seconds === undefined || seconds < 0) {
    return;
  }
  if (!shouldRevalidate({ mtimeMs: input.mtimeMs, revalidateSeconds: seconds })) {
    return;
  }
  void revalidatePrerendered({
    pathname: normalized,
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.storage === undefined ? {} : { storage: input.storage }),
    handler: input.handler,
    ...(input.options.canary === undefined ? {} : { canary: input.options.canary }),
    env: process.env,
  });
}

