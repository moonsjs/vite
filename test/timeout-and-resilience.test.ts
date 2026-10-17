import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrerenderStorage } from "@moonsjs/core";
import { startBunServer, startNodeServer } from "@moonsjs/vite/server";

/**
 * Addendum R (review G1/G2/G6): paritas kedua transport untuk
 * timeout eksplisit (504 `E_REQUEST_TIMEOUT`), fallback storage yang melempar,
 * dan header keamanan pada respons error transport.
 */

const BIG_JS = `// payload\n${"const value = 1;\n".repeat(200)}`;

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-resilience-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.js"), BIG_JS);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface ProbeOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

function nodeRequest(port: number, options: ProbeOptions): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function bunRequest(port: number, options: ProbeOptions): Promise<ProbeResult> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.headers !== undefined) {
    init.headers = options.headers;
  }
  if (options.body !== undefined) {
    init.body = options.body as unknown as BodyInit;
  }
  const response = await fetch(`http://127.0.0.1:${port}${options.path}`, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
}

async function startNode(
  handler: (request: Request) => Promise<Response>,
  options: Parameters<typeof startNodeServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = startNodeServer(handler, { ...options, port: 0, handleSignals: false });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}

async function closeNode(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const transport of ["node:http", "Bun.serve"] as const) {
  test(`R: ${transport} — handler melewati batas → 504 E_REQUEST_TIMEOUT + header aman`, async () => {
    const handler = async (): Promise<Response> => {
      await sleep(400);
      return new Response("late");
    };
    if (transport === "node:http") {
      const { server, port } = await startNode(handler, {
        clientDir: makeClientDir(),
        requestTimeoutMs: 120,
      });
      try {
        const result = await nodeRequest(port, { path: "/slow" });
        expect(result.status).toBe(504);
        expect(result.body.toString("utf8")).toContain("E_REQUEST_TIMEOUT");
        expect(result.headers["x-content-type-options"]).toBe("nosniff");
        expect(result.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      } finally {
        await closeNode(server);
      }
      return;
    }
    const server = startBunServer(handler, { clientDir: makeClientDir(), requestTimeoutMs: 120 });
    try {
      const result = await bunRequest(server.port, { path: "/slow" });
      expect(result.status).toBe(504);
      expect(result.body.toString("utf8")).toContain("E_REQUEST_TIMEOUT");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(result.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    } finally {
      await server.stop(true);
    }
  });

  test(`R: ${transport} — requestTimeoutMs 0 = tanpa batas`, async () => {
    const handler = async (): Promise<Response> => {
      await sleep(250);
      return new Response("done");
    };
    if (transport === "node:http") {
      const { server, port } = await startNode(handler, { clientDir: makeClientDir(), requestTimeoutMs: 0 });
      try {
        const result = await nodeRequest(port, { path: "/slow" });
        expect(result.status).toBe(200);
        expect(result.body.toString("utf8")).toBe("done");
      } finally {
        await closeNode(server);
      }
      return;
    }
    const server = startBunServer(handler, { clientDir: makeClientDir(), requestTimeoutMs: 0 });
    try {
      const result = await bunRequest(server.port, { path: "/slow" });
      expect(result.status).toBe(200);
      expect(result.body.toString("utf8")).toBe("done");
    } finally {
      await server.stop(true);
    }
  });

  test(`R: ${transport} — storage.read melempar → fallback dist/client`, async () => {
    const throwingStorage: PrerenderStorage = {
      read: async () => {
        throw new Error("sidecar down");
      },
      write: async () => {},
    };
    const handler = async (): Promise<Response> => new Response("handler");
    if (transport === "node:http") {
      const { server, port } = await startNode(handler, {
        clientDir: makeClientDir(),
        storage: throwingStorage,
      });
      try {
        const asset = await nodeRequest(port, { path: "/assets/app.js" });
        expect(asset.status).toBe(200);
        expect(asset.body.byteLength).toBeGreaterThan(0);
        const page = await nodeRequest(port, { path: "/some-page" });
        expect(page.status).toBe(200);
        expect(page.body.toString("utf8")).toBe("handler");
      } finally {
        await closeNode(server);
      }
      return;
    }
    const server = startBunServer(handler, { clientDir: makeClientDir(), storage: throwingStorage });
    try {
      const asset = await bunRequest(server.port, { path: "/assets/app.js" });
      expect(asset.status).toBe(200);
      expect(asset.body.byteLength).toBeGreaterThan(0);
      const page = await bunRequest(server.port, { path: "/some-page" });
      expect(page.status).toBe(200);
      expect(page.body.toString("utf8")).toBe("handler");
    } finally {
      await server.stop(true);
    }
  });

  test(`R: ${transport} — 413 transport membawa header default aman`, async () => {
    const handler = async (): Promise<Response> => new Response("handler");
    const body = Buffer.from("x".repeat(2048));
    const headers = { "content-type": "application/x-moons", "x-moons": "1" };
    if (transport === "node:http") {
      const { server, port } = await startNode(handler, {
        clientDir: makeClientDir(),
        bodyLimitBytes: 512,
      });
      try {
        const result = await nodeRequest(port, {
          method: "POST",
          path: "/_moons/fn/abc",
          headers,
          body,
        });
        expect(result.status).toBe(413);
        expect(result.headers["x-content-type-options"]).toBe("nosniff");
      } finally {
        await closeNode(server);
      }
      return;
    }
    const server = startBunServer(handler, { clientDir: makeClientDir(), bodyLimitBytes: 512 });
    try {
      const result = await bunRequest(server.port, {
        method: "POST",
        path: "/_moons/fn/abc",
        headers,
        body,
      });
      expect(result.status).toBe(413);
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await server.stop(true);
    }
  });
}
