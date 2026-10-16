import { parse } from "@babel/parser";
import { API_METHODS, MoonsError } from "@moonsjs/core";

/**
 * Validasi statis export modul `src/api` (PRD Addendum D.1):
 * hanya handler method `GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS` sebagai fungsi;
 * `default`/export lain ditolak → `E_API_HANDLER_INVALID`.
 */
export function assertApiModuleExports(code: string, file: string): string[] {
  let ast: unknown;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
  } catch {
    return []; // biarkan bundler melaporkan syntax error
  }

  const program = (ast as { program?: { body?: Array<Record<string, unknown>> } }).program;
  const body = program?.body ?? [];
  const methods: string[] = [];

  for (const statement of body) {
    if (statement["type"] === "ExportDefaultDeclaration") {
      throw apiError(
        file,
        "export `default` tidak didukung di modul API",
        "Modul `src/api` hanya mengekspor handler method bernama.",
        ["Ganti menjadi `export const GET = (args) => …`", "Hapus export default"],
      );
    }
    if (statement["type"] !== "ExportNamedDeclaration") {
      continue;
    }
    if (statement["source"] !== undefined) {
      // re-export `export { X } from "..."` — nama tetap dicek di bawah.
    }
    const declaration = statement["declaration"] as Record<string, unknown> | undefined;
    if (declaration !== undefined) {
      if (declaration["type"] === "VariableDeclaration") {
        for (const declarator of (declaration["declarations"] ?? []) as Array<Record<string, unknown>>) {
          const id = declarator["id"] as Record<string, unknown> | undefined;
          if (id?.["type"] === "Identifier") {
            methods.push(id["name"] as string);
          }
        }
      } else if (declaration["type"] === "FunctionDeclaration") {
        const id = declaration["id"] as Record<string, unknown> | undefined;
        if (id?.["type"] === "Identifier") {
          methods.push(id["name"] as string);
        }
      }
      continue;
    }
    for (const specifier of (statement["specifiers"] ?? []) as Array<Record<string, unknown>>) {
      const exported = specifier["exported"] as Record<string, unknown> | undefined;
      if (exported?.["type"] === "Identifier") {
        methods.push(exported["name"] as string);
      }
    }
  }

  const illegal = methods.filter((name) => !API_METHODS.includes(name as never));
  if (illegal.length > 0) {
    throw apiError(
      file,
      `export \`${illegal[0]}\` bukan handler method yang dikenal`,
      `Handler yang legal: ${API_METHODS.join(", ")}.`,
      [
        "Ganti nama export menjadi salah satu method HTTP",
        "Pindahkan helper ke modul lain (mis. `src/server/…`)",
      ],
    );
  }
  if (methods.length === 0) {
    throw apiError(
      file,
      "modul API tanpa handler method",
      `Wajib ada minimal satu dari ${API_METHODS.join(", ")}.`,
      [`Tambahkan \`export const GET = (args) => new Response(…)\``],
    );
  }

  return methods;
}

export function assertMiddlewareExports(code: string, file: string): void {
  let ast: unknown;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
  } catch {
    return;
  }
  const program = (ast as { program?: { body?: Array<Record<string, unknown>> } }).program;
  const hasDefault = (program?.body ?? []).some(
    (statement) => statement["type"] === "ExportDefaultDeclaration",
  );
  if (!hasDefault) {
    throw new MoonsError({
      code: "E_MIDDLEWARE_INVALID",
      file,
      message: "`_middleware.ts` tanpa `export default`",
      details: "Middleware direktori mengikuti bentuk `Middleware`: `(args) => Promise<Response>`.",
      suggestions: [
        "Tambahkan `export default async ({ req, ctx, next }) => await next()`",
        "Hapus file bila tidak dipakai",
      ],
    });
  }
}

function apiError(file: string, message: string, details: string, suggestions: string[]): MoonsError {
  return new MoonsError({
    code: "E_API_HANDLER_INVALID",
    file,
    message,
    details,
    suggestions,
  });
}
