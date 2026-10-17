import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunServer, startNodeServer } from "@moonsjs/vite/server";

/**
 * Addendum T (G4): `Range` single-range untuk file statik — 206 +
 * `content-range`, 416 untuk range tak terpuaskan, format tak didukung → 200,
 * dan range tidak digabung dengan gzip (identity).
 */

const SMALL = "0123456789";
const BIG_JS = `// payload\n${"const value = 1;\n".repeat(200)}`;

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-range-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "data.txt"), SMALL);
  writeFileSync(join(dir, "assets", "app.js"), BIG_JS);
  return dir;
}

interface ProbeResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function nodeGet(port: number, path: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
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

async function bunGet(port: number, path: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const collected: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    collected[key] = value;
  });
  return { status: response.status, headers: collected, body: Buffer.from(await response.arrayBuffer()) };
}

async function startNode(handler: (request: Request) => Promise<Response>): Promise<{ server: Server; port: number }> {
  const server = startNodeServer(handler, { port: 0, handleSignals: false, clientDir: makeClientDir() });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}

const handler = async (): Promise<Response> => new Response("handler");

for (const transport of ["node:http", "Bun.serve"] as const) {
  test(`T: ${transport} — 206/content-range/416/suffix/format tak didukung`, async () => {
    const run = async (
      get: (path: string, headers?: Record<string, string>) => Promise<ProbeResult>,
    ): Promise<void> => {
      const full = await get("/data.txt");
      expect(full.status).toBe(200);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      expect(full.body.toString("utf8")).toBe(SMALL);

      const head = await get("/data.txt", { range: "bytes=0-4" });
      expect(head.status).toBe(206);
      expect(head.headers["content-range"]).toBe(`bytes 0-4/${SMALL.length}`);
      expect(head.body.toString("utf8")).toBe("01234");

      const open = await get("/data.txt", { range: "bytes=5-" });
      expect(open.status).toBe(206);
      expect(open.headers["content-range"]).toBe(`bytes 5-9/${SMALL.length}`);
      expect(open.body.toString("utf8")).toBe("56789");

      const suffix = await get("/data.txt", { range: "bytes=-3" });
      expect(suffix.status).toBe(206);
      expect(suffix.headers["content-range"]).toBe(`bytes 7-9/${SMALL.length}`);
      expect(suffix.body.toString("utf8")).toBe("789");

      const bad = await get("/data.txt", { range: "bytes=99-" });
      expect(bad.status).toBe(416);
      expect(bad.headers["content-range"]).toBe(`bytes */${SMALL.length}`);
      expect(bad.body.byteLength).toBe(0);

      const malformed = await get("/data.txt", { range: "bytes=abc" });
      expect(malformed.status).toBe(200);
      expect(malformed.body.toString("utf8")).toBe(SMALL);

      // Range + gzip: partial selalu identity (tanpa content-encoding).
      const ranged = await get("/assets/app.js", { range: "bytes=0-9", "accept-encoding": "gzip" });
      expect(ranged.status).toBe(206);
      expect(ranged.headers["content-encoding"]).toBeUndefined();
      expect(ranged.body.byteLength).toBe(10);
    };

    if (transport === "node:http") {
      const { server, port } = await startNode(handler);
      try {
        await run((path, headers) => nodeGet(port, path, headers));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return;
    }
    const server = startBunServer(handler, { port: 0, handleSignals: false, clientDir: makeClientDir() });
    try {
      await run((path, headers) => bunGet(server.port, path, headers));
    } finally {
      await server.stop(true);
    }
  });
}
