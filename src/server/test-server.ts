import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import type { renderToMarkup as RenderToMarkupFn } from "@moonsjs/react/ssr";
import { createRequestHandler, type RequestHandlerOptions } from "./handler";
import { DEFAULT_TEMPLATE, injectShell, type Shell } from "./shell";

type RenderMarkup = typeof RenderToMarkupFn;

/**
 * Addendum O: resolve the SSR renderer from the app's own `node_modules` first.
 * Bun resolves registry packages through its install cache; peer imports
 * (`react-dom/server`) are not reachable from there, but they are from the app.
 */
async function loadRenderer(candidates: ReadonlyArray<string>): Promise<RenderMarkup> {
  for (const root of candidates) {
    for (const relative of [
      "node_modules/@moonsjs/react/dist/ssr.js",
      "node_modules/@moonsjs/react/dist/ssr.mjs",
      "node_modules/@moonsjs/react/src/ssr.ts",
    ]) {
      const file = join(root, relative);
      if (!existsSync(file)) {
        continue;
      }
      const mod = (await import(pathToFileURL(file).href)) as {
        renderToMarkup?: RenderMarkup;
      };
      if (typeof mod.renderToMarkup === "function") {
        return mod.renderToMarkup;
      }
    }
  }
  const fallback = (await import("@moonsjs/react/ssr")) as { renderToMarkup: RenderMarkup };
  return fallback.renderToMarkup;
}

export interface TestServerOptions {
  routes: RouteDefinition[];
  config: MoonsConfig;
  routesDir: string;
  loadRoute: Record<string, () => Promise<RouteModule>>;
  /** Endpoint `src/api` (Addendum O) — hasil scan app. */
  apiRoutes?: RequestHandlerOptions["apiRoutes"];
  loadApi?: RequestHandlerOptions["loadApi"];
  apiMiddlewares?: RequestHandlerOptions["apiMiddlewares"];
  loadApiMiddleware?: RequestHandlerOptions["loadApiMiddleware"];
  /** Default: shell in-memory dari `DEFAULT_TEMPLATE` (tanpa file). */
  shell?: Shell;
}

export interface TestServer {
  handler: (request: Request) => Promise<Response>;
  /** Dispatch request langsung ke handler — tanpa port/jaringan (§19.5). */
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Utility test in-process (PRD §19.5): jalankan handler tanpa listen port.
 * Dipakai test aplikasi user maupun test internal framework.
 */
export function createTestServer(
  options: TestServerOptions,
  baseUrl = "http://localhost",
): TestServer {
  const shell: Shell =
    options.shell ??
    ((markup, payload, _url, meta) => injectShell(DEFAULT_TEMPLATE, markup, payload, meta));

  const handler = createRequestHandler({
    routes: options.routes,
    config: options.config,
    routesDir: options.routesDir,
    loadRoute: options.loadRoute,
    ...(options.apiRoutes === undefined ? {} : { apiRoutes: options.apiRoutes }),
    ...(options.loadApi === undefined ? {} : { loadApi: options.loadApi }),
    ...(options.apiMiddlewares === undefined ? {} : { apiMiddlewares: options.apiMiddlewares }),
    ...(options.loadApiMiddleware === undefined
      ? {}
      : { loadApiMiddleware: options.loadApiMiddleware }),
    renderer: () =>
      loadRenderer([process.cwd(), resolve(options.routesDir, "..", "..")]),
    shell,
  });

  return {
    handler,
    fetch: (input: string, init?: RequestInit) =>
      handler(new Request(new URL(input, baseUrl), init)),
  };
}
