import { MoonsError, type RouteDefinition, type RouteModule } from "@moonsjs/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { scanPayloadForSecrets } from "../payload-scan";

/**
 * Prerender statis (PRD Addendum D.5): render route ber-`prerender = true`
 * saat build → `dist/client/<path>/index.html` (guard: payload scan fail-mode).
 */
/** Addendum H: config statis yang ditulis saat prerender (deploy kit). */
export interface PrerenderStaticConfig {
  headers?: Record<string, string>;
  redirects?: Array<{ from: string; to: string; status?: number }>;
  sitemap?: { site: string; exclude?: string[] };
  robots?: { sitemap?: boolean; disallow?: string[] };
}

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
  /** Addendum H: `headers`/`redirects`/`sitemap`/`robots` dari config. */
  staticConfig?: PrerenderStaticConfig;
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
          message: "`revalidate` is invalid or used without `prerender = true`",
          details: "File-based ISR: `revalidate` (seconds, number >= 0) + `prerender`.",
          suggestions: [
            "Use a number of seconds, e.g. `export const revalidate = 60`",
            "Add `export const prerender = true` to the same page",
          ],
        });
      }
    }

    if (prerender !== true) {
      if (prerender !== undefined && prerender !== false) {
        throw prerenderError(route, "`prerender` must be a boolean (`true`/`false`)");
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
        log(`[moons] prerender: skipped ${pathname} (notFound)`);
        skipped += 1;
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        throw prerenderError(route, `\`redirect()\` is not supported during prerender (${pathname})`);
      }
      if (response.status !== 200) {
        throw prerenderError(route, `status ${response.status} while rendering ${pathname}`);
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

  // Addendum H: deploy kit statis (headers/redirects/sitemap/robots).
  const emitted = emitStaticFiles(options.clientDir, options.staticConfig, entries);

  const extras = [...(wrote404 ? [NOT_FOUND_FILE] : []), ...emitted];
  log(
    `[moons] prerender done: ${written} file${extras.length > 0 ? ` + ${extras.join(" + ")}` : ""} (${skipped} skipped)`,
  );
  return { written, skipped };
}

/** Tulis file deploy statis dari config; mengembalikan nama file yang ditulis. */
function emitStaticFiles(
  clientDir: string,
  staticConfig: PrerenderStaticConfig | undefined,
  entries: Array<{ path: string }>,
): string[] {
  if (staticConfig === undefined) {
    return [];
  }
  const emitted: string[] = [];

  const headers = Object.entries(staticConfig.headers ?? {});
  if (headers.length > 0) {
    const lines = ["/*", ...headers.map(([name, value]) => `  ${name}: ${value}`)];
    writeFileSync(join(clientDir, "_headers"), `${lines.join("\n")}\n`);
    emitted.push("_headers");
  }

  const redirects = staticConfig.redirects ?? [];
  if (redirects.length > 0) {
    const lines = redirects.map((entry) => `${entry.from} ${entry.to} ${entry.status ?? 301}`);
    writeFileSync(join(clientDir, "_redirects"), `${lines.join("\n")}\n`);
    emitted.push("_redirects");
  }

  const sitemap = staticConfig.sitemap;
  if (sitemap !== undefined) {
    const site = sitemap.site.replace(/\/$/, "");
    const exclude = sitemap.exclude ?? [];
    const paths = [...new Set(entries.map((entry) => entry.path))]
      .filter((path) => !exclude.some((prefix) => path.startsWith(prefix)))
      .sort();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...paths.map((path) => `  <url><loc>${site}${path === "/" ? "/" : path}</loc></url>`),
      "</urlset>",
      "",
    ].join("\n");
    writeFileSync(join(clientDir, "sitemap.xml"), xml);
    emitted.push("sitemap.xml");
  }

  const robots = staticConfig.robots;
  if (robots !== undefined) {
    const lines = ["User-agent: *"];
    for (const path of robots.disallow ?? []) {
      lines.push(`Disallow: ${path}`);
    }
    if ((robots.sitemap ?? true) && sitemap !== undefined) {
      lines.push("", `Sitemap: ${sitemap.site.replace(/\/$/, "")}/sitemap.xml`);
    }
    writeFileSync(join(clientDir, "robots.txt"), `${lines.join("\n")}\n`);
    emitted.push("robots.txt");
  }

  return emitted;
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
      `[moons] prerender: ${NOT_FOUND_FILE} skipped (sentinel \`${NOT_FOUND_SENTINEL}\` → ${response.status})`,
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
    message: `prerender output \`${pathname}\` contains ${labels}`,
    details: "Static HTML is permanent — a prerendered secret cannot be retracted.",
    suggestions: [
      "Do not return secret env values from a loader that runs at prerender time",
      "Turn off `prerender` for this route or move the data to a request-time serverFn",
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
      message: "dynamic route with `prerender = true` without `export const paths`",
      details: "Prerendering needs a param list to render each path.",
      suggestions: [
        'Add `export const paths = () => [{ id: "…" }]`',
        "Or remove `prerender` so the route renders at request time (SSR)",
      ],
    });
  }

  const raw = await (paths as () => unknown | Promise<unknown>)();
  if (!Array.isArray(raw)) {
    throw prerenderError(route, "`paths()` must return an array");
  }

  const expected = new Set(route.params);
  const result: string[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw prerenderError(route, "`paths()` items must be objects with string params");
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const name of expected) {
      const value = record[name];
      if (typeof value !== "string" || value.length === 0) {
        throw prerenderError(route, `param \`${name}\` must be a non-empty string`);
      }
    }
    for (const key of keys) {
      if (!expected.has(key)) {
        throw prerenderError(route, `param \`${key}\` is not in the route pattern`);
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
    throw prerenderError(route, `param value \`${value}\` is not valid for a file path`);
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
      message: `prerender path escapes the client directory (\`${pathname}\`)`,
      details: "The file name must stay inside `dist/client`.",
      suggestions: ["Check the `paths` param values — do not use `..`"],
    });
  }
  return file;
}

function prerenderError(route: RouteDefinition, message: string): MoonsError {
  return new MoonsError({
    code: "E_PRERENDER_INVALID",
    file: route.file,
    message,
    details: "The prerender contract is enforced.",
    suggestions: [
      "Fix the `paths`/params shape so it matches the route pattern",
      "Do not use `redirect()` on a prerendered route",
    ],
  });
}
