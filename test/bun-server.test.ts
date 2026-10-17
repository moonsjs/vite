import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { startBunServer } from "@moonsjs/vite/server";

/**
 * Addendum Q (3B): paritas `Bun.serve` untuk permukaan yang diuji di
 * `static-serving.test.ts` (static, ETag/304, gzip, trailingSlash, handler,
 * RPC 413) — kontrak yang sama, transport berbeda.
 */

const BIG_JS = `// payload\n${"const value = 1;\n".repeat(200)}`;

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-bun-static-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.js"), BIG_JS);
  writeFileSync(join(dir, "small.txt"), "kecil");
  return dir;
}

function makePrerenderedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-bun-prerender-"));
  mkdirSync(join(dir, "about"), { recursive: true });
  writeFileSync(join(dir, "about", "index.html"), "ABOUT-PAGE");
  writeFileSync(
    join(dir, "_moons_prerender.json"),
    JSON.stringify({ version: 2, entries: [{ path: "/about" }] }),
  );
  return dir;
}

function baseUrl(server: { port: number }): string {
  return `http://127.0.0.1:${server.port}`;
}

test("Q: bun-server — static + default headers + immutable cache + ETag/304", async () => {
  const handler = async (): Promise<Response> => new Response("handler");
  const server = startBunServer(handler, {
    port: 0,
    clientDir: makeClientDir(),
    handleSignals: false,
  });
  try {
    const first = await fetch(`${baseUrl(server)}/assets/app.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    await first.arrayBuffer();

    const second = await fetch(`${baseUrl(server)}/assets/app.js`, {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("Q: bun-server — gzip untuk aset teks + HEAD tanpa body", async () => {
  const handler = async (): Promise<Response> => new Response("handler");
  const server = startBunServer(handler, {
    port: 0,
    clientDir: makeClientDir(),
    handleSignals: false,
  });
  try {
    const gz = await fetch(`${baseUrl(server)}/assets/app.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gz.status).toBe(200);
    // Bun fetch mendekompres otomatis; header membuktikan gzip diterapkan dan
    // isi hasil dekompresi membuktikan payload utuh.
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("vary")).toContain("accept-encoding");
    expect(await gz.text()).toBe(BIG_JS);

    // Jalur gzip mentah (tanpa dekompresi) — byte-level, sama seperti node-server.
    const raw = await fetch(`${baseUrl(server)}/assets/app.js`, {
      headers: { "accept-encoding": "gzip" },
      decompress: false,
    } as RequestInit);
    const rawBody = Buffer.from(await raw.arrayBuffer());
    expect(rawBody.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(gunzipSync(rawBody).toString("utf8")).toBe(BIG_JS);

    const head = await fetch(`${baseUrl(server)}/assets/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("Q: bun-server — trailingSlash mencakup path prerender (never & always)", async () => {
  const handler = async (): Promise<Response> => new Response("handler", { status: 404 });

  const neverServer = startBunServer(handler, {
    port: 0,
    clientDir: makePrerenderedDir(),
    handleSignals: false,
    trailingSlash: "never",
  });
  try {
    const redirect = await fetch(`${baseUrl(neverServer)}/about/`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toContain("/about");
    const direct = await fetch(`${baseUrl(neverServer)}/about`);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe("ABOUT-PAGE");
  } finally {
    await neverServer.stop(true);
  }

  const alwaysServer = startBunServer(handler, {
    port: 0,
    clientDir: makePrerenderedDir(),
    handleSignals: false,
    trailingSlash: "always",
  });
  try {
    const redirect = await fetch(`${baseUrl(alwaysServer)}/about`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toContain("/about/");
  } finally {
    await alwaysServer.stop(true);
  }
});

test("Q: bun-server — handler dispatch + header default aman + storage menang", async () => {
  const handler = async (req: Request): Promise<Response> =>
    new Response(`handled ${new URL(req.url).pathname}`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  const server = startBunServer(handler, {
    port: 0,
    clientDir: makeClientDir(),
    handleSignals: false,
  });
  try {
    const page = await fetch(`${baseUrl(server)}/hello`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("handled /hello");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

    const missing = await fetch(`${baseUrl(server)}/nope`);
    expect(missing.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("Q: bun-server — RPC content-length > batas → 413 format §15", async () => {
  const handler = async (): Promise<Response> => new Response("handler");
  const server = startBunServer(handler, {
    port: 0,
    clientDir: makeClientDir(),
    handleSignals: false,
    bodyLimitBytes: 512,
  });
  try {
    const big = "x".repeat(2048);
    const response = await fetch(`${baseUrl(server)}/_moons/fn/abc`, {
      method: "POST",
      headers: { "content-type": "application/x-moons", "x-moons": "1" },
      body: big,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("E_RPC_BODY_TOO_LARGE");
  } finally {
    await server.stop(true);
  }
});
