import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  trailingSlashRedirect,
  type PrerenderStorage,
} from "@moonsjs/core";
import { contentTypeForPathname } from "./storage";
import {
  BodyLimitError,
  COMPRESSIBLE_FILE,
  GZIP_MIN_BYTES,
  InvalidRequestError,
  MIME_TYPES,
  RequestTimeoutError,
  acceptsGzipHeader,
  applyStaticHeaders,
  gzipCached,
  isAbortLike,
  requestTimeoutText,
  resolveStaticFile,
  rpcBodyTooLargeText,
  runHandlerWithTimeout,
  scheduleRevalidation,
} from "./transport";
import {
  resolveClientIp,
  resolveRequestUrl,
  sendNodeResponse,
  toWebRequest,
} from "./node";
import { createLogger, type Logger } from "./logger";
import type { PluginRuntime } from "./plugins";
import { installGracefulShutdown } from "./shutdown";

// Kontrak lama tetap diekspor dari sini (index.ts & test lama).
export { resolveStaticFile, staticFileTarget } from "./transport";
export type { PrerenderManifestInfo } from "./transport";

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
  /** Addendum L.3: log akses terstruktur (default senyap). */
  logging?: { accessLog?: boolean; json?: boolean; redact?: string[] };
  /** Addendum M: kebijakan trailing slash (juga untuk path prerender/static). */
  trailingSlash?: "never" | "always";
  /** Addendum R: batas waktu respons handler (ms); `0` menonaktifkan. */
  requestTimeoutMs?: number;
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

  const accessLogger: Logger | null =
    options.logging?.accessLog === true
      ? createLogger({
          json: options.logging.json !== false,
          redact: options.logging.redact ?? [],
        })
      : null;

  const server = createServer((req, res) => {
    const requestStartedAt = performance.now();
    if (accessLogger !== null) {
      res.once("finish", () => {
        const ip = resolveClientIp(req, options.trustProxy === true);
        accessLogger({
          msg: "request",
          method: req.method ?? "GET",
          path: req.url ?? "/",
          status: res.statusCode,
          durationMs: Math.round(performance.now() - requestStartedAt),
          ...(ip === null ? {} : { ip }),
        });
      });
    }
    void (async () => {
      let url: URL;
      try {
        // Addendum J.1: URL/Origin mengikuti `x-forwarded-*` bila trustProxy aktif;
        // request malformed → 400 (bukan 500 + stack).
        url = resolveRequestUrl(req, { trustProxy: options.trustProxy === true });
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          console.warn(`[moons] ${error.message} — 400`);
          respondText(res, 400, "Bad Request", options.headers);
          return;
        }
        throw error;
      }

      try {
        // Addendum M: kanonikalisasi trailing slash di transport — mencakup
        // path prerender yang dilayani langsung (tidak lewat handler).
        if (options.trailingSlash !== undefined) {
          const canonical = trailingSlashRedirect(url.pathname, options.trailingSlash);
          if (canonical !== null) {
            url.pathname = canonical;
            res.statusCode = 308;
            res.setHeader("location", url.toString());
            res.end();
            return;
          }
        }

        if (req.method === "GET" || req.method === "HEAD") {
          // Addendum I: storage bersama (bila dikonfigurasi) diutamakan.
          if (options.storage !== undefined) {
            // Addendum R (review G2): storage error = miss — aset & halaman
            // non-ISR harus tetap jalan saat store bersama outage.
            let entry: Awaited<ReturnType<PrerenderStorage["read"]>> | null = null;
            try {
              entry = await options.storage.read(url.pathname);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (accessLogger !== null) {
                accessLogger({ msg: "isr:storage-read-failed", level: "warn", path: url.pathname, error: message });
              } else {
                console.warn(`[moons] isr storage read failed (${url.pathname}): ${message} — falling back to dist/client`);
              }
            }
            if (entry !== null) {
              scheduleRevalidation({
                pathname: url.pathname,
                mtimeMs: entry.mtimeMs,
                storage: options.storage,
                handler,
                options,
                clientDir,
                logger: accessLogger,
              });
              res.statusCode = 200;
              res.setHeader("content-type", contentTypeForPathname(url.pathname));
              applyStaticHeaders(
                { has: (name) => res.hasHeader(name), set: (name, value) => res.setHeader(name, value) },
                url.pathname,
                options.headers,
              );
              res.end(req.method === "HEAD" ? undefined : Buffer.from(entry.body));
              return;
            }
            // L.2 (temuan F1): storage MISS → jatuh ke file `dist/client`
            // (aset/non-ISR); storage tetap menang untuk path yang dimilikinya.
          }
          {
            const staticFile = resolveStaticFile(clientDir, url.pathname);
            if (staticFile !== null) {
              scheduleRevalidation({
                pathname: url.pathname,
                mtimeMs: statSync(staticFile).mtimeMs,
                file: staticFile,
                // Bila storage dikonfigurasi, hasil regenerasi (walau fallback
                // dari file) tetap ditulis ke storage bersama (L.2).
                ...(options.storage === undefined ? {} : { storage: options.storage }),
                handler,
                options,
                clientDir,
                logger: accessLogger,
              });
              const body = readFileSync(staticFile);
              const stat = statSync(staticFile);
              res.statusCode = 200;
              res.setHeader("content-type", MIME_TYPES[extname(staticFile).toLowerCase()] ?? "application/octet-stream");
              applyStaticHeaders(
                { has: (name) => res.hasHeader(name), set: (name, value) => res.setHeader(name, value) },
                url.pathname,
                options.headers,
              );

              // Addendum K.5: ETag + 304.
              const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
              res.setHeader("etag", etag);
              const ifNoneMatch = req.headers["if-none-match"];
              if (
                typeof ifNoneMatch === "string" &&
                ifNoneMatch.split(",").some((value) => value.trim() === etag)
              ) {
                res.statusCode = 304;
                res.end();
                return;
              }

              // Addendum K.5: gzip untuk aset teks (cache per mtime).
              let payload: Buffer = body;
              const encodings = req.headers["accept-encoding"];
              const acceptsGzip = acceptsGzipHeader(
                Array.isArray(encodings) ? (encodings[0] ?? null) : (encodings ?? null),
              );
              if (
                req.method === "GET" &&
                COMPRESSIBLE_FILE.test(staticFile) &&
                body.byteLength >= GZIP_MIN_BYTES &&
                acceptsGzip
              ) {
                payload = gzipCached(staticFile, stat.mtimeMs, body);
                res.setHeader("content-encoding", "gzip");
                appendVary(res, "accept-encoding");
              }
              res.end(req.method === "HEAD" ? undefined : payload);
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
            respondText(res, 413, rpcBodyTooLargeText(rpcLimit, contentLength), options.headers);
            res.once("finish", () => req.destroy());
            return;
          }
        }

        const request = await toWebRequest(req, {
          trustProxy: options.trustProxy === true,
          ...(isRpc ? { maxBodyBytes: rpcLimit } : {}),
        });
        // Addendum R: batas waktu eksplisit; 0/undefined = tanpa batas.
        const response = await runHandlerWithTimeout(handler, request, options.requestTimeoutMs);
        await sendNodeResponse(res, response);
      } catch (error) {
        if (error instanceof BodyLimitError) {
          const isRpc = url.pathname.startsWith("/_moons/fn/");
          respondText(
            res,
            413,
            isRpc ? rpcBodyTooLargeText(error.limit, null) : "Payload Too Large",
            options.headers,
          );
          // Sisa body tidak perlu dibaca — putuskan setelah respons terkirim.
          res.once("finish", () => req.destroy());
          return;
        }
        // Addendum R: timeout eksplisit — 504 + log terstruktur.
        if (error instanceof RequestTimeoutError) {
          if (accessLogger !== null) {
            accessLogger({
              msg: "request-timeout",
              level: "warn",
              method: req.method ?? "GET",
              path: url.pathname + url.search,
              limitMs: error.limit,
            });
          } else {
            console.warn(`[moons] request timed out after ${error.limit}ms — ${req.method ?? "GET"} ${url.pathname}`);
          }
          respondText(res, 504, requestTimeoutText(error.limit), options.headers);
          return;
        }
        // Review G7: abort klien/koneksi putus bukan error server (tanpa stack).
        if (isAbortLike(error)) {
          if (accessLogger !== null) {
            accessLogger({
              msg: "request-aborted",
              level: "warn",
              method: req.method ?? "GET",
              path: url.pathname + url.search,
            });
          } else {
            console.warn(`[moons] request aborted by the client — ${req.method ?? "GET"} ${url.pathname}`);
          }
          if (!res.headersSent && !res.writableEnded) {
            respondText(res, 499, "Client Closed Request", options.headers);
          }
          return;
        }
        console.error("[moons] server error:", error);
        respondText(res, 500, "Internal Server Error", options.headers);
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

function appendVary(res: import("node:http").ServerResponse, value: string): void {
  const existing = res.getHeader("vary");
  if (typeof existing === "string" && existing.length > 0) {
    if (!existing.toLowerCase().includes(value)) {
      res.setHeader("vary", `${existing}, ${value}`);
    }
    return;
  }
  res.setHeader("vary", value);
}

/** Respons teks transport — ikut membawa header config + default aman (review G6). */
function respondText(
  res: import("node:http").ServerResponse,
  status: number,
  text: string,
  configured: Record<string, string> | undefined,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  applyStaticHeaders(
    { has: (name) => res.hasHeader(name), set: (name, value) => res.setHeader(name, value) },
    "/",
    configured,
  );
  res.end(text);
}
