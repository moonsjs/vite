import { MoonsError } from "@moonsjs/core";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ViteDevServer } from "vite";

export type Shell = (
  markup: string,
  payload: string,
  url: string,
  meta?: Record<string, unknown>,
) => string | Promise<string>;

export const ROOT_PLACEHOLDER = '<div id="root"></div>';

export const DEFAULT_TEMPLATE = [
  "<!doctype html>",
  '<html lang="id">',
  "<head>",
  '  <meta charset="utf-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
  "  <title>Moons</title>",
  "</head>",
  "<body>",
  `  ${ROOT_PLACEHOLDER}`,
  '  <script type="module" src="/src/client/main.tsx"></script>',
  "</body>",
  "</html>",
  "",
].join("\n");

/** Inject markup SSR + payload devalue ke shell HTML (PRD §8.2, §17, Addendum B.1). */
export function injectShell(
  template: string,
  markup: string,
  payload: string,
  meta?: Record<string, unknown>,
): string {
  if (!template.includes(ROOT_PLACEHOLDER)) {
    throw new MoonsError({
      code: "E_INTERNAL",
      message: `shell HTML tidak memuat \`${ROOT_PLACEHOLDER}\``,
      details: "index.html aplikasi wajib memuat elemen root tersebut agar SSR bisa meng-inject markup.",
      suggestions: [
        `Tambahkan ${ROOT_PLACEHOLDER} ke index.html`,
        "Atau hapus index.html untuk memakai shell bawaan",
      ],
    });
  }
  const dataScript = `<script id="__moons_data" type="application/x-moons">${payload}</script>`;
  const withRoot = template.replace(ROOT_PLACEHOLDER, `<div id="root">${markup}</div>${dataScript}`);
  return applyMeta(withRoot, meta);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Terapkan meta route ke `<head>` (Addendum B.1): `<title>` + description/og.
 * Tag yang sudah ada (mis. di index.html) ditimpa; yang belum ada disisipkan
 * sebelum `</head>`.
 */
function applyMeta(html: string, meta: Record<string, unknown> | undefined): string {
  if (meta === undefined) {
    return html;
  }
  let out = html;
  if (typeof meta.title === "string") {
    const title = `<title>${escapeHtml(meta.title)}</title>`;
    out = /<title>[\s\S]*?<\/title>/.test(out)
      ? out.replace(/<title>[\s\S]*?<\/title>/, title)
      : out.replace("</head>", `  ${title}\n</head>`);
  }

  const tags: Array<{ attr: "name" | "property"; key: string; value: unknown }> = [
    { attr: "name", key: "description", value: meta.description },
    { attr: "property", key: "og:title", value: meta.title },
    { attr: "property", key: "og:description", value: meta.description },
  ];
  for (const tag of tags) {
    if (typeof tag.value !== "string") {
      continue;
    }
    const rendered = `<meta ${tag.attr}="${tag.key}" content="${escapeHtml(tag.value)}" />`;
    const pattern = new RegExp(`<meta[^>]*${tag.attr}="${tag.key}"[^>]*>`);
    out = pattern.test(out)
      ? out.replace(pattern, rendered)
      : out.replace("</head>", `  ${rendered}\n</head>`);
  }
  return out;
}

/**
 * Shell untuk dev: baca `index.html` dari disk setiap request (selalu segar)
 * lalu lewatkan ke Vite `transformIndexHtml` (inject `/@vite/client`, dsb).
 */
export function createDevShell(server: ViteDevServer, options: { templatePath: string }): Shell {
  return async (markup, payload, url, meta) => {
    const template = existsSync(options.templatePath)
      ? readFileSync(options.templatePath, "utf8")
      : DEFAULT_TEMPLATE;
    const html = injectShell(template, markup, payload, meta);
    return await server.transformIndexHtml(url, html);
  };
}

/** Shell untuk produksi: baca `dist/client/index.html` sekali dari cwd. */
export function createFileShell(options: { clientDir?: string } = {}): Shell {
  let cached: string | null = null;
  return async (markup, payload, _url, meta) => {
    if (cached === null) {
      const clientDir = resolve(options.clientDir ?? process.cwd(), "dist/client");
      const file = join(clientDir, "index.html");
      if (!existsSync(file)) {
        throw new MoonsError({
          code: "E_INTERNAL",
          file,
          message: "`dist/client/index.html` tidak ditemukan",
          details: "Build client harus dijalankan sebelum server produksi dinyalakan.",
          suggestions: ["Jalankan `bun run build` lebih dulu"],
        });
      }
      cached = readFileSync(file, "utf8");
    }
    return injectShell(cached, markup, payload, meta);
  };
}
