import { expect, test } from "bun:test";
import { MoonsError } from "@moonsjs/core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SERVER_ONLY_PACKAGES,
  createServerOnlyClassifier,
  packageNameFromSpecifier,
  readPackageJsonFrom,
  tryReadPackageJson,
} from "../src/server-only";
import { checkClientModuleImports } from "../src/transform";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "moons-so-"));
}

function writeFile(root: string, rel: string, content: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function writePackage(
  root: string,
  rel: string,
  json: Record<string, unknown>,
  files: Record<string, string> = { "index.js": "export const x = 1;\n" },
): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json, null, 2) + "\n");
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function fixtureRoot(): string {
  const root = makeRoot();
  writeFile(root, "package.json", JSON.stringify({ name: "app", private: true }));
  writeFile(root, "src/routes/index.tsx", "export default function P() { return null; }\n");
  writePackage(root, "node_modules/pg", { name: "pg", main: "index.js" });
  writePackage(root, "node_modules/@prisma/client", { name: "@prisma/client", main: "index.js" }, {
    "index.js": "export const c = 1;\n",
    "runtime/index.js": "export const r = 1;\n",
  });
  writePackage(root, "node_modules/so-marked", {
    name: "so-marked",
    main: "index.js",
    moons: { serverOnly: true },
  });
  writePackage(root, "node_modules/my-db", { name: "my-db", main: "index.js" });
  writePackage(root, "node_modules/react", { name: "react", main: "index.js" });
  return root;
}

// ---------------------------------------------------------------------------
// Classifier (unit)
// ---------------------------------------------------------------------------

test("packageNameFromSpecifier: bare, scoped, subpath; relatif/absolute/node: → null", () => {
  expect(packageNameFromSpecifier("pg")).toBe("pg");
  expect(packageNameFromSpecifier("pg/lib/x")).toBe("pg");
  expect(packageNameFromSpecifier("@prisma/client")).toBe("@prisma/client");
  expect(packageNameFromSpecifier("@prisma/client/runtime")).toBe("@prisma/client");
  expect(packageNameFromSpecifier("./x")).toBeNull();
  expect(packageNameFromSpecifier("/abs")).toBeNull();
  expect(packageNameFromSpecifier("node:fs")).toBeNull();
  expect(packageNameFromSpecifier("bun:sqlite")).toBeNull();
  expect(packageNameFromSpecifier("\0virtual")).toBeNull();
});

test("classifier: daftar bawaan (root/subpath/scoped), config, marker, dan non-match", () => {
  const root = fixtureRoot();
  const importer = join(root, "src/routes/index.tsx");
  const check = (specifier: string, resolved: string | null) =>
    createServerOnlyClassifier({ configured: ["my-db"] }).check({
      specifier,
      resolvedFile: resolved,
      importerFile: importer,
    });

  expect(check("pg", join(root, "node_modules/pg/index.js"))).toMatchObject({
    packageName: "pg",
    source: "builtin",
  });
  expect(
    check("@prisma/client/runtime", join(root, "node_modules/@prisma/client/runtime/index.js")),
  ).toMatchObject({ packageName: "@prisma/client", source: "builtin" });
  expect(check("my-db", join(root, "node_modules/my-db/index.js"))).toMatchObject({
    packageName: "my-db",
    source: "config",
  });
  expect(check("so-marked", join(root, "node_modules/so-marked/index.js"))).toMatchObject({
    packageName: "so-marked",
    source: "marker",
  });
  expect(check("react", join(root, "node_modules/react/index.js"))).toBeNull();
  expect(check("pg", null)).toBeNull();
});

test("classifier: import di dalam package yang sama diabaikan; daftar bawaan memuat entri wajib", () => {
  const root = fixtureRoot();
  const own = join(root, "node_modules/pg/index.js");
  const classifier = createServerOnlyClassifier();
  expect(
    classifier.check({ specifier: "./helper", resolvedFile: join(root, "node_modules/pg/other.js"), importerFile: own }),
  ).toBeNull();

  for (const name of ["pg", "drizzle-orm", "@prisma/client", "sharp", "@libsql/client"]) {
    expect(DEFAULT_SERVER_ONLY_PACKAGES).toContain(name);
  }
});

test("readPackageJsonFrom/tryReadPackageJson: menelusuri ke atas; marker terbaca", () => {
  const root = fixtureRoot();
  const deep = writeFile(root, "src/routes/deep/x.ts", "export {};\n");
  expect(readPackageJsonFrom(deep)?.name).toBe("app");
  expect(tryReadPackageJson(join(root, "node_modules/so-marked"))?.serverOnlyMarker).toBe(true);
  expect(tryReadPackageJson(join(root, "node_modules/react"))?.serverOnlyMarker).toBe(false);
});

// ---------------------------------------------------------------------------
// Integrasi checkClientModuleImports (gate build)
// ---------------------------------------------------------------------------

async function checkSource(
  root: string,
  source: string,
  options: { configured?: string[]; resolveMap?: Record<string, string> } = {},
): Promise<unknown> {
  const file = writeFile(root, "src/routes/probe.tsx", source);
  const resolveMap = options.resolveMap ?? {};
  try {
    await checkClientModuleImports({
      file,
      code: source,
      projectRoot: root,
      resolve: (specifier: string) => {
        const mapped = resolveMap[specifier];
        if (mapped !== undefined) {
          return mapped;
        }
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
          return join(dirname(file), specifier.replace(/^\.\//, ""));
        }
        return join(root, "node_modules", specifier, "index.js");
      },
      analyze: () => null,
      serverOnlyPackages: options.configured ?? [],
    });
    return null;
  } catch (error) {
    return error;
  }
}

function expectForbidden(error: unknown, substrings: string[]): MoonsError {
  expect(error).toBeInstanceOf(MoonsError);
  const moons = error as MoonsError;
  expect(moons.code).toBe("E_FORBIDDEN_SERVER_IMPORT");
  expect(moons.format()).toContain("Suggestion:");
  for (const needle of substrings) {
    expect(moons.format()).toContain(needle);
  }
  return moons;
}

test("gate: import langsung paket bawaan → E_FORBIDDEN_SERVER_IMPORT (sumber + file:line)", async () => {
  const root = fixtureRoot();
  const error = await checkSource(root, 'import { x } from "pg";\nexport default function P() { return <div>{x}</div>; }\n');
  const moons = expectForbidden(error, ["built-in", "probe.tsx"]);
  expect(moons.format()).toContain("pg");
});

test("gate: subpath scoped + paket marker juga ditolak", async () => {
  const root = fixtureRoot();
  const sub = await checkSource(root, 'import { r } from "@prisma/client/runtime";\nexport default function P() { return <div>{r}</div>; }\n');
  expectForbidden(sub, ["@prisma/client", "built-in"]);

  const marker = await checkSource(root, 'import { x } from "so-marked";\nexport default function P() { return <div>{x}</div>; }\n');
  expectForbidden(marker, ["marker", "serverOnly", "so-marked"]);
});

test("gate: `security.serverOnlyPackages` menambah daftar", async () => {
  const root = fixtureRoot();
  const error = await checkSource(root, 'import { x } from "my-db";\nexport default function P() { return <div>{x}</div>; }\n', {
    configured: ["my-db"],
  });
  expectForbidden(error, ["serverOnlyPackages"]);
});

test("gate: export * / re-export / dynamic import ikut ditolak", async () => {
  const root = fixtureRoot();
  expectForbidden(
    await checkSource(root, 'export * from "pg";\n'),
    ["pg"],
  );
  expectForbidden(
    await checkSource(root, 'export { x as y } from "pg";\n'),
    ["pg"],
  );
  const dynamic = await checkSource(
    root,
    'export default function P() { const load = async () => await import("pg"); return <button onClick={load}>x</button>; }\n',
  );
  expectForbidden(dynamic, ["(dynamic)", "pg"]);
});

test("gate: type-only dikecualikan; campuran nilai+tipe tetap ditolak", async () => {
  const root = fixtureRoot();
  // import type → lolos
  expect(
    await checkSource(root, 'import type { Pool } from "pg";\nexport default function P() { return <div/>; }\n'),
  ).toBeNull();
  // seluruh specifier bertipe → lolos
  expect(
    await checkSource(root, 'import { type Pool } from "pg";\nexport default function P() { return <div/>; }\n'),
  ).toBeNull();
  // export type → lolos
  expect(await checkSource(root, 'export type { Pool } from "pg";\n')).toBeNull();
  // campuran → ditolak
  expectForbidden(
    await checkSource(root, 'import { type Pool, Client } from "pg";\nexport default function P() { return <div>{Client}</div>; }\n'),
    ["pg"],
  );
});

test("gate: paket biasa dan import relatif tidak terpengaruh", async () => {
  const root = fixtureRoot();
  expect(
    await checkSource(root, 'import { useMemo } from "react";\nexport default function P() { return <div>{useMemo(() => 1, [])}</div>; }\n'),
  ).toBeNull();
});
