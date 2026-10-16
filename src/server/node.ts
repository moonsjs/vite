import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 32 * 1024 * 1024; // batas defensif transport; limit RPC §7.3 tetap berlaku

/** Konversi request Node → Web `Request` (body diteruskan untuk non-GET/HEAD, §7.3). */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === "content-length") {
      // content-length tidak disalin; fetch menghitung ulang dari body.
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

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const body = await readBody(req);
  return new Request(url, { method, headers, body: new Uint8Array(body) });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body melebihi batas transport"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

/** Tulis Web `Response` ke `ServerResponse` Node. */
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
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}
