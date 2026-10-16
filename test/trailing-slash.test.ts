import { expect, test } from "bun:test";
import type { MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import { createTestServer } from "@moonsjs/vite/server";
import { createElement } from "react";

const routes: RouteDefinition[] = [
  { path: "/", file: "/p/src/routes/index.tsx", kind: "page", params: [] },
  { path: "/about", file: "/p/src/routes/about.tsx", kind: "page", params: [] },
];

const loadRoute: Record<string, () => Promise<RouteModule>> = {
  index: async () => ({ default: () => createElement("h1", null, "home") }),
  about: async () => ({ default: () => createElement("h1", null, "about") }),
};

function server(policy: "never" | "always") {
  const config: MoonsConfig = {
    routesDir: "src/routes",
    context: () => ({}),
    trailingSlash: policy,
  };
  return createTestServer({ routes, config, routesDir: "/p/src/routes", loadRoute });
}

test("M: handler — never: /about/ → 308 /about, query dipertahankan", async () => {
  const s = server("never");

  const res = await s.fetch("/about/?a=1");
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("http://localhost/about?a=1");

  const ok = await s.fetch("/about");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("about");
});

test("M: handler — always: /about → 308 /about/; root/_moons/aset dikecualikan", async () => {
  const s = server("always");

  const res = await s.fetch("/about");
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("http://localhost/about/");

  const ok = await s.fetch("/about/");
  expect(ok.status).toBe(200);

  const root = await s.fetch("/");
  expect(root.status).toBe(200);

  const health = await s.fetch("/_moons/health");
  expect(health.status).toBe(200);

  const asset = await s.fetch("/assets/app.js");
  expect(asset.status).not.toBe(308);
});

test("M: tanpa config trailingSlash → tanpa redirect (perilaku lama)", async () => {
  const config: MoonsConfig = { routesDir: "src/routes", context: () => ({}) };
  const s = createTestServer({ routes, config, routesDir: "/p/src/routes", loadRoute });
  const res = await s.fetch("/about/?x=1");
  expect(res.status).toBe(200);
});
