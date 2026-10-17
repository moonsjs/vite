import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { PrerenderStorage, PrerenderStorageEntry } from "@moonsjs/core";
import { resolveStaticFile, staticFileTarget } from "./node-server";

/**
 * Addendum I: storage file sistem (default) untuk file prerender/ISR.
 * Read hanya melayani path yang benar-benar ada (manifest-aware);
 * write atomik (tmp + rename) dan membuat direktori bila perlu.
 */
export function createFileStorage(clientDir: string): PrerenderStorage {
  return {
    async read(pathname: string): Promise<PrerenderStorageEntry | null> {
      const file = resolveStaticFile(clientDir, pathname);
      if (file === null) {
        return null;
      }
      const stat = statSync(file);
      return { body: readFileSync(file), mtimeMs: stat.mtimeMs };
    },
    async write(pathname: string, body: Uint8Array): Promise<void> {
      const target = staticFileTarget(clientDir, pathname);
      if (target === null) {
        throw new Error(`[moons] isr: invalid path to write: ${pathname}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, body);
      renameSync(tmp, target);
    },
  };
}

/** Ekstensi pathname (untuk `content-type`) tanpa membaca storage. */
export function contentTypeForPathname(pathname: string): string {
  const ext = extname(pathname.split("?")[0] ?? "").toLowerCase();
  return MIME[ext] ?? MIME[".html"] ?? "text/html; charset=utf-8";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};
