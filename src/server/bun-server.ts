import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { CLIENT_IP_HEADER, DEFAULT_BODY_LIMIT_BYTES, trailingSlashRedirect } from "@moonsjs/core";
import { contentTypeForPathname } from "./storage";
import {
  BodyLimitError,
  COMPRESSIBLE_FILE,
  DEFAULT_SECURITY_HEADERS,
  GZIP_MIN_BYTES,
  InvalidRequestError,
  MAX_TRANSPORT_BODY_BYTES,
  MIME_TYPES,
  RequestTimeoutError,
  acceptsGzipHeader,
  applyStaticHeaders,
  forwardedHost,
  forwardedProtocol,
  gzipCached,
  isAbortLike,
  readBodyWithLimit,
  requestTimeoutText,
  resolveClientIpValues,
  resolveStaticFile,
  rpcBodyTooLargeText,
  runHandlerWithTimeout,
  scheduleRevalidation,
  textResponseWithHeaders,
} from "./transport";
import { createLogger, type Logger } from "./logger";
import type { NodeServerOptions } from "./node-server";
import type { PluginRuntime } from "./plugins";

/**
 * Addendum Q (3B): host `Bun.serve` dengan perilaku paritas `node-server`:
 * static + storage/ISR + ETag/gzip + trailingSlash + body limit RPC +
 * header default + access log + drain SIGTERM. Dipilih otomatis oleh
 * `startServer` saat berjalan di Bun (override: `MOONS_SERVER=node|bun`).
 */

interface BunServerHandle {
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  if (existing !== null && existing.length > 0) {
    if (!existing.toLowerCase().includes(value)) {
      headers.set("vary", `${existing}, ${value}`);
    }
    return;
  }
  headers.set("vary", value);
}

/** J.7: response handler tanpa header default aman — mutasi langsung bila mungkin. */
function withDefaultSecurityHeaders(response: Response): Response {
  let missing = false;
  for (const name of Object.keys(DEFAULT_SECURITY_HEADERS)) {
    if (!response.headers.has(name)) {
      missing = true;
      break;
    }
  }
  if (!missing) {
    return response;
  }
  try {
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!response.headers.has(name)) {
        response.headers.set(name, value);
      }
    }
    return response;
  } catch {
    // Header immutable (mis. dari fetch) → bungkus ulang.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** J.1: URL dari Request Bun, mengikuti `x-forwarded-*` bila trustProxy aktif. */
function resolveBunUrl(request: Request, trustProxy: boolean): URL {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new InvalidRequestError(`invalid request URL: ${request.url}`);
  }
  if (!trustProxy) {
    return url;
  }
  const proto = forwardedProtocol(request.headers.get("x-forwarded-proto") ?? undefined);
  const host = forwardedHost(request.headers.get("x-forwarded-host") ?? undefined);
  if (proto === null && host === null) {
    return url;
  }
  // Bangun URL baru (bukan mutasi `.host`): setter `host` mempertahankan port
  // lama, sehingga `internal:3000` + `x-forwarded-host: app.example.com`
  // menghasilkan origin `https://app.example.com:3000` — origin RPC meleset.
  const effectiveProto = proto ?? (url.protocol === "https:" ? "https" : "http");
  const effectiveHost = host ?? url.host;
  try {
    return new URL(`${effectiveProto}://${effectiveHost}${url.pathname}${url.search}${url.hash}`);
  } catch {
    throw new InvalidRequestError(`invalid forwarded host: ${JSON.stringify(effectiveHost)}`);
  }
}

/** Request Web dengan body terbatas + `x-moons-client-ip` tepercaya (J.1/J.2). */
async function toBoundedRequest(
  request: Request,
  url: URL,
  clientIp: string | null,
  maxBodyBytes: number,
): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  if (clientIp !== null) {
    headers.set(CLIENT_IP_HEADER, clientIp);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return new Request(url, { method: request.method, headers });
  }
  const body = await readBodyWithLimit(request.body, maxBodyBytes);
  return new Request(url, { method: request.method, headers, body: body as unknown as BodyInit });
}

function installBunShutdown(
  server: BunServerHandle,
  options: { timeoutMs?: number; plugins?: PluginRuntime | undefined },
): (signal: string) => void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[moons] received ${signal} — no longer accepting connections, draining...`);
    const timer = setTimeout(() => {
      console.log(`[moons] drain exceeded ${timeoutMs}ms — forcing exit`);
      void server.stop(true).catch(() => {});
      process.exit(1);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    void (async () => {
      try {
        await server.stop(false);
      } catch (error) {
        clearTimeout(timer);
        console.log(
          `[moons] server close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
        return;
      }
      if (options.plugins !== undefined) {
        // Berbagi batas waktu dengan drain: timer di-ref kembali.
        (timer as { ref?: () => void }).ref?.();
        try {
          await options.plugins.shutdown();
        } catch (error) {
          console.log(`[moons] onShutdown failed: ${String(error)}`);
        }
      }
      clearTimeout(timer);
      console.log("[moons] shutdown complete (full drain)");
      process.exit(0);
    })();
  };
}

/**
 * Serve produksi dengan `Bun.serve` (Addendum Q). API yang sama dengan
 * `startNodeServer`; hanya tersedia di runtime Bun.
 */
export function startBunServer(
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions = {},
): BunServerHandle {
  if (typeof Bun === "undefined") {
    throw new Error("[moons] startBunServer requires the Bun runtime");
  }
  const clientDir = resolve(options.clientDir ?? join(process.cwd(), "dist/client"));
  const port = options.port ?? Number(process.env["PORT"] ?? 3000);
  const trustProxy = options.trustProxy === true;
  const requestTimeoutMs = options.requestTimeoutMs;
  // Addendum R: idleTimeout Bun diselaraskan dengan batas kita (+5 dtk grace)
  // supaya 504 dari framework yang menang, bukan koneksi diputus diam-diam.
  const idleTimeout =
    requestTimeoutMs === undefined || requestTimeoutMs <= 0
      ? 0
      : Math.ceil(requestTimeoutMs / 1000) + 5;
  const accessLogger: Logger | null =
    options.logging?.accessLog === true
      ? createLogger({
          json: options.logging.json !== false,
          redact: options.logging.redact ?? [],
        })
      : null;

  const serveStatic = async (
    request: Request,
    url: URL,
  ): Promise<Response | null> => {
    if (options.storage !== undefined) {
      // Addendum R (review G2): storage error = miss — aset & halaman non-ISR
      // harus tetap jalan saat store bersama outage.
      let entry: Awaited<ReturnType<NonNullable<typeof options.storage>["read"]>> | null = null;
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
        const headers = new Headers();
        headers.set("content-type", contentTypeForPathname(url.pathname));
        applyStaticHeaders(headers, url.pathname, options.headers);
        return new Response(
          request.method === "HEAD" ? null : (entry.body as unknown as BodyInit),
          { status: 200, headers },
        );
      }
      // L.2 (temuan F1): storage MISS → fallback `dist/client`; storage tetap menang.
    }
    const staticFile = resolveStaticFile(clientDir, url.pathname);
    if (staticFile === null) {
      return null;
    }
    const stat = statSync(staticFile);
    scheduleRevalidation({
      pathname: url.pathname,
      mtimeMs: stat.mtimeMs,
      file: staticFile,
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      handler,
      options,
      clientDir,
      logger: accessLogger,
    });
    const headers = new Headers();
    headers.set(
      "content-type",
      MIME_TYPES[extname(staticFile).toLowerCase()] ?? "application/octet-stream",
    );
    applyStaticHeaders(headers, url.pathname, options.headers);

    // K.5: ETag + 304.
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    headers.set("etag", etag);
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch !== null && ifNoneMatch.split(",").some((value) => value.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }

    // K.5: gzip untuk aset teks (cache per mtime).
    let payload: Uint8Array | null =
      request.method === "HEAD" ? null : readFileSync(staticFile);
    if (
      payload !== null &&
      COMPRESSIBLE_FILE.test(staticFile) &&
      payload.byteLength >= GZIP_MIN_BYTES &&
      acceptsGzipHeader(request.headers.get("accept-encoding"))
    ) {
      payload = gzipCached(staticFile, stat.mtimeMs, Buffer.from(payload));
      headers.set("content-encoding", "gzip");
      appendVaryHeader(headers, "accept-encoding");
    }
    return new Response(payload as unknown as BodyInit | null, { status: 200, headers });
  };

  const server = Bun.serve({
    port,
    idleTimeout,
    fetch: async (request, bunServer) => {
      const requestStartedAt = performance.now();
      let url: URL;
      try {
        url = resolveBunUrl(request, trustProxy);
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          console.warn(`[moons] ${error.message} — 400`);
          return textResponseWithHeaders(400, "Bad Request", options.headers);
        }
        throw error;
      }
      let clientIp: string | null = null;
      const finish = (response: Response): Response => {
        if (accessLogger !== null) {
          accessLogger({
            msg: "request",
            method: request.method,
            path: url.pathname + url.search,
            status: response.status,
            durationMs: Math.round(performance.now() - requestStartedAt),
            ...(clientIp === null ? {} : { ip: clientIp }),
          });
        }
        return response;
      };

      try {
        // M: kanonikalisasi trailing slash di transport (termasuk path prerender).
        if (options.trailingSlash !== undefined) {
          const canonical = trailingSlashRedirect(url.pathname, options.trailingSlash);
          if (canonical !== null) {
            url.pathname = canonical;
            return new Response(null, { status: 308, headers: { location: url.toString() } });
          }
        }

        if (request.method === "GET" || request.method === "HEAD") {
          const staticResponse = await serveStatic(request, url);
          if (staticResponse !== null) {
            return finish(staticResponse);
          }
        }

        // J.2: batas body RPC di transport — content-length diperiksa lebih dulu.
        const isRpc = url.pathname.startsWith("/_moons/fn/");
        const rpcLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
        if (isRpc) {
          const contentLength = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(contentLength) && contentLength > rpcLimit) {
            return finish(
              textResponseWithHeaders(413, rpcBodyTooLargeText(rpcLimit, contentLength), options.headers),
            );
          }
        }

        const remoteAddress = bunServer.requestIP(request)?.address ?? null;
        clientIp = resolveClientIpValues(
          request.headers.get("x-forwarded-for") ?? undefined,
          remoteAddress,
          trustProxy,
        );
        // Fast path: GET/HEAD tanpa rewrite URL & tanpa IP tepercaya → pakai
        // Request asli (menghindari rekonstruksi + salinan header per request).
        const needsRewrite = clientIp !== null || url.toString() !== request.url;
        const webRequest =
          (request.method === "GET" || request.method === "HEAD") && !needsRewrite
            ? request
            : await toBoundedRequest(
                request,
                url,
                clientIp,
                isRpc ? rpcLimit : MAX_TRANSPORT_BODY_BYTES,
              );
        // Addendum R: batas waktu eksplisit; 0/undefined = tanpa batas.
        const response = await runHandlerWithTimeout(handler, webRequest, requestTimeoutMs);
        return finish(withDefaultSecurityHeaders(response));
      } catch (error) {
        if (error instanceof BodyLimitError) {
          const isRpc = url.pathname.startsWith("/_moons/fn/");
          return finish(
            textResponseWithHeaders(
              413,
              isRpc ? rpcBodyTooLargeText(error.limit, null) : "Payload Too Large",
              options.headers,
            ),
          );
        }
        // Addendum R: timeout eksplisit — 504 + log terstruktur.
        if (error instanceof RequestTimeoutError) {
          if (accessLogger !== null) {
            accessLogger({
              msg: "request-timeout",
              level: "warn",
              method: request.method,
              path: url.pathname + url.search,
              limitMs: error.limit,
            });
          } else {
            console.warn(`[moons] request timed out after ${error.limit}ms — ${request.method} ${url.pathname}`);
          }
          return finish(textResponseWithHeaders(504, requestTimeoutText(error.limit), options.headers));
        }
        // Review G7: abort klien/koneksi putus bukan error server (tanpa stack).
        if (isAbortLike(error)) {
          if (accessLogger !== null) {
            accessLogger({
              msg: "request-aborted",
              level: "warn",
              method: request.method,
              path: url.pathname + url.search,
            });
          } else {
            console.warn(`[moons] request aborted by the client — ${request.method} ${url.pathname}`);
          }
          return new Response(null, { status: 499 });
        }
        console.error("[moons] server error:", error);
        return finish(textResponseWithHeaders(500, "Internal Server Error", options.headers));
      }
    },
  });

  // B.4: onStart sebelum log siap, onReady setelah server menerima koneksi.
  const listenAfterStart = (): void => {
    console.log(`[moons] server listening on http://localhost:${server.port}`);
    void options.plugins?.ready();
  };
  if (options.plugins !== undefined) {
    void options.plugins.start().then(listenAfterStart);
  } else {
    listenAfterStart();
  }

  if (options.handleSignals !== false) {
    const shutdown = installBunShutdown(server as unknown as BunServerHandle, {
      ...(options.shutdownTimeoutMs === undefined ? {} : { timeoutMs: options.shutdownTimeoutMs }),
      plugins: options.plugins,
    });
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }

  return server as unknown as BunServerHandle;
}
