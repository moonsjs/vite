import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeForPathname, startBunServer } from "@moonsjs/vite/server";
import { MIME_TYPES } from "../src/server/transport";

/** Addendum R (review G5): artefak framework & media disajikan dengan tipe benar. */

test("MIME map: xml/csv/pdf/media tersedia di kedua jalur", () => {
  expect(contentTypeForPathname("/sitemap.xml")).toBe("application/xml; charset=utf-8");
  expect(contentTypeForPathname("/feed.csv")).toBe("text/csv; charset=utf-8");
  expect(contentTypeForPathname("/readme.md")).toBe("text/markdown; charset=utf-8");
  expect(contentTypeForPathname("/doc.pdf")).toBe("application/pdf");

  expect(MIME_TYPES[".xml"]).toBe("application/xml; charset=utf-8");
  expect(MIME_TYPES[".mp4"]).toBe("video/mp4");
  expect(MIME_TYPES[".webm"]).toBe("video/webm");
  expect(MIME_TYPES[".mp3"]).toBe("audio/mpeg");
  expect(MIME_TYPES[".zip"]).toBe("application/zip");
});

test("bun-server: sitemap.xml statik disajikan application/xml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moons-mime-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sitemap.xml"), "<urlset></urlset>");
  const server = startBunServer(async () => new Response("handler"), {
    port: 0,
    clientDir: dir,
    handleSignals: false,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sitemap.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toContain("<urlset>");
  } finally {
    await server.stop(true);
  }
});
