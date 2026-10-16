import { MOONS_VERSION, type App, type Middleware, type MoonsConfig, type RouteDefinition } from "@moonsjs/core";

/**
 * Eksekusi lifecycle plugin (PRD §14.4 / Addendum B.4).
 * Urutan: registrasi (addRoute per route → addMiddleware per middleware →
 * extendContext(register)) → onStart → ready/onReady → shutdown/onShutdown.
 */
export interface PluginRuntime {
  readonly app: App;
  /** Registrasi + `onStart` (sebelum server siap). */
  start(): Promise<void>;
  /** Tandai `app.ready = true` lalu panggil `onReady` (server siap). */
  ready(): Promise<void>;
  /** Panggil `onShutdown` (selama drain; error dilaporkan, tidak menggagalkan). */
  shutdown(): Promise<void>;
  /** Terapkan extender `extendContext` ke ctx request (dipanggil handler). */
  applyExtensions(ctx: unknown): void;
}

export interface PluginRuntimeOptions {
  config: MoonsConfig;
  routes: RouteDefinition[];
  /** Rantai middleware final (config.middleware). */
  middlewares: Middleware[];
  log?: (message: string) => void;
}

export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const log = options.log ?? ((message: string) => console.warn(message));
  const plugins = options.config.plugins ?? [];
  const state = { ready: false, version: MOONS_VERSION };
  const app = state as App;
  const extensions: Array<(ctx: unknown) => unknown> = [];
  const register = (fn: (ctx: unknown) => unknown): void => {
    extensions.push(fn);
  };

  // Fase registrasi (sinkron): addRoute → addMiddleware → extendContext.
  for (const plugin of plugins) {
    for (const route of options.routes) {
      // Objek beku: hook bersifat observasi di v1 (lihat docs/decisions/0022).
      const frozen = Object.freeze({
        ...route,
        params: [...route.params],
      }) as RouteDefinition;
      plugin.addRoute?.(frozen);
    }
    for (const middleware of options.middlewares) {
      plugin.addMiddleware?.(middleware);
    }
    plugin.extendContext?.(register as never);
  }

  return {
    app,
    async start(): Promise<void> {
      for (const plugin of plugins) {
        await plugin.onStart?.(app);
      }
    },
    async ready(): Promise<void> {
      state.ready = true;
      for (const plugin of plugins) {
        await plugin.onReady?.(app);
      }
    },
    async shutdown(): Promise<void> {
      for (const plugin of plugins) {
        try {
          await plugin.onShutdown?.(app);
        } catch (error) {
          log(`[moons] plugin \`${plugin.name}\` gagal saat onShutdown: ${String(error)}`);
        }
      }
    },
    applyExtensions(ctx: unknown): void {
      for (const extend of extensions) {
        const result = extend(ctx);
        if (result !== null && typeof result === "object" && !Array.isArray(result)) {
          Object.assign(ctx as Record<string, unknown>, result);
        }
      }
    },
  };
}
