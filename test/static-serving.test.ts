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

function makePrerenderedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-static-m-"));
  mkdirSync(join(dir, "about"), { recursive: true });
  writeFileSync(join(dir, "about", "index.html"), "ABOUT-PAGE");
  writeFileSync(
    join(dir, "_moons_prerender.json"),
    JSON.stringify({ version: 2, entries: [{ path: "/about" }] }),
  );
  return dir;
}

test("M: node-server — trailingSlash mencakup path prerender (never & always)", async () => {
  const handler = async (): Promise<Response> => new Response("handler", { status: 404 });

  const neverServer = startNodeServer(handler, {
    port: 0,
    clientDir: makePrerenderedDir(),
    handleSignals: false,
    trailingSlash: "never",
  });
  const neverPort = await listen(neverServer);
  try {
    const redirect = await httpGet(neverPort, "/about/");
    expect(redirect.status).toBe(308);
    expect(String(redirect.headers["location"])).toBe(`http://127.0.0.1:${neverPort}/about`);

    const ok = await httpGet(neverPort, "/about");
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe("ABOUT-PAGE");
  } finally {
    await new Promise<void>((resolve) => neverServer.close(() => resolve()));
  }

  const alwaysServer = startNodeServer(handler, {
    port: 0,
    clientDir: makePrerenderedDir(),
    handleSignals: false,
    trailingSlash: "always",
  });
  const alwaysPort = await listen(alwaysServer);
  try {
    const redirect = await httpGet(alwaysPort, "/about");
    expect(redirect.status).toBe(308);
    expect(String(redirect.headers["location"])).toBe(`http://127.0.0.1:${alwaysPort}/about/`);

    const ok = await httpGet(alwaysPort, "/about/");
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe("ABOUT-PAGE");
  } finally {
    await new Promise<void>((resolve) => alwaysServer.close(() => resolve()));
  }
});

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
