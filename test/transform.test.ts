import { expect, test } from "bun:test";
import { MoonsError, computeFnHash, fnRegistryKey } from "@moonsjs/core";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeServerFile,
  buildFnRegistry,
  checkClientModuleImports,
  checkRouteModuleExports,
  injectServerFnMeta,
  isNonContractServerFile,
  isServerFilePath,
  isServerSpecifier,
  renderServerFnStub,
  resolveServerSpecifierSync,
  scanServerFiles,
} from "../src/transform";

const USERS_SERVER = `import { serverFn } from "@moonsjs/server";
import { z } from "zod";
import { db } from "./db.server";
import { readFileSync } from "node:fs";

const CANARY = "MOONS_LEAK_CANARY_7f3a91b2";

export const INTERNAL_HELPER = "jangan-bocor";

export const getUser = serverFn({
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), name: z.string() }),
  handler: async ({ input, ctx }) => {
    const secret = CANARY + INTERNAL_HELPER;
    if (secret.length === 0) throw new Error("unreachable");
    return { id: input.id, name: "Alice" };
  },
});

export const deleteUser = serverFn({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ input, ctx }) => ({ ok: input.id.length > 0 }),
});
`;

const SECRETS_SERVER = `export const INTERNAL_SECRET = "s3cr3t-sh0uld-n3v3r-l34k";\n`;

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "moons-transform-"));
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function makeContext(root: string) {
  return {
    resolve: (specifier: string, importer: string) =>
      resolveServerSpecifierSync(importer, specifier),
    analyze: (absoluteFile: string) => {
      try {
        return analyzeServerFile(readFileSync(absoluteFile, "utf8"), absoluteFile, root);
      } catch {
        return null;
      }
    },
  };
}

test("E_SCHEMA_LOCAL_REF: schema merujuk deklarasi lokal ditolak saat build (temuan eval ronde 2)", () => {
  const root = makeTempProject();
  const source = `import { serverFn } from "@moonsjs/server";
import { z } from "zod";

const pathSchema = z.object({ path: z.string() });

export const callThirdParty = serverFn({
  input: pathSchema,
  output: z.object({ ok: z.boolean() }),
  handler: async ({ input }) => ({ ok: input.path.length > 0 }),
});
`;
  const file = writeProjectFile(root, "src/server/tp.server.ts", source);
  const analysis = analyzeServerFile(source, file, root);

  let thrown: unknown;
  try {
    renderServerFnStub(source, file, analysis, { analyzeSpecifier: () => null });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(MoonsError);
  const moons = thrown as MoonsError;
  expect(moons.code).toBe("E_SCHEMA_LOCAL_REF");
  expect(moons.format()).toContain("pathSchema");
  expect(moons.format()).toContain("callThirdParty");
  // A4: contoh diff "Before/After" + saran konkret ada di pesan.
  expect(moons.format()).toContain("Before (rejected):");
  expect(moons.format()).toContain("After (pick one):");
  expect(moons.format()).toContain("src/shared/schemas.ts");
  expect(moons.format()).toContain("inline the schema");
  expect(moons.format()).toContain("Suggestion:");
});

test("schema inline & import dari modul shared tetap menghasilkan stub valid", () => {
  const root = makeTempProject();
  const source = `import { serverFn } from "@moonsjs/server";
import { z } from "zod";
import { sharedSchema } from "../shared/schemas";

export const inline = serverFn({
  input: z.object({ path: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

export const imported = serverFn({
  input: sharedSchema,
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});
`;
  const file = writeProjectFile(root, "src/server/ok.server.ts", source);
  const analysis = analyzeServerFile(source, file, root);
  const { code } = renderServerFnStub(source, file, analysis, { analyzeSpecifier: () => null });

  expect(code).toContain("sharedSchema");
  expect(code).toContain("__moons_createStub");
});

test("stub §12.3: hanya schema + hash, canary/handler/helper hilang", () => {
  const root = makeTempProject();
  const usersFile = writeProjectFile(root, "src/server/users.server.ts", USERS_SERVER);
  writeProjectFile(root, "src/server/db.server.ts", "export const db = {};\n");

  const analysis = analyzeServerFile(USERS_SERVER, usersFile, root);
  expect(analysis.serverFns.map((fn) => fn.name).sort()).toEqual(["deleteUser", "getUser"]);

  const { code } = renderServerFnStub(USERS_SERVER, usersFile, analysis, {
    analyzeSpecifier: (sourceFile, specifier) => {
      const resolved = resolveServerSpecifierSync(sourceFile, specifier);
      return resolved === null
        ? null
        : analyzeServerFile(
            readFileSync(resolved, "utf8"),
            resolved,
            root,
          );
    },
  });

  expect(code).toContain('import { __moons_createStub } from "@moonsjs/server/client";');
  expect(code).toContain('import { z } from "zod";');
  expect(code).not.toContain("@moonsjs/server\""); // import server asli diganti
  expect(code).not.toContain("CANARY");
  expect(code).not.toContain("MOONS_LEAK_CANARY");
  expect(code).not.toContain("INTERNAL_HELPER");
  expect(code).not.toContain("node:fs");
  expect(code).not.toContain("db.server");
  expect(code).not.toContain("async ({ input, ctx })");

  const getUserHash = computeFnHash(root, usersFile, "getUser");
  expect(code).toContain(`export const getUser = __moons_createStub({ hash: ${JSON.stringify(getUserHash)}, input: z.object({ id: z.string() })`);
});

test("re-export §12.6: export * di-expand, alias dipertahankan", () => {
  const root = makeTempProject();
  const usersFile = writeProjectFile(root, "src/server/users.server.ts", USERS_SERVER);
  writeProjectFile(root, "src/server/db.server.ts", "export const db = {};\n");
  const indexFile = writeProjectFile(
    root,
    "src/server/index.server.ts",
    'export * from "./users.server";\nexport { getUser as fetchUser } from "./users.server";\n',
  );

  const source = 'export * from "./users.server";\nexport { getUser as fetchUser } from "./users.server";\n';
  const analysis = analyzeServerFile(source, indexFile, root);
  const { code } = renderServerFnStub(source, indexFile, analysis, {
    analyzeSpecifier: (sourceFile, specifier) => {
      const resolved = resolveServerSpecifierSync(sourceFile, specifier);
      return resolved === null
        ? null
        : analyzeServerFile(
            readFileSync(resolved, "utf8"),
            resolved,
            root,
          );
    },
  });

  expect(code).toContain('export { getUser as fetchUser } from "./users.server";');
  expect(code).toContain('export { getUser, deleteUser } from "./users.server";');
});

test("injectServerFnMeta menambahkan meta §7.2 tanpa menyentuh handler", () => {
  const root = "/project";
  const file = "/project/src/server/users.server.ts";
  const analysis = analyzeServerFile(USERS_SERVER, file, root);
  const output = injectServerFnMeta(USERS_SERVER, analysis, root);

  expect(output).toContain(`__hash: ${JSON.stringify(computeFnHash(root, file, "getUser"))}`);
  expect(output).toContain('__file: "src/server/users.server.ts"');
  expect(output).toContain('__exportName: "getUser"');
  expect(output).toContain("CANARY"); // handler asli tetap utuh (env ssr)
  expect(fnRegistryKey(root, file, "getUser")).toBe("src/server/users.server.ts#getUser");
});

test("checkClientModuleImports §12.4/§12.7/§12.8", async () => {
  const root = makeTempProject();
  writeProjectFile(root, "src/server/users.server.ts", USERS_SERVER);
  writeProjectFile(root, "src/server/db.server.ts", "export const db = {};\n");
  writeProjectFile(root, "src/server/secrets.server.ts", SECRETS_SERVER);
  const context = makeContext(root);

  const clientFile = join(root, "src/routes/dashboard.tsx");

  const bad = 'import { INTERNAL_SECRET } from "../server/secrets.server";\nexport default () => INTERNAL_SECRET;\n';
  let thrown: unknown;
  try {
    await checkClientModuleImports({ file: clientFile, code: bad, projectRoot: root, ...context });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  const error = thrown as MoonsError;
  expect(error.code).toBe("E_SERVER_IMPORT_IN_CLIENT");
  expect(error.format()).toContain("src/routes/dashboard.tsx:1");
  expect(error.format()).toContain("importing `INTERNAL_SECRET` from src/server/secrets.server.ts");
  expect(error.format()).toContain("Suggestion:");

  const okServerFn =
    'import { getUser } from "../server/users.server";\nexport const load = () => getUser({ input: { id: "u1" } });\n';
  await checkClientModuleImports({ file: clientFile, code: okServerFn, projectRoot: root, ...context });

  await expect(
    checkClientModuleImports({
      file: clientFile,
      code: 'import db from "../server/db.server";\nexport default db;\n',
      projectRoot: root,
      ...context,
    }),
  ).rejects.toThrow(MoonsError);

  await expect(
    checkClientModuleImports({
      file: clientFile,
      code: 'import * as secrets from "../server/secrets.server";\nexport default secrets;\n',
      projectRoot: root,
      ...context,
    }),
  ).rejects.toThrow(MoonsError);

  await expect(
    checkClientModuleImports({
      file: clientFile,
      code: 'export const load = () => import("../server/users.server");\n',
      projectRoot: root,
      ...context,
    }),
  ).rejects.toThrow(MoonsError);

  await checkClientModuleImports({
    file: clientFile,
    code: 'export const load = async () => {\n  if (import.meta.env.DEV) {\n    await import("../server/users.server");\n  }\n};\n',
    projectRoot: root,
    ...context,
  });

  let forbidden: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import { readFileSync } from "node:fs";\nexport default readFileSync;\n',
      projectRoot: root,
      ...context,
    });
  } catch (error) {
    forbidden = error;
  }
  expect((forbidden as MoonsError).code).toBe("E_FORBIDDEN_SERVER_IMPORT");

  await checkClientModuleImports({
    file: clientFile,
    code: 'export * from "../server/users.server";\n',
    projectRoot: root,
    ...context,
  });
});

test("scanServerFiles + buildFnRegistry (§21.3 shape)", () => {
  const root = makeTempProject();
  const usersFile = writeProjectFile(root, "src/server/users.server.ts", USERS_SERVER);
  writeProjectFile(root, "src/server/secrets.server.ts", SECRETS_SERVER);

  const files = scanServerFiles(root);
  expect(files).toEqual([usersFile, join(root, "src/server/secrets.server.ts")].sort());

  const registry = buildFnRegistry(root, files);
  expect(registry["src/server/users.server.ts#getUser"]).toBe(
    computeFnHash(root, usersFile, "getUser"),
  );
  expect(registry["src/server/users.server.ts#deleteUser"]).toBeDefined();
  expect(Object.keys(registry)).toHaveLength(2);
});

test("env() di modul client → E_ENV_IN_CLIENT (§12.4)", async () => {
  const root = makeTempProject();
  const context = makeContext(root);
  const clientFile = join(root, "src/client/config.ts");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import { env } from "@moonsjs/server";\n\nexport const apiKey = env("API_KEY");\n',
      projectRoot: root,
      ...context,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  const error = thrown as MoonsError;
  expect(error.code).toBe("E_ENV_IN_CLIENT");
  expect(error.format()).toContain("src/client/config.ts:3");
  expect(error.format()).toContain('calling `env("API_KEY")` in a client module');
  expect(error.format()).toContain("Suggestion:");

  await expect(
    checkClientModuleImports({
      file: clientFile,
      code: 'import { env as getEnv } from "@moonsjs/server";\nexport const k = getEnv("K");\n',
      projectRoot: root,
      ...context,
    }),
  ).rejects.toThrow(MoonsError);
});

test("checkRouteModuleExports §11.2/§12.4", () => {
  const project = makeTempProject();
  const routesDir = join(project, "src/routes");
  mkdirSync(routesDir, { recursive: true });

  const check = (file: string, code: string): void =>
    checkRouteModuleExports({ file: join(routesDir, file), code, routesDir, projectRoot: project });

  expect(() =>
    check(
      "index.tsx",
      'export const loader = async () => ({});\nexport default function Page() { return null; }\n',
    ),
  ).not.toThrow();

  expect(() =>
    check(
      "_layout.tsx",
      'export const loader = async () => ({});\nexport default function L({ children }) { return children; }\n',
    ),
  ).not.toThrow();

  let thrown: unknown;
  try {
    check("index.tsx", "export const helper = 1;\nexport default function Page() { return null; }\n");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  const error = thrown as MoonsError;
  expect(error.code).toBe("E_ROUTE_EXPORT_INVALID");
  expect(error.format()).toContain("src/routes/index.tsx:1");
  expect(error.format()).toContain("export `helper` is not allowed in route modules");
  expect(error.format()).toContain("Suggestion:");

  expect(() =>
    check("_layout.tsx", "export const meta = () => ({});\nexport default function L() { return null; }\n"),
  ).toThrow(MoonsError);

  expect(() =>
    check(
      "_error.tsx",
      "export const loader = async () => ({});\nexport default function E() { return null; }\n",
    ),
  ).toThrow(MoonsError);

  expect(() => check("about.tsx", "export const loader = async () => ({});\n")).toThrow(MoonsError);

  expect(() =>
    check("about.tsx", 'export * from "./x";\nexport default function P() { return null; }\n'),
  ).toThrow(MoonsError);

  expect(() => check("_helpers.tsx", "export const x = 1;\n")).not.toThrow();
});

test("audit M6: import dengan query Vite (?raw/?url) ditolak bersih (§12.4)", async () => {
  const root = makeTempProject();
  writeProjectFile(root, "src/server/secrets.server.ts", SECRETS_SERVER);
  const context = makeContext(root);
  const clientFile = join(root, "src/routes/probe.tsx");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import raw from "../server/secrets.server.ts?raw";\nexport default function P() { return raw; }\n',
      projectRoot: root,
      ...context,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  const error = thrown as MoonsError;
  expect(error.code).toBe("E_SERVER_IMPORT_IN_CLIENT");
  expect(error.format()).toContain("importing the default export from src/server/secrets.server.ts");

  // side-effect import dengan query: aman (modul tetap menjadi stub) → tidak ditolak
  await checkClientModuleImports({
    file: clientFile,
    code: 'import "../server/secrets.server.ts?raw";\nexport default function P() { return null; }\n',
    projectRoot: root,
    ...context,
  });
});

test("audit M6: import.meta.glob yang mencakup *.server ditolak (§12.7)", async () => {
  const root = makeTempProject();
  const context = makeContext(root);
  const clientFile = join(root, "src/routes/probe.tsx");

  for (const code of [
    'const mods = import.meta.glob("../server/*.server.ts", { eager: true });\nexport default mods;\n',
    'const mods = import.meta.glob(["../server/*.server.ts", "../lib/*.ts"]);\nexport default mods;\n',
  ]) {
    let thrown: unknown;
    try {
      await checkClientModuleImports({ file: clientFile, code, projectRoot: root, ...context });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MoonsError);
    expect((thrown as MoonsError).code).toBe("E_SERVER_IMPORT_IN_CLIENT");
    expect((thrown as MoonsError).format()).toContain("importing (glob)");
  }

  await checkClientModuleImports({
    file: clientFile,
    code: 'const mods = import.meta.glob("../lib/*.ts");\nexport default mods;\n',
    projectRoot: root,
    ...context,
  });
});

test("audit M6: dynamic import template literal dengan teks .server ditolak (§12.7)", async () => {
  const root = makeTempProject();
  const context = makeContext(root);
  const clientFile = join(root, "src/routes/probe.tsx");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'export const load = () => import(`../server/${"users"}.server`);\n',
      projectRoot: root,
      ...context,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).code).toBe("E_SERVER_IMPORT_IN_CLIENT");
  expect((thrown as MoonsError).format()).toContain("importing (dynamic)");

  // template tanpa teks `.server` tetap boleh
  await checkClientModuleImports({
    file: clientFile,
    code: "export const load = (name: string) => import(`../lib/${name}.ts`);\n",
    projectRoot: root,
    ...context,
  });
});

test("audit ronde 2: alias/resolve yang menunjuk *.server ditolak (bukan MISSING_EXPORT)", async () => {
  const root = makeTempProject();
  const secretsFile = writeProjectFile(root, "src/server/secrets.server.ts", SECRETS_SERVER);
  const usersFile = writeProjectFile(root, "src/server/users.server.ts", USERS_SERVER);
  writeProjectFile(root, "src/server/db.server.ts", "export const db = {};\n");
  const plainFile = writeProjectFile(root, "src/lib/plain.ts", "export const plain = 1;\n");

  const context = {
    resolve: (specifier: string): string | null => {
      if (specifier === "@secrets") return secretsFile;
      if (specifier === "@users") return usersFile;
      if (specifier === "@plain") return plainFile;
      return null;
    },
    analyze: (absoluteFile: string) => {
      try {
        return analyzeServerFile(readFileSync(absoluteFile, "utf8"), absoluteFile, root);
      } catch {
        return null;
      }
    },
  };
  const clientFile = join(root, "src/routes/probe.tsx");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import { INTERNAL_SECRET } from "@secrets";\nexport default INTERNAL_SECRET;\n',
      projectRoot: root,
      ...context,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).code).toBe("E_SERVER_IMPORT_IN_CLIENT");
  expect((thrown as MoonsError).format()).toContain(
    "importing `INTERNAL_SECRET` from src/server/secrets.server.ts",
  );

  await checkClientModuleImports({
    file: clientFile,
    code: 'import { getUser } from "@users";\nexport const load = () => getUser({ input: { id: "u1" } });\n',
    projectRoot: root,
    ...context,
  });

  await checkClientModuleImports({
    file: clientFile,
    code: 'import { plain } from "@plain";\nexport default plain;\n',
    projectRoot: root,
    ...context,
  });
});

test("audit ronde 2: resolve via symlink/realpath ke *.server ditolak", async () => {
  const root = makeTempProject();
  const secretsFile = writeProjectFile(root, "src/server/secrets.server.ts", SECRETS_SERVER);
  const linkPath = join(root, "src", "linked-secret.ts");
  writeFileSync(linkPath, ""); // placeholder lalu diganti symlink
  const { rmSync, symlinkSync } = await import("node:fs");
  rmSync(linkPath);
  symlinkSync("./server/secrets.server.ts", linkPath);

  const clientFile = join(root, "src/routes/probe.tsx");
  const analyze = (absoluteFile: string): ReturnType<typeof analyzeServerFile> | null => {
    try {
      return analyzeServerFile(readFileSync(absoluteFile, "utf8"), absoluteFile, root);
    } catch {
      return null;
    }
  };

  // resolver mengembalikan path LINK (bukan realpath) — tetap harus ditolak
  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import x from "./linked-secret";\nexport default x;\n',
      projectRoot: root,
      resolve: (specifier) => (specifier === "./linked-secret" ? linkPath : null),
      analyze,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).format()).toContain(
    "importing the default export from src/server/secrets.server.ts",
  );

  // resolver mengembalikan realpath secara langsung
  let thrownReal: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import x from "./linked-secret";\nexport default x;\n',
      projectRoot: root,
      resolve: (specifier) => (specifier === "./linked-secret" ? secretsFile : null),
      analyze,
    });
  } catch (error) {
    thrownReal = error;
  }
  expect(thrownReal).toBeInstanceOf(MoonsError);
  expect((thrownReal as MoonsError).format()).toContain(
    "importing the default export from src/server/secrets.server.ts",
  );
});

test("audit ronde 2: file server non-kontrak (.server.js) ditolak dengan pesan khusus", async () => {
  const root = makeTempProject();
  const legacyFile = writeProjectFile(
    root,
    "src/server/legacy.server.js",
    "export const SECRET = 1;\n",
  );
  const clientFile = join(root, "src/routes/probe.tsx");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import { SECRET } from "./server/legacy.server";\nexport default SECRET;\n',
      projectRoot: root,
      resolve: (specifier) => (specifier === "./server/legacy.server" ? legacyFile : null),
      analyze: () => null,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).code).toBe("E_SERVER_IMPORT_IN_CLIENT");
  expect((thrown as MoonsError).format()).toContain("extension outside the");

  expect(isNonContractServerFile("/x/legacy.server.js")).toBe(true);
  expect(isNonContractServerFile("/x/users.server.ts")).toBe(false);
});

test("audit ronde 2: ekstensi .server case-insensitive", () => {
  expect(isServerFilePath("/x/Secrets.SERVER.TS")).toBe(true);
  expect(isServerFilePath("/x/secrets.server.TsX")).toBe(true);
  expect(isServerSpecifier("./Secrets.Server.Ts")).toBe(true);
  expect(isNonContractServerFile("/x/Legacy.Server.MJS")).toBe(true);
  expect(isServerFilePath("/x/notserver.ts")).toBe(false);
});

test("audit ronde 2: resolve case-varian *.server ditolak", async () => {
  const root = makeTempProject();
  const caseFile = writeProjectFile(root, "src/server/Secrets.SERVER.TS", SECRETS_SERVER);
  const clientFile = join(root, "src/routes/probe.tsx");

  let thrown: unknown;
  try {
    await checkClientModuleImports({
      file: clientFile,
      code: 'import { INTERNAL_SECRET } from "./secrets";\nexport default INTERNAL_SECRET;\n',
      projectRoot: root,
      resolve: (specifier) => (specifier === "./secrets" ? caseFile : null),
      analyze: (absoluteFile) => {
        try {
          return analyzeServerFile(readFileSync(absoluteFile, "utf8"), absoluteFile, root);
        } catch {
          return null;
        }
      },
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  expect((thrown as MoonsError).format()).toContain(
    "importing `INTERNAL_SECRET` from src/server/Secrets.SERVER.TS",
  );
});
