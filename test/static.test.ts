import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticFile } from "@moonsjs/vite/server";

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-client-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "main.js"), "console.log(1);\n");
  writeFileSync(join(dir, "index.html"), "<html></html>\n");
  return dir;
}

test("menyajikan file yang ada di dalam clientDir", () => {
  const clientDir = makeClientDir();
  expect(resolveStaticFile(clientDir, "/assets/main.js")).toBe(join(clientDir, "assets/main.js"));
  expect(resolveStaticFile(clientDir, "/index.html")).toBe(join(clientDir, "index.html"));
});

test("menolak path traversal dan file yang tidak ada", () => {
  const clientDir = makeClientDir();
  expect(resolveStaticFile(clientDir, "/../secret.txt")).toBeNull();
  expect(resolveStaticFile(clientDir, "/%2e%2e/secret.txt")).toBeNull();
  expect(resolveStaticFile(clientDir, "/assets/nope.js")).toBeNull();
  expect(resolveStaticFile(clientDir, "/assets")).toBeNull();
});
