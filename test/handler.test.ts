import { expect, test } from "bun:test";
import type { LoaderRunArgs, MoonsConfig, RouteDefinition, RouteModule } from "@moonsjs/core";
import { decodeSsrPayload } from "@moonsjs/core/serialize";
import { appendHeader, notFound, redirect, setCookie, setHeader } from "@moonsjs/core";
import { useRouteError, useSearchParams } from "@moonsjs/react";
import { createRequestHandler } from "@moonsjs/vite/server";
import { createElement } from "react";

/** React menambahkan komentar pemisah text; normalisasi untuk assertion. */
function plain(text: string): string {
  return text.replaceAll("<!-- -->", "");
}

function makeConfig(): MoonsConfig {
  return {
    routesDir: "src/routes",
    context: () => ({ requestId: "r1" }),
  };
}

function makeRoutes(withCustom: boolean): RouteDefinition[] {
  const routes: RouteDefinition[] = [
    { path: "/", file: "/proj/src/routes/index.tsx", kind: "page", params: [] },
  ];
  if (withCustom) {
    routes.push({ path: "/", file: "/proj/src/routes/_error.tsx", kind: "error", params: [] });
    routes.push({ path: "/", file: "/proj/src/routes/_404.tsx", kind: "404", params: [] });
  }
  return routes;
}

function makeLoadRoute(options: { failWith?: "throw" | "response" } = {}): Record<
  string,
  () => Promise<RouteModule>
> {
  const loader: (args: LoaderRunArgs) => unknown =
    options.failWith === "throw"
      ? () => {
          throw new Error("boom-loader");
        }
      : options.failWith === "response"
        ? () => new Response("nope")
        : async () => ({});

  return {
    index: async (): Promise<RouteModule> => ({
      default: () => createElement("h1", null, "home"),
      loader,
    }),
    _error: async () => ({
      default: function ErrorView() {
        const error = useRouteError();
        const label =
          error instanceof Error
            ? error.message.split("\n")[0]
            : error === undefined
              ? "none"
              : "value";
        return createElement("p", null, `err:${label}`);
      },
    }),
    _404: async () => ({
      default: () => createElement("p", null, "custom-404"),
    }),
  };
}

const shell = (markup: string, payload: string): string =>
  `<!--shell--><div id="root">${markup}</div><script id="__moons_data">${payload}</script>`;

function makeHandler(options: {
  withCustom?: boolean;
  failWith?: "throw" | "response";
} = {}) {
  return createRequestHandler({
    routes: makeRoutes(options.withCustom ?? true),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: makeLoadRoute(options.failWith === undefined ? {} : { failWith: options.failWith }),
    shell,
  });
}

test("halaman normal → 200", async () => {
  const handler = makeHandler();
  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("home");
});

test("query string request → searchParams di markup + payload (Addendum A.3)", async () => {
  const handler = createRequestHandler({
    routes: makeRoutes(false),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: function QueryView() {
          const searchParams = useSearchParams();
          const month = searchParams["month"] ?? "-";
          const type = searchParams["type"] ?? "-";
          return createElement("p", null, `q:${month}:${type}`);
        },
        loader: async () => ({}),
      }),
    },
    shell,
  });

  const response = await handler(new Request("http://localhost/?month=2026-11&type=FIX"));
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(plain(body)).toContain("q:2026-11:FIX");

  const encoded = /<script id="__moons_data">([\s\S]*?)<\/script>/.exec(body)?.[1];
  expect(encoded).toBeDefined();
  const payload = decodeSsrPayload(encoded as string);
  expect(payload.searchParams).toEqual({ month: "2026-11", type: "FIX" });
});

test("meta(): hasil masuk payload + argumen ke-4 shell (Addendum B.1)", async () => {
  let captured: Record<string, unknown> | undefined;
  const handler = createRequestHandler({
    routes: makeRoutes(false),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: () => createElement("h1", null, "home"),
        loader: async () => ({ name: "Alice" }),
        meta: ({ data }: { data: { name: string } }) => ({
          title: `Halo ${data.name}`,
          description: "desc",
        }),
      }),
    },
    shell: (markup, payload, _url, meta) => {
      captured = meta;
      return `<!--shell--><div id="root">${markup}</div><script id="__moons_data">${payload}</script>`;
    },
  });

  const response = await handler(new Request("http://localhost/"));
  const body = await response.text();
  expect(captured).toEqual({ title: "Halo Alice", description: "desc" });

  const encoded = /<script id="__moons_data">([\s\S]*?)<\/script>/.exec(body)?.[1];
  expect(decodeSsrPayload(encoded as string).meta).toEqual(captured);
});

test("redirect(): 302 default + Location absolut; status eksplisit & URL absolut (Addendum B.2)", async () => {
  const makeRedirectHandler = (run: () => never) =>
    createRequestHandler({
      routes: makeRoutes(false),
      config: makeConfig(),
      routesDir: "/proj/src/routes",
      loadRoute: {
        index: async (): Promise<RouteModule> => ({
          default: () => createElement("h1", null, "home"),
          loader: async () => run(),
        }),
      },
      shell,
    });

  const relative = await makeRedirectHandler(() => redirect("/login"))(
    new Request("http://localhost/"),
  );
  expect(relative.status).toBe(302);
  expect(relative.headers.get("location")).toBe("http://localhost/login");

  const absolute = await makeRedirectHandler(() => redirect("https://example.com/x", 303))(
    new Request("http://localhost/"),
  );
  expect(absolute.status).toBe(303);
  expect(absolute.headers.get("location")).toBe("https://example.com/x");
});

test("notFound(): sinyal dirender sebagai _404 kustom + status 404 (Addendum B.2)", async () => {
  const handler = createRequestHandler({
    routes: makeRoutes(true),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: () => createElement("h1", null, "home"),
        loader: async () => notFound(),
      }),
      _404: async (): Promise<RouteModule> => ({
        default: () => createElement("p", null, "custom-404"),
      }),
    },
    shell,
  });

  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("custom-404");
});

test("_404 kustom dirender dengan status 404 + key manifest khusus", async () => {
  const handler = makeHandler();
  const response = await handler(new Request("http://localhost/tidak-ada"));
  const body = await response.text();
  expect(response.status).toBe(404);
  expect(body).toContain("custom-404");
  expect(body).toContain("__moons/404");
});

test("tanpa _404 kustom → halaman 404 bawaan", async () => {
  const handler = makeHandler({ withCustom: false });
  const response = await handler(new Request("http://localhost/tidak-ada"));
  const body = await response.text();
  expect(response.status).toBe(404);
  expect(body).toContain("Page not found");
});

test("loader error → _error kustom (500) dengan error dev", async () => {
  const handler = makeHandler({ failWith: "throw" });
  const response = await handler(new Request("http://localhost/"));
  const body = plain(await response.text());
  expect(response.status).toBe(500);
  expect(body).toContain("err:boom-loader");
  // D.3: payload memakai key file boundary (bukan konstanta global); key
  // ter-serialisasi devalue (kutip ter-escape) di dalam script payload.
  expect(body).toContain('\\"_error\\"');
});

test("production: _error kustom tanpa detail error di markup maupun payload", async () => {
  const previous = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    const handler = makeHandler({ failWith: "throw" });
    const response = await handler(new Request("http://localhost/"));
    const body = plain(await response.text());
    expect(response.status).toBe(500);
    expect(body).toContain("err:none");
    expect(body).not.toContain("boom-loader");
  } finally {
    if (previous === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = previous;
    }
  }
});

test("tanpa _error kustom → halaman 500 bawaan", async () => {
  const handler = makeHandler({ withCustom: false, failWith: "throw" });
  const response = await handler(new Request("http://localhost/"));
  const body = await response.text();
  expect(response.status).toBe(500);
  expect(body).toContain("Internal server error");
});

test("loader mengembalikan Response → E_INTERNAL sampai ke _error kustom", async () => {
  const handler = makeHandler({ failWith: "response" });
  const response = await handler(new Request("http://localhost/"));
  const body = plain(await response.text());
  expect(response.status).toBe(500);
  expect(body).toContain("err:[moons] E_INTERNAL");
});

test("A1: payloadScan (dev) memperingatkan canary & nilai env mirip-rahasia — sekali per label", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    const secret = "ssr-secret-value-123456";
    const canary = "MOONS_CANARY_X";
    const handler = createRequestHandler({
      routes: makeRoutes(false),
      config: makeConfig(),
      routesDir: "/proj/src/routes",
      loadRoute: {
        index: async (): Promise<RouteModule> => ({
          default: () => createElement("h1", null, "home"),
          loader: async () => ({ token: secret, marker: canary }),
        }),
      },
      shell,
      payloadScan: { canary, env: { DB_SECRET: secret, TOKEN_SHORT: "pendek" } },
    });

    await handler(new Request("http://localhost/"));
    await handler(new Request("http://localhost/"));
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("canary");
    expect(warnings.join("\n")).toContain("env(DB_SECRET)");
    expect(warnings.join("\n")).not.toContain("TOKEN_SHORT");
  } finally {
    console.warn = originalWarn;
  }
});

test("A1: tanpa payloadScan (production) tidak ada peringatan payload", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    const handler = createRequestHandler({
      routes: makeRoutes(false),
      config: makeConfig(),
      routesDir: "/proj/src/routes",
      loadRoute: {
        index: async (): Promise<RouteModule> => ({
          default: () => createElement("h1", null, "home"),
          loader: async () => ({ token: "ssr-secret-value-123456" }),
        }),
      },
      shell,
    });
    await handler(new Request("http://localhost/"));
    expect(warnings).toEqual([]);
  } finally {
    console.warn = originalWarn;
  }
});

test("D.2: loader setHeader/appendHeader/setCookie di-merge ke respons HTML", async () => {
  const handler = createRequestHandler({
    routes: makeRoutes(false),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: () => createElement("h1", null, "home"),
        loader: async () => {
          setHeader("x-loader", "1");
          appendHeader("x-dup", "a");
          appendHeader("x-dup", "b");
          setCookie("s", "v", { httpOnly: true });
          setCookie("t", "w");
          return {};
        },
      }),
    },
    shell,
  });

  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-loader")).toBe("1");
  const dup = response.headers.get("x-dup") ?? "";
  expect(dup).toContain("a");
  expect(dup).toContain("b");
  const cookies =
    typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const joined = cookies.join("\n");
  expect(joined).toContain("s=v");
  expect(joined).toContain("HttpOnly");
  expect(joined).toContain("t=w");
});

test("D.2: mutasi tetap diterapkan pada jalur error (loader throw)", async () => {
  const handler = createRequestHandler({
    routes: makeRoutes(false),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: () => createElement("h1", null, "home"),
        loader: async () => {
          setCookie("s", "v");
          throw new Error("boom");
        },
      }),
    },
    shell,
  });
  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(500);
  expect(response.headers.get("set-cookie") ?? "").toContain("s=v");
});

test("D.2: nilai header CRLF → E_RESPONSE_HEADER_INVALID (non-production)", async () => {
  const handler = createRequestHandler({
    routes: makeRoutes(false),
    config: makeConfig(),
    routesDir: "/proj/src/routes",
    loadRoute: {
      index: async (): Promise<RouteModule> => ({
        default: () => createElement("h1", null, "home"),
        loader: async () => {
          setHeader("x-a", "a\r\nx-injected: 1");
          return {};
        },
      }),
    },
    shell,
  });
  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("E_RESPONSE_HEADER_INVALID");
});
