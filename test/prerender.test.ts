import { expect, test } from "bun:test";
import { MoonsError, type RouteDefinition, type RouteModule } from "@moonsjs/core";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrerender } from "../src/server/prerender";

function makeClientDir(): string {
  return mkdtempSync(join(tmpdir(), "moons-prerender-"));
}

const ROUTES_DIR = "/proj/src/routes";

function page(file: string, path: string, params: string[] = []): RouteDefinition {
  return { path, file, kind: "page", params };
}

function makeOptions(input: {
  routes: RouteDefinition[];
  modules: Record<string, Partial<RouteModule>>;
  handler: (request: Request) => Promise<Response>;
  clientDir: string;
  canary?: string;
  env?: Record<string, string | undefined>;
  staticConfig?: {
    headers?: Record<string, string>;
    redirects?: Array<{ from: string; to: string; status?: number }>;
    sitemap?: { site: string; exclude?: string[] };
    robots?: { sitemap?: boolean; disallow?: string[] };
  };
}) {
  const loadRoute: Record<string, () => Promise<RouteModule>> = {};
  for (const [key, module] of Object.entries(input.modules)) {
    loadRoute[key] = async () => ({ default: () => null, ...module });
  }
  return {
    routes: input.routes,
    routesDir: ROUTES_DIR,
    loadRoute,
    handler: input.handler,
    clientDir: input.clientDir,
    ...(input.canary === undefined ? {} : { canary: input.canary }),
    ...(input.staticConfig === undefined ? {} : { staticConfig: input.staticConfig }),
    env: input.env ?? {},
    log: () => {},
  };
}

test("prerender: route statis & dynamic (paths) ditulis ke dist/client", async () => {
  const clientDir = makeClientDir();
  const options = makeOptions({
    routes: [
      page(`${ROUTES_DIR}/index.tsx`, "/"),
      page(`${ROUTES_DIR}/blog/[slug].tsx`, "/blog/:slug", ["slug"]),
    ],
    modules: {
      index: { prerender: true },
      "blog/[slug]": {
        prerender: true,
        paths: () => [{ slug: "hello" }, { slug: "kedua" }],
      },
    },
    handler: async (request) => {
      // D.5: penanda prerender dikirim ke handler (→ ctx.__prerender).
      expect(request.headers.get("x-moons-prerender")).toBe("1");
      return new Response(`<html><body>${new URL(request.url).pathname}</body></html>`);
    },
    clientDir,
  });

  const result = await runPrerender(options);
  expect(result.written).toBe(3);
  expect(readFileSync(join(clientDir, "index.html"), "utf8")).toContain("/");
  expect(readFileSync(join(clientDir, "blog/hello/index.html"), "utf8")).toContain("/blog/hello");
  expect(readFileSync(join(clientDir, "blog/kedua/index.html"), "utf8")).toContain("/blog/kedua");

  // route tanpa prerender tidak ditulis
  expect(existsSync(join(clientDir, "other/index.html"))).toBe(false);
});

test("prerender: notFound() (404) melewati path; redirect/status ≥400 → E_PRERENDER_INVALID", async () => {
  const clientDir = makeClientDir();
  const base = {
    routes: [page(`${ROUTES_DIR}/x.tsx`, "/x")],
    modules: { x: { prerender: true } },
    clientDir,
  };

  const skipped = await runPrerender(
    makeOptions({ ...base, handler: async () => new Response("nf", { status: 404 }) }),
  );
  expect(skipped).toEqual({ written: 0, skipped: 1 });
  expect(existsSync(join(clientDir, "x/index.html"))).toBe(false);

  for (const response of [
    new Response(null, { status: 302, headers: { location: "/" } }),
    new Response("boom", { status: 500 }),
  ]) {
    let thrown: unknown;
    try {
      await runPrerender(makeOptions({ ...base, handler: async () => response }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MoonsError);
    expect((thrown as MoonsError).code).toBe("E_PRERENDER_INVALID");
  }
});

test("prerender: dynamic tanpa paths → E_PRERENDER_NO_PATHS; bentuk paths salah → INVALID", async () => {
  const clientDir = makeClientDir();
  const handler = async () => new Response("ok");

  let noPaths: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/p/[id].tsx`, "/p/:id", ["id"])],
        modules: { "p/[id]": { prerender: true } },
        handler,
        clientDir,
      }),
    );
  } catch (error) {
    noPaths = error;
  }
  expect(noPaths).toBeInstanceOf(MoonsError);
  expect((noPaths as MoonsError).code).toBe("E_PRERENDER_NO_PATHS");

  for (const paths of [
    () => "bukan-array",
    () => [{ id: 1 }],
    () => [{ other: "x" }],
    () => [{ id: "" }],
  ]) {
    let thrown: unknown;
    try {
      await runPrerender(
        makeOptions({
          routes: [page(`${ROUTES_DIR}/p/[id].tsx`, "/p/:id", ["id"])],
          modules: { "p/[id]": { prerender: true, paths } },
          handler,
          clientDir,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MoonsError);
    expect((thrown as MoonsError).code).toBe("E_PRERENDER_INVALID");
  }
});

test("prerender: traversal (`..`) ditolak; `prerender` non-boolean ditolak", async () => {
  const clientDir = makeClientDir();
  const handler = async () => new Response("ok");

  let traversal: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/p/[id].tsx`, "/p/:id", ["id"])],
        modules: { "p/[id]": { prerender: true, paths: () => [{ id: ".." }] } },
        handler,
        clientDir,
      }),
    );
  } catch (error) {
    traversal = error;
  }
  expect((traversal as MoonsError).code).toBe("E_PRERENDER_INVALID");

  let nonBoolean: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/x.tsx`, "/x")],
        modules: { x: { prerender: "yes" } },
        handler,
        clientDir,
      }),
    );
  } catch (error) {
    nonBoolean = error;
  }
  expect((nonBoolean as MoonsError).code).toBe("E_PRERENDER_INVALID");
});

test("prerender: guard kebocoran fail-mode — canary & env rahasia → E_PRERENDER_LEAK", async () => {
  const clientDir = makeClientDir();
  const secret = "ssr-secret-value-123456";

  let canaryError: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/x.tsx`, "/x")],
        modules: { x: { prerender: true } },
        handler: async () => new Response("<html>MOONS_CANARY_X</html>"),
        clientDir,
        canary: "MOONS_CANARY_X",
      }),
    );
  } catch (error) {
    canaryError = error;
  }
  expect(canaryError).toBeInstanceOf(MoonsError);
  expect((canaryError as MoonsError).code).toBe("E_PRERENDER_LEAK");

  let envError: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/x.tsx`, "/x")],
        modules: { x: { prerender: true } },
        handler: async () => new Response(`<html>${secret}</html>`),
        clientDir,
        env: { DB_SECRET: secret },
      }),
    );
  } catch (error) {
    envError = error;
  }
  expect((envError as MoonsError).code).toBe("E_PRERENDER_LEAK");
  expect((envError as MoonsError).format()).toContain("env(DB_SECRET)");
});

test("Addendum G: 404.html ditulis bila `_404` ada; dilewati bila tidak ada/non-404; leak tetap fail-mode", async () => {
  const notFoundRoute: RouteDefinition = {
    path: "/",
    file: `${ROUTES_DIR}/_404.tsx`,
    kind: "404",
    params: [],
  };

  // 1) `_404` ada + sentinel 404 → `404.html` ditulis.
  const clientDir = makeClientDir();
  await runPrerender(
    makeOptions({
      routes: [page(`${ROUTES_DIR}/index.tsx`, "/"), notFoundRoute],
      modules: { index: { prerender: true } },
      handler: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/_moons/404") {
          return new Response("<html><body>HALAMAN-404-M9</body></html>", { status: 404 });
        }
        return new Response("<html><body>ok</body></html>");
      },
      clientDir,
    }),
  );
  expect(readFileSync(join(clientDir, "404.html"), "utf8")).toContain("HALAMAN-404-M9");

  // 2) Tanpa route `_404` → tidak ada file (static host memakai 404 bawaannya).
  const without404 = makeClientDir();
  await runPrerender(
    makeOptions({
      routes: [page(`${ROUTES_DIR}/index.tsx`, "/")],
      modules: { index: { prerender: true } },
      handler: async () => new Response("<html>ok</html>"),
      clientDir: without404,
    }),
  );
  expect(existsSync(join(without404, "404.html"))).toBe(false);

  // 3) `_404` ada tetapi sentinel bukan 404 (mis. catch-all selalu 200) → dilewati.
  const non404 = makeClientDir();
  await runPrerender(
    makeOptions({
      routes: [page(`${ROUTES_DIR}/index.tsx`, "/"), notFoundRoute],
      modules: { index: { prerender: true } },
      handler: async () => new Response("<html>semua-200</html>"),
      clientDir: non404,
    }),
  );
  expect(existsSync(join(non404, "404.html"))).toBe(false);

  // 4) Canary di body 404 → E_PRERENDER_LEAK (fail-mode, file 404.html).
  const leaky = makeClientDir();
  let thrown: unknown;
  try {
    await runPrerender(
      makeOptions({
        routes: [page(`${ROUTES_DIR}/index.tsx`, "/"), notFoundRoute],
        modules: { index: { prerender: true } },
        handler: async (request) =>
          new URL(request.url).pathname === "/_moons/404"
            ? new Response("<html>MOONS_CANARY_404</html>", { status: 404 })
            : new Response("<html>ok</html>"),
        clientDir: leaky,
        canary: "MOONS_CANARY_404",
      }),
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).code).toBe("E_PRERENDER_LEAK");
  expect((thrown as MoonsError).file).toContain("404.html");
});

test("Addendum H: staticConfig menulis _headers/_redirects/sitemap.xml/robots.txt", async () => {
  const clientDir = makeClientDir();
  await runPrerender(
    makeOptions({
      routes: [
        page(`${ROUTES_DIR}/index.tsx`, "/"),
        page(`${ROUTES_DIR}/about.tsx`, "/about"),
      ],
      modules: { index: { prerender: true }, about: { prerender: true } },
      handler: async () => new Response("<html>ok</html>"),
      clientDir,
      staticConfig: {
        headers: { "x-frame-options": "DENY" },
        redirects: [
          { from: "/lama", to: "/about" },
          { from: "/pindah", to: "https://example.com", status: 302 },
        ],
        sitemap: { site: "https://example.com", exclude: ["/skip"] },
        robots: { disallow: ["/internal"] },
      },
    }),
  );

  expect(readFileSync(join(clientDir, "_headers"), "utf8")).toBe("/*\n  x-frame-options: DENY\n");
  expect(readFileSync(join(clientDir, "_redirects"), "utf8")).toBe(
    "/lama /about 301\n/pindah https://example.com 302\n",
  );
  const sitemap = readFileSync(join(clientDir, "sitemap.xml"), "utf8");
  expect(sitemap).toContain("<loc>https://example.com/</loc>");
  expect(sitemap).toContain("<loc>https://example.com/about</loc>");
  const robots = readFileSync(join(clientDir, "robots.txt"), "utf8");
  expect(robots).toContain("Disallow: /internal");
  expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");

  // Tanpa staticConfig → tidak ada file deploy kit (opt-in).
  const bare = makeClientDir();
  await runPrerender(
    makeOptions({
      routes: [page(`${ROUTES_DIR}/index.tsx`, "/")],
      modules: { index: { prerender: true } },
      handler: async () => new Response("ok"),
      clientDir: bare,
    }),
  );
  expect(existsSync(join(bare, "_headers"))).toBe(false);
  expect(existsSync(join(bare, "_redirects"))).toBe(false);
  expect(existsSync(join(bare, "sitemap.xml"))).toBe(false);
  expect(existsSync(join(bare, "robots.txt"))).toBe(false);
});
