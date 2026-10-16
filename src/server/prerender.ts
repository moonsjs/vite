import { MoonsError, type RouteDefinition, type RouteModule } from "@moonsjs/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { scanPayloadForSecrets } from "../payload-scan";

/**
 * Prerender statis (PRD Addendum D.5): render route ber-`prerender = true`
 * saat build → `dist/client/<path>/index.html` (guard: payload scan fail-mode).
 */
export interface PrerenderOptions {
  routes: RouteDefinition[];
  routesDir: string;
  loadRoute: Record<string, () => Promise<RouteModule>>;
  /** Handler SSR yang sudah dibuat runtime (createRequestHandler). */
  handler: (request: Request) => Promise<Response>;
  /** Tujuan file statis (biasanya `<root>/dist/client`). */
  clientDir: string;
  canary?: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface PrerenderResult {
  written: number;
  skipped: number;
}

/**
 * Manifest path yang benar-benar di-prerender (dibaca static server agar hanya
 * file hasil prerender yang "menang" atas SSR — bukan shell index.html biasa).
 */
export const PRERENDER_MANIFEST_FILE = "_moons_prerender.json";

/**
 * Addendum G: sentinel internal untuk merender halaman 404 statis. Path ini
 * tidak pernah menjadi route publik; handler merendernya seperti request tak
 * dikenal (route `_404` atau 404 bawaan).
 */
export const NOT_FOUND_SENTINEL = "/_moons/404";

/** Addendum G: nama file 404 untuk static host (konvensi Cloudflare Pages/Netlify). */
export const NOT_FOUND_FILE = "404.html";

export async function runPrerender(options: PrerenderOptions): Promise<PrerenderResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const env = options.env ?? process.env;
  let written = 0;
  let skipped = 0;
  const entries: Array<{ path: string; revalidate?: number }> = [];

  const pages = options.routes.filter((route) => route.kind === "page");
  for (const route of pages) {
    const key = routeKeyOf(options.routesDir, route.file);
    const load = options.loadRoute[key];
    if (load === undefined) {
      continue;
    }
    const module = (await load()) as RouteModule;
    const prerender = module.prerender;
    const revalidate = module.revalidate;

    // Addendum E.1: `revalidate` hanya sah bersama `prerender`.
    if (revalidate !== undefined) {
      if (
        typeof revalidate !== "number" ||
        !Number.isFinite(revalidate) ||
        revalidate < 0 ||
        prerender !== true
      ) {
        throw new MoonsError({
          code: "E_ISR_INVALID",
          file: route.file,
          message: "`revalidate` tidak valid atau dipakai tanpa `prerender = true`",
          details: "ISR berbasis file: `revalidate` (detik, number >= 0) + `prerender`.",
          suggestions: [
            "Gunakan angka detik, mis. `export const revalidate = 60`",
            "Tambahkan `export const prerender = true` pada page yang sama",
          ],
        });
      }
    }

    if (prerender !== true) {
      if (prerender !== undefined && prerender !== false) {
        throw prerenderError(route, "`prerender` harus boolean (`true`/`false`)");
      }
      continue;
    }

    const pathnames = await resolvePathnames(route, module);
    for (const pathname of pathnames) {
      const response = await options.handler(
        new Request(`http://localhost${pathname}`, {
          method: "GET",
          headers: { "x-moons-prerender": "1" },
        }),
      );

      if (response.status === 404) {
        log(`[moons] prerender: lewati ${pathname} (notFound)`);
        skipped += 1;
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        throw prerenderError(route, `\`redirect()\` tidak didukung saat prerender (${pathname})`);
      }
      if (response.status !== 200) {
        throw prerenderError(route, `status ${response.status} saat merender ${pathname}`);
      }

      const html = await response.text();
      assertNoLeak(html, pathname, route.file, options, env);

      const file = outputFile(options.clientDir, pathname);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, html);
      entries.push(
        typeof revalidate === "number" && revalidate >= 0
          ? { path: pathname, revalidate }
          : { path: pathname },
      );
      written += 1;
    }
  }

  // Addendum G: `404.html` untuk static host, bila app punya route `_404`.
  const notFound = await renderStaticNotFound(options, env, log);
  let wrote404 = false;
  if (notFound !== null) {
    writeFileSync(join(options.clientDir, NOT_FOUND_FILE), notFound);
    wrote404 = true;
  }

  // Manifest v2 (Addendum E.1): entries + revalidate; reader tetap menerima v1.
  writeFileSync(
    join(options.clientDir, PRERENDER_MANIFEST_FILE),
    `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
  );

  log(
    `[moons] prerender selesai: ${written} file${wrote404 ? ` + ${NOT_FOUND_FILE}` : ""} (${skipped} dilewati)`,
  );
  return { written, skipped };
}

/**
 * Addendum G: render halaman 404 ke `dist/client/404.html` (static export).
 * Ditulis hanya bila app memiliki route `_404` dan sentinel menghasilkan 404;
 * hasilnya tetap melewati guard kebocoran (fail-mode).
 */
async function renderStaticNotFound(
  options: PrerenderOptions,
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): Promise<string | null> {
  if (!options.routes.some((route) => route.kind === "404")) {
    return null;
  }
  const response = await options.handler(
    new Request(`http://localhost${NOT_FOUND_SENTINEL}`, {
      method: "GET",
      headers: { "x-moons-prerender": "1" },
    }),
  );
  if (response.status !== 404) {
    log(
      `[moons] prerender: ${NOT_FOUND_FILE} dilewati (sentinel \`${NOT_FOUND_SENTINEL}\` → ${response.status})`,
    );
    return null;
  }
  const html = await response.text();
  assertNoLeak(html, NOT_FOUND_SENTINEL, NOT_FOUND_FILE, options, env);
  return html;
}

/** Guard kebocoran fail-mode (Addendum D.5) — dipakai halaman & 404 statis. */
function assertNoLeak(
  html: string,
  pathname: string,
  file: string,
  options: PrerenderOptions,
  env: Record<string, string | undefined>,
): void {
  const findings = scanPayloadForSecrets(html, {
    ...(options.canary === undefined ? {} : { canary: options.canary }),
    env,
  });
  if (findings.length === 0) {
    return;
  }
  const labels = findings
    .map((finding) => (finding.kind === "canary" ? "canary" : `env(${finding.label})`))
    .join(", ");
  throw new MoonsError({
    code: "E_PRERENDER_LEAK",
    file,
    message: `hasil prerender \`${pathname}\` memuat ${labels}`,
    details: "HTML statis permanen — rahasia yang ter-prerender tidak bisa ditarik kembali.",
    suggestions: [
      "Jangan mengembalikan nilai env rahasia dari loader yang di-prerender",
      "Matikan `prerender` untuk route ini atau pindahkan datanya ke serverFn request-time",
    ],
  });
}

function routeKeyOf(routesDir: string, file: string): string {
  const relative = file.startsWith(routesDir) ? file.slice(routesDir.length + 1) : file;
  return relative.split("\\").join("/").replace(/\.(tsx|ts)$/, "");
}

async function resolvePathnames(route: RouteDefinition, module: RouteModule): Promise<string[]> {
  const isDynamic = route.params.length > 0;
  if (!isDynamic) {
    return [route.path];
  }
  const paths = module.paths;
  if (typeof paths !== "function") {
    throw new MoonsError({
      code: "E_PRERENDER_NO_PATHS",
      file: route.file,
      message: "route dynamic ber-`prerender = true` tanpa `export const paths`",
      details: "Prerender butuh daftar param untuk merender tiap path.",
      suggestions: [
        'Tambahkan `export const paths = () => [{ id: "…" }]`',
        "Atau hapus `prerender` agar dirender SSR saat request",
      ],
    });
  }

  const raw = await (paths as () => unknown | Promise<unknown>)();
  if (!Array.isArray(raw)) {
    throw prerenderError(route, "`paths()` harus mengembalikan array");
  }

  const expected = new Set(route.params);
  const result: string[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw prerenderError(route, "item `paths()` harus objek param string");
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const name of expected) {
      const value = record[name];
      if (typeof value !== "string" || value.length === 0) {
        throw prerenderError(route, `param \`${name}\` wajib string non-kosong`);
      }
    }
    for (const key of keys) {
      if (!expected.has(key)) {
        throw prerenderError(route, `param \`${key}\` tidak ada di pola route`);
      }
    }
    result.push(buildPathname(route, record as Record<string, string>));
  }
  return result;
}

function buildPathname(route: RouteDefinition, params: Record<string, string>): string {
  const segments = route.path.split("/").filter((segment) => segment.length > 0);
  const out: string[] = [];
  let catchallName: string | null = null;
  for (const segment of segments) {
    if (segment === "*") {
      catchallName = route.params[route.params.length - 1] ?? null;
      const value = catchallName === null ? "" : (params[catchallName] ?? "");
      for (const part of value.split("/")) {
        if (part.length === 0) {
          continue;
        }
        out.push(encodeSegment(route, part));
      }
      continue;
    }
    if (segment.startsWith(":")) {
      out.push(encodeSegment(route, params[segment.slice(1)] ?? ""));
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

function encodeSegment(route: RouteDefinition, value: string): string {
  if (value.length === 0 || /^\.+$/.test(value)) {
    throw prerenderError(route, `nilai param \`${value}\` tidak valid untuk path file`);
  }
  return encodeURIComponent(value);
}

function outputFile(clientDir: string, pathname: string): string {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  const file = resolve(join(clientDir, ...parts, "index.html"));
  const base = resolve(clientDir);
  if (file !== base && !file.startsWith(base + sep)) {
    throw new MoonsError({
      code: "E_PRERENDER_INVALID",
      message: `path prerender keluar dari direktori client (\`${pathname}\`)`,
      details: "Nama file harus berada di dalam `dist/client`.",
      suggestions: ["Periksa nilai param `paths` — jangan memakai `..`"],
    });
  }
  return file;
}

function prerenderError(route: RouteDefinition, message: string): MoonsError {
  return new MoonsError({
    code: "E_PRERENDER_INVALID",
    file: route.file,
    message,
    details: "Kontrak prerender mengikuti.",
    suggestions: [
      "Perbaiki bentuk `paths`/param agar cocok dengan pola route",
      "Jangan memakai `redirect()` pada route yang di-prerender",
    ],
  });
}
