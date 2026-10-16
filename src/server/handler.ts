import {
  MoonsError,
  composeMiddleware,
  findApiDirMiddlewares,
  findDirMiddlewares,
  findErrorBoundary,
  isNotFoundSignal,
  isRedirectSignal,
  resolveRoute,
  routeKeyFromFile,
  runLoaders,
  type ApiMethod,
  type ApiMiddlewareDefinition,
  type ApiRouteDefinition,
  type Middleware,
  type MoonsConfig,
  type ResolvedRoute,
  type RouteDefinition,
  type RouteModule,
  trailingSlashRedirect,
} from "@moonsjs/core";
import { encodeSsrPayload, reviveError, serializeError } from "@moonsjs/core/serialize";
import { API_METHODS, resolveApiRoute } from "@moonsjs/core";
import { renderToMarkup } from "@moonsjs/react/ssr";
import type { ClientRouteEntry, RouteModuleShape } from "@moonsjs/react/internal";
import { createRpcHandler, runWithContext, runWithRequestCache, runWithResponseCollector, takeResponseMutations } from "@moonsjs/server";
import { NOT_FOUND_ROUTE_KEY } from "../manifest";
import { scanPayloadForSecrets, type PayloadScanOptions } from "../payload-scan";
import type { Shell } from "./shell";

const RPC_PREFIX = "/_moons/fn/";
const HEALTH_PATH = "/_moons/health";

export interface RequestHandlerOptions {
  routes: RouteDefinition[];
  /** Config yang sudah divalidasi. */
  config: MoonsConfig;
  /** Direktori route absolut; dipakai untuk derivasi key stabil. */
  routesDir: string;
  /** Peta import() modul route, key = routeKeyFromFile. */
  loadRoute: Record<string, () => Promise<RouteModule>>;
  shell: Shell;
  /**
   * Dipanggil setelah `config.context` per request (Addendum B.4: extender
   * `extendContext` plugin di-merge ke ctx).
   */
  onContext?: (ctx: Ctx) => void;
  /**
   * A1: pemindaian payload SSR (dev) — peringatan sekali per label bila payload
   * memuat canary/nilai env mirip-rahasia. Production TIDAK mengisi opsi ini
   * (tanpa biaya runtime). Lihat `payload-scan.ts`.
   */
  payloadScan?: PayloadScanOptions;
  /** Endpoint API `src/api` (Addendum D.1) — hasil scan plugin. */
  apiRoutes?: ApiRouteDefinition[];
  /** Peta import() modul API, key = route.path. */
  loadApi?: Record<string, () => Promise<unknown>>;
  /** Middleware direktori pohon `src/api` (Addendum D.3). */
  apiMiddlewares?: ApiMiddlewareDefinition[];
  /** Peta import() `_middleware.ts` pohon api, key = file path. */
  loadApiMiddleware?: Record<string, () => Promise<unknown>>;
}

/**
 * Handler HTML: context → middleware global → resolve route → loader paralel
 * → render React → inject payload devalue (PRD §11.2, §14.2, §17).
 */
export function createRequestHandler(
  options: RequestHandlerOptions,
): (request: Request) => Promise<Response> {  const { routes, config, routesDir, loadRoute, shell } = options;
  const rpc = createRpcHandler(
    config.security === undefined ? {} : { security: config.security },
  );
  const notFoundRoute = routes.find((route) => route.kind === "404");
  const errorRoute = routes.find((route) => route.kind === "error");
  /** A1: dedupe peringatan payload (sekali per label). */
  const warnedPayloadLabels = new Set<string>();

  async function renderRoute(
    resolved: ResolvedRoute,
    request: Request,
    ctx: Ctx,
  ): Promise<Response> {
    const entries = [...resolved.layouts, resolved.route];
    const keys = entries.map((entry) => routeKeyFromFile(routesDir, entry.file));
    const modules = await loadModules(keys, loadRoute);

    const data = await runLoaders(
      entries.map((entry, index) => ({ file: keys[index] as string, module: modules[index] as RouteModule })),
      { params: resolved.params, ctx, req: request },
    );

    const pageKey = routeKeyFromFile(routesDir, resolved.route.file);
    const pageModule = modules[modules.length - 1] as RouteModule;
    const entry: ClientRouteEntry = { page: pageKey, layouts: keys.slice(0, -1) };
    // Addendum A.3: query string ikut ke payload agar server/client identik.
    const searchParams = Object.fromEntries(new URL(request.url).searchParams);
    // Addendum B.1: eksekusi `meta()` page (data = hasil loader page itu sendiri).
    const meta = await runRouteMeta(pageModule, data[pageKey], resolved.route.file);

    const markup = renderToMarkup(
      entry,
      { page: pageModule as RouteModuleShape, layouts: modules.slice(0, -1) as RouteModuleShape[] },
      resolved.params,
      data,
      searchParams,
    );
    const payload = encodeSsrPayload({
      key: pageKey,
      params: resolved.params,
      searchParams,
      data,
      ...(meta === undefined ? {} : { meta }),
    });

    // A1: pindai payload SSR (dev saja — `payloadScan` tidak diisi production).
    warnPayloadFindings(payload, options.payloadScan, warnedPayloadLabels);

    return htmlResponse(await shell(markup, payload, request.url, meta), 200);
  }

  /** Addendum D.1: dispatch endpoint `src/api` (405/HEAD/OPTIONS + error). */
  async function handleApiRequest(
    route: ApiRouteDefinition,
    params: Record<string, string>,
    request: Request,
    ctx: Ctx,
  ): Promise<Response> {
    const load = options.loadApi?.[route.path];
    if (load === undefined) {
      return apiErrorResponse(
        new MoonsError({
          code: "E_API_HANDLER_INVALID",
          file: route.file,
          message: `API module \`${route.path}\` could not be loaded`,
          details: "The `loadApi` map does not contain this route (build/dev out of sync).",
          suggestions: ["Rebuild / restart the dev server"],
        }),
        route,
      );
    }

    let mod: unknown;
    try {
      mod = await load();
    } catch (error) {
      return apiErrorResponse(error, route);
    }
    if (mod === null || typeof mod !== "object") {
      return apiErrorResponse(
        new MoonsError({
          code: "E_API_HANDLER_INVALID",
          file: route.file,
          message: "API module does not export a handler object",
          details: `Module \`${route.path}\` must export method handlers.`,
          suggestions: ["Export `GET`/`POST`/… as `(args) => Response` functions"],
        }),
        route,
      );
    }

    const record = mod as Record<string, unknown>;
    const methods: ApiMethod[] = API_METHODS.filter(
      (method) => typeof record[method] === "function",
    );
    const requestMethod = request.method.toUpperCase();
    type ApiHandlerFn = (args: {
      req: Request;
      params: Record<string, string>;
      ctx: Ctx;
    }) => Response | Promise<Response>;
    let handler = record[requestMethod] as ApiHandlerFn | undefined;
    let stripBody = false;

    // D.7 #2: HEAD otomatis dari GET; OPTIONS otomatis → 204 + Allow.
    if (typeof handler !== "function" && requestMethod === "HEAD" && typeof record["GET"] === "function") {
      handler = record["GET"] as ApiHandlerFn;
      stripBody = true;
    }
    if (typeof handler !== "function") {
      if (requestMethod === "OPTIONS") {
        return new Response(null, { status: 204, headers: { allow: methods.join(", ") } });
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: methods.join(", ") },
      });
    }

    try {
      const result = await handler({ req: request, params, ctx });
      if (!(result instanceof Response)) {
        return apiErrorResponse(
          new MoonsError({
            code: "E_API_HANDLER_INVALID",
            file: route.file,
            message: `handler \`${requestMethod}\` did not return a \`Response\``,
            details: "API handlers must return `new Response(...)`.",
            suggestions: ["Return `new Response(body, { status, headers })`"],
          }),
          route,
        );
      }
      if (stripBody) {
        return new Response(null, { status: result.status, headers: result.headers });
      }
      return result;
    } catch (error) {
      return apiErrorResponse(error, route);
    }
  }

  /** §11.2: halaman `_404.tsx` kustom (standalone), fallback bawaan. */
  async function notFoundResponse(request: Request): Promise<Response> {
    if (notFoundRoute !== undefined) {
      try {
        const key = routeKeyFromFile(routesDir, notFoundRoute.file);
        const [module] = await loadModules([key], loadRoute);
        const payload = encodeSsrPayload({ key: NOT_FOUND_ROUTE_KEY, params: {}, data: {} });
        const markup = renderToMarkup(
          { page: key, layouts: [] },
          { page: module as RouteModuleShape, layouts: [] },
          {},
          {},
        );
        return htmlResponse(await shell(markup, payload, request.url), 404);
      } catch (error) {
        console.error("[moons] failed to render custom _404:", error);
      }
    }

    const payload = encodeSsrPayload({ key: "", params: {}, data: {} });
    const html = await shell(
      "<h1>404</h1><p>Page not found.</p>",
      payload,
      request.url,
    );
    return htmlResponse(html, 404);
  }

  /**
   * §11.2/D.3: `_error.tsx` kustom (boundary terdekat dari route; fallback
   * root). Production tidak men-serialisasi error apa pun (§16.6).
   */
  async function routeErrorResponse(
    error: unknown,
    request: Request,
    resolved?: ResolvedRoute,
  ): Promise<Response> {
    console.error("[moons] route error:", error);

    const boundary =
      (resolved === undefined ? null : findErrorBoundary(resolved.route, routes)) ??
      errorRoute ??
      null;
    if (boundary !== null) {
      try {
        const key = routeKeyFromFile(routesDir, boundary.file);
        const [module] = await loadModules([key], loadRoute);
        const isProduction = process.env["NODE_ENV"] === "production";
        const serialized = isProduction ? undefined : serializeError(error);
        const payload = encodeSsrPayload({
          key,
          params: {},
          data: {},
          ...(serialized === undefined ? {} : { error: serialized }),
        });
        const markup = renderToMarkup(
          { page: key, layouts: [] },
          { page: module as RouteModuleShape, layouts: [] },
          {},
          {},
          {},
          serialized === undefined ? undefined : reviveError(serialized),
        );
        return htmlResponse(await shell(markup, payload, request.url), 500);
      } catch (renderError) {
        console.error("[moons] failed to render custom _error:", renderError);
      }
    }

    return internalErrorResponse(error, { log: false });
  }

  /** Muat middleware direktori (D.3) → `Middleware[]`; error bentuk jelas. */
  async function loadDirMiddlewares(chain: ReadonlyArray<RouteDefinition>): Promise<Middleware[]> {
    const result: Middleware[] = [];
    for (const definition of chain) {
      const key = routeKeyFromFile(routesDir, definition.file);
      const load = options.loadRoute?.[key];
      if (load === undefined) {
        throw new MoonsError({
          code: "E_MIDDLEWARE_INVALID",
          file: definition.file,
          message: "directory middleware could not be loaded",
          details: "The `loadRoute` map does not contain this `_middleware.ts`.",
          suggestions: ["Restart the dev server / rebuild"],
        });
      }
      const module = (await load()) as { default?: unknown };
      const handler = module.default;
      if (typeof handler !== "function") {
        throw new MoonsError({
          code: "E_MIDDLEWARE_INVALID",
          file: definition.file,
          message: "`_middleware.ts` does not default-export a function",
          details: "Directory middleware follows the `(args) => Promise<Response>` shape.",
          suggestions: ["Export default `async ({ req, ctx, next }) => await next()`"],
        });
      }
      result.push(handler as Middleware);
    }
    return result;
  }

  /** Muat middleware pohon `src/api` (D.3). */
  async function loadApiDirMiddlewares(
    chain: ReadonlyArray<ApiMiddlewareDefinition>,
  ): Promise<Middleware[]> {
    const result: Middleware[] = [];
    for (const definition of chain) {
      const load = options.loadApiMiddleware?.[definition.file];
      if (load === undefined) {
        throw new MoonsError({
          code: "E_MIDDLEWARE_INVALID",
          file: definition.file,
          message: "API middleware could not be loaded",
          details: "The `loadApiMiddleware` map does not contain this `_middleware.ts`.",
          suggestions: ["Restart the dev server / rebuild"],
        });
      }
      const module = (await load()) as { default?: unknown };
      if (typeof module.default !== "function") {
        throw new MoonsError({
          code: "E_MIDDLEWARE_INVALID",
          file: definition.file,
          message: "`_middleware.ts` does not default-export a function",
          details: "Directory middleware follows the `(args) => Promise<Response>` shape.",
          suggestions: ["Export default `async ({ req, ctx, next }) => await next()`"],
        });
      }
      result.push(module.default as Middleware);
    }
    return result;
  }

  const handleCore = async function handler(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      // §19.5: health ditangani paling awal — tetap hidup walau kode user rusak.
      if (url.pathname === HEALTH_PATH) {
        return healthResponse(request.method);
      }

      // `MoonsConfig.context` bertipe `unknown` (menghindari referensi sirkular
      // ke global `Ctx` — §13); kontraknya tetap `Promise<Ctx>`, jadi cast di
      // batas runtime ini. Tanpa cast, tsc app user yang memuat `@moonsjs/vite/server`
      // (mis. `createTestServer` §19.5) melihat `unknown` vs `Ctx` global app.
      const ctx = (await config.context(request)) as Ctx;
      options.onContext?.(ctx);
      // Addendum D.5: tandai request prerender build-time (aditif §13.1).
      if (request.headers.get("x-moons-prerender") === "1") {
        (ctx as Record<string, unknown>)["__prerender"] = true;
      }

      const respond = composeMiddleware(config.middleware ?? [], ctx, async () => {
        if (url.pathname.startsWith(RPC_PREFIX)) {
          return await rpc(request, url.pathname.slice(RPC_PREFIX.length), ctx);
        }
        // Addendum D.1: endpoint HTTP mentah `src/api` (semua method).
        if (options.apiRoutes !== undefined && options.apiRoutes.length > 0) {
          const apiMatch = resolveApiRoute(url.pathname, options.apiRoutes);
          if (apiMatch !== null) {
            // Addendum D.3: middleware direktori pohon api.
            const apiChain = findApiDirMiddlewares(
              apiMatch.route.file,
              options.apiMiddlewares ?? [],
            );
            if (apiChain.length === 0) {
              return await handleApiRequest(apiMatch.route, apiMatch.params, request, ctx);
            }
            const middlewares = await loadApiDirMiddlewares(apiChain);
            return await composeMiddleware(
              middlewares,
              ctx,
              () => handleApiRequest(apiMatch.route, apiMatch.params, request, ctx),
              { code: "E_MIDDLEWARE_INVALID", label: "API middleware" },
            )(request);
          }
        }
        const resolved = resolveRoute(url.pathname, routes);
        if (resolved === null) {
          return await notFoundResponse(request);
        }
        try {
          // Addendum D.3: middleware direktori (root→leaf) untuk page.
          const dirChain = findDirMiddlewares(resolved.route, routes);
          if (dirChain.length === 0) {
            return await renderRoute(resolved, request, ctx);
          }
          const middlewares = await loadDirMiddlewares(dirChain);
          return await composeMiddleware(
            middlewares,
            ctx,
            () => renderRoute(resolved, request, ctx),
            { code: "E_MIDDLEWARE_INVALID", label: "directory middleware" },
          )(request);
        } catch (error) {
          // Addendum B.2: sinyal routing dari loader/meta.
          if (isRedirectSignal(error)) {
            return new Response(null, {
              status: error.status,
              headers: { location: new URL(error.to, request.url).toString() },
            });
          }
          if (isNotFoundSignal(error)) {
            return await notFoundResponse(request);
          }
          return await routeErrorResponse(error, request, resolved);
        }
      });

      // Addendum D.2: kolektor mutasi respons aktif selama request; helper
      // (setHeader/setCookie) menulis ke store, diterapkan ke Response akhir —
      // termasuk jalur error (mutasi yang sudah dipush tetap dihormati).
      return await runWithResponseCollector(async () => {
        let response: Response;
        try {
          response = await runWithRequestCache(() => runWithContext(ctx, () => respond(request)));
        } catch (error) {
          response = internalErrorResponse(error);
        }
        return applyResponseMutations(response);
      });
    } catch (error) {
      return internalErrorResponse(error);
    }
  };

  // Addendum H: redirect statis + hook lifecycle + header statis.
  const staticHeaders = Object.entries(config.headers ?? {});
  const redirects = (config.redirects ?? []).map((entry) => ({
    ...entry,
    status: entry.status ?? 301,
  }));

  return async function handler(request: Request): Promise<Response> {
    const isPrerender = request.headers.get("x-moons-prerender") === "1";
    const applyHeaders = (response: Response): Response => {
      for (const [name, value] of staticHeaders) {
        if (!response.headers.has(name)) {
          response.headers.set(name, value);
        }
      }
      return response;
    };

    try {
      // Addendum M: kanonikalisasi trailing slash sebelum routing (308,
      // query dipertahankan; `/_moons/**`, root, dan aset dikecualikan).
      if (!isPrerender && config.trailingSlash !== undefined) {
        const policyUrl = new URL(request.url);
        const canonical = trailingSlashRedirect(policyUrl.pathname, config.trailingSlash);
        if (canonical !== null) {
          policyUrl.pathname = canonical;
          return applyHeaders(
            new Response(null, { status: 308, headers: { location: policyUrl.toString() } }),
          );
        }
      }

      if (!isPrerender && redirects.length > 0) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/$/, "");
        for (const entry of redirects) {
          if (path === entry.from.replace(/\/$/, "")) {
            const location = entry.to.startsWith("http")
              ? entry.to
              : new URL(entry.to, url.origin).toString();
            return applyHeaders(
              new Response(null, { status: entry.status, headers: { location } }),
            );
          }
        }
      }

      await config.hooks?.onRequest?.(request);
      let response = await handleCore(request);
      const replaced = await config.hooks?.onResponse?.(response, request);
      if (replaced instanceof Response) {
        response = replaced;
      }
      return applyHeaders(response);
    } catch (error) {
      try {
        await config.hooks?.onError?.(error, request);
      } catch {
        // Kegagalan hook tidak boleh menutupi error asli.
      }
      return internalErrorResponse(error);
    }
  };
}

/** Terapkan mutasi `setHeader`/`appendHeader`/`setCookie` ke respons (D.2). */
function applyResponseMutations(response: Response): Response {
  const mutations = takeResponseMutations();
  if (mutations.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const mutation of mutations) {
    if (mutation.kind === "header") {
      if (mutation.append) {
        headers.append(mutation.name, mutation.value);
      } else {
        headers.set(mutation.name, mutation.value);
      }
    } else {
      headers.append("set-cookie", mutation.value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadModules(
  keys: string[],
  loadRoute: Record<string, () => Promise<RouteModule>>,
): Promise<RouteModule[]> {
  return await Promise.all(
    keys.map(async (key) => {
      const load = loadRoute[key];
      if (load === undefined) {
        throw new MoonsError({
          code: "E_INTERNAL",
          message: `route module \`${key}\` is not registered`,
          details: "The route registry is out of sync with the scan result.",
          suggestions: ["Run `bun run build` again, or restart the dev server"],
        });
      }
      return await load();
    }),
  );
}

async function runRouteMeta(
  pageModule: RouteModule,
  pageData: unknown,
  file: string,
): Promise<Record<string, unknown> | undefined> {
  const meta = (pageModule as { meta?: unknown }).meta;
  if (meta === undefined) {
    return undefined;
  }
  if (typeof meta !== "function") {
    throw new MoonsError({
      code: "E_INTERNAL",
      file,
      message: "export `meta` must be a function `({ data }) => RouteMeta`",
      details: "The `meta` shape follows `RouteMeta`.",
      suggestions: [
        "Change it to `export const meta = ({ data }) => ({ title: \"...\" })`",
        "Or remove the `meta` export",
      ],
    });
  }
  const result = await (meta as (args: { data: unknown }) => unknown)({ data: pageData });
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new MoonsError({
      code: "E_INTERNAL",
      file,
      message: "`meta()` must return a RouteMeta object",
      details: "The returned value is used for <title>/description/og.",
      suggestions: ["Return an object, e.g. `({ title: \"Home\" })`"],
    });
  }
  return result as Record<string, unknown>;
}

/**
 * Error endpoint API (Addendum D.1): detail hanya di non-production (§16.6).
 */
function apiErrorResponse(error: unknown, route: ApiRouteDefinition): Response {
  const isProduction = process.env["NODE_ENV"] === "production";
  if (error instanceof MoonsError) {
    console.error(`[moons] API ${route.path}: ${error.format()}`);
    return new Response(isProduction ? "Internal server error." : error.format(), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  console.error(`[moons] API ${route.path}:`, error);
  return new Response(isProduction ? "Internal server error." : String(error), {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function internalErrorResponse(error: unknown, options: { log?: boolean } = {}): Response {
  if (options.log !== false) {
    console.error("[moons] request error:", error);
  }

  const detail =
    process.env["NODE_ENV"] !== "production" && error instanceof MoonsError
      ? `<pre>${escapeHtml(error.format())}</pre>`
      : "<p>Internal server error.</p>";

  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>500</title></head><body><h1>500</h1>${detail}</body></html>`,
    500,
  );
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** §19.5: `/_moons/health` → `{ ok: true }`. */
function healthResponse(method: string): Response {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (method === "GET" || method === "HEAD") {
    return new Response(method === "HEAD" ? null : JSON.stringify({ ok: true }), {
      status: 200,
      headers,
    });
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: "GET, HEAD" },
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A1: peringatan dev untuk payload SSR yang memuat canary/nilai env
 * mirip-rahasia (sekali per label). Tidak pernah aktif di production karena
 * `payloadScan` hanya diisi runtime dev.
 */
function warnPayloadFindings(
  payload: string,
  scan: PayloadScanOptions | undefined,
  warned: Set<string>,
): void {
  if (scan === undefined) {
    return;
  }
  for (const finding of scanPayloadForSecrets(payload, scan)) {
    const label = finding.kind === "canary" ? "canary" : `env(${finding.label})`;
    if (warned.has(label)) {
      continue;
    }
    warned.add(label);
    console.warn(
      `[moons] dev warning: SSR payload contains ${label} — do not return secrets from loaders.`,
    );
  }
}
