import { expect, test } from "bun:test";
import type { MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import { createTestServer } from "@moonsjs/vite/server";
import { createElement } from "react";

const routes: RouteDefinition[] = [
  { path: "/", file: "/proj/src/routes/index.tsx", kind: "page", params: [] },
];

const config: MoonsConfig = {
  routesDir: "src/routes",
  context: () => ({ requestId: "test" }),
};

const loadRoute: Record<string, () => Promise<RouteModule>> = {
  index: async () => ({ default: () => createElement("h1", null, "home") }),
};

function makeServer() {
  return createTestServer({ routes, config, routesDir: "/proj/src/routes", loadRoute });
}

test("createTestServer: tanpa port, dispatch langsung ke handler", async () => {
  const server = makeServer();

  const response = await server.fetch("/");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("home");
  expect(html).toContain('id="root"');
  expect(html).toContain("__moons_data");
});

test("createTestServer: health → { ok: true } dan 404 tersedia", async () => {
  const server = makeServer();

  const health = await server.fetch("/_moons/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  const missing = await server.fetch("/tidak-ada");
  expect(missing.status).toBe(404);
});
