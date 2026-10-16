import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStaticFile } from "../src/server/node-server";

function write(root: string, rel: string, content = "x"): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-static-"));
  write(dir, "index.html", "<div id=\"root\"></div>");
  write(dir, "assets/app.js", "console.log(1)");
  write(dir, "blog/hello/index.html", "<p>hello</p>");
  return dir;
}

test("resolveStaticFile: aset persis dilayani; path tanpa file → null (bukan shell)", () => {
  const dir = makeClientDir();
  expect(resolveStaticFile(dir, "/assets/app.js")).toContain("assets/app.js");
  // Shell index.html BUKAN pengganti SSR untuk "/" tanpa manifest prerender.
  expect(resolveStaticFile(dir, "/")).toBeNull();
  expect(resolveStaticFile(dir, "/blog/hello")).toBeNull();
  expect(resolveStaticFile(dir, "/tidak-ada")).toBeNull();
});

test("resolveStaticFile: manifest prerender mengaktifkan path (termasuk root & trailing slash)", () => {
  const dir = makeClientDir();
  write(dir, "_moons_prerender.json", JSON.stringify({ paths: ["/", "/blog/hello"] }));

  expect(resolveStaticFile(dir, "/")).toContain("index.html");
  expect(resolveStaticFile(dir, "/blog/hello")).toContain("blog/hello/index.html");
  expect(resolveStaticFile(dir, "/blog/hello/")).toContain("blog/hello/index.html");
  expect(resolveStaticFile(dir, "/blog/other")).toBeNull();
});

test("resolveStaticFile: traversal ditolak", () => {
  const dir = makeClientDir();
  const outside = join(dir, "..", "outside-prerender.txt");
  writeFileSync(outside, "secret");
  expect(resolveStaticFile(dir, "/../outside-prerender.txt")).toBeNull();
  expect(resolveStaticFile(dir, "/%2e%2e/outside-prerender.txt")).toBeNull();
});
