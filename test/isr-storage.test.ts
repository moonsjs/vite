import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrerenderStorage, PrerenderStorageEntry } from "@moonsjs/core";
import { createFileStorage, startNodeServer } from "@moonsjs/vite/server";
import { revalidatePrerendered, __resetIsrInflight } from "../src/server/isr";

function makeMemoryStorage(initial: Record<string, string> = {}): PrerenderStorage & {
  entries: Map<string, PrerenderStorageEntry>;
} {
  const entries = new Map<string, PrerenderStorageEntry>();
  const now = Date.now() - 1_000;
  for (const [pathname, body] of Object.entries(initial)) {
    entries.set(pathname, { body: new TextEncoder().encode(body), mtimeMs: now });
  }
  return {
    entries,
    async read(pathname) {
      return entries.get(pathname) ?? null;
    },
    async write(pathname, body) {
      entries.set(pathname, { body, mtimeMs: Date.now() });
    },
  };
}

function makeClientDir(revalidate: number | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-isr-storage-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  const entry = revalidate === undefined ? { path: "/x" } : { path: "/x", revalidate };
  writeFileSync(
    join(dir, "_moons_prerender.json"),
    JSON.stringify({ version: 2, entries: [entry] }),
  );
  return dir;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

test("Addendum I: revalidatePrerendered menulis lewat storage; canary → tidak menulis", async () => {
  __resetIsrInflight();
  const storage = makeMemoryStorage();
  await revalidatePrerendered({
    pathname: "/x",
    storage,
    handler: async () => new Response("<html>versi-baru</html>"),
  });
  expect(new TextDecoder().decode(storage.entries.get("/x")?.body)).toContain("versi-baru");

  const guarded = makeMemoryStorage();
  await revalidatePrerendered({
    pathname: "/x",
    storage: guarded,
    handler: async () => new Response("<html>MOONS_CANARY_W2</html>"),
    canary: "MOONS_CANARY_W2",
  });
  expect(guarded.entries.has("/x")).toBe(false);
});

test("Addendum I: server menyajikan dari storage tanpa memanggil handler (revalidate belum jatuh)", async () => {
  __resetIsrInflight();
  const storage = makeMemoryStorage({ "/x": "<html>versi-lama</html>" });
  const clientDir = makeClientDir(3600);
  let calls = 0;
  const server = startNodeServer(
    async (request) => {
      calls += 1;
      const pathname = new URL(request.url).pathname;
      if (pathname === "/x") {
        return new Response("<html>handler</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("handler", { status: 404 });
    },
    { port: 0, clientDir, storage, headers: { "x-storage-test": "1" }, handleSignals: false },
  );
  const port = await listen(server);
  try {
    const served = await fetch(`http://127.0.0.1:${port}/x`);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-storage-test")).toBe("1");
    expect(await served.text()).toContain("versi-lama");
    expect(calls).toBe(0); // penyajian murni dari storage

    const missing = await fetch(`http://127.0.0.1:${port}/tidak-ada`);
    expect(missing.status).toBe(404);
    expect(calls).toBe(1); // fallback ke handler
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Addendum I: revalidate=0 → stale disajikan lalu storage diregenerasi", async () => {
  __resetIsrInflight();
  const storage = makeMemoryStorage({ "/x": "<html>versi-lama</html>" });
  const clientDir = makeClientDir(0);
  const server = startNodeServer(
    async () => new Response("<html>versi-hasil-regenerasi</html>"),
    { port: 0, clientDir, storage, handleSignals: false },
  );
  const port = await listen(server);
  try {
    const served = await fetch(`http://127.0.0.1:${port}/x`);
    expect(await served.text()).toContain("versi-lama"); // stale-while-revalidate

    const deadline = Date.now() + 2_000;
    let body = "";
    while (Date.now() < deadline) {
      body = new TextDecoder().decode(storage.entries.get("/x")?.body);
      if (body.includes("versi-hasil-regenerasi")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(body).toContain("versi-hasil-regenerasi");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Addendum I: createFileStorage — read/write roundtrip di file sistem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moons-file-storage-"));
  const storage = createFileStorage(dir);
  expect(await storage.read("/x")).toBeNull();

  const clientDir = makeClientDir(undefined);
  const fileStorage = createFileStorage(clientDir);
  await fileStorage.write("/x", new TextEncoder().encode("<html>ditulis</html>"));
  const entry = await fileStorage.read("/x");
  expect(entry).not.toBeNull();
  expect(new TextDecoder().decode(entry?.body)).toContain("ditulis");
  expect(typeof entry?.mtimeMs).toBe("number");
  expect(await storage.read("/project-belum-ada")).toBeNull();
});
