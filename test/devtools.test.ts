import { expect, test } from "bun:test";
import { emptyDevtoolsData, renderDevtoolsHtml, type DevtoolsData } from "../src/devtools";

const sample: DevtoolsData = {
  routes: [
    { path: "/", kind: "page", file: "src/routes/index.tsx" },
    { path: "/users/:id", kind: "page", file: "src/routes/users/[id].tsx" },
    { path: "/", kind: "layout", file: "src/routes/_layout.tsx" },
  ],
  apiRoutes: [{ path: "/api/webhooks/:provider", kind: "api", file: "src/api/webhooks/[provider].ts" }],
  serverFns: [{ file: "src/lib/tasks.server.ts", name: "addNote", hash: "0f0e0d0c0b0a0908" }],
  canary: true,
  version: "0.1.12",
};

test("Addendum I.4: devtools merender route, fn registry, dan status payload-scan", () => {
  const html = renderDevtoolsHtml(sample);
  expect(html).toContain("moons devtools");
  expect(html).toContain("/users/:id");
  expect(html).toContain("src/routes/users/[id].tsx");
  expect(html).toContain("src/routes/_layout.tsx");
  expect(html).toContain("0f0e0d0c0b0a0908");
  expect(html).toContain("addNote");
  expect(html).toContain("/api/webhooks/:provider");
  expect(html).toContain("aktif");
  expect(html).toContain("0.1.12");
  expect(html).toContain("Routes (3)");
  expect(html).toContain("serverFn registry (1)");
});

test("Addendum I.4: devtools meng-escape nilai (tidak ada HTML injection)", () => {
  const html = renderDevtoolsHtml({
    ...emptyDevtoolsData(),
    routes: [{ path: '/<script>alert("x")</script>', kind: "page", file: "a<b>.tsx" }],
  });
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;script&gt;alert");
  expect(html).toContain("a&lt;b&gt;.tsx");
});

test("Addendum I.4: devtools menampilkan keadaan kosong", () => {
  const html = renderDevtoolsHtml(emptyDevtoolsData());
  expect(html).toContain("(kosong)");
  expect(html).toContain("(tidak ada serverFn)");
  expect(html).toContain("nonaktif");
});
