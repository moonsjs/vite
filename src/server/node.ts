import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLIENT_IP_HEADER } from "@moonsjs/core";
import {
  BodyLimitError,
  DEFAULT_SECURITY_HEADERS,
  InvalidRequestError,
  MAX_TRANSPORT_BODY_BYTES,
  forwardedHost,
  forwardedProtocol,
  resolveClientIpValues,
  type ToWebRequestOptions,
} from "./transport";

// Kontrak lama tetap diekspor dari sini (test & pemakai lama).
export {
  BodyLimitError,
  DEFAULT_SECURITY_HEADERS,
  InvalidRequestError,
  MAX_TRANSPORT_BODY_BYTES,
} from "./transport";
export type { ToWebRequestOptions } from "./transport";

/**
 * Rekonstruksi URL request (Addendum J.1). Tanpa `trustProxy`, origin/host
 * murni dari header `Host` (perilaku lama, kebal spoofing `x-forwarded-*`).
 * Malformed → `InvalidRequestError` (server memetakan ke 400).
 */
export function resolveRequestUrl(
  req: IncomingMessage,
  options: ToWebRequestOptions = {},
): URL {
  const hostHeader = req.headers.host ?? "localhost";
  const trustProxy = options.trustProxy === true;
  const proto = trustProxy ? forwardedProtocol(req.headers["x-forwarded-proto"]) : null;
  const forwardedHostValue = trustProxy ? forwardedHost(req.headers["x-forwarded-host"]) : null;
  const host = forwardedHostValue ?? hostHeader;
  try {
    return new URL(`${proto ?? "http"}://${host}${req.url ?? "/"}`);
  } catch {
    throw new InvalidRequestError(`invalid Host header: ${JSON.stringify(hostHeader)}`);
  }
}

/** IP klien tepercaya (Addendum J.1): XFF (hanya bila trustProxy) → socket. */
export function resolveClientIp(req: IncomingMessage, trustProxy: boolean): string | null {
  return resolveClientIpValues(
    req.headers["x-forwarded-for"],
    req.socket?.remoteAddress ?? null,
    trustProxy,
  );
}

/** Konversi request Node → Web `Request` (body diteruskan untuk non-GET/HEAD, §7.3 + J.1/J.2). */
export async function toWebRequest(
  req: IncomingMessage,
  options: ToWebRequestOptions = {},
): Promise<Request> {
  const url = resolveRequestUrl(req, options);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === "content-length" || key === CLIENT_IP_HEADER) {
      // content-length tidak disalin; fetch menghitung ulang dari body.
      // x-moons-client-ip selalu ditimpa nilai tepercaya di bawah.
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const clientIp = resolveClientIp(req, options.trustProxy === true);
  if (clientIp !== null) {
    headers.set(CLIENT_IP_HEADER, clientIp);
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const body = await readBody(req, options.maxBodyBytes ?? MAX_TRANSPORT_BODY_BYTES);
  // View zero-copy (bukan salinan) — Buffer selalu di atas ArrayBuffer biasa.
  const view = new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  return new Request(url, { method, headers, body: view });
}

/**
 * Baca body dengan batas tegas (Addendum J.2): begitu melewati `maxBytes`,
 * pembacaan dihentikan (pause) dan `BodyLimitError` dilempar — tidak pernah
 * seluruh body besar masuk memori, dan hanya satu salinan buffer dibuat.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.pause();
      reject(error);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        fail(new BodyLimitError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolvePromise(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => fail(error));
  });
}

/** Tulis Web `Response` ke `ServerResponse` Node (streaming bila ada body). */
export async function sendNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // `set-cookie` ditangani terpisah: forEach menggabungkan nilai ganda
    // menjadi satu string (cookie kedua hilang — D.2).
    if (key === "set-cookie") {
      return;
    }
    res.setHeader(key, value);
  });
  const getSetCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(response.headers);
    if (cookies.length > 0) {
      res.setHeader("set-cookie", cookies);
    }
  } else {
    const single = response.headers.get("set-cookie");
    if (single !== null) {
      res.setHeader("set-cookie", single);
    }
  }

  for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!res.hasHeader(name)) {
      res.setHeader(name, value);
    }
  }

  if (response.body === null || res.req?.method === "HEAD") {
    res.end();
    return;
  }

  // Addendum J.2: stream langsung — tidak ada `arrayBuffer()` penuh di memori.
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    res,
  );
}
