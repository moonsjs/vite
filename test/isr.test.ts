import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetIsrInflight,
  revalidatePrerendered,
  shouldRevalidate,
} from "../src/server/isr";

function makeFile(content = "<html>lama</html>"): string {
  const dir = mkdtempSync(join(tmpdir(), "moons-isr-"));
  const file = join(dir, "index.html");
  writeFileSync(file, content);
  return file;
}

test("shouldRevalidate: batas detik sesuai umur file", () => {
  const now = 1_000_000;
  expect(shouldRevalidate({ mtimeMs: now - 999, revalidateSeconds: 1, now })).toBe(false);
  expect(shouldRevalidate({ mtimeMs: now - 1000, revalidateSeconds: 1, now })).toBe(true);
  expect(shouldRevalidate({ mtimeMs: now, revalidateSeconds: 0, now })).toBe(true);
});

test("revalidatePrerendered: tulis atomik (tmp+rename) dengan konten baru", async () => {
  __resetIsrInflight();
  const file = makeFile();
  const before = statSync(file).mtimeMs;
  await Bun.sleep(5);
  await revalidatePrerendered({
    pathname: "/x",
    file,
    handler: async (request) => {
      expect(request.headers.get("x-moons-prerender")).toBe("1");
      return new Response("<html>baru</html>");
    },
    env: {},
  });
  expect(readFileSync(file, "utf8")).toBe("<html>baru</html>");
  expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(before);
});

test("revalidatePrerendered: leak-guard fail-closed — file lama TIDAK ditimpa", async () => {
  __resetIsrInflight();
  const file = makeFile("<html>aman</html>");
  const secret = "ssr-secret-value-123456";
  const logs: string[] = [];
  await revalidatePrerendered({
    pathname: "/leak",
    file,
    handler: async () => new Response(`<html>${secret}</html>`),
    env: { DB_SECRET: secret },
    log: (message) => logs.push(message),
  });
  expect(readFileSync(file, "utf8")).toBe("<html>aman</html>");
  expect(logs.join("\n")).toContain("NOT writing");

  await revalidatePrerendered({
    pathname: "/canary",
    file,
    handler: async () => new Response("<html>MOONS_CANARY_X</html>"),
    canary: "MOONS_CANARY_X",
    env: {},
    log: () => {},
  });
  expect(readFileSync(file, "utf8")).toBe("<html>aman</html>");
});

test("revalidatePrerendered: status non-200 tidak menimpa; dedupe panggilan paralel", async () => {
  __resetIsrInflight();
  const file = makeFile("<html>lama</html>");
  await revalidatePrerendered({
    pathname: "/err",
    file,
    handler: async () => new Response("boom", { status: 500 }),
    env: {},
    log: () => {},
  });
  expect(readFileSync(file, "utf8")).toBe("<html>lama</html>");

  let calls = 0;
  const handler = async (): Promise<Response> => {
    calls += 1;
    await Bun.sleep(20);
    return new Response("<html>sekali</html>");
  };
  const [a, b] = await Promise.all([
    revalidatePrerendered({ pathname: "/dedupe", file, handler, env: {} }),
    revalidatePrerendered({ pathname: "/dedupe", file, handler, env: {} }),
  ]);
  expect(calls).toBe(1);
  expect(a).toBeUndefined();
  expect(b).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe("<html>sekali</html>");
});
