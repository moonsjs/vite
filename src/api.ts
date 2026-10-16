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
        "export `default` is not supported in API modules",
        "`src/api` modules only export named method handlers.",
        ["Replace it with `export const GET = (args) => …`", "Remove the default export"],
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
      `export \`${illegal[0]}\` is not a recognized method handler`,
      `Legal handlers: ${API_METHODS.join(", ")}.`,
      [
        "Rename the export to one of the HTTP methods",
        "Move helpers to another module (e.g. `src/server/…`)",
      ],
    );
  }
  if (methods.length === 0) {
    throw apiError(
      file,
      "API module has no method handler",
      `At least one of ${API_METHODS.join(", ")} is required.`,
      ["Add `export const GET = (args) => new Response(…)`"],
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
      message: "`_middleware.ts` without `export default`",
      details: "Directory middleware follows the `Middleware` shape: `(args) => Promise<Response>`.",
      suggestions: [
        "Add `export default async ({ req, ctx, next }) => await next()`",
        "Delete the file if unused",
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
