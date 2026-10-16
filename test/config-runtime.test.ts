import { expect, test } from "bun:test";
import type { MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import { createRequestHandler } from "@moonsjs/vite/server";
import { createElement } from "react";

const ROUTES: RouteDefinition[] = [
  { path: "/", file: "/proj/src/routes/index.tsx", kind: "page", params: [] },
];

function loadRoute(): Record<string, () => Promise<RouteModule>> {
  return {
    index: async () => ({ default: () => createElement("h1", null, "home") }),
  };
}

const shell = (markup: string, payload: string): string =>
  `<div id="root">${markup}</div><script id="__moons_data">${payload}</script>`;

function makeHandler(config: MoonsConfig) {
  return createRequestHandler({
    routes: ROUTES,
    config,
    routesDir: "/proj/src/routes",
    loadRoute: loadRoute(),
    shell,
  });
}

function baseConfig(extra: Partial<MoonsConfig> = {}): MoonsConfig {
  return { routesDir: "src/routes", context: () => ({ requestId: "r1" }), ...extra };
}

test("Addendum H: header statis dipasang bila belum ada", async () => {
  const handler = makeHandler(baseConfig({ headers: { "x-frame-options": "DENY" } }));
  const response = await handler(new Request("http://example.com/"));
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("Addendum H: redirect runtime (301 default) + dilewati saat prerender", async () => {
  const handler = makeHandler(
    baseConfig({ redirects: [{ from: "/lama", to: "/about" }] }),
  );

  const redirect = await handler(new Request("http://example.com/lama"));
  expect(redirect.status).toBe(301);
  expect(redirect.headers.get("location")).toBe("http://example.com/about");

  // Tanpa slash akhir juga cocok.
  const redirectNoSlash = await handler(new Request("http://example.com/lama/"));
  expect(redirectNoSlash.status).toBe(301);

  // Saat prerender, redirect tidak boleh memotong rendering.
  const prerender = await handler(
    new Request("http://example.com/", { headers: { "x-moons-prerender": "1" } }),
  );
  expect(prerender.status).toBe(200);
  expect(await prerender.text()).toContain("home");
});

test("Addendum H: hook onRequest/onResponse berjalan; onResponse boleh mengganti respons", async () => {
  const seen: string[] = [];
  const handler = makeHandler(
    baseConfig({
      headers: { "x-app": "docs" },
      hooks: {
        onRequest: () => {
          seen.push("request");
        },
        onResponse: (response) => {
          seen.push("response");
          return new Response("diganti", {
            status: 201,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    }),
  );

  const response = await handler(new Request("http://example.com/"));
  expect(seen).toEqual(["request", "response"]);
  expect(response.status).toBe(201);
  expect(await response.text()).toBe("diganti");
  // Header statis tetap menempel di respons pengganti.
  expect(response.headers.get("x-app")).toBe("docs");
});

test("Addendum H: error pada onRequest → onError dipanggil, respons 500", async () => {
  const seen: string[] = [];
  const handler = makeHandler(
    baseConfig({
      hooks: {
        onRequest: () => {
          throw new Error("boom-hook");
        },
        onError: () => {
          seen.push("error");
        },
      },
    }),
  );

  const response = await handler(new Request("http://example.com/"));
  expect(response.status).toBe(500);
  expect(seen).toEqual(["error"]);
});
