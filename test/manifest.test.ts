import { expect, test } from "bun:test";
import { scanRoutes } from "@moonsjs/core";
import { buildClientManifest, renderRoutesModule } from "../src/manifest";
import { makeProject } from "./helpers";

test("manifest client memuat page + layout chain root→leaf", () => {
  const project = makeProject([
    "_layout.tsx",
    "index.tsx",
    "users/_layout.tsx",
    "users/[id].tsx",
    "docs/[...rest].tsx",
  ]);

  const routes = scanRoutes(project.routesDir);
  const manifest = buildClientManifest(routes, project.routesDir);

  expect(manifest["index"]).toEqual({ page: "index", layouts: ["_layout"] });
  expect(manifest["users/[id]"]).toEqual({
    page: "users/[id]",
    layouts: ["_layout", "users/_layout"],
  });
  expect(manifest["docs/[...rest]"]).toEqual({
    page: "docs/[...rest]",
    layouts: ["_layout"],
  });
});

test("renderRoutesModule menghasilkan import() root-relative + manifest", () => {
  const project = makeProject(["_layout.tsx", "index.tsx", "users/[id].tsx"]);
  const routes = scanRoutes(project.routesDir);
  const source = renderRoutesModule(routes, project.routesDir, project.root);

  expect(source).toContain('"index": () => import("/src/routes/index.tsx")');
  expect(source).toContain('"users/[id]": () => import("/src/routes/users/[id].tsx")');
  expect(source).toContain('"users/[id]": {');
  expect(source).toContain('"layouts": [');
});
