import type { MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import { createRequestHandler } from "./handler";
import { DEFAULT_TEMPLATE, injectShell, type Shell } from "./shell";

export interface TestServerOptions {
  routes: RouteDefinition[];
  config: MoonsConfig;
  routesDir: string;
  loadRoute: Record<string, () => Promise<RouteModule>>;
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
    shell,
  });

  return {
    handler,
    fetch: (input: string, init?: RequestInit) =>
      handler(new Request(new URL(input, baseUrl), init)),
  };
}
