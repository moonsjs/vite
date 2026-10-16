import { MoonsError, computeFnHash, fnRegistryKey } from "@moonsjs/core";
import { parse, parseExpression } from "@babel/parser";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createServerOnlyClassifier,
  serverOnlyImportError,
  type PackageJsonInfo,
} from "./server-only";

/**
 * Spec §12: analisis `.server.ts` + stub client + injeksi meta server +
 * penolakan import (E_SERVER_IMPORT_IN_CLIENT / E_FORBIDDEN_SERVER_IMPORT).
 */

export interface ServerFnInfo {
  name: string;
  hash: string;
  line: number;
  input: { start: number; end: number };
  output: { start: number; end: number };
  objectStart: number;
}

export interface ServerFileAnalysis {
  /** Absolute path. */
  file: string;
  serverFns: ServerFnInfo[];
  /** Semua nama export top-level (langsung). */
  exportNames: string[];
  /** Pernyataan `export { X as Y } from "./z.server"` (untuk resolusi re-export). */
  reExports: Array<{ source: string; names: Array<{ local: string; exported: string }> }>;
  /** `export * from "./z.server"`. */
  exportAllFrom: string[];
}

interface AstNode {
  type: string;
  start: number | null;
  end: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}

const SERVER_SPECIFIER = /\.server(\.(ts|tsx|js|jsx|mts|cts|mjs|cjs))?$/i;
const CONTRACT_SERVER_FILE = /\.server\.(ts|tsx)$/i;
const NON_CONTRACT_SERVER_FILE = /\.server\.(js|jsx|mts|cts|mjs|cjs)$/i;

export function isServerFilePath(path: string): boolean {
  return CONTRACT_SERVER_FILE.test(stripQuery(path));
}

/** File server dengan ekstensi di luar kontrak §12 (tidak bisa di-stub). */
export function isNonContractServerFile(path: string): boolean {
  return NON_CONTRACT_SERVER_FILE.test(stripQuery(path));
}

export function isServerSpecifier(specifier: string): boolean {
  return SERVER_SPECIFIER.test(specifier);
}

/**
 * Resolusi sinkron untuk specifier `*.server` (relatif/absolut).
 * Import alias/virtual untuk file server tidak didukung — tidak dibutuhkan app.
 */
export function resolveServerSpecifierSync(importerFile: string, specifier: string): string | null {
  if (!isServerSpecifier(specifier)) {
    return null;
  }
  const base = specifier.startsWith(".")
    ? resolve(dirname(importerFile), specifier)
    : isAbsolute(specifier)
      ? specifier
      : null;
  if (base === null) {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function stripQuery(id: string): string {
  const queryIndex = id.indexOf("?");
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

function parseModule(code: string, filename: string): AstNode {
  return parse(code, {
    sourceType: "module",
    plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    errorRecovery: false,
  }) as unknown as AstNode;
}

function walk(
  node: unknown,
  visit: (node: AstNode, ancestors: AstNode[]) => void,
  ancestors: AstNode[] = [],
): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit, ancestors);
    }
    return;
  }
  const candidate = node as AstNode;
  if (typeof candidate.type !== "string" || typeof candidate.start !== "number") {
    return;
  }
  visit(candidate, ancestors);
  const nextAncestors = [...ancestors, candidate];
  for (const key of Object.keys(candidate)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") {
      continue;
    }
    walk(candidate[key], visit, nextAncestors);
  }
}

function topLevelStatements(ast: AstNode): AstNode[] {
  const program = ast["program"] as { body?: AstNode[] } | undefined;
  return program?.body ?? [];
}

/**
 * Type-only import/export (Addendum C.1): `import type ...`, `export type ...`,
 * atau seluruh specifier bertanda `type`. Terhapus saat kompilasi sehingga
 * dikecualikan dari gate paket server-only. `export * from` = bernilai.
 */
function isTypeOnlyImportExport(statement: AstNode): boolean {
  const declarationKind = (statement["importKind"] ?? statement["exportKind"]) as
    | string
    | undefined;
  if (declarationKind === "type") {
    return true;
  }
  const specifiers = (statement["specifiers"] ?? []) as AstNode[];
  if (specifiers.length === 0) {
    return false;
  }
  return specifiers.every(
    (item) => ((item["importKind"] ?? item["exportKind"]) as string | undefined) === "type",
  );
}

function keyName(node: unknown): string | null {
  const key = node as AstNode | undefined;
  if (key?.type === "Identifier") {
    return key["name"] as string;
  }
  if (key?.type === "StringLiteral") {
    return key["value"] as string;
  }
  return null;
}

function extractServerFnInit(init: unknown): {
  input: { start: number; end: number };
  output: { start: number; end: number };
  line: number;
  objectStart: number;
} | null {
  const call = init as AstNode | undefined;
  if (call?.type !== "CallExpression") {
    return null;
  }
  const callee = call["callee"] as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee["name"] !== "serverFn") {
    return null;
  }
  const args = (call["arguments"] ?? []) as AstNode[];
  const first = args[0];
  if (first?.type !== "ObjectExpression") {
    return null;
  }

  const properties = new Map<string, AstNode>();
  for (const property of (first["properties"] ?? []) as AstNode[]) {
    if (property.type !== "ObjectProperty") {
      continue;
    }
    const name = keyName(property["key"]);
    if (name !== null) {
      properties.set(name, property);
    }
  }

  const input = properties.get("input")?.["value"] as AstNode | undefined;
  const output = properties.get("output")?.["value"] as AstNode | undefined;
  if (
    input?.start == null ||
    input.end == null ||
    output?.start == null ||
    output.end == null
  ) {
    return null;
  }

  return {
    input: { start: input.start, end: input.end },
    output: { start: output.start, end: output.end },
    line: call.loc?.start.line ?? 1,
    objectStart: first.start ?? 0,
  };
}

export function analyzeServerFile(
  source: string,
  filename: string,
  projectRoot: string,
): ServerFileAnalysis {
  const ast = parseModule(source, filename);
  const serverFns: ServerFnInfo[] = [];
  const exportNames: string[] = [];
  const reExports: ServerFileAnalysis["reExports"] = [];
  const exportAllFrom: string[] = [];

  for (const statement of topLevelStatements(ast)) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement["declaration"] as AstNode | null | undefined;

      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of (declaration["declarations"] ?? []) as AstNode[]) {
          const id = declarator["id"] as AstNode | undefined;
          if (id?.type !== "Identifier") {
            continue;
          }
          const name = id["name"] as string;
          exportNames.push(name);
          const info = extractServerFnInit(declarator["init"]);
          if (info !== null) {
            serverFns.push({
              name,
              hash: computeFnHash(projectRoot, filename, name),
              line: info.line,
              input: info.input,
              output: info.output,
              objectStart: info.objectStart,
            });
          }
        }
      } else if (declaration?.type === "FunctionDeclaration") {
        const id = declaration["id"] as AstNode | undefined;
        if (id?.type === "Identifier") {
          exportNames.push(id["name"] as string);
        }
      }

      for (const specifier of (statement["specifiers"] ?? []) as AstNode[]) {
        const exported = specifier["exported"] as AstNode | undefined;
        if (exported?.type === "Identifier") {
          exportNames.push(exported["name"] as string);
        }
      }

      const sourceNode = statement["source"] as AstNode | undefined;
      if (sourceNode?.type === "StringLiteral" && isServerSpecifier(sourceNode["value"] as string)) {
        reExports.push({
          source: sourceNode["value"] as string,
          names: ((statement["specifiers"] ?? []) as AstNode[]).map((specifier) => ({
            local: ((specifier["local"] as AstNode | undefined)?.["name"] as string) ?? "",
            exported: (((specifier["exported"] as AstNode | undefined)?.["name"] as string) ?? ""),
          })),
        });
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      exportNames.push("default");
    } else if (statement.type === "ExportAllDeclaration") {
      const sourceNode = statement["source"] as AstNode | undefined;
      if (sourceNode?.type === "StringLiteral" && isServerSpecifier(sourceNode["value"] as string)) {
        exportAllFrom.push(sourceNode["value"] as string);
      }
    }
  }

  return { file: filename, serverFns, exportNames, reExports, exportAllFrom };
}

/** Nama-nama yang diekspor sebagai serverFn stub dari file (langsung atau via re-export). */
export function serverFnExportNames(
  analysis: ServerFileAnalysis,
  analyzeTarget: (specifier: string) => ServerFileAnalysis | null,
  seen = new Set<string>(),
): Set<string> {
  const names = new Set(analysis.serverFns.map((fn) => fn.name));

  for (const reExport of analysis.reExports) {
    const target = analyzeTarget(reExport.source);
    if (target === null || seen.has(reExport.source)) {
      continue;
    }
    seen.add(reExport.source);
    const targetNames = serverFnExportNames(target, analyzeTarget, seen);
    for (const { local, exported } of reExport.names) {
      if (local === "*" || targetNames.has(local)) {
        names.add(exported);
      }
    }
  }

  for (const specifier of analysis.exportAllFrom) {
    const target = analyzeTarget(specifier);
    if (target === null || seen.has(specifier)) {
      continue;
    }
    seen.add(specifier);
    for (const name of serverFnExportNames(target, analyzeTarget, seen)) {
      names.add(name);
    }
  }

  return names;
}

function collectRetainedText(source: string, analysis: ServerFileAnalysis): string {
  return analysis.serverFns
    .map((fn) => `${source.slice(fn.input.start, fn.input.end)}\n${source.slice(fn.output.start, fn.output.end)}`)
    .join("\n");
}

function isUsed(name: string, retainedText: string): boolean {
  return new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`).test(retainedText);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPatternNames(node: AstNode | undefined, into: Set<string>): void {
  if (node === undefined) {
    return;
  }
  switch (node.type) {
    case "Identifier": {
      const name = node["name"] as string | undefined;
      if (name !== undefined) {
        into.add(name);
      }
      return;
    }
    case "ObjectPattern":
      for (const property of (node["properties"] ?? []) as AstNode[]) {
        collectPatternNames(
          (property.type === "RestElement" ? property["argument"] : property["value"]) as
            | AstNode
            | undefined,
          into,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of (node["elements"] ?? []) as AstNode[]) {
        collectPatternNames(element, into);
      }
      return;
    case "AssignmentPattern":
      collectPatternNames(node["left"] as AstNode | undefined, into);
      return;
    case "RestElement":
      collectPatternNames(node["argument"] as AstNode | undefined, into);
      return;
    default:
      return;
  }
}

/** Nama deklarasi nilai top-level (bukan import) — yang DIBUANG dari stub §12.3. */
function localTopLevelNames(ast: AstNode): Set<string> {
  const names = new Set<string>();
  const declare = (decl: AstNode | null | undefined): void => {
    if (decl === undefined || decl === null) {
      return;
    }
    if (decl.type === "VariableDeclaration") {
      for (const declarator of (decl["declarations"] ?? []) as AstNode[]) {
        collectPatternNames(declarator["id"] as AstNode | undefined, names);
      }
      return;
    }
    if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
      const name = ((decl["id"] as AstNode | undefined)?.["name"] as string | undefined) ?? "";
      if (name.length > 0) {
        names.add(name);
      }
    }
  };

  for (const statement of topLevelStatements(ast)) {
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      declare(statement["declaration"] as AstNode | null | undefined);
    } else {
      declare(statement);
    }
  }
  return names;
}

/** Identifier posisi-nilai yang direferensikan di dalam ekspresi (key/member di-skip). */
function referencedIdentifiers(expression: string, filename: string): Set<string> {
  const ast = parseExpression(expression, {
    plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  }) as unknown as AstNode;
  const names = new Set<string>();

  walk(ast, (node, ancestors) => {
    if (node.type !== "Identifier") {
      return;
    }
    const parent = ancestors[ancestors.length - 1];
    if (parent !== undefined) {
      const parentType = parent.type as string;
      const nonComputed = parent["computed"] !== true;
      if (
        nonComputed &&
        (parentType === "MemberExpression" || parentType === "OptionalMemberExpression") &&
        parent["property"] === node
      ) {
        return;
      }
      if (
        nonComputed &&
        (parentType === "ObjectProperty" ||
          parentType === "ObjectMethod" ||
          parentType === "ClassProperty" ||
          parentType === "TSPropertySignature") &&
        parent["key"] === node
      ) {
        return;
      }
    }
    names.add((node["name"] as string | undefined) ?? "");
  });

  return names;
}

export interface StubDependencies {
  /** Resolve specifier relatif file sumber → analysis (null bila tidak bisa). */
  analyzeSpecifier: (sourceFile: string, specifier: string) => ServerFileAnalysis | null;
}

export interface RenderStubResult {
  code: string;
  /** Specifier server file yang di-referensikan (untuk keperluan cache/diagnostik). */
  referenced: string[];
}

/**
 * Bangun stub client §12.2/§12.3 dari sumber `.server.ts`:
 * hanya import yang dipakai schema + `__moons_createStub` per serverFn.
 */
export function renderServerFnStub(
  source: string,
  filename: string,
  analysis: ServerFileAnalysis,
  dependencies: StubDependencies,
): RenderStubResult {
  const ast = parseModule(source, filename);
  const retainedText = collectRetainedText(source, analysis);
  const localNames = localTopLevelNames(ast);
  const importLines: string[] = [];
  const referenced: string[] = [];
  // Addendum J.4 (D2): nama yang diimpor dari file `*.server.ts` lain — dipakai
  // untuk mendeteksi referensi schema ke nilai server (dulu `MISSING_EXPORT`).
  const serverImportedNames = new Map<string, { specifier: string; imported: string }>();
  let needsCreateStub = analysis.serverFns.length > 0;

  for (const statement of topLevelStatements(ast)) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const sourceNode = statement["source"] as AstNode;
    const specifier = sourceNode["value"] as string;

    if (/^@moons\/server(\/|$)/.test(specifier)) {
      continue; // serverFn/env tidak dibawa ke client (§12.2)
    }
    if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
      continue; // import server-only dibuang
    }

    const specifiers = (statement["specifiers"] ?? []) as AstNode[];
    const kept: AstNode[] = [];

    if (isServerSpecifier(specifier)) {
      referenced.push(specifier);
      for (const item of specifiers) {
        if (item.type === "ImportDefaultSpecifier" || item.type === "ImportNamespaceSpecifier") {
          continue; // default / * as dari *.server → dibuang (§12.2)
        }
        const local = ((item["local"] as AstNode | undefined)?.["name"] as string) ?? "";
        if (local.length > 0 && isUsed(local, retainedText)) {
          kept.push(item);
          const imported =
            ((item["imported"] as AstNode | undefined)?.["name"] as string | undefined) ?? local;
          serverImportedNames.set(local, { specifier, imported });
        }
      }
    } else {
      for (const item of specifiers) {
        const local = ((item["local"] as AstNode | undefined)?.["name"] as string) ?? "";
        if (local.length > 0 && isUsed(local, retainedText)) {
          kept.push(item);
        }
      }
    }

    if (kept.length === 0) {
      continue; // import tak terpakai → dipangkas (§12.3)
    }

    const keptText = kept
      .map((item) => source.slice(item.start ?? 0, item.end ?? 0))
      .join(", ");
    importLines.push(`import { ${keptText} } from ${JSON.stringify(specifier)};`);
  }

  if (needsCreateStub) {
    importLines.push('import { __moons_createStub } from "@moonsjs/server/client";');
  }

  const exportLines: string[] = [];
  for (const fn of analysis.serverFns) {
    const input = source.slice(fn.input.start, fn.input.end);
    const output = source.slice(fn.output.start, fn.output.end);

    // E_SCHEMA_LOCAL_REF: deklarasi lokal dibuang dari stub, jadi referensinya
    // menjadi `undefined` di browser (crash hydration — dulu lolos build).
    for (const [kind, slice] of [
      ["input", input],
      ["output", output],
    ] as const) {
      for (const reference of referencedIdentifiers(slice, filename)) {
        if (reference.length === 0) {
          continue;
        }
        const serverImport = serverImportedNames.get(reference);
        if (serverImport !== undefined) {
          const target = dependencies.analyzeSpecifier(filename, serverImport.specifier);
          const isServerFn =
            target !== null && target.serverFns.some((fn) => fn.name === serverImport.imported);
          if (!isServerFn) {
            throw new MoonsError({
              code: "E_SCHEMA_SERVER_REF",
              file: filename,
              line: fn.line,
              annotation: fn.name,
              message: `schema ${kind} of serverFn \`${fn.name}\` references server value \`${reference}\` from \`${serverImport.specifier}\``,
              details:
                `\`${reference}\` is imported from another server file and is not a serverFn — the client stub does not export it (previously a raw bundler \`MISSING_EXPORT\` error).\n\n` +
                "Pick one:\n" +
                "  // a) move the constant/schema to a client-safe module\n" +
                `  import { ${reference} } from "../shared/schemas";\n` +
                "  // b) inline the value if it is genuinely public in the schema, or\n" +
                "  // c) do extra validation in the server handler without referencing server values in the schema",
              suggestions: [
                "Move the referenced declaration to a client-safe shared module (e.g. `src/shared/schemas.ts`)",
                "Or do the validation in the server handler instead of the schema expression",
              ],
            });
          }
          continue;
        }
        if (!localNames.has(reference)) {
          continue;
        }
        throw new MoonsError({
          code: "E_SCHEMA_LOCAL_REF",
          file: filename,
          line: fn.line,
          annotation: fn.name,
          message: `schema ${kind} of serverFn \`${fn.name}\` references local declaration \`${reference}\``,
          details:
            `\`${reference}\` is dropped from the client stub, so its value is \`undefined\` in the browser (hydration crash).\n\n` +
            "Before (rejected):\n" +
            `  const ${reference} = z.object({ … });                 // local declaration in the same file\n` +
            `  export const ${fn.name} = serverFn({ ${kind}: ${reference}, … });\n\n` +
            "After (pick one):\n" +
            `  // a) inline the schema in the argument\n` +
            `  export const ${fn.name} = serverFn({ ${kind}: z.object({ … }), … });\n` +
            `  // b) move the declaration to a shared module that may enter the client (e.g. src/shared/schemas.ts)\n` +
            `  import { ${reference} } from "../shared/schemas";`,
          suggestions: [
            `Inline the schema in the argument \`serverFn({ ${kind}: … })\`, or`,
            `Move \`${reference}\` to a shared module (e.g. \`src/shared/schemas.ts\`) and import it from there`,
            "Never move secret values to shared — the schema must be client-safe (zod/Standard Schema)",
          ],
        });
      }
    }

    exportLines.push(
      `export const ${fn.name} = __moons_createStub({ hash: ${JSON.stringify(fn.hash)}, input: ${input}, output: ${output} });`,
    );
  }

  for (const reExport of analysis.reExports) {
    const target = dependencies.analyzeSpecifier(filename, reExport.source);
    if (target === null) {
      throw new MoonsError({
        code: "E_SERVER_IMPORT_IN_CLIENT",
        file: filename,
        message: `cannot resolve \`${reExport.source}\` for re-export`,
        details: "Re-exports from `*.server.ts` must be statically resolvable.",
        suggestions: ["Fix the re-export path", "Avoid dynamic re-exports from server files"],
      });
    }
    const targetNames = serverFnExportNames(target, (specifier) =>
      dependencies.analyzeSpecifier(filename, specifier),
    );
    const keptNames = reExport.names.filter(({ local }) => local !== "" && targetNames.has(local));
    if (keptNames.length > 0) {
      const specifiers = keptNames
        .map(({ local, exported }) => (local === exported ? local : `${local} as ${exported}`))
        .join(", ");
      exportLines.push(`export { ${specifiers} } from ${JSON.stringify(reExport.source)};`);
    }
  }

  for (const specifier of analysis.exportAllFrom) {
    const target = dependencies.analyzeSpecifier(filename, specifier);
    if (target === null) {
      throw new MoonsError({
        code: "E_SERVER_IMPORT_IN_CLIENT",
        file: filename,
        message: `\`export *\` from \`${specifier}\` cannot be resolved`,
        details: "`export *` from `*.server.ts` must be statically expandable.",
        suggestions: ["Fix the re-export path", "Replace it with named re-exports"],
      });
    }
    const targetNames = serverFnExportNames(target, (nested) =>
      dependencies.analyzeSpecifier(filename, nested),
    );
    if (targetNames.size > 0) {
      exportLines.push(
        `export { ${[...targetNames].join(", ")} } from ${JSON.stringify(specifier)};`,
      );
    }
  }

  if (importLines.length === 0 && exportLines.length === 0) {
    return { code: "// @moons: no serverFn exported\nexport {};\n", referenced };
  }

  return { code: `${[...importLines, "", ...exportLines].join("\n")}\n`, referenced };
}

/** Inject meta §7.2 ke deklarasi serverFn (env ssr; handler tetap utuh). */
export function injectServerFnMeta(
  source: string,
  analysis: ServerFileAnalysis,
  projectRoot: string,
): string {
  let output = source;
  const inserts = [...analysis.serverFns].sort((a, b) => b.objectStart - a.objectStart);

  for (const fn of inserts) {
    const meta =
      ` __hash: ${JSON.stringify(fn.hash)},` +
      ` __file: ${JSON.stringify(fnRegistryKey(projectRoot, analysis.file, fn.name).split("#")[0] as string)},` +
      ` __line: ${fn.line},` +
      ` __exportName: ${JSON.stringify(fn.name)},`;
    const at = fn.objectStart + 1;
    output = output.slice(0, at) + meta + output.slice(at);
  }

  return output;
}

export interface ClientImportCheckContext {
  /** Absolute path file yang sedang diperiksa. */
  file: string;
  code: string;
  projectRoot: string;
  /**
   * Resolve specifier dengan importer tertentu → absolute path (null bila tidak
   * ada). Boleh sinkron maupun async (plugin memakai `this.resolve`, sehingga
   * alias Vite & `tsconfig paths` ikut terperiksa — audit ronde 2).
   */
  resolve: (specifier: string, importer: string) => string | null | Promise<string | null>;
  /** Analysis untuk file server (hasil cache plugin). */
  analyze: (absoluteFile: string) => ServerFileAnalysis | null;
  /** Direktori `src/api` (absolut) — modul API server-only (Addendum D.1). */
  apiDir?: string;
  /** File config (absolut) — server-only (Addendum J.4). */
  configFile?: string;
  /** Direktori `src/server` (absolut) — server-only (Addendum J.4). */
  serverDir?: string;
  /** Paket server-only tambahan dari `security.serverOnlyPackages` (Addendum C). */
  serverOnlyPackages?: ReadonlyArray<string>;
  /** Cache package.json lintas modul (performa; dikelola plugin). */
  packageCache?: Map<string, PackageJsonInfo | null>;
}

/** Nama serverFn (langsung atau via re-export) — versi async untuk pemeriksaan resolve. */
async function serverFnExportNamesAsync(
  analysis: ServerFileAnalysis,
  analyzeSpecifier: (specifier: string, importer: string) => Promise<ServerFileAnalysis | null>,
  seen = new Set<string>(),
): Promise<Set<string>> {
  const names = new Set(analysis.serverFns.map((fn) => fn.name));

  for (const reExport of analysis.reExports) {
    const key = `${analysis.file}\0${reExport.source}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const target = await analyzeSpecifier(reExport.source, analysis.file);
    if (target === null) {
      continue;
    }
    const targetNames = await serverFnExportNamesAsync(target, analyzeSpecifier, seen);
    for (const { local, exported } of reExport.names) {
      if (local === "*" || targetNames.has(local)) {
        names.add(exported);
      }
    }
  }

  for (const specifier of analysis.exportAllFrom) {
    const key = `${analysis.file}\0${specifier}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const target = await analyzeSpecifier(specifier, analysis.file);
    if (target === null) {
      continue;
    }
    for (const name of await serverFnExportNamesAsync(target, analyzeSpecifier, seen)) {
      names.add(name);
    }
  }

  return names;
}

export function nonContractServerFileError(file: string, projectRoot: string): MoonsError {
  return new MoonsError({
    code: "E_SERVER_IMPORT_IN_CLIENT",
    file: toRelative(projectRoot, file),
    message: "server file uses an extension outside the `*.server.ts` contract",
    details:
      "The zero-trust transform only handles `*.server.ts`/`*.server.tsx`; server files with other extensions cannot be stubbed and must not enter the client graph.",
    suggestions: [
      "Rename the file to `*.server.ts`/`*.server.tsx` and put the `serverFn` inside it",
      "Or move the value you need into a non-server file",
    ],
  });
}

/** Periksa import modul client terhadap §12.4/§12.7/§12.8 — berbasis hasil resolve. */
interface TraceFileRecord {
  ast: AstNode | null;
  mentionsServer: boolean;
}

/**
 * Addendum K.1: telusuri apakah `name` dari sebuah modul client pada akhirnya
 * berasal dari `*.server.ts` (langsung atau lewat rantai re-export/barrel),
 * dan bukan serverFn. Mengembalikan file server yang bermasalah, atau null.
 */
async function traceValueToServer(input: {
  file: string;
  name: string;
  resolveSafe: (specifier: string, importer: string) => Promise<string | null>;
  analyze: (absoluteFile: string) => ServerFileAnalysis | null;
  cache: Map<string, TraceFileRecord>;
  seen: Set<string>;
}): Promise<string | null> {
  const key = `${input.file}#${input.name}`;
  if (input.seen.has(key) || input.seen.size > 64) {
    return null;
  }
  input.seen.add(key);

  const record = loadTraceFile(input.file, input.cache);
  if (record === null || record.ast === null || !record.mentionsServer) {
    return null;
  }
  const ast = record.ast;
  if (localTopLevelNames(ast).has(input.name)) {
    return null; // didefinisikan lokal = kode client
  }

  const importBindings = new Map<string, { specifier: string; imported: string }>();
  const edges: Array<{ specifier: string; local: string }> = [];

  for (const statement of topLevelStatements(ast)) {
    if (statement.type === "ImportDeclaration") {
      const source = (statement["source"] as AstNode | null | undefined)?.["value"];
      if (typeof source !== "string") {
        continue;
      }
      for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
        if (item.type !== "ImportSpecifier") {
          continue;
        }
        const local = (item["local"] as AstNode | undefined)?.["name"] as string | undefined;
        const imported = ((item["imported"] as AstNode | undefined)?.["name"] as string | undefined) ?? local;
        if (local !== undefined && imported !== undefined) {
          importBindings.set(local, { specifier: source, imported });
        }
      }
      continue;
    }

    if (statement.type === "ExportNamedDeclaration") {
      const source = (statement["source"] as AstNode | null | undefined)?.["value"];
      for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
        if (item.type !== "ExportSpecifier") {
          continue;
        }
        const local = (item["local"] as AstNode | undefined)?.["name"] as string | undefined;
        const exported = ((item["exported"] as AstNode | undefined)?.["name"] as string | undefined) ?? local;
        if (local === undefined || exported !== input.name) {
          continue;
        }
        if (typeof source === "string") {
          edges.push({ specifier: source, local });
        } else {
          const binding = importBindings.get(local);
          if (binding !== undefined) {
            edges.push({ specifier: binding.specifier, local: binding.imported });
          }
        }
      }
      continue;
    }

    const exportedAll = statement["exported"];
    if (
      statement.type === "ExportAllDeclaration" &&
      (exportedAll === null || exportedAll === undefined)
    ) {
      const source = (statement["source"] as AstNode | null | undefined)?.["value"];
      if (typeof source === "string") {
        edges.push({ specifier: source, local: input.name });
      }
    }
  }

  for (const edge of edges) {
    const next = await input.resolveSafe(edge.specifier, input.file);
    if (next === null) {
      continue;
    }
    if (isServerFilePath(next)) {
      const analysis = input.analyze(next);
      const isServerFn =
        analysis !== null && analysis.serverFns.some((fn) => fn.name === edge.local);
      if (!isServerFn) {
        return next;
      }
      continue;
    }
    const deeper = await traceValueToServer({
      ...input,
      file: next,
      name: edge.local,
    });
    if (deeper !== null) {
      return deeper;
    }
  }
  return null;
}

function loadTraceFile(file: string, cache: Map<string, TraceFileRecord>): TraceFileRecord | null {
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let record: TraceFileRecord | null = null;
  try {
    const source = readFileSync(file, "utf8");
    // Pra-filter murah: hanya modul yang (a) menyebut `.server` atau (b)
    // punya re-export (`export … from`) yang bisa menjadi mata rantai barrel.
    const isBarrel = /(^|\n)\s*export\s+(\*|\{[^}]*\})\s+from\s/.test(source);
    const mentionsServer = source.includes(".server") || isBarrel;
    record = {
      ast: mentionsServer ? parseModule(source, file) : null,
      mentionsServer,
    };
  } catch {
    record = null;
  }
  cache.set(file, record ?? { ast: null, mentionsServer: false });
  return record;
}

export async function checkClientModuleImports(
  context: ClientImportCheckContext,
): Promise<void> {
  const { file, code, projectRoot, resolve, analyze } = context;
  const ast = parseModule(code, file);
  const traceCache = new Map<string, TraceFileRecord>();
  const relativeFile = toRelative(projectRoot, file);
  // Addendum C: gate paket server-only (daftar bawaan ∪ security.serverOnlyPackages ∪ marker).
  const serverOnly = createServerOnlyClassifier({
    configured: context.serverOnlyPackages ?? [],
    ...(context.packageCache === undefined ? {} : { cache: context.packageCache }),
  });
  // Addendum D.1: `src/api/**` server-only (endpoint HTTP mentah).
  let apiDirReal: string | null = null;
  if (context.apiDir !== undefined && context.apiDir.length > 0) {
    try {
      apiDirReal = realpathSync(context.apiDir);
    } catch {
      apiDirReal = context.apiDir;
    }
  }

  // Addendum J.4: config + direktori `src/server/**` server-only.
  let configFileReal: string | null = null;
  if (context.configFile !== undefined) {
    try {
      configFileReal = realpathSync(context.configFile);
    } catch {
      configFileReal = context.configFile;
    }
  }
  let serverDirReal: string | null = null;
  if (context.serverDir !== undefined) {
    try {
      serverDirReal = realpathSync(context.serverDir);
    } catch {
      serverDirReal = context.serverDir;
    }
  }

  const rejectConfigImport = (line: number, specifier: string): never => {
    throw new MoonsError({
      code: "E_FORBIDDEN_SERVER_IMPORT",
      file: relativeFile,
      line,
      message: `importing \`${specifier}\` — \`moons.config.ts\` is a server-only module`,
      details:
        "The config contains `context`/`middleware` (server code) and never enters the client bundle (Addendum J.4).",
      suggestions: [
        "Move the value you need into a client-safe module (e.g. `src/shared/…`)",
        "Get the value from the server via a loader/serverFn",
      ],
    });
  };

  const rejectServerDirImport = (line: number, specifier: string, resolvedTarget: string): never => {
    throw new MoonsError({
      code: "E_FORBIDDEN_SERVER_IMPORT",
      file: relativeFile,
      line,
      message: `importing \`${specifier}\` — \`${toRelative(projectRoot, resolvedTarget)}\` is inside \`src/server/**\` (server-only)`,
      details:
        "The `src/server/**` directory is for server code only (Addendum J.4); the `.server.ts` suffix is not the only guarantee.",
      suggestions: [
        "Move client-safe code to `src/shared/`",
        "Access the value from the server via a loader/serverFn",
      ],
    });
  };

  const rejectApiImport = (line: number, specifier: string, resolvedTarget: string): never => {
    const relApi = toRelative(projectRoot, resolvedTarget);
    throw new MoonsError({
      code: "E_FORBIDDEN_SERVER_IMPORT",
      file: relativeFile,
      line,
      message: `importing \`${specifier}\` — \`${relApi}\` is a server-only API module`,
      details:
        "`src/api/**` only runs on the server (HTTP endpoints) and never enters the client bundle.",
      suggestions: [
        "Move the operation into `*.server.ts` and call it via a serverFn",
        "Do not import `src/api` files from client routes/components",
      ],
    });
  };

  const resolveSafe = async (specifier: string, importer: string): Promise<string | null> => {
    try {
      const result = await resolve(specifier, importer);
      if (result === null) {
        return null;
      }
      const clean = stripQuery(result);
      // Audit ronde 2: normalisasi realpath — symlink ke `*.server.ts` harus
      // tertangkap walau resolver mengembalikan path link.
      try {
        return realpathSync(clean);
      } catch {
        return clean;
      }
    } catch {
      return null;
    }
  };

  const analyzeResolved = async (
    specifier: string,
    importer: string,
  ): Promise<ServerFileAnalysis | null> => {
    const absolute = await resolveSafe(specifier, importer);
    return absolute === null ? null : analyze(absolute);
  };

  const isAllowedServerFnImport = async (
    resolvedTarget: string | null,
    specifier: string,
    name: string,
  ): Promise<boolean> => {
    const target =
      resolvedTarget === null ? await analyzeResolved(specifier, file) : analyze(resolvedTarget);
    if (target === null) {
      return false;
    }
    const names = await serverFnExportNamesAsync(target, (nested, importer) =>
      analyzeResolved(nested, importer),
    );
    return names.has(name);
  };

  const reject = (line: number, message: string, details: string): never => {
    throw new MoonsError({
      code: "E_SERVER_IMPORT_IN_CLIENT",
      file: relativeFile,
      line,
      message,
      details,
      suggestions: [
        "Create a server function that returns the data you need, or",
        "If the value is genuinely public, redefine the constant in a client-safe module (never move secret values)",
      ],
    });
  };

  const rejectForbidden = (line: number, specifier: string): never => {
    throw new MoonsError({
      code: "E_FORBIDDEN_SERVER_IMPORT",
      file: relativeFile,
      line,
      message: `importing \`${specifier}\` in a client module`,
      details: "Server-only modules may only be imported from *.server.ts.",
      suggestions: [
        "Move the operation into a serverFn, or",
        "Remove the import",
      ],
    });
  };

  for (const statement of topLevelStatements(ast)) {
    if (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
      const sourceNode = statement["source"] as AstNode | null | undefined;
      if (sourceNode?.type !== "StringLiteral") {
        continue;
      }
      const rawSpecifier = sourceNode["value"] as string;
      // Query Vite (`?raw`, `?url`, `?inline`, dst.) dinormalisasi untuk
      // pencocokan & resolusi (audit adversarial M6).
      const specifier = stripQuery(rawSpecifier);
      const line = statement.loc?.start.line ?? 1;
      // Addendum C: type-only (`import type ...`, seluruh specifier tipe)
      // terhapus saat kompilasi → dikecualikan dari gate paket server-only.
      const typeOnly = isTypeOnlyImportExport(statement);

      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
        rejectForbidden(line, specifier);
      }

      const resolvedTarget = await resolveSafe(specifier, file);

      // Addendum D.1: modul `src/api/**` server-only.
      if (apiDirReal !== null && resolvedTarget !== null && isInsideDir(resolvedTarget, apiDirReal)) {
        rejectApiImport(line, rawSpecifier, resolvedTarget);
      }

      // Addendum J.4: `moons.config.ts` + direktori `src/server/**` server-only
      // (impor nilai; type-only dikecualikan — J.5).
      if (!typeOnly && resolvedTarget !== null) {
        if (configFileReal !== null && resolvedTarget === configFileReal) {
          rejectConfigImport(line, rawSpecifier);
        }
        if (
          serverDirReal !== null &&
          isInsideDir(resolvedTarget, serverDirReal) &&
          !isServerFilePath(resolvedTarget) &&
          // File non-kontrak (`*.server.mts` dll.) punya error khusus yang
          // lebih tepat — biarkan jatuh ke pemeriksaan di bawah.
          !isNonContractServerFile(resolvedTarget)
        ) {
          rejectServerDirImport(line, rawSpecifier, resolvedTarget);
        }
      }

      // Addendum C: paket server-only (nama paket hasil resolve — subpath,
      // alias, tsconfig paths, symlink/workspace ikut tertangkap).
      if (!typeOnly) {
        const match = serverOnly.check({
          specifier,
          resolvedFile: resolvedTarget,
          importerFile: file,
        });
        if (match !== null) {
          throw serverOnlyImportError({
            relativeFile,
            line,
            specifier: rawSpecifier,
            packageName: match.packageName,
            source: match.source,
            ...(match.source === "marker"
              ? { markerPath: toRelative(projectRoot, join(match.packageDir, "package.json")) }
              : {}),
          });
        }
      }

      // Audit ronde 2: file server di luar kontrak §12 ditolak (tidak bisa di-stub).
      if (resolvedTarget !== null && isNonContractServerFile(resolvedTarget)) {
        throw nonContractServerFileError(resolvedTarget, projectRoot);
      }

      // Audit ronde 2: keputusan berbasis hasil resolve — menangkap alias Vite,
      // `tsconfig paths`, dan symlink (realpath) yang menunjuk `*.server.ts`.
      const serverBySpecifier = isServerSpecifier(specifier);
      const serverByResolve = resolvedTarget !== null && isServerFilePath(resolvedTarget);
      if (!serverBySpecifier && !serverByResolve) {
        // Addendum K.1: rantai re-export ke `*.server.ts` (barrel) — pesan Moons
        // menggantikan `MISSING_EXPORT` bundler. Hanya nilai (bukan type-only).
        if (!typeOnly && resolvedTarget !== null && /[.](ts|tsx)$/.test(resolvedTarget)) {
          const requestedNames: string[] = [];
          if (statement.type === "ImportDeclaration") {
            for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
              if (item.type !== "ImportSpecifier") {
                continue;
              }
              const kind = (item["importKind"] ?? statement["importKind"]) as string | undefined;
              if (kind === "type") {
                continue;
              }
              const imported = (item["imported"] as AstNode | undefined)?.["name"] as string | undefined;
              if (imported !== undefined) {
                requestedNames.push(imported);
              }
            }
          } else if (statement.type === "ExportNamedDeclaration") {
            for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
              const kind = (item["importKind"] ??
                statement["importKind"] ??
                item["exportKind"] ??
                statement["exportKind"]) as string | undefined;
              if (kind === "type") {
                continue;
              }
              const local = (item["local"] as AstNode | undefined)?.["name"] as string | undefined;
              if (local !== undefined) {
                requestedNames.push(local);
              }
            }
          }
          for (const name of requestedNames) {
            const serverFile = await traceValueToServer({
              file: resolvedTarget,
              name,
              resolveSafe,
              analyze,
              cache: traceCache,
              seen: new Set<string>(),
            });
            if (serverFile !== null) {
              throw new MoonsError({
                code: "E_SERVER_IMPORT_IN_CLIENT",
                file: relativeFile,
                line,
                message: `importing \`${name}\` — comes from \`${toRelative(projectRoot, serverFile)}\` (via a re-export chain)`,
                details:
                  `\`${toRelative(projectRoot, resolvedTarget)}\` re-exports a value from a server file; ` +
                  "the client stub does not export it (previously a raw bundler `MISSING_EXPORT` error).",
                suggestions: [
                  "Create a server function that returns the data you need, or",
                  "Redefine the public constant in a client-safe module (never move secret values)",
                ],
              });
            }
          }
        }
        continue;
      }

      const targetRelative =
        resolvedTarget === null ? rawSpecifier : toRelative(projectRoot, resolvedTarget);

      if (statement.type === "ExportAllDeclaration") {
        if (resolvedTarget === null) {
          reject(line, `\`export *\` from \`${targetRelative}\` cannot be resolved`, "Re-exports from `*.server.ts` must be statically resolvable.");
        }
        continue; // aman: target menjadi stub
      }

      const specifiers = (statement["specifiers"] ?? []) as AstNode[];
      for (const item of specifiers) {
        if (item.type === "ImportDefaultSpecifier") {
          reject(line, `importing the default export from ${targetRelative}`, "Default exports from a server file must not cross to the client.");
        }
        if (item.type === "ImportNamespaceSpecifier") {
          reject(line, `importing the namespace (\`* as\`) from ${targetRelative}`, "Namespace imports from a server file must not cross to the client.");
        }
        const name = ((item["local"] as AstNode | undefined)?.["name"] as string) ?? "";
        // Type-only (Addendum J.5): Babel menaruh `importKind: "type"` di
        // statement untuk `import type { X }`, dan di specifier untuk
        // `import { type X }` — keduanya harus dibaca (D1).
        const specifierKind = item["importKind"] as string | undefined;
        const statementKind = statement["importKind"] as string | undefined;
        if (specifierKind === "type" || statementKind === "type") {
          continue;
        }
        if (name.length > 0 && !(await isAllowedServerFnImport(resolvedTarget, specifier, name))) {
          reject(
            line,
            `importing \`${name}\` from ${targetRelative}`,
            "Server code must not appear in the client.\nOnly `serverFn` may cross.",
          );
        }
      }
    }
  }

  // §12.4: pemanggilan env() di modul client (juga @moonsjs/server import env).
  const envBindings = new Set<string>();
  for (const statement of topLevelStatements(ast)) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const sourceNode = statement["source"] as AstNode | undefined;
    const specifier = sourceNode?.type === "StringLiteral" ? (sourceNode["value"] as string) : "";
    if (specifier !== "@moonsjs/server" && !specifier.startsWith("@moonsjs/server/")) {
      continue;
    }
    for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
      if (item.type !== "ImportSpecifier") {
        continue;
      }
      const imported = item["imported"] as AstNode | undefined;
      const local = item["local"] as AstNode | undefined;
      if (imported?.type === "Identifier" && imported["name"] === "env" && local?.type === "Identifier") {
        envBindings.add(local["name"] as string);
      }
    }
  }

  if (envBindings.size > 0) {
    walk(ast, (node) => {
      if (node.type !== "CallExpression") {
        return;
      }
      const callee = node["callee"] as AstNode | undefined;
      if (callee?.type !== "Identifier" || !envBindings.has(callee["name"] as string)) {
        return;
      }
      const callText = code
        .slice(node.start ?? 0, node.end ?? 0)
        .replace(/\s+/g, " ")
        .slice(0, 80);
      throw new MoonsError({
        code: "E_ENV_IN_CLIENT",
        file: relativeFile,
        line: node.loc?.start.line ?? 1,
        message: `calling \`${callText}\` in a client module`,
        details: "`env()` is only legal on the server.",
        suggestions: [
          "Move the call into a serverFn, or",
          "Use import.meta.env for public values",
        ],
      });
    });
  }

  // Dynamic import (§12.7/§12.8) — literal maupun template dengan teks `.server`,
  // plus resolusi (alias/tsconfig paths/symlink) — audit ronde 2.
  const dynamicRequests: Array<{ request: DynamicImportRequest; guarded: boolean }> = [];
  walk(ast, (node, ancestors) => {
    const request = dynamicImportRequest(node);
    if (request !== null) {
      dynamicRequests.push({
        request,
        guarded: ancestors.some((ancestor) => isDevGuard(ancestor)),
      });
    }
  });

  for (const { request, guarded } of dynamicRequests) {
    if (guarded) {
      continue; // §12.8: branch DEV/PROD mati saat build → tidak perlu diperiksa
    }

    const specifier = stripQuery(request.text);
    const resolvedTarget = await resolveSafe(specifier, file);

    // Addendum D.1: dynamic import modul `src/api/**` juga ditolak.
    if (apiDirReal !== null && resolvedTarget !== null && isInsideDir(resolvedTarget, apiDirReal)) {
      rejectApiImport(request.node.loc?.start.line ?? 1, request.text, resolvedTarget);
    }

    // Addendum C: dynamic import paket server-only juga digerbang.
    const match = serverOnly.check({
      specifier,
      resolvedFile: resolvedTarget,
      importerFile: file,
    });
    if (match !== null) {
      throw serverOnlyImportError({
        relativeFile,
        line: request.node.loc?.start.line ?? 1,
        specifier: request.text,
        packageName: match.packageName,
        source: match.source,
        dynamic: true,
        ...(match.source === "marker"
          ? { markerPath: toRelative(projectRoot, join(match.packageDir, "package.json")) }
          : {}),
      });
    }

    if (resolvedTarget !== null && isNonContractServerFile(resolvedTarget)) {
      throw nonContractServerFileError(resolvedTarget, projectRoot);
    }

    const serverBySpecifier = isServerSpecifier(specifier);
    const serverByResolve = resolvedTarget !== null && isServerFilePath(resolvedTarget);
    if (!serverBySpecifier && !serverByResolve) {
      continue;
    }

    const targetRelative =
      resolvedTarget === null ? request.text : toRelative(projectRoot, resolvedTarget);
    reject(request.node.loc?.start.line ?? 1, `importing (dynamic) \`${request.text}\` from ${targetRelative}`, "The client must not dynamically import `*.server.ts`.");
  }

  // `import.meta.glob` yang mencakup `*.server.ts` (§12.7) — audit adversarial M6.
  walk(ast, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node["callee"] as AstNode | undefined;
    if (callee?.type !== "MemberExpression") {
      return;
    }
    const object = callee["object"] as AstNode | undefined;
    const property = callee["property"] as AstNode | undefined;
    if (
      object?.type !== "MetaProperty" ||
      property?.type !== "Identifier" ||
      property["name"] !== "glob"
    ) {
      return;
    }

    for (const pattern of globPatterns(((node["arguments"] ?? []) as AstNode[])[0])) {
      if (!isServerSpecifier(pattern)) {
        continue;
      }
      throw new MoonsError({
        code: "E_SERVER_IMPORT_IN_CLIENT",
        file: relativeFile,
        line: node.loc?.start.line ?? 1,
        message: `importing (glob) \`${pattern}\` in a client module`,
        details: "`import.meta.glob` patterns covering `*.server.ts` are forbidden in the client.",
        suggestions: [
          "Statically import the `serverFn` from `*.server.ts` (that is all that may cross), or",
          "Move the data requirement into a server function",
        ],
      });
    }
  });
}

interface DynamicImportRequest {
  /** Teks specifier literal, atau gabungan quasi template (`*` untuk ekspresi). */
  text: string;
  node: AstNode;
}

/** Dukung Babel 8 (`ImportExpression`) dan bentuk lama (`CallExpression` + callee `Import`). */
function dynamicImportRequest(node: AstNode): DynamicImportRequest | null {
  let sourceNode: AstNode | null = null;

  if (node.type === "ImportExpression") {
    sourceNode = (node["source"] as AstNode | undefined) ?? null;
  } else if (node.type === "CallExpression") {
    const callee = node["callee"] as AstNode | undefined;
    if (callee?.type !== "Import") {
      return null;
    }
    sourceNode = ((node["arguments"] ?? []) as AstNode[])[0] ?? null;
  }

  if (sourceNode === null) {
    return null;
  }
  if (sourceNode.type === "StringLiteral") {
    return { text: sourceNode["value"] as string, node: sourceNode };
  }
  if (sourceNode.type === "TemplateLiteral") {
    const text = ((sourceNode["quasis"] ?? []) as AstNode[])
      .map((quasi) => ((quasi["value"] as { cooked?: string | null } | undefined)?.cooked ?? ""))
      .join("*");
    return { text, node: sourceNode };
  }
  return null;
}

function globPatterns(node: AstNode | undefined): string[] {  if (node?.type === "StringLiteral") {
    return [node["value"] as string];
  }
  if (node?.type === "ArrayExpression") {
    return ((node["elements"] ?? []) as Array<AstNode | null>)
      .filter((element): element is AstNode => element?.type === "StringLiteral")
      .map((element) => element["value"] as string);
  }
  return [];
}

function isDevGuard(node: AstNode): boolean {
  if (node.type !== "IfStatement") {
    return false;
  }
  const test = node["test"] as AstNode | undefined;
  return isImportMetaFlag(test, "DEV") || isNegatedImportMetaFlag(test, "PROD");
}

function isImportMetaFlag(node: AstNode | undefined, flag: string): boolean {
  const member = node;
  if (member?.type !== "MemberExpression") {
    return false;
  }
  const property = member["property"] as AstNode | undefined;
  if (property?.type !== "Identifier" || property["name"] !== flag) {
    return false;
  }
  const object = member["object"] as AstNode | undefined;
  return isImportMetaEnv(object);
}

function isNegatedImportMetaFlag(node: AstNode | undefined, flag: string): boolean {
  if (node?.type !== "UnaryExpression" || node["operator"] !== "!") {
    return false;
  }
  return isImportMetaFlag(node["argument"] as AstNode | undefined, flag);
}

function isImportMetaEnv(node: AstNode | undefined): boolean {
  if (node?.type !== "MemberExpression") {
    return false;
  }
  const property = node["property"] as AstNode | undefined;
  if (property?.type !== "Identifier" || property["name"] !== "env") {
    return false;
  }
  const object = node["object"] as AstNode | undefined;
  return object?.type === "MetaProperty";
}

function toRelative(projectRoot: string, file: string): string {
  const relative = file.startsWith(projectRoot)
    ? file.slice(projectRoot.length).replace(/^[/\\]/, "")
    : file;
  return relative.split("\\").join("/");
}

function isInsideDir(file: string, dir: string): boolean {
  const normalized = dir.endsWith("/") ? dir : `${dir}/`;
  return file === dir || file.startsWith(normalized);
}

export interface RouteExportCheckContext {
  file: string;
  code: string;
  routesDir: string;
  projectRoot: string;
}

/**
 * §11.2 + §12.4: export legal per jenis modul route.
 * page: `default|loader|meta|prerender|paths` (D.5); layout: `default|loader`;
 * `_error`/`_404`: `default`.
 */
export function checkRouteModuleExports(context: RouteExportCheckContext): void {
  const { file, code, routesDir, projectRoot } = context;
  if (!file.startsWith(routesDir) || !file.endsWith(".tsx")) {
    return;
  }

  const base = file.slice(file.lastIndexOf("/") + 1);
  if (base.startsWith("_") && base !== "_layout.tsx" && base !== "_error.tsx" && base !== "_404.tsx") {
    return; // bukan route (diabaikan scanner)
  }

  const allowed =
    base === "_layout.tsx"
      ? ["default", "loader"]
      : base === "_error.tsx" || base === "_404.tsx"
        ? ["default"]
        : ["default", "loader", "meta", "prerender", "paths", "revalidate"];
  const allowedText = `Only ${allowed.map((name) => `\`${name}\``).join(", ")} may be exported.`;
  const relativeFile = toRelative(projectRoot, file);
  const ast = parseModule(code, file);

  const declarations: Array<{ name: string; line: number }> = [];
  let hasDefault = false;

  for (const statement of topLevelStatements(ast)) {
    if (statement.type === "ExportDefaultDeclaration") {
      hasDefault = true;
      continue;
    }

    if (statement.type === "ExportAllDeclaration") {
      throw new MoonsError({
        code: "E_ROUTE_EXPORT_INVALID",
        file: relativeFile,
        line: statement.loc?.start.line ?? 1,
        message: "`export *` is not allowed in route modules",
        details: allowedText,
        suggestions: [
          `Move the file contents outside ${toRelative(projectRoot, routesDir)}/, or`,
          "Remove the `export *`",
        ],
      });
    }

    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }

    const declaration = statement["declaration"] as AstNode | null | undefined;
    if (declaration !== null && declaration !== undefined) {
      for (const name of declarationNames(declaration)) {
        declarations.push({ name, line: declaration.loc?.start.line ?? 1 });
      }
    }

    for (const item of (statement["specifiers"] ?? []) as AstNode[]) {
      const exported = item["exported"] as AstNode | undefined;
      const name =
        exported?.type === "Identifier"
          ? (exported["name"] as string)
          : exported?.type === "StringLiteral"
            ? (exported["value"] as string)
            : null;
      if (name !== null) {
        declarations.push({ name, line: item.loc?.start.line ?? statement.loc?.start.line ?? 1 });
      }
    }
  }

  for (const entry of declarations) {
    if (!allowed.includes(entry.name)) {
      throw new MoonsError({
        code: "E_ROUTE_EXPORT_INVALID",
        file: relativeFile,
        line: entry.line,
        message: `export \`${entry.name}\` is not allowed in route modules`,
        details: allowedText,
        suggestions: [
          `Move \`${entry.name}\` to a file outside ${toRelative(projectRoot, routesDir)}/, or`,
          "Remove the export",
        ],
      });
    }
  }

  if (!hasDefault) {
    throw new MoonsError({
      code: "E_ROUTE_EXPORT_INVALID",
      file: relativeFile,
      message: "route module must export `default`",
      details: "Every route file needs an `export default` React component.",
      suggestions: ["Add `export default function Page() { ... }`"],
    });
  }
}

function declarationNames(declaration: AstNode): string[] {
  switch (declaration.type) {
    case "VariableDeclaration":
      return ((declaration["declarations"] ?? []) as AstNode[])
        .map((declarator) => ((declarator["id"] as AstNode | undefined)?.["name"] as string) ?? "")
        .filter((name) => name.length > 0);
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      return [((declaration["id"] as AstNode | undefined)?.["name"] as string) ?? ""].filter(
        (name) => name.length > 0,
      );
    default:
      return [];
  }
}

/** Scan semua `*.server.{ts,tsx}` di bawah root (exclude direktori build/dependency). */
export function scanServerFiles(projectRoot: string): string[] {
  const excluded = new Set(["node_modules", "dist", ".moons", ".git"]);
  const result: string[] = [];

  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) {
          continue;
        }
        walkDir(join(dir, entry.name));
      } else if (entry.isFile() && isServerFilePath(entry.name)) {
        result.push(join(dir, entry.name));
      }
    }
  };

  walkDir(projectRoot);
  return result.sort();
}

export interface FnRegistryJson {
  [key: string]: string;
}

/** Bangun isi `fn-registry.json` (bentuk yang dibaca §21.3). */
export function buildFnRegistry(projectRoot: string, files: string[]): FnRegistryJson {
  const registry: FnRegistryJson = {};
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const analysis = analyzeServerFile(source, file, projectRoot);
    for (const fn of analysis.serverFns) {
      registry[fnRegistryKey(projectRoot, file, fn.name)] = fn.hash;
    }
  }
  return registry;
}
