import { expect, test } from "bun:test";
import type { Middleware, MoonsConfig, MoonsPlugin, RouteDefinition } from "@moonsjs/core";
import { createPluginRuntime } from "@moonsjs/vite/server";

function makeConfig(plugins: MoonsPlugin[]): MoonsConfig {
  return { routesDir: "src/routes", context: async () => ({}), middleware: [], plugins };
}

const routes: RouteDefinition[] = [
  { path: "/", file: "/p/src/routes/index.tsx", kind: "page", params: [] },
];

test("plugin §14.4: fase registrasi (addRoute beku → addMiddleware → extendContext) lalu start/ready/shutdown", async () => {
  const calls: string[] = [];
  const middleware: Middleware = async ({ next }) => next();

  const plugin = {
    name: "p",
    addRoute(route: RouteDefinition) {
      calls.push(`route:${route.path}`);
      expect(Object.isFrozen(route)).toBe(true);
    },
    addMiddleware() {
      calls.push("mw");
    },
    extendContext(register: (fn: (ctx: unknown) => unknown) => void) {
      register((ctx) => ({ extra: "x", seen: typeof ctx === "object" }));
      calls.push("extend");
    },
    onStart() {
      calls.push("start");
    },
    onReady() {
      calls.push("ready");
    },
    onShutdown() {
      calls.push("shutdown");
    },
  } as unknown as MoonsPlugin;

  const runtime = createPluginRuntime({ config: makeConfig([plugin]), routes, middlewares: [middleware] });
  // Registrasi selesai saat create; belum start.
  expect(calls).toEqual(["route:/", "mw", "extend"]);
  expect(runtime.app.ready).toBe(false);

  await runtime.start();
  await runtime.ready();
  expect(runtime.app.ready).toBe(true);
  await runtime.shutdown();
  expect(calls).toEqual(["route:/", "mw", "extend", "start", "ready", "shutdown"]);

  const ctx: Record<string, unknown> = {};
  runtime.applyExtensions(ctx);
  expect(ctx["extra"]).toBe("x");
  expect(ctx["seen"]).toBe(true);
});

test("onShutdown error dilaporkan, tidak melempar; extendContext mutasi langsung juga bekerja", async () => {
  const logged: string[] = [];
  const plugin = {
    name: "bad",
    extendContext(register: (fn: (ctx: { flag?: boolean }) => void) => void) {
      register((ctx) => {
        ctx.flag = true;
      });
    },
    onShutdown() {
      throw new Error("boom-shutdown");
    },
  } as unknown as MoonsPlugin;

  const runtime = createPluginRuntime({
    config: makeConfig([plugin]),
    routes,
    middlewares: [],
    log: (message) => logged.push(message),
  });

  await runtime.shutdown();
  expect(logged.join("\n")).toContain("boom-shutdown");

  const ctx: { flag?: boolean } = {};
  runtime.applyExtensions(ctx);
  expect(ctx.flag).toBe(true);
});
