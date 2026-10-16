import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MoonsError, type MoonsErrorCode } from "@moonsjs/core";
import {
  analyzeServerFile,
  checkClientModuleImports,
  renderServerFnStub,
} from "../src/transform";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "moons-j4-"));
}

function writeFile(root: string, relative: string, content: string): string {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

async function check(options: {
  root: string;
  source: string;
  resolve: (specifier: string) => string | null;
  analyze?: (file: string) => ReturnType<typeof analyzeServerFile>;
  configFile?: string;
  serverDir?: string;
}): Promise<unknown> {
  const file = writeFile(options.root, "src/routes/probe.tsx", options.source);
  try {
    await checkClientModuleImports({
      file,
      code: options.source,
      projectRoot: options.root,
      resolve: (specifier) => options.resolve(specifier),
      analyze: options.analyze ?? (() => null),
      ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
      ...(options.serverDir === undefined ? {} : { serverDir: options.serverDir }),
    });
    return null;
  } catch (error) {
    return error;
  }
}

function expectCode(error: unknown, code: MoonsErrorCode): MoonsError {
  expect(error).toBeInstanceOf(MoonsError);
  const moons = error as MoonsError;
  expect(moons.code).toBe(code);
  return moons;
}

test("J.4: impor `moons.config.ts` dari modul client ditolak", async () => {
  const root = makeTempDir();
  const configFile = writeFile(root, "moons.config.ts", "export default {};");
  const error = await check({
    root,
    source: 'import config from "../../moons.config";\nexport default config;',
    resolve: (specifier) => (specifier.endsWith("moons.config") ? configFile : null),
    configFile,
  });
  expectCode(error, "E_FORBIDDEN_SERVER_IMPORT");
});

test("J.4: impor nilai dari `src/server/**` (non-suffix) ditolak; type-only lolos", async () => {
  const root = makeTempDir();
  const serverDir = join(root, "src/server");
  const helper = writeFile(root, "src/server/helpers.ts", "export const X = 1;");

  const valueError = await check({
    root,
    source: 'import { X } from "../server/helpers";\nexport default X;',
    resolve: () => helper,
    serverDir,
  });
  expectCode(valueError, "E_FORBIDDEN_SERVER_IMPORT");

  const typeOnly = await check({
    root,
    source: 'import type { X } from "../server/helpers";\nexport default 1;',
    resolve: () => helper,
    serverDir,
  });
  expect(typeOnly).toBeNull();
});

test("J.5: `import type` dari *.server.ts lolos; impor nilai tetap ditolak", async () => {
  const root = makeTempDir();
  const secret = writeFile(
    root,
    "src/server/secrets.server.ts",
    'import { serverFn } from "@moonsjs/server";\nexport type SecretKind = { kind: string };\nexport const SECRET = "x";\nexport const ping = "fn";',
  );
  const analysis = analyzeServerFile(
    'import { serverFn } from "@moonsjs/server";\nexport type SecretKind = { kind: string };\nexport const SECRET = "x";\nexport const ping = "fn";',
    secret,
    root,
  );

  const statementType = await check({
    root,
    source:
      'import type { SecretKind } from "../server/secrets.server";\nconst v: SecretKind = { kind: "a" };\nexport default v;',
    resolve: () => secret,
    analyze: () => analysis,
  });
  expect(statementType).toBeNull();

  const inlineType = await check({
    root,
    source:
      'import { type SecretKind } from "../server/secrets.server";\nconst v: SecretKind = { kind: "a" };\nexport default v;',
    resolve: () => secret,
    analyze: () => analysis,
  });
  expect(inlineType).toBeNull();

  const value = await check({
    root,
    source: 'import { SECRET } from "../server/secrets.server";\nexport default SECRET;',
    resolve: () => secret,
    analyze: () => analysis,
  });
  expectCode(value, "E_SERVER_IMPORT_IN_CLIENT");
});

test("J.4/D2: schema merujuk nilai server dari file lain → E_SCHEMA_SERVER_REF", () => {
  const root = makeTempDir();
  const sourceA = 'export const SECRET_CONST = "x";';
  const fileA = writeFile(root, "src/server/a.server.ts", sourceA);
  const sourceB = [
    'import { serverFn } from "@moonsjs/server";',
    'import { z } from "zod";',
    'import { SECRET_CONST } from "./a.server";',
    "export const fn = serverFn({",
    '  input: z.object({ v: z.string().refine((x) => x !== SECRET_CONST) }),',
    "  output: z.object({ ok: z.boolean() }),",
    "  handler: async () => ({ ok: true }),",
    "});",
    "",
  ].join("\n");
  const fileB = writeFile(root, "src/server/b.server.ts", sourceB);
  const analysisB = analyzeServerFile(sourceB, fileB, root);
  expect(analysisB).not.toBeNull();

  let caught: unknown;
  try {
    renderServerFnStub(sourceB, fileB, analysisB!, {
      analyzeSpecifier: (sourceFile, specifier) =>
        specifier.includes("a.server") && sourceFile === fileB
          ? analyzeServerFile(sourceA, fileA, root)
          : null,
    });
  } catch (error) {
    caught = error;
  }
  const moons = expectCode(caught, "E_SCHEMA_SERVER_REF");
  expect(moons.message).toContain("SECRET_CONST");
});

test("J.4/D2: schema merujuk serverFn dari file lain tetap boleh", () => {
  const root = makeTempDir();
  const sourceA = [
    'import { serverFn } from "@moonsjs/server";',
    'import { z } from "zod";',
    "export const other = serverFn({",
    "  input: z.object({}),",
    "  output: z.object({ ok: z.boolean() }),",
    "  handler: async () => ({ ok: true }),",
    "});",
    "",
  ].join("\n");
  const fileA = writeFile(root, "src/server/a.server.ts", sourceA);
  const sourceB = [
    'import { serverFn } from "@moonsjs/server";',
    'import { z } from "zod";',
    'import { other } from "./a.server";',
    "export const fn = serverFn({",
    "  input: z.object({}),",
    "  output: z.object({ ok: z.boolean() }),",
    "  handler: async () => ({ ok: await other({}) }),",
    "});",
    "",
  ].join("\n");
  const fileB = writeFile(root, "src/server/b.server.ts", sourceB);
  const analysisB = analyzeServerFile(sourceB, fileB, root);
  expect(analysisB).not.toBeNull();
  // Tidak melempar: import serverFn diizinkan menyeberang.
  const result = renderServerFnStub(sourceB, fileB, analysisB!, {
    analyzeSpecifier: (sourceFile, specifier) =>
      specifier.includes("a.server") && sourceFile === fileB
        ? analyzeServerFile(sourceA, fileA, root)
        : null,
  });
  expect(result.code.length).toBeGreaterThan(0);
});
