import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative as relativePath, resolve as resolvePath } from "node:path";
import {
  MOONS_VERSION,
  MoonsError,
  fnRegistryKey,
  generateTypes,
  scanApiMiddlewares,
  scanApiRoutes,
  scanRoutes,
  validateConfig,
  type ApiMiddlewareDefinition,
  type ApiRouteDefinition,
  type RouteDefinition,
} from "@moonsjs/core";
import { loadConfigFromFile, type Plugin, type ViteDevServer } from "vite";
import { assertApiModuleExports, assertMiddlewareExports } from "./api";
import { findLeak } from "./leak-check";
import type { PackageJsonInfo } from "./server-only";
import { renderApiModule, renderRoutesModule, rootSpecifier } from "./manifest";
import { installDevMiddleware } from "./server/dev";
import {
  analyzeServerFile,
  checkClientModuleImports,
  checkRouteModuleExports,
  injectServerFnMeta,
  isNonContractServerFile,
  isServerFilePath,
  nonContractServerFileError,
  renderServerFnStub,
  resolveServerSpecifierSync,
  scanServerFiles,
  stripQuery,
  type ServerFileAnalysis,
} from "./transform";
import { fromNullPrefixed, VIRTUAL_MODULES } from "./virtual-modules";

export interface MoonsVitePluginOptions {
  /** Default: "moons.config.ts". */
  configPath?: string;
  /** Hanya dipakai di CI (M2 §21). */
  leakTest?: { canary?: string };
  /** Default: root Vite. */
  projectRoot?: string;
}

/**
 * Plugin `@moonsjs/vite` (PRD §9): scan route, typegen, virtual module,
 * dev SSR middleware, build client + server.
 */
const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export default function moons(options: MoonsVitePluginOptions = {}): Plugin {
  let root = options.projectRoot ?? process.cwd();
  let isSsrBuild = false;
  let configFilePath = "";
  let routesDir = "";
  let serverOnlyPackages: ReadonlyArray<string> = [];
  // Addendum J.1/J.2: paritas dev & produksi (paritas E7).
  let trustProxy = false;
  let bodyLimitBytes: number | undefined;
  let apiDir = "";
  let apiRoutes: ApiRouteDefinition[] = [];
  let apiMiddlewares: ApiMiddlewareDefinition[] = [];
  /** Cache package.json untuk gate Addendum C (dibagi lintas modul). */
  const packageCache = new Map<string, PackageJsonInfo | null>();  let routes: RouteDefinition[] = [];
  let analysisCache = new Map<string, ServerFileAnalysis>();
  const stubTransformed = new Set<string>();

  function analyzeFile(absoluteFile: string): ServerFileAnalysis | null {
    const cached = analysisCache.get(absoluteFile);
    if (cached !== undefined) {
      return cached;
    }
    let source: string;
    try {
      source = readFileSync(absoluteFile, "utf8");
    } catch {
      return null;
    }
    const analysis = analyzeServerFile(source, absoluteFile, root);
    analysisCache.set(absoluteFile, analysis);
    return analysis;
  }

  function refreshServerFns(): void {
    const next = new Map<string, ServerFileAnalysis>();
    const registry: Record<string, string> = {};

    for (const file of scanServerFiles(root)) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const analysis = analyzeServerFile(source, file, root);
      next.set(file, analysis);
      for (const fn of analysis.serverFns) {
        registry[fnRegistryKey(root, file, fn.name)] = fn.hash;
      }
    }

    analysisCache = next;
    const outDir = resolvePath(root, ".moons");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolvePath(outDir, "fn-registry.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8",
    );
  }

  /** Semua specifier file `.server.ts` yang punya serverFn (untuk eager import di entry server). */
  function serverFnFileSpecifiers(): string[] {
    const specifiers: string[] = [];
    for (const [file, analysis] of analysisCache) {
      if (analysis.serverFns.length > 0) {
        specifiers.push(rootSpecifier(root, file));
      }
    }
    return specifiers.sort();
  }

  /** Stub client §12.2 + cache §12.2.5. */
  function transformServerFileClient(code: string, id: string): string {
    const relativePath = id.startsWith(root)
      ? id.slice(root.length).split("\\").join("/")
      : id;
    const cacheKey = createHash("sha256").update(`${relativePath}\0${code}`).digest("hex");
    const cacheFile = resolvePath(root, ".moons/cache", `${cacheKey}.js`);

    if (existsSync(cacheFile)) {
      stubTransformed.add(id);
      return readFileSync(cacheFile, "utf8");
    }

    const analysis = analyzeFile(id);
    if (analysis === null) {
      throw new MoonsError({
        code: "E_INTERNAL",
        file: id,
        message: "failed to read the server file for transform",
        details: "The `.server.ts` file must be readable during transform.",
        suggestions: ["Check the path and file permissions"],
      });
    }

    const stub = renderServerFnStub(code, id, analysis, {
      analyzeSpecifier: (sourceFile, specifier) => {
        const resolved = resolveServerSpecifierSync(sourceFile, specifier);
        return resolved === null ? null : analyzeFile(resolved);
      },
    });

    mkdirSync(resolvePath(root, ".moons/cache"), { recursive: true });
    writeFileSync(cacheFile, stub.code, "utf8");
    stubTransformed.add(id);
    return stub.code;
  }

  return {
    name: "moons",
    enforce: "pre",

    config(_config, env) {
      isSsrBuild = env.isSsrBuild === true;
      const common = {
        appType: "custom" as const,
      };

      if (isSsrBuild) {
        return {
          ...common,
          build: {
            outDir: "dist/server",
            emptyOutDir: true,
            // Entry nyata yang di-generate saat buildStart (Rolldown butuh file,
            // entry virtual tidak di-resolve lewat plugin container).
            // D.5: dua entry — server (index) + prerender runner.
            ssr: true,
            rollupOptions: {
              input: {
                index: ".moons/server-entry.ts",
                prerender: ".moons/prerender-entry.ts",
              },
              output: {
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
              },
            },
          },
          ssr: { noExternal: true, target: "node" as const },
        };
      }

      return {
        ...common,
        build: { outDir: "dist/client", emptyOutDir: true },
        // Dev SSR: paket framework WAJIB di-inline ke pipeline Vite. Sejak
        // dipublikasikan, `@moonsjs/*` adalah package node_modules biasa (bukan
        // workspace-link) sehingga default Vite mengeksternalnya; import runtime
        // (bun) menyelesaikannya lewat kondisi `bun` → `src`, sedangkan modul
        // route diselesaikan Vite → `dist` — dua instans React context →
        // "useLoaderData dipanggil di luar render route" (temuan eval T4;
        // docs/decisions/0015). Inline → semua konsisten lewat Vite.
        ssr: { noExternal: [/^@moonsjs\//] },
      };
    },

    async configResolved(resolved) {
      root = options.projectRoot ?? resolved.root;
      configFilePath = resolvePath(root, options.configPath ?? "moons.config.ts");

      if (!existsSync(configFilePath)) {
        throw new MoonsError({
          code: "E_CONFIG_INVALID",
          file: configFilePath,
          message: "`moons.config.ts` not found",
          details: "The framework requires a config file at the project root.",
          suggestions: [
            "Create `moons.config.ts` with `export default defineConfig({ context: async (req) => ({}) })`",
          ],
        });
      }

      let raw: unknown;
      try {
        const loaded = await loadConfigFromFile(
          { command: resolved.command, mode: resolved.mode },
          configFilePath,
          root,
        );
        raw = loaded?.config;
      } catch (error) {
        if (error instanceof MoonsError) {
          throw error;
        }
        throw new MoonsError({
          code: "E_CONFIG_INVALID",
          file: configFilePath,
          message: "failed to load `moons.config.ts`",
          details: error instanceof Error ? error.message : String(error),
          suggestions: ["Check the syntax and imports in `moons.config.ts`"],
        });
      }

      const config = validateConfig(raw, { file: configFilePath, projectRoot: root });
      routesDir = resolvePath(root, config.routesDir);
      serverOnlyPackages = config.security?.serverOnlyPackages ?? [];
      trustProxy = config.security?.trustProxy === true;
      bodyLimitBytes = config.security?.bodyLimitBytes;

      // Addendum D.1: scan + validasi statis modul `src/api`.
      apiDir = resolvePath(root, config.apiDir ?? "src/api");
      if (existsSync(apiDir)) {
        apiRoutes = scanApiRoutes(apiDir);
        for (const route of apiRoutes) {
          assertApiModuleExports(readFileSync(route.file, "utf8"), route.file);
        }
        apiMiddlewares = scanApiMiddlewares(apiDir);
        for (const middleware of apiMiddlewares) {
          assertMiddlewareExports(readFileSync(middleware.file, "utf8"), middleware.file);
        }
      } else {
        apiRoutes = [];
        apiMiddlewares = [];
      }
    },

    async buildStart() {
      routes = scanRoutes(routesDir);
      // D.3: validasi statis `_middleware.ts` pohon routes.
      for (const middleware of routes.filter((route) => route.kind === "middleware")) {
        assertMiddlewareExports(readFileSync(middleware.file, "utf8"), middleware.file);
      }
      await generateTypes({
        routesDir,
        configPath: configFilePath,
        outDir: resolvePath(root, ".moons"),
      });
      refreshServerFns();
      if (isSsrBuild) {
        writeFileSync(
          resolvePath(root, ".moons/server-entry.ts"),
          renderServerEntryBuild(routesDir, serverFnFileSpecifiers(), options.leakTest?.canary),
          "utf8",
        );
        writeFileSync(
          resolvePath(root, ".moons/prerender-entry.ts"),
          renderPrerenderEntry(routesDir, root, options.leakTest?.canary),
          "utf8",
        );
      }
    },

    resolveId(id) {
      const clean = id.startsWith("\0") ? id.slice(1) : id;
      if ((Object.values(VIRTUAL_MODULES) as string[]).includes(clean)) {
        return `\0${clean}`;
      }
      return undefined;
    },

    load(id) {
      const name = fromNullPrefixed(id);
      if (name === null) {
        return undefined;
      }
      switch (name) {
        case VIRTUAL_MODULES.routes:
          return renderRoutesModule(routes, routesDir, root);
        case VIRTUAL_MODULES.api:
          return renderApiModule(apiRoutes, apiMiddlewares, root);
        case VIRTUAL_MODULES.clientEntry:
          return '// Generated by @moons. Do not edit manually.\nexport { clientManifest, loadRoute } from "virtual:moons/routes";\n';
        case VIRTUAL_MODULES.config:
          return renderConfigModule(root, configFilePath);
        case VIRTUAL_MODULES.serverEntry:
          // Hanya dipakai dev (ssrLoadModule); build memakai .moons/server-entry.ts.
          return renderServerEntryDev(routesDir, serverFnFileSpecifiers());
      }
    },

    async transform(code, id) {
      const cleanId = stripQuery(id);
      if (cleanId.startsWith("\0") || cleanId.includes("/node_modules/")) {
        return undefined;
      }

      const environment = environmentName(this);

      if (isServerFilePath(cleanId)) {
        if (environment === "ssr") {
          const analysis = analysisCache.get(cleanId) ?? analyzeFile(cleanId);
          if (analysis === null || analysis.serverFns.length === 0) {
            return undefined;
          }
          return injectServerFnMeta(code, analysis, root);
        }
        return transformServerFileClient(code, cleanId);
      }

      // Audit ronde 2: file server di luar kontrak §12 tidak bisa di-stub —
      // jangan pernah biarkan masuk graph client.
      if (environment !== "ssr" && isNonContractServerFile(cleanId)) {
        throw nonContractServerFileError(cleanId, root);
      }

      if (environment !== "ssr" && CODE_FILE_PATTERN.test(cleanId)) {
        if (cleanId.startsWith(routesDir) && cleanId.endsWith(".tsx")) {
          checkRouteModuleExports({
            file: cleanId,
            code,
            routesDir,
            projectRoot: root,
          });
        }
        await checkClientModuleImports({
          file: cleanId,
          code,
          projectRoot: root,
          // Resolusi penuh (alias Vite, tsconfig paths, symlink) — audit ronde 2.
          resolve: async (specifier, importer) => {
            try {
              const resolved = await this.resolve(specifier, importer);
              return resolved === null ? null : stripQuery(resolved.id);
            } catch {
              return null;
            }
          },
          analyze: (absoluteFile) => analysisCache.get(absoluteFile) ?? analyzeFile(absoluteFile),
          apiDir,
          configFile: configFilePath,
          serverDir: resolvePath(root, "src/server"),
          serverOnlyPackages,
          packageCache,
        });
      }

      return undefined;
    },

    generateBundle(_options, bundle) {
      if (environmentName(this) === "ssr") {
        return;
      }

      const canary = options.leakTest?.canary;
      if (canary !== undefined && canary.length > 0) {
        const leak = findLeak(Object.values(bundle), canary);
        if (leak !== null) {
          throw new MoonsError({
            code: "E_INTERNAL",
            message: `canary \`${canary}\` found in the client bundle (${leak.fileName})`,
            details:
              "Leak verification failed: server code leaked into the client output. Build stopped.",
            suggestions: [
              "Check the `*.server.ts` transform",
              "Run `./scripts/m2/test-leak.sh` to audit",
            ],
          });
        }
      }

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }
        for (const moduleId of Object.keys(output.modules)) {
          const cleanId = stripQuery(moduleId);
          if (!isServerFilePath(cleanId) || stubTransformed.has(cleanId)) {
            continue;
          }
          throw new MoonsError({
            code: "E_FORBIDDEN_SERVER_IMPORT",
            file: cleanId,
            message: "server module got bundled into the client without passing through the transform",
            details:
              "Build verification: every `*.server.ts` in the client bundle must be an RPC stub produced by the transform.",
            suggestions: [
              "Make sure the zero-trust transform runs for this module",
              "If this repeats, report it as a framework bug",
            ],
          });
        }
      }
    },

    configureServer(server) {
      installDevMiddleware(server, {
        templatePath: resolvePath(root, "index.html"),
        // Addendum I.4 (W4): overlay devtools — data segar per request.
        devtools: () => {
          const toRelative = (file: string): string =>
            file.startsWith(root) ? relativePath(root, file).split("\\").join("/") : file;
          return {
            routes: [...routes]
              .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
              .map((route) => ({ path: route.path, kind: route.kind, file: toRelative(route.file) })),
            apiRoutes: [...apiRoutes]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((route) => ({ path: route.path, kind: "api", file: toRelative(route.file) })),
            serverFns: [...analysisCache.values()]
              .flatMap((analysis) =>
                analysis.serverFns.map((fn) => ({
                  file: toRelative(analysis.file),
                  name: fn.name,
                  hash: fn.hash,
                })),
              )
              .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
            canary: options.leakTest?.canary !== undefined,
            version: MOONS_VERSION,
          };
        },
        // A1: pemindaian payload SSR hanya di dev (warning), tanpa biaya di production.
        payloadScan: {
          ...(options.leakTest?.canary === undefined ? {} : { canary: options.leakTest.canary }),
          env: process.env,
        },
        // D.1: request ke prefix API (semua method) dirutekan ke runtime.
        ...(apiRoutes.length === 0
          ? {}
          : { apiPrefix: `/${apiDir.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "api"}` }),
        trustProxy,
        ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
      });
      server.config.logger.info("[moons] devtools: /__moons/devtools");
    },

    async handleHotUpdate(context) {
      if (isServerFilePath(context.file)) {
        refreshServerFns();
        context.server.ws.send({ type: "full-reload" });
        return;
      }

      if (context.file.startsWith(apiDir) && existsSync(apiDir)) {
        try {
          apiRoutes = scanApiRoutes(apiDir);
          for (const route of apiRoutes) {
            assertApiModuleExports(readFileSync(route.file, "utf8"), route.file);
          }
          apiMiddlewares = scanApiMiddlewares(apiDir);
          for (const middleware of apiMiddlewares) {
            assertMiddlewareExports(readFileSync(middleware.file, "utf8"), middleware.file);
          }
        } catch (error) {
          context.server.config.logger.error(String(error));
          return;
        }
        invalidateVirtualModules(context.server);
        context.server.ws.send({ type: "full-reload" });
        return;
      }

      if (!context.file.startsWith(routesDir)) {
        return;
      }

      try {
        routes = scanRoutes(routesDir);
        for (const middleware of routes.filter((route) => route.kind === "middleware")) {
          assertMiddlewareExports(readFileSync(middleware.file, "utf8"), middleware.file);
        }
        await generateTypes({
          routesDir,
          configPath: configFilePath,
          outDir: resolvePath(root, ".moons"),
        });
      } catch (error) {
        context.server.config.logger.error(String(error));
        return;
      }

      invalidateVirtualModules(context.server);
      context.server.ws.send({ type: "full-reload" });
    },
  };
}

function renderConfigModule(root: string, configFilePath: string): string {
  return [
    "// Generated by @moons. Do not edit manually.",
    `import raw from ${JSON.stringify(rootSpecifier(root, configFilePath))};`,
    'import { validateConfig } from "@moonsjs/core";',
    `export default validateConfig(raw, { file: ${JSON.stringify(configFilePath)} });`,
    "",
  ].join("\n");
}

function renderServerEntryDev(routesDir: string, eagerImports: string[]): string {
  return [
    "// Generated by @moons. Do not edit manually.",
    'import { createPluginRuntime, createRequestHandler } from "@moonsjs/vite/server";',
    'import { renderToMarkup } from "@moonsjs/react/ssr";',
    'import config from "virtual:moons/config";',
    'import { routes, loadRoute } from "virtual:moons/routes";',
    'import { apiRoutes, apiMiddlewares, loadApi, loadApiMiddleware } from "virtual:moons/api";',
    ...eagerImports.map((specifier) => `import ${JSON.stringify(specifier)};`),
    "",
    "export function createDevApp(shell, payloadScan) {",
    "  const plugins = createPluginRuntime({ config, routes, middlewares: config.middleware ?? [] });",
    `  const handler = createRequestHandler({ routes, apiRoutes, apiMiddlewares, loadApi, loadApiMiddleware, config, routesDir: ${JSON.stringify(routesDir)}, loadRoute, shell, renderer: async () => renderToMarkup, onContext: (ctx) => plugins.applyExtensions(ctx), ...(payloadScan === undefined ? {} : { payloadScan }) });`,
    "  return { handler, plugins };",
    "}",
    "",
  ].join("\n");
}

function renderServerEntryBuild(
  routesDir: string,
  eagerImports: string[],
  canary: string | undefined,
): string {
  return [
    "// Generated by @moons. Do not edit manually.",
    'import { createFileShell, createPluginRuntime, createRequestHandler, startNodeServer } from "@moonsjs/vite/server";',
    'import { renderToMarkup } from "@moonsjs/react/ssr";',
    'import config from "virtual:moons/config";',
    'import { routes, loadRoute } from "virtual:moons/routes";',
    'import { apiRoutes, apiMiddlewares, loadApi, loadApiMiddleware } from "virtual:moons/api";',
    ...eagerImports.map((specifier) => `import ${JSON.stringify(specifier)};`),
    "",
    "const plugins = createPluginRuntime({ config, routes, middlewares: config.middleware ?? [] });",
    "const handler = createRequestHandler({",
    "  routes,",
    "  apiRoutes,",
    "  apiMiddlewares,",
    "  loadApi,",
    "  loadApiMiddleware,",
    "  config,",
    `  routesDir: ${JSON.stringify(routesDir)},`,
    "  loadRoute,",
    "  shell: createFileShell(),",
    "  renderer: async () => renderToMarkup,",
    "  onContext: (ctx) => plugins.applyExtensions(ctx),",
    "});",
    "",
    `startNodeServer(handler, { plugins, headers: config.headers, storage: config.isr?.storage, trustProxy: config.security?.trustProxy, bodyLimitBytes: config.security?.bodyLimitBytes, logging: config.logging, trailingSlash: config.trailingSlash${canary === undefined ? "" : `, canary: ${JSON.stringify(canary)}`} });`,
    "",
  ].join("\n");
}

interface ModuleGraphLike {
  getModulesByFile(file: string): Iterable<{ id?: string | null }> | undefined;
  invalidateModule(module: unknown): void;
}

/** Entry D.5: runner prerender (dijalankan CLI setelah build server). */
function renderPrerenderEntry(
  routesDir: string,
  projectRoot: string,
  canary: string | undefined,
): string {
  return [
    "// Generated by @moons. Do not edit manually.",
    'import { createFileShell, createRequestHandler, runPrerender } from "@moonsjs/vite/server";',
    'import { renderToMarkup } from "@moonsjs/react/ssr";',
    'import config from "virtual:moons/config";',
    'import { routes, loadRoute } from "virtual:moons/routes";',
    "",
    "const handler = createRequestHandler({",
    "  routes,",
    "  config,",
    `  routesDir: ${JSON.stringify(routesDir)},`,
    "  loadRoute,",
    "  shell: createFileShell(),",
    "  renderer: async () => renderToMarkup,",
    "});",
    "",
    "await runPrerender({",
    "  routes,",
    `  routesDir: ${JSON.stringify(routesDir)},`,
    "  loadRoute,",
    "  handler,",
    "  staticConfig: config,",
    `  clientDir: ${JSON.stringify(resolvePath(projectRoot, "dist/client"))},`,
    ...(canary === undefined ? [] : [`  canary: ${JSON.stringify(canary)},`]),
    "});",
    "",
  ].join("\n");
}

function environmentName(context: unknown): string {
  const environment = (context as { environment?: { name?: string } } | undefined)?.environment;
  return environment?.name ?? "client";
}

function invalidateVirtualModules(server: ViteDevServer): void {
  const graphs: ModuleGraphLike[] = [server.moduleGraph as unknown as ModuleGraphLike];
  const environments = (server as unknown as { environments?: Record<string, { moduleGraph?: unknown }> })
    .environments;
  if (environments !== undefined) {
    for (const environment of Object.values(environments)) {
      if (environment.moduleGraph !== undefined) {
        graphs.push(environment.moduleGraph as ModuleGraphLike);
      }
    }
  }

  for (const graph of graphs) {
    for (const name of Object.values(VIRTUAL_MODULES)) {
      for (const module of graph.getModulesByFile(`\0${name}`) ?? []) {
        graph.invalidateModule(module);
      }
    }
  }
}
