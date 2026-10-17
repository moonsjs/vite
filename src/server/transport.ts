import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { MoonsError, type PrerenderStorage } from "@moonsjs/core";
import { revalidatePrerendered, shouldRevalidate } from "./isr";
import type { Logger } from "./logger";

/**
 * Addendum Q (3B): bagian transport yang tidak bergantung runtime — dipakai
 * `node-server` dan `bun-server` agar paritas bukan duplikasi.
 */

/** Batas transport default (Addendum J.2); RPC punya batas lebih kecil dari config. */
export const MAX_TRANSPORT_BODY_BYTES = 32 * 1024 * 1024;

/** Request tidak valid (Host/URL malformed) → dipetakan ke 400 oleh server. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** Body melebihi batas → dipetakan ke 413; pembacaan dihentikan saat melewati. */
export class BodyLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`request body exceeds the ${limit} byte limit`);
    this.name = "BodyLimitError";
    this.limit = limit;
  }
}

export interface ToWebRequestOptions {
  /** Addendum J.1: percayai `x-forwarded-proto`/`x-forwarded-host` (default false). */
  trustProxy?: boolean;
  /** Batas pembacaan body (byte). Default: `MAX_TRANSPORT_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** Addendum S: header tepercaya untuk IP klien (default `x-forwarded-for`). */
  clientIpHeader?: string;
}

/** Addendum J.7: default aman runtime; `config.headers` tetap menang (cek `has`). */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return null;
  }
  const first = raw.split(",")[0]?.trim() ?? "";
  return first.length === 0 ? null : first;
}

export function forwardedProtocol(
  value: string | string[] | undefined,
): "http" | "https" | null {
  const first = firstHeaderValue(value)?.toLowerCase() ?? null;
  if (first === "https") {
    return "https";
  }
  if (first === "http") {
    return "http";
  }
  return null;
}

export function forwardedHost(value: string | string[] | undefined): string | null {
  const first = firstHeaderValue(value);
  if (first === null || first.length === 0 || first.length > 255) {
    return null;
  }
  // hostname[:port] — tolak karakter di luar himpunan aman (spasi, CRLF, /, @, ?).
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(first)) {
    return null;
  }
  return first;
}

function isPlausibleIp(value: string): boolean {
  return value.length <= 64 && /^[0-9a-fA-F:.]+$/.test(value);
}

function stripZoneId(value: string): string {
  const index = value.indexOf("%");
  return index === -1 ? value : value.slice(0, index);
}

/** `::ffff:127.0.0.1` → `127.0.0.1`; buang zone id (`%eth0`). */
function normalizeIp(value: string): string {
  const withoutZone = stripZoneId(value);
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

/**
 * IP klien tepercaya (Addendum J.1) dari nilai header mentah — inti yang sama
 * untuk Node (`IncomingMessage`) dan Bun (`Request` + `server.requestIP`).
 */
export function resolveClientIpValues(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | null,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const forwarded = firstHeaderValue(forwardedFor);
    if (forwarded !== null && isPlausibleIp(forwarded)) {
      return normalizeIp(forwarded);
    }
  }
  return remoteAddress === null ? null : normalizeIp(remoteAddress);
}

export const MIME_TYPES: Record<string, string> = {
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
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

export const COMPRESSIBLE_FILE = /\.(js|mjs|css|html|json|svg|txt|map|xml)$/i;
export const GZIP_MIN_BYTES = 1024;
const GZIP_CACHE_MAX = 64;
const gzipCache = new Map<string, { mtimeMs: number; gzip: Buffer }>();

/** Varian gzip ter-cache per file+mtime (bounded FIFO) — Addendum K.5. */
export function gzipCached(file: string, mtimeMs: number, body: Buffer): Buffer {
  const cached = gzipCache.get(file);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.gzip;
  }
  const gzip = gzipSync(body);
  if (gzipCache.size >= GZIP_CACHE_MAX) {
    const oldest = gzipCache.keys().next().value;
    if (oldest !== undefined) {
      gzipCache.delete(oldest);
    }
  }
  gzipCache.set(file, { mtimeMs, gzip });
  return gzip;
}

export function acceptsGzipHeader(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  return value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "gzip" || part === "*" || part.startsWith("gzip;"));
}

/** 413 transport dengan format §15 yang sama seperti `rpc.ts` (Addendum J.2). */
export function rpcBodyTooLargeText(limit: number, size: number | null): string {
  const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);
  return new MoonsError({
    code: "E_RPC_BODY_TOO_LARGE",
    message:
      size === null
        ? `body exceeds the ${megabytes(limit)} MB limit`
        : `body ${megabytes(size)} MB exceeds the ${megabytes(limit)} MB limit`,
    details:
      "Body exceeds `security.bodyLimitBytes`; reading stops at the transport before the body is fully buffered.",
    suggestions: [
      "Reduce the payload size, or",
      "Increase security.bodyLimitBytes if you really need to",
    ],
  }).format();
}

/** Handler melewati `requestTimeoutMs` → transport menjawab 504 (Addendum R). */
export class RequestTimeoutError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`handler did not respond within ${limit} ms`);
    this.name = "RequestTimeoutError";
    this.limit = limit;
  }
}

/** 504 dengan format §15 (dipakai kedua transport). */
export function requestTimeoutText(limit: number): string {
  return new MoonsError({
    code: "E_REQUEST_TIMEOUT",
    message: `handler did not respond within ${limit} ms`,
    details:
      "The transport stopped waiting for the handler and answered 504. " +
      "The handler keeps running until it settles; JavaScript cannot cancel it.",
    suggestions: [
      "Make the handler faster, or move slow work out of the request path",
      "Raise `requestTimeoutMs`, or set it to 0 to disable the timeout",
    ],
  }).format();
}

/**
 * Jalankan handler dengan batas waktu eksplisit (Addendum R; review G1).
 * `timeoutMs` undefined/0 → tanpa batas (perilaku lama).
 */
export async function runHandlerWithTimeout(
  handler: (request: Request) => Promise<Response>,
  request: Request,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return handler(request);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([handler(request), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Klasifikasi abort klien / koneksi putus (review G7) — bukan error server. */
export function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }
    const code = (error as { code?: unknown }).code;
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      return true;
    }
    const message = error.message.toLowerCase();
    return message === "aborted" || message.includes("aborted") || message.includes("premature close");
  }
  return false;
}

/** Respons teks transport (400/413/500/504) — tetap membawa header config + default aman (review G6). */
export function textResponseWithHeaders(
  status: number,
  text: string,
  configured?: Record<string, string>,
): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  applyStaticHeaders(headers, "/", configured);
  return new Response(text, { status, headers });
}

/**
 * Addendum T (G4): `Range` single-range untuk file statik.
 * `null` = tidak ada/format tidak didukung (sajikan penuh 200);
 * `"unsatisfiable"` = 416; `partial` = 206 dengan `content-range`.
 */
export type RangeResult =
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" }
  | null;

export function parseRangeHeader(value: string | null, size: number): RangeResult {
  if (value === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null) {
    // Multi-range atau unit lain → abaikan (sajikan penuh).
    return null;
  }
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") {
    return null;
  }
  if (rawStart === "") {
    // Suffix: `bytes=-N` → N byte terakhir.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    if (size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  // Cek "tak terpuaskan" SEBELUM validasi start>end: `bytes=99-` dengan
  // size kecil menghasilkan start>end karena end default size-1.
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  if (start > end) {
    return null;
  }
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

/** Target header minimal yang dipenuhi `ServerResponse` dan `Headers`. */
export interface HeaderTarget {
  has(name: string): boolean;
  set(name: string, value: string): void;
}

/**
 * Addendum J.7: header konfigurasi (menang), default aman, dan
 * `Cache-Control: immutable` untuk aset ber-hash di `/assets/*`.
 */
export function applyStaticHeaders(
  target: HeaderTarget,
  pathname: string,
  configured: Record<string, string> | undefined,
): void {
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!target.has(name)) {
      target.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!target.has(name)) {
      target.set(name, value);
    }
  }
  if (pathname.startsWith("/assets/") && !target.has("cache-control")) {
    target.set("cache-control", "public, max-age=31536000, immutable");
  }
}

/**
 * Baca body Web stream dengan batas tegas (Addendum J.2): begitu melewati
 * `maxBytes`, pembacaan dihentikan dan `BodyLimitError` dilempar.
 */
export async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        size += value.byteLength;
        if (size > maxBytes) {
          throw new BodyLimitError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream sudah selesai/tertutup — abaikan
    }
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

export function readPrerenderManifest(clientDir: string): PrerenderManifestInfo {
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
export function scheduleRevalidation(input: {
  pathname: string;
  mtimeMs: number;
  file?: string;
  storage?: PrerenderStorage;
  handler: (request: Request) => Promise<Response>;
  options: { canary?: string };
  clientDir: string;
  logger?: Logger | null;
}): void {
  const normalized = input.pathname.length > 1 ? input.pathname.replace(/\/+$/, "") : input.pathname;
  const seconds = readPrerenderManifest(input.clientDir).revalidate.get(normalized);
  if (seconds === undefined || seconds < 0) {
    return;
  }
  if (!shouldRevalidate({ mtimeMs: input.mtimeMs, revalidateSeconds: seconds })) {
    return;
  }
  const regeneratedAt = performance.now();
  const logger = input.logger ?? null;
  void revalidatePrerendered({
    pathname: normalized,
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.storage === undefined ? {} : { storage: input.storage }),
    handler: input.handler,
    ...(input.options.canary === undefined ? {} : { canary: input.options.canary }),
    env: process.env,
  })
    .then(() => {
      logger?.({
        msg: "isr:regenerated",
        path: normalized,
        durationMs: Math.round(performance.now() - regeneratedAt),
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (logger !== null) {
        logger({ msg: "isr:revalidate-failed", level: "warn", path: normalized, error: message });
      } else {
        console.error(`[moons] isr regeneration failed (${normalized}): ${message}`);
      }
    });
}
