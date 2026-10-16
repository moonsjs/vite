import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import {
  BodyLimitError,
  InvalidRequestError,
  readBody,
  resolveClientIp,
  resolveRequestUrl,
  toWebRequest,
} from "../src/server/node";

function fakeReq(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  remoteAddress?: string;
}): IncomingMessage {
  const stream = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  stream.method = init.method ?? "GET";
  stream.url = init.url ?? "/";
  stream.headers = init.headers ?? {};
  Object.assign(stream, { socket: { remoteAddress: init.remoteAddress ?? "127.0.0.1" } });
  if (init.body !== undefined) {
    stream.end(init.body);
  } else {
    stream.end();
  }
  return stream as unknown as IncomingMessage;
}

test("J.1: tanpa trustProxy, URL memakai Host header (x-forwarded-* diabaikan)", () => {
  const url = resolveRequestUrl(
    fakeReq({
      url: "/users/1?q=x",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example.com",
      },
    }),
  );
  expect(url.toString()).toBe("http://app.example.com/users/1?q=x");
});

test("J.1: trustProxy memakai x-forwarded-proto/host untuk URL + origin", () => {
  const url = resolveRequestUrl(
    fakeReq({
      url: "/_moons/fn/abc",
      headers: {
        host: "internal:3000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com",
      },
    }),
    { trustProxy: true },
  );
  expect(url.protocol).toBe("https:");
  expect(url.host).toBe("app.example.com");
  expect(`${url.protocol}//${url.host}`).toBe("https://app.example.com");
});

test("J.1: nilai x-forwarded-* tidak valid diabaikan (fallback Host)", () => {
  const url = resolveRequestUrl(
    fakeReq({
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "ftp",
        "x-forwarded-host": "evil host/path",
      },
    }),
    { trustProxy: true },
  );
  expect(url.toString()).toBe("http://app.example.com/");
});

test("J.1/J.4: Host malformed → InvalidRequestError (dipetakan 400)", () => {
  expect(() => resolveRequestUrl(fakeReq({ headers: { host: "bad host" } }))).toThrow(
    InvalidRequestError,
  );
});

test("J.1: x-moons-client-ip selalu ditimpa — nilai klien dibuang", async () => {
  const request = await toWebRequest(
    fakeReq({
      headers: { host: "app.example.com", "x-moons-client-ip": "6.6.6.6" },
      remoteAddress: "127.0.0.1",
    }),
  );
  expect(request.headers.get("x-moons-client-ip")).toBe("127.0.0.1");
});

test("J.1: trustProxy memakai entri pertama x-forwarded-for (divalidasi)", () => {
  const request = resolveClientIp(
    fakeReq({
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      remoteAddress: "10.0.0.1",
    }),
    true,
  );
  expect(request).toBe("203.0.113.9");

  const spoof = resolveClientIp(
    fakeReq({
      headers: { "x-forwarded-for": "bukan-ip<script>" },
      remoteAddress: "10.0.0.1",
    }),
    true,
  );
  expect(spoof).toBe("10.0.0.1");
});

test("J.1: remoteAddress IPv4-mapped dinormalisasi", () => {
  const ip = resolveClientIp(fakeReq({ remoteAddress: "::ffff:127.0.0.1" }), false);
  expect(ip).toBe("127.0.0.1");
});

test("J.2: readBody berhenti dini saat melewati batas (tidak menunggu end)", async () => {
  const chunk = Buffer.alloc(64, 1);
  const stream = new PassThrough();
  stream.write(chunk);
  stream.write(chunk);
  stream.write(chunk); // 192 byte > 128

  await expect(readBody(stream as unknown as IncomingMessage, 128)).rejects.toBeInstanceOf(
    BodyLimitError,
  );
});

test("J.2: readBody di bawah batas mengembalikan isi utuh", async () => {
  const body = await readBody(fakeReq({ body: Buffer.from("halo") }), 1024);
  expect(body.toString()).toBe("halo");
});

test("J.2: toWebRequest meneruskan body dengan batas RPC kecil", async () => {
  const request = await toWebRequest(
    fakeReq({
      method: "POST",
      url: "/_moons/fn/x",
      headers: { host: "app.example.com" },
      body: Buffer.alloc(2048, 7),
    }),
    { maxBodyBytes: 1024 },
  ).catch((error: unknown) => error);
  expect(request).toBeInstanceOf(BodyLimitError);
  expect((request as BodyLimitError).limit).toBe(1024);
});
