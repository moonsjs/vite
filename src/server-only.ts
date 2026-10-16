import { MoonsError } from "@moonsjs/core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Gate paket server-only (PRD Addendum C): paket npm yang tidak boleh masuk
 * graph client — di-import dari route/client/shared → build gagal.
 *
 * Daftar bawaan adalah **minimum normatif** dan TIDAK dapat dihapus app:
 * gate kebocoran tidak boleh bisa dilonggarkan (prinsip "batas lebih ketat
 * menang"); salah-tangkap diperbaiki lewat rilis framework.
 */
export const DEFAULT_SERVER_ONLY_PACKAGES: ReadonlyArray<string> = [
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "drizzle-orm",
  "@prisma/client",
  "prisma",
  "mongodb",
  "mongoose",
  "redis",
  "ioredis",
  "bcrypt",
  "bcryptjs",
  "argon2",
  "jsonwebtoken",
  "nodemailer",
  "sharp",
  "execa",
  "cross-spawn",
  "dotenv",
  "knex",
  "typeorm",
  "sequelize",
  "@libsql/client",
];

export type ServerOnlyMatchSource = "builtin" | "config" | "marker";

export interface PackageJsonInfo {
  /** Direktori package (tempat package.json berada). */
  dir: string;
  name: string;
  serverOnlyMarker: boolean;
}

export interface ServerOnlyMatch {
  packageName: string;
  source: ServerOnlyMatchSource;
  packageDir: string;
}

export interface ServerOnlyClassifier {
  check(input: {
    specifier: string;
    resolvedFile: string | null;
    importerFile: string;
  }): ServerOnlyMatch | null;
}

export interface ServerOnlyClassifierOptions {
  /** `security.serverOnlyPackages` — tambahan milik app (tidak menghapus bawaan). */
  configured?: ReadonlyArray<string>;
  /** Cache package.json per-direktori; bagikan lintas modul demi performa. */
  cache?: Map<string, PackageJsonInfo | null>;
}

/** Nama paket dari specifier bare (dipakai sebagai info pelengkap; pencocokan utama lewat resolve). */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\0") ||
    specifier.includes(":")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || (parts[1] ?? "").length === 0) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

/** Baca package.json pada direktori tertentu (null bila tidak ada/gagal). */
export function tryReadPackageJson(dir: string): PackageJsonInfo | null {
  const candidate = join(dir, "package.json");
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    const json = JSON.parse(readFileSync(candidate, "utf8")) as {
      name?: unknown;
      moons?: unknown;
    };
    const moons = json.moons as { serverOnly?: unknown } | undefined;
    return {
      dir,
      name: typeof json.name === "string" ? json.name : "",
      serverOnlyMarker: moons?.serverOnly === true,
    };
  } catch {
    return null;
  }
}

/** Baca package.json terdekat dari sebuah file absolut (menelusuri ke atas). */
export function readPackageJsonFrom(file: string): PackageJsonInfo | null {
  let dir = dirname(file);
  for (let depth = 0; depth < 64; depth += 1) {
    const info = tryReadPackageJson(dir);
    if (info !== null) {
      return info;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

export function createServerOnlyClassifier(
  options: ServerOnlyClassifierOptions = {},
): ServerOnlyClassifier {
  const cache = options.cache ?? new Map<string, PackageJsonInfo | null>();
  const configured = new Set(options.configured ?? []);
  const builtin = new Set(DEFAULT_SERVER_ONLY_PACKAGES);

  const infoOf = (file: string): PackageJsonInfo | null => {
    let dir = dirname(file);
    for (let depth = 0; depth < 64; depth += 1) {
      if (cache.has(dir)) {
        return cache.get(dir) ?? null;
      }
      const info = tryReadPackageJson(dir);
      if (info !== null) {
        cache.set(dir, info);
        return info;
      }
      // Direktori tanpa package.json: lanjut ke atas (tidak di-cache agar
      // penelusuran berikutnya tetap benar untuk subtree berbeda).
      const parent = dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
    return null;
  };

  return {
    check({ specifier: _specifier, resolvedFile, importerFile }) {
      if (resolvedFile === null) {
        return null;
      }
      const info = infoOf(resolvedFile);
      if (info === null || info.name.length === 0) {
        return null;
      }
      // Gate menyasar dependency: import di dalam package yang sama diabaikan.
      const importer = infoOf(importerFile);
      if (importer !== null && importer.dir === info.dir) {
        return null;
      }
      if (builtin.has(info.name)) {
        return { packageName: info.name, source: "builtin", packageDir: info.dir };
      }
      if (configured.has(info.name)) {
        return { packageName: info.name, source: "config", packageDir: info.dir };
      }
      if (info.serverOnlyMarker) {
        return { packageName: info.name, source: "marker", packageDir: info.dir };
      }
      return null;
    },
  };
}

/**
 * Error §15 untuk import paket server-only (kode tetap
 * `E_FORBIDDEN_SERVER_IMPORT`, PRD Addendum C.3).
 */
export function serverOnlyImportError(input: {
  relativeFile: string;
  line: number;
  specifier: string;
  packageName: string;
  source: ServerOnlyMatchSource;
  /** Path package.json relatif project — untuk sumber kecocokan "marker". */
  markerPath?: string;
  dynamic?: boolean;
}): MoonsError {
  const sourceLabel =
    input.source === "builtin"
      ? "Match source: framework built-in server-only package list."
      : input.source === "config"
        ? "Match source: `security.serverOnlyPackages` in moons.config.ts."
        : `Match source: marker \`"moons": { "serverOnly": true }\` in ${input.markerPath ?? "package.json"}.`;
  return new MoonsError({
    code: "E_FORBIDDEN_SERVER_IMPORT",
    file: input.relativeFile,
    line: input.line,
    message: `importing${input.dynamic === true ? " (dynamic)" : ""} \`${input.specifier}\` — server-only package \`${input.packageName}\``,
    details: `${sourceLabel}\nServer-only packages must not enter the client bundle.`,
    suggestions: [
      "Move the operation into `*.server.ts` and call it via a serverFn",
      "Or replace/remove the import in the client module",
    ],
  });
}
