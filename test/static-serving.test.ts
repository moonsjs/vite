import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { startNodeServer } from "@moonsjs/vite/server";

const BIG_JS = `// payload\n${"const value = 1;\n".repeat(200)}`;

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-static-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.js"), BIG_JS);
  writeFileSync(join(dir, "small.txt"), "kecil");
  return dir;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("K.5: ETag + gzip cache + 304 pada file statis", async () => {
  const server = startNodeServer(async () => new Response("handler", { status: 404 }), {
    port: 0,
    clientDir: makeClientDir(),
    handleSignals: false,
  });
  const port = await listen(server);
  try {
    // 1) Tanpa Accept-Encoding: body utuh, ETag ada, tanpa gzip.
    const plain = await httpGet(port, "/assets/app.js");
    expect(plain.status).toBe(200);
    expect(plain.body.toString()).toBe(BIG_JS);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const etag = plain.headers["etag"];
    expect(typeof etag).toBe("string");

    // 2) Accept-Encoding gzip: varian gzip (lebih kecil), vary mencatat.
    const gzipped = await httpGet(port, "/assets/app.js", { "accept-encoding": "gzip" });
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(String(gzipped.headers["vary"])).toContain("accept-encoding");
    expect(gunzipSync(gzipped.body).toString()).toBe(BIG_JS);
    expect(gzipped.body.byteLength).toBeLessThan(plain.body.byteLength);

    // 3) If-None-Match dengan ETag: 304 tanpa body.
    const notModified = await httpGet(port, "/assets/app.js", {
      "if-none-match": String(etag),
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body.byteLength).toBe(0);

    // 4) File kecil (< ambang) tidak dikompresi.
    const small = await httpGet(port, "/small.txt", { "accept-encoding": "gzip" });
    expect(small.status).toBe(200);
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.body.toString()).toBe("kecil");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
